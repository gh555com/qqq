const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
// ★ Lazy-load cheerio; only load when parsing HTML to speed up startup
let _cheerio = null;
function getCheerio() {
    if (!_cheerio) _cheerio = require("cheerio");
    return _cheerio;
}
const crypto = require("crypto");
const { TextDecoder } = require("util");
const { getSharedDownloader, isPlatformOrSegmentVideo } = require("./dow");
const sizeOf = require("image-size");
const global = require("./global");
const { q } = require("./i18n");

let _global = null;
function getGlobal() {
    if (!_global) _global = require("./global");
    return _global;
}

function log(msg, level = "INFO") {
    try { getGlobal().logMessage(msg, level); } catch (e) { console.log(msg); }
}

// ============================================================================
// C# Clipboard Helper
// ============================================================================
const CLIPBOARD_HELPER_CS = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;

public class ClipboardHelper {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetClipboardData(uint uFormat);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint RegisterClipboardFormat(string lpszFormat);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int GlobalSize(IntPtr hMem);

    public static string DumpHtmlToFile(string filePath) {
        if (!OpenClipboard(IntPtr.Zero)) return "Error: OpenClipboard failed";

        try {
            uint fmt = RegisterClipboardFormat("HTML Format");
            if (fmt == 0) return "Error: RegisterClipboardFormat failed";

            IntPtr h = GetClipboardData(fmt);
            if (h == IntPtr.Zero) return "Error: GetClipboardData failed";

            IntPtr ptr = GlobalLock(h);
            if (ptr == IntPtr.Zero) return "Error: GlobalLock failed";

            try {
                int len = GlobalSize(h);
                byte[] buff = new byte[len];
                Marshal.Copy(ptr, buff, 0, len);
                File.WriteAllBytes(filePath, buff);
                return "Success";
            } finally {
                GlobalUnlock(h);
            }
        } catch (Exception ex) {
            return "Error: " + ex.Message;
        } finally {
            CloseClipboard();
        }
    }

    public static string SetFiles(string[] paths) {
        try {
            System.Collections.Specialized.StringCollection sc = new System.Collections.Specialized.StringCollection();
            sc.AddRange(paths);
            System.Windows.Forms.Clipboard.SetFileDropList(sc);
            return "Success";
        } catch (Exception ex) {
            return "Error: " + ex.Message;
        }
    }
}

public class IconHelper {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHFILEINFO {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbSizeFileInfo, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr hIcon);

    public const uint SHGFI_ICON = 0x100;
    public const uint SHGFI_LARGEICON = 0x0;
    public const uint SHGFI_SMALLICON = 0x1;
    public const uint SHGFI_USEFILEATTRIBUTES = 0x10;

    public static string GetIconBase64(string path) {
        SHFILEINFO shinfo = new SHFILEINFO();
        try {
            // SHGFI_LARGEICON is 32x32
            IntPtr res = SHGetFileInfo(path, 0, ref shinfo, (uint)Marshal.SizeOf(shinfo), SHGFI_ICON | SHGFI_LARGEICON);
            if (res == IntPtr.Zero || shinfo.hIcon == IntPtr.Zero) return null;

            using (Icon icon = Icon.FromHandle(shinfo.hIcon)) {
                using (Bitmap bitmap = icon.ToBitmap()) {
                    using (MemoryStream ms = new MemoryStream()) {
                        bitmap.Save(ms, ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
        } catch {
            return null;
        } finally {
            if (shinfo.hIcon != IntPtr.Zero) {
                DestroyIcon(shinfo.hIcon);
            }
        }
    }
}
`;

// ============================================================================
// Process / Spawn Helpers  (✅ Companion: default NO_TRACK; do not enter download task tracker)
// ============================================================================
const NO_TRACK_ENV_KEY = "QQQ_NO_TRACK";
function _envNoTrack() {
    return { ...process.env, [NO_TRACK_ENV_KEY]: "1" };
}

function spawnRun(cmd, args, opts = {}) {
    const { checkExpected, returnOutput } = opts;
    return new Promise((resolve) => {
        // ✅ Double safety: explicitly mark env NO_TRACK
        const child = cp.spawn(cmd, args, {
            windowsHide: true,
            env: _envNoTrack(),
            // detached default is false; it's fine not to force it here
        });

        let output = "";
        let errorOutput = "";
        let done = false;
        let timer = null;

        const finish = (val) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            resolve(val);
        };

        child.stdout.on("data", (d) => output += d.toString());
        child.stderr.on("data", (d) => errorOutput += d.toString());

        child.on("close", () => {
            if (checkExpected) finish(output.includes(checkExpected));
            else finish(returnOutput ? output : "");
        });

        child.on("error", () => {
            finish(checkExpected ? false : "");
        });

        timer = setTimeout(() => {
            try { child.kill(); } catch { }
            finish(checkExpected ? false : "");
        }, 10000);
    });
}

function spawnOutput(cmd, args) {
    return spawnRun(cmd, args, { returnOutput: true });
}

// ============================================================================
// Deduplication Helper (dedupe only within the same folder; no cross-folder)
// ============================================================================
/**
 * Try to deduplicate within the file's directory (same-folder only)
 * @param {string} filePath
 * @returns {string} The final file path to use
 */
function _tryLocalDeduplicate(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return filePath;
    try {
        const currentFp = computeFingerprint(filePath);
        if (!currentFp) return filePath;

        // ★ Core fix: strictly limit dedupe to the same folder; forbid cross-folder reference
        const dir = path.dirname(filePath);
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const isWin = process.platform === "win32";
        const normalizedFilePath = isWin ? filePath.toLowerCase() : filePath;

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const f = entry.name;
            const full = path.join(dir, f);
            const normalizedFull = isWin ? full.toLowerCase() : full;

            if (normalizedFull === normalizedFilePath) continue;

            if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.tmp')) continue;

            const otherFp = computeFingerprint(full);
            if (otherFp === currentFp) {
                try {
                    fs.unlinkSync(filePath);
                    log(q('h.log.dedupeReuse', f), "INFO");
                    return full;
                } catch (e) {
                    log(q('h.log.dedupeReuseFailed', filePath, e.message), "WARN");
                }
            }
        }
    } catch (e) {
        log(`[Dedupe] Local Exception: ${e.message}`, "ERROR");
    }
    return filePath;
}

// ============================================================================
// File / Path Helpers
// ============================================================================
const QQQ_ADS_SALT = "gh555";
const QQQ_FOLDER_NAME = "qqq";

// ★ Cache for salted qqq folders (avoid repeated ADS reads)
const _saltedQqqCache = new Set();

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        try {
            fs.mkdirSync(dirPath, { recursive: true });
            // ★ Add salt: if creating the qqq folder, write ADS marker (Windows NTFS)
            _saltQqqFolder(dirPath);
        } catch (e) { }
    } else {
        // ★ Directory already exists: ensure salt is present (fix missing salt case)
        _ensureSalt(dirPath);
    }
}

/**
 * Ensure qqq folder has salt marker (called when folder already exists)
 * Only adds salt if folder is qqq and doesn't have salt yet
 * Uses cache to avoid repeated ADS reads
 */
function _ensureSalt(dirPath) {
    if (path.basename(dirPath) !== QQQ_FOLDER_NAME) return;
    // ★ Check cache first (fast path)
    if (_saltedQqqCache.has(dirPath)) return;
    // Check if salt already exists
    if (isOurQqqFolder(dirPath)) {
        _saltedQqqCache.add(dirPath);  // Cache it
        return;
    }
    // No salt found, add it now
    log(`[Salt] Folder exists but no salt, adding salt to: ${dirPath}`, "DEBUG");
    _saltQqqFolder(dirPath);
}

// xattr key constants
const XATTR_KEY_DARWIN = "com.qqq.owner";
const XATTR_KEY_LINUX = "user.qqq.owner";

/**
 * Salt the qqq folder to mark it as created by us
 * - Windows: ADS (Alternate Data Stream)
 * - macOS: xattr com.qqq.owner
 * - Linux: xattr user.qqq.owner
 * Note: silently fail on all platforms; never block main flow
 */
function _saltQqqFolder(dirPath) {
    if (path.basename(dirPath) !== QQQ_FOLDER_NAME) return;
    try {
        if (process.platform === "win32") {
            fs.writeFileSync(dirPath + ":qqq", QQQ_ADS_SALT, "utf8");
            log(`[Salt] Written ADS to ${dirPath}:qqq = ${QQQ_ADS_SALT}`, "DEBUG");
        } else if (process.platform === "darwin") {
            cp.execFileSync("xattr", ["-w", XATTR_KEY_DARWIN, QQQ_ADS_SALT, dirPath], { timeout: 1000 });
            log(`[Salt] Written xattr ${XATTR_KEY_DARWIN} to ${dirPath}`, "DEBUG");
        } else {
            // Linux: setfattr may not be installed; silently fail
            cp.execFileSync("setfattr", ["-n", XATTR_KEY_LINUX, "-v", QQQ_ADS_SALT, dirPath], { timeout: 1000 });
            log(`[Salt] Written xattr ${XATTR_KEY_LINUX} to ${dirPath}`, "DEBUG");
        }
        // ★ Cache it after successful write
        _saltedQqqCache.add(dirPath);
    } catch (e) {
        log(`[Salt] Failed to write salt to ${dirPath}: ${e.message}`, "WARN");
    }
}

/**
 * Check whether a qqq folder is created by us (verify salt)
 * Silently fail and return false on all platforms
 */
function isOurQqqFolder(dirPath) {
    if (path.basename(dirPath) !== QQQ_FOLDER_NAME) return false;
    try {
        if (process.platform === "win32") {
            const salt = fs.readFileSync(dirPath + ":qqq", "utf8");
            return salt === QQQ_ADS_SALT;
        } else if (process.platform === "darwin") {
            const out = cp.execFileSync("xattr", ["-p", XATTR_KEY_DARWIN, dirPath], { timeout: 1000, encoding: "utf8" });
            return out.trim() === QQQ_ADS_SALT;
        } else {
            // Linux: getfattr
            const out = cp.execFileSync("getfattr", ["--only-values", "-n", XATTR_KEY_LINUX, dirPath], { timeout: 1000, encoding: "utf8" });
            return out.trim() === QQQ_ADS_SALT;
        }
    } catch {
        return false;
    }
}

/**
 * Check whether a directory is empty (no files or subdirectories)
 */
function isDirEmpty(dirPath) {
    try {
        const entries = fs.readdirSync(dirPath);
        return entries.length === 0;
    } catch {
        return false;
    }
}

/**
 * ★ Fallback cleanup: if qqq folder is empty and created by us, delete permanently
 * Called by onDidSaveTextDocument
 * @returns {boolean} Whether deletion was performed
 */
function cleanupEmptyQqqFolder(docDir) {
    if (!docDir) return false;
    const qqqPath = path.join(docDir, QQQ_FOLDER_NAME);
    try {
        if (!fs.existsSync(qqqPath)) return false;
        if (!fs.statSync(qqqPath).isDirectory()) return false;
        if (!isDirEmpty(qqqPath)) return false;
        if (!isOurQqqFolder(qqqPath)) return false;
        // Delete ADS stream first, then delete empty directory
        try { fs.unlinkSync(qqqPath + ":qqq"); } catch { }
        fs.rmdirSync(qqqPath);
        // ★ Clear from cache after deletion
        _saltedQqqCache.delete(qqqPath);
        log(`[Cleanup] Deleted empty qqq folder: ${qqqPath}`, "INFO");
        return true;
    } catch (e) {
        log(`[Cleanup] cleanupEmptyQqqFolder failed: ${e.message}`, "WARN");
        return false;
    }
}

const IMAGE_EXTS_FOR_CLIPBOARD = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif",
]);

function isImageExtForClipboard(ext) {
    return IMAGE_EXTS_FOR_CLIPBOARD.has(ext.toLowerCase());
}

// ★ Use the unified formatter from global.js to avoid re-implementing
const { formatBytesCompact, formatTimeCompact } = global;

/**
 * Generate a progress message with size and time
 * @param {string} stepInfo - Step info, e.g. "Folder 1/3"
 * @param {string} itemName - Current item name
 * @param {number} totalSize - Total copied size (bytes)
 * @param {number} elapsedMs - Elapsed time (ms)
 * @returns {string}
 */
function _formatCopyProgress(stepInfo, itemName, totalSize, elapsedMs) {
    const TWENTY_MIN = 20 * 60 * 1000;
    const sizeStr = totalSize > 0 ? ` ${formatBytesCompact(totalSize)}` : '';
    const timePart = elapsedMs >= TWENTY_MIN ? ` (${formatTimeCompact(elapsedMs)})` : '';

    // Format: [Copy folder 1/3] 222m (31:22) folderName
    return `[${stepInfo}]${sizeStr}${timePart} ${itemName}`;
}

// ★ Valid character set for filename encoding (digits + letters, excluding confusing chars)
// Digits first so index=0 encodes to '00'
const FILENAME_VALID_CHARS = (() => {
    const excluded = new Set(["l", "i", "s", "a", "m", "c", "b", "f", "t"]);
    const letters = "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        .split("")
        .filter((c) => !excluded.has(c.toLowerCase()));
    return [..."0123456789", ...letters]; // 10 digits + 34 letters = 44 chars, digits first!
})();

/**
 * Encode index to 2-char string using FILENAME_VALID_CHARS (base-44)
 * Capacity: 44^2 = 1,936 files per transaction
 * @param {number} index - 0-based index
 * @returns {string} 2-char encoded string
 */
function _encodeFileIndex(index) {
    const base = FILENAME_VALID_CHARS.length; // 44
    const c1 = FILENAME_VALID_CHARS[Math.floor(index / base) % base];
    const c2 = FILENAME_VALID_CHARS[index % base];
    return `${c1}${c2}`;
}

/**
 * Generate a timestamp filename with 6-char prefix (4-char anchor + 2-char index)
 * ★ UNIFIED BATCH MODE: All scenarios use transId + index
 *
 * @param {string} ext - File extension (e.g. '.mp4')
 * @param {string} transId - Transaction ID (first 4 chars used as anchor)
 * @param {number} [index=0] - File index within batch (0-based), encoded to 2 chars
 * @returns {string} Filename in format: {anchor4}{index2}_{date}__{day}__{time}{ext}
 *
 * Example:
 * - Batch: y3Wx00_2026.02.06__5__12.20.30.png (index=0)
 * - Batch: y3Wx01_2026.02.06__5__12.20.30.png (index=1)
 * - Single file scenarios also use index=0 for consistency
 *
 * Anchor collision probability: 1/44^4 ≈ 1/3,748,096
 * Files per transaction: 44^2 = 1,936
 */
function getTimestampFilename(ext, transId, index = 0) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
    const time = now.toTimeString().slice(0, 8).replace(/:/g, ".");
    const day = now.getDay() || 7;

    // ★ Unified batch mode: 4-char anchor + 2-char index
    const anchor = (transId && typeof transId === 'string' && transId.length >= 4)
        ? transId.slice(0, 4)
        : '0000';  // Fallback anchor if transId is invalid (should not happen)
    const indexStr = _encodeFileIndex(typeof index === 'number' ? index : 0);
    const prefix = `${anchor}${indexStr}`;

    return `${prefix}_${date}__${day}__${time}${ext}`;
}

/**
 * Get a non-conflicting path (e.g. file (1).txt)
 */
function getUniquePath(baseDir, originalName, isFolder = false) {
    let nameWithoutExt, ext;
    if (isFolder) {
        // For folders, do not split extension; treat the whole string as the name
        nameWithoutExt = originalName;
        ext = "";
    } else {
        ext = path.extname(originalName);
        nameWithoutExt = path.basename(originalName, ext);
        // Special case: for hidden files like .gitignore, path.extname returns the full name; fix it here
        if (!nameWithoutExt && ext.startsWith('.')) {
            nameWithoutExt = ext;
            ext = "";
        }
    }

    let targetPath = path.join(baseDir, originalName);
    let counter = 1;

    while (fs.existsSync(targetPath)) {
        targetPath = path.join(baseDir, `${nameWithoutExt}_${counter}${ext}`);
        counter++;
    }
    return targetPath;
}

/**
 * ★ Extract original filename from URL (unified with VideoDownloadController._createTask logic)
 * @param {string} url - Resource URL
 * @param {string} kind - 'video' or 'image'
 * @returns {string|null} - Filename, null on failure
 */
function getFilenameFromUrl(url, kind = 'video') {
    try {
        const u = new URL(url);
        const pathname = u.pathname || '';
        const base = path.basename(pathname);

        if (kind === 'video') {
            // ★ Video: match common video extensions
            if (base && /\.(mp4|webm|mkv|mov|flv|avi|wmv|m4v|mpg|mpeg|3gp|ts|ogv)$/i.test(base)) {
                const decoded = decodeURIComponent(base);
                // ★ Reasonableness check: not too long, no special characters
                if (decoded.length <= 100 && /^[a-zA-Z0-9._\-\u4e00-\u9fff]+$/.test(decoded)) {
                    return decoded;
                }
            }
        } else {
            // ★ Image: match common image extensions
            if (base && /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(base)) {
                const decoded = decodeURIComponent(base);
                if (decoded.length <= 100 && /^[a-zA-Z0-9._\-\u4e00-\u9fff]+$/.test(decoded)) {
                    return decoded;
                }
            }
        }
    } catch (e) { }
    return null;
}

function _fileUriToLocalPath(fileUri) {
    try {
        let u = String(fileUri || "");
        if (!u.toLowerCase().startsWith("file://")) return "";
        u = u.replace(/^file:\/\//i, "").replace(/^localhost\//i, "");
        u = decodeURIComponent(u);
        if (process.platform === "win32") {
            u = u.replace(/^\//, "").replace(/\//g, "\\");
        } else {
            u = "/" + u.replace(/^\/+/, "");
        }
        return u;
    } catch { return ""; }
}

function _extFromContentType(ct) {
    const t = String(ct || "").toLowerCase().split(";")[0].trim();
    if (t === "image/jpeg") return ".jpg";
    if (t === "image/jpg") return ".jpg";
    if (t === "image/png") return ".png";
    if (t === "image/gif") return ".gif";
    if (t === "image/webp") return ".webp";
    if (t === "image/svg+xml") return ".svg";
    if (t === "image/bmp") return ".bmp";
    if (t === "image/x-icon" || t === "image/vnd.microsoft.icon") return ".ico";
    return "";
}

function _guessExtFromUrl(url, contentType) {
    const byCT = _extFromContentType(contentType);
    if (byCT) return byCT;
    try {
        const u = new URL(url);
        const p = u.pathname || "";
        const ext = path.extname(p);
        if (ext && ext.length <= 6) return ext;
    } catch { }
    return ".png";
}

function copyFileWithProgress(src, dest, onProgress, token) {
    return new Promise((resolve, reject) => {
        if (token?.isCancellationRequested) return reject(new Error("cancelled"));
        try {
            const stat = fs.statSync(src);
            const totalSize = stat.size;
            let copiedSize = 0;
            const readStream = fs.createReadStream(src);
            const writeStream = fs.createWriteStream(dest);
            readStream.on("error", reject);
            writeStream.on("error", reject);
            if (token) {
                token.onCancellationRequested(() => {
                    readStream.destroy();
                    writeStream.destroy();
                    try { fs.unlinkSync(dest); } catch { }
                    reject(new Error("cancelled"));
                });
            }
            readStream.on("data", (chunk) => {
                copiedSize += chunk.length;
                if (onProgress && totalSize > 0) onProgress(chunk.length, copiedSize, totalSize);
            });
            writeStream.on("finish", () => resolve());
            readStream.pipe(writeStream);
        } catch (e) { reject(e); }
    });
}

// ============================================================================
// Fingerprint Logic
// ============================================================================
const _fingerprintCache = new Map();
const FINGERPRINT_HEAD = 128;
const FINGERPRINT_MID = 128;
const FINGERPRINT_TAIL = 128;

function canonicalizeExistingPath(p) {
    return global.canonicalizeExistingPath(p);
}

/**
 * Safety-check whether a file/folder can be accessed and read
 * @param {string} filePath - Path to check
 * @returns {boolean} - Whether it can be safely accessed
 */
function safeAccessCheck(filePath) {
    try {
        // Check accessibility (read permission)
        fs.accessSync(filePath, fs.constants.R_OK);
        // Check whether stat info can be obtained
        fs.statSync(filePath);
        return true;
    } catch (e) {
        // File locked, insufficient permissions, invalid path, etc.
        log(q('h.log.safeAccessDenied', filePath, e.code || e.message), "WARN");
        return false;
    }
}

function cacheKeyForPath(p) {
    return global.cacheKeyForPath(p);
}

function prefillFingerprint(filePath, fingerprint) {
    try {
        const stat = fs.statSync(filePath);
        const key = cacheKeyForPath(filePath);
        _fingerprintCache.set(key, { mtime: stat.mtimeMs, size: stat.size, fp: fingerprint });
    } catch (e) { }
}

function computeFingerprint(filePath) {
    try {
        const stat = fs.statSync(filePath);
        const size = stat.size;
        // Use second-level precision or integer ms to avoid FS precision jitter causing misses
        const mtime = Math.floor(stat.mtimeMs);
        const key = cacheKeyForPath(filePath);

        const cached = _fingerprintCache.get(key);
        if (cached && cached.mtime === mtime && cached.size === size) return cached.fp;

        if (size === 0) {
            // Empty file: must use path+mtime to distinguish; cannot return the same fp for all empty files
            const fp = crypto.createHash("md5").update(`empty:0:${key}:${mtime}`).digest("hex");
            _fingerprintCache.set(key, { mtime, size, fp });
            if (_fingerprintCache.size > 2000) _fingerprintCache.clear();
            return fp;
        }

        const fd = fs.openSync(filePath, "r");
        const chunks = [];
        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigUInt64LE(BigInt(size));
        chunks.push(sizeBuf);

        try {
            if (size <= FINGERPRINT_HEAD) {
                const buf = Buffer.alloc(size);
                fs.readSync(fd, buf, 0, size, 0);
                chunks.push(buf);
            } else if (size <= FINGERPRINT_HEAD + FINGERPRINT_TAIL) {
                const head = Buffer.alloc(FINGERPRINT_HEAD);
                fs.readSync(fd, head, 0, FINGERPRINT_HEAD, 0);
                chunks.push(head);
                const tailSize = Math.min(FINGERPRINT_TAIL, size - FINGERPRINT_HEAD);
                const tail = Buffer.alloc(tailSize);
                fs.readSync(fd, tail, 0, tailSize, size - tailSize);
                chunks.push(tail);
            } else {
                const head = Buffer.alloc(FINGERPRINT_HEAD);
                fs.readSync(fd, head, 0, FINGERPRINT_HEAD, 0);
                chunks.push(head);
                const midPos = Math.floor(size / 2) - Math.floor(FINGERPRINT_MID / 2);
                const mid = Buffer.alloc(FINGERPRINT_MID);
                fs.readSync(fd, mid, 0, FINGERPRINT_MID, midPos);
                chunks.push(mid);
                const tail = Buffer.alloc(FINGERPRINT_TAIL);
                fs.readSync(fd, tail, 0, FINGERPRINT_TAIL, size - FINGERPRINT_TAIL);
                chunks.push(tail);
            }
        } finally {
            fs.closeSync(fd);
        }

        const fp = crypto.createHash("md5").update(Buffer.concat(chunks)).digest("hex");
        _fingerprintCache.set(key, { mtime, size, fp });
        if (_fingerprintCache.size > 2000) _fingerprintCache.clear();
        return fp;
    } catch (e) { return null; }
}

function computeBufferFingerprint(buffer) {
    try {
        const size = buffer.length;
        if (size === 0) return crypto.createHash("md5").update("empty:0").digest("hex");
        const chunks = [];
        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigUInt64LE(BigInt(size));
        chunks.push(sizeBuf);

        if (size <= FINGERPRINT_HEAD) {
            chunks.push(buffer);
        } else if (size <= FINGERPRINT_HEAD + FINGERPRINT_TAIL) {
            chunks.push(buffer.subarray(0, FINGERPRINT_HEAD));
            chunks.push(buffer.subarray(size - Math.min(FINGERPRINT_TAIL, size - FINGERPRINT_HEAD)));
        } else {
            chunks.push(buffer.subarray(0, FINGERPRINT_HEAD));
            const midPos = Math.floor(size / 2) - Math.floor(FINGERPRINT_MID / 2);
            chunks.push(buffer.subarray(midPos, midPos + FINGERPRINT_MID));
            chunks.push(buffer.subarray(size - FINGERPRINT_TAIL));
        }
        return crypto.createHash("md5").update(Buffer.concat(chunks)).digest("hex");
    } catch (e) { return null; }
}

// ============================================================================
// Quality Check & Intelligent Selection Logic
// ============================================================================

function _scoreDecodedText(s) {
    let bad = 0, printable = 0, cjk = 0;
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (s[i] === "\uFFFD") bad += 4;        // Replacement character penalty
        if (code === 0) bad += 6;              // NUL penalty
        if (code >= 0x20 && code !== 0x7f) printable++;
        if (code >= 0x4e00 && code <= 0x9fff) cjk += 3;  // CJK bonus
    }
    return printable + cjk - bad;
}

function _detectEncodingConfidence(buf) {
    if (!buf || buf.length === 0) return 0;
    const candidates = [
        { enc: "utf8", text: buf.toString("utf8") },
        { enc: "latin1", text: buf.toString("latin1") },
    ];

    // Simple UTF-16 detection
    if (buf.length >= 2) {
        if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
            // BOM present, high confidence if valid
            // But let's check content score too
            candidates.push({ enc: "utf16le", text: buf.toString("utf16le") });
        } else {
            // Heuristic: check null distribution for UTF-16LE vs BE
            let zEven = 0, zOdd = 0, n = Math.min(buf.length, 1024);
            for (let i = 0; i < n; i++) if (buf[i] === 0) i % 2 === 0 ? zEven++ : zOdd++;
            if (zOdd > n * 0.1 && zOdd > zEven * 2) candidates.push({ enc: "utf16le", text: buf.toString("utf16le") });
            if (zEven > n * 0.1 && zEven > zOdd * 2) candidates.push({ enc: "utf16be", text: _decodeUtf16be(buf) });
        }
    }

    let maxScore = -Infinity;
    for (const c of candidates) {
        const score = _scoreDecodedText(c.text);
        if (score > maxScore) maxScore = score;
    }

    // Normalized score: good text usually has score/length > 0.8 (if mostly ASCII) or > 1.5 (if CJK)
    // Bad text (garbage) often has low or negative score.
    const normalized = maxScore / Math.max(1, buf.length);
    // Map to 0-1 confidence.
    // < 0.2 -> 0
    // > 0.8 -> 1
    return Math.min(1, Math.max(0, (normalized - 0.2) / 0.6));
}

function _checkHtmlIntegrity(htmlText) {
    if (!htmlText) return 0;
    // Check for broken tags like </span or <div
    // Or mojibake in tags like <?/span>
    const brokenCloseTags = (htmlText.match(/[\?\uFFFD]\/[a-z]{1,12}\s*>/gi) || []).length;
    const brokenOpenTags = (htmlText.match(/[\?\uFFFD][a-z]{1,12}[\s>]/gi) || []).length;
    const totalTags = (htmlText.match(/<\/?[a-z]{1,12}/gi) || []).length;

    if (totalTags === 0) return 0.5; // No tags, uncertain

    const brokenRatio = (brokenCloseTags + brokenOpenTags) / totalTags;
    // If > 10% tags are broken, integrity is very low.
    return Math.max(0, 1 - brokenRatio * 5);
}

async function _checkPlainTextAlignment(htmlText) {
    try {
        const plainText = await vscode.env.clipboard.readText();
        if (!plainText || !htmlText) return false;

        const $ = getCheerio().load(htmlText);
        const textContent = $.text().trim();
        if (textContent.length < 10) return true; // Too short to verify, assume aligned

        // Pick anchors: start, middle, end
        const anchors = [
            textContent.substring(0, 20),
            textContent.substring(Math.floor(textContent.length / 2), Math.floor(textContent.length / 2) + 20),
            textContent.substring(Math.max(0, textContent.length - 20)),
        ].map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 5);

        if (anchors.length === 0) return true;

        let matchCount = 0;
        for (const anchor of anchors) {
            if (plainText.includes(anchor)) matchCount++;
        }

        // Require at least 2/3 matches or 100% if only 1 anchor
        return matchCount >= Math.min(anchors.length, 2);
    } catch { return false; }
}

function _isResultQualityAcceptable(blocks) {
    if (!blocks || blocks.length === 0) return false;
    const allText = blocks.filter(b => b.type === "text").map(b => b.text || "").join("");
    if (allText.length === 0) return true; // Image only is OK

    const badChars = (allText.match(/[\uFFFD]/g) || []).length;
    const questionMarks = (allText.match(/\?{3,}/g) || []).length; // Continuous ???

    const badRatio = badChars / allText.length;
    return badRatio < 0.05 && questionMarks < 3;
}

// ============================================================================
// Markdown Format Detection
// Detect whether plain text contains Markdown symbols, used to decide whether to prefer plain text over HTML
// ============================================================================
function _looksLikeMarkdown(text) {
    if (!text || text.length < 3) return false;

    // Markdown symbol patterns
    const markdownPatterns = [
        /^#{1,6}\s+\S/m,                    // Headings: # ## ### etc.
        /^\s*[-*+]\s+\S/m,                  // Unordered list: - * +
        /^\s*\d+\.\s+\S/m,                  // Ordered list: 1. 2. 3.
        /^\s*>\s+\S/m,                      // Blockquote: >
        /^---\s*$/m,                         // Horizontal rule: ---
        /^\*\*\*\s*$/m,                      // Horizontal rule: ***
        /^___\s*$/m,                         // Horizontal rule: ___
        /\*\*[^*]+\*\*/,                     // Bold: **text**
        /\*[^*]+\*/,                         // Italic: *text* (exclude list cases)
        /`[^`]+`/,                           // Inline code: `code`
        /^```/m,                             // Code block: ```
        /\[([^\]]+)\]\(([^)]+)\)/,          // Link: [text](url)
        /!\[([^\]]*)\]\(([^)]+)\)/,         // Image: ![alt](url)
    ];

    // Count matched patterns
    let matchCount = 0;
    for (const pattern of markdownPatterns) {
        if (pattern.test(text)) {
            matchCount++;
            // If matched clear Markdown markers (heading, hr, code block), return true directly
            if (/^#{1,6}\s+\S/m.test(text) ||      // Heading
                /^---\s*$/m.test(text) ||          // Horizontal rule
                /^\*\*\*\s*$/m.test(text) ||       // Horizontal rule
                /^```/m.test(text)) {               // Code block
                return true;
            }
        }
    }

    // If 2+ patterns match, treat as Markdown
    return matchCount >= 2;
}

// ============================================================================
// Core HTML Logic (The "Eyes" & "Hands")
// ============================================================================
async function _getSmartHtmlFromClipboard(progressCallback, token) {
    if (token?.isCancellationRequested) return null;
    if (progressCallback) progressCallback(0, q('h.progress.readHtml'));

    let rawBuf = null;
    let rawText = null;
    let baseUrl = "";

    if (process.platform === "win32") {
        // ★ 优先使用 Rust daemon（更快，内存更小）
        const rustBridge = getGlobal().rustBridge;
        if (rustBridge && rustBridge.isAvailable()) {
            try {
                const tempFileR = path.join(os.tmpdir(), `vscode_img_paste_r_${Date.now()}.bin`);
                const r = await rustBridge.call("dumpHtmlToFile", { path: tempFileR }, 2000);
                if (r && r.success && fs.existsSync(tempFileR)) {
                    const buf = fs.readFileSync(tempFileR);
                    try { fs.unlinkSync(tempFileR); } catch { }
                    if (buf && buf.length > 0) {
                        rawBuf = buf;
                        log(`[RustDaemon] Successfully dumped ${buf.length} bytes`, "INFO");
                    }
                }
            } catch (e) { log(`[RustDaemon] Dump failed: ${e.message}`, "DEBUG"); }
        }

        // ★ Fallback: Shell daemon
        if (!rawBuf) {
            const shellBridge = getGlobal().shellBridge;
            if (shellBridge && shellBridge.isAvailable()) {
                try {
                    const tempFileD = path.join(os.tmpdir(), `vscode_img_paste_d_${Date.now()}.bin`);
                    const r = await shellBridge.call("dumpHtmlToFile", { path: tempFileD }, 2000);
                    if (r && r.success && fs.existsSync(tempFileD)) {
                        const buf = fs.readFileSync(tempFileD);
                        try { fs.unlinkSync(tempFileD); } catch { }
                        if (buf && buf.length > 0) {
                            rawBuf = buf;
                            log(`[ShellDaemon] Successfully dumped ${buf.length} bytes`, "INFO");
                        }
                    }
                } catch (e) { log(`[ShellDaemon] Dump failed: ${e.message}`, "WARN"); }
            }
        }

        if (!rawBuf) {
            try {
                const tempFile = path.join(os.tmpdir(), `vscode_img_paste_${Date.now()}.bin`);
                const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    $code = @'
${CLIPBOARD_HELPER_CS}
'@
    Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies System.Windows.Forms,System.Drawing
    $res = [ClipboardHelper]::DumpHtmlToFile('${tempFile.replace(/\\/g, "\\\\")}')
    Write-Output $res
} catch {
    Write-Output ("Error: " + $_.Exception.Message)
}
`;
                await spawnOutput("powershell", ["-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript]);
                if (fs.existsSync(tempFile)) {
                    const buf = fs.readFileSync(tempFile);
                    try { fs.unlinkSync(tempFile); } catch { }
                    if (buf && buf.length > 0) {
                        rawBuf = buf;
                        log(`[PowerShellDump] Successfully dumped ${buf.length} bytes`, "INFO");
                    }
                }
            } catch (e) { log(`[Smart] powershell dump failed: ${e.message}`, "WARN"); }
        }
    }

    if (!rawBuf) {
        const t = await vscode.env.clipboard.readText();
        if (t && /<\/?(html|body|div|p|img|picture|source|span|a)\b/i.test(t)) rawText = t;
    }

    if (!rawBuf && !rawText) return null;

    if (token?.isCancellationRequested) return null;
    if (progressCallback) progressCallback(0, q('h.progress.smartDecode'));

    let htmlText = "";
    let payload = null;

    if (rawBuf) {
        // Pre-check for scheme selection decision later
        // We do decoding here anyway
        const sliced = _sliceCfHtmlPayload(rawBuf);
        baseUrl = sliced.sourceUrl || "";
        payload = sliced.fragBuf && sliced.fragBuf.length > 0 ? sliced.fragBuf : sliced.htmlBuf;

        const simpleUtf8 = _decodeUtf8Strict(rawBuf);
        if (simpleUtf8 !== null) {
            htmlText = payload.toString("utf8");
        } else {
            htmlText = _decodeHtmlBytesSmart(payload);
        }
    } else {
        htmlText = String(rawText || "");
    }

    if (!htmlText || !htmlText.trim()) return null;

    // --- Decision Point: Return metadata for intelligent selection ---
    // Instead of just returning $ and baseUrl, we return everything needed

    htmlText = _extractHtmlFragmentString(htmlText);
    htmlText = _repairBrokenAngleTags(htmlText);

    let safeHtml = sanitizeHtml(htmlText);
    safeHtml = _repairBrokenAngleTags(safeHtml);
    safeHtml = safeHtml.replace(/[\u0080-\uffff]/g, (ch) => `&#x${ch.charCodeAt(0).toString(16)};`);

    if (!safeHtml || !safeHtml.trim()) return null;

    if (token?.isCancellationRequested) return null;
    if (progressCallback) progressCallback(0, q('h.progress.htmlParse'));

    let $;
    try {
        $ = getCheerio().load(safeHtml, { decodeEntities: true, xmlMode: false });
        $("script, iframe, object, embed, style, link[rel=stylesheet], meta, base, form, input, button, textarea, noscript").remove();
        $("*").each((i, el) => {
            if (el.type !== "tag") return;
            const attribs = el.attribs || {};
            if (attribs.style) delete attribs.style;
            for (const k of Object.keys(attribs)) {
                if (k.toLowerCase().startsWith("on")) delete attribs[k];
            }
            if (attribs.href && attribs.href.toLowerCase().startsWith("javascript:")) delete attribs.href;
            if (attribs.src && attribs.src.toLowerCase().startsWith("javascript:")) delete attribs.src;
        });
    } catch (e) {
        log(`cheerio load failed: ${e.message}`, "ERROR");
        return null;
    }

    return { $, baseUrl, payload, htmlText }; // Return payload and htmlText for quality checks
}

const _UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });
function _decodeUtf8Strict(buf) { try { return _UTF8_FATAL_DECODER.decode(buf); } catch { return null; } }

function _parseCfHtmlHeaderFromBuffer(buf) {
    try {
        const headLen = Math.min(buf.length, 4096);
        const head = buf.subarray(0, headLen).toString("latin1");
        const pickInt = (key) => { const m = new RegExp(key + ":(\\d+)", "i").exec(head); return m ? parseInt(m[1], 10) : null; };
        const startHTML = pickInt("StartHTML"), endHTML = pickInt("EndHTML"), startFrag = pickInt("StartFragment"), endFrag = pickInt("EndFragment");
        let sourceUrl = ""; const m = /SourceURL:(.*)\r?\n/i.exec(head); if (m) sourceUrl = m[1].trim();
        return { startHTML, endHTML, startFrag, endFrag, sourceUrl };
    } catch { return { startHTML: null, endHTML: null, startFrag: null, endFrag: null, sourceUrl: "" }; }
}

function _sliceCfHtmlPayload(buf) {
    try {
        const h = _parseCfHtmlHeaderFromBuffer(buf);
        let htmlBuf = buf, fragBuf = null;
        if (h.startHTML != null && h.endHTML != null && h.endHTML > h.startHTML) htmlBuf = buf.subarray(h.startHTML, h.endHTML);
        if (h.startFrag != null && h.endFrag != null && h.endFrag > h.startFrag) fragBuf = buf.subarray(h.startFrag, h.endFrag);
        return { htmlBuf, fragBuf, sourceUrl: h.sourceUrl || "" };
    } catch { return { htmlBuf: buf, fragBuf: null, sourceUrl: "" }; }
}

function _decodeUtf16be(buf) {
    const b = Buffer.from(buf);
    for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
    return b.toString("utf16le");
}

function _decodeHtmlBytesSmart(buf) {
    if (!buf || !buf.length) return "";
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return _decodeUtf16be(buf.subarray(2));
    let zEven = 0, zOdd = 0, n = Math.min(buf.length, 4096);
    for (let i = 0; i < n; i++) if (buf[i] === 0) i % 2 === 0 ? zEven++ : zOdd++;
    if (zOdd > n * 0.1 && zOdd > zEven * 2) return buf.toString("utf16le");
    if (zEven > n * 0.1 && zEven > zOdd * 2) return _decodeUtf16be(buf);
    try { return _UTF8_FATAL_DECODER.decode(buf); } catch { }
    return buf.toString("utf8");
}

function _repairBrokenAngleTags(html) {
    if (!html) return "";
    let s = String(html).replace(/\u0000/g, "");
    s = s.replace(/[\?\uFFFD]\s*\/\s*([a-zA-Z]{1,12})\s*>/g, "</$1>");
    s = s.replace(/[\?\uFFFD]\s*([a-zA-Z]{1,12})(\s|>)/g, "<$1$2>");
    return s;
}

function _extractHtmlFragmentString(htmlText) {
    if (!htmlText) return "";
    let s = String(htmlText);
    const si = s.indexOf("<!--StartFragment-->"), ei = s.indexOf("<!--EndFragment-->");
    if (si >= 0 && ei > si) return s.substring(si + 20, ei);
    const m = /<html[\s\S]*<\/html>/i.exec(s);
    if (m) return m[0];
    const lt = s.indexOf("<");
    return lt >= 0 ? s.slice(lt) : s;
}

function sanitizeHtml(html) {
    if (!html) return "";
    const $ = getCheerio().load(html, { decodeEntities: false });
    $("script, iframe, object, embed").remove();
    $("*").each(function () {
        const attrs = this.attribs || {};
        for (const attr of Object.keys(attrs)) if (attr.toLowerCase().startsWith("on") || attr.toLowerCase().startsWith("javascript:")) $(this).removeAttr(attr);
    });
    return $.html();
}



function extractVideoUrlsFromHtmlFragment(htmlContent, baseUrl = '') {
    try {
        const cheerio = require('cheerio');
        const { URL: NodeURL } = require('url');

        const $ = cheerio.load(htmlContent);
        const videoUrls = new Set();

        // Find video sources within <video> tags
        $('video source, video').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                try {
                    const fullUrl = new URL(src, baseUrl).href;
                    videoUrls.add(fullUrl);
                } catch (e) {
                    // If URL parsing fails, add the raw URL
                    videoUrls.add(src);
                }
            }

            // Check other possible video source attributes
            const attrsToCheck = ['data-src', 'data-source', 'data-video', 'data-url'];
            for (const attr of attrsToCheck) {
                const attrValue = $(elem).attr(attr);
                if (attrValue) {
                    try {
                        const fullUrl = new URL(attrValue, baseUrl).href;
                        videoUrls.add(fullUrl);
                    } catch (e) {
                        videoUrls.add(attrValue);
                    }
                }
            }
        });

        // Find <iframe> tags (may be video players)
        $('iframe').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                try {
                    const fullUrl = new URL(src, baseUrl).href;
                    videoUrls.add(fullUrl);
                } catch (e) {
                    // If URL parsing fails, add the raw URL
                    videoUrls.add(src);
                }
            }
        });

        // Find elements whose class or id suggests video
        $('[class*="video" i], [id*="video" i]').each((i, elem) => {
            const src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-source') || $(elem).attr('data-video');
            if (src) {
                try {
                    const fullUrl = new URL(src, baseUrl).href;
                    videoUrls.add(fullUrl);
                } catch (e) {
                    // If URL parsing fails, add the raw URL
                    videoUrls.add(src);
                }
            }
        });

        // Find links that look like video files by extension
        const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.m4v', '.flv', '.mkv', '.m3u8', '.mpd'];
        $('a, [href], [data-href]').each((i, elem) => {
            const href = $(elem).attr('href') || $(elem).attr('data-href');
            if (href) {
                const lowerHref = href.toLowerCase();
                if (videoExtensions.some(ext => lowerHref.includes(ext))) {
                    try {
                        const fullUrl = new URL(href, baseUrl).href;
                        videoUrls.add(fullUrl);
                    } catch (e) {
                        videoUrls.add(href);
                    }
                }
            }
        });

        // Try extracting JSON-style video URLs from script tags and global text
        // Many SPA/mobile pages store video info in JSON (e.g. Baidu News)
        $('script').each((i, elem) => {
            let scriptContent = $(elem).text();
            if (scriptContent && scriptContent.trim()) {
                // 1. Preprocess: unescape slashes and Unicode escapes in JSON
                scriptContent = scriptContent.replace(/\\\//g, '/').replace(/\\u002F/gi, '/');

                // 2. Scan common video fields (enhanced regex, more formats)
                // Compatible with: "video_url":"http..." and video_url="http..." and video_url: "http..."
                const commonKeys = ['play_url', 'video_url', 'playUrl', 'videoUrl', 'src', 'url', 'mp4', 'm3u8'];

                // Lenient regex: key followed by any symbols until http
                const keyRegexStr = `(${commonKeys.join('|')})[^:="']*[:="']+\s*["']?(https?://[^"']+)["']?`;
                const keyRegex = new RegExp(keyRegexStr, 'gi');

                let keyMatch;
                while ((keyMatch = keyRegex.exec(scriptContent)) !== null) {
                    const potentialUrl = keyMatch[2];
                    // Validate if it contains a video extension or looks like a video URL
                    if (extensions.some(ext => potentialUrl.includes('.' + ext)) || potentialUrl.includes('video')) {
                        try {
                            const fullUrl = new URL(potentialUrl, baseUrl).href;
                            videoUrls.add(fullUrl);
                        } catch (e) {
                            videoUrls.add(potentialUrl);
                        }
                    }
                }

                // 3. Original generic regex extraction
                const videoUrlRegex = /https?:\/\/[^\s"'<>()\[\]{}]+\.(mp4|webm|ogg|mov|avi|m4v|flv|mkv|m3u8|mpd)[^\s"'<>()\[\]{}]*(\?[\w\-._~:?#[\]@!$&'()*+,;=%]*)?/gi;
                let match;
                while ((match = videoUrlRegex.exec(scriptContent)) !== null) {
                    try {
                        const fullUrl = new URL(match[0], baseUrl).href;
                        videoUrls.add(fullUrl);
                    } catch (e) {
                        videoUrls.add(match[0]);
                    }
                }
            }
        });

        return Array.from(videoUrls);
    } catch (error) {
        console.error(q('h.log.extractVideoUrlFailed'), error);
        return [];
    }
}

// Helper function to extract video URLs from a web page
async function extractVideoUrlsFromWebPage(url) {
    try {
        const cheerio = require('cheerio');
        const https = require('https');
        const http = require('http');
        const { URL: NodeURL } = require('url');

        const commonHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        };

        // ★ Always use fetchViaHttps because it uses simplified headers to avoid server rejection
        function fetchViaHttps(targetUrl, customHeaders = {}) {
            return new Promise((resolve, reject) => {
                const urlObj = new NodeURL(targetUrl);
                const client = urlObj.protocol === 'https:' ? https : http;

                const options = {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        ...customHeaders
                    },
                    timeout: 15000
                };

                const request = client.get(targetUrl, options, (response) => {
                    // Handle redirects
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        fetchViaHttps(new NodeURL(response.headers.location, targetUrl).href, customHeaders)
                            .then(resolve)
                            .catch(reject);
                        return;
                    }

                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => {
                        if (response.statusCode >= 200 && response.statusCode < 300) {
                            resolve(data);
                        } else {
                            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                        }
                    });
                    response.on('error', (err) => { reject(err); });
                });

                request.on('error', (err) => { reject(err); });
                request.on('timeout', () => {
                    request.destroy();
                    reject(new Error('Request timeout'));
                });
            });
        }

        // Use fetchViaHttps directly; do not rely on node-fetch or global.fetch
        const html = await fetchViaHttps(url, commonHeaders);

        // Detect Cloudflare challenge page signatures
        if (html.includes('cf-turnstile') || html.includes('challenge-platform') || html.includes('Cloudflare Ray ID')) {
            throw new Error(`HTTP 403: Cloudflare Challenge Detected`);
        }

        const $ = cheerio.load(html);

        const videoUrls = new Set();

        // Find video sources within <video> tags
        $('video source').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                const fullUrl = new URL(src, url).href;
                videoUrls.add(fullUrl);
            }

            const srcAttr = elem.attribs['src'];
            if (srcAttr) {
                const fullUrl = new URL(srcAttr, url).href;
                videoUrls.add(fullUrl);
            }
        });

        // Find src attribute on <video> tags directly
        $('video').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                const fullUrl = new URL(src, url).href;
                videoUrls.add(fullUrl);
            }
        });

        // Find <iframe> tags (may be video players)
        $('iframe').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                const fullUrl = new URL(src, url).href;
                videoUrls.add(fullUrl);
            }
        });

        // Find elements whose class suggests video
        $('[class*="video" i], [id*="video" i]').each((i, elem) => {
            const src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-source');
            if (src) {
                const fullUrl = new URL(src, url).href;
                videoUrls.add(fullUrl);
            }
        });

        // Find links that look like video files by extension
        const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.m4v', '.flv'];
        $('a, [href]').each((i, elem) => {
            const href = $(elem).attr('href');
            if (href) {
                const lowerHref = href.toLowerCase();
                if (videoExtensions.some(ext => lowerHref.includes(ext))) {
                    const fullUrl = new URL(href, url).href;
                    videoUrls.add(fullUrl);
                }
            }
        });

        return Array.from(videoUrls);
    } catch (error) {
        throw error;
    }
}

function _buildBlocksFromSanitizedDom($, baseUrl) {
    const blocks = [];
    let textBuf = "";
    const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote"]);

    function resolve(src) {
        try { return baseUrl ? new URL(src, baseUrl).href : src; } catch { return src; }
    }

    function flush() {
        if (!textBuf.trim()) { textBuf = ""; return; }
        const lines = textBuf.replace(/\r/g, "").split("\n");
        for (const line of lines) if (line.trim()) blocks.push({ type: "text", text: line.trim() });
        textBuf = "";
    }
    function walk(node) {
        if (node.type === "text") { textBuf += node.data; }
        else if (node.type === "tag") {
            const tag = node.name.toLowerCase();
            if (tag === "br") { textBuf += "\n"; return; }
            if (tag === "img") {
                flush();
                const rawSrc = $(node).attr("src") || $(node).attr("data-src");
                const src = resolve(rawSrc);
                if (src) blocks.push({ type: "media", kind: "image", src, status: "pending" });
                return;
            }
            if (tag === "video") {
                flush();
                let rawSrc = $(node).attr("src") || $(node).attr("data-src");
                if (!rawSrc) {
                    const sources = $(node).find("source");
                    for (let i = 0; i < sources.length; i++) {
                        rawSrc = $(sources[i]).attr("src");
                        if (rawSrc) break;
                    }
                }
                const src = resolve(rawSrc);
                if (src) blocks.push({ type: "media", kind: "video", src, status: "pending" });
                return;
            }
            if (tag === "iframe" || tag === "embed") {
                flush();
                const rawSrc = $(node).attr("src");
                const src = resolve(rawSrc);
                if (src) blocks.push({ type: "media", kind: "video", src, status: "pending" });
                return;
            }
            const isBlock = BLOCK_TAGS.has(tag);
            if (isBlock) textBuf += "\n";
            for (const c of node.children || []) walk(c);
            if (isBlock) { textBuf += "\n"; flush(); }
        }
    }
    const root = $("body").length ? $("body")[0] : $.root()[0];
    if (root) (root.children || []).forEach(walk);
    flush();
    if (!blocks.length) blocks.push({ type: "text", text: "" });
    return blocks;
}

async function _zipDomWithCleanText($, cleanText, baseUrl) {
    const blocks = [];
    const flatNodes = [];

    function resolve(src) {
        try { return baseUrl ? new URL(src, baseUrl).href : src; } catch { return src; }
    }

    function structuralWalk(node) {
        if (node.type === "text") {
            const t = $(node).text();
            if (t.length > 0) flatNodes.push({ type: "text", content: t });
        } else if (node.type === "tag") {
            if (node.name === "img") {
                const rawSrc = $(node).attr("src") || $(node).attr("data-src");
                const src = resolve(rawSrc);
                if (src) flatNodes.push({ type: "media", kind: "image", src, status: "pending" });
            } else if (node.name === "video") {
                let rawSrc = $(node).attr("src") || $(node).attr("data-src");
                if (!rawSrc && node.children) {
                    for (const c of node.children) {
                        if (c.type === "tag" && c.name === "source") {
                            rawSrc = $(c).attr("src");
                            if (rawSrc) break;
                        }
                    }
                }
                const src = resolve(rawSrc);
                if (src) flatNodes.push({ type: "media", kind: "video", src, status: "pending" });
            } else if (node.name === "iframe" || node.name === "embed") {
                const rawSrc = $(node).attr("src");
                const src = resolve(rawSrc);
                if (src) flatNodes.push({ type: "media", kind: "video", src, status: "pending" });
            } else { (node.children || []).forEach(structuralWalk); }
        }
    }
    const root = $("body").length ? $("body")[0] : $.root()[0];
    if (root) (root.children || []).forEach(structuralWalk);

    let textCursor = 0;

    function getSmartAnchor(str, startFrom = 0, len = 10) {
        if (str.length <= len) return { text: str, offset: 0 };
        const sub = str.substring(startFrom);
        const match = /[\p{L}\p{N}]{4,}/u.exec(sub);
        if (match) {
            const safeLen = Math.min(match[0].length, len);
            return {
                text: match[0].substring(0, safeLen),
                offset: startFrom + match.index
            };
        }
        return { text: str.substring(startFrom, startFrom + len), offset: startFrom };
    }

    for (const node of flatNodes) {
        if (node.type === "media") {
            blocks.push(node);
        } else if (node.type === "text") {
            const htmlContent = node.content;
            if (!htmlContent) continue;

            const trimmedHtml = htmlContent.trim();
            if (trimmedHtml.length === 0) {
                const wsMatch = cleanText.slice(textCursor).match(/^\s+/);
                if (wsMatch) {
                    if (htmlContent.length < 5) {
                        const current = cleanText.slice(textCursor, textCursor + htmlContent.length);
                        if (/^\s+$/.test(current)) {
                            blocks.push({ type: "text", text: current });
                            textCursor += current.length;
                        }
                    }
                }
                continue;
            }

            let searchWindow;
            if (trimmedHtml.length < 10) {
                searchWindow = 60;
            } else if (trimmedHtml.length < 50) {
                searchWindow = 200;
            } else {
                searchWindow = Math.min(trimmedHtml.length * 1.5 + 100, 600);
            }

            const searchArea = cleanText.slice(textCursor, textCursor + searchWindow);

            const startAnchorObj = getSmartAnchor(trimmedHtml, 0, 10);
            let idx = searchArea.indexOf(startAnchorObj.text);
            let matchedOffsetInHtml = startAnchorObj.offset;

            if (idx === -1 && trimmedHtml.length > 20) {
                const secondAnchorObj = getSmartAnchor(trimmedHtml, Math.floor(trimmedHtml.length / 3), 10);
                const idx2 = searchArea.indexOf(secondAnchorObj.text);
                if (idx2 !== -1) {
                    idx = idx2;
                    matchedOffsetInHtml = secondAnchorObj.offset;
                }
            }

            if (idx !== -1) {
                let blockStartRel = idx - matchedOffsetInHtml;
                if (blockStartRel < 0) blockStartRel = 0;

                if (blockStartRel > 0) {
                    blocks.push({ type: "text", text: searchArea.substring(0, blockStartRel) });
                    textCursor += blockStartRel;
                }

                const endScanLen = 10;
                let endAnchorObj;
                {
                    const tailLimit = 150;
                    const tailStart = Math.max(0, trimmedHtml.length - tailLimit);
                    const tailStr = trimmedHtml.substring(tailStart);

                    if (tailStr.length >= 15) {
                        endAnchorObj = {
                            text: tailStr.substring(tailStr.length - 15),
                            offset: tailStart + tailStr.length - 15
                        };
                    } else if (tailStr.length >= 8) {
                        endAnchorObj = {
                            text: tailStr.substring(tailStr.length - 8),
                            offset: tailStart + tailStr.length - 8
                        };
                    } else {
                        const s = Math.max(0, trimmedHtml.length - endScanLen);
                        endAnchorObj = { text: trimmedHtml.substring(s), offset: s };
                    }
                }

                const maxContentLen = trimmedHtml.length * 1.5 + 20;
                const contentSearchArea = cleanText.slice(textCursor, textCursor + maxContentLen);
                let contentLen = 0;

                if (trimmedHtml.length < 5) {
                    contentLen = trimmedHtml.length;
                } else {
                    const subIdx = contentSearchArea.lastIndexOf(endAnchorObj.text);

                    if (subIdx !== -1) {
                        contentLen = subIdx + endAnchorObj.text.length;
                    } else {
                        if (endAnchorObj.text.length > 4) {
                            const shortAnchor = endAnchorObj.text.substring(endAnchorObj.text.length - 4);
                            const subIdx2 = contentSearchArea.lastIndexOf(shortAnchor);
                            if (subIdx2 !== -1) {
                                contentLen = subIdx2 + shortAnchor.length;
                            } else {
                                contentLen = trimmedHtml.length;
                            }
                        } else {
                            contentLen = trimmedHtml.length;
                        }
                    }
                }

                if (contentLen > contentSearchArea.length) contentLen = contentSearchArea.length;
                if (contentLen < 0) contentLen = 0;

                const fullChunk = cleanText.substr(textCursor, contentLen);
                blocks.push({ type: "text", text: fullChunk });
                textCursor += contentLen;

            } else {
                const len = htmlContent.length;
                const safeLen = Math.min(len, cleanText.length - textCursor);
                if (safeLen > 0) {
                    const chunk = cleanText.substr(textCursor, safeLen);
                    blocks.push({ type: "text", text: chunk });
                    textCursor += safeLen;
                }
            }
        }
    }

    if (textCursor < cleanText.length) {
        blocks.push({ type: "text", text: cleanText.substring(textCursor) });
    }
    return blocks;
}

async function verifyVideoFile(filePath, transId = null) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    let ffmpeg = 'ffmpeg';
    try {
        const globalPath = getGlobal().ffmpegPath();
        if (globalPath && globalPath !== 'ffmpeg') {
            ffmpeg = globalPath;
        } else {
            const d = getSharedDownloader();
            if (d && d.ytdlp && d.ytdlp.ffmpegPath) ffmpeg = d.ytdlp.ffmpegPath;
        }
    } catch (e) { }

    return new Promise((resolve) => {
        const proc = cp.spawn(ffmpeg, ['-i', filePath]);
        let stderr = '';
        proc.stderr.on('data', d => stderr += d.toString());
        const cleanup = () => { try { proc.kill(); } catch (e) { } };
        const timer = setTimeout(() => { cleanup(); resolve(null); }, 30000);

        proc.on('close', () => {
            clearTimeout(timer);
            const isVideo = stderr.includes('Video:') || stderr.includes('Audio:');
            const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
            if (isVideo && durationMatch) {
                const currentName = path.basename(filePath);
                const ext = path.extname(filePath).toLowerCase();
                let finalPath = filePath;
                const isTooLong = currentName.length > 100;
                let newExt = ext;
                if (stderr.includes("Video: h264") && !['.mp4', '.mkv', '.mov'].includes(ext)) newExt = '.mp4';
                else if (stderr.includes("Video: vp9") && ext !== '.webm' && ext !== '.mkv') newExt = '.webm';

                if (isTooLong) {
                    const safeName = getTimestampFilename(newExt || '.mp4', transId || '0000', 0);
                    const p2 = path.join(path.dirname(filePath), safeName);
                    try { fs.renameSync(filePath, p2); finalPath = p2; } catch (e) { finalPath = filePath; }
                } else if (newExt !== ext) {
                    const p2 = filePath.replace(ext, newExt);
                    try { fs.renameSync(filePath, p2); finalPath = p2; } catch (e) { finalPath = filePath; }
                }
                resolve(finalPath);
            } else {
                try { fs.unlinkSync(filePath); } catch (e) { }
                log(`[Verify] Video verification failed for ${path.basename(filePath)} (no video stream or duration)`, "WARN");
                resolve(null);
            }
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            log(`[Verify] FFmpeg spawn error for ${path.basename(filePath)}: ${err.message}`, "ERROR");
            resolve(null);
        });
    });
}

async function _materializeImageBlocksToFiles(blocks, targetDir, progressCallback, token, transId, autoRename = false) {
    const pending = blocks.filter(b => b && b.type === "media" && (b.kind === "image" || b.kind === "video") && b.src && b.status === "pending");
    if (!pending.length) return;
    const securityLevelString = getGlobal().getConfig("downloadSecurityLevel") || "0: 最宽松"; // qq2q
    let securityLevel = 0;
    if (securityLevelString.startsWith("1")) securityLevel = 1;
    if (securityLevelString.startsWith("2")) securityLevel = 2;
    const d = getSharedDownloader({ securityLevel, baseDir: targetDir, downloadVideos: "all", ytdlpConcurrency: 2 });
    const httpTasks = [];
    const localTasks = [];
    const taskMap = new Map();
    const originalFilenames = new Map(); // Save original filename mapping
    let httpIndex = 0; // ★ Batch file index for unique filename generation
    for (const b of pending) {
        const src = String(b.src || "");
        if (/^data:/i.test(src) || /^file:/i.test(src)) localTasks.push(b);
        else {
            const tag = Math.random().toString(36).slice(2) + "_" + Date.now();
            b._tag = tag;
            const ext = b.kind === "video" ? ".mp4" : ".png";
            // ★ Unified source of truth: first try extracting original filename from URL; fall back to timestamp on failure
            // This keeps filenames consistent between HTML-block paste and downloadVideosFromUrl
            const originalFileName = getFilenameFromUrl(src, b.kind);
            // ★ Use transId + index for batch mode unique filename (fixes duplicate filename bug)
            const filename = originalFileName || getTimestampFilename(ext, transId, httpIndex);
            httpIndex++;
            const destPath = path.join(targetDir, filename);
            httpTasks.push({ url: src, tag, kind: b.kind || "image", destPath, referrer: b.referrer || "", maxBytes: 20000 * 1048576 });
            taskMap.set(tag, b);
            if (originalFileName) {
                originalFilenames.set(tag, originalFileName);
            }
        }
    }

    // ★ Key fix: pre-register all destPath into transaction tempFiles
    // This way on cancel, even if downloaded but not yet recorded into landedFiles, it can be deleted via tempFiles
    if (transId && httpTasks.length > 0) {
        try {
            const global = getGlobal();
            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
            if (trans) {
                const allDestPaths = httpTasks.map(t => t.destPath);
                const newTempFiles = [...(trans.tempFiles || []), ...allDestPaths];
                await global.TransactionManager.updateTransaction(transId, { tempFiles: [...new Set(newTempFiles)] });
            }
        } catch (e) {
            log(q('h.log.transactionPreregisterFailed', e.message), "WARN");
        }
    }

    let doneCount = 0;
    const total = pending.length;
    let localIndex = httpIndex; // ★ Continue from httpIndex for unified batch indexing
    for (const b of localTasks) {
        try {
            const src = String(b.src || "");
            let buf = null;
            let contentType = "";
            if (/^data:image\//i.test(src)) {
                const m = /^data:(image\/[a-z0-9\+\-\.]+);base64,(.*)$/i.exec(src);
                if (m) { contentType = m[1] || ""; buf = Buffer.from(m[2] || "", "base64"); }
            } else if (/^file:\/\//i.test(src)) {
                const localPath = _fileUriToLocalPath(src);
                if (localPath && fs.existsSync(localPath) && !fs.statSync(localPath).isDirectory()) {
                    ensureDir(targetDir);
                    const ext = path.extname(localPath) || ".png";
                    const originalName = path.basename(localPath);
                    // Prefer using original filename. Only fall back to timestamp style when filename is unavailable (e.g. only extension).
                    let filename = originalName;
                    if (!originalName || originalName === ext) {
                        // ★ Use transId + index for batch mode unique filename
                        filename = getTimestampFilename(ext, transId, localIndex);
                        localIndex++;
                    }
                    const destPath = path.join(targetDir, filename);
                    try {
                        fs.copyFileSync(localPath, destPath);

                        // Compute fingerprint first, then dedupe within the same directory
                        const fp = computeFingerprint(destPath);
                        let finalPath = destPath;

                        if (!autoRename && fp) {
                            // Fix: strictly forbid cross-folder dedupe; call local dedupe logic directly
                            finalPath = _tryLocalDeduplicate(destPath);
                        } else {
                            finalPath = autoRename ? destPath : _tryLocalDeduplicate(destPath);
                        }

                        b.filename = path.basename(finalPath);
                        b.path = finalPath;
                        b.fingerprint = computeFingerprint(finalPath);
                        b.size = fs.statSync(finalPath).size;
                        b.status = "ok";

                        // ★ Register Transaction (use normalized path)
                        if (transId) {
                            const global = getGlobal();
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                            if (trans) {
                                const normalizedPath = path.normalize(finalPath);
                                const newLanded = [...(trans.landedFiles || []), normalizedPath];
                                await global.TransactionManager.updateTransaction(transId, { landedFiles: [...new Set(newLanded)] });
                            }
                        }

                        // Prefill fingerprint cache
                        if (b.fingerprint) prefillFingerprint(finalPath, b.fingerprint);
                    } catch { b.status = "failed"; }
                    doneCount++;
                    if (progressCallback) progressCallback((doneCount / total) * 100, q('h.progress.processLocalResource', doneCount, total));
                    continue;
                }
            }
            if (buf && buf.length > 0) {
                ensureDir(targetDir);
                let ext = _guessExtFromUrl(src, contentType);
                if (!isImageExtForClipboard(ext)) {
                    try { const dim = sizeOf(buf); if (dim && dim.type) ext = "." + dim.type; } catch { ext = ".webp"; }
                }
                // ★ Use transId + index for batch mode unique filename
                const filename = getTimestampFilename(ext, transId, localIndex);
                localIndex++;
                const destPath = path.join(targetDir, filename);
                try {
                    fs.writeFileSync(destPath, buf);

                    const finalPath = autoRename ? destPath : _tryGlobalDeduplicate(destPath);
                    const fp = computeFingerprint(finalPath); // Re-compute in case it changed

                    b.filename = path.basename(finalPath);
                    b.path = finalPath;
                    b.fingerprint = fp || null;
                    b.size = fs.statSync(finalPath).size;
                    b.status = "ok";

                    // ★ Register Transaction (use normalized path)
                    if (transId) {
                        const global = getGlobal();
                        const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                        if (trans) {
                            const normalizedPath = path.normalize(finalPath);
                            const newLanded = [...(trans.landedFiles || []), normalizedPath];
                            await global.TransactionManager.updateTransaction(transId, { landedFiles: [...new Set(newLanded)] });
                        }
                    }

                    // Prefill fingerprint cache
                    if (b.fingerprint) prefillFingerprint(finalPath, b.fingerprint);
                } catch { b.status = "failed"; }
            }
        } catch { b.status = "failed"; }
        doneCount++;
        if (progressCallback) progressCallback((doneCount / total) * 100, q('h.progress.processLocalResource', doneCount, total));
    }
    if (httpTasks.length > 0) {
        try {
            const r = await d.downloadAll(httpTasks, targetDir, {
                onProgress: (t, e) => { if (e.type === "done" || e.type === "error") { doneCount++; if (progressCallback) progressCallback((doneCount / total) * 100, q('h.progress.downloading', doneCount, total)); } }
            });
            // ★ FIX: Use confirmed fingerprints map to avoid "pointing to deleted file" bug
            // When same-batch files have identical content, earlier processed files might point to
            // files that get deleted by later dedupe operations. This map ensures we always
            // reference the FIRST confirmed file for each fingerprint.
            const confirmedFingerprints = new Map(); // fingerprint -> confirmed path

            for (const res of r.results) {
                try {
                    const block = taskMap.get(res.tag);
                    if (!block) continue;
                    if (res.success) {
                        let dlPath = res.path || res.destPath;
                        const originalFileName = originalFilenames.get(res.tag);

                        if (block.kind === "video") {
                            dlPath = await verifyVideoFile(dlPath, transId);
                            if (!dlPath) {
                                block.status = "failed";
                                block.error = "Video verification failed";
                                continue;
                            }
                        }

                        // Compute fingerprint first
                        const fp = computeFingerprint(dlPath);
                        let finalPath = dlPath;
                        let isNewFile = true;

                        if (!autoRename && fp) {
                            // ★ Step 1: Check same-batch dedupe (confirmedFingerprints)
                            if (confirmedFingerprints.has(fp)) {
                                // Same fingerprint already confirmed in this batch, reuse it
                                const existingPath = confirmedFingerprints.get(fp);
                                try {
                                    fs.unlinkSync(dlPath);
                                    log(`[Dedupe] Same-batch duplicate: ${path.basename(dlPath)} -> reuse: ${path.basename(existingPath)}`, "INFO");
                                } catch (e) {
                                    log(`[Dedupe] Failed to delete duplicate ${dlPath}: ${e.message}`, "WARN");
                                }
                                finalPath = existingPath;
                                isNewFile = false;
                            } else {
                                // ★ Step 2: Check cross-batch dedupe (existing files in directory)
                                const tempPath = _tryLocalDeduplicate(dlPath);
                                isNewFile = (tempPath === dlPath);
                                finalPath = tempPath;
                                // ★ Register this fingerprint as confirmed (whether new or reused from old batch)
                                confirmedFingerprints.set(fp, finalPath);
                            }
                        } else {
                            finalPath = autoRename ? dlPath : _tryLocalDeduplicate(dlPath);
                            isNewFile = (finalPath === dlPath);
                            if (fp) confirmedFingerprints.set(fp, finalPath);
                        }

                        block.status = "ok";
                        block.path = finalPath;
                        block.filename = path.basename(finalPath);
                        try {
                            block.size = fs.statSync(finalPath).size;
                        } catch (e) {
                            block.size = 0;
                            log(`[Dedupe] Warning: Unable to stat finalPath: ${finalPath}`, "WARN");
                        }
                        block.fingerprint = computeFingerprint(block.path);
                        if (block.fingerprint) prefillFingerprint(block.path, block.fingerprint);

                        // ★ Transaction record: only record new files into landedFiles (use normalized path)
                        // Reused old files are not recorded; they should not be deleted on cancel
                        if (transId && isNewFile) {
                            const global = getGlobal();
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                            if (trans) {
                                const normalizedPath = path.normalize(finalPath);
                                const newLanded = [...(trans.landedFiles || []), normalizedPath];
                                // ★ Also remove from tempFiles (since it has been recorded into landedFiles)
                                const newTempFiles = (trans.tempFiles || []).filter(f => f !== dlPath && f !== finalPath);
                                await global.TransactionManager.updateTransaction(transId, {
                                    landedFiles: [...new Set(newLanded)],
                                    tempFiles: newTempFiles
                                });
                            }
                        } else if (transId && !isNewFile) {
                            // ★ Reused old file: remove from tempFiles (since dlPath has been deleted)
                            const global = getGlobal();
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                            if (trans) {
                                const newTempFiles = (trans.tempFiles || []).filter(f => f !== dlPath);
                                await global.TransactionManager.updateTransaction(transId, { tempFiles: newTempFiles });
                            }
                        }
                    } else { block.status = "failed"; block.error = res.error; }
                } catch (e) {
                    log(q('h.log.downloadResultFailed', res.tag, e.message), "ERROR");
                }
            }
        } catch (e) { log(`dow.js downloadAll failed: ${e.message}`, "ERROR"); }
    }
}

// ============================================================================
// Shell / File Clipboard
// ============================================================================
// ★ File copy with progress (async version so UI can update)
/**
 * Async safe recursive folder copy; supports cancel checks and returns accumulated size
 */
async function safeCopyFolderRecursiveAsync(src, dest, token = null, shouldCancel = null) {
    const skipped = [];
    const errors = [];
    let totalSize = 0;

    const isCancelled = () => (token && token.isCancellationRequested) || (shouldCancel && shouldCancel());

    async function copyRecursive(srcPath, destPath) {
        if (isCancelled()) return;

        try {
            if (!safeAccessCheck(srcPath)) {
                skipped.push(srcPath);
                return;
            }

            const stat = await fs.promises.stat(srcPath).catch(() => null);
            if (!stat) return;

            if (stat.isDirectory()) {
                try {
                    if (!fs.existsSync(destPath)) {
                        await fs.promises.mkdir(destPath, { recursive: true });
                    }
                } catch (e) {
                    errors.push(q('h.log.createDirFailed', destPath, e.message));
                    return;
                }

                let entries = [];
                try {
                    entries = await fs.promises.readdir(srcPath);
                } catch (e) {
                    errors.push(q('h.log.readDirFailed', srcPath, e.message));
                    return;
                }

                for (const entry of entries) {
                    if (isCancelled()) break;
                    await copyRecursive(path.join(srcPath, entry), path.join(destPath, entry));
                }
            } else if (stat.isFile()) {
                try {
                    await fs.promises.copyFile(srcPath, destPath);
                    totalSize += stat.size;
                } catch (e) {
                    if (e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM') {
                        skipped.push(srcPath);
                        log(q('h.log.safeCopyBusy', srcPath), "WARN");
                    } else {
                        errors.push(q('h.log.copyFileFailed', srcPath, e.message));
                    }
                }
            }
        } catch (e) {
            errors.push(`${srcPath}: ${e.message}`);
        }
    }

    try {
        await copyRecursive(src, dest);
        return { success: !isCancelled(), skipped, errors, totalSize };
    } catch (e) {
        return { success: false, skipped, errors: [...errors, q('h.log.topLevelError', e.message)], totalSize: 0 };
    }
}

// ★ Fix: add token and transId parameters; record transaction while copying
async function processFilesForClipboardWithProgress(files, targetDir, progressCallback, token = null, transId = null, onCancelCallback = null, shouldCancel = null, autoRename = false) {
    const folders = files.filter((f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
    const validFiles = files.filter((f) => { try { return !fs.statSync(f).isDirectory(); } catch { return false; } });
    ensureDir(targetDir);
    const copiedFiles = [];
    const copiedFolders = [];
    const fingerprints = {};

    const totalItems = folders.length + validFiles.length;
    let processedItems = 0;
    let skippedCount = 0;
    let totalSize = 0;

    // ★ Record task start time for elapsed calculation
    const taskStartMs = Date.now();

    // ★ Current step info (for timed UI updates)
    let currentStepInfo = '';
    let currentItemName = '';
    let lastProgressUpdateMs = 0;
    const PROGRESS_UPDATE_INTERVAL = 3000; // Update once every 3 seconds

    // ★ Helper to yield the event loop
    const yieldToUI = () => new Promise(resolve => setImmediate(resolve));

    // ★ Combined cancel check: token or shouldCancel callback
    const isCancelled = () => token?.isCancellationRequested || (shouldCancel && shouldCancel());

    // ★ Batch update transaction record (update all files at once, using normalized paths)
    const batchUpdateTransaction = async (allFiles, allFolders) => {
        if (!transId) return;
        if (allFiles.length === 0 && allFolders.length === 0) return;
        try {
            const global = getGlobal();
            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
            if (trans) {
                const updates = {};
                if (allFiles.length > 0) {
                    // ★ Normalize all paths
                    const normalizedFiles = allFiles.map(f => path.normalize(f));
                    updates.landedFiles = [...new Set([...(trans.landedFiles || []), ...normalizedFiles])];
                }
                if (allFolders.length > 0) {
                    // ★ Normalize all paths
                    const normalizedFolders = allFolders.map(f => path.normalize(f));
                    updates.landedFolders = [...new Set([...(trans.landedFolders || []), ...normalizedFolders])];
                }
                if (Object.keys(updates).length > 0) {
                    await global.TransactionManager.updateTransaction(transId, updates);
                    log(q('h.log.transactionBatchUpdate', allFiles.length, allFolders.length), "INFO");
                }
            }
        } catch (e) {
            log(q('h.log.transactionBatchUpdateFailed', e.message), "WARN");
        }
    };

    // ★ Initial progress display
    if (progressCallback && totalItems > 0) {
        progressCallback(2, q('h.progress.prepareCopy', totalItems, folders.length, validFiles.length));
        await yieldToUI();
    }

    // ★ Add timer: update progress display every 3s (for large file/folder copy)
    let progressTimer = null;
    if (progressCallback) {
        progressTimer = setInterval(() => {
            if (isCancelled()) {
                clearInterval(progressTimer);
                progressTimer = null;
                return;
            }
            if (currentStepInfo && currentItemName) {
                const elapsedMs = Date.now() - taskStartMs;
                const pct = Math.round(((processedItems + 1) / Math.max(totalItems, 1)) * 85) + 5;
                const msg = _formatCopyProgress(currentStepInfo, currentItemName, totalSize, elapsedMs);
                progressCallback(pct, msg);
            }
        }, PROGRESS_UPDATE_INTERVAL);
    }

    // Copy folders
    for (let i = 0; i < folders.length; i++) {
        // ★ Check cancel state (user cancel or anchor lost)
        if (isCancelled()) {
            log(q('h.log.copyCancelled', copiedFolders.length, copiedFiles.length), "WARN");
            // ★ On cancel, batch-update transaction first to ensure all copied files are recorded
            await batchUpdateTransaction(copiedFiles, copiedFolders);
            if (onCancelCallback) onCancelCallback();
            break;
        }
        const folder = folders[i];
        try {
            const folderName = path.basename(folder);
            if (progressCallback) {
                const pct = Math.round(((processedItems + 1) / totalItems) * 85) + 5;
                currentStepInfo = q('h.progress.copyFolder', i + 1, folders.length, '').replace(/\]\s*$/, '').replace(/^\[/, '');
                currentItemName = folderName;
                const elapsedMs = Date.now() - taskStartMs;
                const msg = _formatCopyProgress(currentStepInfo, currentItemName, totalSize, elapsedMs);
                progressCallback(pct, msg);
                lastProgressUpdateMs = Date.now();
                await yieldToUI();
            }
            // Same-name folder: silent rename (unified behavior for q1/q2, no overwrite)
            let destFolder = path.join(targetDir, folderName);
            if (fs.existsSync(destFolder)) {
                destFolder = getUniquePath(targetDir, folderName, true);
            }

            // ★ Switch to async folder copy to avoid blocking main thread for large folders
            const result = await safeCopyFolderRecursiveAsync(folder, destFolder, token, shouldCancel);

            if (result.success || result.errors.length === 0) {
                copiedFolders.push(destFolder);
                totalSize += result.totalSize;
                if (result.skipped.length > 0) {
                    skippedCount += result.skipped.length;
                    log(q('h.log.copyFolderSkip', folder, result.skipped.length), "WARN");
                }
            } else {
                skippedCount++;
                log(q('h.log.copyFolderFailed', folder, result.errors.slice(0, 3).join('; ')), "WARN");
            }
        } catch (e) {
            skippedCount++;
            log(q('h.log.copyFolderException', folder, e.message), "WARN");
        }
        processedItems++;
    }

    // Copy files
    for (let i = 0; i < validFiles.length; i++) {
        // ★ Check cancel state (user cancel or anchor lost)
        if (isCancelled()) {
            log(q('h.log.copyCancelled', copiedFolders.length, copiedFiles.length), "WARN");
            // ★ On cancel, batch-update transaction first
            await batchUpdateTransaction(copiedFiles, copiedFolders);
            if (onCancelCallback) onCancelCallback();
            break;
        }
        const f = validFiles[i];
        try {
            const fileName = path.basename(f);
            if (progressCallback) {
                const pct = Math.round(((processedItems + 1) / totalItems) * 85) + 5;
                currentStepInfo = q('h.progress.copyFile', i + 1, validFiles.length, '').replace(/\]\s*$/, '').replace(/^\[/, '');
                currentItemName = fileName;
                const now = Date.now();
                const elapsedMs = now - taskStartMs;
                // ★ Force update once every 3s to show total copied size so far
                if (now - lastProgressUpdateMs >= PROGRESS_UPDATE_INTERVAL || i === 0 || i === validFiles.length - 1) {
                    const msg = _formatCopyProgress(currentStepInfo, currentItemName, totalSize, elapsedMs);
                    progressCallback(pct, msg);
                    lastProgressUpdateMs = now;
                }
                // Async copy doesn't need frequent yields, since fs.promises is non-blocking
                // But yielding every 10 files is still safer to give microtasks some room
                if (i % 10 === 0) {
                    await yieldToUI();
                }
            }

            if (!safeAccessCheck(f)) {
                skippedCount++;
                log(q('h.log.skipInaccessible', f), "WARN");
                processedItems++;
                continue;
            }

            const srcFingerprint = computeFingerprint(f);
            if (srcFingerprint) {
                fingerprints[f] = srcFingerprint;
            }

            const ext = path.extname(f);
            const isImg = isImageExtForClipboard(ext);
            const originalName = path.basename(f);

            let destName = originalName;
            if (isImg && (!originalName || originalName === ext)) {
                // ★ Use transId + index for batch mode unique filename
                destName = getTimestampFilename(ext, transId, i);
            }
            let dest = path.join(targetDir, destName);

            // Same-name file: silent rename (unified behavior for q1/q2, no overwrite)
            if (fs.existsSync(dest)) {
                const dstFingerprint = computeFingerprint(dest);
                const srcFingerprint2 = srcFingerprint || computeFingerprint(f);
                if (dstFingerprint === srcFingerprint2) {
                    // Same content, skip copy
                    copiedFiles.push(dest);
                    if (srcFingerprint2) prefillFingerprint(dest, srcFingerprint2);
                    processedItems++;
                    continue;
                }
                // Different content, rename
                dest = getUniquePath(targetDir, destName, false);
            }

            // ★ Switch to async file copy; fully solve big-file paste stutter
            await fs.promises.copyFile(f, dest);

            // Local dedupe check
            const finalPath = autoRename ? dest : _tryLocalDeduplicate(dest);
            if (finalPath !== dest) {
                copiedFiles.push(finalPath);
            } else {
                if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);
                copiedFiles.push(dest);
            }
            try {
                const st = await fs.promises.stat(finalPath);
                totalSize += st.size;
            } catch { }
        } catch (e) {
            if (e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOENT') {
                skippedCount++;
                log(q('h.log.skipFile', e.code, f), "WARN");
            } else {
                log(q('h.log.copyFileFailed', f, e.message), "WARN");
            }
        }
        processedItems++;
    }

    // ★ Batch update transaction after copy completes (if not cancelled)
    if (!isCancelled()) {
        await batchUpdateTransaction(copiedFiles, copiedFolders);
    }

    // ★ Clear timer
    if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
    }

    return {
        type: "file_folder",
        files: copiedFiles,
        folders: copiedFolders,
        fingerprints: fingerprints,
        skippedCount: skippedCount,
        totalRequested: totalItems,
        totalSize: totalSize
    };
}

async function handleClipboardShell(targetDir, token = null, progressCallback = null, preFetchedFiles = null, preCalculatedTotalSize = 0, transId = null, onCancelCallback = null, shouldCancel = null, autoRename = false) {
    try {
        if (token?.isCancellationRequested || (shouldCancel && shouldCancel())) return null;

        // ★ File copy logic: works on ALL platforms (Windows, Linux, macOS)
        // Linux/macOS: preFetchedFiles comes from Shell bridge (xclip text/uri-list → file:// URIs)
        // Windows: preFetchedFiles comes from Shell bridge or PowerShell (CF_HDROP)
        {
            let files = preFetchedFiles;

            // ★ Prefer using pre-fetched file list (single source of truth)
            if (files && files.length > 0) {
                log(q('h.log.usePreFetchedFiles', files.length), "INFO");
            } else {
                // Fallback: fetch on demand
                log(q('h.log.noPreFetchedFiles'), "INFO");
                if (progressCallback) {
                    progressCallback(1, q('h.progress.getFileList'));
                }
                const res = await getGlobal().tryEngineCall({ python: "get_clipboard_files", shell: "getFiles" }, {}, 8000);
                if (res) {
                    if (res.paths && res.paths.length > 0) files = res.paths;
                    else if (res.files && res.files.length > 0) files = res.files;
                    log(q('h.log.tryEngineCallResult', JSON.stringify(res).slice(0, 200)), "INFO");
                } else {
                    log(q('h.log.tryEngineCallEmpty'), "WARN");
                }
            }

            if (files && files.length > 0) {
                log(q('h.log.startCopyFiles', files.length, files.slice(0, 3).join(', ') + '...'), "INFO");

                // ★ Show progress (concise format, no prefix)
                if (progressCallback) {
                    progressCallback(1, q('h.progress.detectItems', files.length));
                }

                // ★ Pass token and transId; record transaction while copying
                const result = await processFilesForClipboardWithProgress(files, targetDir, progressCallback, token, transId, onCancelCallback, shouldCancel, autoRename);

                // ★ Record copy result (including skipped info)
                const successFiles = (result?.files || []).length;
                const successFolders = (result?.folders || []).length;
                const skipped = result?.skippedCount || 0;
                log(q('h.log.copyResult', successFiles, successFolders, skipped), "INFO");
                // ★ Transaction is already recorded during processFilesForClipboardWithProgress; no duplicate updates here
                return result;
            }
        }

        const res = await getGlobal().tryOneByOne(async (bridge, name) => {
            try {
                const hasImg = await bridge.call("hasImage", {}, 1500);
                if (hasImg?.value) {
                    // ★ Use transId + index=0 for single screenshot (unified batch mode)
                    const fname = getTimestampFilename(".png", transId, 0);
                    const dest = path.join(targetDir, fname);
                    ensureDir(targetDir);
                    const saved = await bridge.call("saveImage", { path: dest }, 8000);
                    if (saved?.success && fs.existsSync(dest)) {
                        const st = fs.statSync(dest);
                        if (st.size > 0) {
                            // ✅ Key: in-memory screenshot must also go through local dedupe
                            const finalPath = autoRename ? dest : _tryLocalDeduplicate(dest);
                            const fp = computeFingerprint(finalPath);
                            const finalSize = (finalPath === dest) ? st.size : fs.statSync(finalPath).size;

                            // ★ Register Transaction (use normalized path)
                            if (transId) {
                                const global = getGlobal();
                                const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                                if (trans) {
                                    const normalizedPath = path.normalize(finalPath);
                                    const newLanded = [...(trans.landedFiles || []), normalizedPath];
                                    await global.TransactionManager.updateTransaction(transId, { landedFiles: [...new Set(newLanded)] });
                                }
                            }

                            return { type: "image", path: finalPath, fingerprint: fp, totalSize: finalSize };
                        }
                    }
                }
            } catch (e) { }
            return null;
        });
        if (res) return res;

        // Fallback to HTML if text looks like HTML
        const text = await vscode.env.clipboard.readText();
        if (text && (text.includes("<html") || text.includes("<body") || text.includes("<div") || text.includes("<img"))) {
            return await handleClipboardUnified(targetDir, progressCallback, token, transId, null, autoRename);
        }
    } catch (e) { log(q('h.log.shellClipboardFailed', e.message), "ERROR"); }
    return null;
}

// ============================================================================
// Main Entry
// ============================================================================
async function handleClipboardUnified(targetDir, progressCallback, token, transId, shouldCancel = null, autoRename = false) {
    // 1. Get raw data and parsed DOM using Unified "Eyes"
    const result = await _getSmartHtmlFromClipboard(progressCallback, token);
    if (!result) return null;

    // ★ Check cancel state
    if (token?.isCancellationRequested || (shouldCancel && shouldCancel())) return null;

    const { $, baseUrl, payload, htmlText } = result;

    // 2. Intelligent Decision Logic
    let useScheme1 = false;

    // Check user config first
    const forceScheme1 = getGlobal().getConfig("forceTextFlowScheme"); // Replaced old key name

    // Detect quality signals
    const encodingConf = payload ? _detectEncodingConfidence(payload) : 1;
    const htmlIntegrity = _checkHtmlIntegrity(htmlText);
    const plainTextOk = await _checkPlainTextAlignment(htmlText);

    log(`[SmartPaste] conf=${encodingConf.toFixed(2)}, integrity=${htmlIntegrity.toFixed(2)}, plainTextOk=${plainTextOk}`, "INFO");

    // Decision Tree
    if (forceScheme1) {
        // User explicitly requested to force Scheme 1 (Text Flow) to fix mojibake
        useScheme1 = true;
        log("[SmartPaste] User forced Scheme 1 via config", "INFO");
    } else if (encodingConf > 0.8 && htmlIntegrity > 0.8) {
        // High confidence in HTML -> Prefer Scheme 2 (DOM)
        useScheme1 = false;
    } else if (plainTextOk) {
        // HTML is shaky, but plain text aligns well -> Prefer Scheme 1 (Hybrid)
        useScheme1 = true;
    } else {
        // Both are bad, default to Scheme 2 as it handles images better usually
        useScheme1 = false;
    }

    let blocks = [];

    // Execution
    if (useScheme1) {
        if (progressCallback) progressCallback(0, q('h.progress.schemeOne'));
        const cleanText = await vscode.env.clipboard.readText() || "";
        blocks = await _zipDomWithCleanText($, cleanText, baseUrl);
    } else {
        if (progressCallback) progressCallback(0, q('h.progress.schemeTwo'));
        blocks = _buildBlocksFromSanitizedDom($, baseUrl);

        // Quality Check for Scheme 2 Result
        if (!_isResultQualityAcceptable(blocks)) {
            log("[SmartPaste] Scheme 2 result quality low, falling back to Scheme 1", "WARN");
            if (progressCallback) progressCallback(0, q('h.progress.qualityFallback'));
            const cleanText = await vscode.env.clipboard.readText() || "";
            blocks = await _zipDomWithCleanText($, cleanText, baseUrl);
        }
    }

    // Check whether there are video URLs to process
    const videoUrls = extractVideoUrlsFromHtmlFragment(htmlText, baseUrl);
    if (videoUrls.length > 0) {
        log(q('h.log.extractedVideoUrls', videoUrls.length), "INFO");

        // Collect existing media links to avoid duplicates
        const existingMediaSrcs = new Set(blocks.filter(b => b.type === "media").map(b => b.src));

        // Add video URLs into blocks as media resources
        for (const videoUrl of videoUrls) {
            // If already added during DOM parsing, skip
            if (existingMediaSrcs.has(videoUrl)) continue;

            blocks.push({
                type: "media",
                kind: "video",
                src: videoUrl,
                status: "pending"
            });
            existingMediaSrcs.add(videoUrl);
        }
    }

    if (blocks.some(b => b.type === "media")) {
        if (progressCallback) progressCallback(10, q('h.progress.detectMediaResources', blocks.filter(b => b.type === "media").length));
        await _materializeImageBlocksToFiles(blocks, targetDir, progressCallback, token, transId, autoRename);
    }

    return { type: "html_blocks", blocks, baseUrl };
}

// ============================================================================
// Auto-Detect & Dispatch (Migrated from qqq.js raceClipboard)
// ★ Accept full snapshot (single source of truth); no repeated Shell calls
// ============================================================================
async function autoDetectAndPaste(targetDir, progressCallback, token, transId, snapshot = null, onCancelCallback = null, shouldCancel = null, autoRename = false) {
    const global = getGlobal();

    // ★ Extract info from snapshot
    let qStatus = snapshot?.rawStatus || { hasFile: false, hasHtml: false, hasImage: false, hasText: false };
    let preFiles = snapshot?.files || null;
    let handled = snapshot !== null && snapshot.rawStatus !== undefined;

    log(q('h.autoDetect.startDetect', !!snapshot, handled), "INFO");

    // Fallback: if no snapshot passed in, try fetching
    if (!handled) {
        if (progressCallback) {
            progressCallback(1, q('h.progress.detectClipboard'));
        }
        try {
            if (global.shellBridge && global.shellBridge.isAvailable()) {
                log(q('h.autoDetect.tryShellBridge'), "INFO");
                const res = await global.shellBridge.call("wq", {}, 3000);
                if (res && !res.error) {
                    qStatus = res;
                    if (res.files) preFiles = res.files;
                    handled = true;
                    log(q('h.autoDetect.shellBridgeSuccess', res.hasFile, res.hasHtml, res.hasImage, res.files?.length || 0), "INFO");
                }
            } else {
                log(q('h.autoDetect.shellBridgeUnavailable'), "INFO");
            }
        } catch (e) {
            log(q('h.autoDetect.shellBridgeFailed', e.message), "WARN");
        }
    }

    if (!handled && process.platform === "win32") {
        try {
            log(q('h.autoDetect.tryPowerShell'), "INFO");
            const psScript = `Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetDataObject().GetFormats();$o=@{hasFile=$false;hasHtml=$false;hasImage=$false;hasText=$false};if($f -contains 'FileDrop'){$o.hasFile=$true};if($f -contains 'HTML Format'){$o.hasHtml=$true};if(($f -contains 'Bitmap')-or($f -contains 'DeviceIndependentBitmap')-or($f -contains 'PNG')){$o.hasImage=$true};if(($f -contains 'Text')-or($f -contains 'UnicodeText')){$o.hasText=$true};$o|ConvertTo-Json -Compress`;
            const jsonStr = await spawnOutput("powershell", ["-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript]);
            if (jsonStr && jsonStr.trim()) {
                const parsed = JSON.parse(jsonStr);
                if (parsed) {
                    qStatus = parsed;
                    handled = true;
                    log(q('h.autoDetect.powerShellSuccess', parsed.hasFile, parsed.hasHtml, parsed.hasImage), "INFO");
                }
            }
        } catch (e) {
            log(q('h.autoDetect.powerShellFailed', e.message), "WARN");
        }
    }

    if (!handled) {
        try {
            const text = await vscode.env.clipboard.readText();
            if (text) {
                qStatus.hasText = true;
                log(q('h.autoDetect.vsCodeApiText'), "INFO");
            }
        } catch (e) { }
    }

    // ★ Linux: if detection returned all-false AND no text either, xclip might be missing → prompt install
    if (process.platform === 'linux' && !qStatus.hasFile && !qStatus.hasHtml && !qStatus.hasImage && !qStatus.hasText) {
        if (global.checkAndInstallLinuxDeps) {
            await global.checkAndInstallLinuxDeps(true);
        }
    }

    log(q('h.autoDetect.finalStatus', qStatus.hasFile, qStatus.hasHtml, qStatus.hasImage, qStatus.hasText), "INFO");

    // Dispatch based on priority: File > HTML > Image > Text
    if (qStatus.hasFile) {
        log(q('h.autoDetect.enterFileCopy', preFiles?.length || 0), "INFO");
        // ★ Pass the pre-fetched file list and propagate autoRename
        return await handleClipboardShell(targetDir, token, progressCallback, preFiles, 0, transId, onCancelCallback, shouldCancel, autoRename);
    }

    // ★★★ Markdown preservation detection ★★★
    // When hasHtml and hasText both exist, detect whether plain text contains Markdown symbols
    // If it's Markdown text and HTML has no media resources, prefer plain text
    if (qStatus.hasHtml && qStatus.hasText) {
        try {
            const plainText = await vscode.env.clipboard.readText();
            if (plainText && _looksLikeMarkdown(plainText)) {
                // Check whether HTML has media resources
                const htmlResult = await _getSmartHtmlFromClipboard(null, token);
                if (htmlResult && htmlResult.$) {
                    const $ = htmlResult.$;
                    const hasMedia = $('img, video, iframe, embed, object, picture, source[type^="video"]').length > 0;
                    if (!hasMedia) {
                        log(q('h.autoDetect.markdownDetected'), "INFO");
                        return { type: "text", text: plainText };
                    } else {
                        log(q('h.autoDetect.markdownWithMedia'), "INFO");
                    }
                } else {
                    // HTML parse failed; use plain text directly
                    log(q('h.autoDetect.htmlParseFailed'), "INFO");
                    return { type: "text", text: plainText };
                }
            }
        } catch (e) {
            log(q('h.autoDetect.markdownDetectFailed', e.message), "WARN");
        }
    }

    if (qStatus.hasHtml) {
        log(q('h.autoDetect.enterHtmlProcess'), "INFO");
        return await handleClipboardUnified(targetDir, progressCallback, token, transId, shouldCancel, autoRename);
    }

    if (qStatus.hasImage) {
        log(q('h.autoDetect.enterImageProcess'), "INFO");
        return await handleClipboardShell(targetDir, token, progressCallback, null, 0, transId, onCancelCallback, shouldCancel);
    }

    if (qStatus.hasText) {
        try {
            const text = await vscode.env.clipboard.readText();
            if (text) {
                // ★ Remove logic that auto-detects plain-text URL as video download
                // if (isPlatformOrSegmentVideo(text) || /\.(mp4|webm|mkv|mov)(\?|$)/i.test(text)) {
                //     log(`[AutoDetect] Detected video URL`, "INFO");
                //     return { type: "video_url", text, url: text };
                // }
                log(q('h.autoDetect.detectedText'), "INFO");
                return { type: "text", text };
            }
        } catch (e) { }
    }

    log(q('h.autoDetect.noContentDetected'), "WARN");
    return null;
}

// Helper needed for video detection
// const { isPlatformOrSegmentVideo } = require("./dow");

async function promptForUrl(prompt = q('h.ui.promptUrlDefault')) {
    return await vscode.window.showInputBox({
        prompt: prompt,
        placeHolder: "https://example.com/page-with-video",
        validateInput: text => {
            if (!text) return q('h.ui.urlEmpty');
            try {
                new URL(text);
                return null;
            } catch {
                return q('h.ui.urlInvalid');
            }
        }
    });
}

async function pickTargetDirectory() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return folders[0].uri.fsPath;
    }
    const selectedDir = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: q('h.ui.selectVideoDir')
    });
    return selectedDir && selectedDir.length > 0 ? selectedDir[0].fsPath : null;
}

/**
 * Copy file/folder paths into system clipboard (Windows CF_HDROP format)
 * @param {string[]} filePaths - Absolute path list
 * @returns {Promise<{success: boolean, usedEngine: boolean}>} success=whether succeeded, usedEngine=whether engine was used (non-text fallback)
 */
async function copyFilesToClipboard(filePaths) {
    if (!filePaths || filePaths.length === 0) return { success: false, usedEngine: false };

    const global = getGlobal();
    try {
        // ★ Always use global.tryEngineCall to enjoy perfect fallback: Rust -> Python -> Node
        const res = await global.tryEngineCall({
            rust: "setFiles",
            python: "setFiles",
            shell: "setFiles" // Node Daemon fallback
        }, { paths: filePaths }, 3000);

        if (res && res.success) {
            const activeName = global.getActiveEngineName(global.pythonBridge, global.rustBridge, global.shellBridge);
            log(q('h.log.copyViaEngine', activeName, filePaths.length), "INFO");
            return { success: true, usedEngine: true };
        }
    } catch (e) {
        log(q('h.log.copyException', e.message), "WARN");
    }

    // If all Bridges are unavailable, do minimal plain-text fallback
    try {
        await vscode.env.clipboard.writeText(filePaths.join("\n"));
        log(q('h.log.copyFallbackText'), "WARN");
        return { success: true, usedEngine: false }; // q4 will detect and play SFX
    } catch { }
    return { success: false, usedEngine: false };
}

module.exports = {
    CLIPBOARD_HELPER_CS,
    autoDetectAndPaste,
    copyFilesToClipboard,
    handleClipboardUnified,
    handleClipboardShell,
    sanitizeHtml,
    _getSmartHtmlFromClipboard,
    extractVideoUrlsFromWebPage,
    extractVideoUrlsFromHtmlFragment,
    computeFingerprint,
    prefillFingerprint,
    getTimestampFilename,
    getFilenameFromUrl,
    isImageExtForClipboard,
    spawnOutput,
    ensureDir,
    cleanupEmptyQqqFolder,
    promptForUrl,
    pickTargetDirectory,
    log,
    verifyVideoFile
};

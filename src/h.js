const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const cheerio = require("cheerio");
const crypto = require("crypto");
const { TextDecoder } = require("util");
const { getSharedDownloader, isPlatformOrSegmentVideo } = require("./dow");
const sizeOf = require("image-size");
const global = require("./global");

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
// Process / Spawn Helpers  (✅ 配套：默认 NO_TRACK，不进入下载任务 tracker)
// ============================================================================
const NO_TRACK_ENV_KEY = "QQQ_NO_TRACK";
function _envNoTrack() {
    return { ...process.env, [NO_TRACK_ENV_KEY]: "1" };
}

function spawnRun(cmd, args, opts = {}) {
    const { checkExpected, returnOutput } = opts;
    return new Promise((resolve) => {
        // ✅ 双保险：显式 env 标记 NO_TRACK
        const child = cp.spawn(cmd, args, {
            windowsHide: true,
            env: _envNoTrack(),
            // detached 默认就是 false；这里不强行写也行
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

function spawnCheck(cmd, args, expected) {
    return spawnRun(cmd, args, { checkExpected: expected });
}

function spawnOutput(cmd, args) {
    return spawnRun(cmd, args, { returnOutput: true });
}

// ============================================================================
// Deduplication Helper (仅同文件夹内去重，不跨文件夹)
// ============================================================================
function _tryGlobalDeduplicate(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return filePath;
    try {
        const currentFp = computeFingerprint(filePath);
        if (!currentFp) return filePath;

        // ★ 只在同一文件夹内去重，不同文件夹允许有相同文件
        const dir = path.dirname(filePath);
        const files = fs.readdirSync(dir);
        const isWin = process.platform === "win32";
        const normalizedFilePath = isWin ? filePath.toLowerCase() : filePath;

        for (const f of files) {
            const full = path.join(dir, f);
            const normalizedFull = isWin ? full.toLowerCase() : full;

            if (normalizedFull === normalizedFilePath) continue;
            try {
                if (!fs.statSync(full).isFile()) continue;
            } catch { continue; }
            if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.tmp')) continue;

            const otherFp = computeFingerprint(full);
            if (otherFp === currentFp) {
                try {
                    fs.unlinkSync(filePath);
                    log(`[Dedupe] 同文件夹重复: ${path.basename(filePath)} -> 使用旧文件: ${f}`, "INFO");
                    return full;
                } catch (e) {
                    log(`[Dedupe] 删除失败 ${filePath}: ${e.message}`, "WARN");
                }
            }
        }
    } catch (e) {
        log(`[Dedupe] Exception: ${e.message}`, "ERROR");
    }
    return filePath;
}

// ============================================================================
// File / Path Helpers
// ============================================================================
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { }
    }
}

const IMAGE_EXTS_FOR_CLIPBOARD = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif",
]);

function isImageExtForClipboard(ext) {
    return IMAGE_EXTS_FOR_CLIPBOARD.has(ext.toLowerCase());
}

function getTimestampFilename(ext) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
    const time = now.toTimeString().slice(0, 8).replace(/:/g, ".");
    const day = now.getDay() || 7;
    const ms = String(now.getMilliseconds()).padStart(3, "0");

    const excluded = new Set(["l", "i", "s", "a", "m", "c", "b", "f", "t"]);
    const valid = "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        .split("")
        .filter((c) => !excluded.has(c.toLowerCase()));

    const c1 = valid[Math.floor(Math.random() * valid.length)];
    let c2 = valid[Math.floor(Math.random() * valid.length)];
    if (c1.toLowerCase() === "g") {
        const noG = valid.filter((c) => c.toLowerCase() !== "g");
        c2 = noG[Math.floor(Math.random() * noG.length)];
    }

    return `${ms}${c1}${c2}_${date}__${day}__${time}${ext}`;
}

/**
 * ★ 从 URL 提取原始文件名（与 VideoDownloadController._createTask 统一逻辑）
 * @param {string} url - 资源 URL
 * @param {string} kind - 'video' 或 'image'
 * @returns {string|null} - 文件名，失败返回 null
 */
function getFilenameFromUrl(url, kind = 'video') {
    try {
        const u = new URL(url);
        const pathname = u.pathname || '';
        const base = path.basename(pathname);

        if (kind === 'video') {
            // ★ 视频：匹配常见视频扩展名
            if (base && /\.(mp4|webm|mkv|mov|flv|avi|wmv|m4v|mpg|mpeg|3gp|ts|ogv)$/i.test(base)) {
                const decoded = decodeURIComponent(base);
                // ★ 文件名合理检查：不能太长，不能有特殊字符
                if (decoded.length <= 100 && /^[a-zA-Z0-9._\-\u4e00-\u9fff]+$/.test(decoded)) {
                    return decoded;
                }
            }
        } else {
            // ★ 图片：匹配常见图片扩展名
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
const _fingerprintDb = new Map();
const FINGERPRINT_HEAD = 128;
const FINGERPRINT_MID = 128;
const FINGERPRINT_TAIL = 128;

function canonicalizeExistingPath(p) {
    if (!p) return "";
    let out = String(p);
    try {
        if (fs.existsSync(out)) out = fs.realpathSync(out);
    } catch { }
    out = path.normalize(out);
    if (process.platform === "win32") {
        out = out.replace(/^\\\\\?\\/, "").replace(/^[a-z]:/, (m) => m.toUpperCase());
    }
    return out;
}

/**
 * 安全检查文件/文件夹是否可以被访问和读取
 * @param {string} filePath - 要检查的路径
 * @returns {boolean} - 是否可以安全访问
 */
function safeAccessCheck(filePath) {
    try {
        // 检查是否能访问（读取权限）
        fs.accessSync(filePath, fs.constants.R_OK);
        // 检查是否能获取状态信息
        fs.statSync(filePath);
        return true;
    } catch (e) {
        // 文件被占用、权限不足、路径无效等情况
        log(`[SafeAccess] 无法访问: ${filePath} - ${e.code || e.message}`, "WARN");
        return false;
    }
}

/**
 * 安全的递归复制文件夹，忽略无法访问的文件
 * @param {string} src - 源文件夹
 * @param {string} dest - 目标文件夹
 * @returns {{success: boolean, skipped: string[], errors: string[]}} - 复制结果
 */
function safeCopyFolderRecursive(src, dest) {
    const skipped = [];
    const errors = [];

    function copyRecursive(srcPath, destPath) {
        try {
            if (!safeAccessCheck(srcPath)) {
                skipped.push(srcPath);
                return;
            }

            const stat = fs.statSync(srcPath);

            if (stat.isDirectory()) {
                // 创建目标目录
                try {
                    if (!fs.existsSync(destPath)) {
                        fs.mkdirSync(destPath, { recursive: true });
                    }
                } catch (e) {
                    errors.push(`创建目录失败 ${destPath}: ${e.message}`);
                    return;
                }

                // 读取目录内容
                let entries = [];
                try {
                    entries = fs.readdirSync(srcPath);
                } catch (e) {
                    errors.push(`无法读取目录 ${srcPath}: ${e.message}`);
                    return;
                }

                // 递归复制每个条目
                for (const entry of entries) {
                    const srcEntry = path.join(srcPath, entry);
                    const destEntry = path.join(destPath, entry);
                    copyRecursive(srcEntry, destEntry);
                }
            } else if (stat.isFile()) {
                // 复制文件
                try {
                    fs.copyFileSync(srcPath, destPath);
                } catch (e) {
                    if (e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM') {
                        skipped.push(srcPath);
                        log(`[SafeCopy] 文件被占用/权限不足，跳过: ${srcPath}`, "WARN");
                    } else {
                        errors.push(`复制文件失败 ${srcPath}: ${e.message}`);
                    }
                }
            }
            // 忽略符号链接和其他特殊文件类型
        } catch (e) {
            // 捕获所有未预期的错误，防止崩溃
            errors.push(`处理 ${srcPath} 时发生错误: ${e.message}`);
        }
    }

    try {
        copyRecursive(src, dest);
        return { success: true, skipped, errors };
    } catch (e) {
        return { success: false, skipped, errors: [...errors, `顶层错误: ${e.message}`] };
    }
}

function cacheKeyForPath(p) {
    const canon = canonicalizeExistingPath(p);
    return process.platform === "win32" ? canon.toLowerCase() : canon;
}

function prefillFingerprint(filePath, fingerprint) {
    try {
        const stat = fs.statSync(filePath);
        const key = cacheKeyForPath(filePath);
        _fingerprintCache.set(key, { mtime: stat.mtimeMs, size: stat.size, fp: fingerprint });
        _fingerprintDb.set(fingerprint, filePath);
    } catch (e) { }
}

function findFileByFingerprint(fingerprint) {
    return _fingerprintDb.get(fingerprint);
}

function computeFingerprint(filePath) {
    try {
        const stat = fs.statSync(filePath);
        const size = stat.size;
        const mtime = stat.mtimeMs;
        const key = cacheKeyForPath(filePath);

        const cached = _fingerprintCache.get(key);
        if (cached && cached.mtime === mtime && cached.size === size) return cached.fp;

        if (size === 0) return crypto.createHash("md5").update("empty:0").digest("hex");

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

        const $ = cheerio.load(htmlText);
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
// 检测纯文本是否包含 Markdown 格式符号，用于决定是否优先保留纯文本而非 HTML
// ============================================================================
function _looksLikeMarkdown(text) {
    if (!text || text.length < 3) return false;

    // Markdown 格式符号模式
    const markdownPatterns = [
        /^#{1,6}\s+\S/m,                    // 标题: # ## ### 等
        /^\s*[-*+]\s+\S/m,                  // 无序列表: - * +
        /^\s*\d+\.\s+\S/m,                  // 有序列表: 1. 2. 3.
        /^\s*>\s+\S/m,                      // 引用: >
        /^---\s*$/m,                         // 分隔线: ---
        /^\*\*\*\s*$/m,                      // 分隔线: ***
        /^___\s*$/m,                         // 分隔线: ___
        /\*\*[^*]+\*\*/,                     // 粗体: **text**
        /\*[^*]+\*/,                         // 斜体: *text* (注意排除列表)
        /`[^`]+`/,                           // 行内代码: `code`
        /^```/m,                             // 代码块: ```
        /\[([^\]]+)\]\(([^)]+)\)/,          // 链接: [text](url)
        /!\[([^\]]*)\]\(([^)]+)\)/,         // 图片: ![alt](url)
    ];

    // 统计匹配到的模式数量
    let matchCount = 0;
    for (const pattern of markdownPatterns) {
        if (pattern.test(text)) {
            matchCount++;
            // 如果匹配到了明确的 Markdown 标记（标题、分隔线、代码块），直接返回 true
            if (/^#{1,6}\s+\S/m.test(text) ||      // 标题
                /^---\s*$/m.test(text) ||          // 分隔线
                /^\*\*\*\s*$/m.test(text) ||       // 分隔线
                /^```/m.test(text)) {               // 代码块
                return true;
            }
        }
    }

    // 如果匹配到 2 个以上模式，认为是 Markdown
    return matchCount >= 2;
}

// ============================================================================
// Core HTML Logic (The "Eyes" & "Hands")
// ============================================================================
async function _getSmartHtmlFromClipboard(progressCallback, token) {
    if (token?.isCancellationRequested) return null;
    if (progressCallback) progressCallback(0, "读取 HTML...");

    let rawBuf = null;
    let rawText = null;
    let baseUrl = "";

    if (process.platform === "win32") {
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
    if (progressCallback) progressCallback(0, "智能解码...");

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
    if (progressCallback) progressCallback(0, "HTML 解析...");

    let $;
    try {
        $ = cheerio.load(safeHtml, { decodeEntities: true, xmlMode: false });
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
    const $ = cheerio.load(html, { decodeEntities: false });
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

        // 查找 <video> 标签中的视频源
        $('video source, video').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                try {
                    const fullUrl = new URL(src, baseUrl).href;
                    videoUrls.add(fullUrl);
                } catch (e) {
                    // 如果URL解析失败，直接添加原始URL
                    videoUrls.add(src);
                }
            }

            // 检查其他可能的视频源属性
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

        // 查找 <iframe> 标签（可能是视频播放器）
        $('iframe').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                try {
                    const fullUrl = new URL(src, baseUrl).href;
                    videoUrls.add(fullUrl);
                } catch (e) {
                    // 如果URL解析失败，直接添加原始URL
                    videoUrls.add(src);
                }
            }
        });

        // 查找具有视频类名或ID的元素
        $('[class*="video" i], [id*="video" i]').each((i, elem) => {
            const src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-source') || $(elem).attr('data-video');
            if (src) {
                try {
                    const fullUrl = new URL(src, baseUrl).href;
                    videoUrls.add(fullUrl);
                } catch (e) {
                    // 如果URL解析失败，直接添加原始URL
                    videoUrls.add(src);
                }
            }
        });

        // 查找可能的视频文件扩展名链接
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
                        // 如果URL解析失败，直接添加原始URL
                        videoUrls.add(href);
                    }
                }
            }
        });

        // 尝试从 script 标签和全局文本中提取 JSON 格式的视频 URL
        // 很多 SPA 或移动端页面（如百度新闻）将视频信息存储在 JSON 中
        $('script').each((i, elem) => {
            let scriptContent = $(elem).text();
            if (scriptContent && scriptContent.trim()) {
                // 1. 预处理：反转义 JSON 中的斜杠，以及 Unicode 转义
                scriptContent = scriptContent.replace(/\\\//g, '/').replace(/\\u002F/gi, '/');

                // 2. 扫描常见的视频字段 (增强版正则，兼容更多格式)
                // 兼容: "video_url":"http..." 和 video_url="http..." 和 video_url: "http..."
                const commonKeys = ['play_url', 'video_url', 'playUrl', 'videoUrl', 'src', 'url', 'mp4', 'm3u8'];

                // 宽容正则：key 后面跟任意符号，直到遇到 http
                const keyRegexStr = `(${commonKeys.join('|')})[^:="']*[:="']+\s*["']?(https?://[^"']+)["']?`;
                const keyRegex = new RegExp(keyRegexStr, 'gi');

                let keyMatch;
                while ((keyMatch = keyRegex.exec(scriptContent)) !== null) {
                    const potentialUrl = keyMatch[2];
                    // 验证是否包含视频扩展名，或者看起来像视频 URL
                    if (extensions.some(ext => potentialUrl.includes('.' + ext)) || potentialUrl.includes('video')) {
                        try {
                            const fullUrl = new URL(potentialUrl, baseUrl).href;
                            videoUrls.add(fullUrl);
                        } catch (e) {
                            videoUrls.add(potentialUrl);
                        }
                    }
                }

                // 3. 原有的通用正则提取
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
        console.error('从HTML片段提取视频URL失败:', error);
        return [];
    }
}

// 从网页中提取视频URL的辅助函数
async function extractVideoUrlsFromWebPage(url) {
    try {
        const cheerio = require('cheerio');
        const https = require('https');
        const http = require('http');
        const { URL: NodeURL } = require('url');

        const commonHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        };

        // ★ 始终使用 fetchViaHttps，因为它使用简化的 headers，避免被服务器拒绝
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
                    // 处理重定向
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

        // 直接使用 fetchViaHttps，不依赖 node-fetch 或 global.fetch
        const html = await fetchViaHttps(url, commonHeaders);

        // 检测 Cloudflare 挑战页面特征
        if (html.includes('cf-turnstile') || html.includes('challenge-platform') || html.includes('Cloudflare Ray ID')) {
            throw new Error(`HTTP 403: Cloudflare Challenge Detected`);
        }

        const $ = cheerio.load(html);

        const videoUrls = new Set();

        // 查找 <video> 标签中的视频源
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

        // 查找直接的 <video> 标签的src属性
        $('video').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                const fullUrl = new URL(src, url).href;
                videoUrls.add(fullUrl);
            }
        });

        // 查找 <iframe> 标签（可能是视频播放器）
        $('iframe').each((i, elem) => {
            const src = $(elem).attr('src');
            if (src) {
                const fullUrl = new URL(src, url).href;
                videoUrls.add(fullUrl);
            }
        });

        // 查找具有视频类名的元素
        $('[class*="video" i], [id*="video" i]').each((i, elem) => {
            const src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-source');
            if (src) {
                const fullUrl = new URL(src, url).href;
                videoUrls.add(fullUrl);
            }
        });

        // 查找可能的视频文件扩展名链接
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

async function verifyVideoFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    let ffmpeg = 'ffmpeg';
    try {
        const d = getSharedDownloader();
        if (d && d.ytdlp && d.ytdlp.ffmpegPath) ffmpeg = d.ytdlp.ffmpegPath;
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
                    const safeName = getTimestampFilename(newExt || '.mp4');
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

async function _materializeImageBlocksToFiles(blocks, targetDir, progressCallback, token, transId) {
    const pending = blocks.filter(b => b && b.type === "media" && (b.kind === "image" || b.kind === "video") && b.src && b.status === "pending");
    if (!pending.length) return;
    const securityLevelString = getGlobal().getConfig("downloadSecurityLevel") || "0: 最宽松";
    let securityLevel = 0;
    if (securityLevelString.startsWith("1")) securityLevel = 1;
    if (securityLevelString.startsWith("2")) securityLevel = 2;
    const d = getSharedDownloader({ securityLevel, baseDir: targetDir, downloadVideos: "all", ytdlpConcurrency: 2 });
    const httpTasks = [];
    const localTasks = [];
    const taskMap = new Map();
    for (const b of pending) {
        const src = String(b.src || "");
        if (/^data:/i.test(src) || /^file:/i.test(src)) localTasks.push(b);
        else {
            const tag = Math.random().toString(36).slice(2) + "_" + Date.now();
            b._tag = tag;
            const ext = b.kind === "video" ? ".mp4" : ".png";
            // ★ 统一真理源：先尝试从 URL 提取原始文件名，失败再用时间戳
            // 这样 HTML 块粘贴和 downloadVideosFromUrl 的文件名一致
            const filename = getFilenameFromUrl(src, b.kind) || getTimestampFilename(ext);
            const destPath = path.join(targetDir, filename);
            httpTasks.push({ url: src, tag, kind: b.kind || "image", destPath, referrer: b.referrer || "", maxBytes: 200 * 1024 * 1024 });
            taskMap.set(tag, b);
        }
    }

    // ★ 关键修复：预先将所有 destPath 记录到事务的 tempFiles 中
    // 这样取消时即使文件已下载但还没记录到 landedFiles，也能通过 tempFiles 删除
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
            log(`[事务] 预注册 tempFiles 失败: ${e.message}`, "WARN");
        }
    }

    let doneCount = 0;
    const total = pending.length;
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
                    const filename = getTimestampFilename(ext);
                    const destPath = path.join(targetDir, filename);
                    try {
                        fs.copyFileSync(localPath, destPath);

                        const finalPath = _tryGlobalDeduplicate(destPath);
                        const fp = computeFingerprint(finalPath);

                        b.filename = path.basename(finalPath);
                        b.path = finalPath;
                        b.fingerprint = fp || null;
                        b.size = fs.statSync(finalPath).size;
                        b.status = "ok";

                        // ★ Register Transaction（使用规范化路径）
                        if (transId) {
                            const global = getGlobal();
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                            if (trans) {
                                const normalizedPath = path.normalize(finalPath);
                                const newLanded = [...(trans.landedFiles || []), normalizedPath];
                                await global.TransactionManager.updateTransaction(transId, { landedFiles: [...new Set(newLanded)] });
                            }
                        }
                    } catch { b.status = "failed"; }
                    doneCount++;
                    if (progressCallback) progressCallback((doneCount / total) * 100, `处理本地资源 ${doneCount}/${total}`);
                    continue;
                }
            }
            if (buf && buf.length > 0) {
                ensureDir(targetDir);
                let ext = _guessExtFromUrl(src, contentType);
                if (!isImageExtForClipboard(ext)) {
                    try { const dim = sizeOf(buf); if (dim && dim.type) ext = "." + dim.type; } catch { ext = ".webp"; }
                }
                const filename = getTimestampFilename(ext);
                const destPath = path.join(targetDir, filename);
                try {
                    fs.writeFileSync(destPath, buf);

                    const finalPath = _tryGlobalDeduplicate(destPath);
                    const fp = computeFingerprint(finalPath); // Re-compute in case it changed

                    b.filename = path.basename(finalPath);
                    b.path = finalPath;
                    b.fingerprint = fp || null;
                    b.size = fs.statSync(finalPath).size;
                    b.status = "ok";

                    // ★ Register Transaction（使用规范化路径）
                    if (transId) {
                        const global = getGlobal();
                        const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                        if (trans) {
                            const normalizedPath = path.normalize(finalPath);
                            const newLanded = [...(trans.landedFiles || []), normalizedPath];
                            await global.TransactionManager.updateTransaction(transId, { landedFiles: [...new Set(newLanded)] });
                        }
                    }
                } catch { b.status = "failed"; }
            }
        } catch { b.status = "failed"; }
        doneCount++;
        if (progressCallback) progressCallback((doneCount / total) * 100, `处理本地资源 ${doneCount}/${total}`);
    }
    if (httpTasks.length > 0) {
        try {
            const r = await d.downloadAll(httpTasks, targetDir, {
                onProgress: (t, e) => { if (e.type === "done" || e.type === "error") { doneCount++; if (progressCallback) progressCallback((doneCount / total) * 100, `下载中 ${doneCount}/${total}`); } }
            });
            for (const res of r.results) {
                try {
                    const block = taskMap.get(res.tag);
                    if (!block) continue;
                    if (res.success) {
                        let dlPath = res.path || res.destPath;

                        if (block.kind === "video") {
                            dlPath = await verifyVideoFile(dlPath);
                            if (!dlPath) {
                                block.status = "failed";
                                block.error = "Video verification failed";
                                continue;
                            }
                        }

                        // 下载完成后，尝试全局去重
                        const finalPath = _tryGlobalDeduplicate(dlPath);
                        const isNewFile = (finalPath === dlPath);  // ★ 判断是否是新文件

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

                        // ★ 事务记录：只有新文件才记入 landedFiles（使用规范化路径）
                        // 复用的旧文件不记入，取消时不删除
                        if (transId && isNewFile) {
                            const global = getGlobal();
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                            if (trans) {
                                const normalizedPath = path.normalize(finalPath);
                                const newLanded = [...(trans.landedFiles || []), normalizedPath];
                                // ★ 同时从 tempFiles 中移除（因为已经记入 landedFiles）
                                const newTempFiles = (trans.tempFiles || []).filter(f => f !== dlPath && f !== finalPath);
                                await global.TransactionManager.updateTransaction(transId, {
                                    landedFiles: [...new Set(newLanded)],
                                    tempFiles: newTempFiles
                                });
                            }
                        } else if (transId && !isNewFile) {
                            // ★ 复用旧文件：从 tempFiles 中移除（因为 dlPath 已被删除）
                            const global = getGlobal();
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                            if (trans) {
                                const newTempFiles = (trans.tempFiles || []).filter(f => f !== dlPath);
                                await global.TransactionManager.updateTransaction(transId, { tempFiles: newTempFiles });
                            }
                        }
                    } else { block.status = "failed"; block.error = res.error; }
                } catch (e) {
                    log(`处理下载结果失败 (${res.tag}): ${e.message}`, "ERROR");
                }
            }
        } catch (e) { log(`dow.js downloadAll failed: ${e.message}`, "ERROR"); }
    }
}

// ============================================================================
// Shell / File Clipboard
// ============================================================================
function copyFilesToTarget(files, targetDir) {
    ensureDir(targetDir);
    const copied = [];
    const fingerprints = {};
    for (const f of files) {
        try {
            // ★ 先检查文件是否可访问
            if (!safeAccessCheck(f)) {
                log(`[copyFilesToTarget] 跳过无法访问的文件: ${f}`, "WARN");
                continue;
            }

            const srcFingerprint = computeFingerprint(f);
            if (srcFingerprint) {
                fingerprints[f] = srcFingerprint;
                let existingPath = findFileByFingerprint(srcFingerprint);
                if (existingPath && fs.existsSync(existingPath)) {
                    copied.push(existingPath);
                    continue;
                }
            }
            const ext = path.extname(f);
            const isImg = isImageExtForClipboard(ext);
            const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
            const dest = path.join(targetDir, fname);
            if (fs.existsSync(dest)) {
                const dstFingerprint = computeFingerprint(dest);
                if (dstFingerprint === srcFingerprint) {
                    copied.push(dest);
                    if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);
                    // Ensure it's registered globally
                    _tryGlobalDeduplicate(dest);
                    continue;
                }
            }
            fs.copyFileSync(f, dest);

            // Global Deduplication Check
            const finalPath = _tryGlobalDeduplicate(dest);
            if (finalPath !== dest) {
                // If deduplicated to a different path
                copied.push(finalPath);
                // No need to prefill fingerprint as registerSourceFile does it
            } else {
                if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);
                copied.push(dest);
            }
        } catch (e) {
            // ★ 对于被占用/权限不足的文件，记录日志并跳过
            if (e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOENT') {
                log(`[copyFilesToTarget] 跳过文件 (${e.code}): ${f}`, "WARN");
            } else {
                log(`[copyFilesToTarget] 复制文件失败 ${f}: ${e.message}`, "WARN");
            }
        }
    }
    return { copied, fingerprints };
}

function processFilesForClipboard(files, targetDir) {
    const folders = files.filter((f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
    const validFiles = files.filter((f) => { try { return !fs.statSync(f).isDirectory(); } catch { return false; } });
    ensureDir(targetDir);
    const copiedFiles = [];
    const copiedFolders = [];
    const fingerprints = {};
    for (const folder of folders) {
        try {
            const destFolder = path.join(targetDir, path.basename(folder));
            // ★ 使用安全的递归复制函数，防止无法访问的文件导致崩溃
            const result = safeCopyFolderRecursive(folder, destFolder);
            if (result.success) {
                copiedFolders.push(destFolder);
                if (result.skipped.length > 0) {
                    log(`[Clipboard] 复制文件夹 ${folder} 时跳过 ${result.skipped.length} 个无法访问的文件`, "WARN");
                }
            } else {
                log(`[Clipboard] 复制文件夹失败 ${folder}: ${result.errors.join('; ')}`, "WARN");
            }
        } catch (e) {
            log(`[Clipboard] 复制文件夹异常 ${folder}: ${e.message}`, "WARN");
        }
    }
    if (validFiles.length > 0) {
        const result = copyFilesToTarget(validFiles, targetDir);
        copiedFiles.push(...result.copied);
        Object.assign(fingerprints, result.fingerprints);
    }
    if (copiedFiles.length > 0 || copiedFolders.length > 0) {
        return { type: "file_folder", files: copiedFiles, folders: copiedFolders, fingerprints: fingerprints };
    }
    return null;
}

// ★ 带进度显示的文件复制（异步版本，让 UI 能够更新）
// ★ 修复：添加 token 和 transId 参数，边复制边记录事务
async function processFilesForClipboardWithProgress(files, targetDir, progressCallback, token = null, transId = null, onCancelCallback = null, shouldCancel = null) {
    const folders = files.filter((f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
    const validFiles = files.filter((f) => { try { return !fs.statSync(f).isDirectory(); } catch { return false; } });
    ensureDir(targetDir);
    const copiedFiles = [];
    const copiedFolders = [];
    const fingerprints = {};

    const totalItems = folders.length + validFiles.length;
    let processedItems = 0;
    let skippedCount = 0;

    // ★ 让出事件循环的辅助函数
    const yieldToUI = () => new Promise(resolve => setImmediate(resolve));

    // ★ 组合取消检查：token 或 shouldCancel 回调
    const isCancelled = () => token?.isCancellationRequested || (shouldCancel && shouldCancel());

    // ★ 批量更新事务记录（一次性更新所有文件，使用规范化路径）
    const batchUpdateTransaction = async (allFiles, allFolders) => {
        if (!transId) return;
        if (allFiles.length === 0 && allFolders.length === 0) return;
        try {
            const global = getGlobal();
            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
            if (trans) {
                const updates = {};
                if (allFiles.length > 0) {
                    // ★ 规范化所有路径
                    const normalizedFiles = allFiles.map(f => path.normalize(f));
                    updates.landedFiles = [...new Set([...(trans.landedFiles || []), ...normalizedFiles])];
                }
                if (allFolders.length > 0) {
                    // ★ 规范化所有路径
                    const normalizedFolders = allFolders.map(f => path.normalize(f));
                    updates.landedFolders = [...new Set([...(trans.landedFolders || []), ...normalizedFolders])];
                }
                if (Object.keys(updates).length > 0) {
                    await global.TransactionManager.updateTransaction(transId, updates);
                    log(`[事务] 批量更新: ${allFiles.length} 文件, ${allFolders.length} 文件夹`, "INFO");
                }
            }
        } catch (e) {
            log(`[事务] 批量更新失败: ${e.message}`, "WARN");
        }
    };

    // ★ 初始进度显示
    if (progressCallback && totalItems > 0) {
        progressCallback(2, `准备复制 ${totalItems} 个项目 (文件夹${folders.length}, 文件${validFiles.length})...`);
        await yieldToUI();
    }

    // 复制文件夹
    for (let i = 0; i < folders.length; i++) {
        // ★ 检查取消状态（用户取消 或 锚点丢失）
        if (isCancelled()) {
            log(`[复制] 取消，停止复制 (已复制 ${copiedFolders.length} 个文件夹, ${copiedFiles.length} 个文件)`, "WARN");
            // ★ 取消时先批量更新事务，确保所有已复制文件都被记录
            await batchUpdateTransaction(copiedFiles, copiedFolders);
            if (onCancelCallback) onCancelCallback();
            break;
        }
        const folder = folders[i];
        try {
            const folderName = path.basename(folder);
            if (progressCallback) {
                const pct = Math.round(((processedItems + 1) / totalItems) * 85) + 5;
                progressCallback(pct, `[复制文件夹 ${i + 1}/${folders.length}] ${folderName}`);
                await yieldToUI();
            }
            const destFolder = path.join(targetDir, folderName);
            const result = safeCopyFolderRecursive(folder, destFolder);
            if (result.success) {
                copiedFolders.push(destFolder);
                if (result.skipped.length > 0) {
                    skippedCount += result.skipped.length;
                    log(`[Clipboard] 复制文件夹 ${folder} 时跳过 ${result.skipped.length} 个无法访问的文件`, "WARN");
                }
            } else {
                skippedCount++;
                log(`[Clipboard] 复制文件夹失败 ${folder}: ${result.errors.slice(0, 3).join('; ')}`, "WARN");
            }
        } catch (e) {
            skippedCount++;
            log(`复制文件夹异常 ${folder}: ${e.message}`, "WARN");
        }
        processedItems++;
    }

    // 复制文件
    for (let i = 0; i < validFiles.length; i++) {
        // ★ 检查取消状态（用户取消 或 锚点丢失）
        if (isCancelled()) {
            log(`[复制] 取消，停止复制 (已复制 ${copiedFolders.length} 个文件夹, ${copiedFiles.length} 个文件)`, "WARN");
            // ★ 取消时先批量更新事务
            await batchUpdateTransaction(copiedFiles, copiedFolders);
            if (onCancelCallback) onCancelCallback();
            break;
        }
        const f = validFiles[i];
        try {
            const fileName = path.basename(f);
            if (progressCallback) {
                const pct = Math.round(((processedItems + 1) / totalItems) * 85) + 5;
                progressCallback(pct, `[复制文件 ${i + 1}/${validFiles.length}] ${fileName}`);
                if (i % 5 === 0) {
                    await yieldToUI();
                }
            }

            if (!safeAccessCheck(f)) {
                skippedCount++;
                log(`[Clipboard] 跳过无法访问的文件: ${f}`, "WARN");
                processedItems++;
                continue;
            }

            const srcFingerprint = computeFingerprint(f);
            if (srcFingerprint) {
                fingerprints[f] = srcFingerprint;
            }

            const ext = path.extname(f);
            const isImg = isImageExtForClipboard(ext);
            const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
            const dest = path.join(targetDir, fname);

            fs.copyFileSync(f, dest);
            if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);
            copiedFiles.push(dest);
        } catch (e) {
            if (e.code === 'EBUSY' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'ENOENT') {
                skippedCount++;
                log(`[Clipboard] 跳过文件 (${e.code}): ${f}`, "WARN");
            } else {
                log(`复制文件失败 ${f}: ${e.message}`, "WARN");
            }
        }
        processedItems++;
    }

    // ★ 复制完成后批量更新事务（如果没有取消）
    if (!isCancelled()) {
        await batchUpdateTransaction(copiedFiles, copiedFolders);
    }

    return {
        type: "file_folder",
        files: copiedFiles,
        folders: copiedFolders,
        fingerprints: fingerprints,
        skippedCount: skippedCount,
        totalRequested: totalItems
    };
}

async function handleClipboardShell(targetDir, token = null, progressCallback = null, preFetchedFiles = null, preCalculatedTotalSize = 0, transId = null, onCancelCallback = null, shouldCancel = null) {
    try {
        if (token?.isCancellationRequested || (shouldCancel && shouldCancel())) return null;
        if (process.platform === "win32") {
            let files = preFetchedFiles;

            // ★ 优先使用预获取的文件列表（单一真理源）
            if (files && files.length > 0) {
                log(`[Clipboard] 使用预获取的 ${files.length} 个文件`, "INFO");
            } else {
                // 备选方案：现场获取
                log(`[Clipboard] 无预获取文件，调用 tryEngineCall...`, "INFO");
                if (progressCallback) {
                    progressCallback(1, `正在获取剪贴板文件列表...`);
                }
                const res = await getGlobal().tryEngineCall({ python: "get_clipboard_files", shell: "getFiles" }, {}, 8000);
                if (res) {
                    if (res.paths && res.paths.length > 0) files = res.paths;
                    else if (res.files && res.files.length > 0) files = res.files;
                    log(`[Clipboard] tryEngineCall 返回: ${JSON.stringify(res).slice(0, 200)}`, "INFO");
                } else {
                    log(`[Clipboard] tryEngineCall 返回空`, "WARN");
                }
            }

            if (files && files.length > 0) {
                log(`[Clipboard] 开始复制 ${files.length} 个文件: ${files.slice(0, 3).join(', ')}...`, "INFO");

                // ★ 显示进度（简洁格式，不带前缀）
                if (progressCallback) {
                    progressCallback(1, `检测到 ${files.length} 个项目，开始复制...`);
                }

                // ★ 传入 token 和 transId，边复制边记录事务
                const result = await processFilesForClipboardWithProgress(files, targetDir, progressCallback, token, transId, onCancelCallback, shouldCancel);

                // ★ 记录复制结果（包含跳过信息）
                const successFiles = (result?.files || []).length;
                const successFolders = (result?.folders || []).length;
                const skipped = result?.skippedCount || 0;
                log(`[Clipboard] 复制结果: files=${successFiles}, folders=${successFolders}, skipped=${skipped}`, "INFO");
                // ★ 事务已在 processFilesForClipboardWithProgress 中边复制边记录，这里不再重复更新
                return result;
            }
        }

        const res = await getGlobal().tryOneByOne(async (bridge, name) => {
            try {
                const hasImg = await bridge.call("hasImage", {}, 1500);
                if (hasImg?.value) {
                    const fname = getTimestampFilename(".png");
                    const dest = path.join(targetDir, fname);
                    ensureDir(targetDir);
                    const saved = await bridge.call("saveImage", { path: dest }, 8000);
                    if (saved?.success && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
                        // ✅ 关键：内存截图也要走全局去重
                        const finalPath = _tryGlobalDeduplicate(dest);
                        const fp = computeFingerprint(finalPath);

                        // ★ Register Transaction（使用规范化路径）
                        if (transId) {
                            const global = getGlobal();
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === transId);
                            if (trans) {
                                const normalizedPath = path.normalize(finalPath);
                                const newLanded = [...(trans.landedFiles || []), normalizedPath];
                                await global.TransactionManager.updateTransaction(transId, { landedFiles: [...new Set(newLanded)] });
                            }
                        }

                        return { type: "image", path: finalPath, fingerprint: fp };
                    }
                }
            } catch (e) { }
            return null;
        });
        if (res) return res;

        // Fallback to HTML if text looks like HTML
        const text = await vscode.env.clipboard.readText();
        if (text && (text.includes("<html") || text.includes("<body") || text.includes("<div") || text.includes("<img"))) {
            return await handleClipboardUnified(targetDir, progressCallback, token, transId);
        }
    } catch (e) { log(`Shell剪贴板处理失败: ${e.message}`, "ERROR"); }
    return null;
}

// ============================================================================
// Main Entry
// ============================================================================
async function handleClipboardUnified(targetDir, progressCallback, token, transId, shouldCancel = null) {
    // 1. Get raw data and parsed DOM using Unified "Eyes"
    const result = await _getSmartHtmlFromClipboard(progressCallback, token);
    if (!result) return null;

    // ★ 检查取消状态
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
        if (progressCallback) progressCallback(0, "方案一：混合排版...");
        const cleanText = await vscode.env.clipboard.readText() || "";
        blocks = await _zipDomWithCleanText($, cleanText, baseUrl);
    } else {
        if (progressCallback) progressCallback(0, "方案二：DOM排版...");
        blocks = _buildBlocksFromSanitizedDom($, baseUrl);

        // Quality Check for Scheme 2 Result
        if (!_isResultQualityAcceptable(blocks)) {
            log("[SmartPaste] Scheme 2 result quality low, falling back to Scheme 1", "WARN");
            if (progressCallback) progressCallback(0, "质量检测不通过，回退到方案一...");
            const cleanText = await vscode.env.clipboard.readText() || "";
            blocks = await _zipDomWithCleanText($, cleanText, baseUrl);
        }
    }

    // 检查是否有视频URL需要处理
    const videoUrls = extractVideoUrlsFromHtmlFragment(htmlText, baseUrl);
    if (videoUrls.length > 0) {
        log(`[SmartPaste] 从HTML中提取到 ${videoUrls.length} 个视频URL`, "INFO");

        // 收集已有的媒体链接，避免重复
        const existingMediaSrcs = new Set(blocks.filter(b => b.type === "media").map(b => b.src));

        // 将视频URL添加到blocks中作为媒体资源
        for (const videoUrl of videoUrls) {
            // 如果已经在DOM解析中添加过，则跳过
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
        if (progressCallback) progressCallback(10, `发现 ${blocks.filter(b => b.type === "media").length} 个媒体资源，准备下载...`);
        await _materializeImageBlocksToFiles(blocks, targetDir, progressCallback, token, transId);
    }

    return { type: "html_blocks", blocks, baseUrl };
}

// ============================================================================
// Auto-Detect & Dispatch (Migrated from qqq.js raceClipboard)
// ★ 接受完整快照（单一真理源），不再重复调用 Shell
// ============================================================================
async function autoDetectAndPaste(targetDir, progressCallback, token, transId, snapshot = null, onCancelCallback = null, shouldCancel = null) {
    const global = getGlobal();

    // ★ 从快照中提取信息
    let qStatus = snapshot?.rawStatus || { hasFile: false, hasHtml: false, hasImage: false, hasText: false };
    let preFiles = snapshot?.files || null;
    let handled = snapshot !== null && snapshot.rawStatus !== undefined;

    log(`[AutoDetect] 开始检测, snapshot=${!!snapshot}, handled=${handled}`, "INFO");

    // 备选方案：如果没有传入快照，尝试获取
    if (!handled) {
        if (progressCallback) {
            progressCallback(1, `正在检测剪贴板内容...`);
        }
        try {
            if (global.shellBridge && global.shellBridge.isAvailable()) {
                log(`[AutoDetect] 尝试 shellBridge.wq...`, "INFO");
                const res = await global.shellBridge.call("wq", {}, 3000);
                if (res && !res.error) {
                    qStatus = res;
                    if (res.files) preFiles = res.files;
                    handled = true;
                    log(`[AutoDetect] shellBridge.wq 成功: hasFile=${res.hasFile}, hasHtml=${res.hasHtml}, hasImage=${res.hasImage}, files=${res.files?.length || 0}`, "INFO");
                }
            } else {
                log(`[AutoDetect] shellBridge 不可用`, "INFO");
            }
        } catch (e) {
            log(`[AutoDetect] shellBridge.wq 失败: ${e.message}`, "WARN");
        }
    }

    if (!handled && process.platform === "win32") {
        try {
            log(`[AutoDetect] 尝试 PowerShell 检测...`, "INFO");
            const psScript = `Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetDataObject().GetFormats();$o=@{hasFile=$false;hasHtml=$false;hasImage=$false;hasText=$false};if($f -contains 'FileDrop'){$o.hasFile=$true};if($f -contains 'HTML Format'){$o.hasHtml=$true};if(($f -contains 'Bitmap')-or($f -contains 'DeviceIndependentBitmap')-or($f -contains 'PNG')){$o.hasImage=$true};if(($f -contains 'Text')-or($f -contains 'UnicodeText')){$o.hasText=$true};$o|ConvertTo-Json -Compress`;
            const jsonStr = await spawnOutput("powershell", ["-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript]);
            if (jsonStr && jsonStr.trim()) {
                const parsed = JSON.parse(jsonStr);
                if (parsed) {
                    qStatus = parsed;
                    handled = true;
                    log(`[AutoDetect] PowerShell 检测成功: hasFile=${parsed.hasFile}, hasHtml=${parsed.hasHtml}, hasImage=${parsed.hasImage}`, "INFO");
                }
            }
        } catch (e) {
            log(`[AutoDetect] PowerShell 检测失败: ${e.message}`, "WARN");
        }
    }

    if (!handled) {
        try {
            const text = await vscode.env.clipboard.readText();
            if (text) {
                qStatus.hasText = true;
                log(`[AutoDetect] VS Code API 检测到文本`, "INFO");
            }
        } catch (e) { }
    }

    log(`[AutoDetect] 最终状态: hasFile=${qStatus.hasFile}, hasHtml=${qStatus.hasHtml}, hasImage=${qStatus.hasImage}, hasText=${qStatus.hasText}`, "INFO");

    // Dispatch based on priority: File > HTML > Image > Text
    if (qStatus.hasFile) {
        log(`[AutoDetect] 进入文件复制流程, preFiles=${preFiles?.length || 0}`, "INFO");
        // ★ 传递预获取的文件列表，避免重复调用 getFiles
        return await handleClipboardShell(targetDir, token, progressCallback, preFiles, 0, transId, onCancelCallback, shouldCancel);
    }

    // ★★★ Markdown 格式保留检测 ★★★
    // 当 hasHtml 和 hasText 同时存在时，检测纯文本是否包含 Markdown 格式符号
    // 如果是 Markdown 文本且 HTML 中没有媒体资源，则优先使用纯文本
    if (qStatus.hasHtml && qStatus.hasText) {
        try {
            const plainText = await vscode.env.clipboard.readText();
            if (plainText && _looksLikeMarkdown(plainText)) {
                // 检查 HTML 是否有媒体资源
                const htmlResult = await _getSmartHtmlFromClipboard(null, token);
                if (htmlResult && htmlResult.$) {
                    const $ = htmlResult.$;
                    const hasMedia = $('img, video, iframe, embed, object, picture, source[type^="video"]').length > 0;
                    if (!hasMedia) {
                        log(`[AutoDetect] 检测到 Markdown 格式纯文本，且 HTML 无媒体资源，优先使用纯文本`, "INFO");
                        return { type: "text", text: plainText };
                    } else {
                        log(`[AutoDetect] 检测到 Markdown 格式，但 HTML 包含媒体资源，继续 HTML 处理`, "INFO");
                    }
                } else {
                    // HTML 解析失败，直接使用纯文本
                    log(`[AutoDetect] HTML 解析失败，使用 Markdown 纯文本`, "INFO");
                    return { type: "text", text: plainText };
                }
            }
        } catch (e) {
            log(`[AutoDetect] Markdown 检测失败: ${e.message}`, "WARN");
        }
    }

    if (qStatus.hasHtml) {
        log(`[AutoDetect] 进入 HTML 处理流程`, "INFO");
        return await handleClipboardUnified(targetDir, progressCallback, token, transId, shouldCancel);
    }

    if (qStatus.hasImage) {
        log(`[AutoDetect] 进入图片处理流程`, "INFO");
        return await handleClipboardShell(targetDir, token, progressCallback, null, 0, transId, onCancelCallback, shouldCancel);
    }

    if (qStatus.hasText) {
        try {
            const text = await vscode.env.clipboard.readText();
            if (text) {
                // ★ 移除纯文本 URL 自动识别为视频下载的逻辑
                // if (isPlatformOrSegmentVideo(text) || /\.(mp4|webm|mkv|mov)(\?|$)/i.test(text)) {
                //     log(`[AutoDetect] 检测到视频 URL`, "INFO");
                //     return { type: "video_url", text, url: text };
                // }
                log(`[AutoDetect] 检测到纯文本`, "INFO");
                return { type: "text", text };
            }
        } catch (e) { }
    }

    log(`[AutoDetect] 未检测到任何内容`, "WARN");
    return null;
}

// getClipboardTotalSize 已废弃 - 由 wq 单一真理源提供 totalSize

// Helper needed for video detection
// const { isPlatformOrSegmentVideo } = require("./dow");

async function promptForUrl(prompt = "请键入包含视频的网页URL") {
    return await vscode.window.showInputBox({
        prompt: prompt,
        placeHolder: "https://example.com/page-with-video",
        validateInput: text => {
            if (!text) return "URL不能为空";
            try {
                new URL(text);
                return null;
            } catch {
                return "请键入有效的URL";
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
        title: "选择视频下载目录"
    });
    return selectedDir && selectedDir.length > 0 ? selectedDir[0].fsPath : null;
}

module.exports = {
    CLIPBOARD_HELPER_CS,
    autoDetectAndPaste,
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
    promptForUrl,
    pickTargetDirectory,
    log,
    verifyVideoFile
    // getClipboardTotalSize 已废弃
};

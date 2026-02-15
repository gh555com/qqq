// src/q3.js
// ==========================================
// ★★★ Document Export Module (Supports RTF/.doc, DOCX, ZIP) ★★★
// ★★★ Keep deliverables as consistent as possible across the two document formats; only the underlying encoding differs ★★★
// Fix/Adapt: unified cross-platform paths, more stable scan results, clearer directory references
// Fix: restore ZIP progress bar, correct comments, do not strip absolute paths on Linux/macOS
// Enhancement: more stable attachment index de-duplication, include SHA256 computation in progress
// ==========================================
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const qqq = require("./qqq");
const global = require("./global");
const { q } = require("./i18n");

// ==================== Document Export Module (Supports RTF/.doc, DOCX, ZIP) ====================
// ★ Lazy-load docx: only load on export to speed up startup
let _docx = null;
function getDocx() {
    if (!_docx) _docx = require("docx");
    return _docx;
}

// ★★★ Import archiver library ★★★
const archiver = require("archiver");

// ==================== Constants ====================

const EXPORT_MAX_WIDTH = 512;
const EXPORT_MAX_HEIGHT = 288;
const FILENAME_MAX_LENGTH = 22;
const MAX_CONCURRENT_EXPORTS = 3;

const IMAGE_EXTS = global.IMAGE_EXTS;
const VIDEO_EXTS = global.VIDEO_EXTS;

const ExportFormat = {
    RTF_DOC: "rtf_doc",
    DOCX: "docx",
};

let activeExportCount = 0;
const activeChildProcesses = new Map();
let exportIdCounter = 0;

// ==================== Child Process Management ====================

function createExportSession() {
    const exportId = ++exportIdCounter;
    activeChildProcesses.set(exportId, new Set());
    return exportId;
}

function registerChildProcess(exportId, child) {
    const set = activeChildProcesses.get(exportId);
    if (set) {
        set.add(child);
        child.on("close", () => set.delete(child));
        child.on("error", () => set.delete(child));
    }
}

function cleanupExportSession(exportId) {
    const set = activeChildProcesses.get(exportId);
    if (set) {
        for (const child of set) {
            try {
                if (!child.killed) child.kill("SIGKILL");
            } catch (e) { }
        }
        set.clear();
        activeChildProcesses.delete(exportId);
    }
}

// ==================== Helper Functions ====================
// ★ formatBytes has been unified to use global.formatBytes

function truncateFilename(filename, maxLength = FILENAME_MAX_LENGTH) {
    if (!filename) return filename;
    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);
    if (baseName.length <= maxLength) return filename;
    return baseName.substring(0, maxLength) + "..." + ext;
}

function isMediaFile(ext) {
    const e = (ext || "").toLowerCase();
    return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e);
}

/**
 * Unified cross-platform path sanitization:
 * - Do not forcibly convert / into \ (let path handle it)
 * - Fix: absolute paths (/xxx) on Linux/macOS are no longer stripped
 * - Windows: keep the old habit: only strip leading / or \ when it's not a drive-letter/UNC path
 */
function normalizeRawPath(rawPath) {
    if (!rawPath) return "";
    let clean = String(rawPath).trim();

    // Remove leftover newlines from documents
    clean = clean.replace(/\r/g, "").replace(/\n/g, "");

    const isWin = process.platform === "win32";

    if (isWin) {
        // Drive absolute path: C:\a\b or C:/a/b
        const isDriveAbs = /^[a-zA-Z]:[\\/]/.test(clean);
        // UNC: \\server\share or //server/share
        const isUncAbs = clean.startsWith("\\\\") || clean.startsWith("//");

        if (isDriveAbs || isUncAbs) {
            return path.normalize(clean);
        }

        // Windows: treat leading / or \ as user mistake (keep your original "relative-first" semantics)
        while (clean.startsWith("\\") || clean.startsWith("/")) clean = clean.slice(1);
        return path.normalize(clean);
    }

    // Non-Windows: starting with / means absolute path; must not be stripped
    if (clean.startsWith("/")) {
        return path.normalize(clean);
    }

    // Non-Windows: if user mistakenly wrote leading \ or / (relative path but with a root symbol), strip and treat as relative
    while (clean.startsWith("\\") || clean.startsWith("/")) clean = clean.slice(1);
    return path.normalize(clean);
}

function resolvePathToAbsolute(docUri, rawPath) {
    if (!rawPath) return null;
    const clean = normalizeRawPath(rawPath);
    if (!clean) return null;

    // On Windows, path.isAbsolute("/foo") may also be true (root of current drive), but normalizeRawPath already stripped it to relative
    if (path.isAbsolute(clean)) return clean;

    return path.resolve(path.dirname(docUri.fsPath), clean);
}

function computeFileSHA256(filePath) {
    return new Promise((resolve) => {
        try {
            const hash = crypto.createHash("sha256");
            const stream = fs.createReadStream(filePath);
            stream.on("data", (chunk) => hash.update(chunk));
            stream.on("end", () => resolve(hash.digest("hex")));
            stream.on("error", () => resolve(q('q3.export.cannotCompute')));
        } catch {
            resolve(q('q3.export.cannotCompute'));
        }
    });
}

/**
 * ★★★ Build export success message (unified handling for "does not include qqq vibe") ★★★
 */
function buildExportSuccessMessage(fileName, fileSize, hasQqqLinks) {
    const sizeStr = global.formatBytes(fileSize);
    let msg = q('q3.export.docExported', sizeStr, fileName);
    if (!hasQqqLinks) msg += q('q3.export.noQqqVibe');
    return msg;
}

// ==================== Media Info Fetch ====================

async function getMediaInfo(filePath, exportId) {
    if (!qqq.ffmpegPath) return null;

    return new Promise((resolve) => {
        const child = cp.spawn(qqq.ffmpegPath, ["-hide_banner", "-i", filePath], {
            windowsHide: true,
        });
        registerChildProcess(exportId, child);

        let stderr = "";
        child.stderr.on("data", (d) => {
            if (stderr.length < 50000) stderr += d.toString();
        });

        child.on("close", () => {
            const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
            const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);

            let info = { width: null, height: null, duration: 0 };
            if (resMatch) {
                info.width = parseInt(resMatch[1]);
                info.height = parseInt(resMatch[2]);
            }
            if (durMatch) {
                const h = parseFloat(durMatch[1]);
                const m = parseFloat(durMatch[2]);
                const s = parseFloat(durMatch[3]);
                info.duration = h * 3600 + m * 60 + s;
            }
            resolve(info.width ? info : null);
        });

        child.on("error", () => resolve(null));

        setTimeout(() => {
            try {
                child.kill();
            } catch { }
            resolve(null);
        }, 10000);
    });
}

// ==================== PNG Conversion (Unified Format) ====================

async function convertMediaToPng(filePath, info, exportId, useFrameResolution) {
    if (!qqq.ffmpegPath) return null;

    const duration = info?.duration || 0;
    const origW = info?.width || 512;
    const origH = info?.height || 288;

    let targetW = origW;
    let targetH = origH;
    let needScale = false;

    if (useFrameResolution) {
        // ★★★ Frame-resolution mode: force compress to EXPORT_MAX_WIDTH/HEIGHT ★★★
        if (origW > EXPORT_MAX_WIDTH || origH > EXPORT_MAX_HEIGHT) {
            const scale = Math.min(EXPORT_MAX_WIDTH / origW, EXPORT_MAX_HEIGHT / origH);
            targetW = Math.max(1, Math.round(origW * scale));
            targetH = Math.max(1, Math.round(origH * scale));
            needScale = true;
        }
        // Some ffmpeg encoders prefer even dimensions
        targetW = targetW % 2 === 0 ? targetW : targetW + 1;
        targetH = targetH % 2 === 0 ? targetH : targetH + 1;
    } else {
        // ★★★ Original-resolution mode: keep original ★★★
        // Previous logic: limit within EXPORT_MAX_WIDTH/HEIGHT
        // Current logic: keep physical size unchanged; display size is controlled by the document generator
    }

    return new Promise((resolve) => {
        const args = ["-hide_banner", "-loglevel", "error"];

        // Only add seek parameters when seeking is needed
        if (duration > 0.5) {
            const seekTime = Math.floor(duration / 2);
            args.push("-ss", String(seekTime));
        }

        args.push("-i", filePath);

        if (needScale) {
            const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=lanczos`;
            args.push("-vf", scaleFilter);
        }

        args.push("-frames:v", "1");
        args.push("-f", "image2");
        args.push("-c:v", "png");

        const rand = Math.random().toString(36).slice(2);
        const tempFile = path.join(os.tmpdir(), `qqq_export_${rand}.png`);
        args.push("-y", tempFile);

        const child = cp.spawn(qqq.ffmpegPath, args, {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
        });
        registerChildProcess(exportId, child);

        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try {
                    child.kill();
                } catch { }
                resolve(null);
            }
        }, 60000);

        child.on("close", () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);

            let buffer = null;
            try {
                if (fs.existsSync(tempFile)) {
                    buffer = fs.readFileSync(tempFile);
                    fs.unlinkSync(tempFile);
                }
            } catch { }
            resolve(buffer ? { buffer, width: targetW, height: targetH } : null);
        });

        child.on("error", () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve(null);
            }
        });
    });
}

// ==================== RTF Generator ====================

function escapeRtf(text) {
    if (!text) return "";
    let result = "";

    for (const char of text) {
        const cpv = char.codePointAt(0);

        if (cpv === 0x5c) result += "\\\\";
        else if (cpv === 0x7b) result += "\\{";
        else if (cpv === 0x7d) result += "\\}";
        else if (cpv === 0x0a) result += "\\line ";
        else if (cpv === 0x0d) continue;
        else if (cpv === 0x09) result += "\\tab ";
        else if (cpv > 127) {
            if (cpv > 0xffff) {
                const hi = Math.floor((cpv - 0x10000) / 0x400) + 0xd800;
                const lo = ((cpv - 0x10000) % 0x400) + 0xdc00;
                const hiSigned = hi > 32767 ? hi - 65536 : hi;
                const loSigned = lo > 32767 ? lo - 65536 : lo;
                result += `\\u${hiSigned}?\\u${loSigned}?`;
            } else {
                const rtfCode = cpv > 32767 ? cpv - 65536 : cpv;
                result += `\\u${rtfCode}?`;
            }
        } else {
            result += char;
        }
    }
    return result;
}

function createRtfPicture(pngBuffer, width, height) {
    // ★★★ Fit-to-page-width strategy (revised) ★★★
    // 1. Downscale large images: width > page width -> scale down to page width
    // 2. Keep small images: width <= page width -> keep original size

    const PAGE_CONTENT_WIDTH_TWIPS = 9000; // ~16cm
    const twipsPerPixel = 15;

    // Compute the theoretical width (twips) for the original image in the document
    const origWidthTwips = width * twipsPerPixel;

    // Take the smaller value: avoid overflow for large images, and avoid upscaling small images to blur
    const picwgoal = Math.min(origWidthTwips, PAGE_CONTENT_WIDTH_TWIPS);
    const pichgoal = Math.round(picwgoal * (height / width));

    const hexData = pngBuffer.toString("hex");
    // picw/pich: original physical resolution (keep maximum precision)
    return `{\\pict\\pngblip\\picw${width}\\pich${height}\\picwgoal${picwgoal}\\pichgoal${pichgoal}\r\n${hexData}\r\n}`;
}

function generateRtfDocument(elements, attachments, title) {
    const parts = [];
    parts.push("{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033");
    parts.push("{\\fonttbl");
    parts.push("{\\f0\\fswiss\\fcharset0 Arial;}");
    parts.push("}");
    parts.push("{\\colortbl ;\\red0\\green0\\blue0;}");
    parts.push("\\paperw11906\\paperh16838");
    parts.push("\\margl1440\\margr1440\\margt1440\\margb1440");
    parts.push("\\widowctrl\\ftnbj\\aenddoc");

    if (title) {
        parts.push(`\\pard\\ltrpar\\qc\\sb200\\sa400\\f0\\fs36\\b ${escapeRtf(title)}\\b0\\fs22\\par`);
    }

    parts.push("\\pard\\ltrpar\\plain\\f0\\fs22");

    for (const elem of elements) {
        if (elem.type === "text") {
            const lines = elem.content.split(/\r?\n/);
            for (const line of lines) {
                parts.push(
                    line.length === 0
                        ? "\\pard\\ltrpar\\sa0\\par"
                        : `\\pard\\ltrpar\\ql\\f0\\fs22 ${escapeRtf(line)}\\par`
                );
            }
        } else if (elem.type === "image") {
            if (elem.originalMark) {
                parts.push(
                    `\\pard\\ltrpar\\ql\\sb200\\sa100\\f0\\fs22 ${escapeRtf(elem.originalMark)}\\par`
                );
            }
            parts.push("\\pard\\ltrpar\\ql\\sa200");
            parts.push(elem.rtfPicture);
            parts.push("\\par");
            parts.push("\\pard\\ltrpar\\ql\\f0\\fs22");
        } else if (elem.type === "image_error") {
            parts.push(`\\pard\\ltrpar\\f0\\fs22 [${escapeRtf(q('q3.export.mediaConversionFailed', elem.path))}]\\par`);
        }
    }

    if (attachments.length > 0) {
        parts.push("\\pard\\ltrpar\\sb600\\sa200\\brdrb\\brdrs\\brdrw10\\brsp20 \\par");

        parts.push("\\pard\\ltrpar\\sb200\\sa200\\f0\\fs28\\b");
        parts.push(escapeRtf(q('q3.export.attachmentIndex')));
        parts.push("\\b0\\fs22\\par");

        parts.push("\\pard\\ltrpar\\tx500\\tx4500\\tx5500\\tx6800\\sa100\\f0\\fs18\\b");
        parts.push(
            escapeRtf(q('q3.export.colIndex')) +
            "\\tab " +
            escapeRtf(q('q3.export.colFileName')) +
            "\\tab " +
            escapeRtf(q('q3.export.colType')) +
            "\\tab " +
            escapeRtf(q('q3.export.colSize')) +
            "\\tab " +
            escapeRtf(q('q3.export.colSha256Short'))
        );
        parts.push("\\b0\\par");

        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const shortHash = (att.sha256 || "").substring(0, 16) + "...";
            const displayName = truncateFilename(att.name);

            parts.push("\\pard\\ltrpar\\tx500\\tx4500\\tx5500\\tx6800\\sa60\\f0\\fs16");
            parts.push(
                `${i + 1}\\tab ${escapeRtf(displayName)}\\tab ${escapeRtf(
                    (att.ext || "").toUpperCase()
                )}\\tab ${escapeRtf(global.formatBytes(att.size))}\\tab ${escapeRtf(shortHash)}`
            );
            parts.push("\\par");
        }

        parts.push("\\pard\\ltrpar\\sb300\\sa100\\f0\\fs18\\b");
        parts.push(escapeRtf(q('q3.export.fullSha256')));
        parts.push("\\b0\\par");

        for (const att of attachments) {
            parts.push(`\\pard\\ltrpar\\sa40\\f0\\fs14 ${escapeRtf(att.name + ":")}\\par`);
            parts.push(`\\pard\\ltrpar\\li400\\sa80\\f0\\fs12 ${escapeRtf(att.sha256 || "")}\\par`);
        }
    }

    parts.push("}");
    return parts.join("\r\n");
}

// ==================== DOCX Generator ====================

const TAB_POS_1 = 500;
const TAB_POS_2 = 4500;
const TAB_POS_3 = 5500;
const TAB_POS_4 = 6800;

function generateDocxDocument(elements, attachments, title) {
    // ★ Lazy-load: only load docx module during actual export
    const { Document, Paragraph, TextRun, ImageRun, TabStopType, convertInchesToTwip, AlignmentType } = getDocx();
    const children = [];

    if (title) {
        children.push(
            new Paragraph({
                children: [new TextRun({ text: title, bold: true, size: 36, font: "Arial" })],
                alignment: AlignmentType.CENTER,
                spacing: { before: 200, after: 400 },
            })
        );
    }

    for (const elem of elements) {
        if (elem.type === "text") {
            const lines = elem.content.split(/\r?\n/);
            for (const line of lines) {
                children.push(
                    new Paragraph({
                        children: [new TextRun({ text: line, size: 22, font: "Arial" })],
                        spacing: { after: 0 },
                    })
                );
            }
        } else if (elem.type === "image") {
            if (elem.originalMark) {
                children.push(
                    new Paragraph({
                        children: [new TextRun({ text: elem.originalMark, size: 22, font: "Arial" })],
                        spacing: { before: 200, after: 100 },
                    })
                );
            }

            // ★★★ Fit-to-page-width strategy (revised) ★★★
            // Assume A4 effective content width is about 16cm (~600px at 96dpi)
            const PAGE_CONTENT_WIDTH_PX = 600;

            // Take the smaller value: avoid overflow for large images, and avoid upscaling small images to blur
            const dispW = Math.min(elem.width, PAGE_CONTENT_WIDTH_PX);
            const dispH = Math.round(dispW * (elem.height / elem.width));

            children.push(
                new Paragraph({
                    children: [
                        new ImageRun({
                            data: elem.imageBuffer,
                            transformation: { width: dispW, height: dispH },
                        }),
                    ],
                    spacing: { after: 200 },
                })
            );
        } else if (elem.type === "image_error") {
            children.push(
                new Paragraph({
                    children: [new TextRun({ text: `[${q('q3.export.mediaConversionFailed', elem.path)}]`, size: 22, font: "Arial" })],
                    spacing: { after: 0 },
                })
            );
        }
    }

    if (attachments.length > 0) {
        children.push(
            new Paragraph({
                children: [new TextRun({ text: "─".repeat(31), size: 22, font: "Arial" })],
                spacing: { before: 600, after: 200 },
            })
        );

        children.push(
            new Paragraph({
                children: [new TextRun({ text: q('q3.export.attachmentIndex'), bold: true, size: 28, font: "Arial" })],
                spacing: { before: 200, after: 200 },
            })
        );

        children.push(
            new Paragraph({
                children: [
                    new TextRun({ text: q('q3.export.colIndex'), bold: true, size: 18, font: "Arial" }),
                    new TextRun({ text: "\t", size: 18 }),
                    new TextRun({ text: q('q3.export.colFileName'), bold: true, size: 18, font: "Arial" }),
                    new TextRun({ text: "\t", size: 18 }),
                    new TextRun({ text: q('q3.export.colType'), bold: true, size: 18, font: "Arial" }),
                    new TextRun({ text: "\t", size: 18 }),
                    new TextRun({ text: q('q3.export.colSize'), bold: true, size: 18, font: "Arial" }),
                    new TextRun({ text: "\t", size: 18 }),
                    new TextRun({ text: q('q3.export.colSha256Short'), bold: true, size: 18, font: "Arial" })
                ],
                tabStops: [
                    { type: TabStopType.LEFT, position: TAB_POS_1 },
                    { type: TabStopType.LEFT, position: TAB_POS_2 },
                    { type: TabStopType.LEFT, position: TAB_POS_3 },
                    { type: TabStopType.LEFT, position: TAB_POS_4 },
                ],
                spacing: { after: 100 },
            })
        );

        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const shortHash = (att.sha256 || "").substring(0, 16) + "...";
            const displayName = truncateFilename(att.name);

            children.push(
                new Paragraph({
                    children: [
                        new TextRun({ text: String(i + 1), size: 16, font: "Arial" }),
                        new TextRun({ text: "\t", size: 16 }),
                        new TextRun({ text: displayName, size: 16, font: "Arial" }),
                        new TextRun({ text: "\t", size: 16 }),
                        new TextRun({ text: (att.ext || "").toUpperCase(), size: 16, font: "Arial" }),
                        new TextRun({ text: "\t", size: 16 }),
                        new TextRun({ text: global.formatBytes(att.size), size: 16, font: "Arial" }),
                        new TextRun({ text: "\t", size: 16 }),
                        new TextRun({ text: shortHash, size: 16, font: "Arial" }),
                    ],
                    tabStops: [
                        { type: TabStopType.LEFT, position: TAB_POS_1 },
                        { type: TabStopType.LEFT, position: TAB_POS_2 },
                        { type: TabStopType.LEFT, position: TAB_POS_3 },
                        { type: TabStopType.LEFT, position: TAB_POS_4 },
                    ],
                    spacing: { after: 60 },
                })
            );
        }

        children.push(
            new Paragraph({
                children: [new TextRun({ text: q('q3.export.fullSha256'), bold: true, size: 18, font: "Arial" })],
                spacing: { before: 300, after: 100 },
            })
        );

        for (const att of attachments) {
            children.push(
                new Paragraph({
                    children: [new TextRun({ text: `${att.name}:`, size: 14, font: "Arial" })],
                    spacing: { after: 40 },
                })
            );
            children.push(
                new Paragraph({
                    children: [new TextRun({ text: att.sha256 || "", size: 12, font: "Arial" })],
                    indent: { left: convertInchesToTwip(0.3) },
                    spacing: { after: 80 },
                })
            );
        }
    }

    return new Document({
        creator: "qqq extension",
        title: title || q('q3.export.defaultDocTitle'),
        sections: [{ properties: {}, children }],
    });
}

// ==================== Scan qqq Links (For ZIP)====================

/**
 * Scan qqq codeword links in the document and return a de-duplicated reference list
 * Note: internal zip paths use "/" and preserve relative structure
 * @returns {{ hasQqqLinks: boolean, referencedFiles: Array<{ rawPath: string, absPath: string, relativePath: string, isDir: boolean }> }}
 */
function scanQqqLinks(documentUri, text) {
    const regex = qqq.createPathRegex();
    const docDir = path.dirname(documentUri.fsPath);

    const referencedFiles = [];
    const seen = new Set();

    let match;
    while ((match = regex.exec(text))) {
        const originalMark = match[0];
        const rawPath = originalMark.slice(2, -2).trim();

        if (rawPath.startsWith("__PENDING__:")) continue;

        const absPath = resolvePathToAbsolute(documentUri, rawPath);
        if (!absPath) continue;

        if (!fs.existsSync(absPath)) continue;

        // De-duplicate by real path (avoid duplicates caused by .. / symlink)
        let realKey = absPath;
        try { realKey = fs.realpathSync(absPath); } catch { }

        if (seen.has(realKey)) continue;
        seen.add(realKey);

        let relativePath = path.relative(docDir, absPath);
        // Edge case: referencing the document directory itself (or same path) yields ".", must give a clear target or zip layout gets weird
        if (!relativePath || relativePath === "." || relativePath === "./") {
            relativePath = path.basename(absPath) || "qqq_ref";
        }

        // Zip internal paths must use /
        relativePath = relativePath.split(path.sep).join("/");

        let isDir = false;
        try { isDir = fs.statSync(absPath).isDirectory(); } catch { }

        referencedFiles.push({ rawPath, absPath, relativePath, isDir });
    }

    return { hasQqqLinks: referencedFiles.length > 0, referencedFiles };
}

// ==================== Export Doc Command ====================

async function executeExportDocCommand(isCoreIntegrityValid) {
    if (!isCoreIntegrityValid) {
        global.showAutoCloseNotification('error', "qqq: Integrity check failed.");
        return;
    }

    if (activeExportCount >= MAX_CONCURRENT_EXPORTS) {
        global.showAutoCloseNotification('warning', q('q3.export.maxConcurrentExports', activeExportCount));
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        global.showAutoCloseNotification('warning', q('q3.export.noOpenDocument'));
        return;
    }

    const document = editor.document;
    const docDir = document.isUntitled ? os.homedir() : path.dirname(document.uri.fsPath);
    const docFullName = document.isUntitled ? "untitled.txt" : path.basename(document.uri.fsPath);
    const docBaseName = document.isUntitled
        ? "untitled"
        : path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));

    // Remember user's last choice (top-pinning optimization)
    const KEY_LAST_DOC_FORMAT = "lastExportDocFormat";
    const lastFormat = global.getConfig(KEY_LAST_DOC_FORMAT);

    const pickItems = [
        {
            label: "$(file) " + q('q3.export.docFormatRtf') + " ",
            description: q('q3.export.docFormatRtfDesc'),
            format: ExportFormat.RTF_DOC,
        },
        {
            label: "$(file) " + q('q3.export.docFormatDocx') + " ",
            description: q('q3.export.docFormatDocxDesc'),
            format: ExportFormat.DOCX,
        },
    ];

    if (lastFormat) {
        const idx = pickItems.findIndex(i => i.format === lastFormat);
        if (idx > 0) {
            const item = pickItems.splice(idx, 1)[0];
            pickItems.unshift(item);
        }
    }

    const formatChoice = await global.showQuickPick(pickItems, {
        placeHolder: q('q3.export.selectExportFormat'),
        title: q('q3.export.exportDocFormat'),
    });

    if (!formatChoice) return;

    const selectedFormat = formatChoice.format;
    await global.setConfig(KEY_LAST_DOC_FORMAT, selectedFormat); // Save choice
    const text = document.getText();
    const regex = qqq.createPathRegex();

    // Get image resolution config (read via ConfigGate)
    const resolutionConfig = global.getConfig("docExportImageResolution") || "原始分辨率";
    const useFrameResolution = resolutionConfig === "相框分辨率";
    if (useFrameResolution) {
        global.logMessage(q('q3.log.exportFrameRes'), "INFO");
    } else {
        global.logMessage(q('q3.log.exportOriginalRes'), "INFO");
    }

    // Get codeword retention config (read via ConfigGate)
    const includeCipher = global.getConfig("docExportIncludeCipher") !== false;
    global.logMessage(q(includeCipher ? 'q3.log.exportCipherKeep' : 'q3.log.exportCipherRemove'), "INFO");

    // Parse stage: build rawElements first; attachments only collect candidates (SHA256 computed later and included in progress bar)
    const rawElements = [];
    const attachmentCandidates = [];
    const attachmentSeen = new Set();

    let lastIndex = 0;
    let match;

    let hasQqqLinks = false;

    while ((match = regex.exec(text))) {
        if (match.index > lastIndex) {
            const textBefore = text.substring(lastIndex, match.index);
            if (textBefore.length > 0) rawElements.push({ type: "text", content: textBefore });
        }

        const originalMark = match[0];
        const rawPath = originalMark.slice(2, -2).trim();

        const absPath = resolvePathToAbsolute(document.uri, rawPath);
        if (absPath && fs.existsSync(absPath)) {
            hasQqqLinks = true;

            const stat = (() => { try { return fs.statSync(absPath); } catch { return null; } })();
            const ext = path.extname(absPath).toLowerCase();

            // Directory: keep marker as-is in the document; do not include in attachment index
            if (stat && stat.isDirectory()) {
                // If codeword should be kept, output as-is; otherwise ignore this segment (i.e., do not output)
                rawElements.push({ type: "text", content: originalMark });
            } else if (isMediaFile(ext)) {
                // Media: always output media (if codeword should be kept, originalMark field will have a value)
                // ★★★ Fix: includeCipher only controls whether to show the codeword above media ★★★
                rawElements.push({
                    type: "media",
                    path: absPath,
                    rawPath,
                    originalMark: includeCipher ? originalMark : null
                });
            } else {
                // Non-media file (exe, bat, txt, etc):
                rawElements.push({ type: "text", content: originalMark });

                // Attachment index collection (de-dup) logic unchanged
                // De-dup by realpath to avoid the same file referenced multiple times producing duplicate index entries
                let realKey = absPath;
                try { realKey = fs.realpathSync(absPath); } catch { }

                if (!attachmentSeen.has(realKey)) {
                    attachmentSeen.add(realKey);

                    try {
                        const st = fs.statSync(absPath);
                        attachmentCandidates.push({
                            name: path.basename(absPath),
                            path: rawPath,
                            absPath,
                            ext,
                            size: st.size,
                            sha256: "", // Compute later
                        });
                    } catch { }
                }
            }
        } else {
            // Reference missing: keep original marker (as an error hint, or could be removed based on includeCipher)
            // Here follow the principle "only remove valid codewords", or remove for cleanliness.
            // Considering user intent "document should not include codewords", invalid codewords might also be removed?
            // But if removed, user won't know there was a broken link.
            // By convention, keep broken-link text.
            rawElements.push({ type: "text", content: originalMark });
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        const remaining = text.substring(lastIndex);
        if (remaining.length > 0) rawElements.push({ type: "text", content: remaining });
    }

    const mediaCount = rawElements.filter((e) => e.type === "media").length;
    if (rawElements.length === 0) {
        global.showAutoCloseNotification('warning', q('q3.export.emptyDocument'));
        return;
    }

    activeExportCount++;
    const exportId = createExportSession();
    const formatLabel = selectedFormat === ExportFormat.RTF_DOC ? "RTF" : "DOCX";

    await global.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: q('q3.export.exportingDoc', formatLabel),
            cancellable: true,
        },
        async (progress, token) => {
            token.onCancellationRequested(() => cleanupExportSession(exportId));

            try {
                const processedElements = [];
                let processedCount = 0;
                const conversionCache = new Map();

                // 80%: media conversion
                const mediaInc = mediaCount > 0 ? (80 / mediaCount) : 0;

                for (const elem of rawElements) {
                    if (token.isCancellationRequested) {
                        global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                        return;
                    }

                    if (elem.type === "text") {
                        processedElements.push(elem);
                    } else if (elem.type === "media") {
                        processedCount++;
                        progress.report({
                            message: q('q3.export.convertingMedia', processedCount, mediaCount, path.basename(elem.path)),
                            increment: mediaInc,
                        });

                        const fingerprint = qqq.computeFingerprint(elem.path);
                        let pngResult;

                        if (fingerprint && conversionCache.has(fingerprint)) {
                            pngResult = conversionCache.get(fingerprint);
                            global.logMessage(
                                q('q3.log.reusingCache', path.basename(elem.path), fingerprint.substring(0, 8)),
                                "INFO"
                            );
                        } else {
                            const info = await getMediaInfo(elem.path, exportId);
                            // Pass resolution strategy
                            pngResult = await convertMediaToPng(elem.path, info, exportId, useFrameResolution);
                            if (pngResult && fingerprint) conversionCache.set(fingerprint, pngResult);
                        }

                        if (pngResult?.buffer) {
                            if (selectedFormat === ExportFormat.RTF_DOC) {
                                processedElements.push({
                                    type: "image",
                                    rtfPicture: createRtfPicture(pngResult.buffer, pngResult.width, pngResult.height),
                                    originalMark: elem.originalMark,
                                });
                            } else {
                                processedElements.push({
                                    type: "image",
                                    imageBuffer: pngResult.buffer,
                                    width: pngResult.width,
                                    height: pngResult.height,
                                    originalMark: elem.originalMark,
                                });
                            }
                        } else {
                            processedElements.push({ type: "image_error", path: elem.rawPath });
                        }
                    }
                }

                if (token.isCancellationRequested) {
                    global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                    return;
                }

                // 10%: attachment SHA256 (included in progress)
                const attachments = attachmentCandidates;
                const attInc = attachments.length > 0 ? (10 / attachments.length) : 0;

                if (attachments.length > 0) {
                    let idx = 0;
                    for (const att of attachments) {
                        if (token.isCancellationRequested) {
                            global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                            return;
                        }
                        idx++;
                        progress.report({
                            message: q('q3.export.computingHash', idx, attachments.length, att.name),
                            increment: attInc,
                        });
                        att.sha256 = await computeFileSHA256(att.absPath);
                    }
                }

                if (token.isCancellationRequested) {
                    global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                    return;
                }

                progress.report({ message: q('q3.export.generatingDoc', formatLabel), increment: 5 });

                let fileContent;
                let fileExt;
                let filterLabel;

                if (selectedFormat === ExportFormat.RTF_DOC) {
                    fileContent = generateRtfDocument(processedElements, attachments, docFullName);
                    fileExt = ".doc";
                    filterLabel = q('q3.export.filterRtf');
                } else {
                    const docxDocument = generateDocxDocument(processedElements, attachments, docFullName);
                    fileContent = await getDocx().Packer.toBuffer(docxDocument);
                    fileExt = ".docx";
                    filterLabel = q('q3.export.filterDocx');
                }

                progress.report({ message: q('q3.export.savingFile'), increment: 5 });

                const defaultExportPath = path.join(docDir, `${docBaseName}${fileExt}`);
                let finalSavePath = defaultExportPath;

                // ✅ Comment fix: only show save dialog when default path already exists
                if (fs.existsSync(defaultExportPath)) {
                    const filters = {};
                    filters[filterLabel] = [fileExt.substring(1)];
                    const saveUri = await global.showSaveDialog({
                        defaultUri: vscode.Uri.file(defaultExportPath),
                        filters,
                    });
                    if (!saveUri) {
                        global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                        return;
                    }
                    finalSavePath = saveUri.fsPath;
                }

                if (selectedFormat === ExportFormat.RTF_DOC) {
                    fs.writeFileSync(finalSavePath, fileContent, "utf8");
                } else {
                    fs.writeFileSync(finalSavePath, fileContent);
                }

                const stats = fs.statSync(finalSavePath);

                const successMsg = buildExportSuccessMessage(
                    finalSavePath, // Use absolute path
                    stats.size,
                    hasQqqLinks
                );

                // ★★★ Ensure the first popup (Progress) closes before showing the third popup (Message) ★★★
                // In VS Code, the progress bar closes only after the progress callback resolves/returns
                // So we cannot await showInformationMessage here, otherwise progress will hang until user clicks
                // Solution: use setTimeout to defer Message to next tick so Progress can end first

                setTimeout(async () => {
                    // ★★★ Success toast: auto close + reveal and select; unified via TaskMessage.showDoneToast ★★★
                    const OPEN_LABEL = q('q3.export.openFolder');
                    await global.TaskMessage.showDoneToast(successMsg, {
                        buttons: [OPEN_LABEL],
                        timeout: 9000,
                        onButton: async (btn) => {
                            if (btn === OPEN_LABEL) await revealFileOrFolder(finalSavePath);
                        }
                    });
                    await hideToastsBestEffort();
                }, 100);

            } catch (e) {
                global.logMessage(q('q3.log.exportFailed', `${e.message}\n${e.stack}`), "ERROR");
                global.showAutoCloseNotification('error', q('q3.export.exportFailed', e.message));
            } finally {
                cleanupExportSession(exportId);
                activeExportCount--;
            }
        }
    );
}

// ==================== Export ZIP Command ====================

/**
 * Export ZIP command:
 * Package the current focused document and its referenced files/directories into a zip (preserving relative structure)
 * ✅ Directories are exported recursively (archive.directory)
 * ✅ Progress bar: restored using archiver progress events
 */
async function executeExportZipCommand(isCoreIntegrityValid) {
    if (!isCoreIntegrityValid) {
        global.showAutoCloseNotification('error', "qqq: Integrity check failed.");
        return;
    }

    if (activeExportCount >= MAX_CONCURRENT_EXPORTS) {
        global.showAutoCloseNotification('warning', q('q3.export.maxConcurrentExports', activeExportCount));
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        global.showAutoCloseNotification('warning', q('q3.export.noOpenDocument'));
        return;
    }

    const document = editor.document;
    if (document.isUntitled) {
        global.showAutoCloseNotification('warning', q('q3.export.saveDocFirst'));
        return;
    }

    const docPath = document.uri.fsPath;
    const docDir = path.dirname(docPath);
    const docFullName = path.basename(docPath);
    const docBaseName = path.basename(docPath, path.extname(docPath));
    const text = document.getText();

    const scanResult = scanQqqLinks(document.uri, text);
    activeExportCount++;

    await global.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: q('q3.export.exportingZip'),
            cancellable: true,
        },
        async (progress, token) => {
            let archive = null;
            let output = null;
            let finalZipPath = null;

            try {
                progress.report({ message: q('q3.export.preparingFiles'), increment: 5 });

                const defaultZipPath = path.join(docDir, `${docBaseName}.zip`);
                finalZipPath = defaultZipPath;

                if (fs.existsSync(defaultZipPath)) {
                    const saveUri = await global.showSaveDialog({
                        defaultUri: vscode.Uri.file(defaultZipPath),
                        filters: { [q('q3.export.filterZip')]: ["zip"] },
                    });
                    if (!saveUri) {
                        global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                        return;
                    }
                    finalZipPath = saveUri.fsPath;
                }

                if (token.isCancellationRequested) {
                    global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                    return;
                }

                progress.report({ message: q('q3.export.creatingArchive'), increment: 5 });

                await new Promise((resolve, reject) => {
                    output = fs.createWriteStream(finalZipPath);
                    archive = archiver("zip", { zlib: { level: 9 } });

                    let resolved = false;
                    const finish = (err) => {
                        if (resolved) return;
                        resolved = true;
                        err ? reject(err) : resolve();
                    };

                    output.on("close", () => finish(null));
                    output.on("error", (err) => finish(err));
                    archive.on("error", (err) => finish(err));

                    archive.on("warning", (err) => {
                        if (err.code !== "ENOENT") global.logMessage(q('q3.log.zipWarning', err.message), "WARN");
                    });

                    // ✅ Progress bar: archiver progress event (more reliable)
                    let lastPercent = 10;
                    let lastTick = 0;
                    archive.on("progress", (p) => {
                        const now = Date.now();
                        if (now - lastTick < 150) return;
                        lastTick = now;

                        const entries = p?.entries || {};
                        const fsinfo = p?.fs || {};

                        const totalBytes = Number(fsinfo.totalBytes || 0);
                        const processedBytes = Number(fsinfo.processedBytes || 0);

                        const totalEntries = Number(entries.total || 0);
                        const processedEntries = Number(entries.processed || 0);

                        let percent = 10;

                        if (totalBytes > 0) {
                            percent = Math.max(
                                10,
                                Math.min(95, Math.round((processedBytes / totalBytes) * 85) + 10)
                            );
                        } else if (totalEntries > 0) {
                            percent = Math.max(
                                10,
                                Math.min(95, Math.round((processedEntries / totalEntries) * 85) + 10)
                            );
                        } else {
                            percent = Math.min(95, lastPercent + 1);
                        }

                        const inc = Math.max(0, percent - lastPercent);
                        lastPercent = percent;

                        const msg =
                            totalBytes > 0
                                ? q('q3.export.compressingBytes', global.formatBytes(processedBytes), global.formatBytes(totalBytes), percent)
                                : q('q3.export.compressingEntries', processedEntries, totalEntries || "?", percent);

                        progress.report({ message: msg, increment: inc });
                    });

                    archive.pipe(output);

                    // Add focused document
                    archive.file(docPath, { name: docFullName });

                    // Add referenced files/directories (directories exported recursively)
                    for (const file of scanResult.referencedFiles) {
                        try {
                            if (!fs.existsSync(file.absPath)) continue;
                            const stat = fs.statSync(file.absPath);

                            if (stat.isDirectory()) {
                                // ✅ Directories exported unconditionally
                                archive.directory(file.absPath, file.relativePath);
                            } else {
                                archive.file(file.absPath, { name: file.relativePath });
                            }
                        } catch (e) {
                            qqq.logMessage(q('q3.log.addFileFailed', file.absPath, e.message), "WARN");
                        }
                    }

                    token.onCancellationRequested(() => {
                        try { if (archive) archive.abort(); } catch { }
                        finish(new Error(q('q3.export.userCancelled')));
                    });

                    archive.finalize();
                });

                if (token.isCancellationRequested) {
                    try {
                        if (finalZipPath && fs.existsSync(finalZipPath)) fs.unlinkSync(finalZipPath);
                    } catch { }
                    global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                    return;
                }

                progress.report({ message: q('q3.export.done'), increment: 100 });

                const stats = fs.statSync(finalZipPath);
                const successMsg = buildExportSuccessMessage(
                    finalZipPath, // Use absolute path
                    stats.size,
                    scanResult.hasQqqLinks
                );

                const fileCount = scanResult.referencedFiles.length;
                const detailMsg = scanResult.hasQqqLinks
                    ? successMsg + q('q3.export.includesRefs', fileCount)
                    : successMsg;

                // ★★★ Ensure the first popup (Progress) closes before showing the third popup (Message) ★★★
                setTimeout(async () => {
                    // ★★★ Success toast: auto close + reveal and select; unified via TaskMessage.showDoneToast ★★★
                    const OPEN_LABEL = q('q3.export.openFolder');
                    await global.TaskMessage.showDoneToast(detailMsg, {
                        buttons: [OPEN_LABEL],
                        timeout: 9000,
                        onButton: async (btn) => {
                            if (btn === OPEN_LABEL) await revealFileOrFolder(finalZipPath);
                        }
                    });
                    await hideToastsBestEffort();
                }, 100);

                global.logMessage(q('q3.log.zipComplete', finalZipPath, fileCount + 1), "INFO");
            } catch (e) {
                if (e && e.message === q('q3.export.userCancelled')) {
                    try {
                        if (finalZipPath && fs.existsSync(finalZipPath)) fs.unlinkSync(finalZipPath);
                    } catch { }
                    global.showAutoCloseNotification('warning', q('q3.export.exportCancelled'));
                } else {
                    global.logMessage(q('q3.log.zipFailed', `${e.message}\n${e.stack}`), "ERROR");
                    global.showAutoCloseNotification('error', q('q3.export.zipExportFailed', e.message));
                }
            } finally {
                try { if (archive) archive.abort(); } catch { }
                try { if (output) output.close(); } catch { }
                activeExportCount--;
            }
        }
    );
}

// ==================== File Operation Helpers ====================

async function hideToastsBestEffort() {
    const cmds = [
        'notifications.hideToasts',
        'workbench.action.closeMessages',
        'notifications.clearAll'
    ];
    for (const c of cmds) {
        try {
            await vscode.commands.executeCommand(c);
            return;
        } catch (e) { }
    }
}

async function revealFileOrFolder(filePath) {
    try {
        if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
            return;
        }
    } catch (e) { }

    try {
        const folderPath = path.dirname(filePath);
        if (fs.existsSync(folderPath)) {
            await vscode.env.openExternal(vscode.Uri.file(folderPath));
            return;
        }
    } catch (e) { }

    // Windows fallback
    if (process.platform === 'win32') {
        try {
            const folderPath = path.dirname(filePath);
            if (fs.existsSync(folderPath)) {
                cp.exec(`explorer "${folderPath}"`);
            }
        } catch (e) { }
    }
}

function openFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    try {
        if (process.platform === "win32") cp.exec(`start "" "${filePath.replace(/"/g, '""')}"`);
        else if (process.platform === "darwin") cp.exec(`open "${filePath}"`);
        else cp.exec(`xdg-open "${filePath}"`);
    } catch {
        global.openExternal(vscode.Uri.file(filePath));
    }
}

function revealInFolder(filePath) {
    if (!fs.existsSync(filePath)) return;
    try {
        if (process.platform === "win32") cp.exec(`explorer /select,"${filePath.replace(/"/g, '""')}"`);
        else if (process.platform === "darwin") cp.exec(`open -R "${filePath}"`);
        else cp.exec(`xdg-open "${path.dirname(filePath)}"`);
    } catch { }
}

// ==================== Module Exports ====================

// ---------- qqq.pure ----------
const BINARY_EXTS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
    ".exe", ".dll", ".zip", ".tar", ".gz",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv",
    ".pdf", ".doc", ".docx", ".psd", ".ai",
]);

function isLikelyBinary(filePath) {
    if (BINARY_EXTS.has(path.extname(filePath).toLowerCase())) return true;

    try {
        const buf = Buffer.alloc(4096);
        const fd = fs.openSync(filePath, "r");
        try {
            const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
            for (let i = 0; i < bytesRead; i++) {
                if (buf[i] === 0) return true;
            }
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        // If open fails, default to binary (prevent malicious files)
        return true;
    }

    return false;
}

async function pureCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        global.showAutoCloseNotification('info', q('q3.pure.openFileFirst'));
        return;
    }

    const docPath = editor.document.uri.fsPath;
    const parentDir = path.dirname(docPath);
    const qqqDir = path.join(parentDir, "qqq");

    if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) {
        global.showAutoCloseNotification('info', q('q3.pure.noQqqFolder'));
        return;
    }

    // ★ Read both files and folders; treat folders the same as files
    let qqqItems = [];  // { name: string, isDir: boolean }
    try {
        const entries = fs.readdirSync(qqqDir);
        for (const entry of entries) {
            const fullPath = path.join(qqqDir, entry);
            try {
                const stat = fs.statSync(fullPath);
                qqqItems.push({ name: entry, isDir: stat.isDirectory() });
            } catch { }
        }
    } catch (e) {
        global.showAutoCloseNotification('error', q('q3.pure.readQqqFolderFailed'));
        return;
    }

    if (!qqqItems.length) {
        global.showAutoCloseNotification('info', q('q3.pure.qqqFolderEmpty'));
        return;
    }

    // ★ Collect all referenced file/folder names (including direct and indirect references)
    const referencedItems = new Set();
    let parentFiles = [];

    try {
        parentFiles = fs.readdirSync(parentDir);
    } catch (e) {
        return;
    }

    const regex = qqq.createPathRegex();

    for (const fileName of parentFiles) {
        const fullPath = path.join(parentDir, fileName);
        if (fileName === "qqq" || fileName === "qqq.pure") continue;

        try { if (!fs.statSync(fullPath).isFile()) continue; } catch { continue; }
        if (isLikelyBinary(fullPath)) continue;

        try {
            const content = fs.readFileSync(fullPath, "utf-8");
            let match;
            regex.lastIndex = 0;

            while ((match = regex.exec(content))) {
                const rawPath = (match[1] || "").trim();
                const normalized = rawPath.replace(/\\/g, path.sep).replace(/\//g, path.sep);
                const absPath = path.isAbsolute(normalized) ? normalized : path.resolve(parentDir, normalized);

                const absNorm = path.normalize(absPath).toLowerCase();
                const qqqNorm = path.normalize(qqqDir).toLowerCase();

                // ★ Check whether it is under qqq directory (direct reference or subpath reference)
                if (absNorm.startsWith(qqqNorm + path.sep) || absNorm === qqqNorm) {
                    // Get path relative to qqq directory
                    const relToQqq = absNorm.slice(qqqNorm.length).replace(/^[\\/]+/, "");
                    if (relToQqq) {
                        // Take the first-level directory/file name as the direct child item
                        const firstPart = relToQqq.split(/[\\/]/)[0];
                        referencedItems.add(firstPart.toLowerCase());
                    }
                }
            }
        } catch { }
    }

    // ★ Treat files and folders equally; find orphans that are not referenced
    const orphanItems = qqqItems.filter((item) => !referencedItems.has(item.name.toLowerCase()));

    if (!orphanItems.length) {
        global.showAutoCloseNotification('info', q('q3.pure.noOrphanFiles'));
        return;
    }

    // ★ Generate deletion commands for files and folders separately
    const orphanFiles = orphanItems.filter(item => !item.isDir).map(item => path.join(qqqDir, item.name));
    const orphanDirs = orphanItems.filter(item => item.isDir).map(item => path.join(qqqDir, item.name));

    let cmdParts = [];
    if (os.platform() === "win32") {
        // Windows: use del for files; use rmdir /s /q for folders
        if (orphanFiles.length > 0) {
            cmdParts.push(`del ${orphanFiles.map((p) => `"${p}"`).join(" ")}`);
        }
        if (orphanDirs.length > 0) {
            // One rmdir command per folder, joined by &
            for (const d of orphanDirs) {
                cmdParts.push(`rmdir /s /q "${d}"`);
            }
        }
    } else {
        // Unix: use rm for files; use rm -rf for folders
        if (orphanFiles.length > 0) {
            cmdParts.push(`rm ${orphanFiles.map((p) => `"${p}"`).join(" ")}`);
        }
        if (orphanDirs.length > 0) {
            cmdParts.push(`rm -rf ${orphanDirs.map((p) => `"${p}"`).join(" ")}`);
        }
    }

    const cmdStr = os.platform() === "win32" ? cmdParts.join(" & ") : cmdParts.join(" && ");

    // ★ All orphan paths (files and folders)
    const allOrphanPaths = orphanItems.map((item) => path.join(qqqDir, item.name));

    let content = "\n".repeat(13) + " " + q('q3.pure.executeCommandPrompt') + "\n\n\n " + cmdStr + "\n\n\n";
    content += allOrphanPaths.map((p) => `/\\${p}\\/`).join("\n\n\n\n\n");

    const purePath = path.join(parentDir, "qqq.pure");

    try {
        fs.writeFileSync(purePath, content, "utf-8");
        if (!fs.existsSync(purePath)) return;
        const doc = await vscode.workspace.openTextDocument(purePath);
        await global.showTextDocument(doc);
    } catch (e) {
        global.showAutoCloseNotification('error', q('q3.pure.cannotGeneratePureFile'));
    }
}

module.exports = {
    executeExportDocCommand,
    executeExportZipCommand,
    pureCommand,
};

// ============================================================================
// ★ Watermark Sentinel Ghost Module (Standalone, Zero Business Coupling) ★★★
// ============================================================================
(function () {
    let sentinel = null;
    let debounceTimer = null;

    function check() {
        if (!global.verifySystemIntegrityAsync) return;
        // The context here can be attempted to be fetched from global or run silently
        // Since global already has verifySystemIntegrityAsync and internally holds extensionPath
        // We only need to trigger a forced re-check once via global interface to implement "fuse"
        const extPath = global.extensionPath();
        if (!extPath) return;
        global.verifySystemIntegrityAsync({ extensionPath: extPath }, true)
            .catch(() => { });
    }

    try {
        const extPath = global.extensionPath();
        if (!extPath) return;
        const assetsDir = path.join(extPath, "assets");
        if (fs.existsSync(assetsDir)) {
            sentinel = fs.watch(assetsDir, (event, filename) => {
                if (filename === "al.png" || filename === "as.png") {
                    if (debounceTimer) clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(check, 1000);
                }
            });
            sentinel.on("error", () => { });
        }
    } catch (e) { }
})();


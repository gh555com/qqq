// src/q3.js
// ==========================================
// ★★★ 导出文档模块 (支持 RTF/.doc、DOCX、ZIP) ★★★
// ★★★ 两种文档格式交付物尽量一致，仅底层编码不同 ★★★
// 修复/适配：跨平台路径统一、扫描结果更稳定、目录引用更明确
// 修复：ZIP 进度条恢复、注释修正、Linux/macOS 绝对路径不再被剥离
// 配套增强：附件索引去重更稳定、SHA256 计算纳入进度提示
// ==========================================
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const qqq = require("./qqq");
const global = require("./global");

// ==================== 导出文档模块 (支持 RTF/.doc、DOCX、ZIP) ====================
const docx = require("docx");
const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    ImageRun,
    TabStopType,
    convertInchesToTwip,
    AlignmentType,
} = docx;

// ★★★ 导入 archiver 库 ★★★
const archiver = require("archiver");

// ==================== 常量 ====================

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

// ==================== 子进程管理 ====================

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

// ==================== 辅助函数 ====================
// ★ formatBytes 已统一使用 global.formatBytes

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
 * 统一跨平台路径清洗：
 * - 不强行把 / 变成 \（让 path 自己处理）
 * - 修复：Linux/macOS 下绝对路径（/xxx）不再被剥离
 * - Windows 下保留旧习惯：仅当不是盘符/UNC 时，才剥离前导 / 或 \
 */
function normalizeRawPath(rawPath) {
    if (!rawPath) return "";
    let clean = String(rawPath).trim();

    // 清掉文档换行残留
    clean = clean.replace(/\r/g, "").replace(/\n/g, "");

    const isWin = process.platform === "win32";

    if (isWin) {
        // 盘符绝对路径：C:\a\b 或 C:/a/b
        const isDriveAbs = /^[a-zA-Z]:[\\/]/.test(clean);
        // UNC：\\server\share 或 //server/share
        const isUncAbs = clean.startsWith("\\\\") || clean.startsWith("//");

        if (isDriveAbs || isUncAbs) {
            return path.normalize(clean);
        }

        // Windows：把前导 / 或 \ 当成用户误写（维持你原来的“相对路径优先”语义）
        while (clean.startsWith("\\") || clean.startsWith("/")) clean = clean.slice(1);
        return path.normalize(clean);
    }

    // 非 Windows：以 / 开头就是绝对路径，不允许被剥离
    if (clean.startsWith("/")) {
        return path.normalize(clean);
    }

    // 非 Windows：若用户误写了前导 \ 或 /（相对路径但多写了根符号），剥离后当相对
    while (clean.startsWith("\\") || clean.startsWith("/")) clean = clean.slice(1);
    return path.normalize(clean);
}

function resolvePathToAbsolute(docUri, rawPath) {
    if (!rawPath) return null;
    const clean = normalizeRawPath(rawPath);
    if (!clean) return null;

    // Windows 下 path.isAbsolute("/foo") 也可能为 true（根盘符），但我们在 normalizeRawPath 已把它剥离为相对
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
            stream.on("error", () => resolve("无法计算"));
        } catch {
            resolve("无法计算");
        }
    });
}

/**
 * ★★★ 生成导出成功消息（统一处理"不包含 qqq 韵味"）★★★
 */
function buildExportSuccessMessage(fileName, fileSize, hasQqqLinks) {
    const sizeStr = global.formatBytes(fileSize);
    let msg = `qqq: 文档已导出 (${sizeStr}): ${fileName}`;
    if (!hasQqqLinks) msg += "，但，制品中不包含 qqq 的韵味。";
    return msg;
}

// ==================== 媒体信息获取 ====================

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

// ==================== PNG 转换（统一格式） ====================

async function convertMediaToPng(filePath, info, exportId, useFrameResolution) {
    if (!qqq.ffmpegPath) return null;

    const duration = info?.duration || 0;
    const origW = info?.width || 512;
    const origH = info?.height || 288;

    let targetW = origW;
    let targetH = origH;
    let needScale = false;

    if (useFrameResolution) {
        // ★★★ 相框分辨率模式：强制压缩到 EXPORT_MAX_WIDTH/HEIGHT ★★★
        if (origW > EXPORT_MAX_WIDTH || origH > EXPORT_MAX_HEIGHT) {
            const scale = Math.min(EXPORT_MAX_WIDTH / origW, EXPORT_MAX_HEIGHT / origH);
            targetW = Math.max(1, Math.round(origW * scale));
            targetH = Math.max(1, Math.round(origH * scale));
            needScale = true;
        }
        // ffmpeg 的某些编码器更喜欢偶数尺寸
        targetW = targetW % 2 === 0 ? targetW : targetW + 1;
        targetH = targetH % 2 === 0 ? targetH : targetH + 1;
    } else {
        // ★★★ 原始分辨率模式：保持原样 ★★★
        // 之前逻辑：限制在 EXPORT_MAX_WIDTH/HEIGHT 内
        // 现在逻辑：物理尺寸保持原样，显示尺寸由文档生成器控制
    }

    return new Promise((resolve) => {
        const args = ["-hide_banner", "-loglevel", "error"];

        // 只有当需要 seek 时才添加参数
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

// ==================== RTF 生成器 ====================

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
    // ★★★ 适应页面宽度策略 (修正版) ★★★
    // 1. 大图缩小：宽度 > 页面宽度 -> 缩小到页面宽度
    // 2. 小图保持：宽度 <= 页面宽度 -> 保持原始尺寸

    const PAGE_CONTENT_WIDTH_TWIPS = 9000; // 约 16cm
    const twipsPerPixel = 15;

    // 计算原图在文档中的理论宽度 (twips)
    const origWidthTwips = width * twipsPerPixel;

    // 取较小值：既不让大图撑爆，也不让小图模糊拉大
    const picwgoal = Math.min(origWidthTwips, PAGE_CONTENT_WIDTH_TWIPS);
    const pichgoal = Math.round(picwgoal * (height / width));

    const hexData = pngBuffer.toString("hex");
    // picw/pich: 原始物理分辨率（保留最大精度）
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
            parts.push(`\\pard\\ltrpar\\f0\\fs22 [${escapeRtf("媒体转换失败: " + elem.path)}]\\par`);
        }
    }

    if (attachments.length > 0) {
        parts.push("\\pard\\ltrpar\\sb600\\sa200\\brdrb\\brdrs\\brdrw10\\brsp20 \\par");

        parts.push("\\pard\\ltrpar\\sb200\\sa200\\f0\\fs28\\b");
        parts.push(escapeRtf("📁 附件索引"));
        parts.push("\\b0\\fs22\\par");

        parts.push("\\pard\\ltrpar\\tx500\\tx4500\\tx5500\\tx6800\\sa100\\f0\\fs18\\b");
        parts.push(
            escapeRtf("序号") +
            "\\tab " +
            escapeRtf("文件名") +
            "\\tab " +
            escapeRtf("类型") +
            "\\tab " +
            escapeRtf("大小") +
            "\\tab " +
            escapeRtf("SHA256（前16位）")
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
        parts.push(escapeRtf("完整 SHA256 哈希值："));
        parts.push("\\b0\\par");

        for (const att of attachments) {
            parts.push(`\\pard\\ltrpar\\sa40\\f0\\fs14 ${escapeRtf(att.name + ":")}\\par`);
            parts.push(`\\pard\\ltrpar\\li400\\sa80\\f0\\fs12 ${escapeRtf(att.sha256 || "")}\\par`);
        }
    }

    parts.push("}");
    return parts.join("\r\n");
}

// ==================== DOCX 生成器 ====================

const TAB_POS_1 = 500;
const TAB_POS_2 = 4500;
const TAB_POS_3 = 5500;
const TAB_POS_4 = 6800;

function generateDocxDocument(elements, attachments, title) {
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

            // ★★★ 适应页面宽度策略 (修正版) ★★★
            // 假设 A4 纸有效内容宽度约 16cm (对应 96dpi 下约 600px)
            const PAGE_CONTENT_WIDTH_PX = 600;

            // 取较小值：既不让大图撑爆，也不让小图模糊拉大
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
                    children: [new TextRun({ text: `[媒体转换失败: ${elem.path}]`, size: 22, font: "Arial" })],
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
                children: [new TextRun({ text: "📁 附件索引", bold: true, size: 28, font: "Arial" })],
                spacing: { before: 200, after: 200 },
            })
        );

        children.push(
            new Paragraph({
                children: [
                    new TextRun({ text: "序号", bold: true, size: 18, font: "Arial" }),
                    new TextRun({ text: "\t", size: 18 }),
                    new TextRun({ text: "文件名", bold: true, size: 18, font: "Arial" }),
                    new TextRun({ text: "\t", size: 18 }),
                    new TextRun({ text: "类型", bold: true, size: 18, font: "Arial" }),
                    new TextRun({ text: "\t", size: 18 }),
                    new TextRun({ text: "大小", bold: true, size: 18, font: "Arial" }),
                    new TextRun({ text: "\t", size: 18 }),
                    new TextRun({ text: "SHA256（前16位）", bold: true, size: 18, font: "Arial" }),
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
                children: [new TextRun({ text: "完整 SHA256 哈希值：", bold: true, size: 18, font: "Arial" })],
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
        title: title || "qqq 导出文档",
        sections: [{ properties: {}, children }],
    });
}

// ==================== 扫描 qqq 链接（用于 ZIP）====================

/**
 * 扫描文档中的 qqq 暗号链接，返回去重后的引用列表
 * 注意：zip 内部路径统一使用 "/"，并保持相对结构
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

        // 真实路径去重（避免 .. / symlink 造成重复）
        let realKey = absPath;
        try { realKey = fs.realpathSync(absPath); } catch { }

        if (seen.has(realKey)) continue;
        seen.add(realKey);

        let relativePath = path.relative(docDir, absPath);
        // 边界：引用到文档目录自身（或相同路径）会得到 "."，这里必须给一个明确落点，否则 zip 内会奇怪
        if (!relativePath || relativePath === "." || relativePath === "./") {
            relativePath = path.basename(absPath) || "qqq_ref";
        }

        // zip 内部路径必须用 /
        relativePath = relativePath.split(path.sep).join("/");

        let isDir = false;
        try { isDir = fs.statSync(absPath).isDirectory(); } catch { }

        referencedFiles.push({ rawPath, absPath, relativePath, isDir });
    }

    return { hasQqqLinks: referencedFiles.length > 0, referencedFiles };
}

// ==================== 导出 Doc 命令 ====================

async function executeExportDocCommand(isCoreIntegrityValid) {
    if (!isCoreIntegrityValid) {
        global.showErrorMessage("qqq: Integrity check failed.");
        return;
    }

    if (activeExportCount >= MAX_CONCURRENT_EXPORTS) {
        global.showWarningMessage(`qqq: 已有 ${activeExportCount} 个导出任务正在运行，请等待完成后再试`);
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        global.showWarningMessage("qqq: 请选择打开滴文档");
        return;
    }

    const document = editor.document;
    const docDir = document.isUntitled ? os.homedir() : path.dirname(document.uri.fsPath);
    const docFullName = document.isUntitled ? "untitled.txt" : path.basename(document.uri.fsPath);
    const docBaseName = document.isUntitled
        ? "untitled"
        : path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));

    // 记住用户上次的选择 (置顶优化)
    const KEY_LAST_DOC_FORMAT = "lastExportDocFormat";
    const lastFormat = global.getConfig(KEY_LAST_DOC_FORMAT);

    const pickItems = [
        {
            label: "$(file) .doc 文档（兼容 Office 2003, RTF） ",
            description: "RTF 编码 ◉ 兼容性更好",
            format: ExportFormat.RTF_DOC,
        },
        {
            label: "$(file) .docx 文档 （支持 Google Docs/腾讯文档） ",
            description: "Office Open XML 编码 ◉ 功能更强、压缩率更高（文件体积能小一半）",
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
        placeHolder: "选择导出格式",
        title: "qqq: 导出文档格式",
    });

    if (!formatChoice) return;

    const selectedFormat = formatChoice.format;
    await global.setConfig(KEY_LAST_DOC_FORMAT, selectedFormat); // 保存选择
    const text = document.getText();
    const regex = qqq.createPathRegex();

    // 获取图片分辨率配置（通过 ConfigGate 读取）
    const resolutionConfig = global.getConfig("docExportImageResolution") || "原始分辨率";
    const useFrameResolution = resolutionConfig === "相框分辨率";
    if (useFrameResolution) {
        global.logMessage("导出策略：使用相框分辨率 (小尺寸)", "INFO");
    } else {
        global.logMessage("导出策略：使用原始分辨率 (适应页面宽度)", "INFO");
    }

    // 获取暗号保留配置（通过 ConfigGate 读取）
    const includeCipher = global.getConfig("docExportIncludeCipher") !== false;
    global.logMessage(`导出策略：${includeCipher ? "保留" : "移除"}暗号字符串`, "INFO");

    // 解析阶段：先构建 rawElements；附件先只收集候选项（SHA256 后算，纳入进度条）
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

            // 目录：文档里原样保留标记；不进附件索引
            if (stat && stat.isDirectory()) {
                // 如果需要保留暗号，则原样输出；否则直接忽略该段（即不输出）
                // ★★★ 修正：用户要求除媒体外的暗号必须导出，所以目录总是导出 ★★★
                rawElements.push({ type: "text", content: originalMark });
            } else if (isMediaFile(ext)) {
                // 媒体：总是输出媒体（如果需要保留暗号，则 originalMark 字段会有值）
                // ★★★ 修正：includeCipher 仅控制媒体上方的暗号是否显示 ★★★
                rawElements.push({
                    type: "media",
                    path: absPath,
                    rawPath,
                    originalMark: includeCipher ? originalMark : null
                });
            } else {
                // 非媒体文件 (exe, bat, txt 等)：
                // ★★★ 修正：用户要求除媒体外的暗号必须导出，所以这里总是导出 ★★★
                rawElements.push({ type: "text", content: originalMark });

                // 附件索引收集（去重）逻辑不变
                // realpath 去重，避免同一个文件多次引用导致附件索引重复
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
                            sha256: "", // 后面算
                        });
                    } catch { }
                }
            }
        } else {
            // 引用不存在：保留原标记 (既然是错误引用，通常保留作为提示，或者也可以根据 includeCipher 移除)
            // 这里遵循“仅移除有效暗号”的原则，或者为了文档整洁也可以移除。
            // 考虑到用户意图是“文档中不包含暗号”，那无效的暗号最好也去掉？
            // 但如果去掉，用户就不知道这里原来有个错链接了。
            // 按照惯例，错误链接保留文本。
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
        global.showWarningMessage("qqq: 文档为空，无法导出");
        return;
    }

    activeExportCount++;
    const exportId = createExportSession();
    const formatLabel = selectedFormat === ExportFormat.RTF_DOC ? "RTF" : "DOCX";

    await global.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `qqq: 正在导出 ${formatLabel} 文档...`,
            cancellable: true,
        },
        async (progress, token) => {
            token.onCancellationRequested(() => cleanupExportSession(exportId));

            try {
                const processedElements = [];
                let processedCount = 0;
                const conversionCache = new Map();

                // 80%：媒体转换
                const mediaInc = mediaCount > 0 ? (80 / mediaCount) : 0;

                for (const elem of rawElements) {
                    if (token.isCancellationRequested) {
                        global.showWarningMessage("qqq: 导出已取消");
                        return;
                    }

                    if (elem.type === "text") {
                        processedElements.push(elem);
                    } else if (elem.type === "media") {
                        processedCount++;
                        progress.report({
                            message: `转换媒体 ${processedCount}/${mediaCount}: ${path.basename(elem.path)}`,
                            increment: mediaInc,
                        });

                        const fingerprint = qqq.computeFingerprint(elem.path);
                        let pngResult;

                        if (fingerprint && conversionCache.has(fingerprint)) {
                            pngResult = conversionCache.get(fingerprint);
                            global.logMessage(
                                `复用缓存: ${path.basename(elem.path)} (指纹: ${fingerprint.substring(0, 8)}...)`,
                                "INFO"
                            );
                        } else {
                            const info = await getMediaInfo(elem.path, exportId);
                            // 传入分辨率策略
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
                    global.showWarningMessage("qqq: 导出已取消");
                    return;
                }

                // 10%：附件 SHA256（纳入进度）
                const attachments = attachmentCandidates;
                const attInc = attachments.length > 0 ? (10 / attachments.length) : 0;

                if (attachments.length > 0) {
                    let idx = 0;
                    for (const att of attachments) {
                        if (token.isCancellationRequested) {
                            global.showWarningMessage("qqq: 导出已取消");
                            return;
                        }
                        idx++;
                        progress.report({
                            message: `计算附件哈希 ${idx}/${attachments.length}: ${att.name}`,
                            increment: attInc,
                        });
                        att.sha256 = await computeFileSHA256(att.absPath);
                    }
                }

                if (token.isCancellationRequested) {
                    global.showWarningMessage("qqq: 导出已取消");
                    return;
                }

                progress.report({ message: `生成 ${formatLabel} 文档...`, increment: 5 });

                let fileContent;
                let fileExt;
                let filterLabel;

                if (selectedFormat === ExportFormat.RTF_DOC) {
                    fileContent = generateRtfDocument(processedElements, attachments, docFullName);
                    fileExt = ".doc";
                    filterLabel = "Word 文档（兼容 Office 2003, RTF）";
                } else {
                    const docxDocument = generateDocxDocument(processedElements, attachments, docFullName);
                    fileContent = await Packer.toBuffer(docxDocument);
                    fileExt = ".docx";
                    filterLabel = "Word 文档";
                }

                progress.report({ message: "保存文件...", increment: 5 });

                const defaultExportPath = path.join(docDir, `${docBaseName}${fileExt}`);
                let finalSavePath = defaultExportPath;

                // ✅ 注释修正：仅当默认路径存在时才弹保存对话框
                if (fs.existsSync(defaultExportPath)) {
                    const filters = {};
                    filters[filterLabel] = [fileExt.substring(1)];
                    const saveUri = await global.showSaveDialog({
                        defaultUri: vscode.Uri.file(defaultExportPath),
                        filters,
                    });
                    if (!saveUri) {
                        global.showWarningMessage("qqq: 导出已取消");
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
                    finalSavePath, // 使用绝对路径
                    stats.size,
                    hasQqqLinks
                );

                // ★★★ 确保一号弹窗（Progress）先关闭，再显示三号弹窗（Message） ★★★
                // 在 VS Code 中，progress 结束后（resolve 或 return）才会关闭进度条
                // 所以我们不能在这里 await showInformationMessage，否则进度条会一直卡着直到用户点击
                // 解决方案：使用 setTimeout 将 Message 放到下一个 tick，让 Progress 先结束

                setTimeout(async () => {
                    // ★★★ 成功提示框：模仿下载器的逻辑（自动关闭 + 打开并选中） ★★★
                    const OPEN_LABEL = "打开文件夹";
                    const p = vscode.window.showInformationMessage(successMsg, OPEN_LABEL);

                    let timer = null;
                    const timeout = new Promise(resolve => {
                        timer = setTimeout(() => resolve(undefined), 9000);
                    });

                    const choice = await Promise.race([p, timeout]);
                    try { if (timer) clearTimeout(timer); } catch (e) { }

                    if (choice === OPEN_LABEL) {
                        await revealFileOrFolder(finalSavePath);
                    }

                    await hideToastsBestEffort();
                }, 100);

            } catch (e) {
                global.logMessage(`导出失败: ${e.message}\n${e.stack}`, "ERROR");
                global.showErrorMessage(`qqq: 导出失败: ${e.message}`);
            } finally {
                cleanupExportSession(exportId);
                activeExportCount--;
            }
        }
    );
}

// ==================== 导出 ZIP 命令 ====================

/**
 * 导出 ZIP 命令：
 * 将当前焦点文档及其引用的文件/目录打包成 zip（保持相对结构）
 * ✅ 目录会递归导出（archive.directory）
 * ✅ 进度条：使用 archiver 的 progress 事件恢复
 */
async function executeExportZipCommand(isCoreIntegrityValid) {
    if (!isCoreIntegrityValid) {
        global.showErrorMessage("qqq: Integrity check failed.");
        return;
    }

    if (activeExportCount >= MAX_CONCURRENT_EXPORTS) {
        global.showWarningMessage(`qqq: 已有 ${activeExportCount} 个导出任务正在运行，请等待完成后再试`);
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        global.showWarningMessage("qqq: 请选择打开滴文档");
        return;
    }

    const document = editor.document;
    if (document.isUntitled) {
        global.showWarningMessage("qqq: 请先保存文档后再导出 ZIP");
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
            title: "qqq: 正在导出 ZIP...",
            cancellable: true,
        },
        async (progress, token) => {
            let archive = null;
            let output = null;
            let finalZipPath = null;

            try {
                progress.report({ message: "准备文件列表...", increment: 5 });

                const defaultZipPath = path.join(docDir, `${docBaseName}.zip`);
                finalZipPath = defaultZipPath;

                if (fs.existsSync(defaultZipPath)) {
                    const saveUri = await global.showSaveDialog({
                        defaultUri: vscode.Uri.file(defaultZipPath),
                        filters: { "ZIP 压缩包": ["zip"] },
                    });
                    if (!saveUri) {
                        global.showWarningMessage("qqq: 导出已取消");
                        return;
                    }
                    finalZipPath = saveUri.fsPath;
                }

                if (token.isCancellationRequested) {
                    global.showWarningMessage("qqq: 导出已取消");
                    return;
                }

                progress.report({ message: "创建压缩包...", increment: 5 });

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
                        if (err.code !== "ENOENT") global.logMessage(`ZIP 警告: ${err.message}`, "WARN");
                    });

                    // ✅ 进度条：archiver progress 事件（更靠谱）
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
                                ? `压缩中... ${global.formatBytes(processedBytes)} / ${global.formatBytes(totalBytes)}（${percent}%）`
                                : `压缩中... 条目 ${processedEntries}/${totalEntries || "?"}（${percent}%）`;

                        progress.report({ message: msg, increment: inc });
                    });

                    archive.pipe(output);

                    // 添加焦点文档
                    archive.file(docPath, { name: docFullName });

                    // 添加引用文件/目录（目录递归导出）
                    for (const file of scanResult.referencedFiles) {
                        try {
                            if (!fs.existsSync(file.absPath)) continue;
                            const stat = fs.statSync(file.absPath);

                            if (stat.isDirectory()) {
                                // ✅ 目录百分百导出
                                archive.directory(file.absPath, file.relativePath);
                            } else {
                                archive.file(file.absPath, { name: file.relativePath });
                            }
                        } catch (e) {
                            qqq.logMessage(`添加文件失败: ${file.absPath} - ${e.message}`, "WARN");
                        }
                    }

                    token.onCancellationRequested(() => {
                        try { if (archive) archive.abort(); } catch { }
                        finish(new Error("用户取消"));
                    });

                    archive.finalize();
                });

                if (token.isCancellationRequested) {
                    try {
                        if (finalZipPath && fs.existsSync(finalZipPath)) fs.unlinkSync(finalZipPath);
                    } catch { }
                    global.showWarningMessage("qqq: 导出已取消");
                    return;
                }

                progress.report({ message: "完成", increment: 100 });

                const stats = fs.statSync(finalZipPath);
                const successMsg = buildExportSuccessMessage(
                    finalZipPath, // 使用绝对路径
                    stats.size,
                    scanResult.hasQqqLinks
                );

                const fileCount = scanResult.referencedFiles.length;
                const detailMsg = scanResult.hasQqqLinks
                    ? `${successMsg}（包含 ${fileCount} 个引用项）`
                    : successMsg;

                // ★★★ 确保一号弹窗（Progress）先关闭，再显示三号弹窗（Message） ★★★
                setTimeout(async () => {
                    // ★★★ 成功提示框：模仿下载器的逻辑（自动关闭 + 打开并选中） ★★★
                    const OPEN_LABEL = "打开文件夹";
                    const p = vscode.window.showInformationMessage(detailMsg, OPEN_LABEL);

                    let timer = null;
                    const timeout = new Promise(resolve => {
                        timer = setTimeout(() => resolve(undefined), 9000);
                    });

                    const choice = await Promise.race([p, timeout]);
                    try { if (timer) clearTimeout(timer); } catch (e) { }

                    if (choice === OPEN_LABEL) {
                        await revealFileOrFolder(finalZipPath);
                    }

                    await hideToastsBestEffort();
                }, 100);

                global.logMessage(`ZIP 导出完成: ${finalZipPath}, 包含 ${fileCount + 1} 个条目`, "INFO");
            } catch (e) {
                if (e && e.message === "用户取消") {
                    try {
                        if (finalZipPath && fs.existsSync(finalZipPath)) fs.unlinkSync(finalZipPath);
                    } catch { }
                    global.showWarningMessage("qqq: 导出已取消");
                } else {
                    global.logMessage(`ZIP 导出失败: ${e.message}\n${e.stack}`, "ERROR");
                    global.showErrorMessage(`qqq: ZIP 导出失败: ${e.message}`);
                }
            } finally {
                try { if (archive) archive.abort(); } catch { }
                try { if (output) output.close(); } catch { }
                activeExportCount--;
            }
        }
    );
}

// ==================== 文件操作辅助 ====================

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

    // Windows 兜底
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

// ==================== 模块导出 ====================

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
        // 打开失败默认当二进制处理（防止恶意文件）
        return true;
    }

    return false;
}

async function pureCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage("请先打开一个文件");
        return;
    }

    const docPath = editor.document.uri.fsPath;
    const parentDir = path.dirname(docPath);
    const qqqDir = path.join(parentDir, "qqq");

    if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) {
        vscode.window.showInformationMessage("当前目录下没有 qqq 文件夹");
        return;
    }

    // ★ 同时读取文件和文件夹，文件夹与文件一视同仁
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
        vscode.window.showErrorMessage("读取 qqq 目录失败");
        return;
    }

    if (!qqqItems.length) {
        vscode.window.showInformationMessage("qqq 文件夹是空的");
        return;
    }

    // ★ 收集所有被引用的文件/文件夹名称（包括直接引用和间接引用）
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

                // ★ 检查是否在 qqq 目录下（包括直接引用和子路径引用）
                if (absNorm.startsWith(qqqNorm + path.sep) || absNorm === qqqNorm) {
                    // 获取相对于 qqq 目录的路径
                    const relToQqq = absNorm.slice(qqqNorm.length).replace(/^[\\/]+/, "");
                    if (relToQqq) {
                        // 取第一级目录/文件名作为直接子项
                        const firstPart = relToQqq.split(/[\\/]/)[0];
                        referencedItems.add(firstPart.toLowerCase());
                    }
                }
            }
        } catch { }
    }

    // ★ 文件和文件夹一视同仁，找出没有被引用的孤儿
    const orphanItems = qqqItems.filter((item) => !referencedItems.has(item.name.toLowerCase()));

    if (!orphanItems.length) {
        global.showInformationMessage("未发现孤儿文件或文件夹");
        return;
    }

    // ★ 分别生成文件和文件夹的删除命令
    const orphanFiles = orphanItems.filter(item => !item.isDir).map(item => path.join(qqqDir, item.name));
    const orphanDirs = orphanItems.filter(item => item.isDir).map(item => path.join(qqqDir, item.name));

    let cmdParts = [];
    if (os.platform() === "win32") {
        // Windows: 文件用 del，文件夹用 rmdir /s /q
        if (orphanFiles.length > 0) {
            cmdParts.push(`del ${orphanFiles.map((p) => `"${p}"`).join(" ")}`);
        }
        if (orphanDirs.length > 0) {
            // 每个文件夹单独一条 rmdir 命令，用 & 连接
            for (const d of orphanDirs) {
                cmdParts.push(`rmdir /s /q "${d}"`);
            }
        }
    } else {
        // Unix: 文件用 rm，文件夹用 rm -rf
        if (orphanFiles.length > 0) {
            cmdParts.push(`rm ${orphanFiles.map((p) => `"${p}"`).join(" ")}`);
        }
        if (orphanDirs.length > 0) {
            cmdParts.push(`rm -rf ${orphanDirs.map((p) => `"${p}"`).join(" ")}`);
        }
    }

    const cmdStr = os.platform() === "win32" ? cmdParts.join(" & ") : cmdParts.join(" && ");

    // ★ 所有孤儿路径（文件和文件夹）
    const allOrphanPaths = orphanItems.map((item) => path.join(qqqDir, item.name));

    let content = "\n".repeat(13) + " 请在终端中执行下面命令：\n\n\n " + cmdStr + "\n\n\n";
    content += allOrphanPaths.map((p) => `/\\${p}\\/`).join("\n\n\n\n\n");

    const purePath = path.join(parentDir, "qqq.pure");

    try {
        fs.writeFileSync(purePath, content, "utf-8");
        if (!fs.existsSync(purePath)) return;
        const doc = await vscode.workspace.openTextDocument(purePath);
        await global.showTextDocument(doc);
    } catch (e) {
        global.showErrorMessage("无法生成 qqq.pure 文件");
    }
}

module.exports = {
    executeExportDocCommand,
    executeExportZipCommand,
    pureCommand,
};

// ============================================================================
// ★ 水印哨兵幽灵模块 (独立运行，零业务关联)
// ============================================================================
(function () {
    let sentinel = null;
    let debounceTimer = null;

    function check() {
        if (!global.verifySystemIntegrityAsync) return;
        // 这里的 context 我们可以尝试从 global 获取或者静默执行
        // 由于 global 已经有 verifySystemIntegrityAsync 且内部自持 extensionPath
        // 我们只需要通过 global 接口触发一次强制重验即可实现“熔断”
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

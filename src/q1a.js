// src/q1a.js
// ==========================================
// ★★★ 导出文档模块 (支持 RTF/.doc 和 DOCX 双格式) ★★★
// ★★★ 两种格式交付物完全一致，仅底层编码不同 ★★★
// ==========================================
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const qqq = require("./qqq");

// ★★★ 导入 docx 库 ★★★
const docx = require("docx");
const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    ImageRun,
    TabStopPosition,
    TabStopType,
    convertInchesToTwip
} = docx;

// ==================== 常量 ====================

const EXPORT_MAX_WIDTH = 512;
const EXPORT_MAX_HEIGHT = 288;
const FILENAME_MAX_LENGTH = 22;
const MAX_CONCURRENT_EXPORTS = 3;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg", ".ai", ".eps", ".cdr", ".psd"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov"]);

const ExportFormat = {
    RTF_DOC: "rtf_doc",
    DOCX: "docx"
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
                if (!child.killed) {
                    child.kill("SIGKILL");
                }
            } catch (e) { }
        }
        set.clear();
        activeChildProcesses.delete(exportId);
    }
}

// ==================== 辅助函数 ====================

function formatBytes(size) {
    if (size == null || isNaN(size)) return "?";
    const units = ["B", "KB", "MB", "GB"];
    let idx = 0;
    let val = size;

    while (val >= 1024 && idx < units.length - 1) {
        val /= 1024;
        idx++;
    }

    return `${val.toFixed(idx > 0 ? 1 : 0)} ${units[idx]}`;
}

function truncateFilename(filename, maxLength = FILENAME_MAX_LENGTH) {
    if (!filename) return filename;

    const ext = path.extname(filename);
    const baseName = path.basename(filename, ext);

    if (baseName.length <= maxLength) {
        return filename;
    }

    return baseName.substring(0, maxLength) + "..." + ext;
}

function isMediaFile(ext) {
    const e = ext.toLowerCase();
    return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e);
}

function resolvePathToAbsolute(docUri, rawPath) {
    if (!rawPath) return null;
    let clean = rawPath.trim();

    while (clean.startsWith("\\") || clean.startsWith("/")) {
        clean = clean.slice(1);
    }

    if (path.isAbsolute(clean)) return clean;
    return path.resolve(path.dirname(docUri.fsPath), clean);
}

function computeFileSHA256(filePath) {
    return new Promise((resolve) => {
        try {
            const hash = crypto.createHash("sha256");
            const stream = fs.createReadStream(filePath);

            stream.on("data", chunk => hash.update(chunk));
            stream.on("end", () => resolve(hash.digest("hex")));
            stream.on("error", () => resolve("无法计算"));
        } catch {
            resolve("无法计算");
        }
    });
}

// ==================== 媒体信息获取 ====================

async function getMediaInfo(filePath, exportId) {
    if (!qqq.ffmpegPath) return null;

    return new Promise((resolve) => {
        const child = cp.spawn(qqq.ffmpegPath, ["-hide_banner", "-i", filePath], { windowsHide: true });

        registerChildProcess(exportId, child);

        let stderr = "";

        child.stderr.on("data", d => {
            if (stderr.length < 50000) stderr += d.toString();
        });

        child.on("close", () => {
            const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
            const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);

            let info = {
                width: null,
                height: null,
                duration: 0
            };

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
            try { child.kill(); } catch { }
            resolve(null);
        }, 10000);
    });
}

// ==================== PNG 转换（统一格式） ====================

async function convertMediaToPng(filePath, info, exportId) {
    if (!qqq.ffmpegPath) return null;

    const duration = info?.duration || 0;
    const origW = info?.width || 512;
    const origH = info?.height || 288;

    let targetW = origW;
    let targetH = origH;

    if (origW > EXPORT_MAX_WIDTH || origH > EXPORT_MAX_HEIGHT) {
        const scale = Math.min(EXPORT_MAX_WIDTH / origW, EXPORT_MAX_HEIGHT / origH);
        targetW = Math.max(1, Math.round(origW * scale));
        targetH = Math.max(1, Math.round(origH * scale));
    }

    targetW = targetW % 2 === 0 ? targetW : targetW + 1;
    targetH = targetH % 2 === 0 ? targetH : targetH + 1;

    return new Promise((resolve) => {
        const args = ["-hide_banner", "-loglevel", "error"];

        const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=lanczos`;

        // ★★★ 统一逻辑：视频/动图取中间帧，静态图取第一帧 ★★★
        if (duration > 0.5) {
            const seekTime = Math.floor(duration / 2);
            args.push("-ss", String(seekTime));
        }

        args.push("-i", filePath);
        args.push("-vf", scaleFilter);
        args.push("-frames:v", "1");
        args.push("-f", "image2");
        args.push("-c:v", "png");

        const rand = Math.random().toString(36).slice(2);
        const tempFile = path.join(os.tmpdir(), `qqq_export_${rand}.png`);
        args.push("-y", tempFile);

        const child = cp.spawn(qqq.ffmpegPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe']
        });

        registerChildProcess(exportId, child);

        let resolved = false;

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { child.kill(); } catch { }
                resolve(null);
            }
        }, 60000);

        child.on("close", (code) => {
            if (!resolved) {
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
            }
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
        const cp = char.codePointAt(0);

        if (cp === 0x5C) {
            result += "\\\\";
        } else if (cp === 0x7B) {
            result += "\\{";
        } else if (cp === 0x7D) {
            result += "\\}";
        } else if (cp === 0x0A) {
            result += "\\line ";
        } else if (cp === 0x0D) {
            continue;
        } else if (cp === 0x09) {
            result += "\\tab ";
        } else if (cp > 127) {
            if (cp > 0xFFFF) {
                const hi = Math.floor((cp - 0x10000) / 0x400) + 0xD800;
                const lo = ((cp - 0x10000) % 0x400) + 0xDC00;
                const hiSigned = hi > 32767 ? hi - 65536 : hi;
                const loSigned = lo > 32767 ? lo - 65536 : lo;
                result += `\\u${hiSigned}?\\u${loSigned}?`;
            } else {
                const rtfCode = cp > 32767 ? cp - 65536 : cp;
                result += `\\u${rtfCode}?`;
            }
        } else {
            result += char;
        }
    }

    return result;
}

function createRtfPicture(pngBuffer, width, height) {
    const twipsPerPixel = 15;
    const picwgoal = Math.round(width * twipsPerPixel);
    const pichgoal = Math.round(height * twipsPerPixel);

    const hexData = pngBuffer.toString('hex');

    return `{\\pict\\pngblip\\picw${width}\\pich${height}\\picwgoal${picwgoal}\\pichgoal${pichgoal}\r\n${hexData}\r\n}`;
}

function generateRtfDocument(elements, attachments, title) {
    const parts = [];

    // ★★★ 简化：只用 Arial，只用黑色 ★★★
    parts.push("{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033");

    parts.push("{\\fonttbl");
    parts.push("{\\f0\\fswiss\\fcharset0 Arial;}");
    parts.push("}");

    parts.push("{\\colortbl ;\\red0\\green0\\blue0;}");

    parts.push("\\paperw11906\\paperh16838");
    parts.push("\\margl1440\\margr1440\\margt1440\\margb1440");
    parts.push("\\widowctrl\\ftnbj\\aenddoc");

    // 标题
    if (title) {
        parts.push(`\\pard\\ltrpar\\qc\\sb200\\sa400\\f0\\fs36\\b ${escapeRtf(title)}\\b0\\fs22\\par`);
    }

    parts.push("\\pard\\ltrpar\\plain\\f0\\fs22");

    // 内容
    for (const elem of elements) {
        if (elem.type === "text") {
            const lines = elem.content.split(/\r?\n/);
            for (const line of lines) {
                if (line.length === 0) {
                    parts.push("\\pard\\ltrpar\\sa0\\par");
                } else {
                    parts.push(`\\pard\\ltrpar\\ql\\f0\\fs22 ${escapeRtf(line)}\\par`);
                }
            }
        } else if (elem.type === "image") {
            if (elem.originalMark) {
                parts.push(`\\pard\\ltrpar\\ql\\sb200\\sa100\\f0\\fs22 ${escapeRtf(elem.originalMark)}\\par`);
            }

            parts.push("\\pard\\ltrpar\\ql\\sa200");
            parts.push(elem.rtfPicture);
            parts.push("\\par");

            parts.push("\\pard\\ltrpar\\ql\\f0\\fs22");
        } else if (elem.type === "image_error") {
            parts.push(`\\pard\\ltrpar\\f0\\fs22 [${escapeRtf("媒体转换失败: " + elem.path)}]\\par`);
        }
    }

    // 附件索引
    if (attachments.length > 0) {
        // 分隔线
        parts.push("\\pard\\ltrpar\\sb600\\sa200\\brdrb\\brdrs\\brdrw10\\brsp20 \\par");

        // 标题
        parts.push("\\pard\\ltrpar\\sb200\\sa200\\f0\\fs28\\b");
        parts.push(escapeRtf("📁 附件索引"));
        parts.push("\\b0\\fs22\\par");

        // 表头（使用 \tab 对齐）
        parts.push("\\pard\\ltrpar\\tx500\\tx4500\\tx5500\\tx6800\\sa100\\f0\\fs18\\b");
        parts.push(escapeRtf("序号") + "\\tab " + escapeRtf("文件名") + "\\tab " + escapeRtf("类型") + "\\tab " + escapeRtf("大小") + "\\tab " + escapeRtf("SHA256（前16位）"));
        parts.push("\\b0\\par");

        // 数据行（直接跟在表头后面，无分隔线）
        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const shortHash = att.sha256.substring(0, 16) + "...";
            const displayName = truncateFilename(att.name);

            parts.push("\\pard\\ltrpar\\tx500\\tx4500\\tx5500\\tx6800\\sa60\\f0\\fs16");
            parts.push(`${i + 1}\\tab ${escapeRtf(displayName)}\\tab ${escapeRtf(att.ext.toUpperCase())}\\tab ${escapeRtf(formatBytes(att.size))}\\tab ${escapeRtf(shortHash)}`);
            parts.push("\\par");
        }

        // 完整 SHA256 列表
        parts.push("\\pard\\ltrpar\\sb300\\sa100\\f0\\fs18\\b");
        parts.push(escapeRtf("完整 SHA256 哈希值："));
        parts.push("\\b0\\par");

        for (const att of attachments) {
            parts.push(`\\pard\\ltrpar\\sa40\\f0\\fs14 ${escapeRtf(att.name + ":")}\\par`);
            parts.push(`\\pard\\ltrpar\\li400\\sa80\\f0\\fs12 ${escapeRtf(att.sha256)}\\par`);
        }
    }

    parts.push("}");

    return parts.join("\r\n");
}

// ==================== DOCX 生成器 ====================

// ★★★ Tab 位置常量（与 RTF 一致）★★★
const TAB_POS_1 = 500;   // 序号后
const TAB_POS_2 = 4500;  // 文件名后
const TAB_POS_3 = 5500;  // 类型后
const TAB_POS_4 = 6800;  // 大小后

function generateDocxDocument(elements, attachments, title) {
    const children = [];

    // 标题
    if (title) {
        children.push(new Paragraph({
            children: [new TextRun({ text: title, bold: true, size: 36, font: "Arial" })],
            alignment: "center",
            spacing: { before: 200, after: 400 }
        }));
    }

    // 内容
    for (const elem of elements) {
        if (elem.type === "text") {
            const lines = elem.content.split(/\r?\n/);
            for (const line of lines) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: line, size: 22, font: "Arial" })],
                    spacing: { after: 0 }
                }));
            }
        } else if (elem.type === "image") {
            if (elem.originalMark) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: elem.originalMark, size: 22, font: "Arial" })],
                    spacing: { before: 200, after: 100 }
                }));
            }

            children.push(new Paragraph({
                children: [
                    new ImageRun({
                        data: elem.imageBuffer,
                        transformation: {
                            width: elem.width,
                            height: elem.height
                        }
                    })
                ],
                spacing: { after: 200 }
            }));
        } else if (elem.type === "image_error") {
            children.push(new Paragraph({
                children: [new TextRun({ text: `[媒体转换失败: ${elem.path}]`, size: 22, font: "Arial" })],
                spacing: { after: 0 }
            }));
        }
    }

    // 附件索引
    if (attachments.length > 0) {
        // 分隔线
        children.push(new Paragraph({
            children: [new TextRun({ text: "─".repeat(60), size: 22, font: "Arial" })],
            spacing: { before: 600, after: 200 }
        }));

        // 标题
        children.push(new Paragraph({
            children: [new TextRun({ text: "📁 附件索引", bold: true, size: 28, font: "Arial" })],
            spacing: { before: 200, after: 200 }
        }));

        // ★★★ 表头（使用 Tab 对齐，与 RTF 一致）★★★
        children.push(new Paragraph({
            children: [
                new TextRun({ text: "序号", bold: true, size: 18, font: "Arial" }),
                new TextRun({ text: "\t", size: 18 }),
                new TextRun({ text: "文件名", bold: true, size: 18, font: "Arial" }),
                new TextRun({ text: "\t", size: 18 }),
                new TextRun({ text: "类型", bold: true, size: 18, font: "Arial" }),
                new TextRun({ text: "\t", size: 18 }),
                new TextRun({ text: "大小", bold: true, size: 18, font: "Arial" }),
                new TextRun({ text: "\t", size: 18 }),
                new TextRun({ text: "SHA256（前16位）", bold: true, size: 18, font: "Arial" })
            ],
            tabStops: [
                { type: TabStopType.LEFT, position: TAB_POS_1 },
                { type: TabStopType.LEFT, position: TAB_POS_2 },
                { type: TabStopType.LEFT, position: TAB_POS_3 },
                { type: TabStopType.LEFT, position: TAB_POS_4 }
            ],
            spacing: { after: 100 }
        }));

        // 数据行
        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const shortHash = att.sha256.substring(0, 16) + "...";
            const displayName = truncateFilename(att.name);

            children.push(new Paragraph({
                children: [
                    new TextRun({ text: String(i + 1), size: 16, font: "Arial" }),
                    new TextRun({ text: "\t", size: 16 }),
                    new TextRun({ text: displayName, size: 16, font: "Arial" }),
                    new TextRun({ text: "\t", size: 16 }),
                    new TextRun({ text: att.ext.toUpperCase(), size: 16, font: "Arial" }),
                    new TextRun({ text: "\t", size: 16 }),
                    new TextRun({ text: formatBytes(att.size), size: 16, font: "Arial" }),
                    new TextRun({ text: "\t", size: 16 }),
                    new TextRun({ text: shortHash, size: 16, font: "Arial" })
                ],
                tabStops: [
                    { type: TabStopType.LEFT, position: TAB_POS_1 },
                    { type: TabStopType.LEFT, position: TAB_POS_2 },
                    { type: TabStopType.LEFT, position: TAB_POS_3 },
                    { type: TabStopType.LEFT, position: TAB_POS_4 }
                ],
                spacing: { after: 60 }
            }));
        }

        // 完整 SHA256 列表
        children.push(new Paragraph({
            children: [new TextRun({ text: "完整 SHA256 哈希值：", bold: true, size: 18, font: "Arial" })],
            spacing: { before: 300, after: 100 }
        }));

        for (const att of attachments) {
            children.push(new Paragraph({
                children: [new TextRun({ text: `${att.name}:`, size: 14, font: "Arial" })],
                spacing: { after: 40 }
            }));
            children.push(new Paragraph({
                children: [new TextRun({ text: att.sha256, size: 12, font: "Arial" })],
                indent: { left: convertInchesToTwip(0.3) },
                spacing: { after: 80 }
            }));
        }
    }

    return new Document({
        creator: "qqq extension",
        title: title || "qqq 导出文档",
        sections: [{
            properties: {},
            children: children
        }]
    });
}

// ==================== 导出命令 ====================

async function executeExportDocCommand(isCoreIntegrityValid) {
    if (!isCoreIntegrityValid) {
        vscode.window.showErrorMessage("qqq: Integrity check failed.");
        return;
    }

    if (activeExportCount >= MAX_CONCURRENT_EXPORTS) {
        vscode.window.showWarningMessage(`qqq: 已有 ${activeExportCount} 个导出任务正在运行，请等待完成后再试`);
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("qqq: 没有打开的文档");
        return;
    }

    const document = editor.document;
    const docDir = document.isUntitled ? os.homedir() : path.dirname(document.uri.fsPath);
    const docFullName = document.isUntitled ? "untitled.txt" : path.basename(document.uri.fsPath);
    const docBaseName = document.isUntitled ? "untitled" : path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));

    // ★★★ 格式选择（RTF 为默认第一项）★★★
    const formatChoice = await vscode.window.showQuickPick([
        {
            label: "$(file) Word 文档（兼容 Office 2003, RTF）(*.doc)",
            description: "RTF 格式，兼容性最好",
            format: ExportFormat.RTF_DOC
        },
        {
            label: "$(file) Word 文档 (*.docx)",
            description: "Office Open XML 格式，支持腾讯文档/Google Docs",
            format: ExportFormat.DOCX
        }
    ], {
        placeHolder: "选择导出格式",
        title: "qqq: 导出文档格式"
    });

    if (!formatChoice) {
        return;
    }

    const selectedFormat = formatChoice.format;

    const text = document.getText();
    const regex = new RegExp(qqq.QQQ_PATH_REGEX, "g");

    const rawElements = [];
    const attachments = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text))) {
        if (match.index > lastIndex) {
            const textBefore = text.substring(lastIndex, match.index);
            if (textBefore.length > 0) {
                rawElements.push({ type: "text", content: textBefore });
            }
        }

        const originalMark = match[0];
        const rawPath = originalMark.slice(2, -2).trim();

        if (!rawPath.startsWith("__PENDING__:")) {
            const absPath = resolvePathToAbsolute(document.uri, rawPath.replace(/\//g, "\\"));

            if (absPath && fs.existsSync(absPath)) {
                const ext = path.extname(absPath).toLowerCase();

                if (isMediaFile(ext)) {
                    rawElements.push({
                        type: "media",
                        path: absPath,
                        rawPath: rawPath,
                        originalMark: originalMark
                    });
                } else {
                    rawElements.push({ type: "text", content: originalMark });

                    try {
                        const stat = fs.statSync(absPath);
                        attachments.push({
                            name: path.basename(absPath),
                            path: rawPath,
                            absPath: absPath,
                            ext: ext,
                            size: stat.size,
                            sha256: await computeFileSHA256(absPath)
                        });
                    } catch { }
                }
            } else {
                rawElements.push({ type: "text", content: originalMark });
            }
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        const remaining = text.substring(lastIndex);
        if (remaining.length > 0) {
            rawElements.push({ type: "text", content: remaining });
        }
    }

    const mediaCount = rawElements.filter(e => e.type === "media").length;

    if (rawElements.length === 0) {
        vscode.window.showWarningMessage("qqq: 文档为空，无法导出");
        return;
    }

    activeExportCount++;
    const exportId = createExportSession();

    const formatLabel = selectedFormat === ExportFormat.RTF_DOC ? "RTF" : "DOCX";

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `qqq: 正在导出 ${formatLabel} 文档...`,
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(() => {
            cleanupExportSession(exportId);
        });

        try {
            const processedElements = [];
            let processedCount = 0;

            // ★★★ 统一缓存：PNG buffer + 尺寸 ★★★
            const conversionCache = new Map();

            for (const elem of rawElements) {
                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage("qqq: 导出已取消");
                    return;
                }

                if (elem.type === "text") {
                    processedElements.push(elem);

                } else if (elem.type === "media") {
                    processedCount++;
                    progress.report({
                        message: `转换媒体 ${processedCount}/${mediaCount}: ${path.basename(elem.path)}`,
                        increment: (1 / Math.max(1, mediaCount)) * 80
                    });

                    const fingerprint = qqq.computeFingerprint(elem.path);

                    let pngResult;

                    if (fingerprint && conversionCache.has(fingerprint)) {
                        pngResult = conversionCache.get(fingerprint);
                        qqq.logMessage(`复用缓存: ${path.basename(elem.path)} (指纹: ${fingerprint.substring(0, 8)}...)`, "INFO");
                    } else {
                        const info = await getMediaInfo(elem.path, exportId);
                        pngResult = await convertMediaToPng(elem.path, info, exportId);

                        if (pngResult && fingerprint) {
                            conversionCache.set(fingerprint, pngResult);
                        }
                    }

                    if (pngResult?.buffer) {
                        if (selectedFormat === ExportFormat.RTF_DOC) {
                            processedElements.push({
                                type: "image",
                                rtfPicture: createRtfPicture(pngResult.buffer, pngResult.width, pngResult.height),
                                originalMark: elem.originalMark
                            });
                        } else {
                            processedElements.push({
                                type: "image",
                                imageBuffer: pngResult.buffer,
                                width: pngResult.width,
                                height: pngResult.height,
                                originalMark: elem.originalMark
                            });
                        }
                    } else {
                        processedElements.push({
                            type: "image_error",
                            path: elem.rawPath
                        });
                    }
                }
            }

            if (token.isCancellationRequested) {
                vscode.window.showWarningMessage("qqq: 导出已取消");
                return;
            }

            progress.report({ message: `生成 ${formatLabel} 文档...`, increment: 10 });

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

            progress.report({ message: "保存文件...", increment: 10 });

            const defaultExportPath = path.join(docDir, `${docBaseName}${fileExt}`);
            let finalSavePath = defaultExportPath;

            if (fs.existsSync(defaultExportPath)) {
                const filters = {};
                filters[filterLabel] = [fileExt.substring(1)];

                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(defaultExportPath),
                    filters: filters
                });

                if (!saveUri) {
                    vscode.window.showWarningMessage("qqq: 导出已取消");
                    return;
                }

                finalSavePath = saveUri.fsPath;
            }

            if (selectedFormat === ExportFormat.RTF_DOC) {
                fs.writeFileSync(finalSavePath, fileContent, 'utf8');
            } else {
                fs.writeFileSync(finalSavePath, fileContent);
            }

            const stats = fs.statSync(finalSavePath);
            const fileSizeStr = formatBytes(stats.size);

            const cacheHits = mediaCount - conversionCache.size;
            if (cacheHits > 0) {
                qqq.logMessage(`导出完成: ${mediaCount} 个媒体，${cacheHits} 个复用缓存`, "INFO");
            }

            vscode.window.showInformationMessage(
                `qqq: 文档已导出 (${fileSizeStr}): ${path.basename(finalSavePath)}`,
                "打开文件",
                "打开文件夹"
            ).then(choice => {
                if (choice === "打开文件") {
                    openFile(finalSavePath);
                } else if (choice === "打开文件夹") {
                    revealInFolder(finalSavePath);
                }
            });

        } catch (e) {
            qqq.logMessage(`导出失败: ${e.message}\n${e.stack}`, "ERROR");
            vscode.window.showErrorMessage(`qqq: 导出失败: ${e.message}`);
        } finally {
            cleanupExportSession(exportId);
            activeExportCount--;
        }
    });
}

// ==================== 文件操作辅助 ====================

function openFile(filePath) {
    if (!fs.existsSync(filePath)) return;

    try {
        if (process.platform === "win32") {
            cp.exec(`start "" "${filePath.replace(/"/g, '""')}"`);
        } else if (process.platform === "darwin") {
            cp.exec(`open "${filePath}"`);
        } else {
            cp.exec(`xdg-open "${filePath}"`);
        }
    } catch {
        vscode.env.openExternal(vscode.Uri.file(filePath));
    }
}

function revealInFolder(filePath) {
    if (!fs.existsSync(filePath)) return;

    try {
        if (process.platform === "win32") {
            cp.exec(`explorer /select,"${filePath.replace(/"/g, '""')}"`);
        } else if (process.platform === "darwin") {
            cp.exec(`open -R "${filePath}"`);
        } else {
            cp.exec(`xdg-open "${path.dirname(filePath)}"`);
        }
    } catch { }
}

// ==================== 模块导出 ====================

module.exports = {
    executeExportDocCommand
};

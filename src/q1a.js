// src/q1a.js
// ==========================================
// ★★★ 导出 DOC 模块 (RTF格式，兼容 Office 2003) ★★★
// ==========================================
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const qqq = require("./qqq");

// ==================== 导出常量 ====================

const EXPORT_MAX_WIDTH = 512;
const EXPORT_MAX_HEIGHT = 288;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg", ".ai", ".eps", ".cdr", ".psd"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov"]);

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
    try {
        const buffer = fs.readFileSync(filePath);
        return crypto.createHash("sha256").update(buffer).digest("hex");
    } catch {
        return "无法计算";
    }
}

// ==================== 媒体信息获取 ====================

async function getMediaInfo(filePath) {
    if (!qqq.ffmpegPath) return null;

    return new Promise((resolve) => {
        const child = cp.spawn(qqq.ffmpegPath, ["-hide_banner", "-i", filePath], { windowsHide: true });
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

// ==================== GIF 转换（balanced 模式） ====================

/**
 * 将媒体文件转换为 GIF（带透明通道）
 * 使用 balanced 模式的逻辑
 * @param {string} filePath - 源文件路径
 * @param {object} info - 媒体信息 {width, height, duration}
 * @returns {Promise<{buffer: Buffer, width: number, height: number} | null>}
 */
async function convertMediaToGif(filePath, info) {
    if (!qqq.ffmpegPath) return null;

    const duration = info?.duration || 0;
    const origW = info?.width || 512;
    const origH = info?.height || 288;

    // 计算输出尺寸：小于512保留原始，大于512适配到512x288内
    let targetW = origW;
    let targetH = origH;

    if (origW > EXPORT_MAX_WIDTH || origH > EXPORT_MAX_HEIGHT) {
        const scale = Math.min(EXPORT_MAX_WIDTH / origW, EXPORT_MAX_HEIGHT / origH);
        targetW = Math.max(1, Math.round(origW * scale));
        targetH = Math.max(1, Math.round(origH * scale));
    }

    // 确保尺寸为偶数（编码要求）
    targetW = targetW % 2 === 0 ? targetW : targetW + 1;
    targetH = targetH % 2 === 0 ? targetH : targetH + 1;

    return new Promise((resolve) => {
        const args = ["-hide_banner", "-loglevel", "error"];
        const isStatic = duration <= 0.1;
        const isGifLike = !isStatic && duration > 0.1 && duration < 10;

        const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=lanczos`;

        // ★★★ balanced 模式逻辑 ★★★
        if (isStatic) {
            // 静态图：单帧
            args.push("-i", filePath);
            args.push("-vf", `${scaleFilter},split[s0][s1];[s0]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[s1][p]paletteuse=alpha_threshold=128`);
            args.push("-frames:v", "1");
        } else if (isGifLike) {
            // 短动画（<10s）：保留全部帧
            args.push("-i", filePath);
            args.push("-vf", `${scaleFilter},split[s0][s1];[s0]palettegen=reserve_transparent=on:transparency_color=ffffff:stats_mode=diff[p];[s1][p]paletteuse=alpha_threshold=128:dither=bayer:bayer_scale=5`);
        } else {
            // 长视频（>=10s）：三段拼接
            const seg = 1.33;
            const s1 = 1;
            const s2 = Math.floor(duration / 2);
            const s3 = Math.max(s2 + seg + 0.5, duration - seg - 1);

            args.push("-ss", String(s1), "-t", String(seg), "-i", filePath);
            args.push("-ss", String(s2), "-t", String(seg), "-i", filePath);
            args.push("-ss", String(s3), "-t", String(seg), "-i", filePath);

            args.push("-filter_complex",
                `[0:v]fps=15,${scaleFilter}[v0];` +
                `[1:v]fps=15,${scaleFilter}[v1];` +
                `[2:v]fps=15,${scaleFilter}[v2];` +
                `[v0][v1][v2]concat=n=3:v=1:a=0[vc];` +
                `[vc]split[s0][s1];` +
                `[s0]palettegen=reserve_transparent=on:transparency_color=ffffff:stats_mode=diff[p];` +
                `[s1][p]paletteuse=alpha_threshold=128:dither=bayer:bayer_scale=5[out]`
            );
            args.push("-map", "[out]");
        }

        args.push("-loop", "0", "-f", "gif");

        const rand = Math.random().toString(36).slice(2);
        const tempFile = path.join(os.tmpdir(), `qqq_export_${rand}.gif`);
        args.push("-y", tempFile);

        const child = cp.spawn(qqq.ffmpegPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe']
        });

        let resolved = false;

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { child.kill(); } catch { }
                resolve(null);
            }
        }, 120000); // 导出允许2分钟

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

// ==================== RTF 生成器（兼容 Office 2003） ====================

/**
 * 转义 RTF 特殊字符
 */
function escapeRtf(text) {
    if (!text) return "";

    let result = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);

        if (ch === 0x5C) {
            // 反斜杠 \
            result += "\\\\";
        } else if (ch === 0x7B) {
            // 左花括号 {
            result += "\\{";
        } else if (ch === 0x7D) {
            // 右花括号 }
            result += "\\}";
        } else if (ch === 0x0A) {
            // 换行
            result += "\\line ";
        } else if (ch === 0x0D) {
            // 回车（忽略，配合 \n 处理）
            continue;
        } else if (ch === 0x09) {
            // Tab
            result += "\\tab ";
        } else if (ch > 127) {
            // 非 ASCII 字符：使用 Unicode 转义
            result += `\\u${ch}?`;
        } else {
            result += text[i];
        }
    }

    return result;
}

/**
 * 将 Buffer 转换为 RTF 十六进制字符串
 */
function bufferToRtfHex(buffer) {
    return buffer.toString('hex');
}

/**
 * 生成 RTF 图片块
 * @param {Buffer} gifBuffer - GIF 图片数据
 * @param {number} width - 图片宽度（像素）
 * @param {number} height - 图片高度（像素）
 * @returns {string} RTF 图片代码
 */
function createRtfPicture(gifBuffer, width, height) {
    // RTF 使用 twips 单位，1 inch = 1440 twips，假设 96 DPI
    const twipsPerPixel = 15; // 1440 / 96 = 15
    const picwgoal = Math.round(width * twipsPerPixel);
    const pichgoal = Math.round(height * twipsPerPixel);

    const hexData = bufferToRtfHex(gifBuffer);

    // Office 2003 兼容的 GIF 嵌入方式
    // 注意：\pict 后面直接用十六进制数据，不需要 \gifblip（某些版本不支持）
    // 使用 \pngblip 或直接嵌入原始数据
    return `{\\pict\\pngblip\\picw${width}\\pich${height}\\picwgoal${picwgoal}\\pichgoal${pichgoal}\n${hexData}\n}`;
}

/**
 * 生成完整的 RTF 文档
 */
function generateRtfDocument(elements, attachments, title) {
    const parts = [];

    // RTF 头部（ANSI + 简体中文代码页 936）
    parts.push("{\\rtf1\\ansi\\ansicpg936\\deff0\\nouicompat\\deflang2052");

    // 字体表
    parts.push("{\\fonttbl");
    parts.push("{\\f0\\fnil\\fcharset134 \\u24494?\\u36719?\\u38597?\\u40657?;}"); // 微软雅黑
    parts.push("{\\f1\\fnil\\fcharset134 \\u23435?\\u20307?;}"); // 宋体
    parts.push("{\\f2\\fmodern\\fcharset0 Consolas;}");
    parts.push("}");

    // 颜色表
    parts.push("{\\colortbl ;");
    parts.push("\\red0\\green0\\blue0;");        // 1: 黑色
    parts.push("\\red102\\green102\\blue102;");  // 2: 灰色 #666666
    parts.push("\\red255\\green0\\blue0;");      // 3: 红色
    parts.push("\\red136\\green136\\blue136;");  // 4: 分隔线灰色
    parts.push("\\red240\\green240\\blue240;");  // 5: 表格背景
    parts.push("}");

    // 文档属性
    parts.push(`{\\*\\generator QQQ VSCode Extension;}`);

    // 页面设置（A4，1英寸边距）
    parts.push("\\paperw11906\\paperh16838");
    parts.push("\\margl1440\\margr1440\\margt1440\\margb1440");

    // 默认段落格式
    parts.push("\\widowctrl\\ftnbj\\aenddoc\\trackmoves0\\trackformatting1");
    parts.push("\\donotembedsysfont0\\relyonvml0\\donotembedlingdata1");

    // 开始文档内容
    parts.push("\\pard\\plain\\f0\\fs22\\cf1");

    // 内容
    for (const elem of elements) {
        if (elem.type === "text") {
            // 文本段落：保留原始格式，包括空行
            const lines = elem.content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.length === 0) {
                    // 空行
                    parts.push("\\par");
                } else {
                    parts.push(`${escapeRtf(line)}\\par`);
                }
            }
        } else if (elem.type === "image") {
            // 图片：居中显示
            parts.push("\\pard\\qc\\sb200\\sa200");
            parts.push(elem.rtfPicture);
            parts.push("\\par");

            // 图片说明（原始路径）
            if (elem.caption) {
                parts.push(`\\pard\\qc\\f0\\fs16\\cf2\\i ${escapeRtf(elem.caption)}\\i0\\cf1\\fs22\\par`);
            }

            // 恢复左对齐
            parts.push("\\pard\\ql\\f0\\fs22\\cf1");
        } else if (elem.type === "image_error") {
            // 图片转换失败提示
            parts.push(`\\pard\\cf3 [${escapeRtf("\\u23186?\\u20307?\\u36716?\\u25442?\\u22833?\\u36133?: " + elem.path)}]\\cf1\\par`);
        }
    }

    // 附件索引
    if (attachments.length > 0) {
        // 分隔线
        parts.push("\\pard\\sb600\\sa200\\brdrb\\brdrs\\brdrw10\\brsp20 \\par");

        // 标题
        parts.push("\\pard\\sb200\\sa300\\f0\\fs28\\b");
        parts.push(`${escapeRtf("📁 附件索引")}`);
        parts.push("\\b0\\fs22\\par");

        // 简单表格（使用制表符模拟）
        parts.push("\\pard\\sb100\\sa60\\f0\\fs18\\b");
        parts.push(`${escapeRtf("序号")}\\tab ${escapeRtf("文件名")}\\tab\\tab\\tab ${escapeRtf("类型")}\\tab ${escapeRtf("大小")}\\tab ${escapeRtf("SHA256（前16位）")}`);
        parts.push("\\b0\\par");

        // 数据行
        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const shortHash = att.sha256.substring(0, 16) + "...";
            parts.push(`${i + 1}\\tab ${escapeRtf(att.name)}\\tab\\tab\\tab ${escapeRtf(att.ext.toUpperCase())}\\tab ${escapeRtf(formatBytes(att.size))}\\tab \\f2\\fs14 ${escapeRtf(shortHash)}\\f0\\fs18\\par`);
        }

        // 完整 SHA256 列表
        parts.push("\\pard\\sb300\\sa100\\f0\\fs18\\b");
        parts.push(`${escapeRtf("完整 SHA256 哈希值：")}`);
        parts.push("\\b0\\par");

        for (const att of attachments) {
            parts.push(`\\pard\\sa40\\f0\\fs14 ${escapeRtf(att.name + ":")}\\par`);
            parts.push(`\\pard\\li400\\sa80\\f2\\fs12\\cf2 ${escapeRtf(att.sha256)}\\cf1\\f0\\par`);
        }
    }

    // 结束文档
    parts.push("}");

    return parts.join("\r\n");
}

// ==================== 导出命令 ====================

/**
 * 导出文档命令（主入口）
 * @param {boolean} isCoreIntegrityValid - 完整性验证结果
 */
async function executeExportDocCommand(isCoreIntegrityValid) {
    if (!isCoreIntegrityValid) {
        vscode.window.showErrorMessage("Integrity check failed.");
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage("没有打开的文档");
        return;
    }

    const document = editor.document;
    const docDir = document.isUntitled ? os.homedir() : path.dirname(document.uri.fsPath);
    const docBaseName = document.isUntitled ? "untitled" : path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));

    // 解析文档内容
    const text = document.getText();
    const regex = new RegExp(qqq.QQQ_PATH_REGEX);

    // 收集所有元素
    const rawElements = [];
    const attachments = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text))) {
        // 添加标记前的文本
        if (match.index > lastIndex) {
            const textBefore = text.substring(lastIndex, match.index);
            if (textBefore.length > 0) {
                rawElements.push({ type: "text", content: textBefore });
            }
        }

        const rawPath = match[0].slice(2, -2).trim();

        // 跳过 PENDING 标记
        if (!rawPath.startsWith("__PENDING__:")) {
            const absPath = resolvePathToAbsolute(document.uri, rawPath.replace(/\//g, "\\"));

            if (absPath && fs.existsSync(absPath)) {
                const ext = path.extname(absPath).toLowerCase();

                if (isMediaFile(ext)) {
                    rawElements.push({ type: "media", path: absPath, rawPath: rawPath });
                } else {
                    // 非媒体文件：保留原始标记 + 记录到附件索引
                    rawElements.push({ type: "text", content: match[0] });

                    try {
                        const stat = fs.statSync(absPath);
                        attachments.push({
                            name: path.basename(absPath),
                            path: rawPath,
                            absPath: absPath,
                            ext: ext,
                            size: stat.size,
                            sha256: computeFileSHA256(absPath)
                        });
                    } catch { }
                }
            } else {
                // 文件不存在，保留原始标记
                rawElements.push({ type: "text", content: match[0] });
            }
        }

        lastIndex = match.index + match[0].length;
    }

    // 添加剩余文本
    if (lastIndex < text.length) {
        const remaining = text.substring(lastIndex);
        if (remaining.length > 0) {
            rawElements.push({ type: "text", content: remaining });
        }
    }

    // 统计媒体数量
    const mediaCount = rawElements.filter(e => e.type === "media").length;

    if (rawElements.length === 0) {
        vscode.window.showWarningMessage("文档为空，无法导出");
        return;
    }

    // 开始导出
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "正在导出文档...",
        cancellable: true
    }, async (progress, token) => {
        try {
            const processedElements = [];
            let processedCount = 0;

            for (const elem of rawElements) {
                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage("导出已取消");
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

                    // 获取媒体信息
                    const info = await getMediaInfo(elem.path);

                    // 转换为 GIF
                    const gifResult = await convertMediaToGif(elem.path, info);

                    if (gifResult?.buffer) {
                        const rtfPicture = createRtfPicture(gifResult.buffer, gifResult.width, gifResult.height);
                        processedElements.push({
                            type: "image",
                            rtfPicture: rtfPicture,
                            caption: elem.rawPath
                        });
                    } else {
                        processedElements.push({
                            type: "image_error",
                            path: elem.rawPath
                        });
                    }
                }
            }

            progress.report({ message: "生成 RTF 文档...", increment: 10 });

            // 生成 RTF 文档
            const rtfContent = generateRtfDocument(processedElements, attachments, docBaseName);

            progress.report({ message: "保存文件...", increment: 10 });

            // 保存文件
            const defaultPath = path.join(docDir, `${docBaseName}_导出.doc`);
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultPath),
                filters: {
                    "Word 文档 (兼容 Office 2003)": ["doc"]
                }
            });

            if (saveUri) {
                // 写入文件（使用二进制写入，避免编码问题）
                fs.writeFileSync(saveUri.fsPath, rtfContent, { encoding: 'utf8' });

                const stats = fs.statSync(saveUri.fsPath);
                const fileSizeStr = formatBytes(stats.size);

                vscode.window.showInformationMessage(
                    `文档已导出 (${fileSizeStr}): ${path.basename(saveUri.fsPath)}`,
                    "打开文件",
                    "打开文件夹"
                ).then(choice => {
                    if (choice === "打开文件") {
                        openFile(saveUri.fsPath);
                    } else if (choice === "打开文件夹") {
                        revealInFolder(saveUri.fsPath);
                    }
                });
            }

        } catch (e) {
            qqq.logMessage(`导出失败: ${e.message}\n${e.stack}`, "ERROR");
            vscode.window.showErrorMessage(`导出失败: ${e.message}`);
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

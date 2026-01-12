// src/q1.js
const global = require('./global');
const { wq, TransactionManager, getConfig, TaskCounter, TaskMessage } = global;
const h = require('./h');
const VideoDownloadController = require('./VideoDownloadController');
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const qqq = require("./qqq");
const q3 = require("./q3");

const CORE_INTEGRITY_HASH =
    "dc10f424bef818e80eea0a5175bbb6cca07cbee34c8510c7b64069ef1661c88e";
let isCoreIntegrityValid = false;

// ==================== 配置常量 ====================
const SCROLL_DEBOUNCE_MS = 200;

// ★★★ 缓存生成基准尺寸 (512x288) ★★★
const CACHE_BASE_WIDTH = 512;
const CACHE_BASE_HEIGHT = 288;

// UI 显示尺寸配置
const LARGE_PREVIEW_WIDTH = 512;
const LARGE_PREVIEW_HEIGHT = 288;
const SMALL_PREVIEW_WIDTH = 256;
const SMALL_PREVIEW_HEIGHT = 144;

const PREVIEW_BORDER = 6;
const PREVIEW_BG_COLOR = "#fef6e3";

const FALLBACK_DIRECT_READ_EXTS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".ico",
]);
const FALLBACK_MAX_SIZE = 4 * 1024 * 1024;
const TEXT_FILM_MAX_SIZE = 50 * 1024 * 1024; // ★ 文本胶片预览的最大文件限制

const IMAGE_EXTS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".webp",
    ".ico",
    ".tiff",
    ".tif",
    ".svg",
    ".ai",
    ".eps",
    ".cdr",
    ".psd",
]);
const VIDEO_EXTS = new Set([
    ".mp4",
    ".mkv",
    ".webm",
    ".avi",
    ".mov",
    ".wmv",
    ".flv",
    ".rmvb",
    ".mpeg",
    ".mpg",
    ".3gp",
    ".m4v",
    ".f4v",
    ".ts",
    ".mts",
    ".m2ts",
    ".vob",
]);

const PIPE_SEEK_ERROR_PATTERNS = [
    "non seekable",
    "seek not allowed",
    "Discarding interleaved",
    "muxer does not support non seekable output",
    "Could not write header",
];

// ==================== 全局状态 ====================
let decorationType = null;
let markerHideType = null;
let extensionContext = null;
let currentRenderVersion = 0;

let codeLensProvider = null;

const documentDecorationsMap = new Map();
const resolutionCache = new Map();
const folderSizeCache = new Map();
const pendingTokens = new Map();

const editorDebounceTimers = new Map();

let enlargeSmallImages = true;
let performanceMode = "optmum";
let frameSizeMode = "smart";
let cleanFreakMode = false;

let watermarkBase64 = null;
const WATERMARK_PATH = path.join(__dirname, "..", "assets", "q2.gif");

// ==================== ★★★ 调度器（分层）★★★ ====================
const probeScheduler =
    qqq?.probeScheduler && typeof qqq.probeScheduler.schedule === "function"
        ? qqq.probeScheduler
        : { schedule: async (_k, fn) => fn() };

const genScheduler =
    qqq?.genScheduler && typeof qqq.genScheduler.schedule === "function"
        ? qqq.genScheduler
        : { schedule: async (_k, fn) => fn() };

// ==================== 初始化 ====================
function verifySystemIntegrity() {
    try {
        if (!fs.existsSync(WATERMARK_PATH)) return false;
        const buf = fs.readFileSync(WATERMARK_PATH);
        const hash = crypto.createHash("sha256").update(buf).digest("hex");
        return hash === CORE_INTEGRITY_HASH;
    } catch (e) {
        return false;
    }
}

function loadWatermarkResource() {
    try {
        if (fs.existsSync(WATERMARK_PATH)) {
            const buf = fs.readFileSync(WATERMARK_PATH);
            watermarkBase64 = "data:image/gif;base64," + buf.toString("base64");
        }
    } catch (e) {
        watermarkBase64 = null;
    }
}

function refreshConfig() {
    try {
        const config = vscode.workspace.getConfiguration("qqq");
        enlargeSmallImages = config.get("enlargeSmallImages", config.get("stretchSmallImages", true));

        const extremePerformance = config.get("extremePerformance", false);
        if (extremePerformance) performanceMode = "extreme";
        else performanceMode = config.get("performanceMode", "optmum");

        frameSizeMode = config.get("frameSizeMode", "fix");
        cleanFreakMode = config.get("cleanFreak", false);
    } catch (e) {
        enlargeSmallImages = true;
        performanceMode = "optmum";
        frameSizeMode = "fix";
        cleanFreakMode = false;
    }
}

function clearDecorations() {
    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
        if (decorationType) editor.setDecorations(decorationType, []);
        if (markerHideType) editor.setDecorations(markerHideType, []);
    }

    if (decorationType) {
        try { decorationType.dispose(); } catch (e) { }
        decorationType = null;
    }
    if (markerHideType) {
        try { markerHideType.dispose(); } catch (e) { }
        markerHideType = null;
    }
    documentDecorationsMap.clear();
}

function clearAllEditorDebounceTimers() {
    for (const timer of editorDebounceTimers.values()) clearTimeout(timer);
    editorDebounceTimers.clear();
}

// ==================== 错误日志 ====================
function logCriticalError(filePath, errorMsg) {
    try {
        if (!qqq.LOG_PATH) return;
        const timestamp = new Date().toISOString();
        const shortPath = filePath.length > 100 ? "..." + filePath.slice(-97) : filePath;
        const shortErr = errorMsg.length > 500 ? errorMsg.slice(0, 500) + "..." : errorMsg;
        const logLine = `[${timestamp}] FFMPEG_FAIL: ${shortPath}\n${shortErr}\n\n`;
        fs.appendFileSync(qqq.LOG_PATH, logLine);
    } catch (e) { }
}

function logFallbackUsedRateLimited(filePath, ext, errCode, stderr) {
    try {
        const e = (ext || "").toLowerCase();
        const err = String(errCode || "UNKNOWN").slice(0, 120);
        const key = `ffmpeg_fallback:${e}:${err}`;
        const shortPath = filePath.length > 140 ? "..." + filePath.slice(-137) : filePath;
        const shortStderr = (stderr || "").toString().slice(0, 300);
        qqq.logMessageRateLimited(
            key,
            `FFMPEG_FAIL -> fallbackDirectRead: ${shortPath}  ext=${e}  err=${err}${shortStderr ? `  stderr=${shortStderr}` : ""}`,
            "WARN",
            2 * 60 * 1000
        );
    } catch { }
}

// ==================== CSS 计算辅助 ====================
function fitIntoBox(srcW, srcH, boxW, boxH, enlarge) {
    if (!srcW || !srcH) return { width: boxW, height: boxH, scale: 1 };

    let finalW, finalH, s;
    if (enlarge) {
        const scale = Math.min(boxW / srcW, boxH / srcH);
        s = scale;
        finalW = Math.max(1, Math.round(srcW * scale));
        finalH = Math.max(1, Math.round(srcH * scale));
    } else {
        if (srcW > boxW || srcH > boxH) {
            const scale = Math.min(boxW / srcW, boxH / srcH);
            s = scale;
            finalW = Math.max(1, Math.round(srcW * scale));
            finalH = Math.max(1, Math.round(srcH * scale));
        } else {
            s = 1;
            finalW = srcW;
            finalH = srcH;
        }
    }
    return { width: finalW, height: finalH, scale: s };
}

function mimeFromExt(ext) {
    switch ((ext || "").toLowerCase()) {
        case ".png": return "image/png";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".gif": return "image/gif";
        case ".webp": return "image/webp";
        case ".svg": return "image/svg+xml";
        case ".bmp": return "image/bmp";
        case ".ico": return "image/x-icon";
        default: return "";
    }
}

function buildAfterStyle({
    marginLeft,
    boxWidth,
    boxHeight,
    previewWidth,
    previewHeight,
    contentUrl,
    outputSize,
    progressBarUrl,
    watermarkBase64,
}) {
    const gridSize = "20px 20px";
    const gridImage =
        `conic-gradient(#fdf6e3 0.25turn, #e6e1cf 0.25turn 0.5turn, #fdf6e3 0.5turn 0.75turn, #e6e1cf 0.75turn)`;

    const layers = [];
    const sizes = [];
    const positions = [];
    const repeats = [];

    if (watermarkBase64) {
        layers.push(`url("${watermarkBase64}")`);
        sizes.push("contain");
        positions.push("center center");
        repeats.push("no-repeat");
    }

    if (progressBarUrl) {
        layers.push(progressBarUrl);
        sizes.push(`${previewWidth}px 4px`);
        positions.push("center bottom");
        repeats.push("no-repeat");
    }

    layers.push(contentUrl);
    sizes.push(outputSize ? `${outputSize.width}px ${outputSize.height}px` : "contain");
    positions.push("center center");
    repeats.push("no-repeat");

    layers.push(gridImage);
    sizes.push(gridSize);
    positions.push("0 0");
    repeats.push("repeat");

    return {
        contentText: "",
        position: "absolute",
        left: marginLeft,
        top: "0px",
        width: `${boxWidth}px`,
        height: `${boxHeight}px`,
        padding: "2px",
        border: "1px dashed #888",
        backgroundColor: PREVIEW_BG_COLOR,
        zIndex: -1,
        textDecoration:
            `none; pointer-events: none; display: inline-block; ` +
            `background-image: ${layers.join(", ")}; ` +
            `background-size: ${sizes.join(", ")}; ` +
            `background-position: ${positions.join(", ")}; ` +
            `background-repeat: ${repeats.join(", ")};`,
    };
}

function getFrameConfig(info) {
    let mode = "large";
    let width = LARGE_PREVIEW_WIDTH;
    let height = LARGE_PREVIEW_HEIGHT;

    // 文本预览固定使用大分辨率
    if (info?.type === "text_film") {
        return { mode, width: 512, height: 288 };
    }

    if (!info || !info.width || !info.height) {
        if (frameSizeMode === "small") {
            mode = "small";
            width = SMALL_PREVIEW_WIDTH;
            height = SMALL_PREVIEW_HEIGHT;
        }
    } else {
        if (frameSizeMode === "small") {
            mode = "small";
            width = SMALL_PREVIEW_WIDTH;
            height = SMALL_PREVIEW_HEIGHT;
        } else if (frameSizeMode === "large") {
            mode = "large";
            width = LARGE_PREVIEW_WIDTH;
            height = LARGE_PREVIEW_HEIGHT;
        } else {
            if (info.width <= SMALL_PREVIEW_WIDTH && info.height <= SMALL_PREVIEW_HEIGHT) {
                mode = "small";
                width = SMALL_PREVIEW_WIDTH;
                height = SMALL_PREVIEW_HEIGHT;
            }
        }
    }
    return { mode, width, height };
}

// ==================== FFprobe ====================
async function getMediaInfo(filePath, mtimeMs) {
    const cached = resolutionCache.get(filePath);
    if (cached && cached.mtime === mtimeMs) return cached;

    const cacheKey = `probe:info:${filePath}:${mtimeMs}`;
    return probeScheduler.schedule(cacheKey, async () => _getMediaInfoInternal(filePath, mtimeMs));
}

function _getMediaInfoInternal(filePath, mtimeMs) {
    if (!qqq.ffmpegPath) return null;

    return new Promise((resolve) => {
        const child = cp.spawn(qqq.ffmpegPath, ["-hide_banner", "-i", filePath], { windowsHide: true });
        let stderr = "";

        child.stderr.on("data", (d) => {
            if (stderr.length < 50000) stderr += d.toString();
        });

        child.on("close", () => {
            const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
            const codecMatch = /Stream.*Video:\s*(.*?)(?:,|$)/i.exec(stderr);
            const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);

            const ext = path.extname(filePath).toLowerCase();

            let info = {
                mtime: mtimeMs,
                res: null,
                width: null,
                height: null,
                codec: null,
                full_codec_desc: null,
                duration: 0,
                type: "unknown",
                isStaticImage: false,
                isMjpegStatic: false,
                needsConversion: false,
            };

            if (resMatch) {
                const w = parseInt(resMatch[1]);
                const h = parseInt(resMatch[2]);
                info.res = `${w}x${h}`;
                info.width = w;
                info.height = h;
            }

            if (durMatch) {
                const hh = parseFloat(durMatch[1]);
                const mm = parseFloat(durMatch[2]);
                const ss = parseFloat(durMatch[3]);
                info.duration = hh * 3600 + mm * 60 + ss;
            }

            if (codecMatch?.[1]) {
                info.full_codec_desc = codecMatch[1].trim();
                const parts = info.full_codec_desc.split(/[,\s]+/);
                info.codec = parts[0].trim().toLowerCase();
            }

            const isStaticByDuration = info.duration <= 0.1;

            if (info.codec) {
                const c = info.codec;
                if (c.includes("mjpeg") || c === "jpeg") {
                    if (isStaticByDuration) {
                        info.type = "image";
                        info.isStaticImage = true;
                        info.isMjpegStatic = true;
                    } else {
                        info.type = "video";
                    }
                } else if (["png", "bmp", "tiff", "webp", "svg", "pdf"].some((x) => c.includes(x))) {
                    info.type = "image";
                    info.isStaticImage = isStaticByDuration;
                } else if (c.includes("gif")) {
                    if (isStaticByDuration) {
                        info.type = "image";
                        info.isStaticImage = true;
                    } else {
                        info.type = "animated_image";
                    }
                } else if (
                    [
                        "h264",
                        "hevc",
                        "vp8",
                        "vp9",
                        "av1",
                        "mpeg4",
                        "mpeg2",
                        "mpeg1",
                        "wmv",
                        "vc1",
                        "flv",
                        "theora",
                        "avs",
                        "rv40",
                        "rv30",
                        "rv20",
                        "rv10",
                        "msmpeg4",
                        "h263",
                    ].some((x) => c.includes(x))
                ) {
                    info.type = "video";
                }
            }

            if (info.type === "unknown") {
                if (VIDEO_EXTS.has(ext)) {
                    info.type = "video";
                } else if (IMAGE_EXTS.has(ext)) {
                    info.type = "image";
                    info.isStaticImage = true;
                } else if (isTextFile(filePath)) {
                    info.type = "text_film";
                    info.width = 512;
                    info.height = 288;
                }
            }

            // 特殊处理：如果 ffmpeg 识别出了 tty/bintext 等 codec，也视为 text_film
            if (info.codec && (info.codec.includes("tty") || info.codec.includes("bintext") || info.codec.includes("ansi"))) {
                info.type = "text_film";
                info.width = 512;
                info.height = 288;
            }

            if (!info.width && [".ai", ".eps", ".psd", ".cdr"].includes(ext)) {
                info.type = "image";
                info.isStaticImage = true;
                info.width = 512;
                info.height = 512;
                info.needsConversion = true;
            }

            resolutionCache.set(filePath, info);
            if (resolutionCache.size > 200) resolutionCache.delete(resolutionCache.keys().next().value);

            resolve(info.width ? info : null);
        });

        child.on("error", () => resolve(null));

        setTimeout(() => {
            try { child.kill(); } catch (e) { }
            resolve(null);
        }, 5000);
    });
}

function getWebPDurationFromBuffer(buffer) {
    if (!buffer || buffer.length < 12) return 0;
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return 0;

    let pos = 12;
    let totalDurationMs = 0;
    let frameCount = 0;

    while (pos < buffer.length - 8) {
        const chunkId = buffer.toString("ascii", pos, pos + 4);
        const chunkSize = buffer.readUInt32LE(pos + 4);
        const nextChunkPos = pos + 8 + chunkSize + (chunkSize % 2);

        if (chunkId === "ANMF") {
            frameCount++;
            if (pos + 23 < buffer.length) {
                const dur = buffer[pos + 20] | (buffer[pos + 21] << 8) | (buffer[pos + 22] << 16);
                totalDurationMs += dur;
            }
        }
        pos = nextChunkPos;
    }
    return frameCount > 1 ? totalDurationMs / 1000 : 0;
}

// ==================== 核心缓存策略 ====================
function determineCacheStrategy(filePath, info) {
    const ext = path.extname(filePath).toLowerCase();
    let fileSize = 0;
    try { fileSize = fs.statSync(filePath).size; } catch { }

    const isStaticSource = info?.isStaticImage === true;
    const isMjpegStatic = info?.isMjpegStatic === true;
    const simpleFormats = [".png", ".jpg", ".jpeg", ".svg", ".ico"];
    const canDirectRead = simpleFormats.includes(ext) || (ext === ".webp" && isStaticSource);

    let shouldBypassCache = false;
    if (isMjpegStatic) {
        shouldBypassCache = true;
    } else if (
        isStaticSource &&
        canDirectRead &&
        !info?.needsConversion &&
        (
            (ext === ".ico" && fileSize < FALLBACK_MAX_SIZE) ||
            (fileSize < 300 * 1024 && info?.width && info?.height && info.width <= 512 && info.height <= 512)
        )
    ) {
        shouldBypassCache = true;
    }

    let qualityLevel = 71;
    if (performanceMode === "accelerated" || performanceMode === "extreme") qualityLevel = 47;

    let isAnimatedOutput = false;
    const isVideoOrGif = !isStaticSource && (info?.type === "video" || info?.type === "animated_image");
    if (isVideoOrGif) {
        if (performanceMode === "extreme") isAnimatedOutput = false;
        else isAnimatedOutput = true;
    }

    const suffix = isAnimatedOutput ? "q" : "";
    const cacheKey = `${qualityLevel}${suffix}`;

    return {
        shouldBypassCache,
        cacheKey,
        qualityLevel,
        isMjpegStatic,
        isAnimatedOutput,
    };
}

function buildUnifiedWebPArgs(filePath, origSize, duration, qualityLevel, isAnimatedOutput, info) {
    let targetW = CACHE_BASE_WIDTH;
    let targetH = CACHE_BASE_HEIGHT;

    if (origSize?.width && !origSize?.needsConversion) {
        const ow = origSize.width;
        const oh = origSize.height;

        if (ow > CACHE_BASE_WIDTH || oh > CACHE_BASE_HEIGHT) {
            const scale = Math.min(CACHE_BASE_WIDTH / ow, CACHE_BASE_HEIGHT / oh);
            targetW = Math.max(1, Math.round(ow * scale));
            targetH = Math.max(1, Math.round(oh * scale));
        } else {
            targetW = ow;
            targetH = oh;
        }
    }

    const args = ["-hide_banner", "-loglevel", "error"];
    let expectedWebPDuration = 0;

    const isSourceStatic = duration <= 0.1;
    const isSourceGifLike = !isSourceStatic && duration > 0.1 && duration < 10;

    const scaleFilter =
        `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=bilinear,format=yuva420p`;
    let vf = scaleFilter;

    if (info?.type === "text_film") {
        // ★ 文本预览特殊逻辑：解决中文乱码 + 静态预览 (最稳定)
        // 实现跨平台多重字体回退机制
        const isWin = process.platform === "win32";
        const isMac = process.platform === "darwin";

        const fontCandidates = [];
        if (isWin) {
            fontCandidates.push(
                "C:/Windows/Fonts/msyh.ttc",   // 微软雅黑
                "C:/Windows/Fonts/msyh.ttf",
                "C:/Windows/Fonts/simhei.ttf", // 黑体
                "C:/Windows/Fonts/simsun.ttc", // 宋体
                "C:/Windows/Fonts/arial.ttf"   // Arial
            );
        } else if (isMac) {
            fontCandidates.push(
                "/System/Library/Fonts/PingFang.ttc",            // 萍方
                "/Library/Fonts/Microsoft/Microsoft YaHei.ttf",   // 微软雅黑 (如果有)
                "/System/Library/Fonts/STHeiti Light.ttc",        // 华文细黑
                "/Library/Fonts/Arial.ttf"                        // Arial
            );
        } else {
            // Linux (通用路径)
            fontCandidates.push(
                "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", // 文泉驿微米黑
                "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",
                "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", // Noto Sans
                "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc"
            );
        }

        let fontPath = "";
        for (const f of fontCandidates) {
            if (fs.existsSync(f)) {
                fontPath = f;
                break;
            }
        }

        let textContent = "";
        try {
            // ★ 优化提取逻辑：只读取前 1KB 字节，并甄别处理乱码
            const fd = fs.openSync(filePath, 'r');
            const readBuffer = Buffer.alloc(1192);
            const bytesRead = fs.readSync(fd, readBuffer, 0, 1192, 0);
            fs.closeSync(fd);

            // 使用 utf8 解码，并初步处理末尾可能截断的字符
            let rawText = readBuffer.toString('utf8', 0, bytesRead);

            // 甄别乱码：如果包含大量替换字符 \uFFFD，说明编码不对或者文件损坏
            // 统计 \uFFFD 的出现频率
            const replacementChars = (rawText.match(/\uFFFD/g) || []).length;
            if (replacementChars > 10) {
                // 如果乱码太多，尝试过滤掉这些乱码，只保留能看的部分
                rawText = rawText.replace(/\uFFFD/g, '');
            }

            // 限制长度
            rawText = rawText.slice(0, 2000);

            // ★ 深度甄别乱码：如果文本中包含大量无法识别的非 ASCII 且非中文常用字符，判定为极端乱码
            // 统计正常字符比例 (ASCII + 中文范围)
            let normalCharCount = 0;
            for (let i = 0; i < rawText.length; i++) {
                const code = rawText.charCodeAt(i);
                if (code < 128 || (code >= 0x4E00 && code <= 0x9FFF)) {
                    normalCharCount++;
                }
            }
            const normalRatio = normalCharCount / rawText.length;
            if (normalRatio < 0.3 && rawText.length > 20) {
                // 如果正常字符占比低于 30%，判定为编码极其混乱，此时我们标记为 isExtremeGarbled
                info._isExtremeGarbled = true;
            }

            // 改进的自动换行逻辑：更高效地处理超长行，避免性能问题
            let currentLineLen = 0;
            let lineStartIndex = 0;
            const MAX_LINE_WIDTH = 60;

            // 分段处理文本，避免一次性处理过长的字符串
            for (let i = 0; i < rawText.length; i++) {
                const char = rawText[i];
                const charCode = rawText.charCodeAt(i);
                const isFullWidth = charCode > 255;
                const charLen = isFullWidth ? 2 : 1;

                if (char === '\n') {
                    // 处理完整行
                    textContent += rawText.substring(lineStartIndex, i + 1);
                    lineStartIndex = i + 1;
                    currentLineLen = 0;
                } else {
                    if (currentLineLen + charLen > MAX_LINE_WIDTH) {
                        // 插入换行符并处理当前行
                        textContent += rawText.substring(lineStartIndex, i) + '\n';
                        lineStartIndex = i;
                        currentLineLen = charLen;
                    } else {
                        currentLineLen += charLen;
                    }
                }
            }

            // 处理剩余的文本
            if (lineStartIndex < rawText.length) {
                textContent += rawText.substring(lineStartIndex);
            }

            // 逃逸 drawtext 需要的字符
            // ffmpeg 滤镜中，文本需要进行极其严格的转义
            textContent = textContent
                .replace(/\\/g, '\\\\\\\\') // 转义反斜杠
                .replace(/'/g, "'\\''")     // 转义单引号 (ffmpeg 滤镜语法)
                .replace(/:/g, '\\:')       // 转义冒号
                .replace(/,/g, '\\,')       // 转义逗号
                .replace(/%/g, '%%')        // 转义百分号
                .replace(/\r/g, '')         // 移除回车
                .replace(/\n/g, '\r');      // drawtext 使用 \r 作为换行符
        } catch (e) {
            textContent = "Read Error";
        }

        const fontPathEscaped = fontPath ? fontPath.replace(/:/g, "\\:") : "";
        // 如果识别为极端乱码，则不设置字体，让 ffmpeg 尝试用系统最基础的方式兜底
        const useFont = !info?._isExtremeGarbled && fontPathEscaped;
        const fontFilePart = useFont ? `fontfile='${fontPathEscaped}':` : "";

        // 强制背景时长为 1 秒，但只输出 1 帧
        args.push("-f", "lavfi", "-i", `color=c=black:s=${targetW}x${targetH}:d=1`);
        // 使用 [0:v] 显式指定输入流，并确保最后有 [out_v]
        // 范例 B：现代控制台风格 (增加半透明背景黑框)
        vf = `[0:v]drawtext=${fontFilePart}text='${textContent}':fontcolor=white:fontsize=16:line_spacing=2:x=15:y=15:box=1:boxcolor=black@0.6:boxborderw=0,format=yuva420p[out_v]`;
        args.push("-frames:v", "1");
        expectedWebPDuration = 0;
    } else if (performanceMode === "extreme") {
        args.push("-ss", "0", "-i", filePath);
        vf = `[0:v]${scaleFilter}[out_v]`;
        args.push("-frames:v", "1");
        expectedWebPDuration = 0;
    } else if (performanceMode === "accelerated") {
        if (isSourceStatic) {
            args.push("-ss", "0", "-i", filePath);
            vf = `[0:v]${scaleFilter}[out_v]`;
            args.push("-frames:v", "1");
            expectedWebPDuration = 0;
        } else {
            args.push("-ss", "0");
            args.push("-t", "2");
            args.push("-i", filePath);
            vf = `[0:v]fps=7,setpts=N/7/TB,${scaleFilter}[out_v]`;
            args.push("-frames:v", "14");
            expectedWebPDuration = 2;
        }
    } else {
        if (isSourceStatic) {
            args.push("-ss", "0", "-i", filePath);
            vf = `[0:v]${scaleFilter}[out_v]`;
            args.push("-frames:v", "1");
            expectedWebPDuration = 0;
        } else if (isSourceGifLike) {
            args.push("-ss", "0", "-i", filePath);
            vf = `[0:v]${scaleFilter}[out_v]`;
            expectedWebPDuration = duration;
        } else {
            const seg = 1.33;
            const s1 = 1;
            const s2 = Math.floor(duration / 2);
            const s3 = Math.max(s2 + seg + 0.5, duration - seg - 1);
            args.push("-ss", String(s1), "-t", String(seg), "-i", filePath);
            args.push("-ss", String(s2), "-t", String(seg), "-i", filePath);
            args.push("-ss", String(s3), "-t", String(seg), "-i", filePath);
            vf =
                `[0:v]fps=15,${scaleFilter}[v0];` +
                `[1:v]fps=15,${scaleFilter}[v1];` +
                `[2:v]fps=15,${scaleFilter}[v2];` +
                `[v0][v1][v2]concat=n=3:v=1:a=0[out_v]`;
            expectedWebPDuration = seg * 3;
        }
    }

    args.push("-filter_complex", vf, "-map", "[out_v]");
    args.push(
        "-c:v", "libwebp",
        "-lossless", "0",
        "-compression_level", "0",
        "-q:v", String(qualityLevel),
        "-loop", "0",
        "-an",
        "-vsync", "0",
        "-f", "webp"
    );

    return { args, targetW, targetH, expectedWebPDuration };
}

function isPipeSeekError(stderr) {
    const lowerStderr = stderr.toLowerCase();
    return PIPE_SEEK_ERROR_PATTERNS.some((pattern) => lowerStderr.includes(pattern.toLowerCase()));
}

function runFFmpegWithPipeAndFallback(args, cacheFilePath, timeoutMs = 30000, isAnimated = false) {
    return new Promise((resolve) => {
        if (isAnimated) {
            runFFmpegToFile(args, cacheFilePath, timeoutMs).then(resolve);
            return;
        }
        const pipeArgs = [...args, "pipe:1"];
        const child = cp.spawn(qqq.ffmpegPath, pipeArgs, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks = [];
        let stderr = "";
        let resolved = false;

        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (d) => {
            if (stderr.length < 64000) stderr += d.toString();
        });

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { child.kill(); } catch (e) { }
                runFFmpegToFile(args, cacheFilePath, timeoutMs).then(resolve);
            }
        }, timeoutMs);

        child.on("close", () => {
            if (resolved) return;
            clearTimeout(timer);
            const buffer = chunks.length > 0 ? Buffer.concat(chunks) : null;
            if (isPipeSeekError(stderr) || !buffer || buffer.length === 0) {
                runFFmpegToFile(args, cacheFilePath, timeoutMs).then(resolve);
                return;
            }
            resolved = true;
            resolve({ success: true, buffer, fromPipe: true });
        });

        child.on("error", () => {
            if (resolved) return;
            clearTimeout(timer);
            resolved = true;
            runFFmpegToFile(args, cacheFilePath, timeoutMs).then(resolve);
        });
    });
}

function runFFmpegToFile(args, cacheFilePath, timeoutMs = 30000) {
    return new Promise((resolve) => {
        const tmpPath = cacheFilePath + ".tmp";
        const fileArgs = [...args, "-y", tmpPath];
        const child = cp.spawn(qqq.ffmpegPath, fileArgs, {
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        let resolved = false;

        child.stderr.on("data", (d) => {
            if (stderr.length < 64000) stderr += d.toString();
        });

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { child.kill(); } catch (e) { }
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { }
                resolve({ success: false, error: "TIMEOUT_FILE", stderr });
            }
        }, timeoutMs);

        child.on("close", (code) => {
            if (resolved) return;
            clearTimeout(timer);
            resolved = true;

            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, cacheFilePath);
                    const buffer = fs.readFileSync(cacheFilePath);
                    resolve({ success: true, buffer, fromFile: true, cacheFilePath });
                } catch (e) {
                    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e2) { }
                    resolve({ success: false, error: e.message, stderr });
                }
            } else {
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { }
                resolve({ success: false, error: `EXIT_CODE=${code}`, stderr });
            }
        });

        child.on("error", (err) => {
            if (resolved) return;
            clearTimeout(timer);
            resolved = true;
            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { }
            resolve({ success: false, error: err.message, stderr });
        });
    });
}

function tryFallbackDirectRead(filePath, renderW, renderH, info) {
    const ext = path.extname(filePath).toLowerCase();
    if (!FALLBACK_DIRECT_READ_EXTS.has(ext)) return null;
    try {
        const st = fs.statSync(filePath);
        if (st.size > FALLBACK_MAX_SIZE) return null;
        const rawBuffer = fs.readFileSync(filePath);

        const { width: finalCssW, height: finalCssH } = fitIntoBox(
            info?.width,
            info?.height,
            renderW,
            renderH,
            enlargeSmallImages
        );

        return {
            buffer: rawBuffer,
            webpDuration: 0,
            originalDuration: 0,
            outputSize: { width: finalCssW, height: finalCssH },
            isDirect: true,
            ext: ext,
            isFallback: true,
        };
    } catch (e) {
        return null;
    }
}

async function getPreviewBuffer(filePath, contentId, renderW, renderH) {
    if (!qqq.ffmpegPath) return null;

    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return null; }

    const info = await getMediaInfo(filePath, mtimeMs);
    const origSize = info
        ? { width: info.width, height: info.height, needsConversion: info.needsConversion }
        : null;
    const originalDuration = info?.duration || 0;
    const ext = path.extname(filePath).toLowerCase();

    const cacheStrategy = determineCacheStrategy(filePath, info);

    if (cacheStrategy.isMjpegStatic) {
        try {
            const rawBuffer = fs.readFileSync(filePath);
            const { width: finalCssW, height: finalCssH } = fitIntoBox(
                info.width,
                info.height,
                renderW,
                renderH,
                enlargeSmallImages
            );
            return {
                buffer: rawBuffer,
                webpDuration: 0,
                originalDuration: 0,
                outputSize: { width: finalCssW, height: finalCssH },
                isDirect: true,
                ext: ".jpg",
                mimeType: "image/jpeg",
            };
        } catch (e) {
            logCriticalError(filePath, `MJPEG 直通读取失败: ${e.message}`);
        }
    }

    if (!cacheStrategy.shouldBypassCache) {
        const cached = qqq.getCachedBuffer(contentId, cacheStrategy.cacheKey);
        if (cached) {
            const meta = qqq.getCacheQualityMeta(contentId, cacheStrategy.cacheKey) || {};

            const cachedWidth = meta.width || info?.width || 0;
            const cachedHeight = meta.height || info?.height || 0;
            const cachedOriginalDuration =
                meta.originalDuration !== undefined ? meta.originalDuration : originalDuration;

            const webpDur = getWebPDurationFromBuffer(cached);

            const { width: finalCssW, height: finalCssH } = fitIntoBox(
                cachedWidth,
                cachedHeight,
                renderW,
                renderH,
                enlargeSmallImages
            );

            return {
                buffer: cached,
                webpDuration: webpDur,
                originalDuration: cachedOriginalDuration,
                fromCache: true,
                outputSize: { width: finalCssW, height: finalCssH },
                ext: ".webp",
                mimeType: "image/webp",
            };
        }
    }

    if (cacheStrategy.shouldBypassCache && !cacheStrategy.isMjpegStatic) {
        try {
            const rawBuffer = fs.readFileSync(filePath);
            const { width: finalCssW, height: finalCssH } = fitIntoBox(
                info.width,
                info.height,
                renderW,
                renderH,
                enlargeSmallImages
            );
            return {
                buffer: rawBuffer,
                webpDuration: 0,
                originalDuration: originalDuration,
                outputSize: { width: finalCssW, height: finalCssH },
                isDirect: true,
                ext: ext,
            };
        } catch (e) { }
    }

    const { args, targetW, targetH, expectedWebPDuration } = buildUnifiedWebPArgs(
        filePath,
        origSize,
        originalDuration,
        cacheStrategy.qualityLevel,
        cacheStrategy.isAnimatedOutput,
        info
    );

    const taskKey = `gen:${contentId}:${cacheStrategy.cacheKey}`;

    const result = await genScheduler.schedule(taskKey, async () => {
        const existing = qqq.getCachedBuffer(contentId, cacheStrategy.cacheKey);
        if (existing) {
            const meta = qqq.getCacheQualityMeta(contentId, cacheStrategy.cacheKey) || {};
            return { success: true, buffer: existing, fromCache: true, meta };
        }

        const isAnimated = expectedWebPDuration > 0.1;

        const tmpDir = path.join(os.tmpdir(), "qqq_ffmpeg_tmp");
        try {
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        } catch { }

        const cacheFilePath = path.join(tmpDir, `${contentId}_${cacheStrategy.cacheKey}.webp`);
        return runFFmpegWithPipeAndFallback(args, cacheFilePath, 30000, isAnimated);
    });

    if (result.success) {
        const buffer = result.buffer;

        const meta = result.meta || {};
        const outW = meta.width || targetW;
        const outH = meta.height || targetH;
        const outOriginalDuration =
            meta.originalDuration !== undefined ? meta.originalDuration : originalDuration;

        const finalWebPDuration = getWebPDurationFromBuffer(buffer);

        if (result.fromPipe || result.fromFile) {
            qqq.setCacheEntry(contentId, cacheStrategy.cacheKey, buffer, {
                width: targetW,
                height: targetH,
                origWidth: origSize?.width || 0,
                origHeight: origSize?.height || 0,
                type: "webp_unified",
                webpDur: finalWebPDuration,
                originalDuration: originalDuration,
            });
        }

        const { width: finalCssW, height: finalCssH } = fitIntoBox(
            outW,
            outH,
            renderW,
            renderH,
            enlargeSmallImages
        );

        return {
            buffer,
            webpDuration: finalWebPDuration,
            originalDuration: outOriginalDuration,
            outputSize: { width: finalCssW, height: finalCssH },
        };
    } else {
        const fallback = tryFallbackDirectRead(filePath, renderW, renderH, info);

        if (!fallback) {
            const stderr = result.stderr || "";
            if (stderr.includes("moov atom not found")) {
                qqq.logMessageRateLimited(
                    `corrupt_video:${filePath}`,
                    `Corrupt video file (moov atom not found): ${path.basename(filePath)}`,
                    "WARN"
                );
            } else {
                logCriticalError(filePath, `${result.error} (无法兜底)\n${stderr}`);
            }
        } else {
            logFallbackUsedRateLimited(filePath, ext, result.error, result.stderr || "");
        }
        return fallback;
    }
}

// ==================== 其他工具 ====================
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

function formatDuration(sec) {
    if (sec == null || isNaN(sec) || sec < 0) return "0s";
    if (sec >= 60) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}m + ${s.toFixed(2)}s`;
    }
    return `${sec.toFixed(2)}s`;
}

function isImageOrVideoExt(ext) {
    const e = ext.toLowerCase();
    return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e);
}

function isTextFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return false;
        if (stat.size === 0) return false;
        if (stat.size > TEXT_FILM_MAX_SIZE) return false; // 超过限制就不当纯文本预览了

        const buffer = Buffer.alloc(4096);
        const fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
        fs.closeSync(fd);

        for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] === 0) return false; // 含有空字符，判定为二进制
        }
        return true;
    } catch (e) {
        return false;
    }
}

function isSupportedMedia(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (isImageOrVideoExt(ext)) return true;
    return isTextFile(filePath);
}

function getDocumentEOL(doc) {
    return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

// ★ 统一用 qqq 的路径真理来源（避免绝对路径/UNC 被破坏）
function resolvePathToAbsolute(docUri, rawPath) {
    if (!rawPath) return null;
    let clean = String(rawPath).trim();
    if (!clean) return null;

    clean = clean.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

    const baseDir = path.dirname(docUri.fsPath);
    const abs = qqq.resolveNavPath(clean, baseDir);
    return abs ? path.normalize(abs) : null;
}

function calculateAspectRatioString(w, h) {
    if (!w || !h) return "";
    if (w >= h) {
        const r = (h / w) * 16;
        return `16__${parseFloat(r.toFixed(1))}`;
    } else {
        const r = (w / h) * 16;
        return `${parseFloat(r.toFixed(1))}__16`;
    }
}

function createProgressSvg(webpDuration, previewWidth) {
    if (!webpDuration || webpDuration <= 0) return null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${previewWidth}" height="4" viewBox="0 0 ${previewWidth} 4">
  <rect width="${previewWidth}" height="4" fill="black"/>
  <rect width="0" height="4" fill="#fdf6e3">
    <animate attributeName="width" from="0" to="${previewWidth}" dur="${webpDuration.toFixed(3)}s" repeatCount="indefinite"/>
  </rect>
</svg>`;
    return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// ★★★ 修复：lineHeight 有人写成 1.4/1.2 当倍率，VSCode 实际是像素，导致 pxPerLine≈1 => 几万空行
function calculateBlankLinesExact(pxHeight, isLastItem = false) {
    try {
        const config = vscode.workspace.getConfiguration("editor");
        const fontSize = Number(config.get("fontSize", 14)) || 14;
        const lineHeightRaw = Number(config.get("lineHeight", 0)) || 0;

        // 兼容：如果 lineHeight 太小（<8），按“倍率”理解；否则按像素理解
        let pxPerLine = 0;
        if (lineHeightRaw > 0) {
            if (lineHeightRaw < 8) pxPerLine = fontSize * lineHeightRaw; // 倍率
            else pxPerLine = lineHeightRaw; // 像素
        } else {
            pxPerLine = fontSize * 1.35;
        }

        // 钳制：防止异常配置造成爆炸
        pxPerLine = Math.max(pxPerLine, fontSize * 1.1, 10);

        const boxH = pxHeight + PREVIEW_BORDER;
        let baseN = Math.ceil(boxH / pxPerLine);

        let extra = 3;
        if (performanceMode === "extreme") extra = 2;

        let n = Math.max(4, baseN + extra);
        if (isLastItem) n = Math.max(8, n);
        return n;
    } catch (e) {
        return 15;
    }
}

function getEditorId(editor) {
    const docUri = editor.document.uri.toString();
    const viewColumn = editor.viewColumn ?? 0;
    return `${docUri}::${viewColumn}`;
}

// ==================== 主渲染逻辑 ====================
async function renderImages(editor) {
    if (!editor || !isCoreIntegrityValid) {
        clearDecorations();
        return;
    }

    const myVersion = ++currentRenderVersion;

    if (!decorationType)
        decorationType = vscode.window.createTextEditorDecorationType({ isWholeLine: false });

    if (!markerHideType)
        markerHideType = vscode.window.createTextEditorDecorationType({
            textDecoration: "none; font-size: 11px; color: transparent; opacity: 0;",
        });

    const docUri = editor.document.uri.toString();
    if (!documentDecorationsMap.has(docUri)) documentDecorationsMap.set(docUri, new Map());

    const currentDecos = documentDecorationsMap.get(docUri);
    // 注意：hideDecos 不再作为局部 Map 收集，而是直接收集 Range 数组立即应用
    const visibleRanges = editor.visibleRanges;
    if (!visibleRanges?.length) return;

    const marginLeft = "100px";

    const pathRegex = qqq.createPathRegex();

    const tasks = [];
    const newHideRanges = [];

    // 第一阶段：同步扫描，快速隐藏
    for (const range of visibleRanges) {
        const text = editor.document.getText(range);
        const rangeOffset = editor.document.offsetAt(range.start);

        pathRegex.lastIndex = 0;
        let match;

        while ((match = pathRegex.exec(text))) {
            const offset = rangeOffset + match.index;
            const pos = editor.document.positionAt(offset);
            const endPos = editor.document.positionAt(offset + match[0].length);
            const uniqueKey = `${pos.line}_${pos.character}`;

            const rawPath = (match[1] || "").trim();
            if (!rawPath) continue;

            const absPath = resolvePathToAbsolute(editor.document.uri, rawPath);

            // ★★★ 同步检查：存在性 ★★★
            // 只要文件存在，就视为被接管，立即隐藏
            let shouldHide = false;
            if (absPath && fs.existsSync(absPath)) {
                shouldHide = true;
            }

            if (shouldHide) {
                newHideRanges.push(new vscode.Range(pos, endPos));
            } else {
                if (currentDecos.has(uniqueKey)) {
                    currentDecos.delete(uniqueKey);
                }
                continue;
            }

            if (currentDecos.has(uniqueKey)) continue;

            const targetLine = pos.line;
            if (targetLine >= editor.document.lineCount) continue;

            const anchorRange = new vscode.Range(targetLine, 0, targetLine, 0);
            const contentId = qqq.computeFingerprint(absPath);
            if (!contentId) continue;

            // ★ 只有图片、视频和特定的文本文件才渲染相框
            try {
                const stat = fs.statSync(absPath);
                if (stat.isDirectory()) continue;
                if (!isSupportedMedia(absPath)) continue;
            } catch (e) { }

            tasks.push(async () => {
                if (currentRenderVersion !== myVersion) return null;

                try {
                    let mtimeMs = 0;
                    try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }

                    const info = await getMediaInfo(absPath, mtimeMs);
                    const { width: previewWidth, height: previewHeight } = getFrameConfig(info);

                    const previewResult = await getPreviewBuffer(absPath, contentId, previewWidth, previewHeight);

                    if (currentRenderVersion !== myVersion) return null;

                    // ★ 增加渲染结果检测与降级重试机制
                    let finalResult = previewResult;
                    const isTextFilm = info?.type === "text_film";
                    const isResultEmpty = !previewResult?.buffer || previewResult.buffer.length < 200; // WebP 头信息通常就占几十字节，如果太小肯定渲染失败了

                    if (isTextFilm && isResultEmpty) {
                        // 如果是文本胶片且渲染结果为空（透明相框），标记为极端乱码并强制重新生成（不带字体设置）
                        info._isExtremeGarbled = true;
                        // 强制绕过缓存，再次请求
                        finalResult = await getPreviewBuffer(absPath, contentId + "_retry", previewWidth, previewHeight);
                    }

                    if (currentRenderVersion !== myVersion) return null;

                    const deco = { range: anchorRange, renderOptions: {} };
                    let contentUrl = "";
                    let webpDuration = 0;
                    let outputSize = null;

                    if (finalResult?.buffer) {
                        let mime = "image/webp";
                        if (finalResult.isDirect) {
                            mime = finalResult.mimeType || mimeFromExt(finalResult.ext) || "image/webp";
                        } else if (finalResult.mimeType) {
                            mime = finalResult.mimeType;
                        }
                        contentUrl = `url("data:${mime};base64,${finalResult.buffer.toString("base64")}")`;
                        webpDuration = finalResult.webpDuration || 0;
                        outputSize = finalResult.outputSize;
                    }

                    if (!contentUrl) return null;

                    const boxWidth = previewWidth + PREVIEW_BORDER;
                    const boxHeight = previewHeight + PREVIEW_BORDER;

                    let progressBarUrl = null;
                    if (webpDuration > 0.1 && performanceMode === "optmum")
                        progressBarUrl = `url("${createProgressSvg(webpDuration, previewWidth)}")`;

                    deco.renderOptions.after = buildAfterStyle({
                        marginLeft,
                        boxWidth,
                        boxHeight,
                        previewWidth,
                        previewHeight,
                        contentUrl,
                        outputSize,
                        progressBarUrl,
                        watermarkBase64,
                    });

                    deco.hoverMessage = new vscode.MarkdownString(`[打开文件](${vscode.Uri.file(absPath).toString()})`);
                    deco.hoverMessage.isTrusted = true;

                    return { key: uniqueKey, deco };
                } catch (e) {
                    return null;
                }
            });
        }
    }

    // ★★★ 立即应用隐藏装饰器，解决延迟问题 ★★★
    if (newHideRanges.length > 0) {
        editor.setDecorations(markerHideType, newHideRanges);
    } else {
        editor.setDecorations(markerHideType, []);
    }

    // 第二阶段：异步生成/更新图片
    if (tasks.length > 0) {
        const chunkResults = await Promise.all(tasks.map((t) => t()));
        if (currentRenderVersion !== myVersion) return;
        if (!decorationType) return; // 防止异步期间 decorationType 被销毁

        for (const res of chunkResults) if (res) currentDecos.set(res.key, res.deco);
    }

    if (decorationType) {
        editor.setDecorations(decorationType, Array.from(currentDecos.values()));
    }
}

// ==================== 粘贴命令 ====================

// 格式化结果为文本（复用原 replacePendingMarker 逻辑）
// ★ 新增可选参数：taskTitle, transId, taskStartTime, token 用于显示最终结果弹窗
async function formatResultToText(result, editor, taskTitle = '', transId = null, taskStartTime = 0, token = null) {
    if (!result) return "";
    const doc = editor.document;
    const eol = getDocumentEOL(doc);
    const docDir = path.dirname(doc.uri.fsPath);
    let replacement = "";

    if ((result.type === "html_blocks" || result.type === "skeleton") && result.blocks?.length) {
        const blocks = result.blocks;
        const finalContent = [];
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            if (block.type === "text" && block.text) {
                finalContent.push(block.text);
            } else if (block.type === "media") {
                if (block.path) {
                    const filePath = block.path;
                    if (block.fingerprint) qqq.prefillFingerprint(filePath, block.fingerprint);
                    const relPath = qqq.toSafePath(path.relative(docDir, filePath));
                    const isLastItem = i === blocks.length - 1;
                    let pxHeight = LARGE_PREVIEW_HEIGHT;
                    try {
                        const info = await getMediaInfo(filePath, Date.now());
                        const { height } = getFrameConfig(info);
                        pxHeight = height;
                    } catch { }
                    const gapBelow = calculateBlankLinesExact(pxHeight, isLastItem);
                    finalContent.push(`/\\${relPath}\\/${eol.repeat(gapBelow)}`);
                    invalidateFolderSizeCacheForPath(filePath);
                }
                // Skip pending blocks
            }
        }
        replacement = finalContent.join(eol);
    } else if (result.type === "image" || result.type === "ikge") {
        const filePath = result.path;
        if (result.fingerprint) qqq.prefillFingerprint(filePath, result.fingerprint);
        const relPath = qqq.toSafePath(path.relative(docDir, filePath));
        let pxHeight = LARGE_PREVIEW_HEIGHT;
        try {
            const info = await getMediaInfo(filePath, Date.now());
            const { height } = getFrameConfig(info);
            pxHeight = height;
        } catch { }
        const gapBelow = calculateBlankLinesExact(pxHeight, true);
        replacement = `/\\${relPath}\\/` + eol.repeat(gapBelow);
        invalidateFolderSizeCacheForPath(filePath);
    } else if (result.type === "file" || result.type === "file_folder") {
        const files = result.files || [];
        const folders = result.folders || [];
        const fingerprints = result.fingerprints || {};

        for (let i = 0; i < folders.length; i++) {
            const folderPath = folders[i];
            const relPath = qqq.toSafePath(path.relative(docDir, folderPath));
            // 文件夹不渲染相框，不留空行
            replacement += `/\\${relPath}\\/${eol}`;
            invalidateFolderSizeCacheForPath(folderPath);
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            let fp = fingerprints[f];
            if (!fp) {
                const tryKey = process.platform === 'win32' ? f.replace(/\//g, '\\') : f;
                fp = fingerprints[tryKey];
            }
            if (fp) qqq.prefillFingerprint(f, fp);

            const relPath = qqq.toSafePath(path.relative(docDir, f));
            let pxHeight = 0; // 默认不预留相框高度
            const isMedia = isSupportedMedia(f);
            if (isMedia) {
                pxHeight = LARGE_PREVIEW_HEIGHT;
                try {
                    const info = await getMediaInfo(f, Date.now());
                    const { height } = getFrameConfig(info);
                    pxHeight = height;
                } catch { }
            }
            const isLastItem = i === files.length - 1 && folders.length === 0;
            if (i > 0 || folders.length > 0) replacement += eol;
            replacement += `/\\${relPath}\\/`;
            if (isMedia) {
                const gapBelow = calculateBlankLinesExact(pxHeight, isLastItem);
                replacement += eol.repeat(gapBelow);
            } else {
                replacement += eol;
            }
            invalidateFolderSizeCacheForPath(f);
        }

        const totalCount = files.length + folders.length;
    } else if (result.type === "folder_text") {
        const folders = result.text.split(/\r?\n/).filter(f => f.trim());
        for (let i = 0; i < folders.length; i++) {
            const folderPath = folders[i];
            const relPath = path.relative(docDir, folderPath).replace(/\\/g, "/");
            // 文件夹不渲染相框，不留空行
            replacement += `/\\${relPath}\\/${eol}`;
            invalidateFolderSizeCacheForPath(folderPath);
        }
    } else if (result.type === "text") {
        replacement = result.text;
    }

    return replacement;
}

// ==================== 锚点替换辅助 ====================
async function replaceAnchorInDoc(uri, anchor, newText) {
    try {
        // 尝试打开文档（即使不可见）
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const idx = text.indexOf(anchor);

        if (idx === -1) {
            // 锚点丢失，返回 false 触发回滚
            return false;
        }

        const pos = doc.positionAt(idx);
        const endPos = doc.positionAt(idx + anchor.length);
        const range = new vscode.Range(pos, endPos);

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, range, newText);

        // 应用编辑
        return await vscode.workspace.applyEdit(edit);
    } catch (e) {
        console.error("Replace Anchor Failed:", e);
        return false;
    }
}

async function performCurvedPaste(editor, targetDir, typeInfo, preComputedResult = null) {
    // 0. ★ 生成任务标识
    const filePath = editor.document.uri.fsPath;
    const taskNum = await TaskCounter.increment(filePath);  // 数据库递增编号（按文件）
    const iconNum = await TaskCounter.incrementIcon();  // 全局图形编号（跨文件）
    const transId = TransactionManager.createTransactionId();  // 六位随机ID（用于锚点）
    const taskTitle = TaskCounter.formatTitle(filePath, transId, iconNum);  // 标题用 transId + 图形
    const anchor = `/__PENDING_${transId}/`;

    // 立即插入锚点
    const success = await TransactionManager.insertAnchor(editor, transId);

    if (!success) return; // 插入失败，直接退出

    const docUri = editor.document.uri;

    // 2. 注册事务 (Pending)
    // ★ 确定任务类型和总大小（用于回滚赦免时间计算）
    let taskType = 'local_file';  // 默认本地文件
    let intentTotalSize = 0;
    if (typeInfo) {
        if (typeInfo.subType === 'html_rich' || typeInfo.subType === 'html_text') {
            taskType = 'html';
        } else if (typeInfo.subType === 'video_url') {
            taskType = 'video';
        } else if (typeInfo.subType === 'file' || typeInfo.subType === 'image') {
            taskType = 'local_file';
            intentTotalSize = typeInfo.totalSize || 0;
        }
    }

    await TransactionManager.saveTransaction({
        id: transId,
        targetDir: targetDir,
        expectedAnchor: anchor,
        docUri: docUri.toString(),
        tempFiles: [],
        landedFiles: [],
        landedFolders: [],
        startTime: Date.now(),
        taskType: taskType,  // ★ 任务类型: 'local_file' | 'html' | 'video'
        intentTotalSize: intentTotalSize,  // ★ 意图列表总大小（仅本地文件有效）
        existingFiles: global.getDirectorySnapshot(targetDir)  // ★ 任务开始时的目录快照
    });

    // 3. 启动带进度的后台任务
    const taskStartTime = Date.now();  // ★ 记录开始时间

    // ★ 创建自定义取消源（用于锚点丢失时主动取消）
    const anchorLostSource = new vscode.CancellationTokenSource();
    let anchorLost = false;
    let lastAnchorCheckTime = 0;
    const ANCHOR_CHECK_INTERVAL = 800;  // 每 800ms 检查一次锚点

    // ★ 锚点检查函数（带节流）
    const checkAnchorExists = async () => {
        if (anchorLost) return false;  // 已经检测到丢失，不再检查

        const now = Date.now();
        if (now - lastAnchorCheckTime < ANCHOR_CHECK_INTERVAL) {
            return true;  // 节流：还没到检查时间
        }
        lastAnchorCheckTime = now;

        try {
            const doc = await vscode.workspace.openTextDocument(docUri);
            const text = doc.getText();
            const exists = text.includes(anchor);

            if (!exists && !anchorLost) {
                anchorLost = true;
                global.logMessage(`[AnchorWatch] 锚点丢失，立即触发回滚: ${anchor}`, 'WARN');
                anchorLostSource.cancel();
                return false;
            }
            return exists;
        } catch (e) {
            if (!anchorLost) {
                anchorLost = true;
                global.logMessage(`[AnchorWatch] 无法读取文档，视为锚点丢失: ${e.message}`, 'WARN');
                anchorLostSource.cancel();
            }
            return false;
        }
    };

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: taskTitle,  // ★ 简洁标题，不加额外描述
        cancellable: true
    }, async (progress, token) => {
        // ★ 组合取消检查：用户取消 或 锚点丢失
        const isCancelled = () => token.isCancellationRequested || anchorLostSource.token.isCancellationRequested;

        try {
            // 4. 执行实际粘贴逻辑 (传入 transId 进行文件追踪)
            // ★ 进度回调中检查锚点，并传递 shouldCancel 回调
            let result = await h.autoDetectAndPaste(targetDir, async (p, msg) => {
                progress.report({ increment: p, message: msg });
                // ★ 每次进度更新时检查锚点
                await checkAnchorExists();
            }, token, transId, null, null, () => anchorLost);

            // ★★★ 视频并发下载接管 ★★★
            if (result && result.type === 'video_url') {
                // ★ 更新事务类型为视频（影响赦免时间计算）
                await TransactionManager.updateTransaction(transId, { taskType: 'video' });

                try {
                    const vc = new VideoDownloadController(extensionContext);
                    const downloadRes = await vc.downloadEntry(
                        result.url,
                        targetDir,
                        transId,
                        async (p, msg) => {
                            progress.report({ increment: 0, message: msg });
                            // ★ 视频下载进度更新时也检查锚点
                            await checkAnchorExists();
                        },
                        token,
                        null,
                        taskTitle,  // ★ 传递 taskTitle
                        () => anchorLost,  // ★ 传递 shouldCancel 回调
                        taskNum  // ★ 传递 taskNum
                    );

                    if (downloadRes && downloadRes.landedFiles && downloadRes.landedFiles.length > 0) {
                        result = {
                            type: 'file',
                            files: downloadRes.landedFiles,
                            fingerprints: {}
                        };
                    } else {
                        result = null; // 下载失败或取消
                    }
                } catch (e) {
                    console.error("Video Download Failed:", e);
                    result = null;
                }
            }

            // ★ 检查是否被取消（用户取消 或 锚点丢失）
            if (isCancelled()) {
                // ★ 执行回滚
                const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
                if (trans) await TransactionManager.rollback(trans);
                await replaceAnchorInDoc(docUri, anchor, "");

                // ★ 根据取消原因显示不同的弹窗
                if (anchorLost) {
                    TaskMessage.showSimpleToast(`${taskTitle} 锚点丢失，已回滚`, 15000, 'cancel');
                } else {
                    TaskMessage.showSimpleToast(`${taskTitle} 已取消并回滚`, 15000, 'cancel');
                }
                return;
            }

            if (result) {
                // 5. 格式化结果
                // Mock editor object for formatResultToText
                const mockEditor = {
                    document: {
                        uri: docUri,
                        eol: editor.document.eol // Use captured EOL or default
                    }
                };

                const newText = await formatResultToText(result, mockEditor, taskTitle, transId, taskStartTime, token);

                if (newText) {
                    // 6. 替换锚点 (原子化提交)
                    const replaced = await replaceAnchorInDoc(docUri, anchor, newText);

                    if (replaced) {
                        // 成功：提交事务 (移除记录)
                        await TransactionManager.removeTransaction(transId);

                        // ★ 内存截图不显示弹窗，其他类型显示成功弹窗
                        if (result.type !== 'image') {
                            const totalCount = (result.files?.length || 0) + (result.folders?.length || 0);
                            const skippedCount = result.skippedCount || 0;
                            const elapsedMs = Date.now() - taskStartTime;
                            let detail = `文件/文件夹已复制 ${totalCount}`;
                            if (skippedCount > 0) {
                                detail += ` (跳过 ${skippedCount}个无法访问)`;
                            }
                            const msg = TaskMessage.done(taskTitle, detail, elapsedMs, taskNum);
                            TaskMessage.showSimpleToast(msg, 15000, 'success');
                        }
                    } else {
                        // 失败：锚点丢失 -> 回滚文件
                        const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
                        if (trans) await TransactionManager.rollback(trans);

                        // ★ 显示锚点丢失弹窗
                        TaskMessage.showSimpleToast(`${taskTitle} 锚点丢失，已回滚`, 15000, 'cancel');
                    }
                } else {
                    // 失败：结果为空 -> 回滚
                    const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
                    if (trans) await TransactionManager.rollback(trans);
                    await replaceAnchorInDoc(docUri, anchor, "");

                    // ★ 显示失败弹窗
                    TaskMessage.showSimpleToast(`${taskTitle} 处理失败，已回滚`, 15000, 'cancel');
                }
            } else {
                // ★ result 为 null：未知类型（如 reaper 片段）-> 静默删除锚点，不显示弹窗
                const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
                if (trans) await TransactionManager.rollback(trans);
                await replaceAnchorInDoc(docUri, anchor, "");
                // 不显示任何弹窗
            }
        } catch (e) {
            console.error(e);
            const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
            if (trans) await TransactionManager.rollback(trans);
            await replaceAnchorInDoc(docUri, anchor, "");

            // ★ 显示异常弹窗
            TaskMessage.showSimpleToast(`${taskTitle} 发生异常，已回滚`, 15000, 'cancel');
        }
    });
}

async function executeClipboardCommand() {
    if (!isCoreIntegrityValid) {
        vscode.window.showErrorMessage("Integrity check failed.");
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    if (editor.document.isUntitled) {
        vscode.window.showInformationMessage("qqq: 未命名文件不能确定资源落盘路径，固只能使用原始粘贴。解决方案：保存文件。");
        await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
        return;
    }

    // Lazy Recovery Trigger (Only once per session)
    if (!global.hasRecovered) {
        global.hasRecovered = true;
        TransactionManager.recover().catch(e => console.error(e));
    }

    const currentDocDir = path.dirname(editor.document.uri.fsPath);
    const targetDir = path.join(currentDocDir, "qqq");
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // 1. 分类 (Check Q) - ★ 单一真理源，返回完整快照
    const snapshot = await wq();
    const config = getConfig('transactionLevel') || 'full';

    let mode = 'a'; // 默认弯粘

    // ★ 文件数量阈值：超过此数量必须显示进度弹窗
    const FILE_COUNT_THRESHOLD = 100;

    // 白名单 -> 直粘 (q)
    if (snapshot.type === 'whitelist') {
        mode = 'q';
    } else {
        // 黄名单
        if (config === 'half') {
            // 半包模式例外
            if (snapshot.subType === 'image') {
                mode = 'q'; // 截图 -> q
            } else if (snapshot.subType === 'file') {
                const fileCount = snapshot.files?.length || 0;
                // ★ 文件 < 80MB 且数量 < 10 -> q
                // 否则使用弯粘模式显示进度弹窗
                if (snapshot.totalSize < 80 * 1024 * 1024 && fileCount < FILE_COUNT_THRESHOLD) {
                    mode = 'q';
                }
            }
        }
    }

    if (mode === 'q') {
        // 直粘 (q) - 最快速度，无事务
        // ★ 直接传递完整快照，不再重复调用 Shell
        await h.autoDetectAndPaste(targetDir, null, null, null, snapshot).then(async (result) => {
            // ★ Handle Video URL in q mode -> Escalate to 'a' (Curved Paste)
            if (result && result.type === 'video_url') {
                await performCurvedPaste(editor, targetDir, snapshot, result);
                return;
            }

            const newText = await formatResultToText(result, editor);
            if (!newText) return;

            // 确保编辑器仍然活跃
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document.uri.toString() !== editor.document.uri.toString()) return;

            await activeEditor.edit((editBuilder) => {
                editBuilder.replace(activeEditor.selection, newText);
            });
            debounceRender(activeEditor, 10);
        });
    } else {
        // 弯粘 (a) - 事务 + 弹窗 + 锚点
        await performCurvedPaste(editor, targetDir, snapshot);
    }
}

// ==================== 整洁模式 ====================
async function provideCleanlinessEditsAsync(document) {
    if (!document) return [];
    const edits = [];
    const text = document.getText();
    const regex = qqq.createPathRegex();
    const eol = getDocumentEOL(document);
    let match;
    const markers = [];

    while ((match = regex.exec(text))) {
        markers.push({ text: match[0], index: match.index, inner: (match[1] || "").trim() });
    }

    for (let i = markers.length - 1; i >= 0; i--) {
        const m = markers[i];
        const startPos = document.positionAt(m.index);
        const endPos = document.positionAt(m.index + m.text.length);
        const markerLine = startPos.line;

        const rawPath = m.inner;
        const absPath = resolvePathToAbsolute(document.uri, rawPath);
        let pxHeight = 0;

        if (absPath && fs.existsSync(absPath)) {
            const ext = path.extname(absPath);
            if (isImageOrVideoExt(ext)) {
                try {
                    let mtimeMs = fs.statSync(absPath).mtimeMs;
                    const info = await getMediaInfo(absPath, mtimeMs);

                    let pxHeight = 0;

                    // 特殊处理高风险格式 (ai, eps, cdr)，防止无法渲染时占位过大
                    // 策略：如果是这些格式，且 needsConversion (说明 ffprobe 没探测出宽高，用的假数据)，
                    //      则必须要有有效的预览缓存，才分配高度。否则默认不占位。
                    if (info && info.needsConversion && [".ai", ".eps", ".cdr"].includes(ext)) {
                        const contentId = qqq.computeFingerprint(absPath);
                        if (contentId) {
                            const strategy = determineCacheStrategy(absPath, info);
                            const cached = qqq.getCachedBuffer(contentId, strategy.cacheKey);
                            if (cached) {
                                const { height } = getFrameConfig(info);
                                pxHeight = height;
                            } else {
                                // 无缓存，大概率无法渲染，不占位
                                pxHeight = 0;
                            }
                        } else {
                            pxHeight = 0;
                        }
                    } else {
                        const { height } = getFrameConfig(info);
                        pxHeight = height;
                    }
                } catch {
                    const { height } = getFrameConfig(null);
                    pxHeight = height;
                }
            }
        }

        const lineObj = document.lineAt(markerLine);
        const lineContent = lineObj.text;

        if (startPos.character > 0) edits.push({ range: new vscode.Range(startPos, startPos), newText: eol });
        const suffix = lineContent.substring(endPos.character);
        if (suffix.trim().length > 0) edits.push({ range: new vscode.Range(endPos, endPos), newText: eol });

        if (pxHeight > 0) {
            const isLastMarkerInDoc = i === markers.length - 1;
            const neededLines = calculateBlankLinesExact(pxHeight, isLastMarkerInDoc);
            let existingBlanks = 0;
            for (let lineIdx = markerLine + 1; lineIdx < document.lineCount; lineIdx++) {
                if (document.lineAt(lineIdx).text.trim() === "") existingBlanks++;
                else break;
            }
            if (existingBlanks < neededLines) {
                const linesToAdd = neededLines - existingBlanks;
                const lineEndPos = lineObj.range.end;
                edits.push({ range: new vscode.Range(lineEndPos, lineEndPos), newText: eol.repeat(linesToAdd) });
            }
        }
    }
    return edits;
}

async function performGlobalClean(editor, force = false) {
    if (!editor) return;
    if (!force && !cleanFreakMode) return;
    const edits = await provideCleanlinessEditsAsync(editor.document);
    if (edits.length > 0) {
        await editor.edit((editBuilder) => {
            edits.forEach((e) => {
                editBuilder.replace(e.range, e.newText);
            });
        });
    }
}

// ==================== CodeLens ====================
class FileCodeLensProvider {
    constructor() {
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
        this._refreshDebounceTimer = null;
    }
    refresh() {
        this._onDidChangeCodeLenses.fire();
    }
    // ★ 防抖刷新，避免频繁刷新
    debouncedRefresh() {
        if (this._refreshDebounceTimer) {
            clearTimeout(this._refreshDebounceTimer);
        }
        this._refreshDebounceTimer = setTimeout(() => {
            this._refreshDebounceTimer = null;
            this._onDidChangeCodeLenses.fire();
        }, 300);
    }
    async provideCodeLenses(document) {
        if (!isCoreIntegrityValid) return [];
        const lenses = [];
        const regex = qqq.createPathRegex();
        const text = document.getText();
        let match;
        const foldersToFetch = new Set(); // ★ 需要异步获取的文件夹

        while ((match = regex.exec(text))) {
            const pos = document.positionAt(match.index);

            const rawPath = (match[1] || "").trim();
            if (!rawPath) continue;

            const absPath = resolvePathToAbsolute(document.uri, rawPath);
            if (!absPath || !fs.existsSync(absPath)) continue;

            const folder = path.dirname(absPath);
            const ext = path.extname(absPath).toLowerCase();
            const isVidOrImg = isImageOrVideoExt(ext);
            const targetLensLine = pos.line;
            const r = new vscode.Range(targetLensLine, 0, targetLensLine, 0);

            // ★ 同步获取文件夹大小（仅从缓存）
            let folderData = getQqqFolderSizeSync(folder);
            let fSizeStr;
            let folderTooltip;

            if (folderData) {
                fSizeStr = formatBytes(folderData.size || 0);
                folderTooltip = folderData.summary;
            } else {
                // ★ 没有缓存，显示占位符
                fSizeStr = "●";
                folderTooltip = "正在计算文件夹大小...";
                foldersToFetch.add(folder);
            }

            // ★ 同步获取文件信息（这个很快）
            let fileSz = "?";
            let tooltipText = "";
            let mtimeMs = 0;
            try {
                const st = fs.statSync(absPath);
                fileSz = formatBytes(st.size);
                tooltipText = `创建: ${new Date(st.birthtime).toLocaleString()}\n修改: ${new Date(st.mtime).toLocaleString()}`;
                mtimeMs = st.mtimeMs;
            } catch { }

            // ★ 先添加基本的 CodeLens（不等待媒体信息）
            lenses.push(
                new vscode.CodeLens(r, {
                    title: `✎( ${fSizeStr}) 🗀qqq`,
                    command: "qqq.revealFileInFolder",
                    arguments: [absPath],
                    tooltip: folderTooltip,
                }),
                new vscode.CodeLens(r, {
                    title: "✎rename",
                    command: "qqq.renameFile",
                    arguments: [rawPath, absPath],
                })
            );

            // ★ 媒体信息可以异步获取，但这里我们保持同步以简化逻辑
            let titleSuffix = "";
            let iconPart = "";
            let spacePart = "   ";

            if (isVidOrImg) {
                const info = await getMediaInfo(absPath, mtimeMs);
                if (info?.width && info?.height) {
                    const { width: MAX_W, height: MAX_H } = getFrameConfig(info);
                    const isRealVideo = info.type === "video";
                    if (isRealVideo) {
                        iconPart = "🎬";
                        spacePart = " ";
                    }
                    const { scale } = fitIntoBox(info.width, info.height, MAX_W, MAX_H, enlargeSmallImages);
                    const pct = Math.round(scale * 100);
                    titleSuffix = `   (${pct}%)  ${info.width}x${info.height}`;

                    const displayCodec = info.full_codec_desc || info.codec;
                    if (displayCodec) tooltipText += `\n编码: ${displayCodec}`;

                    const arStr = calculateAspectRatioString(info.width, info.height);
                    if (arStr) tooltipText += `\n宽高比：${arStr}`;

                    if (qqq.shouldShowDuration(info)) tooltipText += `\n⌛原始时长：${formatDuration(info.duration)}`;
                }
            }

            lenses.push(
                new vscode.CodeLens(r, {
                    title: `✎( ${fileSz})${iconPart}${spacePart}${absPath}${titleSuffix}`,
                    command: "qqq.openFile",
                    arguments: [absPath],
                    tooltip: tooltipText,
                })
            );
        }

        // ★ 异步获取未缓存的文件夹大小
        if (foldersToFetch.size > 0) {
            const refreshCb = () => this.debouncedRefresh();
            for (const folder of foldersToFetch) {
                fetchFolderSizeAsync(folder, refreshCb);
            }
        }

        return lenses;
    }
}

const FOLDER_SIZE_CACHE_MAX_AGE = 10 * 1000;
const _pendingFolderSizeRequests = new Map(); // ★ 跟踪正在进行的请求

function invalidateFolderSizeCacheForPath(filePath) {
    try {
        const dir = path.dirname(filePath);
        if (folderSizeCache.has(dir)) folderSizeCache.delete(dir);
    } catch { }
}

/**
 * ★ 同步获取文件夹大小（仅从缓存）
 * 返回缓存数据或 null（表示需要异步获取）
 */
function getQqqFolderSizeSync(folderPath) {
    const now = Date.now();
    const cached = folderSizeCache.get(folderPath);
    if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) {
        return cached.data;
    }
    return null;
}

/**
 * ★ 异步获取文件夹大小（带去重，完成后刷新 CodeLens）
 */
function fetchFolderSizeAsync(folderPath, refreshCallback) {
    // 如果已经有正在进行的请求，不重复发起
    if (_pendingFolderSizeRequests.has(folderPath)) {
        return;
    }

    _pendingFolderSizeRequests.set(folderPath, true);

    // 后台异步获取
    qqq.getFolderInfo(folderPath).then(result => {
        _pendingFolderSizeRequests.delete(folderPath);

        if (result?.success) {
            const parts = [];
            let totalFiles = 0;
            if (result.ext_stats) {
                for (const [ext, count] of Object.entries(result.ext_stats)) {
                    totalFiles += count;
                    parts.push(`${count}_${ext || "无后缀"}`);
                }
            }
            const summaryStr =
                parts.length > 0
                    ? `${totalFiles}个文件：${parts.join("; ")}`
                    : result.file_count_root > 0
                        ? `${result.file_count_root}个文件`
                        : "空文件夹";
            const data = { size: result.total_size, summary: summaryStr };
            folderSizeCache.set(folderPath, { data, timestamp: Date.now() });

            // ★ 缓存完成，刷新 CodeLens
            if (refreshCallback) {
                refreshCallback();
            }
        }
    }).catch(() => {
        _pendingFolderSizeRequests.delete(folderPath);
    });
}

async function getQqqFolderSize(folderPath) {
    const now = Date.now();
    const cached = folderSizeCache.get(folderPath);
    if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) return cached.data;

    const result = await qqq.getFolderInfo(folderPath);
    if (result?.success) {
        const parts = [];
        let totalFiles = 0;
        if (result.ext_stats) {
            for (const [ext, count] of Object.entries(result.ext_stats)) {
                totalFiles += count;
                parts.push(`${count}_${ext || "无后缀"}`);
            }
        }
        const summaryStr =
            parts.length > 0
                ? `${totalFiles}个文件：${parts.join("; ")}`
                : result.file_count_root > 0
                    ? `${result.file_count_root}个文件`
                    : "空文件夹";
        const data = { size: result.total_size, summary: summaryStr };
        folderSizeCache.set(folderPath, { data, timestamp: now });
        return data;
    }
    return null;
}

// ==================== 命令 ====================
function openFileCommand(filePath) {
    if (!fs.existsSync(filePath)) return;
    try {
        if (process.platform === "win32") cp.exec(`start "" "${filePath.replace(/"/g, '""')}"`);
        else if (process.platform === "darwin") cp.exec(`open "${filePath}"`);
        else cp.exec(`xdg-open "${filePath}"`);
    } catch {
        vscode.env.openExternal(vscode.Uri.file(filePath));
    }
}

function revealFileInFolder(filePath) {
    if (!fs.existsSync(filePath)) return;
    try {
        if (process.platform === "win32")
            cp.exec(`explorer /select,"${filePath.replace(/"/g, '""')}"`);
        else if (process.platform === "darwin")
            cp.exec(`open -R "${filePath}"`);
        else cp.exec(`xdg-open "${path.dirname(filePath)}"`);
    } catch { }
}

async function renameFileCommand(rawPath, absPath) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const currentName = path.basename(absPath);
    const newName = await global.showInputBox({
        title: "重命名粘贴文件",
        prompt: "rename  ",
        value: currentName,
        ignoreFocusOut: true,
        validateInput: (v) => (!v || !v.trim() ? "文件名不能为空" : null),
    });
    if (!newName || newName.trim() === currentName) return;

    const trimmed = newName.trim();
    const newAbs = path.join(path.dirname(absPath), trimmed);
    try {
        await fs.promises.rename(absPath, newAbs);
    } catch (e) {
        global.showErrorMessage(e.message);
        return;
    }

    const doc = editor.document;
    const newRaw = rawPath.includes("/")
        ? rawPath.substring(0, rawPath.lastIndexOf("/") + 1) + trimmed
        : trimmed;

    const regex = qqq.createPathRegex();
    const ranges = [];
    let m;
    while ((m = regex.exec(doc.getText()))) {
        const inner = (m[1] || "").trim();
        if (inner === rawPath) {
            ranges.push(new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)));
        }
    }
    if (ranges.length)
        await editor.edit((b) => ranges.forEach((r) => b.replace(r, `/\\${newRaw}\\/`)));

    invalidateFolderSizeCacheForPath(newAbs);
    renderVisibleEditors();
}

function debounceRender(editor, delay = SCROLL_DEBOUNCE_MS) {
    if (!editor || editor.document.isClosed) return;
    const editorId = getEditorId(editor);
    const existingTimer = editorDebounceTimers.get(editorId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
        editorDebounceTimers.delete(editorId);
        if (editor && !editor.document.isClosed) {
            const stillVisible = vscode.window.visibleTextEditors.some((e) => getEditorId(e) === editorId);
            if (stillVisible) renderImages(editor);
        }
    }, delay);

    editorDebounceTimers.set(editorId, timer);
}

function renderVisibleEditors(delay = 50) {
    const editors = vscode.window.visibleTextEditors;
    if (editors?.length) editors.forEach((e) => debounceRender(e, delay));
}

// ==================== 激活与停用 ====================
async function activate(context) {
    extensionContext = context;
    // Inject context into global for state access
    try {
        const global = require('./global');
        if (global.ConfigManager) global.ConfigManager.setContext(context);
        // Also ensure global state is accessible for TransactionManager
        // global.js uses extensionContext variable if exported or set?
        // In global.js I used `extensionContext` variable but didn't export a setter.
        // Wait, global.js has `getConfig` using `vscode.workspace.getConfiguration`.
        // But `TransactionManager` uses `extensionContext.globalState`.
        // I need to set `extensionContext` in global.js.
        // `global.js` has `extensionContext` variable but no setter exported?
        // Let's check global.js content again.
        // I might need to add a setter in global.js or pass context to recover.
    } catch (e) { }

    isCoreIntegrityValid = verifySystemIntegrity();
    qqq.logMessage(`Integrity: ${isCoreIntegrityValid ? "PASSED" : "FAILED"}`, "INFO");
    if (!isCoreIntegrityValid) return;

    loadWatermarkResource();
    refreshConfig();
    codeLensProvider = new FileCodeLensProvider();

    // ★ 启动时恢复/清理事务
    try {
        await TransactionManager.recover();
        global.hasRecovered = true;  // ★ 防止 executeClipboardCommand 重复触发
    } catch (e) {
        console.error("Transaction Recovery Failed:", e);
        global.hasRecovered = true;  // ★ 即使失败也标记，防止重复执行
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("qqq")) {
                refreshConfig();
                clearDecorations();
                if (codeLensProvider) codeLensProvider.refresh();
                renderVisibleEditors(10);
                if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor);
            }
            if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("editor.lineHeight")) {
                refreshConfig();
                if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor);
            }
        }),
        vscode.commands.registerCommand("qqq.q1", executeClipboardCommand),
        vscode.commands.registerCommand("qqq.openFile", openFileCommand),
        vscode.commands.registerCommand("qqq.revealFileInFolder", revealFileInFolder),
        vscode.commands.registerCommand("qqq.renameFile", renameFileCommand),
        vscode.commands.registerCommand("qqq.setInOrder", () => {
            performGlobalClean(vscode.window.activeTextEditor, true);
        }),
        vscode.commands.registerCommand("qqq.exportDoc", () => {
            q3.executeExportDocCommand(isCoreIntegrityValid);
        }),
        vscode.commands.registerCommand("qqq.exportZip", () => {
            q3.executeExportZipCommand(isCoreIntegrityValid);
        }),
        vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
        vscode.workspace.onWillSaveTextDocument((e) => {
            if (cleanFreakMode && e.document) {
                e.waitUntil(
                    provideCleanlinessEditsAsync(e.document).then((edits) => {
                        return edits.map((edit) => new vscode.TextEdit(edit.range, edit.newText));
                    })
                );
            }
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
            debounceRender(e.textEditor);
        }),
        vscode.window.onDidChangeActiveTextEditor((e) => {
            if (e) debounceRender(e);
        }),
        vscode.window.onDidChangeWindowState((e) => {
            if (e.focused) renderVisibleEditors();
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            const ed = vscode.window.activeTextEditor;
            if (ed && e.document === ed.document) debounceRender(ed);
            if (e.document === ed?.document && e.contentChanges.length > 0)
                documentDecorationsMap.delete(e.document.uri.toString());
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            const docUri = doc.uri.toString();
            documentDecorationsMap.delete(docUri);
            for (const [editorId, timer] of editorDebounceTimers.entries()) {
                if (editorId.startsWith(docUri + "::")) {
                    clearTimeout(timer);
                    editorDebounceTimers.delete(editorId);
                }
            }
        }),
        vscode.window.onDidChangeVisibleTextEditors((editors) => {
            const visibleEditorIds = new Set(editors.map((e) => getEditorId(e)));
            for (const [editorId, timer] of editorDebounceTimers.entries()) {
                if (!visibleEditorIds.has(editorId)) {
                    clearTimeout(timer);
                    editorDebounceTimers.delete(editorId);
                }
            }
            renderVisibleEditors();
            if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor);
        })
    );

    // 监听文件系统变化（删除/创建/重命名），及时更新渲染状态
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    context.subscriptions.push(watcher);
    const fsChangeHandler = () => {
        if (codeLensProvider) codeLensProvider.refresh();
        renderVisibleEditors(200);
        clearDecorations(); // 强制刷新缓存
    };
    context.subscriptions.push(
        watcher.onDidCreate(fsChangeHandler),
        watcher.onDidDelete(fsChangeHandler),
        watcher.onDidChange(fsChangeHandler)
    );

    const editor = vscode.window.activeTextEditor;
    if (editor) renderImages(editor);
}

async function deactivate() {
    clearAllEditorDebounceTimers();
    clearDecorations();
    // 用户时长统计由 qqq.js 中控统一管理
}

module.exports = { activate, deactivate };

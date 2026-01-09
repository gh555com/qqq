// src/q1.js
const { checkQ, TransactionManager, getConfig } = require('./global');
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
let performanceMode = "balanced";
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
        else performanceMode = config.get("performanceMode", "balanced");

        frameSizeMode = config.get("frameSizeMode", "fix");
        cleanFreakMode = config.get("cleanFreak", false);
    } catch (e) {
        enlargeSmallImages = true;
        performanceMode = "balanced";
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
                }
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

function buildUnifiedWebPArgs(filePath, origSize, duration, qualityLevel, isAnimatedOutput) {
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

    if (performanceMode === "extreme") {
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
        cacheStrategy.isAnimatedOutput
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

            tasks.push(async () => {
                if (currentRenderVersion !== myVersion) return null;

                try {
                    let mtimeMs = 0;
                    try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }

                    const info = await getMediaInfo(absPath, mtimeMs);
                    const { width: previewWidth, height: previewHeight } = getFrameConfig(info);

                    const previewResult = await getPreviewBuffer(absPath, contentId, previewWidth, previewHeight);

                    if (currentRenderVersion !== myVersion) return null;

                    const deco = { range: anchorRange, renderOptions: {} };
                    let contentUrl = "";
                    let webpDuration = 0;
                    let outputSize = null;

                    if (previewResult?.buffer) {
                        let mime = "image/webp";
                        if (previewResult.isDirect) {
                            mime = previewResult.mimeType || mimeFromExt(previewResult.ext) || "image/webp";
                        } else if (previewResult.mimeType) {
                            mime = previewResult.mimeType;
                        }
                        contentUrl = `url("data:${mime};base64,${previewResult.buffer.toString("base64")}")`;
                        webpDuration = previewResult.webpDuration || 0;
                        outputSize = previewResult.outputSize;
                    }

                    if (!contentUrl) return null;

                    const boxWidth = previewWidth + PREVIEW_BORDER;
                    const boxHeight = previewHeight + PREVIEW_BORDER;

                    let progressBarUrl = null;
                    if (webpDuration > 0.1)
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
async function formatResultToText(result, editor) {
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
            const isLastItem = i === folders.length - 1 && files.length === 0;
            const gapBelow = calculateBlankLinesExact(LARGE_PREVIEW_HEIGHT, isLastItem);
            replacement += `/\\${relPath}\\/${eol.repeat(gapBelow)}`;
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
            let pxHeight = LARGE_PREVIEW_HEIGHT;
            if (isImageOrVideoExt(path.extname(f))) {
                try {
                    const info = await getMediaInfo(f, Date.now());
                    const { height } = getFrameConfig(info);
                    pxHeight = height;
                } catch { }
            }
            const isLastItem = i === files.length - 1 && folders.length === 0;
            if (i > 0 || folders.length > 0) replacement += eol;
            replacement += `/\\${relPath}\\/`;
            const gapBelow = calculateBlankLinesExact(pxHeight, isLastItem);
            replacement += eol.repeat(gapBelow);
            invalidateFolderSizeCacheForPath(f);
        }

        const totalCount = files.length + folders.length;
        if (totalCount > 1) vscode.window.showInformationMessage("文件/文件夹已复制 " + totalCount);
    } else if (result.type === "folder_text") {
        const folders = result.text.split(/\r?\n/).filter(f => f.trim());
        for (let i = 0; i < folders.length; i++) {
            const folderPath = folders[i];
            const relPath = path.relative(docDir, folderPath).replace(/\\/g, "/");
            const isLastItem = i === folders.length - 1;
            const gapBelow = calculateBlankLinesExact(LARGE_PREVIEW_HEIGHT, isLastItem);
            replacement += `/\\${relPath}\\/${eol.repeat(gapBelow)}`;
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
    // 1. 生成并插入锚点
    const transId = TransactionManager.createTransactionId();
    const anchor = `/__PENDING_${transId}/`;

    // 立即插入锚点
    const success = await TransactionManager.insertAnchor(editor, transId);

    if (!success) return; // 插入失败，直接退出

    const docUri = editor.document.uri;

    // 2. 注册事务 (Pending)
    await TransactionManager.saveTransaction({
        id: transId,
        targetDir: targetDir,
        expectedAnchor: anchor,
        docUri: docUri.toString(),
        tempFiles: [],
        landedFiles: [],
        landedFolders: [],
        startTime: Date.now()
    });

    // 3. 启动带进度的后台任务
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "资源处理中 (弯粘)...",
        cancellable: true
    }, async (progress, token) => {

        // 监听取消
        token.onCancellationRequested(async () => {
            const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
            if (trans) await TransactionManager.rollback(trans);
            // 尝试移除锚点
            await replaceAnchorInDoc(docUri, anchor, "");
        });

        try {
            // 4. 执行实际粘贴逻辑 (传入 transId 进行文件追踪)
            let result = await h.autoDetectAndPaste(targetDir, (p, msg) => {
                progress.report({ increment: p, message: msg });
            }, token, transId);

            // ★★★ 视频并发下载接管 ★★★
            if (result && result.type === 'video_url') {
                try {
                    const vc = new VideoDownloadController(extensionContext);
                    const downloadRes = await vc.downloadEntry(
                        result.url,
                        targetDir,
                        transId,
                        (p, msg) => progress.report({ increment: 0, message: msg }),
                        token
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

            if (result) {
                // 5. 格式化结果
                // Mock editor object for formatResultToText
                const mockEditor = {
                    document: {
                        uri: docUri,
                        eol: editor.document.eol // Use captured EOL or default
                    }
                };

                // 这里我们假设 formatResultToText 只需要 document.uri 和 eol
                // 如果它需要 getText，我们需要 openTextDocument。
                // 查看源码 formatResultToText 使用了 getDocumentEOL 和 path.dirname。安全。

                const newText = await formatResultToText(result, mockEditor);

                if (newText) {
                    // 6. 替换锚点 (原子化提交)
                    const replaced = await replaceAnchorInDoc(docUri, anchor, newText);

                    if (replaced) {
                        // 成功：提交事务 (移除记录)
                        await TransactionManager.removeTransaction(transId);
                    } else {
                        // 失败：锚点丢失 -> 回滚文件
                        const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
                        if (trans) await TransactionManager.rollback(trans);
                    }
                } else {
                    // 结果为空 -> 回滚
                    const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
                    if (trans) await TransactionManager.rollback(trans);
                    await replaceAnchorInDoc(docUri, anchor, "");
                }
            } else {
                // 任务失败/取消 -> 回滚
                if (!token.isCancellationRequested) {
                    const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
                    if (trans) await TransactionManager.rollback(trans);
                    await replaceAnchorInDoc(docUri, anchor, "");
                }
            }
        } catch (e) {
            console.error(e);
            const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
            if (trans) await TransactionManager.rollback(trans);
            await replaceAnchorInDoc(docUri, anchor, "");
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
    const snapshot = await checkQ();
    const config = getConfig('transactionLevel') || 'full';

    let mode = 'a'; // 默认弯粘

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
                // 文件 < 80MB -> q（★ 直接使用快照中的 totalSize）
                if (snapshot.totalSize < 80 * 1024 * 1024) mode = 'q';
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
    }
    refresh() {
        this._onDidChangeCodeLenses.fire();
    }
    async provideCodeLenses(document) {
        if (!isCoreIntegrityValid) return [];
        const lenses = [];
        const regex = qqq.createPathRegex();
        const text = document.getText();
        let match;
        const tasks = [];

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

            tasks.push(async () => {
                let folderData = await getQqqFolderSize(folder);
                const fSizeStr = formatBytes(folderData?.size || 0);
                const folderTooltip = folderData?.summary;
                let fileSz = "?";
                let tooltipText = "";
                let mtimeMs = 0;

                try {
                    const st = fs.statSync(absPath);
                    fileSz = formatBytes(st.size);
                    tooltipText = `创建: ${new Date(st.birthtime).toLocaleString()}\n修改: ${new Date(st.mtime).toLocaleString()}`;
                    mtimeMs = st.mtimeMs;
                } catch { }

                let titleSuffix = "";
                let isRealVideo = false;

                if (isVidOrImg) {
                    const info = await getMediaInfo(absPath, mtimeMs);
                    if (info?.width && info?.height) {
                        const { width: MAX_W, height: MAX_H } = getFrameConfig(info);
                        if (info.type === "video") isRealVideo = true;
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

                const iconPart = isRealVideo ? "🎬" : "";
                const spacePart = isRealVideo ? " " : "   ";
                const r = new vscode.Range(targetLensLine, 0, targetLensLine, 0);

                return [
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
                    }),
                    new vscode.CodeLens(r, {
                        title: `✎( ${fileSz})${iconPart}${spacePart}${absPath}${titleSuffix}`,
                        command: "qqq.openFile",
                        arguments: [absPath],
                        tooltip: tooltipText,
                    }),
                ];
            });
        }
        const results = await Promise.all(tasks.map((t) => t()));
        results.forEach((group) => lenses.push(...group));
        return lenses;
    }
}

const FOLDER_SIZE_CACHE_MAX_AGE = 10 * 1000;
function invalidateFolderSizeCacheForPath(filePath) {
    try {
        const dir = path.dirname(filePath);
        if (folderSizeCache.has(dir)) folderSizeCache.delete(dir);
    } catch { }
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
    } catch (e) {
        console.error("Transaction Recovery Failed:", e);
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

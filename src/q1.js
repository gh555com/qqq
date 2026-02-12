// src/q1.js
const global = require('./global');
const { savePasteStats, saveVideoStats, wq, TransactionManager, getConfig, TaskCounter, TaskMessage } = global;
const h = require('./h');
const Qvideo = require('./qvideo');
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const { TextDecoder } = require("util");
const { q } = require('./i18n');

// 延迟加载 qqq 以避免循环依赖
let qqq = null;
function geq() {
	if (!qqq) {
		try {
			qqq = require("./qqq");
		} catch (e) {
			global.logMessage(`Failed to lazy-load qqq: ${e.message}`, "ERROR");
		}
	}
	return qqq;
}

const q3 = require("./q3");

// 新水印的SHA256哈希值
const LARGE_WATERMARK_HASH = "dd931dba64fd02a5fd683dd83692bc04311e4bc8ce5df5b44d64491fa1536cc7";
const SMALL_WATERMARK_HASH = "7e2d52d43e5383b8638026552dc4b01e84012643415916ffe745d047541c3c67";
// Deleted:let isCoreIntegrityValid = false;

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
let PREVIEW_BG_COLOR = "#fef6e3";

// 文本胶片（Plain Text 预览）统一质量与缓存 key
// 目标：与最优模式静态产物一致（q=71），且磁盘缓存后缀统一呈现为“.71”
const TEXT_PREVIEW_QUALITY = 71;
function getTextPreviewCacheKey() {
	const prefix = textSlideColorScheme === "dark" ? "d_" : "l_";
	return `${prefix}${textSlideFontSize}`;
}

// 文本胶片：磁盘缓存只存一份大图（514x290，key=71）
// small frame 只改显示缩放（宽高各 1/2 => 面积 1/4），不产生第二份缓存
const TEXT_PREVIEW_PIXEL_LARGE = { width: 514, height: 290 };
const TEXT_PREVIEW_PIXEL_SMALL = { width: 257, height: 145 };
function getTextPreviewOutputSize(renderW, renderH) {
	const w = Number(renderW) || 0;
	const h = Number(renderH) || 0;
	const wantSmall =
		w > 0 && h > 0 &&
		w <= SMALL_PREVIEW_WIDTH &&
		h <= SMALL_PREVIEW_HEIGHT;
	return wantSmall ? TEXT_PREVIEW_PIXEL_SMALL : TEXT_PREVIEW_PIXEL_LARGE;
}

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
const FALLBACK_MAX_SIZE = 4 * 1048576;   // 渲染 ico 图片滴尺寸界限

const IMAGE_EXTS = global.IMAGE_EXTS;
const VIDEO_EXTS = global.VIDEO_EXTS;
const AUDIO_EXTS = global.AUDIO_EXTS;

const PIPE_SEEK_ERROR_PATTERNS = [
	"non seekable",
	"seek not allowed",
	"Discarding interleaved",
	"muxer does not support non seekable output",
	"Could not write header",
];

// ==================== ★ a 的 Text Ext 白名单（照抄） ====================
const TEXT_EXTS = new Set([
	".txt", ".md", ".markdown", ".log", ".ini", ".cfg", ".conf", ".config",
	".json", ".xml", ".yaml", ".yml", ".toml",
	".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
	".py", ".pyw", ".pyi",
	".java", ".kt", ".kts", ".scala", ".groovy",
	".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx",
	".cs", ".vb", ".fs", ".fsx",
	".go", ".rs", ".swift", ".m", ".mm",
	".rb", ".php", ".pl", ".pm", ".lua", ".r",
	".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
	".html", ".htm", ".css", ".scss", ".sass", ".less",
	".sql", ".graphql", ".gql",
	".env", ".gitignore", ".gitattributes", ".editorconfig",
	".dockerfile", ".makefile", ".cmake",
	".rst", ".tex", ".bib", ".csv", ".tsv",
	".vue", ".svelte", ".astro",
	".asm", ".s", ".nasm",
	".lisp", ".cl", ".el", ".scm", ".rkt",
	".hs", ".lhs", ".ml", ".mli", ".elm", ".erl", ".ex", ".exs",
	".clj", ".cljs", ".cljc", ".edn",
	".nim", ".zig", ".v", ".d",
	".proto", ".thrift", ".avsc",
	".tf", ".tfvars", ".hcl",
	".plist", ".strings"
]);

// ==================== 全局状态 ====================
let decorationType = null;
let markerHideType = null;
let extensionContext = null;
let currentRenderVersion = 0;

let codeLensProvider = null;

const documentDecorationsMap = new Map();
const resolutionCache = new Map();
const RESOLUTION_CACHE_MAX_SIZE = 1000; // ★ 提升至1000条
const folderSizeCache = new Map();
const FOLDER_SIZE_CACHE_MAX_ENTRIES = 500; // ★ 调整为500条，匹配实际使用场景

const editorDebounceTimers = new Map();

let enlargeSmallImages = true;
let performanceMode = "optmum";
let frameSizeMode = "fix";
let cleanFreakMode = "add"; // "never" | "add" | "add & remove"
let textSlideColorScheme = "light";
let textSlideFontSize = 14;
let codelensLevel = "3";

// 大小相框水印
let largeWatermarkBase64 = null;
let smallWatermarkBase64 = null;
let LARGE_WATERMARK_PATH = "";
let SMALL_WATERMARK_PATH = "";

// ==================== ★★★ Schedulers (Layered) ★★★ ====================
async function scheduleProbe(key, fn) {
	const _qqq = geq();
	const s = _qqq?.probeScheduler;
	if (s && typeof s.schedule === "function") {
		return s.schedule(key, fn);
	}
	return fn();
}

// ★ 本地防重 Map，用于 genScheduler 不可用时的回退防重
const _localGenPending = new Map();

async function scheduleGen(key, fn) {
	const _qqq = geq();
	const s = _qqq?.genScheduler;
	if (s && typeof s.schedule === "function") {
		return s.schedule(key, fn);
	}
	// ★ 回退防重：即使 genScheduler 不可用，也要防止重复调用
	if (_localGenPending.has(key)) {
		return _localGenPending.get(key);
	}
	const p = fn().finally(() => _localGenPending.delete(key));
	_localGenPending.set(key, p);
	return p;
}

// ==================== 初始化 ====================

async function loadWatermarkResource() {
	// 加载大相框水印
	try {
		if (fs.existsSync(LARGE_WATERMARK_PATH)) {
			const buf = await fs.promises.readFile(LARGE_WATERMARK_PATH);
			largeWatermarkBase64 = "data:image/png;base64," + buf.toString("base64");
		}
	} catch (e) {
		largeWatermarkBase64 = null;
	}

	// 加载小相框水印
	try {
		if (fs.existsSync(SMALL_WATERMARK_PATH)) {
			const buf = await fs.promises.readFile(SMALL_WATERMARK_PATH);
			smallWatermarkBase64 = "data:image/png;base64," + buf.toString("base64");
		}
	} catch (e) {
		smallWatermarkBase64 = null;
	}
}

function refreshConfig() {
	try {
		// ★ 通过 ConfigGate 读取配置（不直接读 settings.json）
		enlargeSmallImages = getConfig("enlargeSmallImages");
		if (enlargeSmallImages === undefined) enlargeSmallImages = true;

		const extremePerformance = getConfig("extremePerformance");
		if (extremePerformance) performanceMode = "extreme";
		else performanceMode = getConfig("performanceMode") || "optmum";

		frameSizeMode = getConfig("frameSizeMode") || "fix";
		cleanFreakMode = getConfig("cleanFreak") || "add";
		textSlideColorScheme = getConfig("textSlideColorScheme") || "light";
		textSlideFontSize = getConfig("textSlideFontSize") || 14;
		codelensLevel = String(getConfig("codelensLevel") || "3");
		PREVIEW_BG_COLOR = textSlideColorScheme === "dark" ? "#1B1411" : "#fef6e3";
	} catch (e) {
		enlargeSmallImages = true;
		performanceMode = "optmum";
		frameSizeMode = "fix";
		cleanFreakMode = "add";
		textSlideColorScheme = "light";
		textSlideFontSize = 14;
		codelensLevel = "3";
		PREVIEW_BG_COLOR = "#fef6e3";
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
		if (!geq().LOG_PATH) return;
		const timestamp = new Date().toISOString();
		const shortPath = filePath.length > 100 ? "..." + filePath.slice(-97) : filePath;
		const shortErr = errorMsg.length > 500 ? errorMsg.slice(0, 500) + "..." : errorMsg;
		const logLine = `[${timestamp}] FFMPEG_FAIL: ${shortPath}\n${shortErr}\n\n`;
		fs.appendFileSync(geq().LOG_PATH, logLine);
	} catch (e) { }
}

function logFallbackUsedRateLimited(filePath, ext, errCode, stderr) {
	try {
		const e = (ext || "").toLowerCase();
		const err = String(errCode || "UNKNOWN").slice(0, 120);
		const key = `ffmpeg_fallback:${e}:${err}`;
		const shortPath = filePath.length > 140 ? "..." + filePath.slice(-137) : filePath;
		const shortStderr = (stderr || "").toString().slice(0, 300);
		geq().logMessageRateLimited(
			key,
			`FFMPEG_FAIL -> fallbackDirectRead: ${shortPath}  ext=${e}  err=${err}${shortStderr ? `  stderr=${shortStderr}` : ""}`,
			"WARN",
			130 * 1000
		);  // 相同日志去重时间
	} catch { }
}

// ==================== CSS 计算辅助 ====================
function fitIntoBox(srcW, srcH, boxW, boxH, enlarge) {
	if (!srcW || !srcH) {
		// 如果宽高未知，不应该直接返回满屏，这会导致拉伸。
		// 应该维持一个默认比例或者原样显示。
		return { width: boxW, height: boxH, scale: 1, unknown: true };
	}

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
	// 如果 outputSize 未知，使用 contain 保持比例而不拉伸
	sizes.push(outputSize && !outputSize.unknown ? `${outputSize.width}px ${outputSize.height}px` : "contain");
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

// ==================== 缓存工具函数 ====================
// 通用FIFO缓存清理函数
function evictOldestEntries(cacheMap, maxSize, evictionRatio = 0.25) {
	if (cacheMap.size > maxSize) {
		const keys = Array.from(cacheMap.keys());
		const deleteCount = Math.floor(keys.length * evictionRatio);
		for (let i = 0; i < deleteCount; i++) {
			cacheMap.delete(keys[i]);
		}
	}
}

// 清理所有缓存
function clearAllCaches() {
	resolutionCache.clear();
	folderSizeCache.clear();
	shouldUseFrameCache.clear();
	global.logMessage(q('q1.log.cacheCleared'), "INFO");
}

// ==================== FFprobe ====================
async function getMediaInfo(filePath, mtimeMsRaw) {
	// 归一化 mtime，与 h.js 保持一致
	const mtimeMs = Math.floor(mtimeMsRaw);
	const cached = resolutionCache.get(filePath);
	if (cached && cached.mtime === mtimeMs) return cached;

	const cacheKey = `probe:info:${filePath}:${mtimeMs}`;
	return scheduleProbe(cacheKey, async () => _getMediaInfoInternal(filePath, mtimeMs));
}

function _getMediaInfoInternal(filePath, mtimeMs) {
	if (!filePath) return null;

	const ff = global.ffmpegPath();
	const ext = path.extname(filePath).toLowerCase();

	// ★ 严格过滤：仅对真正的媒体格式调用 FFprobe
	if (!global.IMAGE_EXTS.has(ext) && !global.AUDIO_EXTS.has(ext) && !global.VIDEO_EXTS.has(ext)) {
		return null;
	}

	// 特殊：Windows 下的图标文件（非媒体）应在 render 层通过图标提取器处理，严禁进入此处
	if (process.platform === 'win32' && (ext === '.exe' || ext === '.lnk')) {
		return null;
	}

	// ... existing code ...

	if (!ff || typeof ff !== 'string' || !fs.existsSync(ff)) {

		// 如果内置路径无效，尝试直接用 'ffmpeg'
	}

	return new Promise((resolve) => {
		let child;
		const trySpawn = (cmd, args) => {
			try {
				return cp.spawn(cmd, args, {
					windowsHide: true,
					env: process.env
				});
			} catch (e) {
				return null;
			}
		};

		const spawnFfmpeg = () => {
			// 1. 优先使用内置路径
			if (ff && fs.existsSync(ff)) {
				const c = trySpawn(ff, ["-hide_banner", "-i", filePath]);
				if (c) return c;
			}
			// 2. 兜底使用环境变量中的 ffmpeg
			const c2 = trySpawn("ffmpeg", ["-hide_banner", "-i", filePath]);
			if (c2) return c2;
			return null;
		};

		child = spawnFfmpeg();

		if (!child) {
			global.logMessage(`[FFmpeg] spawn failed, resolving with null`, "INFO");
			resolve(null);
			return;
		}

		let stderr = "";

		child.stderr.on("data", (d) => {
			if (stderr.length < 50000) stderr += d.toString();
		});

		child.on("close", () => {
			const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
			const codecMatch = /Stream.*Video:\s*(.*?)(?:,|$)/i.exec(stderr);
			const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);

			if (!resMatch && !durMatch) {
				const shortPath = filePath.length > 60 ? "..." + filePath.slice(-57) : filePath;
				const cleanStderr = stderr.replace(
					/\r\n/g, " ").slice(0, 200);
				global.logMessage(`[FFprobe] no resolution or duration found: ${shortPath}`, "DEBUG");
			}

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
						info.isMjpegStatic = false; // Gif 不被视为 MJPEG
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
				// ★ 修复：只有在 FFprobe 真正解析出了宽高或时长时，才根据扩展名推断类型
				// 否则 exe 改名 mp4 会被误判为视频
				if (info.width > 0 || info.duration > 0) {
					if (VIDEO_EXTS.has(ext)) {
						info.type = "video";
					} else if (IMAGE_EXTS.has(ext)) {
						info.type = "image";
						info.isStaticImage = true;
					} else if (AUDIO_EXTS.has(ext)) {
						// ★★★ 加入音频类型检查 ★★★
						info.type = "audio";
					}
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
			// ★ FIFO 缓存大小限制
			evictOldestEntries(resolutionCache, RESOLUTION_CACHE_MAX_SIZE);

			resolve(info.width ? info : null);
		});

		child.on("error", (err) => {
			geq().logMessage(q('q1.log.ffmpegError', err.message), "WARN");
			resolve(null);
		});

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

// ==================== ★ a 的 Plain Text 识别（照抄） ====================
// Check if a file is likely plain text by reading its header bytes
function isPlainTextFile(filePath) {
	try {
		const ext = path.extname(filePath).toLowerCase();

		// If it's a known image/video extension, definitely not text
		if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) return false;

		// If it's a known text extension, return true
		if (TEXT_EXTS.has(ext)) return true;

		// For unknown extensions or no extension, analyze content
		const fd = fs.openSync(filePath, 'r');
		const headerBuf = Buffer.alloc(8192);
		const bytesRead = fs.readSync(fd, headerBuf, 0, 8192, 0);
		fs.closeSync(fd);

		if (bytesRead === 0) return true; // Empty file is considered text

		// Check for binary content indicators
		let nullCount = 0;
		let controlCount = 0;

		for (let i = 0; i < bytesRead; i++) {
			const b = headerBuf[i];
			if (b === 0x00) {
				nullCount++;
			} else if (b < 0x09 || (b > 0x0D && b < 0x20 && b !== 0x1B)) {
				// Control chars except tab, newline, carriage return, escape
				controlCount++;
			}
		}

		// Binary detection heuristics:
		// 1. Any NULL bytes strongly suggest binary
		if (nullCount > 0) return false;

		// 2. Too many control characters suggest binary
		if (controlCount > bytesRead * 0.1) return false;

		// 3. Check for common binary file signatures
		if (bytesRead >= 4) {
			const sig = headerBuf.slice(0, 4).toString('hex');
			const binarySigs = [
				'89504e47', // PNG
				'ffd8ffe0', 'ffd8ffe1', 'ffd8ffe2', 'ffd8ffdb', 'ffd8ffee', // JPEG
				'47494638', // GIF
				'52494646', // RIFF (WebP, AVI, WAV)
				'504b0304', // ZIP/DOCX/XLSX
				'25504446', // PDF
				'7f454c46', // ELF
				'4d5a9000', '4d5a5000', '4d5a0000', // PE/MZ executables
				'cafebabe', // Java class
				'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', // Mach-O
			];
			if (binarySigs.some(s => sig.startsWith(s.slice(0, 8)))) return false;
		}

		// If we get here, it's likely text
		return true;
	} catch (e) {
		return false;
	}
}

// ==================== ★ a 的 文本预览生成（照抄 + cacheKey 改 q 风格） ====================

// Get a font that supports CJK characters
function getCJKFontPath() {
	if (process.platform === 'win32') {
		const winFonts = [
			'C:\\Windows\\Fonts\\msyh.ttc',
			'C:\\Windows\\Fonts\\msyhbd.ttc',
			'C:\\Windows\\Fonts\\simsun.ttc',
			'C:\\Windows\\Fonts\\simhei.ttf',
		];
		for (const f of winFonts) {
			if (fs.existsSync(f)) return f;
		}
	} else if (process.platform === 'darwin') {
		const macFonts = [
			'/System/Library/Fonts/PingFang.ttc',
			'/System/Library/Fonts/STHeiti Light.ttc',
		];
		for (const f of macFonts) {
			if (fs.existsSync(f)) return f;
		}
	} else {
		const linuxFonts = [
			'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
			'/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
		];
		for (const f of linuxFonts) {
			if (fs.existsSync(f)) return f;
		}
	}
	return null;
}

// Detect if buffer is valid UTF-8
function isValidUtf8(buffer) {
	try {
		const str = buffer.toString('utf8');
		// Check for replacement character (indicates invalid UTF-8)
		if (str.includes('\uFFFD')) return false;
		// Additional check: encode back and compare
		const reEncoded = Buffer.from(str, 'utf8');
		// If lengths differ significantly, probably not UTF-8
		if (Math.abs(reEncoded.length - buffer.length) > buffer.length * 0.1) return false;
		return true;
	} catch {
		return false;
	}
}

// Try to decode buffer with encoding detection
function decodeTextBuffer(buffer) {
	// Try UTF-8 first
	if (isValidUtf8(buffer)) {
		return buffer.toString('utf8');
	}

	// Try GBK/GB2312 using TextDecoder (available in Node.js with ICU)
	try {
		const decoder = new TextDecoder('gbk');
		return decoder.decode(buffer);
	} catch {
		// GBK not available, try GB2312
		try {
			const decoder = new TextDecoder('gb2312');
			return decoder.decode(buffer);
		} catch {
			// Fallback to latin1 (preserves bytes but won't display Chinese correctly)
			return buffer.toString('latin1');
		}
	}
}

// Calculate visual width of a string (CJK chars = 1.0, ASCII = 0.55)
function getVisualWidth(str) {
	let w = 0;
	for (const ch of str) {
		const code = ch.charCodeAt(0);
		if (code > 0x2E7F) w += 1.0; // CJK and other wide chars
		else w += 0.55; // ASCII and Latin
	}
	return w;
}

// Generate preview image for plain text file using ffmpeg drawtext
async function generateTextPreview(filePath, contentId, qualityLevel, textCacheKey) {
	if (!global.ffmpegPath()) return null;

	try {
		// Only read first 4KB for preview (enough for ~15 lines of text)
		// This handles 200MB files efficiently
		const PREVIEW_READ_SIZE = 4096;
		const fd = fs.openSync(filePath, 'r');
		const rawBuffer = Buffer.alloc(PREVIEW_READ_SIZE);
		const bytesRead = fs.readSync(fd, rawBuffer, 0, PREVIEW_READ_SIZE, 0);
		fs.closeSync(fd);

		// Only use the bytes actually read
		const actualBuffer = bytesRead < PREVIEW_READ_SIZE ? rawBuffer.slice(0, bytesRead) : rawBuffer;
		let textContent = decodeTextBuffer(actualBuffer);

		// Strip BOM and ALL types of leading whitespace/empty lines
		textContent = textContent
			.replace(/^\uFEFF/, '')                    // UTF-8 BOM
			.replace(/^[\s\u00A0\u3000\u200B\r\n]+/, ''); // All whitespace types

		// Fixed cache frame: 514x290
		const targetW = TEXT_PREVIEW_PIXEL_LARGE.width;
		const targetH = TEXT_PREVIEW_PIXEL_LARGE.height;

		// Layout: font size from config, line height 1.3x font size, padding 4px
		const fontSize = textSlideFontSize;
		const lineHeight = Math.floor(fontSize * 1.3);
		const padding = 4;
		const usableW = targetW - padding * 2;
		const usableH = targetH - padding * 2;
		const maxLines = Math.floor(usableH / lineHeight);

		// Max visual width in "em" units (1em = fontSize)
		const maxVisualWidth = usableW / fontSize;

		// Process text: wrap lines based on visual width
		const lines = textContent.split('\n');
		const wrappedLines = [];

		for (const line of lines) {
			if (wrappedLines.length >= maxLines) break;

			if (line.length === 0) {
				wrappedLines.push(' ');
				continue;
			}

			if (getVisualWidth(line) <= maxVisualWidth) {
				wrappedLines.push(line);
			} else {
				let currentLine = '';
				let currentWidth = 0;

				for (const ch of line) {
					const charWidth = ch.charCodeAt(0) > 0x2E7F ? 1.0 : 0.55;
					if (currentWidth + charWidth > maxVisualWidth) {
						if (currentLine) wrappedLines.push(currentLine);
						if (wrappedLines.length >= maxLines) break;
						currentLine = ch;
						currentWidth = charWidth;
					} else {
						currentLine += ch;
						currentWidth += charWidth;
					}
				}
				if (currentLine && wrappedLines.length < maxLines) {
					wrappedLines.push(currentLine);
				}
			}
		}

		let finalText = wrappedLines.join('\n');
		if (!finalText.trim()) finalText = '[Empty File]';

		// Escape special characters for ffmpeg drawtext
		finalText = finalText.split('%').join('\uFF05');
		finalText = finalText.split('\\').join('\\\\');
		finalText = finalText.split("'").join("\\'");

		const rand = Math.random().toString(36).slice(2);
		const textTempFile = path.join(os.tmpdir(), `qqq_txt_${rand}.txt`);
		const outputFile = path.join(os.tmpdir(), `qqq_txt_${contentId}_${rand}.webp`);

		fs.writeFileSync(textTempFile, finalText, 'utf8');

		const bgColor = textSlideColorScheme === "dark" ? '#1B1411' : '#fef6e3';
		const textColor = textSlideColorScheme === "dark" ? '#E5E5E5' : '#333333';

		const fontPath = getCJKFontPath();

		let textFileEsc = textTempFile.replace(/\\/g, '/').replace(/:/g, '\\:');
		let filterParts = [`drawtext=textfile='${textFileEsc}'`];
		filterParts.push(`fontsize=${fontSize}`);
		filterParts.push(`fontcolor=${textColor}`);
		filterParts.push(`x=${padding}`);
		filterParts.push(`y=${padding}`);
		filterParts.push(`line_spacing=${lineHeight - fontSize}`);

		if (fontPath) {
			let fontEsc = fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');
			filterParts.push(`fontfile='${fontEsc}'`);
		}

		const drawTextFilter = filterParts.join(':');

		const args = [
			'-hide_banner', '-loglevel', 'error',
			'-f', 'lavfi',
			'-i', `color=c=${bgColor}:s=${targetW}x${targetH}:d=1`,
			'-vf', drawTextFilter,
			'-frames:v', '1',
			'-c:v', 'libwebp',
			'-lossless', '0',
			'-compression_level', '0',
			'-q:v', String(qualityLevel),
			'-y', outputFile
		];

		return new Promise((resolve) => {
			const child = cp.spawn(global.ffmpegPath(), args, { windowsHide: true, stdio: 'pipe' });
			let resolved = false;

			const cleanup = () => {
				try { if (fs.existsSync(textTempFile)) fs.unlinkSync(textTempFile); } catch { }
				try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch { }
			};

			const timer = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					try { child.kill(); } catch { }
					cleanup();
					resolve(null);
				}
			}, 15000);

			child.on('close', async () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timer);

					let buffer = null;
					try {
						if (fs.existsSync(outputFile)) buffer = fs.readFileSync(outputFile);
					} catch { }

					cleanup();

					if (!buffer) { resolve(null); return; }

					// 统一缓存命名：.71（cacheKey="71"）
					await geq().setCacheEntry(contentId, textCacheKey, buffer, {
						width: targetW,
						height: targetH,
						type: 'text_preview',
						webpDur: 0,
						originalDuration: 0
					});

					resolve({
						buffer,
						webpDuration: 0,
						outputSize: { width: targetW, height: targetH },
						isTextPreview: true
					});
				}
			});

			child.on('error', () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timer);
					cleanup();
					resolve(null);
				}
			});
		});
	} catch (e) {
		return null;
	}
}

// Helper: try to get text preview from cache or generate
async function tryTextPreview(filePath, contentId, renderW, renderH) {
	const textCacheKey = getTextPreviewCacheKey();
	const outSize = getTextPreviewOutputSize(renderW, renderH);

	const cached = geq().getCachedBuffer(contentId, textCacheKey);
	if (cached) {
		const meta = geq().getCacheQualityMeta(contentId, textCacheKey);
		if (meta && meta.type === 'text_preview') {
			global.logMessage(`[Cache] HIT (text): ${path.basename(filePath)}`, "INFO");
			return {
				buffer: cached,
				webpDuration: 0,
				originalDuration: 0,
				outputSize: outSize,
				fromCache: true,
				isTextPreview: true,
				mimeType: 'image/webp',
				ext: '.webp'
			};
		}
	}

	const gen = await generateTextPreview(filePath, contentId, TEXT_PREVIEW_QUALITY, textCacheKey);
	if (!gen) return null;

	// 同一份磁盘缓存（514x290），按相框尺寸返回不同显示大小
	gen.outputSize = outSize;
	return gen;
}

// ==================== 核心缓存策略（媒体） ====================
function determineCacheStrategy(filePath, info) {
	const ext = path.extname(filePath).toLowerCase();
	let fileSize = 0;
	try { fileSize = fs.statSync(filePath).size; } catch { }

	const isStaticSource = info?.isStaticImage === true;
	const isMjpegStatic = info?.isMjpegStatic === true;
	const simpleFormats = [".png", ".jpg", ".jpeg", ".svg", ".ico"];
	const canDirectRead = simpleFormats.includes(ext) || (ext === ".webp" && isStaticSource);
	// 满足以下任一条件就跳过缓存（直接读原图）：✅ 条件1： 是 .ico 文件 且 小于 4MB ✅ 条件2： 文件小于 300KB 且 宽度≤512px 且 高度≤512px
	let shouldBypassCache = false;
	if (isMjpegStatic) {
		shouldBypassCache = true;
	} else if (
		isStaticSource &&
		canDirectRead &&
		!info?.needsConversion &&
		(
			(ext === ".ico" && fileSize < FALLBACK_MAX_SIZE) ||
			(fileSize < 307200 && info?.width && info?.height && info.width <= 512 && info.height <= 512)
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
		const ff = global.ffmpegPath();
		const child = cp.spawn(ff, pipeArgs, {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env
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
		const ff = global.ffmpegPath();
		const child = cp.spawn(ff, fileArgs, {
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
			env: process.env
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

// ==================== Preview Buffer（文本优先，照 a 逻辑接入） ====================
async function getPreviewBuffer(filePath, contentId, renderW, renderH) {
	// 移除对 ffmpegPath 的硬性拦截，因为图片预览可能通过 image-size 兜底
	// if (!global.ffmpegPath()) return null;

	// 性能优先：已知必失败的源文件直接短路（避免反复 ffmpeg）
	if (geq().isBrokenFile && geq().isBrokenFile(contentId, filePath)) {
		return null;
	}

	const ext = path.extname(filePath).toLowerCase();

	// ★★★ 文本优先：不是看后缀名，而是看实质（照 a）★★★
	if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext) && (TEXT_EXTS.has(ext) || isPlainTextFile(filePath))) {
		const t = await tryTextPreview(filePath, contentId, renderW, renderH);
		if (t && geq().unmarkFileAsBroken) geq().unmarkFileAsBroken(contentId);
		return t;
	}

	let mtimeMs = 0;
	try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return null; }

	const info = await getMediaInfo(filePath, mtimeMs);
	const origSize = info
		? { width: info.width, height: info.height, needsConversion: info.needsConversion }
		: null;
	const originalDuration = info?.duration || 0;

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
		const cached = geq().getCachedBuffer(contentId, cacheStrategy.cacheKey);
		if (cached) {
			const meta = geq().getCacheQualityMeta(contentId, cacheStrategy.cacheKey);
			if (meta && meta.type === "webp_unified") {
				// global.logMessage(`[Cache] HIT: ${path.basename(filePath)} (${cacheStrategy.cacheKey})`, "INFO");
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

	const result = await scheduleGen(taskKey, async () => {
		const existing = geq().getCachedBuffer(contentId, cacheStrategy.cacheKey);
		if (existing) {
			const meta = geq().getCacheQualityMeta(contentId, cacheStrategy.cacheKey);
			if (meta && meta.type === "webp_unified") {
				if (geq().unmarkFileAsBroken) geq().unmarkFileAsBroken(contentId);
				return { success: true, buffer: existing, fromCache: true, meta };
			}
		}

		const isAnimated = expectedWebPDuration > 0.1;

		const tmpDir = path.join(os.tmpdir(), "qqq_ffmpeg_tmp");
		if (!global.__qqqFfmpegTmpReady) {
			try {
				if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
				global.__qqqFfmpegTmpReady = true;
			} catch { }
		}

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

		global.logMessage(`[FFmpeg] Preview generated: ${path.basename(filePath)} (${buffer.length} bytes, ${finalWebPDuration.toFixed(2)}s)`, "INFO");

		// 快速校验：防止 ffmpeg 产出截断/损坏 WebP 被写入缓存导致长期“坏命中”
		if (geq().isValidWebPBuffer && !geq().isValidWebPBuffer(buffer)) {
			if (geq().markFileAsBroken) geq().markFileAsBroken(contentId, filePath, "invalid_webp_output");
			try { if (result.cacheFilePath && fs.existsSync(result.cacheFilePath)) fs.unlinkSync(result.cacheFilePath); } catch { }
			return null;
		}


		global.logMessage(`[FFmpeg] RESULT: success=${result.success}, fromPipe=${result.fromPipe}, fromFile=${result.fromFile}, fromCache=${result.fromCache}`, "DEBUG");

		if (result.fromPipe || result.fromFile) {
			global.logMessage(`[Cache] WRITE: ${contentId}/${cacheStrategy.cacheKey}`, "INFO");
			await geq().setCacheEntry(contentId, cacheStrategy.cacheKey, buffer, {
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

		if (geq().unmarkFileAsBroken) geq().unmarkFileAsBroken(contentId);
		return {
			buffer,
			webpDuration: finalWebPDuration,
			originalDuration: outOriginalDuration,
			outputSize: { width: finalCssW, height: finalCssH },
		};
	} else {
		const errorMsg = result.error || "UNKNOWN";
		const stderr = (result.stderr || "").slice(0, 200);
		global.logMessage(`[FFmpeg] FAILED: ${path.basename(filePath)} - ${errorMsg}${stderr ? ` stderr=${stderr}` : ""}`, "WARN");
		const fallback = tryFallbackDirectRead(filePath, renderW, renderH, info);

		if (!fallback) {
			const stderr = result.stderr || "";

			// 失败熔断：记录失败并逐步延长冷却时间，避免滚动/重绘时反复 spawn ffmpeg
			const brokenRec = geq().markFileAsBroken ? geq().markFileAsBroken(contentId, filePath, result.error || "FFMPEG_FAIL") : null;

			// 只有在“强烈怀疑源文件损坏”且连续失败时才用 ffprobe 进一步确认（昂贵，但这里极少发生）
			if (
				brokenRec &&
				brokenRec.count >= 2 &&
				geq().shouldVerifySourceAfterFailure &&
				geq().shouldVerifySourceAfterFailure(stderr) &&
				geq().verifyMediaFile
			) {
				try {
					const v = await geq().verifyMediaFile(filePath, { timeoutMs: 2000, allowRemote: false });
					if (!v) {
						// 确认严重损坏：延长冷却到上限 24小时 （避免无意义重试）
						geq().markFileAsBroken(contentId, filePath, "verified_corrupt", { increment: false, forceTtlMs: 86400000 });
					}
				} catch { }
			}
			if (stderr.includes("moov atom not found")) {
				geq().logMessageRateLimited(
					`corrupt_video:${filePath}`,
					`Corrupt video file (moov atom not found): ${path.basename(filePath)}`,
					"WARN"
				);
			} else {
				logCriticalError(filePath, `${result.error} (无法兜底)\n${stderr}`);
			}
		} else {
			logFallbackUsedRateLimited(filePath, ext, result.error, result.stderr || "");
			if (geq().unmarkFileAsBroken) geq().unmarkFileAsBroken(contentId);
		}
		return fallback;
	}
}

// ==================== 其他工具 ====================
// ★ formatBytes 已统一使用 global.formatBytes

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

function isSupportedMedia(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (isImageOrVideoExt(ext)) return true;
	// ★ 文本按 a 的“实质识别”接管
	return isPlainTextFile(filePath);
}

// shouldUseFrame结果的内存缓存
const shouldUseFrameCache = new Map();
const CACHE_EXPIRE_TIME = 125 * 60 * 1000;
const CACHE_MAX_SIZE = 2500; // ★ 最大缓存数量

// 清理过期缓存
function cleanShouldUseFrameCache() {
	const now = Date.now();
	for (const [key, value] of shouldUseFrameCache.entries()) {
		if (now - value.timestamp > CACHE_EXPIRE_TIME) {
			shouldUseFrameCache.delete(key);
		}
	}
	// ★ 如果超过最大数量，删除最旧的50%
	if (shouldUseFrameCache.size > CACHE_MAX_SIZE) {
		const entries = Array.from(shouldUseFrameCache.entries())
			.sort((a, b) => a[1].timestamp - b[1].timestamp);
		const deleteCount = Math.floor(entries.length / 2);
		for (let i = 0; i < deleteCount; i++) {
			shouldUseFrameCache.delete(entries[i][0]);
		}
	}
}

// 定期清理缓存
const shouldUseFrameCleanupInterval = setInterval(cleanShouldUseFrameCache, CACHE_EXPIRE_TIME);

// 批量获取图标函数
async function batchGetIcons(filePaths) {
	if (!filePaths || filePaths.length === 0) return {};

	// 结果映射
	const iconResults = {};

	// 收集所有获取图标的任务，使用全局的iconScheduler
	const tasks = filePaths.map(async (filePath) => {
		return global.iconScheduler.schedule(filePath, async () => {
			try {
				const iconB64 = await global.getIcon(filePath);
				iconResults[filePath] = iconB64;
			} catch (error) {
				iconResults[filePath] = null;
			}
		});
	});

	// 等待所有任务完成
	await Promise.all(tasks);

	return iconResults;
}

// 判断文件是否应该使用相框显示
async function shouldUseFrame(filePath) {
	try {
		// 检查是否为文件夹
		let isDirectory = false;
		let mtimeMs = 0;
		try {
			const st = fs.statSync(filePath);
			isDirectory = st.isDirectory();
			mtimeMs = st.mtimeMs;
			if (isDirectory) {
				// 文件夹始终使用图标框显示
				return false;
			}
		} catch { }

		// 构建缓存键：文件路径 + mtime
		const cacheKey = `${filePath}:${mtimeMs}`;

		// 检查内存缓存
		const cachedResult = shouldUseFrameCache.get(cacheKey);
		if (cachedResult) {
			return cachedResult.result;
		}

		const ext = path.extname(filePath).toLowerCase();

		// 纯文本文件，使用文本胶片相框
		if (TEXT_EXTS.has(ext) || isPlainTextFile(filePath)) {
			shouldUseFrameCache.set(cacheKey, { result: true, timestamp: Date.now() });
			return true;
		}

		// 获取媒体信息（非媒体文件会返回 null）
		const info = await getMediaInfo(filePath, mtimeMs);
		if (!info) {
			shouldUseFrameCache.set(cacheKey, { result: false, timestamp: Date.now() });
			return false;
		}

		// 简单格式的静态图片，直接使用相框
		const simpleFormats = [".png", ".jpg", ".jpeg", ".svg", ".ico"];
		if (simpleFormats.includes(ext) && info.isStaticImage && !info.needsConversion) {
			shouldUseFrameCache.set(cacheKey, { result: true, timestamp: Date.now() });
			return true;
		}

		// 视频或动画，需要 FFmpeg
		if (info.type === "video" || info.type === "animated_image") {
			const result = !!global.ffmpegPath();
			shouldUseFrameCache.set(cacheKey, { result, timestamp: Date.now() });
			return result;
		}

		// 其他需要转换的格式，需要 FFmpeg
		if (info.needsConversion) {
			const result = !!global.ffmpegPath();
			shouldUseFrameCache.set(cacheKey, { result, timestamp: Date.now() });
			return result;
		}

		// 默认使用图标框
		shouldUseFrameCache.set(cacheKey, { result: false, timestamp: Date.now() });
		return false;
	} catch (error) {
		return false;
	}
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

	const fsPath = docUri ? docUri.fsPath : null;
	const baseDir = fsPath ? path.dirname(fsPath) : process.cwd();
	const abs = geq().resolveNavPath(clean, baseDir);
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
		// 处理图标框的特殊情况
		if (pxHeight === -1) {
			const config = vscode.workspace.getConfiguration("editor");
			const fontSize = Number(config.get("fontSize", 14)) || 14;
			// 图标框空行数根据字号调整
			let n;
			if (fontSize <= 9) {
				n = 4;  // 字号 6-9
			} else if (fontSize <= 15) {
				n = 3;  // 字号 10-15
			} else {
				n = 2;  // 字号 16+
			}
			if (isLastItem) n = Math.max(n, 2);
			return n;
		}

		const config = vscode.workspace.getConfiguration("editor");
		const fontSize = Number(config.get("fontSize", 14)) || 14;
		const lineHeightRaw = Number(config.get("lineHeight", 0)) || 0;

		let pxPerLine;
		if (lineHeightRaw > 0) {
			// 用户显式配置了 lineHeight
			if (lineHeightRaw < 8) pxPerLine = fontSize * lineHeightRaw;
			else pxPerLine = lineHeightRaw;
		} else {
			// ★ P0修复：基于实测数据的动态行高倍率
			// VSCode 实际行高在不同字号下表现不同：
			// - 小字号(6-8): 倍率 ~1.2
			// - 中等字号(9-20): 倍率 ~1.37
			// - 大字号(20+): 倍率回归 ~1.2
			let ratio;
			if (fontSize <= 6) {
				ratio = 1.19;
			} else if (fontSize <= 8) {
				ratio = 1.22;
			} else if (fontSize <= 20) {
				ratio = 1.37;
			} else {
				ratio = 1.2;
			}
			pxPerLine = fontSize * ratio;
		}

		// 钳制：防止异常配置
		pxPerLine = Math.max(pxPerLine, 10);

		// 计算相框实际高度（包括边框）
		const boxH = pxHeight + PREVIEW_BORDER;
		let n = Math.round(boxH / pxPerLine);

		// extreme 模式可进一步减少
		if (performanceMode === "extreme") {
			n = Math.max(1, n - 1);
		}

		n = Math.max(1, n);
		if (isLastItem) n = Math.max(2, n);
		return n;
	} catch (e) {
		return 8;
	}
}

// ★★★ 统一的空行计算函数 ★★★
// 粘贴和 weave 都使用这个函数，保证结果一致
async function calculateRequiredBlankLines(filePath, isLastItem = false) {
	try {
		// 使用 shouldUseFrame 作为唯一的判断来源
		const useFrame = await shouldUseFrame(filePath);

		if (!useFrame) {
			// 图标框：使用 -1 特殊标记
			return calculateBlankLinesExact(-1, isLastItem);
		}

		// 相框：获取实际高度
		let pxHeight = LARGE_PREVIEW_HEIGHT;
		try {
			let mtimeMs = 0;
			try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { }
			const info = await getMediaInfo(filePath, mtimeMs || Date.now());
			const { height } = getFrameConfig(info);
			pxHeight = height;
		} catch { }

		return calculateBlankLinesExact(pxHeight, isLastItem);
	} catch (e) {
		// 默认图标框
		return calculateBlankLinesExact(-1, isLastItem);
	}
}

function getEditorId(editor) {
	const docUri = editor.document.uri.toString();
	const viewColumn = editor.viewColumn ?? 0;
	return `${docUri}::${viewColumn}`;
}

// ==================== 主渲染逻辑 ====================
async function renderImages(editor) {
	if (!editor) return;
	if (!global.isValid()) {
		geq().logMessage(`renderImages: Integrity is invalid, skipping.`, "WARN");
		clearDecorations();
		return;
	}

	const myVersion = ++currentRenderVersion;

	if (!decorationType)
		decorationType = vscode.window.createTextEditorDecorationType({
			isWholeLine: false,
			gutterIconSize: 'contain'
		});

	if (!markerHideType)
		markerHideType = vscode.window.createTextEditorDecorationType({
			textDecoration: "none; font-size: 11px; color: transparent; opacity: 0;",
		});

	const docUri = editor.document.uri.toString();
	if (!documentDecorationsMap.has(docUri)) documentDecorationsMap.set(docUri, new Map());

	const currentDecos = documentDecorationsMap.get(docUri);
	const visibleRanges = editor.visibleRanges;
	if (!visibleRanges?.length) return;

	const marginLeft = "100px";
	const pathRegex = geq().createPathRegex();

	const tasks = [];
	const newHideRanges = [];
	const iconPaths = []; // 收集需要获取图标的文件路径
	const renderInfos = []; // 收集渲染信息，用于后续处理

	// 第一阶段：同步扫描，快速隐藏（仅对支持渲染的路径隐藏，避免“隐藏了但不渲染”的空洞）
	for (const range of visibleRanges) {
		const text = editor.document.getText(range);
		const rangeOffset = editor.document.offsetAt(range.start);

		pathRegex.lastIndex = 0;
		let match;

		while ((match = pathRegex.exec(text))) {
			const offset = rangeOffset + match.index;
			const pos = editor.document.positionAt(offset);
			const endPos = editor.document.positionAt(offset + match[0].length);

			const rawPath = (match[1] || "").trim();
			if (!rawPath) continue;

			const absPath = resolvePathToAbsolute(editor.document.uri, rawPath);

			let shouldHide = false;
			let st = null;
			if (absPath) {
				try {
					st = fs.statSync(absPath);
					// 文件夹和支持的媒体文件都需要隐藏原始文本
					if (!st.isDirectory()) {
						if (isSupportedMedia(absPath) || process.platform === 'win32') {
							shouldHide = true;
						}
					} else {
						// 文件夹也需要隐藏原始文本
						shouldHide = true;
					}
				} catch { }
			}

			// ★ 缓存键只用位置，但存储 mtime 用于检测变化
			const uniqueKey = `${pos.line}_${pos.character}`;
			const currentMtime = st ? Math.floor(st.mtimeMs) : 0;

			if (shouldHide) {
				newHideRanges.push(new vscode.Range(pos, endPos));
				// ★ 方案 q 核心：检查 mtime 是否变化，变化则删除旧缓存
				const cachedDeco = currentDecos.get(uniqueKey);
				if (cachedDeco && cachedDeco._mtime !== currentMtime) {
					currentDecos.delete(uniqueKey); // mtime 变了，强制重新渲染
				}
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
			const contentId = geq().computeFingerprint(absPath);
			if (!contentId) continue;

			const isDirectory = st.isDirectory();
			// 严格控制探测范围：
			// 1. 文件夹不进行媒体探测，直接走图标渲染
			// 2. 只有真正的媒体格式才进入 FFprobe 逻辑
			// 3. Windows 下非媒体文件（exe/lnk）直接走图标流程，不准碰 FFprobe
			if (!isDirectory && !isSupportedMedia(absPath)) {
				if (process.platform !== 'win32') continue;
				// Windows 下的非媒体文件，仅允许走图标渲染，严禁 FFprobe
			}

			// 收集渲染信息（包括文件夹）
			renderInfos.push({
				absPath,
				uniqueKey,
				anchorRange,
				contentId,
				isDirectory,
				mtime: currentMtime  // ★ 方案 q：存储 mtime
			});

			// 在Windows上，收集需要获取图标的文件路径（包括文件夹）
			if (process.platform === 'win32') {
				iconPaths.push(absPath);
			}
		}
	}

	// 批量获取图标
	let iconResults = {};
	if (process.platform === 'win32' && iconPaths.length > 0) {
		iconResults = await batchGetIcons(iconPaths);
	}

	// 第二阶段：创建渲染任务
	for (const renderInfo of renderInfos) {
		const { absPath, uniqueKey, anchorRange, contentId, isDirectory, mtime } = renderInfo;

		tasks.push(async () => {
			if (currentRenderVersion !== myVersion) return null;

			try {
				const ext = path.extname(absPath).toLowerCase();
				const isVidOrImg = isImageOrVideoExt(ext);
				const isText = !isVidOrImg && isPlainTextFile(absPath);

				// 从批量获取的结果中获取图标
				let iconB64 = iconResults[absPath] || null;

				// 文件夹始终支持渲染（使用图标）
				const isSupported = isDirectory || isVidOrImg || isText;

				let previewWidth = LARGE_PREVIEW_WIDTH;
				let previewHeight = LARGE_PREVIEW_HEIGHT;
				let previewResult = null;

				if (isSupported) {
					// 文件夹始终支持渲染（使用图标），但不需要预览
					if (!isDirectory) {
						let info = null;
						if (!isText) {
							// 需要探测的媒体文件
							let mtimeMs = 0;
							try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }
							info = await getMediaInfo(absPath, mtimeMs);

							const fc = getFrameConfig(info);
							previewWidth = fc.width;
							previewHeight = fc.height;
						} else {
							// 文本文件：直接走配置定义的相框尺寸，禁止探测
							const fc = getFrameConfig(null);
							previewWidth = fc.width;
							previewHeight = fc.height;
						}

						previewResult = await getPreviewBuffer(absPath, contentId, previewWidth, previewHeight);
					}
				}

				if (currentRenderVersion !== myVersion) return null;

				// 如果既没有预览也没有图标，就不渲染
				if (!previewResult && !iconB64) return null;

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

				// 如果没有预览但有图标，使用图标作为预览
				if (!contentUrl && iconB64) {
					contentUrl = `url("data:image/png;base64,${iconB64}")`;
					previewWidth = 32;
					previewHeight = 32;
					outputSize = { width: 32, height: 32 };
				}

				// 设置 Gutter 图标
				if (iconB64) {
					deco.renderOptions.gutterIconPath = vscode.Uri.parse('data:image/png;base64,' + iconB64);
					deco.renderOptions.gutterIconSize = "contain";
				}

				if (!contentUrl) return null;

				const boxWidth = previewWidth + PREVIEW_BORDER;
				const boxHeight = previewHeight + PREVIEW_BORDER;

				let progressBarUrl = null;
				if (webpDuration > 0.1 && performanceMode === "optmum")
					progressBarUrl = `url("${createProgressSvg(webpDuration, previewWidth)}")`;

				// 根据相框大小选择水印
				let selectedWatermark = null;
				if (previewWidth === LARGE_PREVIEW_WIDTH && previewHeight === LARGE_PREVIEW_HEIGHT) {
					selectedWatermark = largeWatermarkBase64;
				} else if (previewWidth === SMALL_PREVIEW_WIDTH && previewHeight === SMALL_PREVIEW_HEIGHT) {
					selectedWatermark = smallWatermarkBase64;
				}

				deco.renderOptions.after = buildAfterStyle({
					marginLeft,
					boxWidth,
					boxHeight,
					previewWidth,
					previewHeight,
					contentUrl,
					outputSize,
					progressBarUrl,
					watermarkBase64: selectedWatermark,
				});

				deco.hoverMessage = new vscode.MarkdownString(`[打开文件](${vscode.Uri.file(absPath).toString()})`);
				deco.hoverMessage.isTrusted = true;

				return { key: uniqueKey, deco, mtime };  // ★ 方案 q：返回 mtime
			} catch (e) {
				return null;
			}
		});
	}

	if (markerHideType) {
		if (newHideRanges.length > 0) {
			editor.setDecorations(markerHideType, newHideRanges);
		} else {
			editor.setDecorations(markerHideType, []);
		}
	}

	if (tasks.length > 0) {
		const chunkResults = await Promise.all(tasks.map((t) => t()));
		if (currentRenderVersion !== myVersion) return;
		if (!decorationType) return;

		for (const res of chunkResults) {
			if (res) {
				res.deco._mtime = res.mtime;  // ★ 方案 q：存储 mtime 用于下次检测变化
				currentDecos.set(res.key, res.deco);
			}
		}
	}

	if (decorationType) {
		editor.setDecorations(decorationType, Array.from(currentDecos.values()));
	}
}

// ==================== 粘贴命令 ====================

// 格式化结果为文本（复用原 replacePendingMarker 逻辑）
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
					if (block.fingerprint) geq().prefillFingerprint(filePath, block.fingerprint);
					const relPath = geq().toSafePath(path.relative(docDir, filePath));
					const isLastItem = i === blocks.length - 1;

					// ★ 使用统一的空行计算函数
					let gapBelow = await calculateRequiredBlankLines(filePath, isLastItem);
					// 对于非最后一个项目，减1以抵消join添加的额外换行符
					if (!isLastItem) gapBelow = Math.max(gapBelow - 1, 0);
					finalContent.push(`/\\${relPath}\\/\n${gapBelow ? eol.repeat(gapBelow) : ""}`);
					invalidateFolderSizeCacheForPath(filePath);
				}
			}
		}
		replacement = finalContent.join(eol);
	} else if (result.type === "image" || result.type === "ikge") {
		const filePath = result.path;
		if (result.fingerprint) geq().prefillFingerprint(filePath, result.fingerprint);
		const relPath = geq().toSafePath(path.relative(docDir, filePath));
		// ★ 使用统一的空行计算函数
		const gapBelow = await calculateRequiredBlankLines(filePath, true);
		replacement = `/\\${relPath}\\/\n` + eol.repeat(gapBelow);
		invalidateFolderSizeCacheForPath(filePath);
	} else if (result.type === "file" || result.type === "file_folder") {
		const files = result.files || [];
		const folders = result.folders || [];
		const fingerprints = result.fingerprints || {};

		for (let i = 0; i < folders.length; i++) {
			const folderPath = folders[i];
			const relPath = geq().toSafePath(path.relative(docDir, folderPath));
			const isLastItem = i === folders.length - 1 && files.length === 0;
			// ★ 使用统一的空行计算函数（文件夹始终是图标框）
			let gapBelow = await calculateRequiredBlankLines(folderPath, isLastItem);

			if (!isLastItem) gapBelow = Math.max(gapBelow - 1, 0);
			replacement += `/\\${relPath}\\/\n${eol.repeat(gapBelow)}`;
			invalidateFolderSizeCacheForPath(folderPath);
		}

		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			let fp = fingerprints[f];
			if (!fp) {
				const tryKey = process.platform === 'win32' ? f.replace(/\//g, '\\') : f;
				fp = fingerprints[tryKey];
			}
			if (fp) geq().prefillFingerprint(f, fp);

			const relPath = geq().toSafePath(path.relative(docDir, f));
			const isLastItem = i === files.length - 1 && folders.length === 0;

			// ★ 使用统一的空行计算函数
			let gapBelow = await calculateRequiredBlankLines(f, isLastItem);
			if (!isLastItem) gapBelow = Math.max(gapBelow - 1, 0);

			if (i > 0 || folders.length > 0) replacement += eol;
			replacement += `/\\${relPath}\\/\n`;
			replacement += eol.repeat(gapBelow);
			invalidateFolderSizeCacheForPath(f);
		}
	} else if (result.type === "folder_text") {
		const folders = result.text.split(/\r?\n/).filter(f => f.trim());
		for (let i = 0; i < folders.length; i++) {
			const folderPath = folders[i];
			const relPath = path.relative(docDir, folderPath).replace(/\\/g, "/");
			const isLastItem = i === folders.length - 1;
			// ★ 使用统一的空行计算函数
			let gapBelow = await calculateRequiredBlankLines(folderPath, isLastItem);
			if (!isLastItem) gapBelow = Math.max(gapBelow - 1, 0);
			replacement += `/\\${relPath}\\/\n${eol.repeat(gapBelow)}`;
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
		const doc = await vscode.workspace.openTextDocument(uri);
		const text = doc.getText();
		const idx = text.indexOf(anchor);

		if (idx === -1) {
			return false;
		}

		const pos = doc.positionAt(idx);
		const endPos = doc.positionAt(idx + anchor.length);
		const range = new vscode.Range(pos, endPos);

		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, range, newText);

		return await vscode.workspace.applyEdit(edit);
	} catch (e) {
		console.error("Replace Anchor Failed:", e);
		return false;
	}
}

async function performCurvedPaste(editor, targetDir, typeInfo, preComputedResult = null) {
	const filePath = editor.document.uri.fsPath;
	const taskNum = await TaskCounter.increment(filePath);
	const iconNum = await TaskCounter.incrementIcon();
	const transId = TransactionManager.createTransactionId();
	const taskTitle = TaskCounter.formatTitle(filePath, transId, iconNum);
	const anchor = `/__PENDING_${transId}/`;

	const success = await TransactionManager.insertAnchor(editor, transId);
	if (!success) return;

	const docUri = editor.document.uri;

	let taskType = 'local_file';
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
		taskType: taskType,
		intentTotalSize: intentTotalSize,
		existingFiles: await global.getDirectorySnapshot(targetDir)
	});

	const taskStartTime = Date.now();

	const anchorLostSource = new vscode.CancellationTokenSource();
	let anchorLost = false;
	let lastAnchorCheckTime = 0;
	const ANCHOR_CHECK_INTERVAL = 800;

	const checkAnchorExists = async () => {
		if (anchorLost) return false;

		const now = Date.now();
		if (now - lastAnchorCheckTime < ANCHOR_CHECK_INTERVAL) {
			return true;
		}
		lastAnchorCheckTime = now;

		try {
			const doc = await vscode.workspace.openTextDocument(docUri);
			const text = doc.getText();
			const exists = text.includes(anchor);

			if (!exists && !anchorLost) {
				anchorLost = true;
				global.logMessage(q('q1.log.anchorLost', anchor), 'WARN');
				anchorLostSource.cancel();
				return false;
			}
			return exists;
		} catch (e) {
			if (!anchorLost) {
				anchorLost = true;
				global.logMessage(q('q1.log.anchorReadError', e.message), 'WARN');
				anchorLostSource.cancel();
			}
			return false;
		}
	};

	vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: taskTitle,
		cancellable: true
	}, async (progress, token) => {
		const isCancelled = () => token.isCancellationRequested || anchorLostSource.token.isCancellationRequested;

		try {
			let result = await h.autoDetectAndPaste(targetDir, async (p, msg) => {
				progress.report({ increment: p, message: msg });
				await checkAnchorExists();
			}, token, transId, null, null, () => anchorLost);

			if (result && result.type === 'video_url') {
				await TransactionManager.updateTransaction(transId, { taskType: 'video' });

				try {
					const vc = new Qvideo(extensionContext);
					const downloadRes = await vc.downloadEntry(
						result.url,
						targetDir,
						transId,
						async (p, msg) => {
							progress.report({ increment: 0, message: msg });
							await checkAnchorExists();
						},
						token,
						null,
						taskTitle,
						() => anchorLost,
						taskNum
					);

					if (downloadRes && downloadRes.landedFiles && downloadRes.landedFiles.length > 0) {
						result = {
							type: 'file',
							files: downloadRes.landedFiles,
							fingerprints: {}
						};
					} else {
						result = null;
					}
				} catch (e) {
					console.error("Video Download Failed:", e);
					result = null;
				}
			}

			if (isCancelled()) {
				const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
				if (trans) await TransactionManager.rollback(trans);
				await replaceAnchorInDoc(docUri, anchor, "");

				if (anchorLost) {
					TaskMessage.showSimpleToast(`${taskTitle} 锚点丢失，已回滚`, 15000, 'cancel');
				} else {
					TaskMessage.showSimpleToast(`${taskTitle} 已取消并回滚`, 15000, 'cancel');
				}
				return;
			}

			if (result) {
				const mockEditor = {
					document: {
						uri: docUri,
						eol: editor.document.eol
					}
				};

				const newText = await formatResultToText(result, mockEditor, taskTitle, transId, taskStartTime, token);

				if (newText) {
					const replaced = await replaceAnchorInDoc(docUri, anchor, newText);

					if (replaced) {
						await TransactionManager.removeTransaction(transId);

						let totalSizeForStats = 0;
						if (result.type !== 'image') {
							const elapsedMs = Date.now() - taskStartTime;
							let detail = '';

							if (result.type === 'html_blocks' || result.type === 'skeleton') {
								// HTML粘贴：统计成功落地的媒体文件数量和总大小
								const mediaBlocks = result.blocks?.filter(b => b.type === 'media' && b.status === 'ok') || [];
								const mediaCount = mediaBlocks.length;
								// 计算总大小
								const totalSize = mediaBlocks.reduce((sum, block) => sum + (block.size || 0), 0);
								totalSizeForStats = totalSize;
								// 格式化大小显示
								let sizeStr = '';
								if (totalSize > 0) {
									if (totalSize < 1024) {
										sizeStr = `${totalSize}b`;
									} else if (totalSize < 1048576) {
										sizeStr = `${(totalSize / 1024).toFixed(1)}k`;
									} else {
										sizeStr = `${(totalSize / 1048576).toFixed(1)}m`;
									}
								}
								detail = `共落盘${mediaCount}个文件${sizeStr ? ` ${sizeStr}` : ''}`;
								// 如果有baseUrl，添加来源信息
								if (result.baseUrl) {
									// 截断URL以保持消息简洁
									const urlSnippet = result.baseUrl.length > 33 ? result.baseUrl.substring(0, 33) + '...' : result.baseUrl;
									detail += `，从 ${urlSnippet}`;
								}
							} else {
								// 文件/文件夹粘贴：原逻辑
								const totalCount = (result.files?.length || 0) + (result.folders?.length || 0);
								const skippedCount = result.skippedCount || 0;
								detail = `文件/文件夹已复制 ${totalCount}`;
								if (skippedCount > 0) {
									detail += ` (跳过 ${skippedCount}个无法访问)`;
								}

								// 尝试从 snapshot 或结果中获取总大小
								if (result.totalSize) {
									totalSizeForStats = result.totalSize;
								} else if (typeInfo && typeInfo.totalSize) {
									totalSizeForStats = typeInfo.totalSize;
								} else if (result.files) {
									for (const f of result.files) {
										try { totalSizeForStats += fs.statSync(f).size; } catch { }
									}
								}
							}
							const msg = TaskMessage.done(taskTitle, detail, elapsedMs, taskNum);
							TaskMessage.showSimpleToast(msg, 15000, 'success');
						} else {
							// 图片粘贴：统计落盘后的真实大小
							if (result.path) {
								try { totalSizeForStats = fs.statSync(result.path).size; } catch { }
							}
						}

						// ★ 统一上报统计
						if (taskType === 'video') {
							saveVideoStats(totalSizeForStats);
						} else {
							savePasteStats(totalSizeForStats);
						}
					} else {
						const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
						if (trans) await TransactionManager.rollback(trans);
						TaskMessage.showSimpleToast(`${taskTitle} 锚点丢失，已回滚`, 15000, 'cancel');
					}
				} else {
					const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
					if (trans) await TransactionManager.rollback(trans);
					await replaceAnchorInDoc(docUri, anchor, "");
					TaskMessage.showSimpleToast(`${taskTitle} 处理失败，已回滚`, 15000, 'cancel');
				}
			} else {
				const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
				if (trans) await TransactionManager.rollback(trans);
				await replaceAnchorInDoc(docUri, anchor, "");
			}
		} catch (e) {
			console.error(e);
			const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
			if (trans) await TransactionManager.rollback(trans);
			await replaceAnchorInDoc(docUri, anchor, "");
			TaskMessage.showSimpleToast(`${taskTitle} 发生异常，已回滚`, 15000, 'cancel');
		}
	});
}

async function executeClipboardCommand() {
	if (!global.isValid()) {
		global.showAutoCloseNotification('error', "Integrity check failed.");
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	if (editor.document.isUntitled) {
		// 先用 wq() 判断剪贴板内容类型
		const snapshot = await wq();
		// 只有当内容不是纯文本时才弹出提示框
		if (snapshot.type !== 'whitelist') {
			global.showAutoCloseNotification('info', "qqq: 只能使用原始粘贴。解决方案：保存文件。");
		}
		await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
		return;
	}

	if (!global.hasRecovered) {
		global.hasRecovered = true;
		TransactionManager.recover().catch(e => console.error(e));
	}

	const currentDocDir = path.dirname(editor.document.uri.fsPath);
	const targetDir = path.join(currentDocDir, "qqq");
	// ★ 不在此处创建 qqq 文件夹！由 h.js ensureDir 在实际写文件时按需创建
	// 避免纯文本粘贴产生空 qqq 文件夹

	const snapshot = await wq();
	const config = getConfig('transactionLevel') || 'full';

	let mode = 'a';

	const FILE_COUNT_THRESHOLD = 100;

	if (snapshot.type === 'whitelist') {
		mode = 'q';
	} else {
		if (config === 'half') {
			if (snapshot.subType === 'image') {
				mode = 'q';
			} else if (snapshot.subType === 'file') {
				const fileCount = snapshot.files?.length || 0;
				if (snapshot.totalSize < 80 * 1048576 && fileCount < FILE_COUNT_THRESHOLD) {
					mode = 'q';
				}
			}
		}
	}

	if (mode === 'q') {
		await h.autoDetectAndPaste(targetDir, null, null, null, snapshot).then(async (result) => {
			if (result && result.type === 'video_url') {
				await performCurvedPaste(editor, targetDir, snapshot, result);
				return;
			}

			const newText = await formatResultToText(result, editor);
			if (!newText) return;

			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor || activeEditor.document.uri.toString() !== editor.document.uri.toString()) return;

			await activeEditor.edit((editBuilder) => {
				editBuilder.replace(activeEditor.selection, newText);
			});

			// ★ 统计简单粘贴
			if (result) {
				let size = 0;
				if (result.type === 'text') {
					size = Buffer.byteLength(result.text || '', 'utf8');
				} else if (result.totalSize) {
					size = result.totalSize;
				} else if (result.type === 'image' && result.path) {
					try { size = fs.statSync(result.path).size; } catch { }
				} else if ((result.type === 'file' || result.type === 'file_folder') && result.files) {
					for (const f of result.files) {
						try { size += fs.statSync(f).size; } catch { }
					}
				} else if (snapshot && snapshot.totalSize) {
					size = snapshot.totalSize;
				}
				savePasteStats(size);
			}

			debounceRender(activeEditor, 10);
		});
	} else {
		await performCurvedPaste(editor, targetDir, snapshot);
	}
}

// ==================== 整洁模式 ====================
async function provideCleanlinessEditsAsync(document, mode = null) {
	if (!document) return [];
	// 如果没有指定 mode，使用全局配置
	const effectiveMode = mode || cleanFreakMode;
	const allowRemove = effectiveMode === "add & remove";

	const edits = [];
	const text = document.getText();
	const regex = geq().createPathRegex();
	const eol = getDocumentEOL(document);
	let match;
	const markers = [];

	while ((match = regex.exec(text))) {
		markers.push({ text: match[0], index: match.index, inner: (match[1] || "").trim() });
	}

	// 从后往前处理，避免索引偏移问题
	for (let i = markers.length - 1; i >= 0; i--) {
		const m = markers[i];
		const startPos = document.positionAt(m.index);
		const endPos = document.positionAt(m.index + m.text.length);
		const markerLine = startPos.line;

		const rawPath = m.inner;
		const absPath = resolvePathToAbsolute(document.uri, rawPath);

		// 检查暗号前后是否有其他内容（需要换行分离）
		const lineObj = document.lineAt(markerLine);
		const lineContent = lineObj.text;
		if (startPos.character > 0) {
			edits.push({ range: new vscode.Range(startPos, startPos), newText: eol });
		}
		const suffix = lineContent.substring(endPos.character);
		if (suffix.trim().length > 0) {
			edits.push({ range: new vscode.Range(endPos, endPos), newText: eol });
		}

		// 计算所需空行数
		const isLastMarkerInDoc = i === markers.length - 1;
		let neededLines = 0;

		if (absPath && fs.existsSync(absPath)) {
			// ★ 使用统一的空行计算函数
			neededLines = await calculateRequiredBlankLines(absPath, isLastMarkerInDoc);
			// 对于非最后一个标记，减1以与粘贴体验一致
			if (!isLastMarkerInDoc) neededLines = Math.max(neededLines - 1, 0);
		}

		// 统计当前已有的空行数
		let existingBlanks = 0;
		for (let lineIdx = markerLine + 1; lineIdx < document.lineCount; lineIdx++) {
			if (document.lineAt(lineIdx).text.trim() === "") existingBlanks++;
			else break;
		}

		// 根据模式决定是否需要修改空行
		if (existingBlanks < neededLines) {
			// 空行不足，需要添加
			const linesToAdd = neededLines - existingBlanks;
			const lineEndPos = lineObj.range.end;
			edits.push({ range: new vscode.Range(lineEndPos, lineEndPos), newText: eol.repeat(linesToAdd) });
		} else if (allowRemove && existingBlanks > neededLines) {
			// 空行过多，需要删除（仅在 add & remove 模式）
			const linesToRemove = existingBlanks - neededLines;
			const removeStartLine = markerLine + 1 + neededLines;
			const removeEndLine = removeStartLine + linesToRemove;
			const removeStart = new vscode.Position(removeStartLine, 0);
			const removeEnd = new vscode.Position(removeEndLine, 0);
			edits.push({ range: new vscode.Range(removeStart, removeEnd), newText: "" });
		}
	}
	return edits;
}

async function performGlobalClean(editor, force = false, mode = null) {
	if (!editor) return;
	if (!force && cleanFreakMode === "never") return;
	try {
		// 检查编辑器是否仍然有效
		if (!vscode.window.visibleTextEditors.includes(editor)) return;
		// 如果没指定 mode，使用全局配置
		const edits = await provideCleanlinessEditsAsync(editor.document, mode);
		if (edits.length > 0) {
			// ★ 按位置排序并过滤重叠的编辑
			edits.sort((a, b) => {
				const cmp = a.range.start.compareTo(b.range.start);
				if (cmp !== 0) return cmp;
				return a.range.end.compareTo(b.range.end);
			});
			// 过滤重叠的编辑（保留第一个）
			const filteredEdits = [];
			let lastEnd = null;
			for (const e of edits) {
				if (lastEnd && e.range.start.isBefore(lastEnd)) {
					// 重叠，跳过
					continue;
				}
				filteredEdits.push(e);
				lastEnd = e.range.end;
			}
			if (filteredEdits.length > 0) {
				await editor.edit((editBuilder) => {
					filteredEdits.forEach((e) => {
						editBuilder.replace(e.range, e.newText);
					});
				});
			}
		}
	} catch (e) {
		global.logMessage(`performGlobalClean failed: ${e.message}`, "WARN");
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
		if (!global.isValid() || codelensLevel === "0") return [];
		const lenses = [];
		const regex = geq().createPathRegex();
		const text = document.getText();
		let match;

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);

			const rawPath = (match[1] || "").trim();
			if (!rawPath) continue;

			const absPath = resolvePathToAbsolute(document.uri, rawPath);
			if (!absPath) continue;

			let st = null;
			try {
				st = fs.statSync(absPath);
			} catch {
				continue;
			}

			const folder = path.dirname(absPath);
			const ext = path.extname(absPath).toLowerCase();
			const isDirectory = st.isDirectory();
			const isVidOrImg = isImageOrVideoExt(ext);
			const isText = !isVidOrImg && !isDirectory && isPlainTextFile(absPath);

			const targetLensLine = pos.line;
			const r = new vscode.Range(targetLensLine, 0, targetLensLine, 0);

			let fileSz = global.formatBytes(st.size);
			let tooltipText = `创建: ${new Date(st.birthtime).toLocaleString()}\n修改: ${new Date(st.mtime).toLocaleString()}`;
			let mtimeMs = st.mtimeMs;

			if (codelensLevel === "3") {
				let folderData = geqFolderSizeSync(folder);
				let fSizeStr;
				let folderTooltip;

				if (folderData) {
					fSizeStr = global.formatBytes(folderData.size || 0);
					folderTooltip = folderData.summary;
				} else {
					fSizeStr = "●";
					folderTooltip = "正在计算文件夹大小...";
					fetchFolderSizeFirstTime(folder); // 首次加载时扫描一次
				}

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
			}

			let titleSuffix = "";
			let iconPart = "";
			let spacePart = "   ";

			if (isDirectory) {
				iconPart = " 📁";
				spacePart = "";
			} else if (isVidOrImg) {
				const info = await getMediaInfo(absPath, mtimeMs);
				if (info?.width && info?.height) {
					const { width: MAX_W, height: MAX_H } = getFrameConfig(info);
					const isRealVideo = info.type === "video";
					if (isRealVideo) {
						iconPart = "🎬";
						spacePart = "";
					}
					const { scale } = fitIntoBox(info.width, info.height, MAX_W, MAX_H, enlargeSmallImages);
					const pct = Math.round(scale * 100);
					titleSuffix = `   (${pct}%)  ${info.width}x${info.height}`;

					const displayCodec = info.full_codec_desc || info.codec;
					if (displayCodec) tooltipText += `\n编码: ${displayCodec}`;

					const arStr = calculateAspectRatioString(info.width, info.height);
					if (arStr) tooltipText += `\n宽高比：${arStr}`;

					if (geq().shouldShowDuration(info)) tooltipText += `\n⌛原始时长：${formatDuration(info.duration)}`;
				}
			} else if (isText) {

				iconPart = " 📄";
				spacePart = "";
			}

			let titlePrefix = "✎";
			if (codelensLevel === "1") {
				titlePrefix = "";
			}

			lenses.push(
				new vscode.CodeLens(r, {
					title: `${titlePrefix}( ${fileSz})${iconPart}${spacePart}${absPath}${titleSuffix}`,
					command: "qqq.openFile",
					arguments: [absPath],
					tooltip: tooltipText,
				})
			);

			// 只对文本文件显示✎qode按钮，且仅在codelensLevel为3时
			if (codelensLevel === "3" && isText) {
				lenses.push(
					new vscode.CodeLens(r, {
						title: "✎qode",
						command: "qqq.openFileInRightGroup",
						arguments: [absPath],
						tooltip: "在右边分组打开文件并进入编辑状态",
					})
				);
			}
		}

		return lenses;
	}
}

// ★ 被动监听模式 + 首次加载扫描一次
const FOLDER_SIZE_SCAN_COOLDOWN = 15000; // 15秒扫描冷却时间
const _pendingFolderSizeRequests = new Map();
const _lastScanTime = new Map(); // 记录每个文件夹的上次扫描时间

// ★ 粘贴操作后调用：清除缓存并触发重新扫描
function invalidateFolderSizeCacheForPath(filePath) {
	try {
		const dir = path.dirname(filePath);
		// 清除缓存
		if (folderSizeCache.has(dir)) folderSizeCache.delete(dir);
		if (folderSizeCache.has(filePath)) folderSizeCache.delete(filePath);

		// ★ 简化逻辑：只检查冷却时间，不管之前有没有缓存
		if (dir) {
			const now = Date.now();
			const lastScan = _lastScanTime.get(dir) || 0;
			if (now - lastScan >= FOLDER_SIZE_SCAN_COOLDOWN) {
				fetchFolderSizeInternal(dir, true);
			}
		}
	} catch { }
}

// ★ 仅返回缓存，不触发扫描
function geqFolderSizeSync(folderPath) {
	const cached = folderSizeCache.get(folderPath);
	return cached ? cached.data : null;
}

// ★ 轻量检查：只检查文件夹 mtime 是否变化，变化则清除缓存
function checkFolderMtimeChanged(folderPath) {
	const cached = folderSizeCache.get(folderPath);
	if (!cached) return false; // 没有缓存，不需要检查

	try {
		const currentMtime = fs.statSync(folderPath).mtimeMs;
		if (cached.mtime !== currentMtime) {
			// mtime 变了，清除缓存
			folderSizeCache.delete(folderPath);
			return true;
		}
	} catch { }
	return false;
}

// ★ 首次加载时触发扫描（唯一的主动扫描）
function fetchFolderSizeFirstTime(folderPath) {
	if (folderSizeCache.has(folderPath)) return; // 已有缓存，不扫描
	// ★ 也要检查冷却时间，防止缓存被删后在冷却期内重复扫描
	const now = Date.now();
	const lastScan = _lastScanTime.get(folderPath) || 0;
	if (now - lastScan < FOLDER_SIZE_SCAN_COOLDOWN) return;
	fetchFolderSizeInternal(folderPath, false);
}

// ★ 内部扫描函数（带防重复）
function fetchFolderSizeInternal(folderPath, fromWatcher) {
	if (_pendingFolderSizeRequests.has(folderPath)) return;
	_pendingFolderSizeRequests.set(folderPath, true);
	_lastScanTime.set(folderPath, Date.now());

	// ★ 获取文件夹 mtime 用于后续轻量检查
	let folderMtime = 0;
	try { folderMtime = fs.statSync(folderPath).mtimeMs; } catch { }

	geq().getFolderInfo(folderPath).then(result => {
		_pendingFolderSizeRequests.delete(folderPath);
		if (result?.success) {
			const parts = [];
			let totalFiles = 0;
			if (result.ext_stats) {
				const sortedExts = Object.entries(result.ext_stats).sort(([, countA], [, countB]) => countB - countA);
				for (const [ext, count] of sortedExts) {
					totalFiles += count;
					parts.push(`${count}★ ${ext || "无后缀"}`);
				}
			}
			const summaryStr = parts.length > 0
				? `${totalFiles}个文件：${parts.join(";  ")}`
				: result.file_count_root > 0 ? `${result.file_count_root}个文件` : "空文件夹";
			const data = { size: result.total_size, summary: summaryStr };
			// ★ 存储 mtime 用于轻量检查
			folderSizeCache.set(folderPath, { data, timestamp: Date.now(), mtime: folderMtime });
			evictOldestEntries(folderSizeCache, FOLDER_SIZE_CACHE_MAX_ENTRIES);
			if (codeLensProvider) codeLensProvider.debouncedRefresh();
		}
	}).catch(() => {
		_pendingFolderSizeRequests.delete(folderPath);
	});
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

async function openFileInRightGroupCommand(filePath) {
	if (!fs.existsSync(filePath)) return;
	try {
		const uri = vscode.Uri.file(filePath);
		const doc = await vscode.workspace.openTextDocument(uri);
		// 确定右边的视图列
		let targetColumn = vscode.ViewColumn.Beside;

		// 检查是否有多个标签组
		if (vscode.window.tabGroups && vscode.window.tabGroups.all) {
			const allGroups = vscode.window.tabGroups.all;
			if (allGroups.length > 1) {
				// 找到最右边的标签组
				const sortedGroups = allGroups
					.filter(g => typeof g.viewColumn === "number")
					.sort((a, b) => a.viewColumn - b.viewColumn);
				targetColumn = sortedGroups[sortedGroups.length - 1].viewColumn;
			}
		}

		// 在目标列打开文件，确保进入编辑状态（preserveFocus: false）
		await vscode.window.showTextDocument(doc, {
			viewColumn: targetColumn,
			preserveFocus: false,
			preview: false
		});
	} catch (error) {
		global.logMessage(q('q1.log.openFileFailed', error.message), "ERROR");
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
		title: "重命名",
		prompt: " ",
		value: currentName,
		ignoreFocusOut: true,
		validateInput: (v) => {
			if (!v || !v.trim()) {
				return "文件名不能为空";
			}
			if (v.trim() === currentName) {
				return null;
			}
			const trimmed = v.trim();
			const newAbs = path.join(path.dirname(absPath), trimmed);
			try {
				fs.accessSync(newAbs);
				return "目标文件已存在";
			} catch (e) {
				return null;
			}
		},
	});
	if (!newName || newName.trim() === currentName) return;

	const trimmed = newName.trim();
	const newAbs = path.join(path.dirname(absPath), trimmed);

	try {
		await fs.promises.rename(absPath, newAbs);
	} catch (e) {
		global.showAutoCloseNotification('error', e.message);
		return;
	}

	const doc = editor.document;
	const newRaw = rawPath.includes("/")
		? rawPath.substring(0, rawPath.lastIndexOf("/") + 1) + trimmed
		: trimmed;

	const regex = geq().createPathRegex();
	const ranges = [];
	let m;
	while ((m = regex.exec(doc.getText()))) {
		const inner = (m[1] || "").trim();
		if (inner === rawPath) {
			ranges.push(new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)));
		}
	}
	if (ranges.length) {
		try {
			// 检查编辑器是否仍然有效
			if (!vscode.window.visibleTextEditors.includes(editor)) return;
			await editor.edit((b) => ranges.forEach((r) => b.replace(r, `
/\\${newRaw}\\/
`)));
		} catch (e) {
			global.logMessage(`renameFile edit failed: ${e.message}`, "WARN");
		}
	}

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

// ==================== Initialization ====================
async function activate(context) {
	if (!context) {
		global.logMessage("q1.activate: context is undefined!", "ERROR");
		return;
	}

	extensionContext = context;
	const extensionPath = context.extensionUri?.fsPath || context.extensionPath;

	if (!extensionPath) {
		global.logMessage("q1.activate: extensionPath is undefined!", "ERROR");
		return;
	}

	LARGE_WATERMARK_PATH = path.join(extensionPath, "assets", "al.png");
	SMALL_WATERMARK_PATH = path.join(extensionPath, "assets", "as.png");

	try {
		if (global.ConfigManager) global.ConfigManager.setContext(context);
	} catch (e) { }

	// 异步校验完整性，不阻塞启动
	global.verifySystemIntegrityAsync(context).then(valid => {
		const _qqq = geq();
		if (!valid) {
			if (_qqq) _qqq.logMessage(`Integrity: FAILED (LARGE_PATH=${LARGE_WATERMARK_PATH})`, "WARN");
			else global.logMessage(`Integrity: FAILED (LARGE_PATH=${LARGE_WATERMARK_PATH})`, "WARN");
			global.showAutoCloseNotification('warning', "核心文件不完整，部分功能可能受限");
		} else {
			if (_qqq) {
				_qqq.logMessage(`Integrity: PASSED`, "INFO");
				_qqq.logMessage(`FFmpeg Path: ${_qqq.ffmpegPath}`, "INFO");
			}
		}
	});

	await loadWatermarkResource();
	refreshConfig();
	codeLensProvider = new FileCodeLensProvider();

	// ★ 终极修复：通过 ConfigGate 回调机制获取配置更新通知（解决竞态问题）
	// 之前直接监听 onDidChangeConfiguration 会导致 refreshConfig() 在 sessionOverrides 更新前执行
	global.ConfigManager.onConfigUpdated((changedKeys, event) => {
		global.logMessage(q('q1.log.configUpdateCallback', changedKeys.join(', ')), "DEBUG");
		refreshConfig();
		clearDecorations();
		if (codeLensProvider) codeLensProvider.refresh();
		renderVisibleEditors(10);
		if (cleanFreakMode !== "never") performGlobalClean(vscode.window.activeTextEditor);
	});

	// ★ 终极最优解：注册权提升，严禁在注册前使用 await
	context.subscriptions.push(
		// ★ 只保留 editor 配置的监听（这些不涉及 ConfigGate）
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("editor.lineHeight")) {
				refreshConfig();
				if (cleanFreakMode !== "never") performGlobalClean(vscode.window.activeTextEditor);
			}
		}),
		vscode.commands.registerCommand("qqq.q1", global.withReady(executeClipboardCommand)),
		vscode.commands.registerCommand("qqq.openFile", global.withReady(openFileCommand)),
		vscode.commands.registerCommand("qqq.openFileInRightGroup", global.withReady(openFileInRightGroupCommand)),
		vscode.commands.registerCommand("qqq.revealFileInFolder", global.withReady(revealFileInFolder)),
		vscode.commands.registerCommand("qqq.renameFile", global.withReady(renameFileCommand)),
		vscode.commands.registerCommand("qqq.weave", global.withReady(() => {
			// weave 只增不减
			performGlobalClean(vscode.window.activeTextEditor, true, "add");
		})),
		vscode.commands.registerCommand("qqq.exportDoc", global.withReady(() => {
			q3.executeExportDocCommand(global.isValid());
		})),
		vscode.commands.registerCommand("qqq.exportZip", global.withReady(() => {
			q3.executeExportZipCommand(global.isValid());
		})),
		vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
		vscode.workspace.onWillSaveTextDocument((e) => {
			if (cleanFreakMode !== "never" && e.document) {
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
		// ★ 兜底机制：文档保存后检查同级目录的空 qqq 文件夹，确认是我们创建的则永久删除
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (!doc || doc.isUntitled || doc.uri.scheme !== 'file') return;
			try {
				const docDir = path.dirname(doc.uri.fsPath);
				h.cleanupEmptyQqqFolder(docDir);
			} catch { }
		}),
		vscode.window.onDidChangeActiveTextEditor((e) => {
			if (e) debounceRender(e);
		}),
		vscode.window.onDidChangeWindowState((e) => {
			if (e.focused) {
				// ★ 方案 q 轻量版：只检查文件夹 mtime，不主动扫盘
				let needRefresh = false;
				for (const [folderPath] of folderSizeCache) {
					if (checkFolderMtimeChanged(folderPath)) {
						needRefresh = true;
					}
				}
				if (needRefresh && codeLensProvider) {
					codeLensProvider.refresh();  // mtime 变了才刷新 CodeLens
				}
				// ★ 装饰器更新（通过 mtime 检查，不扫盘）
				for (const editor of vscode.window.visibleTextEditors) {
					renderImages(editor);
				}
			}
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
			if (cleanFreakMode !== "never") performGlobalClean(vscode.window.activeTextEditor);
		})
	);

	// ★ 终极最优解：异步恢复移至函数末尾，且使用后台执行模式
	(async () => {
		try {
			await TransactionManager.recover();
			global.hasRecovered = true;
		} catch (e) {
			global.logMessage(q('q1.log.transactionRecoverError', e.message), "ERROR");
			global.hasRecovered = true;
		}
	})();

	const editor = vscode.window.activeTextEditor;
	if (editor) renderImages(editor);
}

async function deactivate() {
	clearAllEditorDebounceTimers();
	clearDecorations();

	// ★ 清理定时器
	if (shouldUseFrameCleanupInterval) {
		clearInterval(shouldUseFrameCleanupInterval);
	}

	// ★ 清理所有缓存
	clearAllCaches();

	// 用户时长统计由 geq().js 中控统一管理
}

// 导出工具函数供其他模块使用
const q1Utils = {
	calculateBlankLinesExact,
	getMediaInfo,
	getFrameConfig,
	LARGE_PREVIEW_HEIGHT,
	PREVIEW_BORDER
};

module.exports = { activate, deactivate, ...q1Utils };


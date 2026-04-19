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

// Lazy-load qqq to avoid circular dependencies
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

// SHA256 hash values for the new watermarks
const LARGE_WATERMARK_HASH = "dd931dba64fd02a5fd683dd83692bc04311e4bc8ce5df5b44d64491fa1536cc7";
const SMALL_WATERMARK_HASH = "7e2d52d43e5383b8638026552dc4b01e84012643415916ffe745d047541c3c67";
// Deleted:let isCoreIntegrityValid = false;

// ==================== Configuration Constants ====================
const SCROLL_DEBOUNCE_MS = 200;

// ★★★ Cache generation baseline size (512x288) ★★★
const CACHE_BASE_WIDTH = 512;
const CACHE_BASE_HEIGHT = 288;

// UI display size configuration
const LARGE_PREVIEW_WIDTH = 512;
const LARGE_PREVIEW_HEIGHT = 288;
const SMALL_PREVIEW_WIDTH = 256;
const SMALL_PREVIEW_HEIGHT = 144;

const PREVIEW_BORDER = 6;
let PREVIEW_BG_COLOR = "#fef6e3";

// Text film (Plain Text preview) unified quality and cache key
// Goal: match the best-mode static output (q=71), and unify disk cache suffix as ".71"
const TEXT_PREVIEW_QUALITY = 71;
function getTextPreviewCacheKey() {
	const prefix = textSlideColorScheme === "dark" ? "d_" : "l_";
	return `${prefix}${textSlideFontSize}`;
}

// Text film: only store one large image on disk cache (514x290, key=71)
// The small frame only changes display scaling (width/height each 1/2 => area 1/4), no second cache is generated
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
const FALLBACK_MAX_SIZE = 4 * 1048576;   // Size limit for rendering ico images

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

// ==================== ★ a's Text Ext whitelist (copied as-is) ====================
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

// ==================== Global State ====================
let decorationType = null;
let markerHideType = null;
let extensionContext = null;
let currentRenderVersion = 0;

let codeLensProvider = null;

// ★★★ Auto-measured line height (measured by webview for precision) ★★★
let measuredPxPerLine = null;  // Cached measured value, null = not yet measured
let measurementPending = false;  // Prevent duplicate measurement requests
let measurementCallback = null;  // Callback to request measurement from q4 webview

const documentDecorationsMap = new Map();
const resolutionCache = new Map();
const RESOLUTION_CACHE_MAX_SIZE = 1000; // ★ Increased to 1000 entries
const folderSizeCache = new Map();
const FOLDER_SIZE_CACHE_MAX_ENTRIES = 500; // ★ Adjusted to 500 entries to match actual usage

const editorDebounceTimers = new Map();

let enlargeSmallImages = false;
let performanceMode = "optmum";
let frameSizeMode = "fix";
let cleanFreakMode = "add"; // "never" | "add" | "add & remove"

// ★ Helper function to get effective cleanFreakMode
function getEffectiveCleanFreakMode() {
	return cleanFreakMode;
}

let textSlideColorScheme = "light";
let textSlideFontSize = 14;
let codelensLevel = "3";

// Large/small frame watermarks
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

// ★ Local de-dup Map, fallback de-dup when genScheduler is unavailable
const _localGenPending = new Map();

async function scheduleGen(key, fn) {
	const _qqq = geq();
	const s = _qqq?.genScheduler;
	if (s && typeof s.schedule === "function") {
		return s.schedule(key, fn);
	}
	// ★ Fallback de-dup: even if genScheduler is unavailable, prevent duplicate calls
	if (_localGenPending.has(key)) {
		return _localGenPending.get(key);
	}
	const p = fn().finally(() => _localGenPending.delete(key));
	_localGenPending.set(key, p);
	return p;
}

// ==================== Initialization ====================

async function loadWatermarkResource() {
	// Load large frame watermark
	try {
		if (fs.existsSync(LARGE_WATERMARK_PATH)) {
			const buf = await fs.promises.readFile(LARGE_WATERMARK_PATH);
			largeWatermarkBase64 = "data:image/png;base64," + buf.toString("base64");
		}
	} catch (e) {
		largeWatermarkBase64 = null;
	}

	// Load small frame watermark
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
		// ★ Read config via ConfigGate (do not read settings.json directly)
		enlargeSmallImages = getConfig("enlargeSmallImages");
		if (enlargeSmallImages === undefined) enlargeSmallImages = false;

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
		enlargeSmallImages = false;
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

// ==================== Error Logging ====================
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
		);  // De-dup time for identical logs
	} catch { }
}

// ==================== CSS Computation Helpers ====================
function fitIntoBox(srcW, srcH, boxW, boxH, enlarge) {
	if (!srcW || !srcH) {
		// If width/height is unknown, we should not directly return full-screen, which would stretch.
		// We should keep a default ratio or display as-is.
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
	// If outputSize is unknown, use contain to preserve aspect ratio without stretching
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

// ==================== Cache Utility Functions ====================
// Generic FIFO cache eviction function
function evictOldestEntries(cacheMap, maxSize, evictionRatio = 0.25) {
	if (cacheMap.size > maxSize) {
		const keys = Array.from(cacheMap.keys());
		const deleteCount = Math.floor(keys.length * evictionRatio);
		for (let i = 0; i < deleteCount; i++) {
			cacheMap.delete(keys[i]);
		}
	}
}

// Clear all caches
function clearAllCaches() {
	resolutionCache.clear();
	folderSizeCache.clear();
	shouldUseFrameCache.clear();
	global.logMessage(q('q1.log.cacheCleared'), "INFO");
}

// ==================== FFprobe ====================
async function getMediaInfo(filePath, mtimeMsRaw) {
	// Normalize mtime, keep consistent with h.js
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

	// ★ Strict filter: only call FFprobe for real media formats
	if (!global.IMAGE_EXTS.has(ext) && !global.AUDIO_EXTS.has(ext) && !global.VIDEO_EXTS.has(ext)) {
		return null;
	}

	// Special: icon files on Windows (non-media) should be handled by the icon extractor in render layer, must not enter here
	if (process.platform === 'win32' && (ext === '.exe' || ext === '.lnk')) {
		return null;
	}

	// ... existing code ...

	if (!ff || typeof ff !== 'string' || !fs.existsSync(ff)) {

		// If built-in path is invalid, try using 'ffmpeg' directly
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
			// 1. Prefer the built-in path
			if (ff && fs.existsSync(ff)) {
				const c = trySpawn(ff, ["-hide_banner", "-i", filePath]);
				if (c) return c;
			}
			// 2. Fallback to ffmpeg in the environment PATH
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
						info.isMjpegStatic = false; // Gif is not considered MJPEG
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
				// ★ Fix: only infer type by extension when FFprobe actually parsed width/height or duration
				// Otherwise, renaming exe to mp4 would be misdetected as video
				if (info.width > 0 || info.duration > 0) {
					if (VIDEO_EXTS.has(ext)) {
						info.type = "video";
					} else if (IMAGE_EXTS.has(ext)) {
						info.type = "image";
						info.isStaticImage = true;
						// ★ Fix PSD bug: special formats that need conversion should set needsConversion = true
						if ([".ai", ".eps", ".psd", ".cdr", ".tiff", ".tif"].includes(ext)) {
							info.needsConversion = true;
						}
					} else if (AUDIO_EXTS.has(ext)) {
						// ★★★ Add audio type check ★★★
						info.type = "audio";
					}
				}
			}

			// ★ REMOVED: Don't force default 512x512 for unrecognized formats
			// If FFmpeg can't parse width/height, it means it can't render → return null
			// This ensures shouldUseFrame will correctly use icon frame

			resolutionCache.set(filePath, info);
			// ★ FIFO cache size limit
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

// ==================== ★ a's Plain Text detection (copied as-is) ====================
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

// ==================== ★ a's text preview generation (copied as-is + cacheKey changed to q style) ====================

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

					// Unified cache naming: .71 (cacheKey="71")
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

	// Same disk cache (514x290), return different display sizes by frame size
	gen.outputSize = outSize;
	return gen;
}

// ==================== Core Cache Strategy (Media) ====================
function determineCacheStrategy(filePath, info) {
	const ext = path.extname(filePath).toLowerCase();
	let fileSize = 0;
	try { fileSize = fs.statSync(filePath).size; } catch { }

	const isStaticSource = info?.isStaticImage === true;
	const isMjpegStatic = info?.isMjpegStatic === true;
	const simpleFormats = [".png", ".jpg", ".jpeg", ".svg", ".ico"];
	const canDirectRead = simpleFormats.includes(ext) || (ext === ".webp" && isStaticSource);
	// Bypass cache if any of the following is true: ✅ Condition 1: is .ico and smaller than 4MB ✅ Condition 2: file < 300KB and width≤512px and height≤512px
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

// ==================== Preview Buffer (Text first, integrated per a's logic) ====================
async function getPreviewBuffer(filePath, contentId, renderW, renderH) {
	// Remove hard block on ffmpegPath because image preview may fallback via image-size
	// if (!global.ffmpegPath()) return null;

	// Performance first: known-to-fail source files short-circuit (avoid repeated ffmpeg)
	if (geq().isBrokenFile && geq().isBrokenFile(contentId, filePath)) {
		return null;
	}

	const ext = path.extname(filePath).toLowerCase();

	// ★★★ Text first: not by extension, but by substance (per a) ★★★
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
			logCriticalError(filePath, `MJPEG direct-read failed: ${e.message}`);
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

		// Quick validation: prevent truncated/corrupted WebP output from being cached and causing long-term "bad hits"
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

			// Failure fuse: record failures and gradually extend cooldown to avoid repeatedly spawning ffmpeg during scroll/redraw
			const brokenRec = geq().markFileAsBroken ? geq().markFileAsBroken(contentId, filePath, result.error || "FFMPEG_FAIL") : null;

			// Only when "strongly suspect source is corrupted" and consecutive failures occur, use ffprobe to further confirm (expensive, but rare)
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
						// Confirmed severe corruption: extend cooldown to max 24 hours (avoid meaningless retries)
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
				logCriticalError(filePath, `${result.error} (no fallback)\n${stderr}`);
			}
		} else {
			logFallbackUsedRateLimited(filePath, ext, result.error, result.stderr || "");
			if (geq().unmarkFileAsBroken) geq().unmarkFileAsBroken(contentId);
		}
		return fallback;
	}
}

// ==================== Other Utilities ====================
// ★ formatBytes is unified via global.formatBytes

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
	// ★ Text is handled by a's "substance detection"
	return isPlainTextFile(filePath);
}

// In-memory cache for shouldUseFrame results
const shouldUseFrameCache = new Map();
const CACHE_EXPIRE_TIME = 125 * 60 * 1000;
const CACHE_MAX_SIZE = 2500; // ★ Maximum number of cached entries

// Clean expired cache entries
function cleanShouldUseFrameCache() {
	const now = Date.now();
	for (const [key, value] of shouldUseFrameCache.entries()) {
		if (now - value.timestamp > CACHE_EXPIRE_TIME) {
			shouldUseFrameCache.delete(key);
		}
	}
	// ★ If exceeding max size, delete the oldest 50%
	if (shouldUseFrameCache.size > CACHE_MAX_SIZE) {
		const entries = Array.from(shouldUseFrameCache.entries())
			.sort((a, b) => a[1].timestamp - b[1].timestamp);
		const deleteCount = Math.floor(entries.length / 2);
		for (let i = 0; i < deleteCount; i++) {
			shouldUseFrameCache.delete(entries[i][0]);
		}
	}
}

// Periodically clean cache
const shouldUseFrameCleanupInterval = setInterval(cleanShouldUseFrameCache, CACHE_EXPIRE_TIME);

// Batch get icons function
async function batchGetIcons(filePaths) {
	if (!filePaths || filePaths.length === 0) return {};

	// Result map
	const iconResults = {};

	// Collect all icon-fetch tasks using the global iconScheduler
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

	// Wait for all tasks to complete
	await Promise.all(tasks);

	return iconResults;
}

// Determine whether a file should be displayed with a frame
async function shouldUseFrame(filePath) {
	try {
		// Check if it's a directory
		let isDirectory = false;
		let mtimeMs = 0;
		try {
			const st = fs.statSync(filePath);
			isDirectory = st.isDirectory();
			mtimeMs = st.mtimeMs;
			if (isDirectory) {
				// Directories always use icon-frame display
				return false;
			}
		} catch { }

		// Build cache key: file path + mtime
		const cacheKey = `${filePath}:${mtimeMs}`;

		const ext = path.extname(filePath).toLowerCase();

		// ★★★ CHECK BROKEN FILE FIRST: If this file previously failed to render, use icon frame ★★★
		// This ensures consistency between shouldUseFrame and actual rendering
		// Must check BEFORE cache because broken status can change after caching
		const contentId = geq().computeFingerprint ? geq().computeFingerprint(filePath) : null;
		if (contentId && geq().isBrokenFile && geq().isBrokenFile(contentId, filePath)) {
			// Don't cache broken status - it may recover later
			return false;
		}

		// Check in-memory cache (only after broken check)
		const cachedResult = shouldUseFrameCache.get(cacheKey);
		if (cachedResult) {
			return cachedResult.result;
		}

		// Plain text files use text film frame
		if (TEXT_EXTS.has(ext) || isPlainTextFile(filePath)) {
			shouldUseFrameCache.set(cacheKey, { result: true, timestamp: Date.now() });
			return true;
		}

		// Get media info (non-media files return null)
		const info = await getMediaInfo(filePath, mtimeMs);
		if (!info) {
			// FFmpeg cannot parse this file → icon frame
			shouldUseFrameCache.set(cacheKey, { result: false, timestamp: Date.now() });
			return false;
		}

		// ★★★ ROBUST LOGIC: If FFmpeg can parse width/height, it can render → use frame ★★★
		// This covers PSD, AI, TXF, and any future unknown formats that FFmpeg supports

		// Browser-native formats (no ffmpeg needed for display)
		const browserNativeFormats = [".png", ".jpg", ".jpeg", ".svg", ".ico", ".gif", ".webp", ".bmp"];
		if (browserNativeFormats.includes(ext) && info.isStaticImage) {
			shouldUseFrameCache.set(cacheKey, { result: true, timestamp: Date.now() });
			return true;
		}

		// ★ Cache ffmpegPath check result to avoid multiple calls
		const hasFFmpeg = !!global.ffmpegPath();

		// Videos or animations require FFmpeg for conversion
		if (info.type === "video" || info.type === "animated_image") {
			shouldUseFrameCache.set(cacheKey, { result: hasFFmpeg, timestamp: Date.now() });
			return hasFFmpeg;
		}

		// ★★★ KEY FIX: Any format with valid width/height can be rendered by FFmpeg ★★★
		// Instead of checking needsConversion flag, check if we have dimensions
		// This ensures PSD, AI, TXF, and any unknown format FFmpeg can parse will use frame
		if (info.width > 0 && info.height > 0) {
			// FFmpeg parsed this successfully → it can convert to displayable format
			shouldUseFrameCache.set(cacheKey, { result: hasFFmpeg, timestamp: Date.now() });
			return hasFFmpeg;
		}

		// No dimensions → icon frame
		shouldUseFrameCache.set(cacheKey, { result: false, timestamp: Date.now() });
		return false;
	} catch (error) {
		return false;
	}
}

function getDocumentEOL(doc) {
	return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

// ★ Use qqq's path as the single source of truth (avoid breaking absolute/UNC paths)
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

// ★★★ Fix: someone set lineHeight as 1.4/1.2 as a multiplier, but VSCode expects pixels, causing pxPerLine≈1 => tens of thousands of blank lines
function calculateBlankLinesExact(pxHeight, isLastItem = false) {
	try {
		// Handle the special case for icon frames
		if (pxHeight === -1) {
			const config = vscode.workspace.getConfiguration("editor");
			const fontSize = Number(config.get("fontSize", 14)) || 14;
			// Icon frame blank line count adjusted by font size
			let n;
			if (fontSize <= 9) {
				n = 4;  // font size 6-9
			} else if (fontSize <= 15) {
				n = 3;  // font size 10-15
			} else {
				n = 2;  // font size 16+
			}
			if (isLastItem) n = Math.max(n, 2);
			return n;
		}

		const config = vscode.workspace.getConfiguration("editor");
		const fontSize = Number(config.get("fontSize", 14)) || 14;
		const lineHeightRaw = Number(config.get("lineHeight", 0)) || 0;

		let pxPerLine;

		// ★★★ Priority 1: Use webview-measured value (most accurate) ★★★
		if (measuredPxPerLine && measuredPxPerLine > 0) {
			pxPerLine = measuredPxPerLine;
			// Trigger async re-measurement if config changed (silent background update)
			requestLineHeightMeasurement();
		} else if (lineHeightRaw > 0) {
			// Priority 2: User explicitly configured lineHeight
			if (lineHeightRaw < 8) pxPerLine = fontSize * lineHeightRaw;
			else pxPerLine = lineHeightRaw;
		} else {
			// Priority 3: Fallback to heuristic ratio (when no measurement and no explicit config)
			// VSCode actual line height behaves differently across font sizes:
			// - Small font (6-8): ratio ~1.2
			// - Medium font (9-20): ratio ~1.37
			// - Large font (20+): ratio returns to ~1.2
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
			// Trigger measurement for future accuracy
			requestLineHeightMeasurement();
		}

		// Clamp: prevent abnormal configs
		pxPerLine = Math.max(pxPerLine, 10);

		// Compute actual frame height (including border)
		const boxH = pxHeight + PREVIEW_BORDER;

		// ★★★ Always round UP to prevent overlap (better to have extra space than overlap) ★★★
		let n = Math.ceil(boxH / pxPerLine);

		// extreme mode can further reduce
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

// ★★★ Request line height measurement from webview ★★★
function requestLineHeightMeasurement() {
	if (measurementPending) return;  // Already pending
	if (!measurementCallback) return;  // No webview registered yet

	measurementPending = true;
	const config = vscode.workspace.getConfiguration("editor");
	const fontSize = Number(config.get("fontSize", 14)) || 14;
	const lineHeightRaw = Number(config.get("lineHeight", 0)) || 0;
	const fontFamily = config.get("fontFamily", "Consolas, 'Courier New', monospace") || "monospace";

	// Request measurement from webview
	measurementCallback({
		fontSize,
		lineHeight: lineHeightRaw,
		fontFamily
	});
}

// ★★★ Receive measurement result from webview ★★★
function setMeasuredLineHeight(pxPerLine) {
	if (pxPerLine && pxPerLine > 5 && pxPerLine < 200) {
		const oldValue = measuredPxPerLine;
		measuredPxPerLine = pxPerLine;
		measurementPending = false;
		if (oldValue !== pxPerLine) {
			global.logMessage(`Line height measured: ${pxPerLine.toFixed(2)}px`, "INFO");
			// ★★★ Trigger full update when measurement changes ★★★
			if (pendingFullUpdateAfterMeasurement) {
				pendingFullUpdateAfterMeasurement = false;
				forceFullUpdateAllVisibleEditors();
			}
		}
	} else {
		measurementPending = false;
	}
}

// ★★★ Invalidate measurement cache (call when config changes) ★★★
function invalidateLineHeightCache() {
	measuredPxPerLine = null;
	measurementPending = false;
}

// ★★★ Flag: whether to trigger full update after measurement completes ★★★
let pendingFullUpdateAfterMeasurement = false;

/**
 * ★★★ ULTIMATE FORCE UPDATE: Complete refresh for all visible editors ★★★
 * This is the most thorough update: decoration re-render + optional weave
 * - Decoration re-render: ALWAYS done (to fix screen corruption)
 * - Weave (blank line adjustment): RESPECTS user's cleanFreak preference
 * Used when editor config changes (fontSize, lineHeight, fontFamily)
 */
async function forceFullUpdateAllVisibleEditors() {
	try {
		global.logMessage(`[ForceFullUpdate] Starting complete refresh...`, "DEBUG");

		// Step 1: Clear ALL decoration caches (ALWAYS - for fixing screen corruption)
		clearDecorations();

		// Step 2: Perform weave ONLY if user's cleanFreak preference allows
		const cleanFreakModeValue = getEffectiveCleanFreakMode();
		if (cleanFreakModeValue !== "never") {
			// RESPECT user's preference: use their chosen mode, not forced "add & remove"
			const editors = vscode.window.visibleTextEditors;
			for (const editor of editors) {
				if (!editor || !editor.document) continue;
				const text = editor.document.getText();
				// Only process documents that contain qqq markers
				if (text.includes('/\\qqq')) {
					await performGlobalClean(editor, true, cleanFreakModeValue);
				}
			}
		}

		// Step 3: Wait a moment for edits to apply
		await new Promise(resolve => setTimeout(resolve, 100));

		// Step 4: Re-render all visible editors (ALWAYS - for fixing screen corruption)
		renderVisibleEditors(50);

		// Step 5: Refresh CodeLens
		if (codeLensProvider) codeLensProvider.refresh();

		global.logMessage(`[ForceFullUpdate] Complete refresh finished (cleanFreak: ${cleanFreakModeValue}).`, "DEBUG");
	} catch (e) {
		global.logMessage(`[ForceFullUpdate] Error: ${e.message}`, "WARN");
	}
}

/**
 * ★★★ Schedule full update after measurement completes ★★★
 * Call this when config changes - it will wait for measurement result before updating
 * RESPECTS user's cleanFreak preference: if "never", only re-renders, no weave
 */
function scheduleFullUpdateAfterMeasurement() {
	// If user prefers "never", still do re-render (for screen corruption fix), but skip weave
	pendingFullUpdateAfterMeasurement = true;
	// Also trigger measurement request
	requestLineHeightMeasurement();
	// Fallback: if measurement doesn't come back in 2 seconds, force update anyway
	setTimeout(() => {
		if (pendingFullUpdateAfterMeasurement) {
			pendingFullUpdateAfterMeasurement = false;
			global.logMessage(`[ForceFullUpdate] Measurement timeout, using fallback values.`, "DEBUG");
			forceFullUpdateAllVisibleEditors();
		}
	}, 2000);
}

// ★★★ Unified blank line calculation function ★★★
// Both paste and weave use this function to ensure consistent results
async function calculateRequiredBlankLines(filePath, isLastItem = false) {
	try {
		// Use shouldUseFrame as the single source of truth
		const useFrame = await shouldUseFrame(filePath);

		if (!useFrame) {
			// Icon frame: use -1 special marker
			return calculateBlankLinesExact(-1, isLastItem);
		}

		// Frame: get actual height
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
		// Default to icon frame
		return calculateBlankLinesExact(-1, isLastItem);
	}
}

function getEditorId(editor) {
	const docUri = editor.document.uri.toString();
	const viewColumn = editor.viewColumn ?? 0;
	return `${docUri}::${viewColumn}`;
}

// ==================== Main Render Logic ====================
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
	const iconPaths = []; // Collect file paths that need icons
	const renderInfos = []; // Collect render info for later processing

	// Phase 1: sync scan, fast hide (only hide paths that can be rendered, avoid "hidden but not rendered" holes)
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
					// Files and supported media files need to hide original text
					if (!st.isDirectory()) {
						if (isSupportedMedia(absPath) || process.platform === 'win32') {
							shouldHide = true;
						}
					} else {
						// Directories also need to hide original text
						shouldHide = true;
					}
				} catch { }
			}

			// ★ Cache key uses only position, but store mtime for change detection
			const uniqueKey = `${pos.line}_${pos.character}`;
			const currentMtime = st ? Math.floor(st.mtimeMs) : 0;

			if (shouldHide) {
				newHideRanges.push(new vscode.Range(pos, endPos));
				// ★ Core of plan q: check if mtime changed; if changed, delete old cache
				const cachedDeco = currentDecos.get(uniqueKey);
				if (cachedDeco && cachedDeco._mtime !== currentMtime) {
					currentDecos.delete(uniqueKey); // mtime changed, force re-render
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
			// Strictly control probe scope:
			// 1. Directories do not probe media, go icon render directly
			// 2. Only real media formats enter FFprobe logic
			// 3. On Windows, non-media files (exe/lnk) go icon flow, must not touch FFprobe
			if (!isDirectory && !isSupportedMedia(absPath)) {
				if (process.platform !== 'win32') continue;
				// Non-media files on Windows are only allowed to use icon rendering, FFprobe forbidden
			}

			// Collect render info (including directories)
			renderInfos.push({
				absPath,
				uniqueKey,
				anchorRange,
				contentId,
				isDirectory,
				mtime: currentMtime  // ★ Plan q: store mtime
			});

			// On Windows, collect file paths that need icons (including directories)
			if (process.platform === 'win32') {
				iconPaths.push(absPath);
			}
		}
	}

	// Batch get icons
	let iconResults = {};
	if (process.platform === 'win32' && iconPaths.length > 0) {
		iconResults = await batchGetIcons(iconPaths);
	}

	// Phase 2: create render tasks
	for (const renderInfo of renderInfos) {
		const { absPath, uniqueKey, anchorRange, contentId, isDirectory, mtime } = renderInfo;

		tasks.push(async () => {
			if (currentRenderVersion !== myVersion) return null;

			try {
				const ext = path.extname(absPath).toLowerCase();
				const isVidOrImg = isImageOrVideoExt(ext);
				const isText = !isVidOrImg && isPlainTextFile(absPath);

				// Get icon from batch results
				let iconB64 = iconResults[absPath] || null;

				// Directories are always supported for rendering (use icon)
				const isSupported = isDirectory || isVidOrImg || isText;

				let previewWidth = LARGE_PREVIEW_WIDTH;
				let previewHeight = LARGE_PREVIEW_HEIGHT;
				let previewResult = null;

				if (isSupported) {
					// Directories are always supported for rendering (use icon), but do not need preview
					if (!isDirectory) {
						let info = null;
						if (!isText) {
							// Media files that need probing
							let mtimeMs = 0;
							try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }
							info = await getMediaInfo(absPath, mtimeMs);

							const fc = getFrameConfig(info);
							previewWidth = fc.width;
							previewHeight = fc.height;
						} else {
							// Text files: use configured frame size directly, probing forbidden
							const fc = getFrameConfig(null);
							previewWidth = fc.width;
							previewHeight = fc.height;
						}

						previewResult = await getPreviewBuffer(absPath, contentId, previewWidth, previewHeight);
					}
				}

				if (currentRenderVersion !== myVersion) return null;

				// If no preview and no icon, don't render
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

				// If no preview but has icon, use icon as preview
				if (!contentUrl && iconB64) {
					contentUrl = `url("data:image/png;base64,${iconB64}")`;
					previewWidth = 32;
					previewHeight = 32;
					outputSize = { width: 32, height: 32 };
				}

				// Set gutter icon
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

				// Select watermark based on frame size (only remove if server says so)
				let selectedWatermark = null;
				if (!global.shouldRemoveWatermark()) {
					if (previewWidth === LARGE_PREVIEW_WIDTH && previewHeight === LARGE_PREVIEW_HEIGHT) {
						selectedWatermark = largeWatermarkBase64;
					} else if (previewWidth === SMALL_PREVIEW_WIDTH && previewHeight === SMALL_PREVIEW_HEIGHT) {
						selectedWatermark = smallWatermarkBase64;
					}
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

				deco.hoverMessage = new vscode.MarkdownString(`[${q('q1.ui.openFile')}](${vscode.Uri.file(absPath).toString()})`);
				deco.hoverMessage.isTrusted = true;

				return { key: uniqueKey, deco, mtime };  // ★ Plan q: return mtime
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
				res.deco._mtime = res.mtime;  // ★ Plan q: store mtime for next change detection
				currentDecos.set(res.key, res.deco);
			}
		}
	}

	if (decorationType) {
		editor.setDecorations(decorationType, Array.from(currentDecos.values()));
	}
}

// ==================== Paste Command ====================

// Format result to text (reuse original replacePendingMarker logic)
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

					// ★ Use unified blank line calculation function
					let gapBelow = await calculateRequiredBlankLines(filePath, isLastItem);
					// For non-last items, subtract 1 to offset the extra newline added by join
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
		// ★ Use unified blank line calculation function
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
			// ★ Use unified blank line calculation function (directories are always icon frames)
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

			// ★ Use unified blank line calculation function
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
			// ★ Use unified blank line calculation function
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

// ==================== Anchor Replacement Helpers ====================
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
						// ★ 视频下载成功即记录统计（不依赖锚点替换是否成功）
						const videoBytes = downloadRes.finalTotalBytes || 0;
						saveVideoStats(videoBytes);
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
					TaskMessage.showSimpleToast(q('qqq.ui.anchorLostRollback', taskTitle), 15000, 'cancel');
				} else {
					TaskMessage.showSimpleToast(q('qqq.ui.taskCancelledRollback', taskTitle), 15000, 'cancel');
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
								// HTML paste: count successfully landed media files and total size
								const mediaBlocks = result.blocks?.filter(b => b.type === 'media' && b.status === 'ok') || [];
								const mediaCount = mediaBlocks.length;
								// Calculate total size
								const totalSize = mediaBlocks.reduce((sum, block) => sum + (block.size || 0), 0);
								totalSizeForStats = totalSize;
								// Format size display
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
								detail = q('q1.ui.mediaLanded', mediaCount, sizeStr ? ` ${sizeStr}` : '');
								// If there is baseUrl, add source info
								if (result.baseUrl) {
									// Truncate URL to keep message concise
									const urlSnippet = result.baseUrl.length > 33 ? result.baseUrl.substring(0, 33) + '...' : result.baseUrl;
									detail += q('q1.ui.fromUrl', urlSnippet);
								}
							} else {
								// File/folder paste: original logic
								const totalCount = (result.files?.length || 0) + (result.folders?.length || 0);
								const skippedCount = result.skippedCount || 0;
								detail = q('q1.ui.fileFolderCopied', totalCount);
								if (skippedCount > 0) {
									detail += ` ${q('q1.ui.skippedInaccessible', skippedCount)}`;
								}

								// Try to get total size from snapshot or result
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
							// Image paste: use real landed size
							if (result.path) {
								try { totalSizeForStats = fs.statSync(result.path).size; } catch { }
							}
						}

						// ★ Unified stats reporting
						if (taskType !== 'video') {
							savePasteStats(totalSizeForStats);
						}

						// ★★★ Force refresh document to fix screen corruption (applies to all media paste) ★★★
						// This ensures decorations are properly rendered after new frames/text films are created
						try {
							await forceRefreshDocument(docUri);
							global.logMessage(`[Paste] Document force refresh completed: ${docUri.fsPath}`, "DEBUG");
						} catch (e) {
							global.logMessage(`[Paste] Force refresh error (non-fatal): ${e.message}`, "WARN");
						}
					} else {
						const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
						if (trans) await TransactionManager.rollback(trans);
						TaskMessage.showSimpleToast(q('qqq.ui.anchorLostRollback', taskTitle), 15000, 'cancel');
					}
				} else {
					const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
					if (trans) await TransactionManager.rollback(trans);
					await replaceAnchorInDoc(docUri, anchor, "");
					TaskMessage.showSimpleToast(q('q1.ui.processFailed', taskTitle), 15000, 'cancel');
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
			TaskMessage.showSimpleToast(q('q1.ui.exceptionOccurred', taskTitle), 15000, 'cancel');
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
		// First use wq() to determine clipboard content type
		const snapshot = await wq();
		// Only show prompt when content is not plain text
		if (snapshot.type !== 'whitelist') {
			global.showAutoCloseNotification('info', q('qqq.ui.plainPasteOnly'));
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
	// ★ Do not create qqq folder here! Let h.js ensureDir create it on-demand when writing files
	// Avoid creating an empty qqq folder for plain-text paste

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
		// ★ 对于 whitelist（纯文本或无媒体HTML），直接调用原生粘贴（更快，保留空行）
		if (snapshot.type === 'whitelist' && (snapshot.subType === 'text' || snapshot.subType === 'html_text')) {
			await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
			return;
		}

		// ★ 快速粘贴也要生成 transId，用于文件名前缀（4位锚点+2位索引）
		const quickTransId = TransactionManager.createTransactionId();
		await h.autoDetectAndPaste(targetDir, null, null, quickTransId, snapshot).then(async (result) => {
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

			// ★ Stats for simple paste
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

			// ★★★ Force refresh for non-text paste (frames/text films) to fix screen corruption ★★★
			if (result && result.type !== 'text') {
				try {
					await forceRefreshDocument(activeEditor.document.uri);
					global.logMessage(`[QuickPaste] Document force refresh completed.`, "DEBUG");
				} catch (e) {
					global.logMessage(`[QuickPaste] Force refresh error (non-fatal): ${e.message}`, "WARN");
				}
			} else {
				// Plain text paste: just debounce render
				debounceRender(activeEditor, 10);
			}
		});
	} else {
		await performCurvedPaste(editor, targetDir, snapshot);
	}
}

// ==================== Cleanliness Mode ====================
async function provideCleanlinessEditsAsync(document, mode = null) {
	if (!document) return [];
	// If mode not specified, use global config (with override support)
	const effectiveMode = mode || getEffectiveCleanFreakMode();
	const allowRemove = effectiveMode === "add & remove";

	const edits = [];
	const text = document.getText();
	const regex = geq().createPathRegex();
	const eol = getDocumentEOL(document);
	let match;
	const markers = [];

	while ((match = regex.exec(text))) {
		// ★ Only process markers where inner path starts with "qqq" to avoid mismatching JS regex like /\\/ or /\n/
		const inner = (match[1] || "").trim();
		if (!inner.startsWith('qqq')) continue;
		markers.push({ text: match[0], index: match.index, inner });
	}

	// Process from back to front to avoid index shift issues
	for (let i = markers.length - 1; i >= 0; i--) {
		const m = markers[i];
		const startPos = document.positionAt(m.index);
		const endPos = document.positionAt(m.index + m.text.length);
		const markerLine = startPos.line;

		const rawPath = m.inner;
		const absPath = resolvePathToAbsolute(document.uri, rawPath);

		// Check if there is other content before/after the marker on the same line (need newline separation)
		const lineObj = document.lineAt(markerLine);
		const lineContent = lineObj.text;
		if (startPos.character > 0) {
			edits.push({ range: new vscode.Range(startPos, startPos), newText: eol });
		}
		const suffix = lineContent.substring(endPos.character);
		if (suffix.trim().length > 0) {
			edits.push({ range: new vscode.Range(endPos, endPos), newText: eol });
		}

		// Calculate required blank lines
		const isLastMarkerInDoc = i === markers.length - 1;
		let neededLines = 0;

		if (absPath && fs.existsSync(absPath)) {
			// ★ Use unified blank line calculation function
			neededLines = await calculateRequiredBlankLines(absPath, isLastMarkerInDoc);
			// For non-last markers, subtract 1 to match paste experience
			if (!isLastMarkerInDoc) neededLines = Math.max(neededLines - 1, 0);
		}

		// Count existing blank lines
		let existingBlanks = 0;
		for (let lineIdx = markerLine + 1; lineIdx < document.lineCount; lineIdx++) {
			if (document.lineAt(lineIdx).text.trim() === "") existingBlanks++;
			else break;
		}

		// Decide whether to adjust blank lines based on mode
		if (existingBlanks < neededLines) {
			// Not enough blank lines, need to add
			const linesToAdd = neededLines - existingBlanks;
			const lineEndPos = lineObj.range.end;
			edits.push({ range: new vscode.Range(lineEndPos, lineEndPos), newText: eol.repeat(linesToAdd) });
		} else if (allowRemove && existingBlanks > neededLines) {
			// Too many blank lines, need to remove (only in add & remove mode)
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
	if (!force && getEffectiveCleanFreakMode() === "never") return;
	try {
		// Check if editor is still valid
		if (!vscode.window.visibleTextEditors.includes(editor)) return;
		// If mode not specified, use global config
		const edits = await provideCleanlinessEditsAsync(editor.document, mode);
		if (edits.length > 0) {
			// ★ Sort by position and filter overlapping edits
			edits.sort((a, b) => {
				const cmp = a.range.start.compareTo(b.range.start);
				if (cmp !== 0) return cmp;
				return a.range.end.compareTo(b.range.end);
			});
			// Filter overlapping edits (keep first)
			const filteredEdits = [];
			let lastEnd = null;
			for (const e of edits) {
				if (lastEnd && e.range.start.isBefore(lastEnd)) {
					// Overlap, skip
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
			let tooltipText = `${q('q1.ui.created')}: ${new Date(st.birthtime).toLocaleString()}\n${q('q1.ui.modified')}: ${new Date(st.mtime).toLocaleString()}`;
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
					folderTooltip = q('q1.ui.calculatingFolderSize');
					fetchFolderSizeFirstTime(folder); // Scan once on first load
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
					if (displayCodec) tooltipText += `\n${q('q1.ui.codec')}: ${displayCodec}`;

					const arStr = calculateAspectRatioString(info.width, info.height);
					if (arStr) tooltipText += `\n${q('q1.ui.aspectRatio')}: ${arStr}`;

					if (geq().shouldShowDuration(info)) tooltipText += `\n⌛${q('q1.ui.originalDuration')}: ${formatDuration(info.duration)}`;
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

			// Only show ✎qode button for text files, and only when codelensLevel is 3
			if (codelensLevel === "3" && isText) {
				lenses.push(
					new vscode.CodeLens(r, {
						title: "✎qode",
						command: "qqq.openFileInRightGroup",
						arguments: [absPath],
						tooltip: q('q1.ui.openInRightGroup'),
					})
				);
			}
		}

		return lenses;
	}
}

// Passive listening mode + scan once on first load
const FOLDER_SIZE_SCAN_COOLDOWN = 15000; // 15s scan cooldown
const _pendingFolderSizeRequests = new Map();
const _lastScanTime = new Map(); // Record last scan time per folder

// ★ Called after paste: clear cache and trigger rescan
function invalidateFolderSizeCacheForPath(filePath) {
	try {
		const dir = path.dirname(filePath);
		// Clear cache
		if (folderSizeCache.has(dir)) folderSizeCache.delete(dir);
		if (folderSizeCache.has(filePath)) folderSizeCache.delete(filePath);

		// ★ Simplified: only check cooldown, regardless of previous cache
		if (dir) {
			const now = Date.now();
			const lastScan = _lastScanTime.get(dir) || 0;
			if (now - lastScan >= FOLDER_SIZE_SCAN_COOLDOWN) {
				fetchFolderSizeInternal(dir, true);
			}
		}
	} catch { }
}

// ★ Only return cache, do not trigger scan
function geqFolderSizeSync(folderPath) {
	const cached = folderSizeCache.get(folderPath);
	return cached ? cached.data : null;
}

// ★ Lightweight check: only check folder mtime; if changed, clear cache
function checkFolderMtimeChanged(folderPath) {
	const cached = folderSizeCache.get(folderPath);
	if (!cached) return false; // No cache, no need to check

	try {
		const currentMtime = fs.statSync(folderPath).mtimeMs;
		if (cached.mtime !== currentMtime) {
			// mtime changed, clear cache
			folderSizeCache.delete(folderPath);
			return true;
		}
	} catch { }
	return false;
}

// ★ Trigger scan on first load (the only proactive scan)
function fetchFolderSizeFirstTime(folderPath) {
	if (folderSizeCache.has(folderPath)) return; // Already cached, don't scan
	// ★ Also check cooldown to prevent repeated scans within cooldown after cache deletion
	const now = Date.now();
	const lastScan = _lastScanTime.get(folderPath) || 0;
	if (now - lastScan < FOLDER_SIZE_SCAN_COOLDOWN) return;
	fetchFolderSizeInternal(folderPath, false);
}

// ★ Internal scan function (with de-dup)
function fetchFolderSizeInternal(folderPath, fromWatcher) {
	if (_pendingFolderSizeRequests.has(folderPath)) return;
	_pendingFolderSizeRequests.set(folderPath, true);
	_lastScanTime.set(folderPath, Date.now());

	// ★ Get folder mtime for later lightweight checks
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
					parts.push(`${count}★ ${ext || q('q1.ui.noExtension')}`);
				}
			}
			const summaryStr = parts.length > 0
				? q('q1.ui.filesCountWithBreakdown', totalFiles, parts.join(";  "))
				: result.file_count_root > 0 ? q('q1.ui.filesCount', result.file_count_root) : q('q1.ui.emptyFolder');
			const data = { size: result.total_size, summary: summaryStr };
			// ★ Store mtime for lightweight checks
			folderSizeCache.set(folderPath, { data, timestamp: Date.now(), mtime: folderMtime });
			evictOldestEntries(folderSizeCache, FOLDER_SIZE_CACHE_MAX_ENTRIES);
			if (codeLensProvider) codeLensProvider.debouncedRefresh();
		}
	}).catch(() => {
		_pendingFolderSizeRequests.delete(folderPath);
	});
}

// ==================== Commands ====================
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
		// Determine the view column on the right
		let targetColumn = vscode.ViewColumn.Beside;

		// Check if there are multiple tab groups
		if (vscode.window.tabGroups && vscode.window.tabGroups.all) {
			const allGroups = vscode.window.tabGroups.all;
			if (allGroups.length > 1) {
				// Find the rightmost tab group
				const sortedGroups = allGroups
					.filter(g => typeof g.viewColumn === "number")
					.sort((a, b) => a.viewColumn - b.viewColumn);
				targetColumn = sortedGroups[sortedGroups.length - 1].viewColumn;
			}
		}

		// Open file in target column and ensure it enters edit mode (preserveFocus: false)
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
		title: q('q1.ui.rename'),
		prompt: " ",
		value: currentName,
		ignoreFocusOut: true,
		validateInput: (v) => {
			if (!v || !v.trim()) {
				return q('q1.ui.fileNameEmpty');
			}
			if (v.trim() === currentName) {
				return null;
			}
			const trimmed = v.trim();
			const newAbs = path.join(path.dirname(absPath), trimmed);
			try {
				fs.accessSync(newAbs);
				return q('q1.ui.targetFileExists');
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
			// Check if editor is still valid
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

/**
 * ★ Force refresh a single document: clear its decoration cache and re-render ALL markers
 * Used after video download completes to fix screen corruption (花屏) issues
 * Only re-renders decorations, does NOT modify any text (safe for ongoing downloads & user typing)
 * @param {vscode.Uri|string} uri - Document URI to refresh
 */
async function forceRefreshDocument(uri) {
	try {
		const docUri = typeof uri === 'string' ? uri : uri.toString();
		const fsPath = typeof uri === 'string' ? vscode.Uri.parse(uri).fsPath : uri.fsPath;

		global.logMessage(`[forceRefreshDocument] Refreshing document: ${fsPath}`, "DEBUG");

		// Step 1: Clear decoration cache for this specific document (forget ALL old decorations)
		documentDecorationsMap.delete(docUri);

		// Step 2: Wait 200ms to ensure cache clear takes effect
		await new Promise(resolve => setTimeout(resolve, 200));

		// Step 3: Re-render ALL markers in this document (not just the downloaded one)
		// renderImages only renders decorations, does NOT modify text
		const targetEditors = vscode.window.visibleTextEditors.filter(
			e => e.document.uri.toString() === docUri
		);
		for (const editor of targetEditors) {
			await renderImages(editor);
		}

		global.logMessage(`[forceRefreshDocument] Document refresh completed: ${fsPath}`, "DEBUG");
		return true;
	} catch (e) {
		global.logMessage(`[forceRefreshDocument] Error: ${e.message}`, "WARN");
		return false;
	}
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

	// Async integrity verification, does not block activation
	global.verifySystemIntegrityAsync(context).then(valid => {
		const _qqq = geq();
		if (!valid) {
			if (_qqq) _qqq.logMessage(`Integrity: FAILED (LARGE_PATH=${LARGE_WATERMARK_PATH})`, "WARN");
			else global.logMessage(`Integrity: FAILED (LARGE_PATH=${LARGE_WATERMARK_PATH})`, "WARN");
			global.showAutoCloseNotification('warning', q('q1.ui.coreFilesIncomplete'));
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

	// ★ Ultimate fix: receive config update notifications via ConfigGate callback mechanism (solves race conditions)
	// Previously listening to onDidChangeConfiguration caused refreshConfig() to run before sessionOverrides update
	global.ConfigManager.onConfigUpdated((changedKeys, event) => {
		global.logMessage(q('q1.log.configUpdateCallback', changedKeys.join(', ')), "DEBUG");
		const oldCleanFreakMode = cleanFreakMode; // ★ Remember old value before refresh
		const oldFrameSizeMode = frameSizeMode;   // ★ Remember old frame size mode
		refreshConfig();
		clearDecorations();
		if (codeLensProvider) codeLensProvider.refresh();
		renderVisibleEditors(10);

		// ★★★ If frameSizeMode changed, trigger full update (blank lines may need adjustment) ★★★
		if (frameSizeMode !== oldFrameSizeMode) {
			global.logMessage(`[Config] frameSizeMode changed: ${oldFrameSizeMode} -> ${frameSizeMode}, triggering full update.`, "DEBUG");
			forceFullUpdateAllVisibleEditors();
		} else if (getEffectiveCleanFreakMode() !== "never") {
			performGlobalClean(vscode.window.activeTextEditor);
		}

		// ★ Notify q4 if cleanFreakMode changed (for weave button sync)
		if (cleanFreakMode !== oldCleanFreakMode && q1Utils.onCleanFreakModeChange) {
			q1Utils.onCleanFreakModeChange(cleanFreakMode);
		}
	});

	// ★ 水印状态变化时刷新所有已渲染的相框
	global.onWatermarkChange((shouldRemove) => {
		global.logMessage(`[Watermark] Status changed: removeWatermark=${shouldRemove}, refreshing all frames...`, "INFO");
		forceFullUpdateAllVisibleEditors();
	});

	// ★ Ultimate optimal: privilege boost, never await before registration
	// ★ 防御性命令注册：防止开发环境热重载或新旧版本共存时命令重复注册
	const safeRegisterCommand = (commandId, handler) => {
		try {
			return vscode.commands.registerCommand(commandId, handler);
		} catch (e) {
			if (e.message?.includes('already exists')) {
				global.logMessage(`[Q1] Command ${commandId} already exists, skipping`, 'WARN');
				return { dispose: () => {} };
			}
			throw e;
		}
	};

	context.subscriptions.push(
		// ★ Only keep editor config listeners (these do not involve ConfigGate)
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("editor.lineHeight") || e.affectsConfiguration("editor.fontFamily")) {
				// ★★★ ULTIMATE FIX: Invalidate cache, request measurement, then full update ★★★
				invalidateLineHeightCache();
				refreshConfig();
				// Schedule full update AFTER measurement completes (not immediately!)
				scheduleFullUpdateAfterMeasurement();
			}
		}),
		safeRegisterCommand("qqq.q1", global.withReady(executeClipboardCommand)),
		safeRegisterCommand("qqq.openFile", global.withReady(openFileCommand)),
		safeRegisterCommand("qqq.openFileInRightGroup", global.withReady(openFileInRightGroupCommand)),
		safeRegisterCommand("qqq.revealFileInFolder", global.withReady(revealFileInFolder)),
		safeRegisterCommand("qqq.renameFile", global.withReady(renameFileCommand)),
		safeRegisterCommand("qqq.weave", global.withReady(() => {
			// weave only adds, never removes
			performGlobalClean(vscode.window.activeTextEditor, true, "add");
		})),
		safeRegisterCommand("qqq.exportDoc", global.withReady(() => {
			q3.executeExportDocCommand(global.isValid());
		})),
		safeRegisterCommand("qqq.exportZip", global.withReady(() => {
			q3.executeExportZipCommand(global.isValid());
		})),
		vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
		vscode.workspace.onWillSaveTextDocument((e) => {
			if (getEffectiveCleanFreakMode() !== "never" && e.document) {
				// ★ 添加超时保护，避免 VS Code 报错 "Aborted onWillSaveTextDocument-event after 1750ms"
				const timeoutMs = 1500; // 给 VS Code 留 250ms 余量
				const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), timeoutMs));
				const editsPromise = provideCleanlinessEditsAsync(e.document).then((edits) => {
					return edits.map((edit) => new vscode.TextEdit(edit.range, edit.newText));
				}).catch(() => []);

				e.waitUntil(Promise.race([editsPromise, timeoutPromise]));
			}
		}),
		vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
			debounceRender(e.textEditor);
		}),
		// ★ Fallback mechanism: after document save, check empty sibling qqq folder; if confirmed created by us, delete permanently
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
				// ★ Plan q lite: only check folder mtime, do not proactively scan
				let needRefresh = false;
				for (const [folderPath] of folderSizeCache) {
					if (checkFolderMtimeChanged(folderPath)) {
						needRefresh = true;
					}
				}
				if (needRefresh && codeLensProvider) {
					codeLensProvider.refresh();  // Refresh CodeLens only if mtime changed
				}
				// ★ Decorations update (via mtime checks, no scanning)
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
			if (getEffectiveCleanFreakMode() !== "never") performGlobalClean(vscode.window.activeTextEditor);
		})
	);

	// ★ Ultimate optimal: move async recovery to end of function and run in background
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

	// ★ Clear timer
	if (shouldUseFrameCleanupInterval) {
		clearInterval(shouldUseFrameCleanupInterval);
	}

	// ★ Clear all caches
	clearAllCaches();

	// User duration stats are centrally managed by geq().js
}

// Export utility functions for other modules
const q1Utils = {
	calculateBlankLinesExact,
	getMediaInfo,
	getFrameConfig,
	LARGE_PREVIEW_HEIGHT,
	PREVIEW_BORDER,
	forceRefreshDocument,
	// ★ cleanFreakMode getter/setter for q4.js weave embedded buttons
	getCleanFreakMode: getEffectiveCleanFreakMode,
	setCleanFreakMode: (mode) => {
		if (["never", "add", "add & remove"].includes(mode)) {
			// ★ Sync to VS Code settings for UI consistency (both sides are "试玩")
			// Real config will come from cloud in the future
			vscode.workspace.getConfiguration(global.cfgNs()).update('cleanFreak', mode, vscode.ConfigurationTarget.Global);
			return true;
		}
		return false;
	},
	// ★ Callback for q4 to register when cleanFreakMode changes
	onCleanFreakModeChange: null,
	// ★ performGlobalClean for direct invocation from q4
	performGlobalClean,
	// ★★★ Line height measurement API for q4 webview ★★★
	setMeasuredLineHeight,
	invalidateLineHeightCache,
	// Register measurement request callback (q4 will call this to receive measurement requests)
	registerMeasurementCallback: (cb) => { measurementCallback = cb; },
	// Trigger initial measurement
	requestLineHeightMeasurement,
	// ★★★ Ultimate force update API ★★★
	forceFullUpdateAllVisibleEditors,
	scheduleFullUpdateAfterMeasurement
};

module.exports = { activate, deactivate, ...q1Utils };

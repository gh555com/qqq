// File: src/q1.js
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { pythonBridge, shouldShowDuration, logMessage, QQQ_PATH_REGEX } = require("./qqq");

// ==================== 核心完整性配置 ====================
const CORE_INTEGRITY_HASH = "dc10f424bef818e80eea0a5175bbb6cca07cbee34c8510c7b64069ef1661c88e";
let isCoreIntegretyValid = false;

// ==================== 全局变量 ====================
let ffmpegPath = null;
let ffmpegProbePromise = null;

const MAX_PREVIEW_CACHE = 100;
const previewCache = new Map();
const documentDecorationsMap = new Map();
let currentRenderVersion = 0;

const resolutionCache = new Map();

const MAX_CONCURRENT_TASKS = 8;
const SCROLL_DEBOUNCE_MS = 200;

const PREVIEW_WIDTH = 512;
const PREVIEW_HEIGHT = 288;
const PREVIEW_BORDER = 6;
const PREVIEW_BG_COLOR = "#fef6e3";
const FFMPEG_BG_COLOR = "0xfef6e3";

const assetsCache = {
	checked: false,
	bgExists: false,
	wmExists: false
};

let watermarkBase64 = null;
const WATERMARK_PATH = path.join(__dirname, "..", "assets", "q2.gif");

try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
} catch (e) {
	ffmpegPath = null;
}

const LOG_PATH = "D:\\view\\p\\kp.log";

let currentQessionId = null;
let dbPath = null;
let decorationType;
let markerHideType;
let extensionContext = null;

const lensLinesByDocUri = new Map();
let lastCodeLensIsActive = false;
let lastCodeLensColor = null;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov"]);

const qqqFolderSizeCache = new Map();
const FOLDER_SIZE_CACHE_MAX_AGE = 10 * 1000;

let enlargeSmallImages = true;
let extremePerformanceMode = false;
let cleanFreakMode = false;
let lastGlobalCleanTime = 0;

function refreshQqqConfig() {
	try {
		const config = vscode.workspace.getConfiguration("qqq");
		enlargeSmallImages = config.get("enlargeSmallImages", config.get("stretchSmallImages", true));
		extremePerformanceMode = config.get("extremePerformance", false);
		cleanFreakMode = config.get("cleanFreak", false);
	} catch (e) {
		enlargeSmallImages = true;
		extremePerformanceMode = false;
		cleanFreakMode = false;
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

function clearDecorations() {
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

function verifySystemIntegrity() {
	try {
		if (!fs.existsSync(WATERMARK_PATH)) return false;
		const buffer = fs.readFileSync(WATERMARK_PATH);
		const hash = crypto.createHash("sha256").update(buffer).digest("hex");
		return hash === CORE_INTEGRITY_HASH;
	} catch (e) {
		return false;
	}
}

function formatBytes(size) {
	if (size == null || isNaN(size)) return "?";
	const units = ["b", "k", "m", "g"];
	let unitIndex = 0;
	let value = size;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value = value / 1024;
		unitIndex++;
	}
	return `${Math.round(value)}${units[unitIndex]}`;
}

function formatDuration(seconds) {
	if (seconds == null || isNaN(seconds) || seconds < 0) return "0s";
	if (seconds >= 60) {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}m + ${secs.toFixed(2)}s`;
	} else {
		return `${seconds.toFixed(2)}s`;
	}
}

function isImageExt(ext) { return IMAGE_EXTS.has(ext.toLowerCase()); }
function isVideoExt(ext) { return VIDEO_EXTS.has(ext.toLowerCase()); }
function isImageOrVideoExt(ext) {
	const lower = ext.toLowerCase();
	return IMAGE_EXTS.has(lower) || VIDEO_EXTS.has(lower);
}
function getDocumentEOL(document) {
	return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

function buildNewRawPath(oldRawPath, newFileName) {
	const lastSlash = Math.max(oldRawPath.lastIndexOf("/"), oldRawPath.lastIndexOf("\\"));
	if (lastSlash === -1) return newFileName;
	return oldRawPath.slice(0, lastSlash + 1) + newFileName;
}

// ==========================================
//           身份识别模块
// ==========================================

function determineMediaType(codec, ext) {
	if (!codec) {
		const e = ext.toLowerCase();
		if (e === ".gif") return "gif";
		if (VIDEO_EXTS.has(e)) return "video";
		if (IMAGE_EXTS.has(e)) return "image";
		return "unknown";
	}
	const c = codec.toLowerCase();
	if (c === "gif") return "gif";
	if (["png", "mjpeg", "webp", "bmp", "tiff", "jpeg", "jpg"].some(x => c.includes(x))) {
		if (c.includes("mjpeg") && VIDEO_EXTS.has(ext.toLowerCase())) return "video";
		return "image";
	}
	const videoCodecs = [
		"h264", "hevc", "vp8", "vp9", "av1", "mpeg4", "mpeg2video",
		"prores", "wmv", "flv", "theora", "vc1", "rv40"
	];
	if (videoCodecs.some(x => c.includes(x))) return "video";
	if (VIDEO_EXTS.has(ext.toLowerCase())) return "video";
	if (IMAGE_EXTS.has(ext.toLowerCase())) return "image";
	return "unknown";
}

async function ensureFfmpegAvailable() {
	if (!ffmpegPath) return false;
	if (ffmpegProbePromise) return ffmpegProbePromise;
	ffmpegProbePromise = new Promise((resolve) => {
		const child = cp.spawn(ffmpegPath, ["-version"], { windowsHide: true });
		let handled = false;
		child.on("error", () => { handled = true; resolve(false); });
		child.on("close", (code) => { if (!handled) resolve(code === 0); });
	});
	return ffmpegProbePromise;
}

async function getMediaInfo(filePath, mtimeMs) {
	const cached = resolutionCache.get(filePath);
	if (cached && cached.mtime === mtimeMs) return cached;

	try {
		const result = await pythonBridge.identify(filePath);
		if (result && !result.error && result.width) {
			const info = {
				mtime: mtimeMs,
				res: `${result.width}x${result.height}`,
				width: result.width,
				height: result.height,
				codec: result.codec,
				codec_long_name: result.codec_long_name,
				duration: result.duration || 0,
				type: result.type || "unknown"
			};
			resolutionCache.set(filePath, info);
			if (resolutionCache.size > 200) resolutionCache.delete(resolutionCache.keys().next().value);
			return info;
		}
	} catch (e) { }

	if (!ffmpegPath) return null;

	return new Promise((resolve) => {
		const child = cp.spawn(ffmpegPath, ["-hide_banner", "-i", filePath], { windowsHide: true });
		let stderr = "";
		child.stderr.on("data", d => { if (stderr.length < 50000) stderr += d.toString(); });
		child.on("close", () => {
			const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
			const codecMatch = /Stream.*Video:\s*(.*?)(?:,|$)/i.exec(stderr);
			const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);
			let info = {
				mtime: mtimeMs, res: null, width: null, height: null, codec: null, duration: 0, type: "unknown"
			};
			if (resMatch) {
				const w = parseInt(resMatch[1]);
				const h = parseInt(resMatch[2]);
				info.res = `${w}x${h}`; info.width = w; info.height = h;
			}
			if (codecMatch && codecMatch[1]) info.codec = codecMatch[1].trim();
			if (durMatch) {
				const hours = parseFloat(durMatch[1]), mins = parseFloat(durMatch[2]), secs = parseFloat(durMatch[3]);
				const rawDuration = hours * 3600 + mins * 60 + secs;
				if (info.codec && info.codec.toLowerCase().includes('mjpeg') && rawDuration <= 0.1) {
					info.duration = 0; info.type = 'image';
				} else {
					info.duration = rawDuration;
				}
			}
			const ext = path.extname(filePath);
			if (info.type === "unknown") info.type = determineMediaType(info.codec, ext);
			resolutionCache.set(filePath, info);
			if (resolutionCache.size > 200) resolutionCache.delete(resolutionCache.keys().next().value);
			resolve(info.width ? info : null);
		});
		setTimeout(() => { try { child.kill(); } catch { } resolve(null); }, 2000);
	});
}

function getGifDurationFromBuffer(buffer) {
	if (!buffer || buffer.length < 13) return 0;
	try {
		let totalDelayCs = 0;
		let i = 13;
		const sig = buffer.slice(0, 6).toString('ascii');
		if (sig !== 'GIF87a' && sig !== 'GIF89a') return 0;
		const flags = buffer[10];
		if ((flags & 0x80) !== 0) i += 3 * Math.pow(2, (flags & 0x07) + 1);

		while (i < buffer.length - 1) {
			const blockType = buffer[i];
			if (blockType === 0x21) {
				const extLabel = buffer[i + 1];
				if (extLabel === 0xF9) {
					if (i + 6 < buffer.length) {
						totalDelayCs += buffer[i + 4] | (buffer[i + 5] << 8);
					}
					i += 8;
				} else if (extLabel === 0xFF || extLabel === 0xFE || extLabel === 0x01) {
					i += 2;
					let bs = buffer[i]; i += bs + 1;
					while (i < buffer.length && buffer[i] !== 0) i += buffer[i] + 1;
					i++;
				} else {
					i += 2;
					while (i < buffer.length && buffer[i] !== 0) i += buffer[i] + 1;
					i++;
				}
			} else if (blockType === 0x2C) {
				if (i + 10 > buffer.length) break;
				const imgFlags = buffer[i + 9];
				i += 10;
				if ((imgFlags & 0x80) !== 0) i += 3 * Math.pow(2, (imgFlags & 0x07) + 1);
				i++;
				while (i < buffer.length && buffer[i] !== 0) i += buffer[i] + 1;
				i++;
			} else if (blockType === 0x3B) break;
			else i++;
		}
		return totalDelayCs / 100;
	} catch (e) { return 0; }
}

function setPreviewCache(filePath, buffer, mtimeMs, gifDuration, outputSize) {
	if (previewCache.size >= MAX_PREVIEW_CACHE) previewCache.delete(previewCache.keys().next().value);
	previewCache.set(filePath, { buffer, mtimeMs, gifDuration, outputSize });
}

function buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize, duration) {
	let targetW = PREVIEW_WIDTH, targetH = PREVIEW_HEIGHT;
	const hasValidSize = origSize && typeof origSize.width === "number";
	if (hasValidSize) {
		const ow = origSize.width, oh = origSize.height;
		if (enlargeSmallImages || isVideo) {
			const scale = Math.min(PREVIEW_WIDTH / ow, PREVIEW_HEIGHT / oh);
			targetW = Math.max(1, Math.round(ow * scale)); targetH = Math.max(1, Math.round(oh * scale));
		} else {
			if (ow <= PREVIEW_WIDTH && oh <= PREVIEW_HEIGHT) { targetW = ow; targetH = oh; }
			else {
				const scale = Math.min(PREVIEW_WIDTH / ow, PREVIEW_HEIGHT / oh);
				targetW = Math.max(1, Math.round(ow * scale)); targetH = Math.max(1, Math.round(oh * scale));
			}
		}
	}
	const args = ["-hide_banner", "-loglevel", "error"];
	let expectedGifDuration = 0;
	if (isVideo) {
		const safeDuration = duration || 0;
		const fpsLimit = extremePerformanceMode ? 8 : 10;
		const scaleFlags = extremePerformanceMode ? "neighbor" : "bilinear";
		const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=${scaleFlags}`;

		if (extremePerformanceMode) {
			let clipStart = 1, clipDuration = 2;
			if (safeDuration > 0 && safeDuration < clipStart + clipDuration) {
				clipStart = Math.max(0, safeDuration - clipDuration - 0.5); clipDuration = Math.min(clipDuration, safeDuration - clipStart);
			}
			args.push("-ss", String(clipStart), "-t", String(clipDuration), "-i", filePath);
			args.push("-filter_complex", `[0:v]fps=${fpsLimit},${scaleFilter}[out_v]`, "-map", "[out_v]", "-f", "gif", "-loop", "0", "pipe:1");
			expectedGifDuration = clipDuration;
		} else if (safeDuration < 5) {
			let clipStart = Math.min(1, safeDuration * 0.1); let clipDuration = Math.min(4, safeDuration - clipStart);
			args.push("-ss", String(clipStart), "-t", String(clipDuration), "-i", filePath);
			args.push("-filter_complex", `[0:v]fps=${fpsLimit},${scaleFilter},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5[out_v]`, "-map", "[out_v]", "-f", "gif", "-loop", "0", "pipe:1");
			expectedGifDuration = clipDuration;
		} else {
			const seg = 1.3, s1 = 1, s2 = Math.floor(safeDuration / 2), s3 = Math.max(s2 + seg + 0.5, safeDuration - seg - 1);
			args.push("-ss", String(s1), "-t", String(seg), "-i", filePath);
			args.push("-ss", String(s2), "-t", String(seg), "-i", filePath);
			args.push("-ss", String(s3), "-t", String(seg), "-i", filePath);
			args.push("-filter_complex", `[0:v]fps=${fpsLimit},${scaleFilter}[v0];[1:v]fps=${fpsLimit},${scaleFilter}[v1];[2:v]fps=${fpsLimit},${scaleFilter}[v2];[v0][v1][v2]concat=n=3:v=1:a=0,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5[out_v]`, "-map", "[out_v]", "-f", "gif", "-loop", "0", "pipe:1");
			expectedGifDuration = seg * 3;
		}
	} else if (isGif) {
		if (extremePerformanceMode) args.push("-t", "2");
		args.push("-i", filePath);
		const scaleFlags = extremePerformanceMode ? "neighbor" : "bilinear";
		const fpsLimit = extremePerformanceMode ? 8 : 10;
		const f = extremePerformanceMode ? `[0:v]fps=${fpsLimit},scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=${scaleFlags}[out_v]` : `[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=${scaleFlags}[out_v]`;
		args.push("-filter_complex", f, "-map", "[out_v]", "-f", "gif", "-loop", "0", "pipe:1");
	} else {
		args.push("-i", filePath);
		const scaleFlags = extremePerformanceMode ? "neighbor" : "bilinear";
		args.push("-filter_complex", `[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=${scaleFlags}[out_v]`, "-map", "[out_v]");
		if (extremePerformanceMode) args.push("-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");
		else args.push("-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1");
	}
	return { args, targetW, targetH, expectedGifDuration };
}

async function getPreviewBuffer(filePath, isVideo, isGif) {
	if (!ffmpegPath) return null;
	let origSize = null, duration = 0, mtimeMs = 0;
	try { const st = fs.statSync(filePath); mtimeMs = st.mtimeMs; } catch { return null; }
	const info = await getMediaInfo(filePath, mtimeMs);
	if (info) { origSize = { width: info.width, height: info.height }; duration = info.duration; }

	if (extremePerformanceMode) {
		const c = previewCache.get(filePath); if (c) return { buffer: c.buffer, gifDuration: c.gifDuration, outputSize: c.outputSize };
	} else {
		const c = previewCache.get(filePath); if (c && c.mtimeMs === mtimeMs) return { buffer: c.buffer, gifDuration: c.gifDuration, outputSize: c.outputSize };
	}
	const ok = await ensureFfmpegAvailable(); if (!ok) return null;

	return new Promise((resolve) => {
		const { args, targetW, targetH, expectedGifDuration } = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize, duration);
		const child = cp.spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks = []; let resolved = false;
		child.stderr.on("data", () => { });
		const timer = setTimeout(() => { if (!resolved) { resolved = true; try { child.kill(); } catch { } resolve(null); } }, 30000);
		child.stdout.on("data", (d) => chunks.push(d));
		child.on("error", () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); } });
		child.on("close", () => {
			if (!resolved) {
				resolved = true; clearTimeout(timer);
				if (!chunks.length) { resolve(null); return; }
				const buffer = Buffer.concat(chunks);
				let gifDuration = expectedGifDuration;
				if (isGif && !isVideo) {
					gifDuration = getGifDurationFromBuffer(buffer);
					if (extremePerformanceMode && gifDuration > 2.5) gifDuration = 2.0;
				}
				const outputSize = { width: targetW, height: targetH };
				setPreviewCache(filePath, buffer, mtimeMs, gifDuration, outputSize);
				resolve({ buffer, gifDuration, outputSize });
			}
		});
	});
}

function computeMarginLeft() { return "100px"; }
function calculateAspectRatioString(w, h) {
	if (!w || !h) return "";
	if (w >= h) { const r = (h / w) * 16; return `16__${parseFloat(r.toFixed(1))}`; }
	else { const r = (w / h) * 16; return `${parseFloat(r.toFixed(1))}__16`; }
}
function createProgressSvg(durationSeconds) {
	if (!durationSeconds || durationSeconds <= 0) return null;
	const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="4" viewBox="0 0 512 4"><rect width="512" height="4" fill="black" /><rect width="0" height="4" fill="#fdf6e3"><animate attributeName="width" from="0" to="512" dur="${durationSeconds.toFixed(3)}s" repeatCount="indefinite" fill="freeze" calcMode="linear" /></rect></svg>`;
	return "data:image/svg+xml;base64," + Buffer.from(svgStr).toString("base64");
}
function invalidateFolderSizeCacheForPath(filePath) { try { const dir = path.dirname(filePath); if (qqqFolderSizeCache.has(dir)) qqqFolderSizeCache.delete(dir); } catch { } }
async function getQqqFolderSize(folderPath) {
	const now = Date.now(); const cached = qqqFolderSizeCache.get(folderPath);
	if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) return cached.data;
	try {
		const result = await pythonBridge.getFolderInfo(folderPath);
		if (result && result.success) {
			const parts = []; let totalFiles = 0;
			if (result.ext_stats) { for (const [ext, count] of Object.entries(result.ext_stats)) { totalFiles += count; parts.push(`${count}_${ext || '无后缀'}`); } }
			const summaryStr = parts.length > 0 ? `${totalFiles}个文件：${parts.join("; ")}` : (result.file_count_root > 0 ? `${result.file_count_root}个文件` : "空文件夹");
			const cachedData = { size: result.total_size, summary: summaryStr };
			qqqFolderSizeCache.set(folderPath, { data: cachedData, timestamp: now }); return cachedData;
		}
	} catch (e) { }
	return null;
}
async function initUserTracking(context) {
	const storageUri = context.globalStorageUri; const storagePath = storageUri.fsPath;
	if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });
	dbPath = path.join(storagePath, "da.sq3");
	try {
		const res = await pythonBridge.call("db_login", { db_path: dbPath });
		if (res && res.qession_id) {
			currentQessionId = res.qession_id;
			const stats = await pythonBridge.call("db_stats", { db_path: dbPath });
			if (stats && stats.forktted) vscode.window.setStatusBarMessage(`qqq累计使用: ${stats.forktted}`, 5000);
		}
	} catch (e) { }
}
async function finishUserTracking() {
	if (currentQessionId && dbPath) { try { await pythonBridge.call("db_logout", { db_path: dbPath, qession_id: currentQessionId }); } catch (e) { } }
}
async function executeClipboardComknd() {
	if (!isCoreIntegretyValid) { vscode.window.showErrorMessage("Integrity check failed."); return; }
	const editor = vscode.window.activeTextEditor;
	let targetDir = "D:\\view\\p";
	if (editor && !editor.document.isUntitled) targetDir = path.join(path.dirname(editor.document.uri.fsPath), "qqq");
	try {
		const result = await pythonBridge.handleClipboard(targetDir);
		if (result.error) { vscode.window.showWarningMessage("剪贴板处理失败：" + result.error); return; }
		handleReqlt(result);
	} catch (e) { vscode.window.showErrorMessage("剪贴板处理异常：" + e.message); }
}

function calculateBlankLinesN(isFramed, isLastItem = false) {
	try {
		const config = vscode.workspace.getConfiguration('editor');
		const fontSize = config.get('fontSize', 14);
		const lineHeightMultiplier = config.get('lineHeight', 0);
		const effectiveLineHeight = (lineHeightMultiplier === 0) ? 1.35 : lineHeightMultiplier;
		const pixelPerLine = fontSize * effectiveLineHeight;
		const requiredHeight = PREVIEW_HEIGHT;
		let baseN = Math.ceil(requiredHeight / pixelPerLine);
		let extra = 2 + Math.floor((effectiveLineHeight - 1) * 3); extra = Math.min(5, Math.max(2, extra));
		let n = baseN + extra; n = Math.max(4, n);
		if (isLastItem) { if (isFramed) n = Math.max(8, n); else n = 2; }
		else { if (!isFramed) n = 2; }
		return n;
	} catch (e) { return 15; }
}

// ==========================================
//           洁癖整理逻辑 (升级版：强制隔离)
// ==========================================

function provideCleanlinessEdits(document) {
	const edits = [];
	const text = document.getText();
	const regex = new RegExp(QQQ_PATH_REGEX);
	const eol = getDocumentEOL(document);

	let match; const markers = [];
	while ((match = regex.exec(text))) markers.push({ text: match[0], index: match.index });

	for (let i = markers.length - 1; i >= 0; i--) {
		const m = markers[i];
		const pos = document.positionAt(m.index);
		const markerLine = pos.line;

		const rawPath = m.text.slice(2, -2).trim();
		const isVidOrImg = isImageOrVideoExt(path.extname(rawPath));

		// 1. 检查暗号本身是否独占一行 (去掉首尾空白后对比)
		const lineText = document.lineAt(markerLine).text;
		const matchText = m.text;

		if (lineText.trim() !== matchText.trim()) {
			const lineRange = document.lineAt(markerLine).range;
			// 暴力清理：不管这行有什么，直接替换为干净的暗号，并在前后加换行
			const cleanBlock = eol + matchText + eol;
			edits.push(vscode.TextEdit.replace(lineRange, cleanBlock));
			// 注意：替换整行后，后续空行检测可能不准，留给下一次触发
			continue;
		}

		// 2. 下方空行逻辑
		let isLastMarkerInDoc = (i === markers.length - 1);
		const n = calculateBlankLinesN(isVidOrImg, isLastMarkerInDoc);
		let currentBlanks = 0; let nextContentLine = -1;
		for (let lineIdx = markerLine + 1; lineIdx < document.lineCount; lineIdx++) {
			const lText = document.lineAt(lineIdx).text;
			if (lText.trim() === "") currentBlanks++; else { nextContentLine = lineIdx; break; }
		}
		if (currentBlanks !== n) {
			const idealString = eol.repeat(n);
			const startReplaceRow = markerLine + 1; const endReplaceRow = (nextContentLine === -1) ? document.lineCount : nextContentLine;
			const range = new vscode.Range(new vscode.Position(startReplaceRow, 0), new vscode.Position(endReplaceRow, 0));
			edits.push(vscode.TextEdit.replace(range, idealString));
		}
	}
	return edits;
}

async function performGlobalClean(editor, force = false) {
	if (!editor) return;
	if (!force) {
		if (!cleanFreakMode) return;
		const now = Date.now(); if (now - lastGlobalCleanTime < 1000) return;
		lastGlobalCleanTime = now;
	}
	const edits = provideCleanlinessEdits(editor.document);
	if (edits.length > 0) await editor.edit(editBuilder => { edits.forEach(e => editBuilder.replace(e.range, e.newText)); });
}

// ==========================================
//           粘贴逻辑 (强制换行)
// ==========================================

function handleReqlt(reqlt) {
	if (reqlt.error) { vscode.window.showErrorMessage(reqlt.error); return; }
	const ed = vscode.window.activeTextEditor; if (!ed) return;
	const onDone = (files) => {
		if (files) files.forEach(f => invalidateFolderSizeCacheForPath(f));
		setTimeout(() => renderIkges(ed), 100);
	};

	if (reqlt.type === "folder_text" || reqlt.type === "text") {
		ed.edit(e => e.insert(ed.selection.active, reqlt.text)).then(() => onDone());
	}
	else if (reqlt.type === "ikge" || reqlt.type === "file") {
		const files = (reqlt.type === "ikge" || reqlt.files.length === 1) ? [reqlt.path || reqlt.files[0]] : reqlt.files;
		const eol = getDocumentEOL(ed.document);

		// 强制前后都有换行，确保独立
		let insertionText = eol;

		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			const isVidOrImg = isImageOrVideoExt(path.extname(f));
			const isLastItem = (i === files.length - 1);

			if (i > 0) insertionText += eol;

			insertionText += `/\\${f}\\/`;

			if (!isLastItem) {
				const gapBelow = calculateBlankLinesN(isVidOrImg, false);
				insertionText += eol.repeat(gapBelow + 1);
			} else {
				const requiredGapBelow = calculateBlankLinesN(isVidOrImg, true);
				insertionText += eol.repeat(requiredGapBelow);
			}
		}

		// 确保后面也有换行
		insertionText += eol;

		ed.edit(e => e.insert(ed.selection.active, insertionText)).then(() => {
			if (files.length > 1) vscode.window.showInformationMessage("文件已复制 " + files.length);
			onDone(files);
		});
	} else if (reqlt.type === "binary") vscode.window.showInformationMessage("二进制已保存");
	else if (reqlt.type === "cancelled") vscode.window.showInformationMessage("粘贴已取消");
}

// ==========================================
//           渲染主逻辑 (after + 穿透 + 归零锚点)
// ==========================================

async function renderIkges(editor) {
	if (!editor) return;
	if (!isCoreIntegretyValid) { clearDecorations(); return; }
	const myRenderVersion = ++currentRenderVersion;

	if (!decorationType) decorationType = vscode.window.createTextEditorDecorationType({ isWholeLine: false });
	if (!markerHideType) markerHideType = vscode.window.createTextEditorDecorationType({ textDecoration: 'none; font-size: 11px; color: transparent; opacity: 0;' });

	const docUri = editor.document.uri.toString();
	if (!documentDecorationsMap.has(docUri)) documentDecorationsMap.set(docUri, new Map());
	const currentDocDecos = documentDecorationsMap.get(docUri);
	const currentHideDecos = new Map();
	const visibleRanges = editor.visibleRanges;
	if (!visibleRanges || !visibleRanges.length) return;

	const marginLeft = computeMarginLeft();
	const boxWidth = PREVIEW_WIDTH + PREVIEW_BORDER;
	const boxHeight = PREVIEW_HEIGHT + PREVIEW_BORDER;
	const tasks = [];

	const regex = new RegExp(QQQ_PATH_REGEX);

	for (const range of visibleRanges) {
		const text = editor.document.getText(range);
		regex.lastIndex = 0; let match;
		while ((match = regex.exec(text))) {
			const offset = editor.document.offsetAt(range.start) + match.index;
			const pos = editor.document.positionAt(offset);
			const endPos = editor.document.positionAt(offset + match[0].length);
			const uniqueKey = `${pos.line}_${pos.character}`;

			const hideDeco = { range: new vscode.Range(pos, endPos) };
			currentHideDecos.set(uniqueKey, hideDeco);
			if (currentDocDecos.has(uniqueKey)) continue;

			const rawPath = match[0].slice(2, -2).trim();

			const absPath = rawPath.replace(/\//g, "\\");
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const ext = path.extname(absPath).toLowerCase();
			let isImage = isImageExt(ext); let isVideo = isVideoExt(ext); let isGif = ext === ".gif";
			let mtimeMs = 0; try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }
			let mediaInfo = null;
			if (!isImage && !isVideo) {
				mediaInfo = await getMediaInfo(absPath, mtimeMs);
				if (mediaInfo && mediaInfo.type === "video") isVideo = true;
				else if (mediaInfo && mediaInfo.type === "image") { isImage = true; if (mediaInfo.codec === "gif") isGif = true; }
				else continue;
			}

			// ★★★ 归零锚点策略 ★★★
			// 无论暗号前面有什么空格，相框永远锚定在行首 (Column 0)
			const targetLine = pos.line;
			if (targetLine >= editor.document.lineCount) continue;
			const anchorRange = new vscode.Range(targetLine, 0, targetLine, 0);

			const task = async () => {
				if (currentRenderVersion !== myRenderVersion) return null;
				try {
					let previewResult = null;
					if (ffmpegPath) {
						previewResult = await getPreviewBuffer(absPath, isVideo, isGif);
						if (currentRenderVersion !== myRenderVersion) return null;
					}
					const deco = { range: anchorRange, renderOptions: {} };
					let contentUrl = ""; let actualGifDuration = 0; let outputSize = null;

					if (previewResult && previewResult.buffer) {
						let mime = "image/png"; if (isGif || isVideo) mime = "image/gif"; else if (extremePerformanceMode) mime = "image/jpeg";
						const b64 = previewResult.buffer.toString("base64");
						contentUrl = `url("data:${mime};base64,${b64}")`;
						if (previewResult.gifDuration && previewResult.gifDuration > 0) actualGifDuration = previewResult.gifDuration;
						outputSize = previewResult.outputSize;
					} else if (isImage && !isVideo && !isGif) {
						const fileUri = vscode.Uri.file(absPath); contentUrl = `url("${fileUri.toString()}")`;
					}
					if (!contentUrl) return null;

					let progressBarUrl = null;
					if ((isGif || isVideo) && actualGifDuration > 0) progressBarUrl = `url("${createProgressSvg(actualGifDuration)}")`;
					const gridSize = "20px 20px";
					const gridImage = `conic-gradient(#fdf6e3 0.25turn, #e6e1cf 0.25turn 0.5turn, #fdf6e3 0.5turn 0.75turn, #e6e1cf 0.75turn)`;

					let layers = [], sizes = [], positions = [], repeats = [];
					if (watermarkBase64) { layers.push(`url("${watermarkBase64}")`); sizes.push("contain"); positions.push("center center"); repeats.push("no-repeat"); }
					if (progressBarUrl) { layers.push(progressBarUrl); sizes.push("512px 4px"); positions.push("center bottom"); repeats.push("no-repeat"); }
					layers.push(contentUrl);
					if (outputSize) sizes.push(`${outputSize.width}px ${outputSize.height}px`); else sizes.push("contain");
					positions.push("center center"); repeats.push("no-repeat");
					layers.push(gridImage); sizes.push(gridSize); positions.push("0 0"); repeats.push("repeat");

					const baseStyle = {
						position: 'absolute',
						left: marginLeft,
						top: '0px',
						width: `${boxWidth}px`, height: `${boxHeight}px`,
						padding: "2px", border: "1px dashed #888", backgroundColor: PREVIEW_BG_COLOR, zIndex: -1
					};

					// ★★★ 使用 after + pointer-events: none (防止遮挡文字) ★★★
					deco.renderOptions.after = {
						contentText: "", ...baseStyle,
						textDecoration: `none; pointer-events: none; display: inline-block; background-image: ${layers.join(", ")}; background-size: ${sizes.join(", ")}; background-position: ${positions.join(", ")}; background-repeat: ${repeats.join(", ")};`
					};
					return { key: uniqueKey, deco };
				} catch (e) { return null; }
			};
			tasks.push(task);
		}
	}

	if (tasks.length > 0) {
		const results = [];
		for (let i = 0; i < tasks.length; i += MAX_CONCURRENT_TASKS) {
			if (currentRenderVersion !== myRenderVersion) return;
			const chunk = tasks.slice(i, i + MAX_CONCURRENT_TASKS);
			const chunkResults = await Promise.all(chunk.map(t => t()));
			results.push(...chunkResults);
		}
		if (currentRenderVersion !== myRenderVersion) return;
		for (const res of results) { if (res) currentDocDecos.set(res.key, res.deco); }
	}
	editor.setDecorations(decorationType, Array.from(currentDocDecos.values()));
	if (currentHideDecos.size > 0) editor.setDecorations(markerHideType, Array.from(currentHideDecos.values()));
}

function parseHexColorToRGB(hex) {
	if (typeof hex !== "string") return null;
	const s = hex.trim();
	if (!s.startsWith("#")) return null;
	if (s.length === 7) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
	if (s.length === 4) return [parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16), parseInt(s[3] + s[3], 16)];
	return null;
}
function getEditorBackgroundRGB() {
	try {
		const bg = vscode.workspace.getConfiguration("workbench").get("colorCustomizations")?.["editor.background"];
		const parsed = parseHexColorToRGB(bg); if (parsed) return parsed;
	} catch { }
	const kind = vscode.window.activeColorTheme.kind;
	return (kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast) ? [30, 30, 30] : [255, 255, 255];
}
async function updateGlobalCodeLensColor(isActive) {
	try {
		const [bgR, bgG, bgB] = getEditorBackgroundRGB();
		const alpha = isActive ? 1 : 22 / 255;
		const color = `rgba(${255 - bgR}, ${255 - bgG}, ${255 - bgB}, ${alpha.toFixed(3)})`;
		if (color === lastCodeLensColor && isActive === lastCodeLensIsActive) return;
		lastCodeLensColor = color; lastCodeLensIsActive = isActive;
		const conf = vscode.workspace.getConfiguration("workbench");
		const custom = conf.get("colorCustomizations") || {};
		if (custom["editorCodeLens.foreground"] === color) return;
		await conf.update("colorCustomizations", { ...custom, "editorCodeLens.foreground": color }, vscode.ConfigurationTarget.Global);
	} catch { }
}
function updateCodeLensColorForEditor(editor) {
	if (!editor) { updateGlobalCodeLensColor(false); return; }
	const set = lensLinesByDocUri.get(editor.document.uri.toString());
	const isActive = set && set.has(editor.selection.active.line);
	updateCodeLensColorForEditor(isActive);
}

class FileCodeLensProvider {
	async provideCodeLenses(document) {
		if (!isCoreIntegretyValid) return [];

		const lenses = [];
		const regex = new RegExp(QQQ_PATH_REGEX);
		const text = document.getText();
		let match;
		const lensLines = new Set();
		const tasks = [];

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const rawPath = match[0].slice(2, -2).trim();

			const absPath = rawPath.replace(/\//g, "\\");
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const folder = path.dirname(absPath);
			const ext = path.extname(absPath).toLowerCase();
			const isVidOrImg = isImageOrVideoExt(ext);
			const isVideoExtFlag = isVideoExt(ext);

			const targetLensLine = pos.line;

			tasks.push(async () => {
				let folderData = await getQqqFolderSize(folder);
				const fSize = folderData ? folderData.size : 0;
				const fSizeStr = formatBytes(fSize);
				const folderTooltip = folderData ? folderData.summary : undefined;

				let fileSz = "?"; let tooltipText = ""; let mtimeMs = 0;
				try {
					const st = fs.statSync(absPath); fileSz = formatBytes(st.size);
					const bTime = new Date(st.birthtime).toLocaleString(); const mTime = new Date(st.mtime).toLocaleString();
					tooltipText = `创建: ${bTime}\n修改: ${mTime}`; mtimeMs = st.mtimeMs;
				} catch { }

				let titleSuffix = ""; let isRealVideo = false;
				if (isVidOrImg) {
					const info = await getMediaInfo(absPath, mtimeMs);
					if (info && info.width && info.height) {
						let scale = 1; const MAX_W = PREVIEW_WIDTH, MAX_H = PREVIEW_HEIGHT;
						if (info.type === "video") isRealVideo = true;
						if (isRealVideo || isVideoExtFlag || enlargeSmallImages) scale = Math.min(MAX_W / info.width, MAX_H / info.height);
						else { if (info.width <= MAX_W && info.height <= MAX_H) scale = 1; else scale = Math.min(MAX_W / info.width, MAX_H / info.height); }
						const pct = Math.round(scale * 100);
						titleSuffix = `   (${pct}%)  ${info.width}x${info.height}`;
						if (info.codec) { tooltipText += `\n编解码器: ${info.codec}`; if (info.codec_long_name) tooltipText += ` (${info.codec_long_name})`; }
						const arStr = calculateAspectRatioString(info.width, info.height); if (arStr) tooltipText += `\n宽高比：${arStr}`;
						if (shouldShowDuration(info)) tooltipText += `\n⌛原始时长：${formatDuration(info.duration)}`;
					}
				}

				const iconPart = isRealVideo ? "🎬" : ""; const spacePart = isRealVideo ? " " : "   ";
				const r = new vscode.Range(targetLensLine, 0, targetLensLine, 0);

				return [
					new vscode.CodeLens(r, {
						title: `✎( ${fSizeStr}) 🗀qqq`, command: "qqq.revealFileInFolder", arguments: [absPath], tooltip: folderTooltip
					}),
					new vscode.CodeLens(r, { title: "✎rename", command: "qqq.renameFile", arguments: [rawPath, absPath] }),
					new vscode.CodeLens(r, {
						title: `✎( ${fileSz})${iconPart}${spacePart}${absPath}${titleSuffix}`, command: "qqq.openFile", arguments: [absPath], tooltip: tooltipText
					})
				];
			});

			lensLines.add(targetLensLine);
		}

		const results = await Promise.all(tasks.map(t => t()));
		results.forEach(group => lenses.push(...group));
		lensLinesByDocUri.set(document.uri.toString(), lensLines);
		updateCodeLensColorForEditor(vscode.window.activeTextEditor);
		return lenses;
	}
}

function openFileComknd(filePath) {
	if (!fs.existsSync(filePath)) return;
	try {
		if (process.platform === "win32") cp.exec(`start "" "${filePath.replace(/"/g, '""')}"`);
		else if (process.platform === "darwin") cp.exec(`open "${filePath}"`);
		else cp.exec(`xdg-open "${filePath}"`);
	} catch { vscode.env.openExternal(vscode.Uri.file(filePath)); }
}
function revealFileInFolder(filePath) {
	if (!fs.existsSync(filePath)) return;
	try {
		if (process.platform === "win32") cp.exec(`explorer /select,"${filePath.replace(/"/g, '""')}"`);
		else if (process.platform === "darwin") cp.exec(`open -R "${filePath}"`);
		else cp.exec(`xdg-open "${path.dirname(filePath)}"`);
	} catch { }
}
async function renameFileComknd(rawPath, absPath) {
	const editor = vscode.window.activeTextEditor; if (!editor) return;
	const currentName = path.basename(absPath);
	const newName = await vscode.window.showInputBox({
		title: "重命名粘贴文件", prompt: "rename  ", value: currentName, ignoreFocusOut: true, validateInput: v => (!v || !v.trim()) ? "文件名不能为空" : null
	});
	if (!newName || newName.trim() === currentName) return;
	const trimmed = newName.trim(); const newAbs = path.join(path.dirname(absPath), trimmed);
	try { await fs.promises.rename(absPath, newAbs); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
	const doc = editor.document;
	const escaped = rawPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	const regex = new RegExp(QQQ_PATH_REGEX);
	const newRaw = buildNewRawPath(rawPath, trimmed);

	const ranges = []; let m; const txt = doc.getText();
	while ((m = regex.exec(txt))) {
		const matchedRaw = m[0].slice(2, -2).trim();
		if (matchedRaw === rawPath) {
			const s = doc.positionAt(m.index);
			const e = doc.positionAt(m.index + m[0].length);
			ranges.push(new vscode.Range(s, e));
		}
	}
	if (ranges.length) await editor.edit(b => ranges.forEach(r => b.replace(r, `/\\${newRaw}\\/`)));
	invalidateFolderSizeCacheForPath(newAbs); renderVisibleEditors();
}

function debounceRender(editor, delay = SCROLL_DEBOUNCE_MS) {
	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => { if (editor && !editor.document.isClosed) renderIkges(editor); }, delay);
}
function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors; if (editors && editors.length) editors.forEach(e => debounceRender(e, delay));
}

async function activate(context) {
	extensionContext = context;
	isCoreIntegretyValid = verifySystemIntegrity(); console.log(`[QQQ Q1] Integrity: ${isCoreIntegretyValid ? "PASSED" : "FAILED"}`);
	if (!isCoreIntegretyValid) return;
	loadWatermarkResource(); refreshQqqConfig(); initUserTracking(context); updateGlobalCodeLensColor(false);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("qqq")) {
				refreshQqqConfig(); previewCache.clear(); documentDecorationsMap.clear(); renderVisibleEditors();
				if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor);
			}
			if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("editor.lineHeight")) {
				refreshQqqConfig(); if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor);
			}
		}),
		vscode.commands.registerCommand("qqq.q1", executeClipboardComknd),
		vscode.commands.registerCommand("qqq.openFile", openFileComknd),
		vscode.commands.registerCommand("qqq.revealFileInFolder", revealFileInFolder),
		vscode.commands.registerCommand("qqq.renameFile", renameFileComknd),
		vscode.commands.registerCommand("qqq.setInOrder", () => { performGlobalClean(vscode.window.activeTextEditor, true); }),
		vscode.languages.registerCodeLensProvider({ scheme: "file" }, new FileCodeLensProvider()),
		vscode.workspace.onWillSaveTextDocument(e => {
			if (cleanFreakMode && e.document) { const edits = provideCleanlinessEdits(e.document); if (edits.length > 0) e.waitUntil(Promise.resolve(edits)); }
		}),
		vscode.window.onDidChangeTextEditorVisibleRanges(e => debounceRender(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(e => { if (e) debounceRender(e); updateCodeLensColorForEditor(e); }),
		vscode.window.onDidChangeWindowState(e => { if (e.focused) renderVisibleEditors(); }),
		vscode.workspace.onDidChangeTextDocument(e => {
			const ed = vscode.window.activeTextEditor; if (ed && e.document === ed.document) debounceRender(ed);
			if (e.document === ed?.document && e.contentChanges.length > 0) documentDecorationsMap.delete(e.document.uri.toString());
		}),
		vscode.workspace.onDidCloseTextDocument(doc => { documentDecorationsMap.delete(doc.uri.toString()); }),
		vscode.window.onDidChangeVisibleTextEditors(editors => {
			renderVisibleEditors(); if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor);
		}),
		vscode.window.onDidChangeTextEditorSelection(e => updateCodeLensColorForEditor(e.textEditor)),
		vscode.window.onDidChangeActiveColorTheme(() => updateCodeLensColorForEditor(vscode.window.activeTextEditor))
	);
	const editor = vscode.window.activeTextEditor; if (editor) renderIkges(editor);
}
async function deactivate() { clearDecorations(); await finishUserTracking(); }
module.exports = { activate, deactivate };

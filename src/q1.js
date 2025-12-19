// src/q1.js
// ==========================================
// ★★★ 转码兜底 + 错误日志 + 配置dispose + 多编辑器独立防抖 ★★★
// ==========================================
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const qqq = require("./qqq");
const q1a = require("./q1a");

const CORE_INTEGRITY_HASH = "dc10f424bef818e80eea0a5175bbb6cca07cbee34c8510c7b64069ef1661c88e";
let isCoreIntegrityValid = false;

// ==================== 配置常量 ====================
const MAX_CONCURRENT_TASKS = 8;
const SCROLL_DEBOUNCE_MS = 200;
const LARGE_PREVIEW_WIDTH = 512;
const LARGE_PREVIEW_HEIGHT = 288;
const SMALL_PREVIEW_WIDTH = 256;
const SMALL_PREVIEW_HEIGHT = 144;
const PREVIEW_BORDER = 6;
const PREVIEW_BG_COLOR = "#fef6e3";

const PROGRESS_SYNC_INTERVAL_MS = 3000;

const FALLBACK_DIRECT_READ_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
const FALLBACK_MAX_SIZE = 4 * 1024 * 1024;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg", ".ai", ".eps", ".cdr", ".psd"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov"]);

// ==================== 全局状态 ====================
let decorationType = null;
let markerHideType = null;
let extensionContext = null;
let currentRenderVersion = 0;

const documentDecorationsMap = new Map();
const resolutionCache = new Map();
const folderSizeCache = new Map();
const pendingTokens = new Map();

const editorDebounceTimers = new Map();

let progressSyncTimer = null;
const animatedDecorationKeys = new Map();

let enlargeSmallImages = true;
let performanceMode = "balanced";
let frameSizeMode = "smart";
let cleanFreakMode = false;

let watermarkBase64 = null;
const WATERMARK_PATH = path.join(__dirname, "..", "assets", "q2.gif");

const LOADING_SVG = `data:image/svg+xml;base64,` + Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">
  <circle cx="20" cy="20" r="8" fill="#888"><animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" begin="0s"/></circle>
  <circle cx="60" cy="20" r="8" fill="#888"><animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" begin="0.33s"/></circle>
  <circle cx="100" cy="20" r="8" fill="#888"><animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" begin="0.66s"/></circle>
</svg>`).toString('base64');

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
		if (extremePerformance) {
			performanceMode = "extreme";
		} else {
			performanceMode = config.get("performanceMode", "balanced");
		}

		frameSizeMode = config.get("frameSizeMode", "smart");
		cleanFreakMode = config.get("cleanFreak", false);
	} catch (e) {
		enlargeSmallImages = true;
		performanceMode = "balanced";
		frameSizeMode = "smart";
		cleanFreakMode = false;
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
	animatedDecorationKeys.clear();
}

function clearEditorDebounceTimer(editorId) {
	const timer = editorDebounceTimers.get(editorId);
	if (timer) {
		clearTimeout(timer);
		editorDebounceTimers.delete(editorId);
	}
}

function clearAllEditorDebounceTimers() {
	for (const timer of editorDebounceTimers.values()) {
		clearTimeout(timer);
	}
	editorDebounceTimers.clear();
}

// ==================== 严重错误日志 ====================

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

// ==================== 进度条同步定时器 ====================

function startProgressSyncTimer() {
	if (progressSyncTimer) return;

	progressSyncTimer = setInterval(() => {
		let hasAnimations = false;
		for (const [, keys] of animatedDecorationKeys) {
			if (keys.size > 0) {
				hasAnimations = true;
				break;
			}
		}

		if (hasAnimations) {
			forceResyncAnimatedDecorations();
		}
	}, PROGRESS_SYNC_INTERVAL_MS);
}

function stopProgressSyncTimer() {
	if (progressSyncTimer) {
		clearInterval(progressSyncTimer);
		progressSyncTimer = null;
	}
}

function forceResyncAnimatedDecorations() {
	const editors = vscode.window.visibleTextEditors;

	for (const editor of editors) {
		const docUri = editor.document.uri.toString();
		const animatedKeys = animatedDecorationKeys.get(docUri);

		if (animatedKeys && animatedKeys.size > 0) {
			const currentDecos = documentDecorationsMap.get(docUri);
			if (currentDecos) {
				for (const key of animatedKeys) {
					currentDecos.delete(key);
				}
			}
			animatedKeys.clear();
			debounceRender(editor, 10);
		}
	}
}

// ==================== 统一 Frame 尺寸逻辑 ====================

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
			} else {
				mode = "large";
				width = LARGE_PREVIEW_WIDTH;
				height = LARGE_PREVIEW_HEIGHT;
			}
		}
	}

	return { mode, width, height };
}

// ==================== FFprobe 探测 ====================

async function getMediaInfo(filePath, mtimeMs) {
	const cached = resolutionCache.get(filePath);
	if (cached && cached.mtime === mtimeMs) return cached;

	if (!qqq.ffmpegPath) return null;

	return new Promise((resolve) => {
		const child = cp.spawn(qqq.ffmpegPath, ["-hide_banner", "-i", filePath], { windowsHide: true });
		let stderr = "";

		child.stderr.on("data", d => {
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
				needsConversion: false
			};

			if (resMatch) {
				const w = parseInt(resMatch[1]);
				const h = parseInt(resMatch[2]);
				info.res = `${w}x${h}`;
				info.width = w;
				info.height = h;
			}

			if (durMatch) {
				const h = parseFloat(durMatch[1]);
				const m = parseFloat(durMatch[2]);
				const s = parseFloat(durMatch[3]);
				info.duration = h * 3600 + m * 60 + s;
			}

			if (codecMatch?.[1]) {
				info.full_codec_desc = codecMatch[1].trim();
				const parts = info.full_codec_desc.split(/[,\s]+/);
				info.codec = parts[0].trim().toLowerCase();
			}

			const isStaticByDuration = info.duration <= 0.1;

			if (info.codec) {
				const c = info.codec;

				if (c.includes('mjpeg') || c === 'jpeg') {
					if (isStaticByDuration) {
						info.type = 'image';
						info.isStaticImage = true;
						info.isMjpegStatic = true;
					} else {
						info.type = 'video';
					}
				} else if (['png', 'bmp', 'tiff', 'webp', 'svg', 'pdf'].some(x => c.includes(x))) {
					info.type = 'image';
					info.isStaticImage = isStaticByDuration;
				} else if (c.includes('gif')) {
					if (isStaticByDuration) {
						info.type = 'image';
						info.isStaticImage = true;
					} else {
						info.type = 'animated_image';
					}
				} else if (['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2', 'mpeg1'].some(x => c.includes(x))) {
					info.type = 'video';
				}
			}

			if (info.type === 'unknown') {
				if (VIDEO_EXTS.has(ext)) {
					info.type = 'video';
				} else if (IMAGE_EXTS.has(ext)) {
					info.type = 'image';
					info.isStaticImage = true;
				}
			}

			if (!info.width && ['.ai', '.eps', '.psd', '.cdr'].includes(ext)) {
				info.type = 'image';
				info.isStaticImage = true;
				info.width = 512;
				info.height = 512;
				info.needsConversion = true;
			}

			resolutionCache.set(filePath, info);

			if (resolutionCache.size > 200) {
				resolutionCache.delete(resolutionCache.keys().next().value);
			}

			resolve(info.width ? info : null);
		});

		child.on("error", () => resolve(null));

		setTimeout(() => {
			try { child.kill(); } catch { }
			resolve(null);
		}, 5000);
	});
}

// ==================== 精确解析 WebP 时长 ====================

function getWebPDurationFromBuffer(buffer) {
	if (!buffer || buffer.length < 12) return 0;
	if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return 0;

	let pos = 12;
	let totalDurationMs = 0;
	let frameCount = 0;

	while (pos < buffer.length - 8) {
		const chunkId = buffer.toString('ascii', pos, pos + 4);
		const chunkSize = buffer.readUInt32LE(pos + 4);
		const nextChunkPos = pos + 8 + chunkSize + (chunkSize % 2);

		if (chunkId === 'ANMF') {
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

// ==================== 缓存策略与转码 ====================

function determineCacheStrategy(filePath, info) {
	const previewWidth = LARGE_PREVIEW_WIDTH;
	const previewHeight = LARGE_PREVIEW_HEIGHT;

	const ext = path.extname(filePath).toLowerCase();
	let fileSize = 0;
	try {
		fileSize = fs.statSync(filePath).size;
	} catch { }

	const isStatic = info?.isStaticImage === true;
	const isMjpegStatic = info?.isMjpegStatic === true;
	const simpleFormats = ['.png', '.jpg', '.jpeg', '.svg'];
	const canDirectRead = simpleFormats.includes(ext) || (ext === '.webp' && isStatic);

	let shouldBypassCache = false;

	if (isMjpegStatic) {
		shouldBypassCache = true;
	} else if (isStatic &&
		canDirectRead &&
		!info?.needsConversion &&
		info?.width && info?.height &&
		info.width <= 512 && info.height <= 512 &&
		fileSize < 300 * 1024) {
		shouldBypassCache = true;
	}

	let qualityLevel;
	switch (performanceMode) {
		case "extreme":
			qualityLevel = 39;
			break;
		case "accelerated":
			qualityLevel = 38;
			break;
		case "balanced":
		default:
			qualityLevel = 70;
	}

	const cacheKey = `${qualityLevel}`;

	return { shouldBypassCache, previewWidth, previewHeight, cacheKey, qualityLevel, isMjpegStatic };
}

function buildUnifiedWebPArgs(filePath, origSize, duration, qualityLevel, previewWidth, previewHeight) {
	let targetW = previewWidth;
	let targetH = previewHeight;

	if (origSize?.width && !origSize?.needsConversion) {
		const ow = origSize.width;
		const oh = origSize.height;

		if (ow > 512 || oh > 512) {
			const scale = Math.min(previewWidth / ow, previewHeight / oh);
			targetW = Math.max(1, Math.round(ow * scale));
			targetH = Math.max(1, Math.round(oh * scale));
		} else {
			targetW = ow;
			targetH = oh;
		}
	}

	const args = ["-hide_banner", "-loglevel", "error"];
	let expectedWebPDuration = 0;
	const isStatic = (duration <= 0.1);
	const isGifLike = !isStatic && duration > 0.1 && duration < 10;

	const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=bilinear,format=yuva420p`;
	let vf = scaleFilter;

	if (performanceMode === "extreme") {
		args.push("-ss", "0", "-i", filePath);
		vf = `[0:v]${scaleFilter}[out_v]`;
		args.push("-frames:v", "1");
		expectedWebPDuration = 0;
	} else if (performanceMode === "accelerated") {
		args.push("-ss", "0", "-i", filePath);

		if (isStatic) {
			vf = `[0:v]${scaleFilter}[out_v]`;
			args.push("-frames:v", "1");
			expectedWebPDuration = 0;
		} else {
			let clipDur = Math.min(2, duration);
			if (duration > 2) {
				let clipStart = Math.min(1, duration * 0.1);
				clipDur = Math.min(2, duration - clipStart);
				args.push("-ss", String(clipStart));
			}
			args.push("-t", String(clipDur));
			vf = `[0:v]fps=6,${scaleFilter}[out_v]`;
			expectedWebPDuration = clipDur;
		}
	} else {
		if (isStatic) {
			args.push("-ss", "0", "-i", filePath);
			vf = `[0:v]${scaleFilter}[out_v]`;
			args.push("-frames:v", "1");
			expectedWebPDuration = 0;
		} else if (isGifLike) {
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

			vf = `[0:v]fps=15,${scaleFilter}[v0];[1:v]fps=15,${scaleFilter}[v1];[2:v]fps=15,${scaleFilter}[v2];[v0][v1][v2]concat=n=3:v=1:a=0[out_v]`;
			expectedWebPDuration = seg * 3;
		}
	}

	args.push("-filter_complex", vf, "-map", "[out_v]");
	args.push("-c:v", "libwebp", "-lossless", "0", "-compression_level", "0", "-q:v", String(qualityLevel), "-loop", "0", "-an", "-vsync", "0", "-f", "webp");

	return { args, targetW, targetH, expectedWebPDuration };
}

function tryFallbackDirectRead(filePath, renderW, renderH, info) {
	const ext = path.extname(filePath).toLowerCase();
	if (!FALLBACK_DIRECT_READ_EXTS.has(ext)) return null;

	try {
		const st = fs.statSync(filePath);
		if (st.size > FALLBACK_MAX_SIZE) return null;

		const rawBuffer = fs.readFileSync(filePath);

		let finalCssW = info?.width || renderW;
		let finalCssH = info?.height || renderH;

		if (info?.width && info?.height) {
			if (enlargeSmallImages) {
				const scale = Math.min(renderW / info.width, renderH / info.height);
				finalCssW = Math.max(1, Math.round(info.width * scale));
				finalCssH = Math.max(1, Math.round(info.height * scale));
			} else {
				if (info.width > renderW || info.height > renderH) {
					const scale = Math.min(renderW / info.width, renderH / info.height);
					finalCssW = Math.max(1, Math.round(info.width * scale));
					finalCssH = Math.max(1, Math.round(info.height * scale));
				} else {
					finalCssW = info.width;
					finalCssH = info.height;
				}
			}
		}

		return {
			buffer: rawBuffer,
			webpDuration: 0,
			originalDuration: 0,
			outputSize: { width: finalCssW, height: finalCssH },
			isDirect: true,
			ext: ext,
			isFallback: true
		};
	} catch (e) {
		return null;
	}
}

async function getPreviewBuffer(filePath, contentId, renderW, renderH) {
	if (!qqq.ffmpegPath) return null;

	let mtimeMs = 0;
	try {
		mtimeMs = fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}

	const info = await getMediaInfo(filePath, mtimeMs);
	const origSize = info ? { width: info.width, height: info.height, needsConversion: info.needsConversion } : null;
	const originalDuration = info?.duration || 0;

	const cacheStrategy = determineCacheStrategy(filePath, info);
	const ext = path.extname(filePath).toLowerCase();

	// MJPEG 静态图：强制直通读取原文件
	if (cacheStrategy.isMjpegStatic) {
		try {
			const rawBuffer = fs.readFileSync(filePath);
			let finalCssW = info.width;
			let finalCssH = info.height;

			if (enlargeSmallImages) {
				const scale = Math.min(renderW / info.width, renderH / info.height);
				finalCssW = Math.max(1, Math.round(info.width * scale));
				finalCssH = Math.max(1, Math.round(info.height * scale));
			} else {
				if (info.width > renderW || info.height > renderH) {
					const scale = Math.min(renderW / info.width, renderH / info.height);
					finalCssW = Math.max(1, Math.round(info.width * scale));
					finalCssH = Math.max(1, Math.round(info.height * scale));
				}
			}

			return {
				buffer: rawBuffer,
				webpDuration: 0,
				originalDuration: 0,
				outputSize: { width: finalCssW, height: finalCssH },
				isDirect: true,
				ext: '.jpg',
				mimeType: 'image/jpeg'
			};
		} catch (e) {
			qqq.logMessage(`MJPEG 直通读取失败: ${e.message}`, "ERROR");
		}
	}

	// 尝试读取缓存
	if (!cacheStrategy.shouldBypassCache) {
		const cached = qqq.getCachedBuffer(contentId, cacheStrategy.cacheKey);

		if (cached) {
			const cacheEntry = qqq.getCacheEntry(contentId);
			const meta = cacheEntry?.qualities?.[cacheStrategy.cacheKey]?.meta || {};

			const origWidth = meta.origWidth || info?.width || 0;
			const origHeight = meta.origHeight || info?.height || 0;
			const cachedOriginalDuration = meta.originalDuration !== undefined ? meta.originalDuration : originalDuration;

			const webpDur = getWebPDurationFromBuffer(cached);

			let finalCssW = origWidth;
			let finalCssH = origHeight;

			if (origWidth > 0 && origHeight > 0) {
				if (enlargeSmallImages) {
					const scale = Math.min(renderW / origWidth, renderH / origHeight);
					finalCssW = Math.max(1, Math.round(origWidth * scale));
					finalCssH = Math.max(1, Math.round(origHeight * scale));
				} else {
					if (origWidth <= renderW && origHeight <= renderH) {
						finalCssW = origWidth;
						finalCssH = origHeight;
					} else {
						const scale = Math.min(renderW / origWidth, renderH / origHeight);
						finalCssW = Math.max(1, Math.round(origWidth * scale));
						finalCssH = Math.max(1, Math.round(origHeight * scale));
					}
				}
			} else {
				finalCssW = renderW;
				finalCssH = renderH;
			}

			return {
				buffer: cached,
				webpDuration: webpDur,
				originalDuration: cachedOriginalDuration,
				fromCache: true,
				outputSize: { width: finalCssW, height: finalCssH },
			};
		}
	}

	// 其他静态图直通读取
	if (cacheStrategy.shouldBypassCache && !cacheStrategy.isMjpegStatic) {
		try {
			const rawBuffer = fs.readFileSync(filePath);
			let finalCssW = info.width;
			let finalCssH = info.height;

			if (enlargeSmallImages) {
				const scale = Math.min(renderW / info.width, renderH / info.height);
				finalCssW = Math.max(1, Math.round(info.width * scale));
				finalCssH = Math.max(1, Math.round(info.height * scale));
			} else {
				if (info.width > renderW || info.height > renderH) {
					const scale = Math.min(renderW / info.width, renderH / info.height);
					finalCssW = Math.max(1, Math.round(info.width * scale));
					finalCssH = Math.max(1, Math.round(info.height * scale));
				}
			}

			return {
				buffer: rawBuffer,
				webpDuration: 0,
				originalDuration: originalDuration,
				outputSize: { width: finalCssW, height: finalCssH },
				isDirect: true,
				ext: ext
			};
		} catch (e) { }
	}

	// 转码生成
	return new Promise((resolve) => {
		const { args, targetW, targetH } = buildUnifiedWebPArgs(
			filePath, origSize, originalDuration, cacheStrategy.qualityLevel,
			cacheStrategy.previewWidth, cacheStrategy.previewHeight
		);

		const rand = Math.random().toString(36).slice(2);
		const tempFile = path.join(os.tmpdir(), `qqq_uni_${contentId}_${rand}.webp`);
		args.push("-y", tempFile);

		const child = cp.spawn(qqq.ffmpegPath, args, {
			windowsHide: true,
			stdio: ['ignore', 'ignore', 'pipe']
		});

		let ffErr = "";
		child.stderr?.on("data", d => {
			if (ffErr.length < 2000) ffErr += d.toString();
		});

		let resolved = false;

		const cleanup = () => {
			if (fs.existsSync(tempFile)) {
				try { fs.unlinkSync(tempFile); } catch { }
			}
		};

		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				try { child.kill(); } catch { }
				cleanup();

				const fallback = tryFallbackDirectRead(filePath, renderW, renderH, info);
				if (fallback) {
					logCriticalError(filePath, "TIMEOUT(30s) - 使用兜底直读");
					resolve(fallback);
				} else {
					logCriticalError(filePath, "TIMEOUT(30s) - 无法兜底");
					resolve(null);
				}
			}
		}, 30000);

		child.on("close", (code) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);

				let buffer = null;
				try {
					if (fs.existsSync(tempFile)) {
						buffer = fs.readFileSync(tempFile);
					}
				} catch (e) { }

				cleanup();

				if (!buffer) {
					const fallback = tryFallbackDirectRead(filePath, renderW, renderH, info);
					if (fallback) {
						if (ffErr.trim().length > 0) {
							logCriticalError(filePath, `EXIT_CODE=${code}\n${ffErr}`);
						}
						resolve(fallback);
						return;
					} else {
						if (ffErr.trim().length > 0) {
							logCriticalError(filePath, `EXIT_CODE=${code} (无法兜底)\n${ffErr}`);
						}
						resolve(null);
						return;
					}
				}

				const finalWebPDuration = getWebPDurationFromBuffer(buffer);

				qqq.setCacheEntry(contentId, cacheStrategy.cacheKey, buffer, {
					width: targetW,
					height: targetH,
					origWidth: origSize?.width || 0,
					origHeight: origSize?.height || 0,
					type: 'webp_unified',
					webpDur: finalWebPDuration,
					originalDuration: originalDuration
				});

				let finalCssW = targetW;
				let finalCssH = targetH;
				const ow = origSize?.width || targetW;
				const oh = origSize?.height || targetH;

				if (ow > 0 && oh > 0) {
					if (enlargeSmallImages) {
						const scale = Math.min(renderW / ow, renderH / oh);
						finalCssW = Math.max(1, Math.round(ow * scale));
						finalCssH = Math.max(1, Math.round(oh * scale));
					} else {
						if (ow <= renderW && oh <= renderH) {
							finalCssW = ow;
							finalCssH = oh;
						} else {
							const scale = Math.min(renderW / ow, renderH / oh);
							finalCssW = Math.max(1, Math.round(ow * scale));
							finalCssH = Math.max(1, Math.round(oh * scale));
						}
					}
				}

				resolve({
					buffer,
					webpDuration: finalWebPDuration,
					originalDuration: originalDuration,
					outputSize: { width: finalCssW, height: finalCssH }
				});
			}
		});

		child.on("error", (err) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				cleanup();

				const fallback = tryFallbackDirectRead(filePath, renderW, renderH, info);
				if (fallback) {
					logCriticalError(filePath, `SPAWN_ERROR: ${err.message}`);
					resolve(fallback);
				} else {
					logCriticalError(filePath, `SPAWN_ERROR (无法兜底): ${err.message}`);
					resolve(null);
				}
			}
		});
	});
}

// ==================== 渲染辅助 ====================
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

function resolvePathToAbsolute(docUri, rawPath) {
	if (!rawPath) return null;
	let clean = rawPath.trim();

	while (clean.startsWith("\\") || clean.startsWith("/")) {
		clean = clean.slice(1);
	}

	if (path.isAbsolute(clean)) return clean;
	return path.resolve(path.dirname(docUri.fsPath), clean);
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

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${previewWidth}" height="4" viewBox="0 0 ${previewWidth} 4"><rect width="${previewWidth}" height="4" fill="black"/><rect width="0" height="4" fill="#fdf6e3"><animate attributeName="width" from="0" to="${previewWidth}" dur="${webpDuration.toFixed(3)}s" repeatCount="indefinite"/></rect></svg>`;

	return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

function calculateBlankLinesExact(pxHeight, isLastItem = false) {
	try {
		const config = vscode.workspace.getConfiguration('editor');
		const fontSize = config.get('fontSize', 14);
		const lhMult = config.get('lineHeight', 0) || 1.35;
		const pxPerLine = fontSize * lhMult;

		const boxH = pxHeight + PREVIEW_BORDER;
		let baseN = Math.ceil(boxH / pxPerLine);

		let extra = 2 + Math.floor((lhMult - 1) * 3);
		extra = Math.min(5, Math.max(2, extra));

		let n = baseN + extra;
		n = Math.max(4, n);

		if (isLastItem) {
			n = Math.max(8, n);
		}

		return n;
	} catch (e) {
		return 15;
	}
}

// ==================== 获取编辑器唯一标识 ====================

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

	if (!decorationType) {
		decorationType = vscode.window.createTextEditorDecorationType({ isWholeLine: false });
	}

	if (!markerHideType) {
		markerHideType = vscode.window.createTextEditorDecorationType({
			textDecoration: 'none; font-size: 11px; color: transparent; opacity: 0;'
		});
	}

	const docUri = editor.document.uri.toString();

	if (!documentDecorationsMap.has(docUri)) {
		documentDecorationsMap.set(docUri, new Map());
	}

	if (!animatedDecorationKeys.has(docUri)) {
		animatedDecorationKeys.set(docUri, new Set());
	}

	const currentDecos = documentDecorationsMap.get(docUri);
	const animatedKeys = animatedDecorationKeys.get(docUri);
	const hideDecos = new Map();
	const visibleRanges = editor.visibleRanges;

	if (!visibleRanges?.length) return;

	const marginLeft = "100px";
	const pathRegex = new RegExp(qqq.QQQ_PATH_REGEX);
	const tasks = [];

	for (const range of visibleRanges) {
		const text = editor.document.getText(range);
		pathRegex.lastIndex = 0;
		let match;

		while ((match = pathRegex.exec(text))) {
			const offset = editor.document.offsetAt(range.start) + match.index;
			const pos = editor.document.positionAt(offset);
			const endPos = editor.document.positionAt(offset + match[0].length);
			const uniqueKey = `${pos.line}_${pos.character}`;

			hideDecos.set(uniqueKey, { range: new vscode.Range(pos, endPos) });
			const rawPath = match[0].slice(2, -2).trim();

			if (rawPath.startsWith("__PENDING__:")) {
				const { width: pW, height: pH } = getFrameConfig(null);
				const boxWidth = pW + PREVIEW_BORDER;
				const boxHeight = pH + PREVIEW_BORDER;

				const loadingDeco = {
					range: new vscode.Range(pos.line, 0, pos.line, 0),
					renderOptions: {
						after: {
							contentText: "",
							position: 'absolute',
							left: marginLeft,
							top: '0px',
							width: `${boxWidth}px`,
							height: `${boxHeight}px`,
							padding: "2px",
							border: "1px dashed #888",
							backgroundColor: PREVIEW_BG_COLOR,
							zIndex: -1,
							textDecoration: `none; pointer-events: none; display: inline-block; background-image: url("${LOADING_SVG}"); background-size: 120px 40px; background-position: center center; background-repeat: no-repeat;`
						}
					}
				};

				currentDecos.set(uniqueKey, loadingDeco);
				continue;
			}

			if (currentDecos.has(uniqueKey)) continue;

			const absPath = resolvePathToAbsolute(editor.document.uri, rawPath.replace(/\//g, "\\"));
			if (!absPath || !fs.existsSync(absPath)) continue;

			const targetLine = pos.line;
			if (targetLine >= editor.document.lineCount) continue;

			const anchorRange = new vscode.Range(targetLine, 0, targetLine, 0);
			const contentId = qqq.computeFingerprint(absPath);
			if (!contentId) continue;

			tasks.push(async () => {
				if (currentRenderVersion !== myVersion) return null;

				try {
					let mtimeMs = 0;
					try {
						mtimeMs = fs.statSync(absPath).mtimeMs;
					} catch { }

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
							if (previewResult.mimeType) {
								mime = previewResult.mimeType;
							} else if (previewResult.ext) {
								const e = previewResult.ext;
								if (e === '.png') mime = 'image/png';
								else if (e === '.jpg' || e === '.jpeg') mime = 'image/jpeg';
								else if (e === '.svg') mime = 'image/svg+xml';
								else if (e === '.gif') mime = 'image/gif';
								else if (e === '.webp') mime = 'image/webp';
								else if (e === '.bmp') mime = 'image/bmp';
								else if (e === '.ico') mime = 'image/x-icon';
							}
						}

						contentUrl = `url("data:${mime};base64,${previewResult.buffer.toString("base64")}")`;
						webpDuration = previewResult.webpDuration || 0;
						outputSize = previewResult.outputSize;
					}

					if (!contentUrl) return null;

					const boxWidth = previewWidth + PREVIEW_BORDER;
					const boxHeight = previewHeight + PREVIEW_BORDER;

					let progressBarUrl = null;
					let hasAnimation = false;

					if (webpDuration > 0.1) {
						progressBarUrl = `url("${createProgressSvg(webpDuration, previewWidth)}")`;
						hasAnimation = true;
					}

					const gridSize = "20px 20px";
					const gridImage = `conic-gradient(#fdf6e3 0.25turn, #e6e1cf 0.25turn 0.5turn, #fdf6e3 0.5turn 0.75turn, #e6e1cf 0.75turn)`;

					let layers = [];
					let sizes = [];
					let positions = [];
					let repeats = [];

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

					deco.renderOptions.after = {
						contentText: "",
						position: 'absolute',
						left: marginLeft,
						top: '0px',
						width: `${boxWidth}px`,
						height: `${boxHeight}px`,
						padding: "2px",
						border: "1px dashed #888",
						backgroundColor: PREVIEW_BG_COLOR,
						zIndex: -1,
						textDecoration: `none; pointer-events: none; display: inline-block; background-image: ${layers.join(", ")}; background-size: ${sizes.join(", ")}; background-position: ${positions.join(", ")}; background-repeat: ${repeats.join(", ")};`
					};

					deco.hoverMessage = new vscode.MarkdownString(`[打开文件](${vscode.Uri.file(absPath).toString()})`);
					deco.hoverMessage.isTrusted = true;

					return { key: uniqueKey, deco, hasAnimation };
				} catch (e) {
					return null;
				}
			});
		}
	}

	if (tasks.length > 0) {
		const results = [];

		for (let i = 0; i < tasks.length; i += MAX_CONCURRENT_TASKS) {
			if (currentRenderVersion !== myVersion) return;

			const chunk = tasks.slice(i, i + MAX_CONCURRENT_TASKS);
			const chunkResults = await Promise.all(chunk.map(t => t()));
			results.push(...chunkResults);
		}

		if (currentRenderVersion !== myVersion) return;

		for (const res of results) {
			if (res) {
				currentDecos.set(res.key, res.deco);
				if (res.hasAnimation) {
					animatedKeys.add(res.key);
				}
			}
		}
	}

	if (animatedKeys.size > 0) {
		startProgressSyncTimer();
	}

	editor.setDecorations(decorationType, Array.from(currentDecos.values()));

	if (hideDecos.size > 0) {
		editor.setDecorations(markerHideType, Array.from(hideDecos.values()));
	}
}

// ==================== 粘贴命令 ====================

async function executeClipboardCommand() {
	if (!isCoreIntegrityValid) {
		vscode.window.showErrorMessage("Integrity check failed.");
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	let targetDir = "D:\\view\\p";
	if (!editor.document.isUntitled) {
		targetDir = path.join(path.dirname(editor.document.uri.fsPath), "qqq");
	}

	const fastResult = await qqq.handleClipboardFast();

	if (fastResult?.type === "text") {
		await editor.edit(e => e.insert(editor.selection.active, fastResult.text));
		return;
	}

	const token = qqq.createPendingToken();
	const eol = getDocumentEOL(editor.document);
	const pendingMarker = `/\\__PENDING__:${token}__\\/`;
	const insertPosition = editor.selection.active;

	await editor.edit(e => e.insert(insertPosition, eol + pendingMarker + eol));

	pendingTokens.set(token, {
		editor: editor,
		documentUri: editor.document.uri.toString(),
		targetDir: targetDir
	});

	debounceRender(editor, 10);

	setImmediate(async () => {
		try {
			const result = await qqq.handleClipboardSlow(targetDir);
			await replacePendingMarker(token, result);
		} catch (e) {
			qqq.logMessage(`媒体处理失败: ${e.message}`, "ERROR");
			await replacePendingMarker(token, { type: "error", error: e.message });
		}
	});
}

async function replacePendingMarker(token, result) {
	const pending = pendingTokens.get(token);
	if (!pending) return;

	pendingTokens.delete(token);

	let editor = vscode.window.visibleTextEditors.find(
		e => e.document.uri.toString() === pending.documentUri
	);

	if (!editor) return;

	const doc = editor.document;
	const text = doc.getText();
	const pendingMarker = `/\\__PENDING__:${token}__\\/`;
	const markerIndex = text.indexOf(pendingMarker);

	if (markerIndex === -1) return;

	const startPos = doc.positionAt(markerIndex);
	const endPos = doc.positionAt(markerIndex + pendingMarker.length);
	const markerRange = new vscode.Range(startPos, endPos);

	let replacement = "";
	const eol = getDocumentEOL(doc);
	const docDir = path.dirname(doc.uri.fsPath);

	if (result.type === "image" || result.type === "ikge") {
		const filePath = result.path;
		const relPath = path.relative(docDir, filePath).replace(/\//g, "\\");

		let pxHeight = LARGE_PREVIEW_HEIGHT;
		try {
			const info = await getMediaInfo(filePath, Date.now());
			const { height } = getFrameConfig(info);
			pxHeight = height;
		} catch { }

		const gapBelow = calculateBlankLinesExact(pxHeight, true);
		replacement = `/\\${relPath}\\/` + eol.repeat(gapBelow);
		invalidateFolderSizeCacheForPath(filePath);

	} else if (result.type === "file") {
		const files = result.files;

		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			const relPath = path.relative(docDir, f).replace(/\//g, "\\");

			let pxHeight = LARGE_PREVIEW_HEIGHT;
			if (isImageOrVideoExt(path.extname(f))) {
				try {
					const info = await getMediaInfo(f, Date.now());
					const { height } = getFrameConfig(info);
					pxHeight = height;
				} catch { }
			}

			const isLastItem = (i === files.length - 1);
			if (i > 0) replacement += eol;
			replacement += `/\\${relPath}\\/`;

			const gapBelow = calculateBlankLinesExact(pxHeight, isLastItem);
			replacement += eol.repeat(gapBelow);
			invalidateFolderSizeCacheForPath(f);
		}

		if (files.length > 1) {
			vscode.window.showInformationMessage("文件已复制 " + files.length);
		}

	} else if (result.type === "folder_text") {
		replacement = result.text;
	} else if (result.type === "text") {
		replacement = result.text;
	} else {
		replacement = "";
	}

	await editor.edit(editBuilder => {
		editBuilder.replace(markerRange, replacement);
	});

	setTimeout(() => renderImages(editor), 50);
}

// ==================== 整洁模式 (Clean Freak) ====================

async function performGlobalClean(editor, force = false) {
	if (!editor) return;
	if (!force && !cleanFreakMode) return;

	const document = editor.document;
	const edits = [];
	const text = document.getText();
	const regex = new RegExp(qqq.QQQ_PATH_REGEX);
	const eol = getDocumentEOL(document);
	let match;
	const markers = [];

	while ((match = regex.exec(text))) {
		markers.push({ text: match[0], index: match.index });
	}

	for (let i = markers.length - 1; i >= 0; i--) {
		const m = markers[i];
		const startPos = document.positionAt(m.index);
		const endPos = document.positionAt(m.index + m.text.length);
		const markerLine = startPos.line;
		const rawPath = m.text.slice(2, -2).trim();

		if (rawPath.startsWith("__PENDING__:")) continue;

		const absPath = resolvePathToAbsolute(document.uri, rawPath.replace(/\//g, "\\"));
		let pxHeight = 0;

		if (absPath && fs.existsSync(absPath)) {
			const ext = path.extname(absPath);
			if (isImageOrVideoExt(ext)) {
				try {
					let mtimeMs = fs.statSync(absPath).mtimeMs;
					const info = await getMediaInfo(absPath, mtimeMs);
					const { height } = getFrameConfig(info);
					pxHeight = height;
				} catch {
					const { height } = getFrameConfig(null);
					pxHeight = height;
				}
			}
		}

		const lineObj = document.lineAt(markerLine);
		const lineContent = lineObj.text;

		if (startPos.character > 0) {
			edits.push(vscode.TextEdit.insert(startPos, eol));
		}

		const suffix = lineContent.substring(endPos.character);
		if (suffix.trim().length > 0) {
			edits.push(vscode.TextEdit.insert(endPos, eol));
		}

		if (pxHeight > 0) {
			let isLastMarkerInDoc = (i === markers.length - 1);
			const neededLines = calculateBlankLinesExact(pxHeight, isLastMarkerInDoc);

			let existingBlanks = 0;
			for (let lineIdx = markerLine + 1; lineIdx < document.lineCount; lineIdx++) {
				if (document.lineAt(lineIdx).text.trim() === "") {
					existingBlanks++;
				} else {
					break;
				}
			}

			if (existingBlanks < neededLines) {
				const linesToAdd = neededLines - existingBlanks;
				const lineEndPos = lineObj.range.end;
				edits.push(vscode.TextEdit.insert(lineEndPos, eol.repeat(linesToAdd)));
			}
		}
	}

	if (edits.length > 0) {
		await editor.edit(editBuilder => {
			edits.forEach(e => {
				if (e.newText) {
					editBuilder.insert(e.range.start, e.newText);
				} else {
					editBuilder.replace(e.range, e.newText);
				}
			});
		});
	}
}

// ==================== CodeLens ====================

class FileCodeLensProvider {
	async provideCodeLenses(document) {
		if (!isCoreIntegrityValid) return [];

		const lenses = [];
		const regex = new RegExp(qqq.QQQ_PATH_REGEX);
		const text = document.getText();
		let match;
		const tasks = [];

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const rawPath = match[0].slice(2, -2).trim();

			if (rawPath.startsWith("__PENDING__:")) continue;

			const absPath = resolvePathToAbsolute(document.uri, rawPath.replace(/\//g, "\\"));
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

						let scale = 1;
						if (isRealVideo || info.duration > 0.1 || enlargeSmallImages) {
							scale = Math.min(MAX_W / info.width, MAX_H / info.height);
						} else {
							if (info.width <= MAX_W && info.height <= MAX_H) {
								scale = 1;
							} else {
								scale = Math.min(MAX_W / info.width, MAX_H / info.height);
							}
						}

						const pct = Math.round(scale * 100);
						titleSuffix = `   (${pct}%)  ${info.width}x${info.height}`;

						const displayCodec = info.full_codec_desc || info.codec;
						if (displayCodec) tooltipText += `\n编码: ${displayCodec}`;

						const arStr = calculateAspectRatioString(info.width, info.height);
						if (arStr) tooltipText += `\n宽高比：${arStr}`;

						if (qqq.shouldShowDuration(info)) {
							tooltipText += `\n⌛原始时长：${formatDuration(info.duration)}`;
						}
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
						tooltip: folderTooltip
					}),
					new vscode.CodeLens(r, {
						title: "✎rename",
						command: "qqq.renameFile",
						arguments: [rawPath, absPath]
					}),
					new vscode.CodeLens(r, {
						title: `✎( ${fileSz})${iconPart}${spacePart}${absPath}${titleSuffix}`,
						command: "qqq.openFile",
						arguments: [absPath],
						tooltip: tooltipText
					})
				];
			});
		}

		const results = await Promise.all(tasks.map(t => t()));
		results.forEach(group => lenses.push(...group));

		return lenses;
	}
}

// ==================== 文件夹大小缓存 ====================

const FOLDER_SIZE_CACHE_MAX_AGE = 10 * 1000;

function invalidateFolderSizeCacheForPath(filePath) {
	try {
		const dir = path.dirname(filePath);
		if (folderSizeCache.has(dir)) {
			folderSizeCache.delete(dir);
		}
	} catch { }
}

async function getQqqFolderSize(folderPath) {
	const now = Date.now();
	const cached = folderSizeCache.get(folderPath);

	if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) {
		return cached.data;
	}

	const result = await qqq.getFolderInfo(folderPath);

	if (result?.success) {
		const parts = [];
		let totalFiles = 0;

		if (result.ext_stats) {
			for (const [ext, count] of Object.entries(result.ext_stats)) {
				totalFiles += count;
				parts.push(`${count}_${ext || '无后缀'}`);
			}
		}

		const summaryStr = parts.length > 0
			? `${totalFiles}个文件：${parts.join("; ")}`
			: (result.file_count_root > 0 ? `${result.file_count_root}个文件` : "空文件夹");

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

function revealFileInFolder(filePath) {
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

async function renameFileCommand(rawPath, absPath) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	const currentName = path.basename(absPath);

	const newName = await vscode.window.showInputBox({
		title: "重命名粘贴文件",
		prompt: "rename  ",
		value: currentName,
		ignoreFocusOut: true,
		validateInput: v => (!v || !v.trim()) ? "文件名不能为空" : null
	});

	if (!newName || newName.trim() === currentName) return;

	const trimmed = newName.trim();
	const newAbs = path.join(path.dirname(absPath), trimmed);

	try {
		await fs.promises.rename(absPath, newAbs);
	} catch (e) {
		vscode.window.showErrorMessage(e.message);
		return;
	}

	const doc = editor.document;
	const newRaw = rawPath.includes('/')
		? rawPath.substring(0, rawPath.lastIndexOf('/') + 1) + trimmed
		: trimmed;

	const regex = new RegExp(qqq.QQQ_PATH_REGEX);
	const ranges = [];
	let m;

	while ((m = regex.exec(doc.getText()))) {
		if (m[0].slice(2, -2).trim() === rawPath) {
			ranges.push(new vscode.Range(
				doc.positionAt(m.index),
				doc.positionAt(m.index + m[0].length)
			));
		}
	}

	if (ranges.length) {
		await editor.edit(b => ranges.forEach(r => b.replace(r, `/\\${newRaw}\\/`)));
	}

	invalidateFolderSizeCacheForPath(newAbs);
	renderVisibleEditors();
}

// ==================== 多编辑器独立防抖 ====================
function debounceRender(editor, delay = SCROLL_DEBOUNCE_MS) {
	if (!editor || editor.document.isClosed) return;

	const editorId = getEditorId(editor);

	const existingTimer = editorDebounceTimers.get(editorId);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	const timer = setTimeout(() => {
		editorDebounceTimers.delete(editorId);

		if (editor && !editor.document.isClosed) {
			const stillVisible = vscode.window.visibleTextEditors.some(
				e => getEditorId(e) === editorId
			);

			if (stillVisible) {
				renderImages(editor);
			}
		}
	}, delay);

	editorDebounceTimers.set(editorId, timer);
}

function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors;

	if (editors?.length) {
		editors.forEach(e => debounceRender(e, delay));
	}
}

// ==================== 激活与停用 ====================

async function activate(context) {
	extensionContext = context;
	isCoreIntegrityValid = verifySystemIntegrity();

	qqq.logMessage(`Integrity: ${isCoreIntegrityValid ? "PASSED" : "FAILED"}`, "INFO");

	if (!isCoreIntegrityValid) return;

	loadWatermarkResource();
	refreshConfig();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("qqq")) {
				refreshConfig();
				clearDecorations();
				renderVisibleEditors();

				if (cleanFreakMode) {
					performGlobalClean(vscode.window.activeTextEditor);
				}
			}

			if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("editor.lineHeight")) {
				refreshConfig();

				if (cleanFreakMode) {
					performGlobalClean(vscode.window.activeTextEditor);
				}
			}
		}),

		vscode.commands.registerCommand("qqq.q1", executeClipboardCommand),
		vscode.commands.registerCommand("qqq.openFile", openFileCommand),
		vscode.commands.registerCommand("qqq.revealFileInFolder", revealFileInFolder),
		vscode.commands.registerCommand("qqq.renameFile", renameFileCommand),
		vscode.commands.registerCommand("qqq.setInOrder", () => {
			performGlobalClean(vscode.window.activeTextEditor, true);
		}),

		// ★★★ 导出 DOC 命令（调用 q1a 模块） ★★★
		vscode.commands.registerCommand("qqq.exportDoc", () => {
			q1a.executeExportDocCommand(isCoreIntegrityValid);
		}),

		// ★★★ 导出 ZIP 命令（调用 q1a 模块） ★★★
		vscode.commands.registerCommand("qqq.exportZip", () => {
			q1a.executeExportZipCommand(isCoreIntegrityValid);
		}),

		vscode.languages.registerCodeLensProvider({ scheme: "file" }, new FileCodeLensProvider()),

		vscode.workspace.onWillSaveTextDocument(e => {
			if (cleanFreakMode && e.document) {
				performGlobalClean(
					vscode.window.visibleTextEditors.find(ed => ed.document === e.document)
				);
			}
		}),

		vscode.window.onDidChangeTextEditorVisibleRanges(e => {
			debounceRender(e.textEditor);
		}),

		vscode.window.onDidChangeActiveTextEditor(e => {
			if (e) debounceRender(e);
		}),

		vscode.window.onDidChangeWindowState(e => {
			if (e.focused) renderVisibleEditors();
		}),

		vscode.workspace.onDidChangeTextDocument(e => {
			const ed = vscode.window.activeTextEditor;

			if (ed && e.document === ed.document) {
				debounceRender(ed);
			}

			if (e.document === ed?.document && e.contentChanges.length > 0) {
				documentDecorationsMap.delete(e.document.uri.toString());
				animatedDecorationKeys.delete(e.document.uri.toString());
			}
		}),

		vscode.workspace.onDidCloseTextDocument(doc => {
			const docUri = doc.uri.toString();

			documentDecorationsMap.delete(docUri);
			animatedDecorationKeys.delete(docUri);

			for (const [editorId, timer] of editorDebounceTimers.entries()) {
				if (editorId.startsWith(docUri + "::")) {
					clearTimeout(timer);
					editorDebounceTimers.delete(editorId);
				}
			}

			let hasAnyAnimations = false;
			for (const [, keys] of animatedDecorationKeys) {
				if (keys.size > 0) {
					hasAnyAnimations = true;
					break;
				}
			}

			if (!hasAnyAnimations) {
				stopProgressSyncTimer();
			}
		}),

		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			const visibleEditorIds = new Set(editors.map(e => getEditorId(e)));

			for (const [editorId, timer] of editorDebounceTimers.entries()) {
				if (!visibleEditorIds.has(editorId)) {
					clearTimeout(timer);
					editorDebounceTimers.delete(editorId);
				}
			}

			renderVisibleEditors();

			if (cleanFreakMode) {
				performGlobalClean(vscode.window.activeTextEditor);
			}
		}),
	);

	const editor = vscode.window.activeTextEditor;
	if (editor) {
		renderImages(editor);
	}
}

async function deactivate() {
	stopProgressSyncTimer();
	clearAllEditorDebounceTimers();
	clearDecorations();
	await qqq.finishUserTracking(extensionContext);
}

module.exports = { activate, deactivate };

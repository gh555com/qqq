// src/q1.js
// ==========================================
// ★★★ 统一 WebP 渲染管线 + 直读优化 + MJPEG 修复 + 动态空行 ★★★
// ==========================================
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

// 从 qqq.js 导入核心接口
const qqq = require("./qqq");

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

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov"]);

// 直接读取白名单（不含 GIF/MJPEG）
const DIRECT_READ_EXTS = new Set([".png", ".jpg", ".jpeg", ".svg"]);

// ==================== 全局状态 ====================
let decorationType = null;
let markerHideType = null;
let extensionContext = null;
let currentRenderVersion = 0;

const documentDecorationsMap = new Map();
const resolutionCache = new Map();
const folderSizeCache = new Map();
const pendingTokens = new Map();

// ★ 全局配置变量
let enlargeSmallImages = true;
let performanceMode = "balanced";
let frameSizeMode = "smart";
let cleanFreakMode = false;

// 水印与 Loading
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
	} catch (e) { return false; }
}

function loadWatermarkResource() {
	try {
		if (fs.existsSync(WATERMARK_PATH)) {
			const buf = fs.readFileSync(WATERMARK_PATH);
			watermarkBase64 = "data:image/gif;base64," + buf.toString("base64");
		}
	} catch (e) { watermarkBase64 = null; }
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
	if (decorationType) { try { decorationType.dispose(); } catch (e) { } decorationType = null; }
	if (markerHideType) { try { markerHideType.dispose(); } catch (e) { } markerHideType = null; }
	documentDecorationsMap.clear();
}

// ==================== 统一 Frame 尺寸逻辑 (关键去重) ====================

// ★★★ 核心函数：根据文件信息和全局配置，决定使用大框还是小框 ★★★
function getFrameConfig(info) {
	let mode = "large"; // 默认大框
	let width = LARGE_PREVIEW_WIDTH;
	let height = LARGE_PREVIEW_HEIGHT;

	// 如果 info 不存在（例如文件读取失败或 Pending），默认使用 Smart/Large 逻辑
	if (!info || !info.width || !info.height) {
		if (frameSizeMode === "small") {
			mode = "small";
			width = SMALL_PREVIEW_WIDTH;
			height = SMALL_PREVIEW_HEIGHT;
		}
		// "smart" 和 "large" 都默认用大框占位
	} else {
		// 有尺寸信息，进行精确判定
		if (frameSizeMode === "small") {
			mode = "small";
			width = SMALL_PREVIEW_WIDTH;
			height = SMALL_PREVIEW_HEIGHT;
		} else if (frameSizeMode === "large") {
			mode = "large";
			width = LARGE_PREVIEW_WIDTH;
			height = LARGE_PREVIEW_HEIGHT;
		} else {
			// Smart Mode
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
		child.stderr.on("data", d => { if (stderr.length < 50000) stderr += d.toString(); });
		child.on("close", () => {
			const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
			const codecMatch = /Stream.*Video:\s*(.*?)(?:,|$)/i.exec(stderr);
			const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);

			let info = {
				mtime: mtimeMs,
				res: null, width: null, height: null,
				codec: null, full_codec_desc: null,
				duration: 0,
				type: "unknown"
			};

			if (resMatch) {
				const w = parseInt(resMatch[1]), h = parseInt(resMatch[2]);
				info.res = `${w}x${h}`; info.width = w; info.height = h;
			}

			if (codecMatch?.[1]) {
				info.full_codec_desc = codecMatch[1].trim();
				const parts = info.full_codec_desc.split(/[,\s]+/);
				info.codec = parts[0].trim().toLowerCase();
			}

			if (durMatch) {
				const h = parseFloat(durMatch[1]), m = parseFloat(durMatch[2]), s = parseFloat(durMatch[3]);
				info.duration = h * 3600 + m * 60 + s;
			}

			if (info.codec) {
				const c = info.codec;
				// ★★★ MJPEG 特殊处理：即使是 jpg 后缀，如果是 mjpeg 编码，也被视为特殊类型 ★★★
				if (c.includes('mjpeg')) {
					// 标记为 mjpeg，后续会强制转码
					info.type = 'mjpeg';
					// 虽然是 video stream，但为了逻辑统一，如果很短，还是算 image
					if (info.duration > 0.1) info.type = 'video';
				}
				else if (['png', 'bmp', 'tiff', 'jpeg', 'webp', 'svg'].some(x => c.includes(x))) info.type = 'image';
				else if (c.includes('gif')) info.type = info.duration > 0.1 ? 'animated_image' : 'image';
				else if (['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4'].some(x => c.includes(x))) info.type = 'video';
			}
			if (info.type === 'unknown') {
				const ext = path.extname(filePath).toLowerCase();
				if (VIDEO_EXTS.has(ext)) info.type = 'video';
				else if (IMAGE_EXTS.has(ext)) info.type = 'image';
			}

			resolutionCache.set(filePath, info);
			if (resolutionCache.size > 200) resolutionCache.delete(resolutionCache.keys().next().value);
			resolve(info.width ? info : null);
		});
		child.on("error", () => resolve(null));
		setTimeout(() => { try { child.kill(); } catch { } resolve(null); }, 5000);
	});
}

// ==================== 缓存策略与转码 ====================

function determineCacheStrategy(filePath, info) {
	// 1. 获取统一相框配置
	const { width: previewWidth, height: previewHeight, mode: frameSizeIndicator } = getFrameConfig(info);

	// 2. 判断是否直通
	const isStatic = info?.duration <= 0.1;
	const isGifLike = !isStatic && info?.duration > 0.1 && info?.duration < 10;
	const ext = path.extname(filePath).toLowerCase();

	// ★★★ MJPEG 修复核心：如果 info.type 是 mjpeg 或者 codec 包含 mjpeg，禁止直通！ ★★★
	const isMJPEG = info?.type === 'mjpeg' || (info?.codec && info.codec.includes('mjpeg'));

	// 直读白名单：必须在列表中，且不是 MJPEG
	const isWhitelisted = (DIRECT_READ_EXTS.has(ext) || (ext === '.webp' && isStatic)) && !isMJPEG;

	let shouldBypassCache = false;

	// 只有尺寸合适且符合白名单的才直读
	if (info?.width <= previewWidth && info?.height <= previewHeight && isWhitelisted) {
		// 静态图总是直读，动图在 balanced 模式下直读
		if (isStatic || (isGifLike && performanceMode === "balanced")) {
			shouldBypassCache = true;
		}
	}

	// 3. 确定质量等级
	let qualityLevel;
	switch (performanceMode) {
		case "extreme": qualityLevel = 39; break;
		case "accelerated": qualityLevel = 38; break;
		case "balanced": qualityLevel = 70; break;
		default: qualityLevel = 70;
	}

	// 4. 生成 CacheKey
	const cacheKey = `${frameSizeIndicator === 'small' ? 's' : 'l'}${qualityLevel}`;

	return {
		shouldBypassCache,
		previewWidth,
		previewHeight,
		cacheKey,
		qualityLevel
	};
}

function getWebPDurationFromBuffer(buffer) {
	if (!buffer || buffer.length < 12) return 0;
	if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return 0;
	let pos = 12, totalDurationMs = 0, frameCount = 0;
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

function buildUnifiedWebPArgs(filePath, origSize, duration, qualityLevel, previewWidth, previewHeight) {
	let targetW = previewWidth, targetH = previewHeight;

	if (origSize?.width) {
		const ow = origSize.width, oh = origSize.height;
		if (enlargeSmallImages) {
			const scale = Math.min(previewWidth / ow, previewHeight / oh);
			targetW = Math.max(1, Math.round(ow * scale));
			targetH = Math.max(1, Math.round(oh * scale));
		} else {
			if (ow <= previewWidth && oh <= previewHeight) { targetW = ow; targetH = oh; }
			else {
				const scale = Math.min(previewWidth / ow, previewHeight / oh);
				targetW = Math.max(1, Math.round(ow * scale));
				targetH = Math.max(1, Math.round(oh * scale));
			}
		}
	}

	const args = ["-hide_banner", "-loglevel", "error"];
	let expectedWebPDuration = 0;
	const isStatic = (duration <= 0.1);
	const isGifLike = !isStatic && duration > 0.1 && duration < 10;
	const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=bilinear`;
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

async function getPreviewBuffer(filePath, contentId) {
	if (!qqq.ffmpegPath) return null;
	let mtimeMs = 0;
	try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return null; }

	const info = await getMediaInfo(filePath, mtimeMs);
	const origSize = info ? { width: info.width, height: info.height } : null;
	const duration = info?.duration || 0;

	const cacheStrategy = determineCacheStrategy(filePath, info);

	if (!cacheStrategy.shouldBypassCache) {
		const cached = qqq.getCachedBuffer(contentId, cacheStrategy.cacheKey);
		if (cached) {
			const webpDur = getWebPDurationFromBuffer(cached);
			return { buffer: cached, webpDuration: webpDur, fromCache: true };
		}
	}

	const ext = path.extname(filePath).toLowerCase();

	if (cacheStrategy.shouldBypassCache) {
		try {
			const rawBuffer = fs.readFileSync(filePath);
			let finalCssW = info.width, finalCssH = info.height;
			if (enlargeSmallImages) {
				const scale = Math.min(cacheStrategy.previewWidth / info.width, cacheStrategy.previewHeight / info.height);
				finalCssW = Math.max(1, Math.round(info.width * scale));
				finalCssH = Math.max(1, Math.round(info.height * scale));
			}
			return {
				buffer: rawBuffer,
				webpDuration: 0,
				outputSize: { width: finalCssW, height: finalCssH },
				isDirect: true,
				ext: ext
			};
		} catch (e) { }
	}

	return new Promise((resolve) => {
		const { args, targetW, targetH, expectedWebPDuration } = buildUnifiedWebPArgs(filePath, origSize, duration, cacheStrategy.qualityLevel, cacheStrategy.previewWidth, cacheStrategy.previewHeight);
		const rand = Math.random().toString(36).slice(2);
		const tempFile = path.join(os.tmpdir(), `qqq_uni_${contentId}_${rand}.webp`);
		args.push("-y", tempFile);

		const child = cp.spawn(qqq.ffmpegPath, args, { windowsHide: true, stdio: 'ignore' });
		let resolved = false;
		const cleanup = () => { if (fs.existsSync(tempFile)) try { fs.unlinkSync(tempFile); } catch { } };
		const timer = setTimeout(() => { if (!resolved) { resolved = true; try { child.kill(); } catch { } cleanup(); resolve(null); } }, 30000);

		child.on("close", () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				let buffer = null;
				try { if (fs.existsSync(tempFile)) buffer = fs.readFileSync(tempFile); } catch (e) { }
				cleanup();
				if (!buffer) { resolve(null); return; }

				let finalDuration = expectedWebPDuration;
				const detectedDur = getWebPDurationFromBuffer(buffer);
				if (detectedDur > 0) finalDuration = detectedDur;
				else if (duration <= 0.1) finalDuration = 0;

				qqq.setCacheEntry(contentId, cacheStrategy.cacheKey, buffer, {
					width: targetW, height: targetH, type: 'webp_unified', webpDur: finalDuration, srcDuration: duration
				});
				resolve({ buffer, webpDuration: finalDuration, outputSize: { width: targetW, height: targetH } });
			}
		});
		child.on("error", () => { if (!resolved) { resolved = true; clearTimeout(timer); cleanup(); resolve(null); } });
	});
}

// ==================== 渲染辅助 ====================

function formatBytes(size) {
	if (size == null || isNaN(size)) return "?";
	const units = ["b", "k", "m", "g"];
	let idx = 0, val = size;
	while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++; }
	return `${Math.round(val)}${units[idx]}`;
}

function formatDuration(sec) {
	if (sec == null || isNaN(sec) || sec < 0) return "0s";
	if (sec >= 60) {
		const m = Math.floor(sec / 60), s = sec % 60;
		return `${m}m + ${s.toFixed(2)}s`;
	}
	return `${sec.toFixed(2)}s`;
}

function isImageOrVideoExt(ext) { const e = ext.toLowerCase(); return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e); }
function getDocumentEOL(doc) { return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"; }

function resolvePathToAbsolute(docUri, rawPath) {
	if (!rawPath) return null;
	let clean = rawPath.trim();
	while (clean.startsWith("\\") || clean.startsWith("/")) clean = clean.slice(1);
	if (path.isAbsolute(clean)) return clean;
	return path.resolve(path.dirname(docUri.fsPath), clean);
}

function calculateAspectRatioString(w, h) {
	if (!w || !h) return "";
	if (w >= h) { const r = (h / w) * 16; return `16__${parseFloat(r.toFixed(1))}`; }
	else { const r = (w / h) * 16; return `${parseFloat(r.toFixed(1))}__16`; }
}

function createProgressSvg(durationSeconds, previewWidth) {
	if (!durationSeconds || durationSeconds <= 0) return null;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${previewWidth}" height="4" viewBox="0 0 ${previewWidth} 4"><rect width="${previewWidth}" height="4" fill="black"/><rect width="0" height="4" fill="#fdf6e3"><animate attributeName="width" from="0" to="${previewWidth}" dur="${durationSeconds.toFixed(3)}s" repeatCount="indefinite"/></rect></svg>`;
	return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

// ★★★ 动态计算所需空行数（精确像素版） ★★★
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
		if (isLastItem) n = Math.max(8, n);
		return n;
	} catch (e) { return 15; }
}

// ==================== 主渲染逻辑 ====================

async function renderImages(editor) {
	if (!editor || !isCoreIntegrityValid) { clearDecorations(); return; }
	const myVersion = ++currentRenderVersion;

	if (!decorationType) decorationType = vscode.window.createTextEditorDecorationType({ isWholeLine: false });
	if (!markerHideType) markerHideType = vscode.window.createTextEditorDecorationType({ textDecoration: 'none; font-size: 11px; color: transparent; opacity: 0;' });

	const docUri = editor.document.uri.toString();
	if (!documentDecorationsMap.has(docUri)) documentDecorationsMap.set(docUri, new Map());
	const currentDecos = documentDecorationsMap.get(docUri);
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
				// Pending 状态使用默认相框尺寸 (Large)
				const { width: pW, height: pH } = getFrameConfig(null);
				const boxWidth = pW + PREVIEW_BORDER;
				const boxHeight = pH + PREVIEW_BORDER;

				const loadingDeco = {
					range: new vscode.Range(pos.line, 0, pos.line, 0),
					renderOptions: {
						after: {
							contentText: "", position: 'absolute', left: marginLeft, top: '0px',
							width: `${boxWidth}px`, height: `${boxHeight}px`,
							padding: "2px", border: "1px dashed #888",
							backgroundColor: PREVIEW_BG_COLOR, zIndex: -1,
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
					// 1. 获取媒体信息
					let mtimeMs = 0;
					try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }
					const info = await getMediaInfo(absPath, mtimeMs);

					// 2. 根据 info 和全局配置获取相框尺寸
					const { width: previewWidth, height: previewHeight } = getFrameConfig(info);

					// 3. 获取图片 Buffer
					const previewResult = await getPreviewBuffer(absPath, contentId);
					if (currentRenderVersion !== myVersion) return null;

					const deco = { range: anchorRange, renderOptions: {} };
					let contentUrl = "";
					let actualWebPDuration = 0;
					let outputSize = null;

					if (previewResult?.buffer) {
						let mime = "image/webp";
						if (previewResult.isDirect && previewResult.ext) {
							const e = previewResult.ext;
							if (e === '.png') mime = 'image/png';
							else if (e === '.jpg' || e === '.jpeg') mime = 'image/jpeg';
							else if (e === '.svg') mime = 'image/svg+xml';
						}
						contentUrl = `url("data:${mime};base64,${previewResult.buffer.toString("base64")}")`;
						actualWebPDuration = previewResult.webpDuration;
						outputSize = previewResult.outputSize;
					}
					if (!contentUrl) return null;

					const boxWidth = previewWidth + PREVIEW_BORDER;
					const boxHeight = previewHeight + PREVIEW_BORDER;

					let progressBarUrl = null;
					if (actualWebPDuration > 0) progressBarUrl = `url("${createProgressSvg(actualWebPDuration, previewWidth)}")`;

					const gridSize = "20px 20px";
					const gridImage = `conic-gradient(#fdf6e3 0.25turn, #e6e1cf 0.25turn 0.5turn, #fdf6e3 0.5turn 0.75turn, #e6e1cf 0.75turn)`;
					let layers = [], sizes = [], positions = [], repeats = [];

					if (watermarkBase64) { layers.push(`url("${watermarkBase64}")`); sizes.push("contain"); positions.push("center center"); repeats.push("no-repeat"); }
					if (progressBarUrl) { layers.push(progressBarUrl); sizes.push(`${previewWidth}px 4px`); positions.push("center bottom"); repeats.push("no-repeat"); }

					layers.push(contentUrl);
					sizes.push(outputSize ? `${outputSize.width}px ${outputSize.height}px` : "contain");
					positions.push("center center"); repeats.push("no-repeat");

					layers.push(gridImage); sizes.push(gridSize); positions.push("0 0"); repeats.push("repeat");

					deco.renderOptions.after = {
						contentText: "", position: 'absolute', left: marginLeft, top: '0px',
						width: `${boxWidth}px`, height: `${boxHeight}px`,
						padding: "2px", border: "1px dashed #888",
						backgroundColor: PREVIEW_BG_COLOR, zIndex: -1,
						textDecoration: `none; pointer-events: none; display: inline-block; background-image: ${layers.join(", ")}; background-size: ${sizes.join(", ")}; background-position: ${positions.join(", ")}; background-repeat: ${repeats.join(", ")};`
					};
					deco.hoverMessage = new vscode.MarkdownString(`[打开文件](${vscode.Uri.file(absPath).toString()})`);
					deco.hoverMessage.isTrusted = true;
					return { key: uniqueKey, deco };
				} catch (e) { return null; }
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
		for (const res of results) { if (res) currentDecos.set(res.key, res.deco); }
	}
	editor.setDecorations(decorationType, Array.from(currentDecos.values()));
	if (hideDecos.size > 0) editor.setDecorations(markerHideType, Array.from(hideDecos.values()));
}

// ==================== 粘贴命令 ====================

async function executeClipboardCommand() {
	if (!isCoreIntegrityValid) { vscode.window.showErrorMessage("Integrity check failed."); return; }
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	let targetDir = "D:\\view\\p";
	if (!editor.document.isUntitled) targetDir = path.join(path.dirname(editor.document.uri.fsPath), "qqq");

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

	pendingTokens.set(token, { editor: editor, documentUri: editor.document.uri.toString(), targetDir: targetDir });
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

	let editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === pending.documentUri);
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

	// ★★★ 核心修复：粘贴时根据图片的实际尺寸计算空行 ★★★
	if (result.type === "image" || result.type === "ikge") {
		const filePath = result.path;
		const relPath = path.relative(docDir, filePath).replace(/\//g, "\\");

		// 1. 获取媒体信息以计算 Frame Size
		let pxHeight = LARGE_PREVIEW_HEIGHT; // 默认
		try {
			const info = await getMediaInfo(filePath, Date.now());
			// 调用统一的 Frame Config 获取高度
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

			// 同样探测尺寸
			let pxHeight = LARGE_PREVIEW_HEIGHT; // 默认
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

			// 使用精确高度计算空行
			const gapBelow = calculateBlankLinesExact(pxHeight, isLastItem);
			replacement += eol.repeat(gapBelow);
			invalidateFolderSizeCacheForPath(f);
		}
		if (files.length > 1) vscode.window.showInformationMessage("文件已复制 " + files.length);
	} else if (result.type === "folder_text") replacement = result.text;
	else if (result.type === "text") replacement = result.text;
	else replacement = ""; // error or unknown

	await editor.edit(editBuilder => { editBuilder.replace(markerRange, replacement); });
	setTimeout(() => renderImages(editor), 50);
}

// ==================== 整洁模式 (Clean Freak) ====================

// 将纯净模式逻辑改为 Async，以便能探测图片尺寸
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

	// 从后往前处理，避免坐标偏移
	for (let i = markers.length - 1; i >= 0; i--) {
		const m = markers[i];
		const startPos = document.positionAt(m.index);
		const endPos = document.positionAt(m.index + m.text.length);
		const markerLine = startPos.line;
		const rawPath = m.text.slice(2, -2).trim();

		if (rawPath.startsWith("__PENDING__:")) continue;
		const absPath = resolvePathToAbsolute(document.uri, rawPath.replace(/\//g, "\\"));

		let pxHeight = 0; // 0 表示非媒体文件或不需要空行

		if (absPath && fs.existsSync(absPath)) {
			const ext = path.extname(absPath);
			if (isImageOrVideoExt(ext)) {
				// ★★★ 核心逻辑：获取实际 Frame Config 以决定空行 ★★★
				try {
					let mtimeMs = fs.statSync(absPath).mtimeMs;
					// 这里我们必须等待，才能知道是 Small 还是 Large
					const info = await getMediaInfo(absPath, mtimeMs);
					const { height } = getFrameConfig(info);
					pxHeight = height;
				} catch {
					// 如果探测失败，回退到默认大框，保证不重叠
					const { height } = getFrameConfig(null);
					pxHeight = height;
				}
			}
		}

		const lineObj = document.lineAt(markerLine);
		const lineContent = lineObj.text;

		// 1. 确保标记独占一行
		if (startPos.character > 0) edits.push(vscode.TextEdit.insert(startPos, eol));
		const suffix = lineContent.substring(endPos.character);
		if (suffix.trim().length > 0) edits.push(vscode.TextEdit.insert(endPos, eol));

		// 2. 只有图片/视频才需要下方空行
		if (pxHeight > 0) {
			let isLastMarkerInDoc = (i === markers.length - 1);
			// 使用精确高度计算
			const neededLines = calculateBlankLinesExact(pxHeight, isLastMarkerInDoc);

			let existingBlanks = 0;
			for (let lineIdx = markerLine + 1; lineIdx < document.lineCount; lineIdx++) {
				if (document.lineAt(lineIdx).text.trim() === "") existingBlanks++;
				else break;
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
				if (e.newText) editBuilder.insert(e.range.start, e.newText);
				else editBuilder.replace(e.range, e.newText);
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
				let fileSz = "?", tooltipText = "", mtimeMs = 0;
				try {
					const st = fs.statSync(absPath);
					fileSz = formatBytes(st.size);
					tooltipText = `创建: ${new Date(st.birthtime).toLocaleString()}\n修改: ${new Date(st.mtime).toLocaleString()}`;
					mtimeMs = st.mtimeMs;
				} catch { }

				let titleSuffix = "", isRealVideo = false;

				if (isVidOrImg) {
					const info = await getMediaInfo(absPath, mtimeMs);
					if (info?.width && info?.height) {
						// 使用统一逻辑获取 Frame 尺寸
						const { width: MAX_W, height: MAX_H } = getFrameConfig(info);

						if (info.type === "video") isRealVideo = true;
						let scale = 1;
						if (isRealVideo || info.duration > 0.1 || enlargeSmallImages) {
							scale = Math.min(MAX_W / info.width, MAX_H / info.height);
						} else {
							if (info.width <= MAX_W && info.height <= MAX_H) scale = 1;
							else scale = Math.min(MAX_W / info.width, MAX_H / info.height);
						}

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
					new vscode.CodeLens(r, { title: `✎( ${fSizeStr}) 🗀qqq`, command: "qqq.revealFileInFolder", arguments: [absPath], tooltip: folderTooltip }),
					new vscode.CodeLens(r, { title: "✎rename", command: "qqq.renameFile", arguments: [rawPath, absPath] }),
					new vscode.CodeLens(r, { title: `✎( ${fileSz})${iconPart}${spacePart}${absPath}${titleSuffix}`, command: "qqq.openFile", arguments: [absPath], tooltip: tooltipText })
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
function invalidateFolderSizeCacheForPath(filePath) { try { const dir = path.dirname(filePath); if (folderSizeCache.has(dir)) folderSizeCache.delete(dir); } catch { } }
async function getQqqFolderSize(folderPath) {
	const now = Date.now();
	const cached = folderSizeCache.get(folderPath);
	if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) return cached.data;
	const result = await qqq.getFolderInfo(folderPath);
	if (result?.success) {
		const parts = [];
		let totalFiles = 0;
		if (result.ext_stats) { for (const [ext, count] of Object.entries(result.ext_stats)) { totalFiles += count; parts.push(`${count}_${ext || '无后缀'}`); } }
		const summaryStr = parts.length > 0 ? `${totalFiles}个文件：${parts.join("; ")}` : (result.file_count_root > 0 ? `${result.file_count_root}个文件` : "空文件夹");
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
async function renameFileCommand(rawPath, absPath) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const currentName = path.basename(absPath);
	const newName = await vscode.window.showInputBox({ title: "重命名粘贴文件", prompt: "rename  ", value: currentName, ignoreFocusOut: true, validateInput: v => (!v || !v.trim()) ? "文件名不能为空" : null });
	if (!newName || newName.trim() === currentName) return;
	const trimmed = newName.trim();
	const newAbs = path.join(path.dirname(absPath), trimmed);
	try { await fs.promises.rename(absPath, newAbs); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
	const doc = editor.document;
	const newRaw = rawPath.includes('/') ? rawPath.substring(0, rawPath.lastIndexOf('/') + 1) + trimmed : trimmed;
	const regex = new RegExp(qqq.QQQ_PATH_REGEX);
	const ranges = [];
	let m;
	while ((m = regex.exec(doc.getText()))) {
		if (m[0].slice(2, -2).trim() === rawPath) {
			ranges.push(new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)));
		}
	}
	if (ranges.length) await editor.edit(b => ranges.forEach(r => b.replace(r, `/\\${newRaw}\\/`)));
	invalidateFolderSizeCacheForPath(newAbs);
	renderVisibleEditors();
}
function buildNewRawPath(oldRaw, newName) { const lastSlash = Math.max(oldRaw.lastIndexOf("/"), oldRaw.lastIndexOf("\\")); return lastSlash === -1 ? newName : oldRaw.slice(0, lastSlash + 1) + newName; }

// ==================== 防抖与激活 ====================
function debounceRender(editor, delay = SCROLL_DEBOUNCE_MS) {
	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => { if (editor && !editor.document.isClosed) renderImages(editor); }, delay);
}
function renderVisibleEditors(delay = 50) { const editors = vscode.window.visibleTextEditors; if (editors?.length) editors.forEach(e => debounceRender(e, delay)); }

async function activate(context) {
	extensionContext = context;
	isCoreIntegrityValid = verifySystemIntegrity();
	console.log(`[QQQ Q1] Integrity: ${isCoreIntegrityValid ? "PASSED" : "FAILED"}`);
	if (!isCoreIntegrityValid) return;

	loadWatermarkResource();
	refreshConfig();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("qqq")) {
				refreshConfig();
				documentDecorationsMap.clear();
				renderVisibleEditors();
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
		vscode.commands.registerCommand("qqq.setInOrder", () => { performGlobalClean(vscode.window.activeTextEditor, true); }),
		vscode.languages.registerCodeLensProvider({ scheme: "file" }, new FileCodeLensProvider()),
		vscode.workspace.onWillSaveTextDocument(e => {
			if (cleanFreakMode && e.document) {
				// onWillSave 只能处理同步 edits，复杂的异步 clean 需要在 save 后触发或者改用 format
				// 为了安全，这里不阻塞保存，使用异步触发
				performGlobalClean(vscode.window.visibleTextEditors.find(ed => ed.document === e.document));
			}
		}),
		vscode.window.onDidChangeTextEditorVisibleRanges(e => debounceRender(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(e => { if (e) debounceRender(e); }),
		vscode.window.onDidChangeWindowState(e => { if (e.focused) renderVisibleEditors(); }),
		vscode.workspace.onDidChangeTextDocument(e => {
			const ed = vscode.window.activeTextEditor;
			if (ed && e.document === ed.document) debounceRender(ed);
			if (e.document === ed?.document && e.contentChanges.length > 0) documentDecorationsMap.delete(e.document.uri.toString());
		}),
		vscode.workspace.onDidCloseTextDocument(doc => { documentDecorationsMap.delete(doc.uri.toString()); }),
		vscode.window.onDidChangeVisibleTextEditors(() => { renderVisibleEditors(); if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor); }),
	);

	const editor = vscode.window.activeTextEditor;
	if (editor) renderImages(editor);
}

async function deactivate() {
	clearDecorations();
	await qqq.finishUserTracking(extensionContext);
}

module.exports = { activate, deactivate };

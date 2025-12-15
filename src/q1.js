// src/q1.js
// ★★★ 图片/视频处理专家：FFmpeg 参数、预览生成、渲染、CodeLens ★★★
// ★★★ 新增：格式分类与透明检测系统 ★★★
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// 从 qqq.js 导入核心接口
const qqq = require("./qqq");

const CORE_INTEGRITY_HASH = "dc10f424bef818e80eea0a5175bbb6cca07cbee34c8510c7b64069ef1661c88e";
let isCoreIntegrityValid = false;

// ==================== 配置常量 ====================
const MAX_CONCURRENT_TASKS = 8;
const SCROLL_DEBOUNCE_MS = 200;
const PREVIEW_WIDTH = 512;
const PREVIEW_HEIGHT = 288;
const PREVIEW_BORDER = 6;
const PREVIEW_BG_COLOR = "#fef6e3";

// ==================== ★★★ 格式分类系统 ★★★ ====================

// Web 原生支持，可直接渲染（用于未来扩展，如跳过转码直接显示）
const WEB_SAFE_FORMATS = new Set([
	'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'
]);

// 格式天生支持透明通道 → 输出 WebP 保留透明能力
const ALPHA_CAPABLE_FORMATS = new Set([
	'png', 'apng',           // PNG 家族
	'gif',                   // GIF（调色板透明）
	'webp',                  // WebP（支持透明）
	'avif',                  // AVIF（支持透明）
	'tiff', 'tif',           // TIFF（支持透明）
	'psd',                   // Photoshop
	'ico',                   // 图标
	'bmp',                   // 32位 BMP (RGBA) - 保守处理
	'svg',                   // SVG 几乎全是透明背景
	'heic', 'heif',          // HEIC/HEIF 容器层面可能携带 alpha
]);

// 格式绝对不支持透明 → 输出 JPEG 更快更小
const OPAQUE_ONLY_FORMATS = new Set([
	'jpg', 'jpeg',           // JPEG 绝对无透明通道
	// 视频格式 - 绝对不透明，极限模式下走 JPEG 单帧
	'mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'm4v', 'wmv', '3gp',
	// RAW 格式 - 绝对不透明
	'raw', 'dng', 'cr2', 'nef', 'arw', 'orf', 'rw2', 'pef', 'srw',
	'dib',                   // DIB 通常无透明
]);

/**
 * 判断文件格式的透明能力
 * @param {string} ext - 扩展名（含或不含点）
 * @returns {'opaque'|'alpha'|'unknown'}
 */
function getTransparencyCapability(ext) {
	const e = ext.toLowerCase().replace(/^\./, '');
	if (OPAQUE_ONLY_FORMATS.has(e)) return 'opaque';
	if (ALPHA_CAPABLE_FORMATS.has(e)) return 'alpha';
	return 'unknown'; // 未知格式保守处理，当作可能透明
}

/**
 * 根据格式和模式决定最佳输出格式
 * @param {string} ext - 源文件扩展名
 * @param {boolean} isVideo - 是否为视频
 * @param {boolean} isAnimated - 是否为动图（GIF 或动态 WebP）
 * @param {boolean} extremeMode - 是否为极限性能模式
 * @returns {{format: 'gif'|'webp'|'jpeg'|'png', mime: string, outputExt: string}}
 */
function decideOutputFormat(ext, isVideo, isAnimated, extremeMode) {
	const capability = getTransparencyCapability(ext);

	// 视频处理
	if (isVideo) {
		if (extremeMode) {
			// 极限模式：视频用 JPEG 单帧，最快
			return { format: 'jpeg', mime: 'image/jpeg', outputExt: 'jpg' };
		} else {
			// 正常模式：视频用 GIF 动图预览
			return { format: 'gif', mime: 'image/gif', outputExt: 'gif' };
		}
	}

	// 动图处理（GIF、APNG、动态 WebP）
	if (isAnimated) {
		if (extremeMode) {
			// 极限模式：动图压缩为短 GIF
			return { format: 'gif', mime: 'image/gif', outputExt: 'gif' };
		} else {
			// 正常模式：保持 GIF 格式
			return { format: 'gif', mime: 'image/gif', outputExt: 'gif' };
		}
	}

	// 静态图片处理
	if (extremeMode) {
		// 极限模式：不透明格式用 JPEG，透明/未知格式用 WebP
		if (capability === 'opaque') {
			return { format: 'jpeg', mime: 'image/jpeg', outputExt: 'jpg' };
		} else {
			// alpha 或 unknown：用 WebP（支持透明且压缩好）
			return { format: 'webp', mime: 'image/webp', outputExt: 'webp' };
		}
	} else {
		// 正常模式：不透明用 JPEG，透明/未知用 WebP
		if (capability === 'opaque') {
			return { format: 'jpeg', mime: 'image/jpeg', outputExt: 'jpg' };
		} else {
			return { format: 'webp', mime: 'image/webp', outputExt: 'webp' };
		}
	}
}

// ==================== 旧的格式集合（保持兼容）====================
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg", ".heic", ".heif", ".avif", ".psd"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov", ".flv", ".m4v", ".wmv", ".3gp"]);

// ==================== 全局状态 ====================
let decorationType = null;
let markerHideType = null;
let extensionContext = null;
let currentRenderVersion = 0;

const documentDecorationsMap = new Map();
const resolutionCache = new Map();
const folderSizeCache = new Map();
const pendingTokens = new Map();

let enlargeSmallImages = true;
let extremePerformanceMode = false;
let cleanFreakMode = false;

// 水印
let watermarkBase64 = null;
const WATERMARK_PATH = path.join(__dirname, "..", "assets", "q2.gif");

// Loading SVG
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
		extremePerformanceMode = config.get("extremePerformance", false);
		cleanFreakMode = config.get("cleanFreak", false);
	} catch (e) {
		enlargeSmallImages = true;
		extremePerformanceMode = false;
		cleanFreakMode = false;
	}
}

function clearDecorations() {
	if (decorationType) { try { decorationType.dispose(); } catch (e) { } decorationType = null; }
	if (markerHideType) { try { markerHideType.dispose(); } catch (e) { } markerHideType = null; }
	documentDecorationsMap.clear();
}

// ==================== 工具函数 ====================

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

function isImageExt(ext) { return IMAGE_EXTS.has(ext.toLowerCase()); }
function isVideoExt(ext) { return VIDEO_EXTS.has(ext.toLowerCase()); }
function isImageOrVideoExt(ext) { const e = ext.toLowerCase(); return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e); }
function getDocumentEOL(doc) { return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"; }

function resolvePathToAbsolute(docUri, rawPath) {
	if (!rawPath) return null;
	let clean = rawPath.trim();
	while (clean.startsWith("\\") || clean.startsWith("/")) clean = clean.slice(1);
	if (path.isAbsolute(clean)) return clean;
	return path.resolve(path.dirname(docUri.fsPath), clean);
}

function buildNewRawPath(oldRaw, newName) {
	const lastSlash = Math.max(oldRaw.lastIndexOf("/"), oldRaw.lastIndexOf("\\"));
	return lastSlash === -1 ? newName : oldRaw.slice(0, lastSlash + 1) + newName;
}

// ==================== FFprobe 探测（q1 自己处理）====================

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

			let info = { mtime: mtimeMs, res: null, width: null, height: null, codec: null, codec_long_name: null, duration: 0, type: "unknown" };

			if (resMatch) {
				const w = parseInt(resMatch[1]), h = parseInt(resMatch[2]);
				info.res = `${w}x${h}`; info.width = w; info.height = h;
			}
			if (codecMatch?.[1]) {
				const parts = codecMatch[1].split(/[,\s]+/);
				info.codec = parts[0].trim();
				if (parts.length > 1) info.codec_long_name = codecMatch[1].trim();
			}
			if (durMatch) {
				const h = parseFloat(durMatch[1]), m = parseFloat(durMatch[2]), s = parseFloat(durMatch[3]);
				info.duration = h * 3600 + m * 60 + s;
			}

			// 类型判断
			if (info.codec) {
				const c = info.codec.toLowerCase();
				if (c.includes('mjpeg') && info.duration <= 0.1) { info.type = 'image'; info.duration = 0; }
				else if (['png', 'bmp', 'tiff', 'jpeg'].some(x => c.includes(x))) info.type = 'image';
				else if (c.includes('gif')) info.type = info.duration > 0.1 ? 'animated_image' : 'image';
				else if (c.includes('webp')) info.type = info.duration > 0.1 ? 'animated_image' : 'image';
				else if (c.includes('apng')) info.type = info.duration > 0.1 ? 'animated_image' : 'image';
				else if (['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2', 'mpeg1'].some(x => c.includes(x))) info.type = 'video';
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

// ==================== 预览生成（FFmpeg 参数由 q1 控制）====================

function getGifDurationFromBuffer(buffer) {
	if (!buffer || buffer.length < 13) return 0;
	try {
		let totalDelayCs = 0, i = 13;
		const sig = buffer.slice(0, 6).toString('ascii');
		if (sig !== 'GIF87a' && sig !== 'GIF89a') return 0;
		const flags = buffer[10];
		if ((flags & 0x80) !== 0) i += 3 * Math.pow(2, (flags & 0x07) + 1);

		while (i < buffer.length - 1) {
			const blockType = buffer[i];
			if (blockType === 0x21) {
				const extLabel = buffer[i + 1];
				if (extLabel === 0xF9) {
					if (i + 6 < buffer.length) totalDelayCs += buffer[i + 4] | (buffer[i + 5] << 8);
					i += 8;
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

/**
 * ★★★ 核心重构：根据格式分类构建 FFmpeg 参数 ★★★
 */
function buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize, duration) {
	const ext = path.extname(filePath).toLowerCase();
	const isAnimated = isGif || (isVideo === false && ext === '.webp' && duration > 0.1);

	// ★★★ 使用格式分类系统决定输出格式 ★★★
	const outputDecision = decideOutputFormat(ext, isVideo, isAnimated || isGif, extremePerformanceMode);

	let targetW = PREVIEW_WIDTH, targetH = PREVIEW_HEIGHT;
	if (origSize?.width) {
		const ow = origSize.width, oh = origSize.height;
		if (enlargeSmallImages || isVideo) {
			const scale = Math.min(PREVIEW_WIDTH / ow, PREVIEW_HEIGHT / oh);
			targetW = Math.max(1, Math.round(ow * scale));
			targetH = Math.max(1, Math.round(oh * scale));
		} else {
			if (ow <= PREVIEW_WIDTH && oh <= PREVIEW_HEIGHT) { targetW = ow; targetH = oh; }
			else {
				const scale = Math.min(PREVIEW_WIDTH / ow, PREVIEW_HEIGHT / oh);
				targetW = Math.max(1, Math.round(ow * scale));
				targetH = Math.max(1, Math.round(oh * scale));
			}
		}
	}

	const args = ["-hide_banner", "-loglevel", "error"];
	let expectedGifDuration = 0;
	const fpsLimit = extremePerformanceMode ? 8 : 10;
	const scaleFlags = extremePerformanceMode ? "neighbor" : "bilinear";
	const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=${scaleFlags}`;

	if (isVideo) {
		const safeDur = duration || 0;

		if (extremePerformanceMode) {
			// ★★★ 极限模式视频：输出 JPEG 单帧 ★★★
			let seekPos = Math.min(1, safeDur * 0.1);
			args.push("-ss", String(seekPos), "-i", filePath);
			args.push("-filter_complex", `[0:v]${scaleFilter}[out_v]`, "-map", "[out_v]");
			args.push("-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1");
			expectedGifDuration = 0;
		} else if (safeDur < 5) {
			// 短视频：完整 GIF 预览
			let clipStart = Math.min(1, safeDur * 0.1);
			let clipDur = Math.min(4, safeDur - clipStart);
			args.push("-ss", String(clipStart), "-t", String(clipDur), "-i", filePath);
			args.push("-filter_complex", `[0:v]fps=${fpsLimit},${scaleFilter},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5[out_v]`, "-map", "[out_v]", "-f", "gif", "-loop", "0", "pipe:1");
			expectedGifDuration = clipDur;
		} else {
			// 长视频：三段拼接 GIF
			const seg = 1.3;
			const s1 = 1, s2 = Math.floor(safeDur / 2), s3 = Math.max(s2 + seg + 0.5, safeDur - seg - 1);
			args.push("-ss", String(s1), "-t", String(seg), "-i", filePath);
			args.push("-ss", String(s2), "-t", String(seg), "-i", filePath);
			args.push("-ss", String(s3), "-t", String(seg), "-i", filePath);
			args.push("-filter_complex", `[0:v]fps=${fpsLimit},${scaleFilter}[v0];[1:v]fps=${fpsLimit},${scaleFilter}[v1];[2:v]fps=${fpsLimit},${scaleFilter}[v2];[v0][v1][v2]concat=n=3:v=1:a=0,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5[out_v]`, "-map", "[out_v]", "-f", "gif", "-loop", "0", "pipe:1");
			expectedGifDuration = seg * 3;
		}
	} else if (isGif || isAnimated) {
		// 动图处理：保持 GIF 格式
		if (extremePerformanceMode) args.push("-t", "2");
		args.push("-i", filePath);
		const f = extremePerformanceMode
			? `[0:v]fps=${fpsLimit},${scaleFilter}[out_v]`
			: `[0:v]${scaleFilter}[out_v]`;
		args.push("-filter_complex", f, "-map", "[out_v]", "-f", "gif", "-loop", "0", "pipe:1");
	} else {
		// ★★★ 静态图片：根据透明能力决定输出格式 ★★★
		args.push("-i", filePath);
		args.push("-filter_complex", `[0:v]${scaleFilter}[out_v]`, "-map", "[out_v]");
		args.push("-frames:v", "1");

		if (outputDecision.format === 'jpeg') {
			// 不透明格式 → JPEG（更快更小）
			args.push("-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "2", "pipe:1");
		} else if (outputDecision.format === 'webp') {
			// 可能透明格式 → WebP（保留透明能力）
			args.push("-f", "webp", "-quality", "80", "-lossless", "0", "pipe:1");
		} else {
			// 后备：PNG
			args.push("-f", "image2pipe", "-vcodec", "png", "pipe:1");
		}
	}

	return {
		args,
		targetW,
		targetH,
		expectedGifDuration,
		outputFormat: outputDecision,
		isAnimatedOutput: isVideo || isGif || isAnimated
	};
}

async function getPreviewBuffer(filePath, isVideo, isGif, contentId) {
	if (!qqq.ffmpegPath) return null;

	let mtimeMs = 0;
	try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { return null; }

	const ext = path.extname(filePath).toLowerCase();

	// 检查磁盘缓存 - 根据输出格式决定 quality key
	const info = await getMediaInfo(filePath, mtimeMs);
	const duration = info?.duration || 0;
	const isAnimated = isGif || (ext === '.webp' && duration > 0.1);
	const outputDecision = decideOutputFormat(ext, isVideo, isAnimated || isGif, extremePerformanceMode);

	// 缓存 key 包含输出格式信息
	const quality = extremePerformanceMode
		? `q0_${outputDecision.outputExt}`
		: (isVideo ? "q2_gif" : `q1_${outputDecision.outputExt}`);

	const cached = qqq.getCachedBuffer(contentId, quality);
	if (cached) {
		const gifDur = (isGif || isVideo) && !extremePerformanceMode ? getGifDurationFromBuffer(cached) : 0;
		return {
			buffer: cached,
			gifDuration: gifDur,
			fromCache: true,
			outputFormat: outputDecision
		};
	}

	const origSize = info ? { width: info.width, height: info.height } : null;

	return new Promise((resolve) => {
		const { args, targetW, targetH, expectedGifDuration, outputFormat, isAnimatedOutput } = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize, duration);
		const child = cp.spawn(qqq.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks = [];
		let resolved = false;

		const timer = setTimeout(() => {
			if (!resolved) { resolved = true; try { child.kill(); } catch { } resolve(null); }
		}, 30000);

		child.stdout.on("data", d => chunks.push(d));
		child.stderr.on("data", () => { });
		child.on("error", () => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); } });
		child.on("close", () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				if (!chunks.length) { resolve(null); return; }

				const buffer = Buffer.concat(chunks);
				let gifDuration = expectedGifDuration;

				// 只有 GIF 格式才解析时长
				if ((isGif || isAnimatedOutput) && outputFormat.format === 'gif') {
					gifDuration = getGifDurationFromBuffer(buffer);
					if (extremePerformanceMode && gifDuration > 2.5) gifDuration = 2.0;
				}

				// 写入磁盘缓存
				qqq.setCacheEntry(contentId, quality, buffer, {
					width: targetW,
					height: targetH,
					type: isVideo ? 'video' : (isGif ? 'gif' : 'image'),
					format: outputFormat.format,
					gifDur: gifDuration,
					srcDuration: duration
				});

				resolve({
					buffer,
					gifDuration,
					outputSize: { width: targetW, height: targetH },
					outputFormat
				});
			}
		});
	});
}

// ==================== 渲染 ====================

function computeMarginLeft() { return "100px"; }

function calculateAspectRatioString(w, h) {
	if (!w || !h) return "";
	if (w >= h) { const r = (h / w) * 16; return `16__${parseFloat(r.toFixed(1))}`; }
	else { const r = (w / h) * 16; return `${parseFloat(r.toFixed(1))}__16`; }
}

function createProgressSvg(durationSeconds) {
	if (!durationSeconds || durationSeconds <= 0) return null;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="4" viewBox="0 0 512 4"><rect width="512" height="4" fill="black"/><rect width="0" height="4" fill="#fdf6e3"><animate attributeName="width" from="0" to="512" dur="${durationSeconds.toFixed(3)}s" repeatCount="indefinite"/></rect></svg>`;
	return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

function calculateBlankLinesN(isFramed, isLastItem = false) {
	try {
		const config = vscode.workspace.getConfiguration('editor');
		const fontSize = config.get('fontSize', 14);
		const lhMult = config.get('lineHeight', 0) || 1.35;
		const pxPerLine = fontSize * lhMult;
		let baseN = Math.ceil(PREVIEW_HEIGHT / pxPerLine);
		let extra = 2 + Math.floor((lhMult - 1) * 3);
		extra = Math.min(5, Math.max(2, extra));
		let n = baseN + extra;
		n = Math.max(4, n);
		if (isLastItem) n = isFramed ? Math.max(8, n) : 2;
		else if (!isFramed) n = 2;
		return n;
	} catch (e) { return 15; }
}

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

	const marginLeft = computeMarginLeft();
	const boxWidth = PREVIEW_WIDTH + PREVIEW_BORDER;
	const boxHeight = PREVIEW_HEIGHT + PREVIEW_BORDER;
	const tasks = [];
	const regex = new RegExp(qqq.QQQ_PATH_REGEX);

	for (const range of visibleRanges) {
		const text = editor.document.getText(range);
		regex.lastIndex = 0;
		let match;

		while ((match = regex.exec(text))) {
			const offset = editor.document.offsetAt(range.start) + match.index;
			const pos = editor.document.positionAt(offset);
			const endPos = editor.document.positionAt(offset + match[0].length);
			const uniqueKey = `${pos.line}_${pos.character}`;

			hideDecos.set(uniqueKey, { range: new vscode.Range(pos, endPos) });

			const rawPath = match[0].slice(2, -2).trim();

			// PENDING 占位符
			if (rawPath.startsWith("__PENDING__:")) {
				const loadingDeco = {
					range: new vscode.Range(pos.line, 0, pos.line, 0),
					renderOptions: {
						after: {
							contentText: "",
							position: 'absolute', left: marginLeft, top: '0px',
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

			const ext = path.extname(absPath).toLowerCase();
			let isImage = isImageExt(ext), isVideo = isVideoExt(ext), isGif = ext === ".gif";
			let mtimeMs = 0;
			try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }

			if (!isImage && !isVideo) {
				const info = await getMediaInfo(absPath, mtimeMs);
				if (info?.type === "video") isVideo = true;
				else if (info?.type === "image") { isImage = true; if (info.codec === "gif") isGif = true; }
				else if (info?.type === "animated_image") { isImage = true; isGif = true; }
				else continue;
			}

			const targetLine = pos.line;
			if (targetLine >= editor.document.lineCount) continue;
			const anchorRange = new vscode.Range(targetLine, 0, targetLine, 0);

			// 计算指纹
			const contentId = qqq.computeFingerprint(absPath);
			if (!contentId) continue;

			tasks.push(async () => {
				if (currentRenderVersion !== myVersion) return null;
				try {
					const previewResult = await getPreviewBuffer(absPath, isVideo, isGif, contentId);
					if (currentRenderVersion !== myVersion) return null;

					const deco = { range: anchorRange, renderOptions: {} };
					let contentUrl = "";
					let actualGifDuration = 0;
					let outputSize = null;

					if (previewResult?.buffer) {
						// ★★★ 根据实际输出格式设置 MIME ★★★
						let mime = previewResult.outputFormat?.mime || "image/png";
						contentUrl = `url("data:${mime};base64,${previewResult.buffer.toString("base64")}")`;
						if (previewResult.gifDuration > 0) actualGifDuration = previewResult.gifDuration;
						outputSize = previewResult.outputSize;
					} else if (isImage && !isVideo && !isGif) {
						contentUrl = `url("${vscode.Uri.file(absPath).toString()}")`;
					}
					if (!contentUrl) return null;

					let progressBarUrl = null;
					if ((isGif || isVideo) && actualGifDuration > 0) {
						progressBarUrl = `url("${createProgressSvg(actualGifDuration)}")`;
					}

					const gridSize = "20px 20px";
					const gridImage = `conic-gradient(#fdf6e3 0.25turn, #e6e1cf 0.25turn 0.5turn, #fdf6e3 0.5turn 0.75turn, #e6e1cf 0.75turn)`;

					let layers = [], sizes = [], positions = [], repeats = [];

					if (watermarkBase64) {
						layers.push(`url("${watermarkBase64}")`);
						sizes.push("contain");
						positions.push("center center");
						repeats.push("no-repeat");
					}
					if (progressBarUrl) {
						layers.push(progressBarUrl);
						sizes.push("512px 4px");
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

					deco.hoverMessage = new vscode.MarkdownString(`[打开图片](${vscode.Uri.file(absPath).toString()})`);
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
		for (const res of results) {
			if (res) currentDecos.set(res.key, res.deco);
		}
	}

	editor.setDecorations(decorationType, Array.from(currentDecos.values()));
	if (hideDecos.size > 0) editor.setDecorations(markerHideType, Array.from(hideDecos.values()));
}

// ==================== 文件夹大小缓存 ====================

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

	// Fast Path: 纯文字
	const fastResult = await qqq.handleClipboardFast();
	if (fastResult?.type === "text") {
		await editor.edit(e => e.insert(editor.selection.active, fastResult.text));
		return;
	}

	// Slow Path: 媒体 - 先插入占位符
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

	// 后台处理媒体
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

	if (result.type === "unknown" || result.type === "error") {
		replacement = "";
	} else if (result.type === "folder_text") {
		replacement = result.text;
	} else if (result.type === "image" || result.type === "ikge") {
		const filePath = result.path;
		const relPath = path.relative(docDir, filePath).replace(/\//g, "\\");
		const isVidOrImg = isImageOrVideoExt(path.extname(filePath));
		const gapBelow = calculateBlankLinesN(isVidOrImg, true);
		replacement = `/\\${relPath}\\/` + eol.repeat(gapBelow);
		invalidateFolderSizeCacheForPath(filePath);
	} else if (result.type === "file") {
		const files = result.files;
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			const relPath = path.relative(docDir, f).replace(/\//g, "\\");
			const isVidOrImg = isImageOrVideoExt(path.extname(f));
			const isLastItem = (i === files.length - 1);
			if (i > 0) replacement += eol;
			replacement += `/\\${relPath}\\/`;
			const gapBelow = calculateBlankLinesN(isVidOrImg, isLastItem);
			replacement += eol.repeat(gapBelow);
			invalidateFolderSizeCacheForPath(f);
		}
		if (files.length > 1) {
			vscode.window.showInformationMessage("文件已复制 " + files.length);
		}
	} else if (result.type === "text") {
		replacement = result.text;
	}

	await editor.edit(editBuilder => {
		editBuilder.replace(markerRange, replacement);
	});

	setTimeout(() => renderImages(editor), 50);
}

// ==================== 整洁模式 ====================

function provideCleanlinessEdits(document) {
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
		let isVidOrImg = false;
		if (absPath) isVidOrImg = isImageOrVideoExt(path.extname(absPath));

		const lineObj = document.lineAt(markerLine);
		const lineContent = lineObj.text;

		if (startPos.character > 0) edits.push(vscode.TextEdit.insert(startPos, eol));
		const suffix = lineContent.substring(endPos.character);
		if (suffix.trim().length > 0) edits.push(vscode.TextEdit.insert(endPos, eol));

		let isLastMarkerInDoc = (i === markers.length - 1);
		const neededLines = calculateBlankLinesN(isVidOrImg, isLastMarkerInDoc);
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
	return edits;
}

async function performGlobalClean(editor, force = false) {
	if (!editor) return;
	if (!force && !cleanFreakMode) return;
	const edits = provideCleanlinessEdits(editor.document);
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
			const isVideoExtFlag = isVideoExt(ext);
			const targetLensLine = pos.line;

			tasks.push(async () => {
				let folderData = await getQqqFolderSize(folder);
				const fSize = folderData?.size || 0;
				const fSizeStr = formatBytes(fSize);
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
						let scale = 1;
						const MAX_W = PREVIEW_WIDTH, MAX_H = PREVIEW_HEIGHT;
						if (info.type === "video") isRealVideo = true;
						if (isRealVideo || isVideoExtFlag || enlargeSmallImages) {
							scale = Math.min(MAX_W / info.width, MAX_H / info.height);
						} else {
							if (info.width <= MAX_W && info.height <= MAX_H) scale = 1;
							else scale = Math.min(MAX_W / info.width, MAX_H / info.height);
						}
						const pct = Math.round(scale * 100);
						titleSuffix = `   (${pct}%)  ${info.width}x${info.height}`;
						if (info.codec) {
							tooltipText += `\n编解码器: ${info.codec}`;
							if (info.codec_long_name) tooltipText += ` (${info.codec_long_name})`;
						}
						const arStr = calculateAspectRatioString(info.width, info.height);
						if (arStr) tooltipText += `\n宽高比：${arStr}`;
						if (qqq.shouldShowDuration(info)) tooltipText += `\n⌛原始时长：${formatDuration(info.duration)}`;

						// ★★★ 显示透明能力信息 ★★★
						const capability = getTransparencyCapability(ext);
						if (capability === 'alpha') {
							tooltipText += `\n🎨 格式支持透明`;
						} else if (capability === 'opaque') {
							tooltipText += `\n🖼️ 格式不支持透明`;
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
	const regex = new RegExp(qqq.QQQ_PATH_REGEX);
	const newRaw = buildNewRawPath(rawPath, trimmed);
	const ranges = [];
	let m;
	const txt = doc.getText();
	while ((m = regex.exec(txt))) {
		const matchedRaw = m[0].slice(2, -2).trim();
		if (matchedRaw === rawPath) {
			const s = doc.positionAt(m.index);
			const e = doc.positionAt(m.index + m[0].length);
			ranges.push(new vscode.Range(s, e));
		}
	}
	if (ranges.length) {
		await editor.edit(b => ranges.forEach(r => b.replace(r, `/\\${newRaw}\\/`)));
	}
	invalidateFolderSizeCacheForPath(newAbs);
	renderVisibleEditors();
}

// ==================== 防抖与渲染 ====================

function debounceRender(editor, delay = SCROLL_DEBOUNCE_MS) {
	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => {
		if (editor && !editor.document.isClosed) renderImages(editor);
	}, delay);
}

function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors;
	if (editors?.length) editors.forEach(e => debounceRender(e, delay));
}

// ==================== 激活与停用 ====================

async function activate(context) {
	extensionContext = context;
	isCoreIntegrityValid = verifySystemIntegrity();
	console.log(`[QQQ Q1] Integrity: ${isCoreIntegrityValid ? "PASSED" : "FAILED"}`);
	console.log(`[QQQ Q1] 格式分类系统已加载:`);
	console.log(`  - ALPHA_CAPABLE: ${ALPHA_CAPABLE_FORMATS.size} 种格式`);
	console.log(`  - OPAQUE_ONLY: ${OPAQUE_ONLY_FORMATS.size} 种格式`);

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
		vscode.commands.registerCommand("qqq.setInOrder", () => {
			performGlobalClean(vscode.window.activeTextEditor, true);
		}),
		vscode.languages.registerCodeLensProvider({ scheme: "file" }, new FileCodeLensProvider()),
		vscode.workspace.onWillSaveTextDocument(e => {
			if (cleanFreakMode && e.document) {
				const edits = provideCleanlinessEdits(e.document);
				if (edits.length > 0) e.waitUntil(Promise.resolve(edits));
			}
		}),
		vscode.window.onDidChangeTextEditorVisibleRanges(e => debounceRender(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(e => { if (e) debounceRender(e); }),
		vscode.window.onDidChangeWindowState(e => { if (e.focused) renderVisibleEditors(); }),
		vscode.workspace.onDidChangeTextDocument(e => {
			const ed = vscode.window.activeTextEditor;
			if (ed && e.document === ed.document) debounceRender(ed);
			if (e.document === ed?.document && e.contentChanges.length > 0) {
				documentDecorationsMap.delete(e.document.uri.toString());
			}
		}),
		vscode.workspace.onDidCloseTextDocument(doc => {
			documentDecorationsMap.delete(doc.uri.toString());
		}),
		vscode.window.onDidChangeVisibleTextEditors(editors => {
			renderVisibleEditors();
			if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor);
		}),
	);

	const editor = vscode.window.activeTextEditor;
	if (editor) renderImages(editor);
}

async function deactivate() {
	clearDecorations();
	await qqq.finishUserTracking(extensionContext);
}

module.exports = {
	activate,
	deactivate,
	// ★★★ 导出格式分类系统供其他模块使用 ★★★
	WEB_SAFE_FORMATS,
	ALPHA_CAPABLE_FORMATS,
	OPAQUE_ONLY_FORMATS,
	getTransparencyCapability,
	decideOutputFormat
};

const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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

// ★★★ 媒体信息缓存 (替代 Sharp) ★★★
const resolutionCache = new Map();

const MAX_CONCURRENT_TASKS = 8;
const SCROLL_DEBOUNCE_MS = 200;

const PREVIEW_WIDTH = 512;
const PREVIEW_HEIGHT = 288;
const PREVIEW_BORDER = 6;
const PREVIEW_BG_COLOR = "#fef6e3";
const FFMPEG_BG_COLOR = "0xfef6e3";

// ★★★ 资源存在性缓存 (IO优化) ★★★
const assetsCache = {
	checked: false,
	bgExists: false,
	wmExists: false
};

// ★★★ 新增：水印资源内存缓存 ★★★
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
let isPythonAvailable = false;
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

// ★ 配置变量
let stretchSmallImages = true;
let extremePerformanceMode = false;
let cleanFreakMode = false;
let lastGlobalCleanTime = 0;

function refreshQqqConfig() {
	try {
		const config = vscode.workspace.getConfiguration("qqq");
		stretchSmallImages = config.get("stretchSmallImages", true);
		extremePerformanceMode = config.get("extremePerformance", false);
		cleanFreakMode = config.get("cleanFreak", false);
	} catch (e) {
		stretchSmallImages = true;
		extremePerformanceMode = false;
		cleanFreakMode = false;
	}
}

// ★★★ 启动时加载水印到内存 ★★★
function loadWatermarkResource() {
	try {
		if (fs.existsSync(WATERMARK_PATH)) {
			const buf = fs.readFileSync(WATERMARK_PATH);
			// 预先拼接好 Data URI Header
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
	// 校验依然使用磁盘文件，确保文件未被篡改
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
//           身份识别模块 (Identity Module)
// ==========================================

// 基于 ffmpeg 识别的 codec 来判断真实类型
function determineMediaType(codec, ext) {
	if (!codec) {
		// Fallback to extension if codec is unknown
		const e = ext.toLowerCase();
		if (e === ".gif") return "gif";
		if (VIDEO_EXTS.has(e)) return "video";
		if (IMAGE_EXTS.has(e)) return "image";
		return "unknown";
	}

	const c = codec.toLowerCase();

	if (c === "gif") return "gif";

	// 常见图片编码
	if (["png", "mjpeg", "webp", "bmp", "tiff", "jpeg", "jpg"].some(x => c.includes(x))) {
		// 特例：mjpeg 在某些容器中被视为 video，但在我们的逻辑中通常是图片流或封面
		// 如果扩展名强行是 mp4/mkv 且 codec 是 mjpeg，可能是个只有封面的视频，暂归为 video
		// 但为了安全，如果 codec 明确是 png/bmp/tiff，肯定是图片
		if (c.includes("mjpeg") && VIDEO_EXTS.has(ext.toLowerCase())) return "video";
		return "image";
	}

	// 常见视频编码
	const videoCodecs = [
		"h264", "hevc", "vp8", "vp9", "av1", "mpeg4", "mpeg2video",
		"prores", "wmv", "flv", "theora", "vc1", "rv40"
	];
	if (videoCodecs.some(x => c.includes(x))) return "video";

	// 兜底：根据后缀
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
	if (cached && cached.mtime === mtimeMs) {
		return cached;
	}

	if (!ffmpegPath) return null;

	return new Promise((resolve) => {
		const child = cp.spawn(ffmpegPath, ["-hide_banner", "-i", filePath], { windowsHide: true });
		let stderr = "";

		child.stderr.on("data", d => {
			if (stderr.length < 50000) {
				stderr += d.toString();
			}
		});

		child.on("close", () => {
			// 解析分辨率
			const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
			// 解析编码器 (Codec)
			const codecMatch = /Stream.*Video:\s*(.*?)(?:,|$)/i.exec(stderr);

			let info = {
				mtime: mtimeMs,
				res: null,
				width: null,
				height: null,
				codec: null,
				type: "unknown" // 新增字段：真实类型
			};

			if (resMatch) {
				const w = parseInt(resMatch[1]);
				const h = parseInt(resMatch[2]);
				info.res = `${w}x${h}`;
				info.width = w;
				info.height = h;
			}

			if (codecMatch && codecMatch[1]) {
				info.codec = codecMatch[1].trim();
			}

			// ★★★ 调用身份识别逻辑 ★★★
			const ext = path.extname(filePath);
			info.type = determineMediaType(info.codec, ext);

			resolutionCache.set(filePath, info);

			if (resolutionCache.size > 200) {
				const first = resolutionCache.keys().next().value;
				resolutionCache.delete(first);
			}
			// 只要解析出了宽度，就认为信息有效
			resolve(info.width ? info : null);
		});

		setTimeout(() => {
			try { child.kill(); } catch { }
			resolve(null);
		}, 2000);
	});
}

// ==========================================
//           FFmpeg 预览 (getPreviewBuffer)
// ==========================================

function setPreviewCache(filePath, buffer, mtimeMs) {
	if (previewCache.size >= MAX_PREVIEW_CACHE) {
		const firstKey = previewCache.keys().next().value;
		if (firstKey !== undefined) previewCache.delete(firstKey);
	}
	previewCache.set(filePath, { buffer, mtimeMs });
}

// ★★★ 核心修改：移除所有背景合成逻辑，GIF 始终输出动画 ★★★
function buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize) {
	const stretch = stretchSmallImages;
	let targetW = PREVIEW_WIDTH;
	let targetH = PREVIEW_HEIGHT;

	if (!stretch && !isVideo) {
		if (origSize && typeof origSize.width === "number" && typeof origSize.height === "number") {
			const ow = origSize.width;
			const oh = origSize.height;
			if (ow <= PREVIEW_WIDTH && oh <= PREVIEW_HEIGHT) {
				targetW = ow;
				targetH = oh;
			} else {
				const scale = Math.min(PREVIEW_WIDTH / ow, PREVIEW_HEIGHT / oh);
				targetW = Math.max(1, Math.round(ow * scale));
				targetH = Math.max(1, Math.round(oh * scale));
			}
		}
	}

	// 1. 基础参数
	const args = ["-hide_banner", "-loglevel", "error"];

	// ★ 视频跳过1秒做封面，但 GIF 保持从头开始（或后续剪裁）
	if (isVideo) args.push("-ss", "1");

	args.push("-i", filePath);

	// 2. ★★★ 移除 q1.png 背景加载逻辑 ★★★

	// 3. 构建滤镜 (Filter Complex)
	// 只需要缩放，或者 fps 控制，不进行任何 overlay/pad
	let fc = "";
	let preFilter = "";

	if (isGif) {
		// ★★★ GIF 逻辑：
		// 1. 如果极致性能模式：开启降帧 fps=10，并在输出时截断时长
		// 2. 否则：保持原始帧率
		if (extremePerformanceMode) {
			preFilter = "fps=10,";
			args.push("-t", "2"); // 限制时长 2秒
		}
	}

	// 缩放逻辑
	let scaleFilter = "";
	if (isGif) {
		let gifTargetW = targetW;
		let gifTargetH = targetH;
		if (!stretch && !isVideo && origSize && origSize.width && origSize.height) {
			const ow = origSize.width;
			const oh = origSize.height;
			if (ow <= PREVIEW_WIDTH && oh <= PREVIEW_HEIGHT) {
				gifTargetW = ow;
				gifTargetH = oh;
			} else {
				const scale = Math.min(PREVIEW_WIDTH / ow, PREVIEW_HEIGHT / oh);
				gifTargetW = Math.max(1, Math.round(ow * scale));
				gifTargetH = Math.max(1, Math.round(oh * scale));
			}
		}
		if (stretch || isVideo || !origSize) {
			gifTargetW = PREVIEW_WIDTH;
			gifTargetH = PREVIEW_HEIGHT;
		}
		// 保持比例缩放，不做 padding
		scaleFilter = `scale=${gifTargetW}:${gifTargetH}:force_original_aspect_ratio=decrease`;
	} else {
		scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`;
	}

	fc = `[0:v]${preFilter}${scaleFilter}[out_v]`;

	args.push("-filter_complex", fc);
	args.push("-map", "[out_v]");

	// 4. 输出格式
	if (isGif) {
		// ★★★ GIF 无论是否性能模式，都输出 gif 格式以保持动画 ★★★
		// 性能模式的优化体现在上面的 fps=10 和 -t 2
		args.push("-an", "-sn", "-f", "gif", "pipe:1");
	} else {
		// 纯视频文件（非GIF），输出单帧封面 (mjpeg 还是 png 取决于性能模式)
		if (extremePerformanceMode) {
			args.push("-frames:v", "1", "-an", "-sn", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");
		} else {
			args.push("-frames:v", "1", "-an", "-sn", "-f", "image2pipe", "-vcodec", "png", "pipe:1");
		}
	}

	return args;
}

async function getPreviewBuffer(filePath, isVideo, isGif) {
	if (!ffmpegPath) return null;

	let origSize = null;
	let mtimeMs = 0;
	try {
		const st = fs.statSync(filePath);
		mtimeMs = st.mtimeMs;
	} catch { return null; }

	if (!isVideo && !stretchSmallImages) {
		const info = await getMediaInfo(filePath, mtimeMs);
		if (info) origSize = { width: info.width, height: info.height };
	}

	if (extremePerformanceMode) {
		const cached = previewCache.get(filePath);
		if (cached) return cached.buffer;
	} else {
		const cached = previewCache.get(filePath);
		if (cached && cached.mtimeMs === mtimeMs) return cached.buffer;
	}

	const ok = await ensureFfmpegAvailable();
	if (!ok) return null;

	return new Promise((resolve) => {
		const args = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize);

		const child = cp.spawn(ffmpegPath, args, {
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore']
		});

		const chunks = [];
		let resolved = false;

		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				try { child.kill(); } catch { }
				resolve(null);
			}
		}, 10000); // GIF 处理可能稍慢，放宽到10秒

		child.stdout.on("data", (d) => chunks.push(d));

		child.on("error", () => {
			if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
		});

		child.on("close", () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				if (!chunks.length) { resolve(null); return; }
				const buffer = Buffer.concat(chunks);
				setPreviewCache(filePath, buffer, mtimeMs);
				resolve(buffer);
			}
		});
	});
}

// ==========================================
//           位置计算 & 宽高比计算
// ==========================================

function computeMarginLeft() {
	return "100px";
}

// ★★★ 宽高比计算逻辑 (16:x 或 x:16) ★★★
function calculateAspectRatioString(w, h) {
	if (!w || !h) return "";
	let ret = "";
	if (w >= h) {
		// 长大于宽，左边固定 16
		const r = (h / w) * 16;
		const right = parseFloat(r.toFixed(1)); // 四舍五入一位小数
		ret = `16:${right}`;
	} else {
		// 长小于宽，右边固定 16
		const r = (w / h) * 16;
		const left = parseFloat(r.toFixed(1));
		ret = `${left}:16`;
	}
	return ret;
}

// ==========================================
//           Python 交互
// ==========================================

function invalidateFolderSizeCacheForPath(filePath) {
	try {
		const dir = path.dirname(filePath);
		if (qqqFolderSizeCache.has(dir)) qqqFolderSizeCache.delete(dir);
	} catch { }
}

function calculateFolderSizeWithPython(folderPath) {
	return new Promise((resolve) => {
		if (!isPythonAvailable) return resolve(null);
		const scriptPath = path.join(__dirname, "kp.py");
		if (!fs.existsSync(scriptPath)) return resolve(null);
		const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
		const child = cp.spawn("python", [scriptPath, "get_size", folderPath], { env });
		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
		child.on("close", (code) => {
			if (code !== 0) return resolve(null);
			try {
				const res = JSON.parse(stdout.trim());
				if (res && res.qccess && typeof res.total_size === "number") resolve(res.total_size);
				else resolve(null);
			} catch { resolve(null); }
		});
	});
}

async function getQqqFolderSize(folderPath) {
	const now = Date.now();
	const cached = qqqFolderSizeCache.get(folderPath);
	if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) return cached.size;
	const size = await calculateFolderSizeWithPython(folderPath);
	if (typeof size === "number") {
		qqqFolderSizeCache.set(folderPath, { size, timestamp: now });
		return size;
	}
	return null;
}

async function checkPythonEnvironment() {
	return new Promise((resolve) => {
		cp.exec("python --version", (error) => {
			if (error) {
				cp.exec("python3 --version", (err3) => resolve(!err3));
			} else {
				resolve(true);
			}
		});
	});
}

function runPythonDbComknd(comknd, args = []) {
	return new Promise((resolve) => {
		if (!dbPath || !isPythonAvailable) return resolve(null);
		const scriptPath = path.join(__dirname, "kp.py");
		const procArgs = [scriptPath, "db_op", dbPath, comknd, ...args];
		const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
		const child = cp.spawn("python", procArgs, { env });
		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.on("close", () => {
			try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
		});
	});
}

async function initUserTracking(context) {
	if (!isPythonAvailable) return;
	const storageUri = context.globalStorageUri;
	const storagePath = storageUri.fsPath;
	if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });
	dbPath = path.join(storagePath, "da.sq3");
	const res = await runPythonDbComknd("login");
	if (res && res.qession_id) {
		currentQessionId = res.qession_id;
		const stats = await runPythonDbComknd("stats");
		if (stats && stats.forktted) {
			vscode.window.setStatusBarMessage(`qqq累计使用: ${stats.forktted}`, 5000);
		}
	}
}

async function finishUserTracking() {
	if (currentQessionId && isPythonAvailable) {
		await runPythonDbComknd("logout", [String(currentQessionId)]);
	}
}

function runPythonScript(additionalEnv = {}) {
	if (!isCoreIntegretyValid) {
		vscode.window.showErrorMessage("Integrity check failed.");
		return;
	}
	if (!isPythonAvailable) {
		vscode.window.showWarningMessage("Python 环境不可用。");
		return;
	}
	const scriptPath = path.join(__dirname, "kp.py");
	if (!fs.existsSync(scriptPath)) return;
	const editor = vscode.window.activeTextEditor;
	let targetDir = "D:\\view\\p";
	if (editor && !editor.document.isUntitled) {
		targetDir = path.join(path.dirname(editor.document.uri.fsPath), "qqq");
	}
	const env = { ...process.env, PYTHONIOENCODING: "utf-8", ...additionalEnv };
	const child = cp.spawn("python", [scriptPath, targetDir], { stdio: ["pipe", "pipe", "pipe"], env });
	let stdout = "", stderr = "";
	child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
	child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
	child.on("close", (code) => {
		if (code !== 0) {
			vscode.window.showErrorMessage("执行失败 " + code);
			return;
		}
		try { handleReqlt(JSON.parse(stdout.trim())); } catch (e) { }
	});
}

function executeClipboardComknd() { runPythonScript(); }

// ==========================================
//           核心：统一计算公式
// ==========================================

function calculateBlankLinesN(isFramed, isLastItem = false) {
	try {
		const config = vscode.workspace.getConfiguration('editor');
		const fontSize = config.get('fontSize', 14);
		const lineHeightMultiplier = config.get('lineHeight', 0);
		const effectiveLineHeight = (lineHeightMultiplier === 0) ? 1.35 : lineHeightMultiplier;

		const pixelPerLine = fontSize * effectiveLineHeight;
		const requiredHeight = PREVIEW_HEIGHT;

		let baseN = Math.ceil(requiredHeight / pixelPerLine);

		let extra = 2 + Math.floor((effectiveLineHeight - 1) * 3);
		extra = Math.min(5, Math.max(2, extra));

		let n = baseN + extra;
		n = Math.max(4, n);

		if (isLastItem) {
			if (isFramed) {
				n = Math.max(8, n);
			} else {
				n = 2;
			}
		} else {
			if (!isFramed) n = 2;
		}

		return n;
	} catch (e) {
		return 15;
	}
}

// ==========================================
//           核心：全局整理逻辑 (Strict)
// ==========================================

function provideCleanlinessEdits(document) {
	const edits = [];
	const text = document.getText();
	const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//gi;
	let match;

	const markers = [];
	while ((match = regex.exec(text))) {
		markers.push({
			text: match[0],
			index: match.index
		});
	}

	for (let i = markers.length - 1; i >= 0; i--) {
		const m = markers[i];
		const pos = document.positionAt(m.index);
		const markerLine = pos.line;

		const rawPath = m.text.slice(1, -1);
		const isVidOrImg = isImageOrVideoExt(path.extname(rawPath));

		let isLastMarkerInDoc = (i === markers.length - 1);
		const n = calculateBlankLinesN(isVidOrImg, isLastMarkerInDoc);

		let currentBlanks = 0;
		let nextContentLine = -1;

		for (let lineIdx = markerLine + 1; lineIdx < document.lineCount; lineIdx++) {
			const lineText = document.lineAt(lineIdx).text;
			if (lineText.trim() === "") {
				currentBlanks++;
			} else {
				nextContentLine = lineIdx;
				break;
			}
		}

		if (currentBlanks !== n) {
			const eol = getDocumentEOL(document);
			const idealString = eol.repeat(n);

			const startReplaceRow = markerLine + 1;
			const endReplaceRow = (nextContentLine === -1) ? document.lineCount : nextContentLine;

			const range = new vscode.Range(
				new vscode.Position(startReplaceRow, 0),
				new vscode.Position(endReplaceRow, 0)
			);

			edits.push(vscode.TextEdit.replace(range, idealString));
		}
	}
	return edits;
}

async function performGlobalClean(editor, force = false) {
	if (!editor) return;
	if (!force) {
		if (!cleanFreakMode) return;
		const now = Date.now();
		if (now - lastGlobalCleanTime < 1000) return;
		lastGlobalCleanTime = now;
	}

	const edits = provideCleanlinessEdits(editor.document);
	if (edits.length > 0) {
		await editor.edit(editBuilder => {
			edits.forEach(e => editBuilder.replace(e.range, e.newText));
		});
	}
}

// ==========================================
//           粘贴 / 文本处理
// ==========================================

function handleReqlt(reqlt) {
	if (reqlt.error) { vscode.window.showErrorMessage(reqlt.error); return; }
	const ed = vscode.window.activeTextEditor;
	if (!ed) return;

	const onDone = (files) => {
		if (files) files.forEach(f => invalidateFolderSizeCacheForPath(f));
		setTimeout(() => renderIkges(ed), 100);
	};

	if (reqlt.type === "folder_text" || reqlt.type === "text") {
		ed.edit(e => e.insert(ed.selection.active, reqlt.text)).then(() => onDone());
	}
	else if (reqlt.type === "ikge" || reqlt.type === "file") {
		const files = (reqlt.type === "ikge" || reqlt.files.length === 1)
			? [reqlt.path || reqlt.files[0]]
			: reqlt.files;

		const eol = getDocumentEOL(ed.document);
		let prefixText = "";

		const currentLineIdx = ed.selection.active.line;

		let contentLineIdx = -1;
		let contentLineText = "";

		for (let i = currentLineIdx - 1; i >= 0; i--) {
			const t = ed.document.lineAt(i).text;
			if (t.trim() !== "") {
				contentLineIdx = i;
				contentLineText = t;
				break;
			}
		}

		if (contentLineIdx !== -1) {
			const match = /\/[a-z]:[^\/]*?qqq[^\/]*?\//i.exec(contentLineText);
			const existingGap = currentLineIdx - contentLineIdx - 1;

			let requiredGap = 0;
			if (match) {
				const raw = match[0].slice(1, -1);
				const isPrevFramed = isImageOrVideoExt(path.extname(raw));
				requiredGap = calculateBlankLinesN(isPrevFramed, false);
			} else {
				requiredGap = 2;
			}

			if (existingGap < requiredGap) {
				prefixText = eol.repeat(requiredGap - existingGap);
			}
		}

		let insertionText = prefixText;

		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			const isVidOrImg = isImageOrVideoExt(path.extname(f));
			const isLastItem = (i === files.length - 1);

			insertionText += `/${f}/`;

			if (!isLastItem) {
				const gapBelow = calculateBlankLinesN(isVidOrImg, false);
				insertionText += eol.repeat(gapBelow + 1);
			} else {
				const requiredGapBelow = calculateBlankLinesN(isVidOrImg, true);
				let existingGapBelow = 0;
				for (let j = currentLineIdx + 1; j < ed.document.lineCount; j++) {
					const lineT = ed.document.lineAt(j).text;
					if (lineT.trim() === "") {
						existingGapBelow++;
					} else {
						break;
					}
				}

				if (existingGapBelow < requiredGapBelow) {
					const needed = requiredGapBelow - existingGapBelow;
					insertionText += eol.repeat(Math.max(0, needed));
				} else {
					if (existingGapBelow === 0) {
						insertionText += eol;
					}
				}
			}
		}

		ed.edit(e => e.insert(ed.selection.active, insertionText)).then(() => {
			if (files.length > 1) vscode.window.showInformationMessage("文件已复制 " + files.length);
			onDone(files);
		});

	} else if (reqlt.type === "binary") {
		vscode.window.showInformationMessage("二进制已保存");
	} else if (reqlt.type === "cancelled") {
		vscode.window.showInformationMessage("粘贴已取消");
	}
}

// ==========================================
//           渲染主逻辑 (灵敏性 + IO优化)
// ==========================================

async function renderIkges(editor) {
	if (!editor) return;
	if (!isCoreIntegretyValid) {
		clearDecorations();
		return;
	}

	const myRenderVersion = ++currentRenderVersion;

	if (!decorationType) {
		decorationType = vscode.window.createTextEditorDecorationType({
			isWholeLine: false
		});
	}

	if (!markerHideType) {
		// ★★★ 修改：暗号固定 11px，完全透明 (不可见) ★★★
		markerHideType = vscode.window.createTextEditorDecorationType({
			textDecoration: 'none; font-size: 11px; color: transparent; opacity: 0;'
		});
	}

	const docUri = editor.document.uri.toString();
	if (!documentDecorationsMap.has(docUri)) {
		documentDecorationsMap.set(docUri, new Map());
	}
	const currentDocDecos = documentDecorationsMap.get(docUri);
	const currentHideDecos = new Map();

	const visibleRanges = editor.visibleRanges;
	if (!visibleRanges || !visibleRanges.length) return;

	const marginLeft = computeMarginLeft();
	const boxWidth = PREVIEW_WIDTH + PREVIEW_BORDER;
	const boxHeight = PREVIEW_HEIGHT + PREVIEW_BORDER;

	const tasks = [];
	const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//gi;

	for (const range of visibleRanges) {
		const text = editor.document.getText(range);
		regex.lastIndex = 0;
		let match;
		while ((match = regex.exec(text))) {
			const offset = editor.document.offsetAt(range.start) + match.index;
			const pos = editor.document.positionAt(offset);
			const endPos = editor.document.positionAt(offset + match[0].length);

			const uniqueKey = `${pos.line}_${pos.character}`;

			const hideDeco = { range: new vscode.Range(pos, endPos) };
			currentHideDecos.set(uniqueKey, hideDeco);

			// ★ 灵敏性优化 1：先查内存，减少无谓 IO
			if (currentDocDecos.has(uniqueKey)) continue;

			const rawPath = match[0].slice(1, -1);
			const absPath = rawPath.replace(/\//g, "\\");

			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const ext = path.extname(absPath).toLowerCase();
			const isImage = isImageExt(ext);
			const isVideo = isVideoExt(ext);
			const isGif = ext === ".gif";

			if (!isImage && !isVideo) continue;

			const targetLine = pos.line + 1;
			if (targetLine >= editor.document.lineCount) continue;

			const anchorRange = new vscode.Range(targetLine, 0, targetLine, 0);

			const task = async () => {
				if (currentRenderVersion !== myRenderVersion) return null;

				try {
					let previewBuffer = null;
					// FFmpeg 生成的 Buffer 现在只包含纯净的、缩放后的 GIF 或封面
					if (ffmpegPath) {
						previewBuffer = await getPreviewBuffer(absPath, isVideo, isGif);
						if (currentRenderVersion !== myRenderVersion) return null;
					}

					const deco = { range: anchorRange, renderOptions: {} };

					// 1. 确定底层内容（Content）的 CSS URL
					let contentUrl = "";

					if (previewBuffer) {
						// 来自 FFmpeg
						// 注意：如果是GIF，现在输出的是 'image/gif'，如果是视频极速模式封面可能是 mjpeg
						let mime = "image/png";
						if (isGif) mime = "image/gif";
						else if (extremePerformanceMode) mime = "image/jpeg";

						const b64 = previewBuffer.toString("base64");
						contentUrl = `url("data:${mime};base64,${b64}")`;
					} else if (isImage) {
						// 静态普通图，直接读文件
						const fileUri = vscode.Uri.file(absPath);
						contentUrl = `url("${fileUri.toString()}")`;
					}

					if (!contentUrl) return null;

					// 2. ★★★ CSS 多重背景渲染核心 ★★★
					// 顺序：水印(最上) -> 内容(中间) -> 格子背景(最下)

					// 构建格子背景 (CSS Conic Gradient 模拟透明度网格)
					// 使用 #eee 和 #fff 模拟常见透明网格，或者根据要求使用自定义色
					const gridSize = "20px 20px";
					const gridImage = `conic-gradient(#eee 0.25turn, transparent 0.25turn 0.5turn, #eee 0.5turn 0.75turn, transparent 0.75turn)`;

					let bgImageVal, bgSizeVal, bgPosVal, bgRepVal;

					if (watermarkBase64) {
						// 三层：水印, 内容, 格子
						bgImageVal = `url("${watermarkBase64}"), ${contentUrl}, ${gridImage}`;
						bgSizeVal = `contain, contain, ${gridSize}`;
						bgPosVal = `center, center, 0 0`;
						bgRepVal = `no-repeat, no-repeat, repeat`;
					} else {
						// 两层：内容, 格子
						bgImageVal = `${contentUrl}, ${gridImage}`;
						bgSizeVal = `contain, ${gridSize}`;
						bgPosVal = `center, 0 0`;
						bgRepVal = `no-repeat, repeat`;
					}

					// 3. 基础样式
					const baseStyle = {
						position: 'absolute',
						left: marginLeft,
						top: '0px',
						width: `${boxWidth}px`,
						height: `${boxHeight}px`,
						padding: "2px",
						border: "1px dashed #888",
						backgroundColor: PREVIEW_BG_COLOR, // 底色，在格子透明部分显示
						zIndex: -1
					};

					deco.renderOptions.before = {
						contentText: "",
						...baseStyle,
						// 使用构造好的多重背景属性
						textDecoration: `none;
                            display: inline-block;
                            background-image: ${bgImageVal};
                            background-size: ${bgSizeVal};
                            background-position: ${bgPosVal};
                            background-repeat: ${bgRepVal};`
					};

					return { key: uniqueKey, deco };
				} catch (e) {
					return null;
				}
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

		for (const res of results) {
			if (res) {
				currentDocDecos.set(res.key, res.deco);
			}
		}
	}

	editor.setDecorations(decorationType, Array.from(currentDocDecos.values()));

	if (currentHideDecos.size > 0) {
		editor.setDecorations(markerHideType, Array.from(currentHideDecos.values()));
	}
}

// ==========================================
//           CodeLens
// ==========================================

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
		const parsed = parseHexColorToRGB(bg);
		if (parsed) return parsed;
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
		lastCodeLensColor = color;
		lastCodeLensIsActive = isActive;

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
		const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//gi;
		const text = document.getText();
		let match;
		const folderSizeMap = new Map();
		const lensLines = new Set();

		const tasks = [];

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const rawPath = match[0].slice(1, -1);
			const absPath = rawPath.replace(/\//g, "\\");
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const folder = path.dirname(absPath);
			const ext = path.extname(absPath).toLowerCase();
			const isVidOrImg = isImageOrVideoExt(ext);
			const isVideoExtFlag = isVideoExt(ext);

			tasks.push(async () => {
				let fSize = folderSizeMap.get(folder);
				if (fSize === undefined) {
					fSize = await getQqqFolderSize(folder);
					folderSizeMap.set(folder, fSize);
				}
				const fSizeStr = formatBytes(fSize);

				let fileSz = "?";
				let tooltipText = "";
				let mtimeMs = 0;
				try {
					const st = fs.statSync(absPath);
					fileSz = formatBytes(st.size);
					const bTime = new Date(st.birthtime).toLocaleString();
					const mTime = new Date(st.mtime).toLocaleString();
					tooltipText = `创建: ${bTime}\n修改: ${mTime}`;
					mtimeMs = st.mtimeMs;
				} catch { }

				let titleSuffix = "";
				// ★★★ 调用 getMediaInfo 以获取真实身份 ★★★
				let isRealVideo = false;

				if (isVidOrImg) {
					const info = await getMediaInfo(absPath, mtimeMs);
					if (info && info.width && info.height) {
						let scale = 1;
						const MAX_W = PREVIEW_WIDTH;
						const MAX_H = PREVIEW_HEIGHT;

						// 判断真实类型
						if (info.type === "video") isRealVideo = true;

						// 如果扩展名是 video，但 ffmpeg 解析失败或没返回 type，也暂且当 video 处理以防万一
						// 但根据 requirement, 我们 prefer actual decoding.
						// info.type 默认为 'unknown', determineMediaType 会尽可能归类。

						if (isRealVideo || isVideoExtFlag || stretchSmallImages) {
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

						if (info.codec) {
							tooltipText += `\n编解码器: ${info.codec}`;
						}

						// ★★★ 新增：Tooltip 中添加宽高比行 ★★★
						const arStr = calculateAspectRatioString(info.width, info.height);
						if (arStr) {
							tooltipText += `\n宽高比: ${arStr}`;
						}
					}
				}

				// ★★★ 图标与空格逻辑 ★★★
				// 视频: ( 24m)🎬 e:\...  (去掉左空格，保留右空格)
				// 其他: ( 24m)   e:\...  (保留左空格，即三个空格)
				const iconPart = isRealVideo ? "🎬" : "";
				const spacePart = isRealVideo ? " " : "   ";

				const r = new vscode.Range(pos, pos);
				return [
					new vscode.CodeLens(r, { title: `✎( ${fSizeStr}) 🗀qqq`, command: "qqq.revealFileInFolder", arguments: [absPath] }),
					new vscode.CodeLens(r, { title: "✎rename", command: "qqq.renameFile", arguments: [rawPath, absPath] }),
					new vscode.CodeLens(r, {
						title: `✎( ${fileSz})${iconPart}${spacePart}${absPath}${titleSuffix}`,
						command: "qqq.openFile",
						arguments: [absPath],
						tooltip: tooltipText
					})
				];
			});

			lensLines.add(pos.line);
		}

		const results = await Promise.all(tasks.map(t => t()));
		results.forEach(group => lenses.push(...group));

		lensLinesByDocUri.set(document.uri.toString(), lensLines);
		updateCodeLensColorForEditor(vscode.window.activeTextEditor);
		return lenses;
	}
}

// ==========================================
//           命令
// ==========================================

function openFileComknd(filePath) {
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
		if (process.platform === "win32") cp.exec(`explorer /select,"${filePath.replace(/"/g, '""')}"`);
		else if (process.platform === "darwin") cp.exec(`open -R "${filePath}"`);
		else cp.exec(`xdg-open "${path.dirname(filePath)}"`);
	} catch { }
}

async function renameFileComknd(rawPath, absPath) {
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
	const escaped = rawPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`\\/${escaped}\\/`, "g");
	const newRaw = buildNewRawPath(rawPath, trimmed);
	const ranges = [];
	let m;
	const txt = doc.getText();
	while ((m = regex.exec(txt))) {
		const s = doc.positionAt(m.index + 1);
		const e = doc.positionAt(m.index + 1 + rawPath.length);
		ranges.push(new vscode.Range(s, e));
	}
	if (ranges.length) {
		await editor.edit(b => ranges.forEach(r => b.replace(r, newRaw)));
	}
	invalidateFolderSizeCacheForPath(newAbs);
	renderVisibleEditors();
}

// ==========================================
//           激活与销毁 (灵敏性保证)
// ==========================================

function debounceRender(editor, delay = SCROLL_DEBOUNCE_MS) {
	// ★ 灵敏性优化 2：移除 isProcessing 锁，只要有事件就允许更新 Timer
	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => {
		if (editor && !editor.document.isClosed) {
			renderIkges(editor);
		}
	}, delay);
}

function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors;
	if (editors && editors.length) editors.forEach(e => debounceRender(e, delay));
}

async function activate(context) {
	extensionContext = context;

	isCoreIntegretyValid = verifySystemIntegrity();
	console.log(`[QQQ] Integrity: ${isCoreIntegretyValid ? "PASSED" : "FAILED"}`);

	if (!isCoreIntegretyValid) return;

	// ★★★ 启动时加载水印 ★★★
	loadWatermarkResource();

	refreshQqqConfig();
	isPythonAvailable = await checkPythonEnvironment();
	if (isPythonAvailable) initUserTracking(context);
	updateGlobalCodeLensColor(false);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("qqq")) {
				refreshQqqConfig();
				renderVisibleEditors();
				if (cleanFreakMode) {
					performGlobalClean(vscode.window.activeTextEditor);
				}
			}
			if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("editor.lineHeight")) {
				refreshQqqConfig();
				if (cleanFreakMode) {
					performGlobalClean(vscode.window.activeTextEditor);
				}
			}
		}),

		vscode.commands.registerCommand("qqq.q1", executeClipboardComknd),
		vscode.commands.registerCommand("qqq.openFile", openFileComknd),
		vscode.commands.registerCommand("qqq.revealFileInFolder", revealFileInFolder),
		vscode.commands.registerCommand("qqq.renameFile", renameFileComknd),
		vscode.commands.registerCommand("qqq.setInOrder", () => {
			performGlobalClean(vscode.window.activeTextEditor, true);
		}),

		vscode.languages.registerCodeLensProvider({ scheme: "file" }, new FileCodeLensProvider()),

		vscode.workspace.onWillSaveTextDocument(e => {
			if (cleanFreakMode && e.document) {
				const edits = provideCleanlinessEdits(e.document);
				if (edits.length > 0) {
					e.waitUntil(Promise.resolve(edits));
				}
			}
		}),

		vscode.window.onDidChangeTextEditorVisibleRanges(e => debounceRender(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(e => {
			if (e) debounceRender(e);
			updateCodeLensColorForEditor(e);
		}),
		// ★ 灵敏性优化 3：窗口获得焦点时，强制检查渲染
		vscode.window.onDidChangeWindowState(e => {
			if (e.focused) {
				renderVisibleEditors();
			}
		}),
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
			if (cleanFreakMode) {
				performGlobalClean(vscode.window.activeTextEditor);
			}
		}),
		vscode.window.onDidChangeTextEditorSelection(e => updateCodeLensColorForEditor(e.textEditor)),
		vscode.window.onDidChangeActiveColorTheme(() => updateCodeLensColorForEditor(vscode.window.activeTextEditor))
	);

	const editor = vscode.window.activeTextEditor;
	if (editor) renderIkges(editor);
}

async function deactivate() {
	clearDecorations();
	await finishUserTracking();
}

module.exports = { activate, deactivate };

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
//           FFmpeg 解析 (getMediaInfo)
// ==========================================

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
			const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
			const codecMatch = /Stream.*Video:\s*(.*?)(?:,|$)/i.exec(stderr);

			let info = { mtime: mtimeMs, res: null, width: null, height: null, codec: null };

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

			resolutionCache.set(filePath, info);

			if (resolutionCache.size > 200) {
				const first = resolutionCache.keys().next().value;
				resolutionCache.delete(first);
			}
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
	if (isVideo) args.push("-ss", "1"); // 视频跳过1秒做封面
	args.push("-i", filePath);

	// 2. 检查背景图 (q1.png - 格子背景/相框底图)
	// 注意：这里只保留背景图 q1.png，彻底移除了水印 q2.gif 的输入
	const bgImagePath = path.join(__dirname, "..", "assets", "q1.png");

	if (!assetsCache.checked) {
		assetsCache.bgExists = fs.existsSync(bgImagePath);
		// assetsCache.wmExists 逻辑移除，水印改由 CSS 处理
		assetsCache.checked = true;
	}
	const useImageBackground = assetsCache.bgExists;

	let streamIndex = 0;
	const contentIdx = streamIndex++;
	let bgIdx = -1;

	// 如果有背景图，作为第二个输入流
	if (useImageBackground) {
		args.push("-loop", "1", "-i", bgImagePath);
		bgIdx = streamIndex++;
	}

	// 3. 构建滤镜复杂图 (Filter Complex)
	// 目标：Scale 内容 -> (可选) Overlay 到背景图 -> (可选) Pad 填充
	let fc = "";

	// GIF 优化：限制帧率和时长，防止崩溃并提高速度
	let preFilter = "";
	if (isGif) {
		preFilter = "fps=10,";
		args.push("-t", "2");
	}

	// 3.1 缩放内容 (Scale)
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
		// 如果必须拉伸，覆盖上面的计算
		if (stretch || isVideo || !origSize) {
			gifTargetW = PREVIEW_WIDTH;
			gifTargetH = PREVIEW_HEIGHT;
		}

		// GIF 的 Scaling
		fc += `[${contentIdx}:v]${preFilter}scale=${gifTargetW}:${gifTargetH}:force_original_aspect_ratio=decrease[scaled]`;
	} else {
		// 普通视频/图片的 Scaling
		fc += `[${contentIdx}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[scaled]`;
	}

	// 3.2 合成背景 (Overlay or Pad)
	if (useImageBackground) {
		// 有背景图 q1.png：将缩放后的内容叠加到背景图中心
		// 这样保留了相框的纹理/格子
		fc += `;[${bgIdx}:v][scaled]overlay=(W-w)/2:(H-h)/2:format=auto[out_v]`;
	} else {
		// 无背景图：用颜色填充边框
		fc += `,pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${FFMPEG_BG_COLOR}[out_v]`;
	}

	// 注意：此处不再处理水印 [wmIdx]，水印已移交 CSS

	args.push("-filter_complex", fc);
	args.push("-map", "[out_v]");

	// 4. 输出格式
	if (extremePerformanceMode) {
		args.push("-frames:v", "1", "-an", "-sn", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");
	} else {
		if (isGif) {
			args.push("-an", "-sn", "-f", "gif", "pipe:1");
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
		}, 6000);

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
//           位置计算
// ==========================================

function computeMarginLeft() {
	return "100px";
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
		markerHideType = vscode.window.createTextEditorDecorationType({
			textDecoration: 'color: transparent; font-size: 1px; opacity: 0;'
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
					// FFmpeg 生成的 Buffer 现在只包含内容+相框背景，不含水印
					if (ffmpegPath) {
						previewBuffer = await getPreviewBuffer(absPath, isVideo, isGif);
						if (currentRenderVersion !== myRenderVersion) return null;
					}

					const deco = { range: anchorRange, renderOptions: {} };

					// 1. 确定底层内容（Content）的 CSS URL
					let contentUrl = "";

					if (previewBuffer) {
						// 来自 FFmpeg (包含背景图q1.png或填充色)
						const mime = extremePerformanceMode ? "image/jpeg" : (isGif ? "image/gif" : "image/png");
						const b64 = previewBuffer.toString("base64");
						contentUrl = `url("data:${mime};base64,${b64}")`;
					} else if (isImage) {
						// 静态普通图，直接读文件 (没有背景图q1.png，背景色为CSS定义)
						const fileUri = vscode.Uri.file(absPath);
						contentUrl = `url("${fileUri.toString()}")`;
					}

					if (!contentUrl) return null;

					// 2. ★★★ CSS 渲染核心改动：水印合成 ★★★
					let bgImageVal, bgSizeVal, bgPosVal, bgRepVal;

					if (watermarkBase64) {
						// 有水印：水印在上(First)，内容在下(Second)
						// 这样无论内容是 GIF、视频截图还是普通图片，水印都会覆盖在上面
						bgImageVal = `url("${watermarkBase64}"), ${contentUrl}`;
						bgSizeVal = "contain, contain";
						bgPosVal = "center, center";
						bgRepVal = "no-repeat, no-repeat";
					} else {
						// 无水印 (fallback)
						bgImageVal = contentUrl;
						bgSizeVal = "contain";
						bgPosVal = "center";
						bgRepVal = "no-repeat";
					}

					// 3. 基础样式 (保留原有的边框、背景色等)
					const baseStyle = {
						position: 'absolute',
						left: marginLeft,
						top: '0px',
						width: `${boxWidth}px`,
						height: `${boxHeight}px`,
						padding: "2px",
						border: "1px dashed #888",
						backgroundColor: PREVIEW_BG_COLOR,
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
			const isVideo = isVideoExt(ext);

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
				if (isVidOrImg) {
					const info = await getMediaInfo(absPath, mtimeMs);
					if (info && info.width && info.height) {
						let scale = 1;
						const MAX_W = PREVIEW_WIDTH;
						const MAX_H = PREVIEW_HEIGHT;

						if (isVideo || stretchSmallImages) {
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
					}
				}

				const r = new vscode.Range(pos, pos);
				return [
					new vscode.CodeLens(r, { title: `✎( ${fSizeStr}) 🗀qqq`, command: "qqq.revealFileInFolder", arguments: [absPath] }),
					new vscode.CodeLens(r, { title: "✎rename", command: "qqq.renameFile", arguments: [rawPath, absPath] }),
					new vscode.CodeLens(r, {
						title: `✎( ${fileSz})   ${absPath}${titleSuffix}`,
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
	// 之前这里有 check: if(isProcessing) return; 导致了事件丢失
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

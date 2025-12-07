// File: src/q1.js
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const crypto = require("crypto"); // 新增：用于哈希校验

// ==================== 核心完整性配置 ====================
// 硬编码的 SHA-256 哈希值
const CORE_INTEGRITY_HASH = "dc10f424bef818e80eea0a5175bbb6cca07cbee34c8510c7b64069ef1661c88e";
let isCoreIntegretyValid = false; // 全局安全锁，默认锁死

// ffmpeg 原生二进制
let ffmpegPath = null;
let ffmpegProbePromise = null;

// 预览缩略图缓存
const MAX_PREVIEW_CACHE = 50;
const previewCache = new Map();

// 统一预览尺寸
const PREVIEW_WIDTH = 512;
const PREVIEW_HEIGHT = 288;
const PREVIEW_BORDER = 6;

// 颜色配置
const PREVIEW_BG_COLOR = "#fdf6e3";
const FFMPEG_BG_COLOR = "0xfdf6e3";

// 尝试加载 @ffmpeg-installer/ffmpeg
try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
} catch (e) {
	ffmpegPath = null;
	console.log("未能加载 @ffmpeg-installer/ffmpeg:", e.message);
}

const LOG_PATH = "D:\\view\\p\\kp.log";

// 运行时状态
let currentQessionId = null;
let dbPath = null;
let isPythonAvailable = false;
let decorationType;
let extensionContext = null;

// CodeLens 相关
const lensLinesByDocUri = new Map();
let lastCodeLensIsActive = false;
let lastCodeLensColor = null;

// 扩展名定义
const IMAGE_EXTS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif",
]);
const VIDEO_EXTS = new Set([
	".mp4", ".mkv", ".webm", ".avi", ".mov",
]);

// 缓存与配置
const qqqFolderSizeCache = new Map();
const FOLDER_SIZE_CACHE_MAX_AGE = 10 * 1000;
let stretchSmallImages = true;
let extremePerformanceMode = false;

function refreshQqqConfig() {
	try {
		const config = vscode.workspace.getConfiguration("qqq");
		stretchSmallImages = config.get("stretchSmallImages", true);
		extremePerformanceMode = config.get("extremePerformance", false);
	} catch (e) {
		stretchSmallImages = true;
		extremePerformanceMode = false;
	}
}

function logMessage(message, level = "WARN") {
	if (level !== "ERROR" && level !== "WARN") return;
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}\n`;
	try {
		fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
		fs.appendFileSync(LOG_PATH, line);
	} catch (e) {
		console.error("日志写入失败:", e);
	}
}

function clearDecorations() {
	if (decorationType) {
		try {
			decorationType.dispose();
		} catch (e) { }
		decorationType = null;
	}
}

// ==========================================
//           安全校验函数 (新增)
// ==========================================

function verifySystemIntegrity() {
	const watermarkPath = path.join(__dirname, "..", "assets", "q2.gif");

	try {
		if (!fs.existsSync(watermarkPath)) {
			throw new Error("Core asset missing");
		}

		// 同步读取，只在启动时执行一次，性能可接受
		const buffer = fs.readFileSync(watermarkPath);
		const hash = crypto.createHash("sha256").update(buffer).digest("hex");

		if (hash !== CORE_INTEGRITY_HASH) {
			throw new Error("Integrity check failed");
		}

		isCoreIntegretyValid = true;
		console.log("qqq system integrity verified.");
		return true;

	} catch (e) {
		isCoreIntegretyValid = false;
		const msg = `qqq 扩展严重错误: 核心组件校验失败 (${e.message})。系统已挂起。`;
		vscode.window.showErrorMessage(msg);
		logMessage(msg, "ERROR");
		return false;
	}
}

// ==========================================
//           工具函数：尺寸 / 路径
// ==========================================

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

async function getImageDimensions(filePath) {
	try {
		const metadata = await sharp(filePath, { limitInputPixels: false }).metadata();
		if (metadata && typeof metadata.width === "number" && typeof metadata.height === "number") {
			return { width: metadata.width, height: metadata.height };
		}
	} catch (e) {
		logMessage("获取图片尺寸失败: " + e.message, "WARN");
	}
	return null;
}

// ==========================================
//           ffmpeg 原生版：缩略图预览
// ==========================================

async function ensureFfmpegAvailable() {
	// 如果完整性校验失败，假装 ffmpeg 不可用
	if (!isCoreIntegretyValid) return false;

	if (!ffmpegPath) return false;
	if (ffmpegProbePromise) return ffmpegProbePromise;

	ffmpegProbePromise = new Promise((resolve) => {
		const child = cp.spawn(ffmpegPath, ["-version"], { windowsHide: true });
		let handled = false;
		child.on("error", () => { ffmpegPath = null; handled = true; resolve(false); });
		child.on("close", (code) => {
			if (handled) return;
			resolve(code === 0);
		});
	});
	return ffmpegProbePromise;
}

function setPreviewCache(filePath, buffer, mtimeMs) {
	if (previewCache.size >= MAX_PREVIEW_CACHE) {
		const firstKey = previewCache.keys().next().value;
		if (firstKey !== undefined) previewCache.delete(firstKey);
	}
	previewCache.set(filePath, { buffer, mtimeMs });
}

// 核心逻辑修改：加入 q2.gif 水印图层
function buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize) {
	// 安全检查：如果校验失败，返回空参数，导致执行失败
	if (!isCoreIntegretyValid) return [];

	const extreme = extremePerformanceMode;
	const stretch = stretchSmallImages;

	let targetW = PREVIEW_WIDTH;
	let targetH = PREVIEW_HEIGHT;

	if (stretch || isVideo) {
		targetW = PREVIEW_WIDTH;
		targetH = PREVIEW_HEIGHT;
	} else {
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

	// 资源路径
	const bgImagePath = path.join(__dirname, "..", "assets", "q1.png");
	const watermarkPath = path.join(__dirname, "..", "assets", "q2.gif"); // 水印路径
	const useImageBackground = fs.existsSync(bgImagePath);

	const args = ["-hide_banner", "-loglevel", "error"];

	if (isVideo) args.push("-ss", "1");

	// 输入 0: 原始内容
	args.push("-i", filePath);

	// 输入流索引跟踪
	let streamIndex = 0; // 当前是 0
	const contentIdx = streamIndex++;

	let bgIdx = -1;
	if (useImageBackground) {
		// 输入 1 (如果存在): 背景图
		args.push("-loop", "1", "-i", bgImagePath);
		bgIdx = streamIndex++;
	}

	// 输入 2 (或1): 水印图 (q2.gif)
	// 强制 loop 保证动图时水印不消失
	args.push("-ignore_loop", "0", "-i", watermarkPath);
	const wmIdx = streamIndex++;

	// 构建 Filter Complex
	let fc = "";
	let currentStream = "";

	// 1. 处理原始内容缩放
	if (useImageBackground) {
		// 方案 A: 有背景图 -> Scale
		fc += `[${contentIdx}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[scaled];`;

		// 2. 叠加到背景图
		// [bg][scaled] -> [composed]
		fc += `[${bgIdx}:v][scaled]overlay=(W-w)/2:(H-h)/2:format=auto[composed];`;
		currentStream = "[composed]";
	} else {
		// 方案 B: 无背景图 -> Scale + Pad
		// 直接处理输入流 0
		fc += `[${contentIdx}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,`;
		fc += `pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${FFMPEG_BG_COLOR}[padded];`;
		currentStream = "[padded]";
	}

	// 3. 叠加水印 (Top Layer)
	// [currentStream][wm] -> output
	// 水印居中叠加
	fc += `${currentStream}[${wmIdx}:v]overlay=(W-w)/2:(H-h)/2:format=auto`;

	args.push("-filter_complex", fc);

	// 输出控制
	if (extreme) {
		args.push(
			"-frames:v", "1", "-an", "-sn",
			"-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
		);
	} else if (isGif) {
		args.push("-f", "gif", "pipe:1");
	} else {
		args.push(
			"-frames:v", "1", "-an", "-sn",
			"-f", "image2pipe", "-vcodec", "png", "pipe:1"
		);
	}

	return args;
}

async function getPreviewBuffer(filePath, isVideo, isGif) {
	// 熔断
	if (!isCoreIntegretyValid) return null;

	if (!ffmpegPath) return null;

	const extreme = extremePerformanceMode;
	let origSize = null;
	if (!isVideo && !stretchSmallImages) {
		origSize = await getImageDimensions(filePath);
	}

	if (extreme) {
		const cached = previewCache.get(filePath);
		if (cached) return cached.buffer;
		const ok = await ensureFfmpegAvailable();
		if (!ok) return null;

		return new Promise((resolve) => {
			const args = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize);
			// 再次检查参数生成是否被熔断拦截
			if (args.length === 0) { resolve(null); return; }

			const child = cp.spawn(ffmpegPath, args, { windowsHide: true });
			const chunks = [];
			child.stdout.on("data", (d) => chunks.push(d));
			child.on("error", () => resolve(null));
			child.on("close", () => {
				if (!chunks.length) { resolve(null); return; }
				const buffer = Buffer.concat(chunks);
				setPreviewCache(filePath, buffer, 0);
				resolve(buffer);
			});
		});
	}

	const ok = await ensureFfmpegAvailable();
	if (!ok) return null;

	let stat;
	try { stat = await fs.promises.stat(filePath); } catch { return null; }

	const cached = previewCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.buffer;

	return new Promise((resolve) => {
		const args = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize);
		if (args.length === 0) { resolve(null); return; }

		const child = cp.spawn(ffmpegPath, args, { windowsHide: true });
		const chunks = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.on("error", () => resolve(null));
		child.on("close", () => {
			if (!chunks.length) { resolve(null); return; }
			const buffer = Buffer.concat(chunks);
			setPreviewCache(filePath, buffer, stat.mtimeMs);
			resolve(buffer);
		});
	});
}

// ==========================================
//           预览偏移（left/right 参数）
// ==========================================

function getPreviewOffset() {
	try {
		if (extensionContext) {
			const stored = extensionContext.globalState.get("qqq.previewOffset");
			if (typeof stored === "number") return stored;
			const config = vscode.workspace.getConfiguration("qqq");
			const fromConfig = config.get("previewOffset", 100);
			extensionContext.globalState.update("qqq.previewOffset", fromConfig);
			return fromConfig;
		}
		const config = vscode.workspace.getConfiguration("qqq");
		return config.get("previewOffset", 100);
	} catch {
		return 100;
	}
}

function computeMarginLeft() {
	const value = getPreviewOffset();
	const numeric = typeof value === "number" ? value : 100;
	let marginLeft = -427 + numeric;
	try {
		const editorConfig = vscode.workspace.getConfiguration("editor");
		const fontSize = editorConfig.get("fontSize", 14);
		const delta = fontSize - 14;
		marginLeft += delta * 2;
	} catch { }
	return `${marginLeft}px`;
}

// ==========================================
//           目录大小（调用 kp.py get_size）
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
				cp.exec("python3 --version", (err3) => {
					resolve(!err3);
				});
			} else {
				resolve(true);
			}
		});
	});
}

// ==========================================
//           用户时长追踪
// ==========================================

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

// ==========================================
//             粘贴逻辑
// ==========================================

function runPythonScript(additionalEnv = {}) {
	// 如果核心校验失败，禁止粘贴功能
	if (!isCoreIntegretyValid) {
		vscode.window.showErrorMessage("qqq system compromised. Action aborted.");
		return;
	}

	if (!isPythonAvailable) {
		vscode.window.showWarningMessage("Python 环境不可用。");
		return;
	}
	const scriptPath = path.join(__dirname, "kp.py");
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
		if (stderr) logMessage("Python stderr: " + stderr, "WARN");
		if (code !== 0) {
			vscode.window.showErrorMessage("执行失败 " + code);
			return;
		}
		try { handleReqlt(JSON.parse(stdout.trim())); } catch (e) { logMessage("JSON Err: " + e.message, "ERROR"); }
	});
}

function executeClipboardComknd() { runPythonScript(); }

function findLastImageOrVideoMarkerLine(document, position) {
	const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//g;
	for (let line = position.line - 1; line >= 0; line--) {
		const match = regex.exec(document.lineAt(line).text);
		if (match && isImageOrVideoExt(path.extname(match[0].slice(1, -1) || ""))) return line;
	}
	return null;
}

function countBlankLinesBetween(document, startLine, endLine) {
	let blank = 0;
	if (endLine <= startLine + 1) return 0;
	for (let i = startLine + 1; i < endLine; i++) {
		if (document.lineAt(i).text.trim() === "") blank++;
	}
	return blank;
}

function buildInsertionTextForMarker(editor, insertPosition, markerText, isImageOrVideo) {
	const document = editor.document;
	const eol = getDocumentEOL(document);
	let prefixLines = 1;
	if (isImageOrVideo) {
		const lastLine = findLastImageOrVideoMarkerLine(document, insertPosition);
		if (lastLine !== null) {
			const blanks = countBlankLinesBetween(document, lastLine, insertPosition.line);
			if (blanks < 18) prefixLines += (18 - blanks);
		}
	}
	let insertion = eol.repeat(prefixLines) + markerText;
	if (isImageOrVideo) insertion += eol.repeat(18);
	return insertion;
}

function handleReqlt(reqlt) {
	if (reqlt.error) { vscode.window.showErrorMessage(reqlt.error); return; }
	const ed = vscode.window.activeTextEditor;
	if (!ed) return;

	const onDone = () => setTimeout(() => renderIkges(ed), 50);

	if (reqlt.type === "folder_text") {
		ed.edit(e => e.insert(ed.selection.active, reqlt.text));
	} else if (reqlt.type === "text") {
		ed.edit(e => e.insert(ed.selection.active, reqlt.text)).then(onDone);
	} else if (reqlt.type === "ikge") {
		const ins = buildInsertionTextForMarker(ed, ed.selection.active, `/${reqlt.path}/`, true);
		ed.edit(e => e.insert(ed.selection.active, ins)).then(() => {
			invalidateFolderSizeCacheForPath(reqlt.path);
			onDone();
		});
	} else if (reqlt.type === "file") {
		if (!reqlt.files || !reqlt.files.length) return;
		if (reqlt.files.length === 1) {
			const f = reqlt.files[0];
			const isVid = isImageOrVideoExt(path.extname(f));
			const ins = buildInsertionTextForMarker(ed, ed.selection.active, `/${f}/`, isVid);
			ed.edit(e => e.insert(ed.selection.active, ins)).then(() => {
				invalidateFolderSizeCacheForPath(f);
				onDone();
			});
		} else {
			const eol = getDocumentEOL(ed.document);
			let text = eol + reqlt.files.map(f => `/${f}/`).join(eol); // 简化
			ed.edit(e => e.insert(ed.selection.active, text)).then(() => {
				reqlt.files.forEach(f => invalidateFolderSizeCacheForPath(f));
				onDone();
			});
		}
		vscode.window.showInformationMessage("文件已复制 " + reqlt.files.length);
	} else if (reqlt.type === "binary") {
		vscode.window.showInformationMessage("二进制已保存");
	} else if (reqlt.type === "cancelled") {
		vscode.window.showInformationMessage("粘贴已取消");
	} else {
		vscode.window.showWarningMessage("未知内容");
	}
}

// ==========================================
//              下区图片/视频渲染
// ==========================================

async function renderIkges(editor) {
	if (!editor) return;

	// 熔断检测：如果不合法，什么都不渲染
	if (!isCoreIntegretyValid) {
		clearDecorations();
		return;
	}

	clearDecorations();
	decorationType = vscode.window.createTextEditorDecorationType({ color: "transparent" });

	const decos = [];
	const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//gi;
	const visibleRanges = editor.visibleRanges;
	if (!visibleRanges || !visibleRanges.length) return;

	const marginLeft = computeMarginLeft();
	const boxWidth = PREVIEW_WIDTH + PREVIEW_BORDER;
	const boxHeight = PREVIEW_HEIGHT + PREVIEW_BORDER;

	for (const range of visibleRanges) {
		const text = editor.document.getText(range);
		regex.lastIndex = 0;
		let match;
		while ((match = regex.exec(text))) {
			const offset = editor.document.offsetAt(range.start) + match.index;
			const pos = editor.document.positionAt(offset);
			const endPos = pos.translate(0, match[0].length);

			const absPath = match[0].slice(1, -1).replace(/\//g, "\\");
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const ext = path.extname(absPath).toLowerCase();
			const isImage = isImageExt(ext);
			const isVideo = isVideoExt(ext);
			if (!isImage && !isVideo) continue;

			const deco = { range: new vscode.Range(pos, endPos), renderOptions: {} };

			try {
				let previewBuffer = null;
				if (ffmpegPath) {
					previewBuffer = await getPreviewBuffer(absPath, isVideo, ext === ".gif");
				}

				const baseStyle = {
					margin: `4px 0 4px ${marginLeft}`,
					height: `${boxHeight}px`,
					width: `${boxWidth}px`,
					padding: "2px",
					border: "1px dashed #888",
					backgroundColor: PREVIEW_BG_COLOR,
					display: "block",
					position: "relative",
				};

				if (previewBuffer) {
					const mime = extremePerformanceMode ? "image/jpeg" : (ext === ".gif" ? "image/gif" : "image/png");
					const dataUri = vscode.Uri.parse(`data:${mime};base64,${previewBuffer.toString("base64")}`);
					deco.renderOptions.after = { ...baseStyle, contentIconPath: dataUri };
				} else if (isImage) {
					deco.renderOptions.after = { ...baseStyle, contentIconPath: vscode.Uri.file(absPath) };
				} else {
					continue;
				}
			} catch (e) {
				continue;
			}
			decos.push(deco);
		}
	}
	editor.setDecorations(decorationType, decos);
}

// ==========================================
//           CodeLens 逻辑
// ==========================================

function parseHexColorToRGB(hex) {
	if (!hex || !hex.startsWith("#")) return null;
	const s = hex.trim();
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
		const alpha = isActive ? 1 : 0.086;
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
	updateGlobalCodeLensColor(set && set.has(editor.selection.active.line));
}

class FileCodeLensProvider {
	async provideCodeLenses(document) {
		// 熔断：校验失败时不提供 CodeLens
		if (!isCoreIntegretyValid) return [];

		const lenses = [];
		const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//gi;
		const text = document.getText();
		let match;
		const folderSizeMap = new Map();
		const lensLines = new Set();

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const absPath = match[0].slice(1, -1).replace(/\//g, "\\");
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const folder = path.dirname(absPath);
			let fSize = folderSizeMap.get(folder);
			if (fSize === undefined) {
				fSize = await getQqqFolderSize(folder);
				folderSizeMap.set(folder, fSize);
			}
			const fSizeStr = formatBytes(fSize);
			let fileSz = "?";
			try { fileSz = formatBytes(fs.statSync(absPath).size); } catch { }

			const r = new vscode.Range(pos, pos);
			lenses.push(
				new vscode.CodeLens(r, { title: `✎( ${fSizeStr}) 🗀qqq`, command: "qqq.revealFileInFolder", arguments: [absPath] }),
				new vscode.CodeLens(r, { title: "✎rename", command: "qqq.renameFile", arguments: [match[0].slice(1, -1), absPath] }),
				new vscode.CodeLens(r, { title: `✎( ${fileSz})   ${absPath}`, command: "qqq.openFile", arguments: [absPath] })
			);
			lensLines.add(pos.line);
		}
		lensLinesByDocUri.set(document.uri.toString(), lensLines);
		updateCodeLensColorForEditor(vscode.window.activeTextEditor);
		return lenses;
	}
}

// ==========================================
//         命令实现
// ==========================================

function openFileComknd(filePath) {
	if (!fs.existsSync(filePath)) return;
	vscode.env.openExternal(vscode.Uri.file(filePath));
}

function revealFileInFolder(filePath) {
	if (!fs.existsSync(filePath)) return;
	const cmd = process.platform === "win32" ? `explorer /select,"${filePath}"` : (process.platform === "darwin" ? `open -R "${filePath}"` : `xdg-open "${path.dirname(filePath)}"`);
	cp.exec(cmd);
}

async function renameFileComknd(rawPath, absPath) {
	// 熔断保护
	if (!isCoreIntegretyValid) return;

	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const currentName = path.basename(absPath);
	const newName = await vscode.window.showInputBox({
		title: "重命名粘贴文件", prompt: "rename  ", value: currentName, ignoreFocusOut: true,
		validateInput: v => (!v || !v.trim()) ? "文件名不能为空" : null
	});
	if (!newName || newName.trim() === currentName) return;
	const trimmed = newName.trim();
	const newAbs = path.join(path.dirname(absPath), trimmed);

	try { await fs.promises.rename(absPath, newAbs); } catch (e) { vscode.window.showErrorMessage(e.message); return; }

	const doc = editor.document;
	const newRaw = buildNewRawPath(rawPath, trimmed);
	const reg = new RegExp(`\\/${rawPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/`, "g");
	const edits = [];
	let m;
	const txt = doc.getText();
	while ((m = reg.exec(txt))) {
		const s = doc.positionAt(m.index + 1);
		const e = doc.positionAt(m.index + 1 + rawPath.length);
		edits.push({ range: new vscode.Range(s, e), newText: newRaw });
	}

	if (edits.length) {
		await editor.edit(b => edits.forEach(x => b.replace(x.range, x.newText)));
	}
	invalidateFolderSizeCacheForPath(newAbs);
	renderVisibleEditors();
}

// ==========================================
//          防抖渲染
// ==========================================

function debounceRender(editor, delay = 100) {
	if (debounceRender.isProcessing) return;
	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => {
		if (editor && !editor.document.isClosed) {
			debounceRender.isProcessing = true;
			renderIkges(editor).finally(() => setTimeout(() => debounceRender.isProcessing = false, 50));
		}
	}, delay);
}
debounceRender.isProcessing = false;

function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors;
	if (editors && editors.length) editors.forEach(e => debounceRender(e, delay));
}

// ==========================================
//               模块激活
// ==========================================

async function activate(context) {
	// 1. 最优先执行：核心完整性校验
	// 如果 q2.gif 不存在或哈希不对，直接挂起，不注册后续事件或功能
	const isSecure = verifySystemIntegrity();
	if (!isSecure) {
		return; // 优雅退出，功能完全失效
	}

	extensionContext = context;
	refreshQqqConfig();
	isPythonAvailable = await checkPythonEnvironment();
	if (isPythonAvailable) initUserTracking(context);
	updateGlobalCodeLensColor(false);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("qqq")) {
				refreshQqqConfig();
				renderVisibleEditors();
			}
		}),
		vscode.commands.registerCommand("qqq.q1", executeClipboardComknd),
		vscode.commands.registerCommand("qqq.openFile", openFileComknd),
		vscode.commands.registerCommand("qqq.revealFileInFolder", revealFileInFolder),
		vscode.commands.registerCommand("qqq.renameFile", renameFileComknd),
		vscode.languages.registerCodeLensProvider({ scheme: "file" }, new FileCodeLensProvider()),
		vscode.window.onDidChangeTextEditorVisibleRanges(e => debounceRender(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(e => { if (e) debounceRender(e); updateCodeLensColorForEditor(e); }),
		vscode.workspace.onDidChangeTextDocument(e => {
			const ed = vscode.window.activeTextEditor;
			if (ed && e.document === ed.document) debounceRender(ed);
		}),
		vscode.window.onDidChangeVisibleTextEditors(renderVisibleEditors),
		vscode.window.onDidChangeTextEditorSelection(e => updateCodeLensColorForEditor(e.textEditor)),
		vscode.window.onDidChangeActiveColorTheme(() => updateCodeLensColorForEditor(vscode.window.activeTextEditor))
	);

	const editor = vscode.window.activeTextEditor;
	if (editor) renderIkges(editor);
}

async function deactivate() {
	await finishUserTracking();
}

module.exports = { activate, deactivate };

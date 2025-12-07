const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp"); // 新增：用来获取图片原始尺寸

// ffmpeg 原生二进制（自带）
let ffmpegPath = null;
let ffmpegProbePromise = null;

// 预览缩略图缓存（图片 / 视频共用）：filePath -> { buffer, mtimeMs }
const MAX_PREVIEW_CACHE = 50;
const previewCache = new Map();

// 统一的图片 / 视频预览尺寸
const PREVIEW_WIDTH = 512;
const PREVIEW_HEIGHT = 288;
const PREVIEW_BORDER = 6; // 额外边框像素（只用于展示尺寸）

// 相框背景色配置
// PREVIEW_BG_COLOR: VSCode 装饰器 CSS 背景（作为兜底，或在 ffmpeg 处理前的一瞬间显示）
// FFMPEG_BG_COLOR: 当 q1.png 不存在时，ffmpeg 降级使用的 pad 填充色
const PREVIEW_BG_COLOR = "#fdf6e3";
const FFMPEG_BG_COLOR = "0xfdf6e3";

// 尝试加载 @ffmpeg-installer/ffmpeg
try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
	console.log("Using bundled ffmpeg binary:", ffmpegPath);
} catch (e) {
	ffmpegPath = null;
	console.log(
		"未能加载 @ffmpeg-installer/ffmpeg，图片/视频预览将被禁用:",
		e.message,
	);
}

// 公共配置常量
const LOG_PATH = "D:\\view\\p\\kp.log";

// 记录当前会话ID (内存变量)
let currentQessionId = null;
let dbPath = null;
let isPythonAvailable = false; // 标记 Python 是否可用
let decorationType;
let extensionContext = null;

// 记录 qqq 匹配暗号所在行，用于控制 CodeLens 透明度
const lensLinesByDocUri = new Map();
let lastCodeLensIsActive = false;
let lastCodeLensColor = null;

// 统一的图片 / 视频扩展名
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
]);

const VIDEO_EXTS = new Set([
	".mp4",
	".mkv",
	".webm",
	".avi",
	".mov",
]);

// qqq 目录大小缓存： dirPath -> { size:number, timestamp:number }
const qqqFolderSizeCache = new Map();
const FOLDER_SIZE_CACHE_MAX_AGE = 10 * 1000; // 10 秒缓存

// 全局配置缓存（来自 VS Code 设置）
let stretchSmallImages = true;        // qqq.stretchSmallImages
let extremePerformanceMode = false;   // qqq.extremePerformance

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

	const rounded = Math.round(value);
	return `${rounded}${units[unitIndex]}`;
}

function isImageExt(ext) {
	return IMAGE_EXTS.has(ext.toLowerCase());
}

function isVideoExt(ext) {
	return VIDEO_EXTS.has(ext.toLowerCase());
}

function isImageOrVideoExt(ext) {
	const lower = ext.toLowerCase();
	return IMAGE_EXTS.has(lower) || VIDEO_EXTS.has(lower);
}

// 把 VSCode 文档 EOL 转成字符串
function getDocumentEOL(document) {
	return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

// 构造新的原始路径（文本里用的那一段）
function buildNewRawPath(oldRawPath, newFileName) {
	const lastSlash = Math.max(
		oldRawPath.lastIndexOf("/"),
		oldRawPath.lastIndexOf("\\"),
	);
	if (lastSlash === -1) {
		return newFileName;
	}
	const dirPart = oldRawPath.slice(0, lastSlash + 1);
	return dirPart + newFileName;
}

// 使用 sharp 获取图片原始尺寸（用于“取消拉伸小图”模式）
async function getImageDimensions(filePath) {
	try {
		const metadata = await sharp(filePath, { limitInputPixels: false }).metadata();
		if (
			metadata &&
			typeof metadata.width === "number" &&
			typeof metadata.height === "number"
		) {
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
	if (!ffmpegPath) {
		return false;
	}
	if (ffmpegProbePromise) {
		return ffmpegProbePromise;
	}

	ffmpegProbePromise = new Promise((resolve) => {
		const child = cp.spawn(ffmpegPath, ["-version"], {
			windowsHide: true,
		});

		let handled = false;

		child.on("error", (err) => {
			console.log("探测 ffmpeg 失败:", err.message);
			ffmpegPath = null;
			handled = true;
			resolve(false);
		});

		child.on("close", (code) => {
			if (handled) {
				return;
			}
			if (code === 0) {
				console.log("ffmpeg 探测成功，可以用于生成图片/视频预览");
				resolve(true);
			} else {
				console.log("ffmpeg 探测失败，退出码:", code);
				ffmpegPath = null;
				resolve(false);
			}
		});
	});

	return ffmpegProbePromise;
}

function setPreviewCache(filePath, buffer, mtimeMs) {
	if (previewCache.size >= MAX_PREVIEW_CACHE) {
		const firstKey = previewCache.keys().next().value;
		if (firstKey !== undefined) {
			previewCache.delete(firstKey);
		}
	}
	previewCache.set(filePath, { buffer, mtimeMs });
}

// ffmpeg 预览参数：
// - 视频：粗暴 -ss 1 放在 -i 前面
// - 图片/视频：scale + overlay (如果 assets/q1.png 存在) 或 scale + pad
// - GIF：
//    * 普通模式：输出动图 gif，保持动画（背景图循环）
//    * 极限性能模式：当作普通图片，取首帧，输出 JPEG
function buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize) {
	const extreme = extremePerformanceMode;
	const stretch = stretchSmallImages;

	// 1. 计算目标缩放尺寸 (targetW, targetH)
	//    无论是用 pad 还是 overlay，这部分计算逻辑是通用的
	let targetW = PREVIEW_WIDTH;
	let targetH = PREVIEW_HEIGHT;

	if (stretch || isVideo) {
		// 拉伸小图 / 视频：目标就是填满 512x288（fit inside）
		targetW = PREVIEW_WIDTH;
		targetH = PREVIEW_HEIGHT;
	} else {
		// 不拉伸小图：
		if (
			origSize &&
			typeof origSize.width === "number" &&
			typeof origSize.height === "number"
		) {
			const ow = origSize.width;
			const oh = origSize.height;

			if (ow <= PREVIEW_WIDTH && oh <= PREVIEW_HEIGHT) {
				// 小图：保持原尺寸
				targetW = ow;
				targetH = oh;
			} else {
				// 大图：按比例缩小至能完整放入框内
				const scale = Math.min(
					PREVIEW_WIDTH / ow,
					PREVIEW_HEIGHT / oh,
				);
				targetW = Math.max(1, Math.round(ow * scale));
				targetH = Math.max(1, Math.round(oh * scale));
			}
		}
	}

	// 2. 检测相框背景图 assets/q1.png 是否存在
	//    注意：src/q1.js 的 __dirname 通常在 /src，所以 assets 在 ../assets
	const bgImagePath = path.join(__dirname, "..", "assets", "q1.png");
	const useImageBackground = fs.existsSync(bgImagePath);

	// 3. 构造参数
	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
	];

	// 视频先粗略 seek 到 1 秒附近
	if (isVideo) {
		args.push("-ss", "1");
	}

	// 输入 0: 原始内容
	args.push("-i", filePath);

	// Filter Complex 构造
	let filterComplex = "";

	if (useImageBackground) {
		// === 方案 A: 使用图片背景 (Overlay) ===

		// 输入 1: 背景图 (-loop 1 保证 GIF 播放时背景一直存在)
		args.push("-loop", "1", "-i", bgImagePath);

		// [0:v] 缩放 -> [scaled]
		// [1:v] 背景
		// Overlay: 把 [scaled] 居中叠加到 [1:v] 上
		filterComplex = [
			`[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[scaled];`,
			`[1:v][scaled]overlay=(W-w)/2:(H-h)/2:format=auto`
		].join("");

		args.push("-filter_complex", filterComplex);

	} else {
		// === 方案 B: 降级方案 (Pad 纯色) ===

		// 单输入流，直接用 -vf
		const vf = [
			`scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`,
			`pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${FFMPEG_BG_COLOR}`,
		].join(",");

		args.push("-vf", vf);
	}

	// 4. 输出控制
	if (extreme) {
		// 极限性能模式：统一输出单帧 JPEG (mjpeg)
		args.push(
			"-frames:v", "1",
			"-an", "-sn",
			"-f", "image2pipe",
			"-vcodec", "mjpeg",
			"pipe:1",
		);
	} else if (isGif) {
		// 普通模式 GIF：保持动图
		// 注意：如果用了 filter_complex，输出默认取滤镜链的最终输出
		args.push(
			"-f", "gif",
			"pipe:1",
		);
	} else {
		// 普通图片 / 视频：输出单帧 PNG
		args.push(
			"-frames:v", "1",
			"-an", "-sn",
			"-f", "image2pipe",
			"-vcodec", "png",
			"pipe:1",
		);
	}

	return args;
}

async function getPreviewBuffer(filePath, isVideo, isGif) {
	if (!ffmpegPath) {
		return null;
	}

	const extreme = extremePerformanceMode;

	// 对于“取消拉伸小图”模式，预先用 sharp 拿一次图片原始尺寸
	let origSize = null;
	if (!isVideo && !stretchSmallImages) {
		origSize = await getImageDimensions(filePath);
	}

	// 极限性能模式：
	//   - 完全信任缓存，不做文件 stat/mTime 检查
	//   - 每个文件只生成一次缩略图
	if (extreme) {
		const cached = previewCache.get(filePath);
		if (cached) {
			return cached.buffer;
		}

		const ok = await ensureFfmpegAvailable();
		if (!ok) {
			return null;
		}

		return new Promise((resolve) => {
			const args = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize);
			const child = cp.spawn(ffmpegPath, args, {
				windowsHide: true,
			});

			const chunks = [];
			let stderr = "";

			child.stdout.on("data", (d) => {
				chunks.push(d);
			});

			child.stderr.on("data", (d) => {
				stderr += d.toString();
			});

			child.on("error", (err) => {
				console.log("调用 ffmpeg 生成预览失败:", err.message);
				resolve(null);
			});

			child.on("close", () => {
				if (!chunks.length) {
					if (stderr) {
						console.log("ffmpeg 预览 stderr:", stderr);
					}
					resolve(null);
					return;
				}
				const buffer = Buffer.concat(chunks);
				// 极限模式下不关心 mtime，写入 0 即可
				setPreviewCache(filePath, buffer, 0);
				resolve(buffer);
			});
		});
	}

	// 稳定模式：保留按 mtime 刷新缓存的逻辑
	const ok = await ensureFfmpegAvailable();
	if (!ok) {
		return null;
	}

	let stat;
	try {
		stat = await fs.promises.stat(filePath);
	} catch {
		return null;
	}

	// 缩略图缓存：key = filePath，value 里带 mtimeMs
	const cached = previewCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs) {
		return cached.buffer;
	}

	return new Promise((resolve) => {
		const args = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize);
		const child = cp.spawn(ffmpegPath, args, {
			windowsHide: true,
		});

		const chunks = [];
		let stderr = "";

		child.stdout.on("data", (d) => {
			chunks.push(d);
		});

		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});

		child.on("error", (err) => {
			console.log("调用 ffmpeg 生成预览失败:", err.message);
			resolve(null);
		});

		child.on("close", () => {
			if (!chunks.length) {
				if (stderr) {
					console.log("ffmpeg 预览 stderr:", stderr);
				}
				resolve(null);
				return;
			}
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
		// 优先从 globalState 读
		if (extensionContext) {
			const stored = extensionContext.globalState.get("qqq.previewOffset");
			if (typeof stored === "number") {
				return stored;
			}
			// 无缓存则从配置取一次并写入缓存
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

// 把 previewOffset 映射到 margin-left
function computeMarginLeft() {
	const value = getPreviewOffset();
	const numeric = typeof value === "number" ? value : 100;

	let marginLeft = -427 + numeric;

	try {
		const editorConfig = vscode.workspace.getConfiguration("editor");
		const fontSize = editorConfig.get("fontSize", 14);
		const delta = fontSize - 14;
		// 字号每 +1px，让图片向右挪 2px，粗略抵消字体变大的影响
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
		if (qqqFolderSizeCache.has(dir)) {
			qqqFolderSizeCache.delete(dir);
		}
	} catch { }
}

function calculateFolderSizeWithPython(folderPath) {
	return new Promise((resolve) => {
		if (!isPythonAvailable) return resolve(null);

		const scriptPath = path.join(__dirname, "kp.py");
		if (!fs.existsSync(scriptPath)) {
			logMessage("脚本不存在: " + scriptPath, "ERROR");
			return resolve(null);
		}

		const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
		const child = cp.spawn("python", [scriptPath, "get_size", folderPath], {
			env,
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
		child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

		child.on("close", (code) => {
			if (stderr) logMessage("get_size stderr: " + stderr, "WARN");
			if (code !== 0) {
				logMessage("get_size 退出码 " + code, "ERROR");
				return resolve(null);
			}
			try {
				const res = JSON.parse(stdout.trim());
				if (res && res.qccess && typeof res.total_size === "number") {
					resolve(res.total_size);
				} else {
					resolve(null);
				}
			} catch (e) {
				logMessage("get_size JSON解析失败: " + e.message, "ERROR");
				resolve(null);
			}
		});
	});
}

async function getQqqFolderSize(folderPath) {
	const now = Date.now();
	const cached = qqqFolderSizeCache.get(folderPath);
	if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) {
		return cached.size;
	}

	const size = await calculateFolderSizeWithPython(folderPath);
	if (typeof size === "number") {
		qqqFolderSizeCache.set(folderPath, { size, timestamp: now });
		return size;
	}
	return null;
}

// ==========================================
//           新增：环境检查
// ==========================================

async function checkPythonEnvironment() {
	return new Promise((resolve) => {
		cp.exec("python --version", (error) => {
			if (error) {
				// 尝试 python3
				cp.exec("python3 --version", (err3) => {
					if (err3) {
						vscode.window
							.showErrorMessage(
								"qqq: 未检测到 Python 环境。核心功能无法使用，请安装 Python。",
								"去下载",
							)
							.then((selection) => {
								if (selection === "去下载") {
									// 打开 Python 下载页
									vscode.env.openExternal(
										vscode.Uri.parse("https://www.python.org/downloads/"),
									);
								}
							});
						resolve(false);
					} else {
						resolve(true);
					}
				});
			} else {
				resolve(true);
			}
		});
	});
}

// ==========================================
//           用户时长追踪功能（复用原逻辑）
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
			try {
				const res = JSON.parse(stdout.trim());
				resolve(res);
			} catch (e) {
				resolve(null);
			}
		});
	});
}

async function initUserTracking(context) {
	if (!isPythonAvailable) return;

	const storageUri = context.globalStorageUri;
	const storagePath = storageUri.fsPath;

	if (!fs.existsSync(storagePath)) {
		fs.mkdirSync(storagePath, { recursive: true });
	}

	dbPath = path.join(storagePath, "da.sq3");

	const res = await runPythonDbComknd("login");
	if (res && res.qession_id) {
		currentQessionId = res.qession_id;
		const stats = await runPythonDbComknd("stats");
		if (stats && stats.forktted) {
			vscode.window.setStatusBarMessage(
				`qqq累计使用: ${stats.forktted}`,
				5000,
			);
		}
	}
}

async function finishUserTracking() {
	if (currentQessionId && isPythonAvailable) {
		await runPythonDbComknd("logout", [String(currentQessionId)]);
	}
}

// ==========================================
//             调用 kp.py 粘贴
// ==========================================

function runPythonScript(additionalEnv = {}) {
	if (!isPythonAvailable) {
		vscode.window.showWarningMessage("Python 环境不可用，无法执行粘贴。");
		return;
	}

	const scriptPath = path.join(__dirname, "kp.py");
	if (!fs.existsSync(scriptPath)) {
		logMessage("脚本不存在: " + scriptPath, "ERROR");
		return;
	}

	const editor = vscode.window.activeTextEditor;
	let targetDir = "";
	if (editor && !editor.document.isUntitled) {
		const currentDocPath = editor.document.uri.fsPath;
		const currentDir = path.dirname(currentDocPath);
		targetDir = path.join(currentDir, "qqq");
	} else {
		targetDir = "D:\\view\\p";
	}

	const env = {
		...process.env,
		PYTHONIOENCODING: "utf-8",
		...additionalEnv,
	};

	const child = cp.spawn("python", [scriptPath, targetDir], {
		stdio: ["pipe", "pipe", "pipe"],
		env: env,
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
	child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

	child.on("close", (code) => {
		if (stderr) logMessage("Python stderr: " + stderr, "WARN");
		if (code !== 0) {
			logMessage("退出码 " + code, "ERROR");
			vscode.window.showErrorMessage("执行失败 " + code);
			return;
		}
		try {
			const reqlt = JSON.parse(stdout.trim());
			handleReqlt(reqlt);
		} catch (e) {
			logMessage("JSON解析失败: " + e.message, "ERROR");
		}
	});
}

function executeClipboardComknd() {
	runPythonScript();
}

// ==========================================
//       插入匹配暗号时的空行 / 间距逻辑
// ==========================================

function findLastImageOrVideoMarkerLine(document, position) {
	const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//g;

	for (let line = position.line - 1; line >= 0; line--) {
		const text = document.lineAt(line).text;
		let match;
		while ((match = regex.exec(text))) {
			const rawPath = match[0].slice(1, -1);
			const ext = path.extname(rawPath || "").toLowerCase();
			if (isImageOrVideoExt(ext)) {
				return line;
			}
		}
	}
	return null;
}

function countBlankLinesBetween(document, startLine, endLine) {
	let blank = 0;
	if (endLine <= startLine + 1) return 0;
	for (let i = startLine + 1; i < endLine; i++) {
		const lineText = document.lineAt(i).text;
		if (lineText.trim() === "") {
			blank++;
		}
	}
	return blank;
}

// 构造插入字符串
function buildInsertionTextForMarker(editor, insertPosition, markerText, isImageOrVideo) {
	const document = editor.document;
	const eol = getDocumentEOL(document);

	let prefixLines = 1; // 规则 1：前面至少 1 空行

	if (isImageOrVideo) {
		const lastLine = findLastImageOrVideoMarkerLine(document, insertPosition);
		if (lastLine !== null) {
			const blanks = countBlankLinesBetween(
				document,
				lastLine,
				insertPosition.line,
			);
			if (blanks < 18) {
				const needExtra = 18 - blanks;
				prefixLines += needExtra;
			}
		}
	}

	let insertion = eol.repeat(prefixLines) + markerText;
	if (isImageOrVideo) {
		insertion += eol.repeat(18); // 规则 2：后面 18 空行
	}
	return insertion;
}

function handleReqlt(reqlt) {
	if (reqlt.error) {
		logMessage("处理失败: " + reqlt.error, "ERROR");
		vscode.window.showErrorMessage(reqlt.error);
		return;
	}
	const ed = vscode.window.activeTextEditor;
	if (!ed) return;

	switch (reqlt.type) {
		case "folder_text": {
			ed.edit((edit) => edit.insert(ed.selection.active, reqlt.text));
			break;
		}
		case "text": {
			ed.edit((edit) => edit.insert(ed.selection.active, reqlt.text)).then(
				() => {
					setTimeout(() => renderIkges(ed), 50);
				},
			);
			break;
		}
		case "ikge": {
			const marker = `/${reqlt.path}/`;
			const isImageOrVideo = true; // ikge 就是图片
			const insertPos = ed.selection.active;
			const insertion = buildInsertionTextForMarker(
				ed,
				insertPos,
				marker,
				isImageOrVideo,
			);
			ed.edit((edit) => edit.insert(insertPos, insertion)).then(() => {
				invalidateFolderSizeCacheForPath(reqlt.path);
				setTimeout(() => renderIkges(ed), 50);
			});
			break;
		}
		case "file": {
			if (!reqlt.files || reqlt.files.length === 0) {
				break;
			}

			// 多文件情况下
			if (reqlt.files.length === 1) {
				const filePath = reqlt.files[0];
				const ext = path.extname(filePath || "").toLowerCase();
				const isImageOrVideo = isImageOrVideoExt(ext);
				const marker = `/${filePath}/`;
				const insertPos = ed.selection.active;
				const insertion = buildInsertionTextForMarker(
					ed,
					insertPos,
					marker,
					isImageOrVideo,
				);
				ed.edit((edit) => edit.insert(insertPos, insertion)).then(() => {
					invalidateFolderSizeCacheForPath(filePath);
					setTimeout(() => renderIkges(ed), 50);
				});
			} else {
				const document = ed.document;
				const eol = getDocumentEOL(document);
				const insertPos = ed.selection.active;
				const firstMarker = `/${reqlt.files[0]}/`;
				// 前面至少 1 空行，其余保持简单，每个一行
				let text = eol + firstMarker;
				for (let i = 1; i < reqlt.files.length; i++) {
					text += eol + `/${reqlt.files[i]}/`;
				}
				ed.edit((edit) => edit.insert(insertPos, text)).then(() => {
					reqlt.files.forEach((f) => invalidateFolderSizeCacheForPath(f));
					setTimeout(() => renderIkges(ed), 50);
				});
			}

			vscode.window.showInformationMessage(
				"文件已复制 " + reqlt.files.length,
			);
			break;
		}
		case "binary": {
			vscode.window.showInformationMessage(
				"二进制已保存 " + path.basename(reqlt.path),
			);
			break;
		}
		case "cancelled": {
			vscode.window.showInformationMessage("粘贴已取消");
			break;
		}
		default:
			vscode.window.showWarningMessage("未知内容");
	}
}

// ==========================================
//              下区图片/视频渲染
// ==========================================

async function renderIkges(editor) {
	if (!editor) return;

	clearDecorations();

	// 下区：让匹配暗号本身的文字颜色变为透明，只显示 after 的图片
	decorationType = vscode.window.createTextEditorDecorationType({
		color: "transparent",
	});

	const decos = [];
	const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//gi;

	const visibleRanges = editor.visibleRanges;
	if (!visibleRanges || visibleRanges.length === 0) return;

	const marginLeft = computeMarginLeft();
	const boxWidth = PREVIEW_WIDTH + PREVIEW_BORDER;
	const boxHeight = PREVIEW_HEIGHT + PREVIEW_BORDER;

	for (const range of visibleRanges) {
		const text = editor.document.getText(range);

		regex.lastIndex = 0;
		let match;

		while ((match = regex.exec(text))) {
			const offsetInVisibleRange =
				editor.document.offsetAt(range.start) + match.index;
			const pos = editor.document.positionAt(offsetInVisibleRange);
			const endPos = pos.translate(0, match[0].length);
			const decoRange = new vscode.Range(pos, endPos);

			const rawPath = match[0].slice(1, -1);
			const absPath = rawPath.replace(/\//g, "\\");
			// 严格匹配小写 "qqq"
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) {
				continue;
			}

			const ext = path.extname(absPath).toLowerCase();
			const isImage = isImageExt(ext);
			const isVideo = isVideoExt(ext);
			const isGif = ext === ".gif";

			// 下区现在只对「图片或视频预览」做渲染
			if (!isImage && !isVideo) {
				continue;
			}

			const deco = {
				range: decoRange,
				renderOptions: {},
			};

			try {
				let previewBuffer = null;

				if (ffmpegPath) {
					previewBuffer = await getPreviewBuffer(absPath, isVideo, isGif);
				}

				if (previewBuffer) {
					const base64 = previewBuffer.toString("base64");
					let mime;
					if (extremePerformanceMode) {
						// 极限模式统一输出 JPEG
						mime = "image/jpeg";
					} else {
						mime = isGif ? "image/gif" : "image/png";
					}
					const dataUri = vscode.Uri.parse(
						`data:${mime};base64,${base64}`,
					);

					// 这里是“OK 相框布局”
					deco.renderOptions.after = {
						contentIconPath: dataUri,
						margin: `4px 0 4px ${marginLeft}`,
						height: `${boxHeight}px`,
						width: `${boxWidth}px`,
						padding: "2px",
						border: "1px dashed #888",
						backgroundColor: PREVIEW_BG_COLOR, // 使用微调后的暖色
						display: "block",
						position: "relative",
					};
				} else if (isImage) {
					// ffmpeg 不可用兜底
					deco.renderOptions.after = {
						contentIconPath: vscode.Uri.file(absPath),
						margin: `4px 0 4px ${marginLeft}`,
						height: `${boxHeight}px`,
						width: `${boxWidth}px`,
						padding: "2px",
						border: "1px dashed #888",
						backgroundColor: PREVIEW_BG_COLOR,
						display: "block",
						position: "relative",
					};
				} else {
					// 视频且无法生成封面，跳过
					continue;
				}
			} catch (error) {
				logMessage("处理图片/视频失败: " + error.message, "WARN");
				continue;
			}

			decos.push(deco);
		}
	}
	editor.setDecorations(decorationType, decos);
}

// ==========================================
//           CodeLens 前景色：反色 + 透明度
// ==========================================

function parseHexColorToRGB(hex) {
	if (typeof hex !== "string") return null;
	const s = hex.trim();
	if (!s.startsWith("#")) return null;

	let r, g, b;
	if (s.length === 7) {
		// #rrggbb
		r = parseInt(s.slice(1, 3), 16);
		g = parseInt(s.slice(3, 5), 16);
		b = parseInt(s.slice(5, 7), 16);
		return [r, g, b];
	}
	if (s.length === 4) {
		// #rgb
		r = parseInt(s[1] + s[1], 16);
		g = parseInt(s[2] + s[2], 16);
		b = parseInt(s[3] + s[3], 16);
		return [r, g, b];
	}
	if (s.length === 9) {
		// #rrggbbaa，忽略 alpha
		r = parseInt(s.slice(1, 3), 16);
		g = parseInt(s.slice(3, 5), 16);
		b = parseInt(s.slice(5, 7), 16);
		return [r, g, b];
	}
	return null;
}

function getEditorBackgroundRGB() {
	try {
		const workbenchConfig = vscode.workspace.getConfiguration("workbench");
		const custom = workbenchConfig.get("colorCustomizations") || {};
		const bg = custom["editor.background"];
		const parsed = parseHexColorToRGB(bg);
		if (parsed) return parsed;
	} catch { }

	// 没拿到具体颜色时，根据主题类型大致猜一个背景色
	const theme = vscode.window.activeColorTheme;
	const kind = theme ? theme.kind : vscode.ColorThemeKind.Light;
	if (
		kind === vscode.ColorThemeKind.Dark ||
		kind === vscode.ColorThemeKind.HighContrast
	) {
		return [30, 30, 30];
	}
	return [255, 255, 255];
}

async function updateGlobalCodeLensColor(isActive) {
	// isActive = true 时，不透明；否则接近透明
	try {
		const [bgR, bgG, bgB] = getEditorBackgroundRGB();
		const invR = 255 - bgR;
		const invG = 255 - bgG;
		const invB = 255 - bgB;
		const alpha = isActive ? 1 : 22 / 255; // 接近 0.086
		const color = `rgba(${invR}, ${invG}, ${invB}, ${alpha.toFixed(3)})`;

		if (color === lastCodeLensColor && isActive === lastCodeLensIsActive) {
			return;
		}
		lastCodeLensColor = color;
		lastCodeLensIsActive = isActive;

		const workbenchConfig = vscode.workspace.getConfiguration("workbench");
		const custom = workbenchConfig.get("colorCustomizations") || {};

		if (custom["editorCodeLens.foreground"] === color) {
			return;
		}

		const newCustom = {
			...custom,
			"editorCodeLens.foreground": color,
		};

		await workbenchConfig.update(
			"colorCustomizations",
			newCustom,
			vscode.ConfigurationTarget.Global,
		);
	} catch {
		// 静默失败即可，不影响其它功能
	}
}

function hasActiveLensOnLine(editor) {
	if (!editor) return false;
	const key = editor.document.uri.toString();
	const lineSet = lensLinesByDocUri.get(key);
	if (!lineSet || !lineSet.size) return false;
	const activeLine = editor.selection.active.line;
	return lineSet.has(activeLine);
}

function updateCodeLensColorForEditor(editor) {
	if (!editor) {
		updateGlobalCodeLensColor(false);
		return;
	}
	const active = hasActiveLensOnLine(editor);
	updateGlobalCodeLensColor(active);
}

// ==========================================
//              上区 CodeLens（3 个按钮）
// ==========================================

class FileCodeLensProvider {
	async provideCodeLenses(document) {
		const lenses = [];
		const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//gi;

		const text = document.getText();
		let match;

		// 同一个 qqq 目录仅计算一次
		const folderSizeMap = new Map();
		const lensLines = new Set();

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const range = new vscode.Range(pos, pos);
			const rawPath = match[0].slice(1, -1);
			const absPath = rawPath.replace(/\//g, "\\");

			// 严格匹配小写 "qqq"
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) {
				continue;
			}

			const folderPath = path.dirname(absPath);
			let folderSizeBytes = null;
			if (folderSizeMap.has(folderPath)) {
				folderSizeBytes = folderSizeMap.get(folderPath);
			} else {
				try {
					folderSizeBytes = await getQqqFolderSize(folderPath);
				} catch {
					folderSizeBytes = null;
				}
				folderSizeMap.set(folderPath, folderSizeBytes);
			}
			const folderSizeStr =
				folderSizeBytes != null ? formatBytes(folderSizeBytes) : "?";

			let fileSizeStr = "?";
			try {
				const stat = fs.statSync(absPath);
				if (stat.isFile()) {
					fileSizeStr = formatBytes(stat.size);
				}
			} catch { }

			// 按钮 1：📁qqq( 25m )
			const lensOpenFolder = new vscode.CodeLens(range, {
				title: `✎( ${folderSizeStr}) 🗀qqq`,
				command: "qqq.revealFileInFolder",
				arguments: [absPath],
			});

			// 按钮 2：  rename
			const lensRename = new vscode.CodeLens(range, {
				title: "✎rename",
				command: "qqq.renameFile",
				arguments: [rawPath, absPath],
			});

			// 按钮 3：  ( 5k )(e:\...\qqq\212zn...)
			const lensOpenFile = new vscode.CodeLens(range, {
				title: `✎( ${fileSizeStr})   ${absPath}`,
				command: "qqq.openFile",
				arguments: [absPath],
			});

			lenses.push(lensOpenFolder, lensRename, lensOpenFile);
			lensLines.add(pos.line);
		}

		// 记录该文档中所有 qqq CodeLens 所在的行号
		lensLinesByDocUri.set(document.uri.toString(), lensLines);

		updateCodeLensColorForEditor(vscode.window.activeTextEditor);

		return lenses;
	}
}

// ==========================================
//         上区按钮：打开 / 重命名
// ==========================================

function openFileComknd(filePath) {
	if (!fs.existsSync(filePath)) {
		vscode.window.showErrorMessage("文件不存在: " + filePath);
		return;
	}
	try {
		if (process.platform === "win32") {
			cp.exec(`start "" "${filePath.replace(/"/g, '""')}"`);
		} else if (process.platform === "darwin") {
			cp.exec(`open "${filePath}"`);
		} else {
			cp.exec(`xdg-open "${filePath}"`);
		}
	} catch (error) {
		vscode.env.openExternal(vscode.Uri.file(filePath));
	}
}

// 按钮 1：打开 qqq 文件夹
function revealFileInFolder(filePath) {
	if (!fs.existsSync(filePath)) {
		vscode.window.showErrorMessage("文件不存在: " + filePath);
		return;
	}
	try {
		if (process.platform === "win32") {
			const cmd = `explorer /select,"${filePath.replace(/"/g, '""')}"`;
			cp.exec(cmd);
		} else if (process.platform === "darwin") {
			cp.exec(`open -R "${filePath}"`);
		} else {
			const dir = path.dirname(filePath);
			cp.exec(`xdg-open "${dir}"`);
		}
	} catch (error) {
		vscode.window.showErrorMessage("打开所在文件夹失败: " + error.message);
	}
}

// 按钮 2：重命名
async function renameFileComknd(rawPath, absPath) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	const currentName = path.basename(absPath);
	const newName = await vscode.window.showInputBox({
		title: "重命名粘贴文件",
		prompt: "rename  ",
		value: currentName,
		ignoreFocusOut: true,
		validateInput: (value) => {
			if (!value || !value.trim()) {
				return "文件名不能为空";
			}
			return null;
		},
	});
	if (typeof newName === "undefined") {
		// 用户取消
		return;
	}
	const trimmedName = newName.trim();
	if (!trimmedName || trimmedName === currentName) {
		return;
	}

	const dir = path.dirname(absPath);
	const newAbsPath = path.join(dir, trimmedName);

	try {
		await fs.promises.rename(absPath, newAbsPath);
	} catch (error) {
		vscode.window.showErrorMessage("重命名失败: " + error.message);
		return;
	}

	// 更新文档中的所有匹配暗号
	const doc = editor.document;
	const fullText = doc.getText();
	const escapedRawPath = rawPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`\\/${escapedRawPath}\\/`, "g");

	const newRawPath = buildNewRawPath(rawPath, trimmedName);

	const ranges = [];
	let match;
	while ((match = regex.exec(fullText))) {
		const startOffset = match.index + 1; // 跳过 '/'
		const endOffset = startOffset + rawPath.length;
		const startPos = doc.positionAt(startOffset);
		const endPos = doc.positionAt(endOffset);
		ranges.push(new vscode.Range(startPos, endPos));
	}

	if (ranges.length === 0) {
		logMessage("未在文档中找到需要替换的路径: " + rawPath, "WARN");
	} else {
		await editor.edit((editBuilder) => {
			for (const range of ranges) {
				editBuilder.replace(range, newRawPath);
			}
		});
	}

	invalidateFolderSizeCacheForPath(newAbsPath);
	renderVisibleEditors();
	vscode.window.showInformationMessage("重命名成功");
}

// ==========================================
//          渲染刷新（防抖）
// ==========================================

function debounceRender(editor, delay = 100) {
	if (debounceRender.isProcessing) return;
	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => {
		if (editor && !editor.document.isClosed) {
			debounceRender.isProcessing = true;
			Promise.resolve()
				.then(() => {
					return renderIkges(editor);
				})
				.finally(() => {
					setTimeout(() => {
						debounceRender.isProcessing = false;
					}, 50);
				});
		}
	}, delay);
}
debounceRender.isProcessing = false;

function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors;
	if (editors && editors.length) {
		editors.forEach((ed) => {
			debounceRender(ed, delay);
		});
	}
}

// ==========================================
//               模块激活 / 停用
// ==========================================

async function activate(context) {
	extensionContext = context;

	// 先读取一次全局配置
	refreshQqqConfig();

	// 启动时检查 Python 环境
	isPythonAvailable = await checkPythonEnvironment();
	if (isPythonAvailable) {
		initUserTracking(context);
	}

	updateGlobalCodeLensColor(false);

	// 配置变更时同步
	vscode.workspace.onDidChangeConfiguration((event) => {
		if (
			event.affectsConfiguration("qqq.previewOffset") ||
			event.affectsConfiguration("qqq.stretchSmallImages") ||
			event.affectsConfiguration("qqq.extremePerformance")
		) {
			try {
				const config = vscode.workspace.getConfiguration("qqq");
				if (event.affectsConfiguration("qqq.previewOffset")) {
					const newVal = config.get("previewOffset", 100);
					if (extensionContext) {
						extensionContext.globalState.update(
							"qqq.previewOffset",
							newVal,
						);
					}
				}
				refreshQqqConfig();
				renderVisibleEditors();
			} catch { }
		}
	});

	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.q1", executeClipboardComknd),
		vscode.commands.registerCommand("qqq.openFile", openFileComknd),
		vscode.commands.registerCommand(
			"qqq.revealFileInFolder",
			revealFileInFolder,
		),
		vscode.commands.registerCommand("qqq.renameFile", renameFileComknd),
		vscode.languages.registerCodeLensProvider(
			{ scheme: "file" },
			new FileCodeLensProvider(),
		),
		vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
			debounceRender(event.textEditor);
		}),
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor) debounceRender(editor);
			updateCodeLensColorForEditor(editor);
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			const editor = vscode.window.activeTextEditor;
			if (editor && event.document === editor.document) {
				debounceRender(editor);
			}
		}),
		vscode.window.onDidChangeVisibleTextEditors(() => {
			renderVisibleEditors();
		}),
		vscode.window.onDidChangeTextEditorSelection((event) => {
			updateCodeLensColorForEditor(event.textEditor);
		}),
		vscode.window.onDidChangeActiveColorTheme(() => {
			updateCodeLensColorForEditor(vscode.window.activeTextEditor);
		}),
	);

	const editor = vscode.window.activeTextEditor;
	if (editor) renderIkges(editor);
}

async function deactivate() {
	await finishUserTracking();
}

module.exports = {
	activate,
	deactivate,
};

// File: src/q1.js
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

let sharp;
let ffmpeg = null;
let ffmpegUtils = null;
let ffmpegLoadingPromise = null;

// 尝试加载 sharp
try {
	sharp = require("sharp");
} catch (e) {
	sharp = null;
	console.log("sharp 库未安装，无法调整图片尺寸 / 生成格子背景");
}

// 尝试加载 ffmpeg.wasm（用于视频封面）
// 适配 @ffmpeg/ffmpeg + @ffmpeg/core@0.9.0
try {
	const { createFFmpeg, fetchFile } = require("@ffmpeg/ffmpeg");
	let corePath;
	try {
		// 优先使用默认导出
		corePath = require.resolve("@ffmpeg/core/dist/ffmpeg-core.js");
	} catch (e1) {
		console.log("Failed to resolve @ffmpeg/core/dist/ffmpeg-core.js:", e1.message);
		try {
			corePath = require.resolve("@ffmpeg/core");
		} catch (e2) {
			console.log("Failed to resolve @ffmpeg/core:", e2.message);
			corePath = undefined;
		}
	}

	console.log("Resolved corePath:", corePath);

	if (corePath) {
		// 使用更兼容的配置
		ffmpeg = createFFmpeg({
			log: false,
			corePath: corePath,
		});
		ffmpegUtils = { fetchFile };
		console.log("FFmpeg instance created successfully");

		// 测试 FFmpeg 可用性
		setTimeout(testFFmpegAvailability, 1000);
	} else {
		ffmpeg = null;
		ffmpegUtils = null;
		console.log("Could not resolve corePath, ffmpeg.wasm 未安装或加载失败，无法为视频生成封面");
	}
} catch (e) {
	console.log("Failed to create FFmpeg instance:", e.message);
	console.log("Stack trace:", e.stack);
	ffmpeg = null;
	ffmpegUtils = null;
	console.log("ffmpeg.wasm 未安装或加载失败，无法为视频生成封面");
}

// 添加一个标志来跟踪 FFmpeg 是否可用
let isFFmpegAvailable = false;

// 添加一个简单的测试函数来验证 FFmpeg 是否能正常工作
async function testFFmpegAvailability() {
	console.log("Testing FFmpeg availability...");
	if (!ffmpeg) {
		console.log("FFmpeg instance is null");
		isFFmpegAvailable = false;
		return;
	}

	try {
		const ready = await ensureFfmpegReady();
		if (ready) {
			console.log("FFmpeg is ready and available");
			isFFmpegAvailable = true;
		} else {
			console.log("FFmpeg is not ready");
			isFFmpegAvailable = false;
		}
	} catch (e) {
		console.log("Error testing FFmpeg availability:", e.message);
		console.log("Stack trace:", e.stack);
		isFFmpegAvailable = false;
	}
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

// ==========================================
//           ffmpeg.wasm 视频封面
// ==========================================

async function ensureFfmpegReady() {
	// 首先检查 FFmpeg 实例是否存在
	if (!ffmpeg) {
		console.log("FFmpeg instance is null, cannot ensure readiness");
		return false;
	}

	// 如果已经有加载承诺，直接返回
	if (ffmpegLoadingPromise) {
		console.log("Returning existing FFmpeg loading promise");
		return ffmpegLoadingPromise;
	}

	console.log("Creating new FFmpeg loading promise");
	ffmpegLoadingPromise = (async () => {
		try {
			// 检查是否已经加载
			if (!ffmpeg.isLoaded()) {
				console.log("Loading FFmpeg...");
				await ffmpeg.load();
				console.log("FFmpeg loaded successfully");
			} else {
				console.log("FFmpeg already loaded");
			}
			return true;
		} catch (e) {
			console.log("ffmpeg 加载失败:", e);
			console.log("Stack trace:", e.stack);
			// 清除加载承诺，以便下次可以重试
			ffmpegLoadingPromise = null;
			return false;
		}
	})();

	return ffmpegLoadingPromise;
}

async function extractVideoCoverBuffer(videoPath) {
	console.log("Attempting to extract video cover for:", videoPath);
	if (!ffmpeg || !ffmpegUtils) {
		console.log("FFmpeg not available for video cover extraction");
		return null;
	}
	const ready = await ensureFfmpegReady();
	if (!ready) {
		console.log("FFmpeg not ready for video cover extraction");
		return null;
	}

	try {
		const { fetchFile } = ffmpegUtils;
		const inputName = "input_" + path.basename(videoPath);
		const outputName = "cover.png";

		console.log("Writing video file to FFmpeg FS");
		ffmpeg.FS("writeFile", inputName, await fetchFile(videoPath));
		// 简单策略：取 1 秒处的一帧作为封面
		console.log("Executing FFmpeg command to extract cover");
		await ffmpeg.run(
			"-i",
			inputName,
			"-ss",
			"00:00:01.000",
			"-frames:v",
			"1",
			outputName,
		);
		console.log("Reading cover image from FFmpeg FS");
		const data = ffmpeg.FS("readFile", outputName);
		ffmpeg.FS("unlink", inputName);
		ffmpeg.FS("unlink", outputName);

		console.log("Video cover extracted successfully");
		return Buffer.from(data.buffer);
	} catch (e) {
		console.log("生成视频封面失败:", e);
		console.log("Stack trace:", e.stack);
		return null;
	}
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
// 需求：现在的 100，相当于之前的 0，整体再往左移 100px
// 同时略微考虑字体大小：字号越大，整体再往右一点，避免过度左飘
function computeMarginLeft() {
	const value = getPreviewOffset();
	const numeric = typeof value === "number" ? value : 100;

	let marginLeft = -427 + numeric; // 原来是 -327 + numeric，这里整体再左移 100px

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
	const regex = /\[([A-Za-z]:[\\\/].*?)\]/g;

	for (let line = position.line - 1; line >= 0; line--) {
		const text = document.lineAt(line).text;
		let match;
		while ((match = regex.exec(text))) {
			const rawPath = match[1];
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

// 构造插入字符串：
// 1. 插入前至少一个空行
// 2. 如果是图片/视频，插入后再加 18 个空行
// 3. 如果前一个图片/视频暗号到当前位置的空行 < 18，则在前面再补足
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
			const marker = `[${reqlt.path}]`;
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

			// 多文件情况下，为了简单起见：
			// - 如果只有 1 个文件，严格按规则插入
			// - 如果多个文件，沿用旧逻辑（每个一行），只在前面补 1 个空行
			if (reqlt.files.length === 1) {
				const filePath = reqlt.files[0];
				const ext = path.extname(filePath || "").toLowerCase();
				const isImageOrVideo = isImageOrVideoExt(ext);
				const marker = `[${filePath}]`;
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
				const firstMarker = `[${reqlt.files[0]}]`;
				// 前面至少 1 空行，其余保持简单，每个一行
				let text = eol + firstMarker;
				for (let i = 1; i < reqlt.files.length; i++) {
					text += eol + `[${reqlt.files[i]}]`;
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
//           生成格子背景（Solarized 暖色系）
// ==========================================

async function generateGridBackgroundBuffer(width, height) {
	if (!sharp) return null;

	// 采用小格子重复的棋盘格：A = #fef6e3, B = #e6e1cf
	const tileSize = 16;
	const colorA = "#fef6e3";
	const colorB = "#e6e1cf";

	const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <pattern id="qqq-grid" x="0" y="0" width="${tileSize}" height="${tileSize}" patternUnits="userSpaceOnUse">
      <rect x="0" y="0" width="${tileSize}" height="${tileSize}" fill="${colorA}" />
      <rect x="0" y="0" width="${tileSize / 2}" height="${tileSize / 2}" fill="${colorB}" />
      <rect x="${tileSize / 2}" y="${tileSize / 2}" width="${tileSize / 2}" height="${tileSize / 2}" fill="${colorB}" />
    </pattern>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#qqq-grid)" />
</svg>
`.trim();

	const buffer = Buffer.from(svg, "utf8");

	try {
		return await sharp(buffer).png().toBuffer();
	} catch (e) {
		logMessage("生成格子背景失败: " + e.message, "WARN");
		// 兜底：用纯色 A 填充
		return await sharp({
			create: {
				width,
				height,
				channels: 3,
				background: { r: 254, g: 246, b: 227 },
			},
		})
			.png()
			.toBuffer();
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
	const regex = /\[([A-Za-z]:[\\\/].*?)\]/gi;

	const visibleRanges = editor.visibleRanges;
	if (!visibleRanges || visibleRanges.length === 0) return;

	const marginLeft = computeMarginLeft();

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

			const rawPath = match[1];
			const absPath = rawPath.replace(/\//g, "\\");
			// 严格匹配小写 "qqq"
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) {
				continue;
			}

			const ext = path.extname(absPath).toLowerCase();
			const isImage = isImageExt(ext);
			const isVideo = isVideoExt(ext);

			// 下区现在只对「图片或视频封面」做渲染，普通文件不再做任何下区渲染
			if (!isImage && !isVideo) {
				continue;
			}

			// 如果是视频文件，检查 FFmpeg 是否可用
			if (isVideo && (!ffmpeg || !ffmpegUtils)) {
				console.log("Skipping video cover rendering - FFmpeg not available");
				continue;
			}

			const deco = {
				range: decoRange,
				renderOptions: {},
			};

			try {
				let bufferForSharp = null;

				if (isVideo) {
					// 生成视频封面
					const coverBuffer = await extractVideoCoverBuffer(absPath);
					if (!coverBuffer) {
						// 无法生成封面就不渲染
						continue;
					}
					bufferForSharp = coverBuffer;
				}

				if (sharp) {
					const TARGET_WIDTH = 512;
					const TARGET_HEIGHT = 288;
					let baseSharp;
					if (bufferForSharp) {
						baseSharp = sharp(bufferForSharp);
					} else {
						baseSharp = sharp(absPath);
					}

					// 先把原始图/封面 resize 为透明背景的 512x288
					const resizedBuffer = await baseSharp
						.resize(TARGET_WIDTH, TARGET_HEIGHT, {
							fit: "contain",
							position: "center",
							background: { r: 0, g: 0, b: 0, alpha: 0 },
						})
						.png()
						.toBuffer();

					let finalBuffer = resizedBuffer;

					// 用格子背景（Solarized 暖色系）作为统一背景
					try {
						const bgBuffer = await generateGridBackgroundBuffer(
							TARGET_WIDTH + 6,
							TARGET_HEIGHT + 6,
						);
						if (bgBuffer) {
							const bg = sharp(bgBuffer);
							finalBuffer = await bg
								.composite([
									{
										input: resizedBuffer,
										gravity: "center",
									},
								])
								.png()
								.toBuffer();
						}
					} catch (bgErr) {
						logMessage("合成格子背景失败: " + bgErr.message, "WARN");
					}

					const base64 = finalBuffer.toString("base64");
					const dataUri = vscode.Uri.parse(
						`data:image/png;base64,${base64}`,
					);

					deco.renderOptions.after = {
						contentIconPath: dataUri,
						margin: `4px 0 4px ${marginLeft}`,
						height: "294px",
						width: "518px",
						padding: "2px",
						border: "1px dashed #888",
						// 背景已经在 finalBuffer 里是棋盘格，这里保持透明即可
						backgroundColor: "transparent",
						display: "block",
						position: "relative",
					};
				} else {
					// 无 sharp：尽力展示原图（不支持视频封面）
					if (!isImage) {
						continue;
					}
					deco.renderOptions.after = {
						contentIconPath: vscode.Uri.file(absPath),
						margin: `4px 0 4px ${marginLeft}`,
						height: "148px",
						width: "auto",
						border: "1px dashed #888",
						backgroundColor: "rgba(230, 230, 250, 0.2)",
						display: "block",
						position: "relative",
					};
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
		const regex = /\[([A-Za-z]:[\\\/].*?)\]/gi;
		const text = document.getText();
		let match;

		// 同一个 qqq 目录仅计算一次
		const folderSizeMap = new Map();
		const lensLines = new Set();

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const range = new vscode.Range(pos, pos);
			const rawPath = match[1];
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

			// 按钮 1：📁qqq( 25m )  | 打开 qqq 文件夹并选中该文件
			const lensOpenFolder = new vscode.CodeLens(range, {
				title: `📁qqq( ${folderSizeStr} )  |`,
				command: "qqq.revealFileInFolder",
				arguments: [absPath],
			});

			// 按钮 2：  rename  |  —— 重命名文件 + 文本里的匹配暗号
			const lensRename = new vscode.CodeLens(range, {
				title: "  rename  |",
				command: "qqq.renameFile",
				arguments: [rawPath, absPath],
			});

			// 按钮 3：  ( 5k )(e:\...\qqq\212zn.  2025.12.06 [6] 12.09.14.png)
			const lensOpenFile = new vscode.CodeLens(range, {
				title: `  ( ${fileSizeStr} )(${absPath})`,
				command: "qqq.openFile",
				arguments: [absPath],
			});

			lenses.push(lensOpenFolder, lensRename, lensOpenFile);
			lensLines.add(pos.line);
		}

		// 记录该文档中所有 qqq CodeLens 所在的行号，用于控制透明度
		lensLinesByDocUri.set(document.uri.toString(), lensLines);

		// 触发一次颜色更新（比如一打开文档时）
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

// 按钮 1：打开 qqq 文件夹并尽量选中文件
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
			// macOS：open -R 可以高亮选中文件
			cp.exec(`open -R "${filePath}"`);
		} else {
			// Linux 桌面环境太多，统一退化为打开目录
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
		prompt: 'rename  （按“Enter”以确认或按"Esc”以取消）',
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
	const regex = new RegExp(`\\[${escapedRawPath}\\]`, "g");
	const newRawPath = buildNewRawPath(rawPath, trimmedName);

	const ranges = [];
	let match;
	while ((match = regex.exec(fullText))) {
		const startOffset = match.index + 1; // 跳过 '['
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

	// 重命名后刷新预览 / 目录缓存
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
					renderIkges(editor);
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

	// 启动时检查 Python 环境
	isPythonAvailable = await checkPythonEnvironment();
	if (isPythonAvailable) {
		// 只有 Python 存在才启动追踪
		initUserTracking(context);
	}

	// 初始设置一下 CodeLens 前景色（默认认为不激活）
	updateGlobalCodeLensColor(false);

	// 配置变更时同步 previewOffset 到 globalState，并刷新预览
	vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("qqq.previewOffset")) {
			try {
				const config = vscode.workspace.getConfiguration("qqq");
				const newVal = config.get("previewOffset", 100);
				if (extensionContext) {
					extensionContext.globalState.update(
						"qqq.previewOffset",
						newVal,
					);
				}
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
	);

	vscode.window.onDidChangeActiveTextEditor((editor) => {
		if (editor) debounceRender(editor);
		updateCodeLensColorForEditor(editor);
	});

	vscode.workspace.onDidChangeTextDocument((event) => {
		const editor = vscode.window.activeTextEditor;
		if (editor && event.document === editor.document) {
			debounceRender(editor);
		}
	});

	vscode.window.onDidChangeVisibleTextEditors(() => {
		renderVisibleEditors();
	});

	// 光标行改变时，更新 CodeLens 透明度
	vscode.window.onDidChangeTextEditorSelection((event) => {
		updateCodeLensColorForEditor(event.textEditor);
	});

	// 主题变化时，更新 CodeLens 颜色
	vscode.window.onDidChangeActiveColorTheme(() => {
		updateCodeLensColorForEditor(vscode.window.activeTextEditor);
	});

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

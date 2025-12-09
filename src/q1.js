const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
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

const MAX_CONCURRENT_TASKS = 8;
const SCROLL_DEBOUNCE_MS = 200;

const PREVIEW_WIDTH = 512;
const PREVIEW_HEIGHT = 288;
const PREVIEW_BORDER = 6;
const PREVIEW_BG_COLOR = "#fef6e3";
const FFMPEG_BG_COLOR = "0xfef6e3";

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
let extensionContext = null;

const lensLinesByDocUri = new Map();
let lastCodeLensIsActive = false;
let lastCodeLensColor = null;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov"]);

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
	} catch (e) { }
}

function clearDecorations() {
	if (decorationType) {
		try { decorationType.dispose(); } catch (e) { }
		decorationType = null;
	}
	documentDecorationsMap.clear();
}

function verifySystemIntegrity() {
	const watermarkPath = path.join(__dirname, "..", "assets", "q2.gif");
	try {
		if (!fs.existsSync(watermarkPath)) return false;
		const buffer = fs.readFileSync(watermarkPath);
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

async function getImageDimensions(filePath) {
	try {
		const metadata = await sharp(filePath, { limitInputPixels: false }).metadata();
		if (metadata && typeof metadata.width === "number" && typeof metadata.height === "number") {
			return { width: metadata.width, height: metadata.height };
		}
	} catch (e) { }
	return null;
}

// ==========================================
//           FFmpeg
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

function setPreviewCache(filePath, buffer, mtimeMs) {
	if (previewCache.size >= MAX_PREVIEW_CACHE) {
		const firstKey = previewCache.keys().next().value;
		if (firstKey !== undefined) previewCache.delete(firstKey);
	}
	previewCache.set(filePath, { buffer, mtimeMs });
}

// ★ GIF 专用分支：移植代码2的简化 -vf 逻辑（不加水印，直接 scale + pad 输出 gif）
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

	// ★★★ GIF 专用：简化流程，使用 -vf scale,pad -f gif（移植代码2，确保尺寸生效，不加水印/背景） ★★★
	if (isGif) {
		// 计算 vf（统一 scale + pad，支持 stretchSmallImages）
		let vf;
		if (stretch || isVideo) {
			// 拉伸模式：统一等比缩放到 512x288 后 pad
			vf = `scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:force_original_aspect_ratio=decrease,pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${FFMPEG_BG_COLOR}`;
		} else {
			// 不拉伸小图：小图保持原尺寸，大图等比缩小到相框内
			let gifTargetW = PREVIEW_WIDTH;
			let gifTargetH = PREVIEW_HEIGHT;
			if (origSize && typeof origSize.width === "number" && typeof origSize.height === "number") {
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
			vf = `scale=${gifTargetW}:${gifTargetH}:force_original_aspect_ratio=decrease,pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${FFMPEG_BG_COLOR}`;
		}

		const args = ["-hide_banner", "-loglevel", "error", "-i", filePath];
		if (extremePerformanceMode) {
			// extreme 模式：GIF 取首帧，输出 mjpeg（简化，不动图）
			args.push("-frames:v", "1", "-an", "-sn", "-vf", vf, "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");
		} else {
			// 普通模式：输出动图 gif
			args.push("-vf", vf, "-f", "gif", "pipe:1");
		}
		return args;
	}

	// 非 GIF：保持原复杂 filter_complex 逻辑（支持背景/水印）
	const args = ["-hide_banner", "-loglevel", "error"];
	if (isVideo) args.push("-ss", "1");
	args.push("-i", filePath);

	const bgImagePath = path.join(__dirname, "..", "assets", "q1.png");
	const watermarkPath = path.join(__dirname, "..", "assets", "q2.gif");

	const useImageBackground = fs.existsSync(bgImagePath);
	const useWatermark = fs.existsSync(watermarkPath);  // 非 GIF 加水印

	let streamIndex = 0;
	const contentIdx = streamIndex++;
	let bgIdx = -1;
	let wmIdx = -1;

	if (useImageBackground) {
		args.push("-loop", "1", "-i", bgImagePath);
		bgIdx = streamIndex++;
	}
	if (useWatermark) {
		args.push("-ignore_loop", "0", "-i", watermarkPath);
		wmIdx = streamIndex++;
	}

	let fc = "";
	let currentStream = "";

	if (useImageBackground) {
		fc += `[${contentIdx}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[scaled];`;
		fc += `[${bgIdx}:v][scaled]overlay=(W-w)/2:(H-h)/2:format=auto[composed]`;
		currentStream = "[composed]";
	} else {
		fc += `[${contentIdx}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,`;
		fc += `pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=${FFMPEG_BG_COLOR}[padded]`;
		currentStream = "[padded]";
	}

	if (useWatermark) {
		fc += `;${currentStream}[${wmIdx}:v]overlay=(W-w)/2:(H-h)/2:format=auto[out_v]`;
	} else {
		fc += `;${currentStream}copy[out_v]`;
	}

	args.push("-filter_complex", fc);
	args.push("-map", "[out_v]");

	if (extremePerformanceMode) {
		args.push("-frames:v", "1", "-an", "-sn", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");
	} else {
		args.push("-frames:v", "1", "-an", "-sn", "-f", "image2pipe", "-vcodec", "png", "pipe:1");
	}

	return args;
}

async function getPreviewBuffer(filePath, isVideo, isGif) {
	if (!ffmpegPath) return null;

	let origSize = null;
	if (!isVideo && !stretchSmallImages) {
		origSize = await getImageDimensions(filePath);
	}

	if (extremePerformanceMode) {
		const cached = previewCache.get(filePath);
		if (cached) return cached.buffer;
	} else {
		let stat;
		try { stat = await fs.promises.stat(filePath); } catch { return null; }
		const cached = previewCache.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.buffer;
	}

	const ok = await ensureFfmpegAvailable();
	if (!ok) return null;

	return new Promise((resolve) => {
		const args = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize);
		const child = cp.spawn(ffmpegPath, args, { windowsHide: true });

		const chunks = [];
		let stderr = "";
		let resolved = false;

		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				try { child.kill(); } catch { }
				resolve(null);
			}
		}, 6000);

		child.stdout.on("data", (d) => chunks.push(d));
		child.stderr.on("data", (d) => stderr += d.toString());

		child.on("error", () => {
			if (!resolved) { resolved = true; clearTimeout(timer); resolve(null); }
		});

		child.on("close", () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				if (!chunks.length) { resolve(null); return; }
				const buffer = Buffer.concat(chunks);
				let mtime = 0;
				try { mtime = fs.statSync(filePath).mtimeMs; } catch { }
				setPreviewCache(filePath, buffer, mtime);
				resolve(buffer);
			}
		});
	});
}

// ==========================================
//           位置计算
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
	let marginLeft = numeric;
	try {
		const editorConfig = vscode.workspace.getConfiguration("editor");
		const fontSize = editorConfig.get("fontSize", 14);
		const delta = fontSize - 14;
		marginLeft += delta * 2;
	} catch { }
	return `${marginLeft}px`;
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
//           粘贴 / 文本处理
// ==========================================

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

// ★ 核心修改：粘贴时强制在暗号后面加一个换行符（eol），确保图片挂在下一行
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
	if (isImageOrVideo) {
		// ★ 强制加一个换行符，确保下一行为空，用于挂载装饰
		insertion += eol;
		insertion += eol.repeat(17); // 总18行：1换行 + 17空白
	}
	return insertion;
}

function handleReqlt(reqlt) {
	if (reqlt.error) { vscode.window.showErrorMessage(reqlt.error); return; }
	const ed = vscode.window.activeTextEditor;
	if (!ed) return;
	const onDone = () => setTimeout(() => renderIkges(ed), 100);

	if (reqlt.type === "folder_text") {
		ed.edit(e => e.insert(ed.selection.active, reqlt.text));
	} else if (reqlt.type === "text") {
		ed.edit(e => e.insert(ed.selection.active, reqlt.text)).then(onDone);
	} else if (reqlt.type === "ikge" || (reqlt.type === "file" && reqlt.files.length === 1)) {
		const f = reqlt.path || reqlt.files[0];
		const isVid = isImageOrVideoExt(path.extname(f));
		const ins = buildInsertionTextForMarker(ed, ed.selection.active, `/${f}/`, isVid);
		ed.edit(e => e.insert(ed.selection.active, ins)).then(() => {
			invalidateFolderSizeCacheForPath(f);
			onDone();
		});
	} else if (reqlt.type === "file" && reqlt.files.length > 1) {
		const eol = getDocumentEOL(ed.document);
		const first = `/${reqlt.files[0]}/`;
		let text = eol + first;
		for (let i = 1; i < reqlt.files.length; i++) text += eol + `/${reqlt.files[i]}/`;
		ed.edit(e => e.insert(ed.selection.active, text)).then(() => {
			reqlt.files.forEach(f => invalidateFolderSizeCacheForPath(f));
			onDone();
		});
		vscode.window.showInformationMessage("文件已复制 " + reqlt.files.length);
	} else if (reqlt.type === "binary") {
		vscode.window.showInformationMessage("二进制已保存");
	} else if (reqlt.type === "cancelled") {
		vscode.window.showInformationMessage("粘贴已取消");
	}
}

// ==========================================
//  ★★★ 方案 B：0 长度 range + before + CSS背景 ★★★
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
			isWholeLine: false  // 不是整行，我们精确控制
		});
	}

	const docUri = editor.document.uri.toString();
	if (!documentDecorationsMap.has(docUri)) {
		documentDecorationsMap.set(docUri, new Map());
	}
	const currentDocDecos = documentDecorationsMap.get(docUri);

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

			// ★ 核心：定位到暗号的下一行（由于加了换行符），用0长度range锚定行首
			const targetLine = pos.line + 1;
			if (targetLine >= editor.document.lineCount) continue;
			const anchorRange = new vscode.Range(targetLine, 0, targetLine, 0);

			// ★ 一行只认第一个暗号
			const lineNum = targetLine;
			if (currentDocDecos.has(lineNum)) continue;

			const rawPath = match[0].slice(1, -1);
			const absPath = rawPath.replace(/\//g, "\\");
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const ext = path.extname(absPath).toLowerCase();
			const isImage = isImageExt(ext);
			const isVideo = isVideoExt(ext);
			const isGif = ext === ".gif";

			if (!isImage && !isVideo) continue;

			const task = async () => {
				if (currentRenderVersion !== myRenderVersion) return null;

				try {
					let previewBuffer = null;
					if (ffmpegPath) {
						previewBuffer = await getPreviewBuffer(absPath, isVideo, isGif);
					}

					const deco = { range: anchorRange, renderOptions: {} };

					// ★★★ 方案 B 核心：before 挂载在0长度range上，使用absolute定位 ★★★
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

					if (previewBuffer) {
						const mime = extremePerformanceMode ? "image/jpeg" : (isGif ? "image/gif" : "image/png");
						const b64 = previewBuffer.toString("base64");
						deco.renderOptions.before = {
							contentText: "",
							...baseStyle,
							textDecoration: `none;
								display: inline-block;
								background-image: url("data:${mime};base64,${b64}");
								background-size: contain;
								background-repeat: no-repeat;
								background-position: center;`
						};
						return { key: lineNum, deco };
					} else if (isImage) {
						// 无 FFmpeg 时的降级：直接用文件路径
						const fileUri = vscode.Uri.file(absPath);
						deco.renderOptions.before = {
							contentIconPath: fileUri,
							...baseStyle
						};
						return { key: lineNum, deco };
					}
					return null;
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
	updateGlobalCodeLensColor(isActive);
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

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const rawPath = match[0].slice(1, -1);
			const absPath = rawPath.replace(/\//g, "\\");
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const folder = path.dirname(absPath);
			let fSize = folderSizeMap.get(folder);
			if (fSize === undefined) {
				fSize = await getQqqFolderSize(folder);
				folderSizeMap.set(folder, fSize);
			}
			const fSizeStr = formatBytes(fSize);

			let fileSz = "?";
			let tooltipText = "";
			try {
				const st = fs.statSync(absPath);
				fileSz = formatBytes(st.size);
				const bTime = new Date(st.birthtime).toLocaleString();
				const mTime = new Date(st.mtime).toLocaleString();
				tooltipText = `创建: ${bTime}\n修改: ${mTime}`;
			} catch { }

			const r = new vscode.Range(pos, pos);

			lenses.push(
				new vscode.CodeLens(r, { title: `✎( ${fSizeStr}) 🗀qqq`, command: "qqq.revealFileInFolder", arguments: [absPath] }),
				new vscode.CodeLens(r, { title: "✎rename", command: "qqq.renameFile", arguments: [rawPath, absPath] }),
				new vscode.CodeLens(r, {
					title: `✎( ${fileSz})   ${absPath}`,
					command: "qqq.openFile",
					arguments: [absPath],
					tooltip: tooltipText
				})
			);
			lensLines.add(pos.line);
		}
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
//           激活与销毁
// ==========================================

function debounceRender(editor, delay = SCROLL_DEBOUNCE_MS) {
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

async function activate(context) {
	extensionContext = context;

	isCoreIntegretyValid = verifySystemIntegrity();
	console.log(`[QQQ] Integrity: ${isCoreIntegretyValid ? "PASSED" : "FAILED"}`);

	if (!isCoreIntegretyValid) return;

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
		vscode.window.onDidChangeActiveTextEditor(e => {
			if (e) debounceRender(e);
			updateCodeLensColorForEditor(e);
		}),
		vscode.workspace.onDidChangeTextDocument(e => {
			const ed = vscode.window.activeTextEditor;
			if (ed && e.document === ed.document) debounceRender(ed);
			// ★ 文档变动时清空该文档的装饰缓存，触发重算
			if (e.document === ed?.document && e.contentChanges.length > 0) {
				documentDecorationsMap.delete(e.document.uri.toString());
			}
		}),
		vscode.workspace.onDidCloseTextDocument(doc => {
			documentDecorationsMap.delete(doc.uri.toString());
		}),
		vscode.window.onDidChangeVisibleTextEditors(renderVisibleEditors),
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

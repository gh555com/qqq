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

// ★★★ 修改：时长格式化，大于等于60秒显示分钟 ★★★
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
//           身份识别模块 (Identity Module)
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
			const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);

			let info = {
				mtime: mtimeMs,
				res: null,
				width: null,
				height: null,
				codec: null,
				duration: 0,
				type: "unknown"
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

			if (durMatch) {
				const hours = parseFloat(durMatch[1]);
				const mins = parseFloat(durMatch[2]);
				const secs = parseFloat(durMatch[3]);
				info.duration = hours * 3600 + mins * 60 + secs;
			}

			const ext = path.extname(filePath);
			info.type = determineMediaType(info.codec, ext);

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
//           GIF 时长解析 (从 Buffer 提取)
// ==========================================

function getGifDurationFromBuffer(buffer) {
	if (!buffer || buffer.length < 13) return 0;

	try {
		let totalDelayCs = 0;
		let i = 0;

		const sig = buffer.slice(0, 6).toString('ascii');
		if (sig !== 'GIF87a' && sig !== 'GIF89a') return 0;

		i = 13;

		const flags = buffer[10];
		const hasGCT = (flags & 0x80) !== 0;
		if (hasGCT) {
			const gctSize = 3 * Math.pow(2, (flags & 0x07) + 1);
			i += gctSize;
		}

		while (i < buffer.length - 1) {
			const blockType = buffer[i];

			if (blockType === 0x21) {
				const extLabel = buffer[i + 1];

				if (extLabel === 0xF9) {
					if (i + 6 < buffer.length) {
						const delayLow = buffer[i + 4];
						const delayHigh = buffer[i + 5];
						const delay = delayLow | (delayHigh << 8);
						totalDelayCs += delay;
					}
					i += 8;
				} else if (extLabel === 0xFF) {
					i += 2;
					const blockSize = buffer[i];
					i += blockSize + 1;
					while (i < buffer.length && buffer[i] !== 0) {
						i += buffer[i] + 1;
					}
					i++;
				} else if (extLabel === 0xFE) {
					i += 2;
					while (i < buffer.length && buffer[i] !== 0) {
						i += buffer[i] + 1;
					}
					i++;
				} else if (extLabel === 0x01) {
					i += 2;
					const blockSize = buffer[i];
					i += blockSize + 1;
					while (i < buffer.length && buffer[i] !== 0) {
						i += buffer[i] + 1;
					}
					i++;
				} else {
					i += 2;
					while (i < buffer.length && buffer[i] !== 0) {
						i += buffer[i] + 1;
					}
					i++;
				}
			} else if (blockType === 0x2C) {
				if (i + 10 > buffer.length) break;

				const imgFlags = buffer[i + 9];
				const hasLCT = (imgFlags & 0x80) !== 0;

				i += 10;

				if (hasLCT) {
					const lctSize = 3 * Math.pow(2, (imgFlags & 0x07) + 1);
					i += lctSize;
				}

				i++;

				while (i < buffer.length && buffer[i] !== 0) {
					i += buffer[i] + 1;
				}
				i++;

			} else if (blockType === 0x3B) {
				break;
			} else {
				i++;
			}
		}

		return totalDelayCs / 100;

	} catch (e) {
		return 0;
	}
}

// ==========================================
//           FFmpeg 预览 (getPreviewBuffer)
// ==========================================

function setPreviewCache(filePath, buffer, mtimeMs, gifDuration) {
	if (previewCache.size >= MAX_PREVIEW_CACHE) {
		const firstKey = previewCache.keys().next().value;
		if (firstKey !== undefined) previewCache.delete(firstKey);
	}
	previewCache.set(filePath, { buffer, mtimeMs, gifDuration });
}

// ★★★ 核心：计算视频截取后的预期 GIF 时长 ★★★
function calculateExpectedVideoDuration(origDuration, isExtremeMode) {
	if (isExtremeMode) {
		// 极限模式：从第1秒开始截取2秒
		return 2.0;
	} else {
		if (origDuration < 5) {
			// 短视频：从第1秒开始截取最多4秒
			const available = Math.max(0, origDuration - 1);
			return Math.min(4.0, available > 0 ? available : 4.0);
		} else {
			// 长视频：三段各1.3秒 = 3.9秒
			return 3.9;
		}
	}
}

function buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize, duration) {
	const stretch = stretchSmallImages;
	let targetW = PREVIEW_WIDTH;
	let targetH = PREVIEW_HEIGHT;

	if (!stretch) {
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

	const args = ["-hide_banner", "-loglevel", "error"];

	if (isVideo) {
		// ★★★ 视频处理：必须截取并转为 GIF ★★★
		let filterComplex = "";
		let fpsLimit = "fps=10";
		if (extremePerformanceMode) fpsLimit = "fps=8";

		const scaleFlags = extremePerformanceMode ? "neighbor" : "bilinear";

		let baseChain = "";

		if (extremePerformanceMode) {
			// 极限模式：截取2秒
			args.push("-ss", "1", "-t", "2", "-i", filePath);
			baseChain = `[0:v]${fpsLimit}`;
		} else {
			const safeDuration = duration || 0;
			if (safeDuration < 5) {
				// 短视频：截取4秒
				args.push("-ss", "1", "-t", "4", "-i", filePath);
				baseChain = `[0:v]${fpsLimit}`;
			} else {
				// 长视频：智能三段采样
				args.push("-i", filePath);
				const segmentLen = 1.3;
				const start1 = 1.0;
				const start2 = safeDuration / 2.0;
				const start3 = Math.max(start1 + segmentLen + 0.1, safeDuration - segmentLen - 1.0);
				const selectExpr = `between(t,${start1},${start1 + segmentLen})+between(t,${start2},${start2 + segmentLen})+between(t,${start3},${start3 + segmentLen})`;
				baseChain = `[0:v]select='${selectExpr}',setpts=N/FRAME_RATE/TB,${fpsLimit}`;
			}
		}

		const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=${scaleFlags}`;

		if (extremePerformanceMode) {
			filterComplex = `${baseChain},${scaleFilter}[out_v]`;
		} else {
			filterComplex = `${baseChain},${scaleFilter},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[out_v]`;
		}

		args.push("-filter_complex", filterComplex);
		args.push("-map", "[out_v]");
		// ★★★ 修复：确保 GIF 循环 ★★★
		args.push("-loop", "0", "-an", "-sn", "-f", "gif", "pipe:1");

	} else if (isGif) {
		// ★★★ 原生 GIF：保留原汁原味，只做缩放 ★★★
		args.push("-i", filePath);

		const scaleFlags = extremePerformanceMode ? "neighbor" : "bilinear";
		const scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=${scaleFlags}`;

		let filterComplex = "";
		if (extremePerformanceMode) {
			// 极限模式：截取前2秒
			filterComplex = `[0:v]fps=8,${scaleFilter}[out_v]`;
			args.length = 3; // 重置
			args.push("-t", "2", "-i", filePath);
			args.push("-filter_complex", filterComplex);
		} else {
			// 普通模式：保留原帧率和时长
			filterComplex = `[0:v]${scaleFilter}[out_v]`;
			args.push("-filter_complex", filterComplex);
		}

		args.push("-map", "[out_v]");
		args.push("-loop", "0", "-an", "-sn", "-f", "gif", "pipe:1");

	} else {
		// ★★★ 静态图片 ★★★
		args.push("-i", filePath);

		let scaleFlags = extremePerformanceMode ? "neighbor" : "bilinear";
		let scaleFilter = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=${scaleFlags}`;

		const fc = `[0:v]${scaleFilter}[out_v]`;
		args.push("-filter_complex", fc);
		args.push("-map", "[out_v]");

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
	let duration = 0;
	let mtimeMs = 0;
	try {
		const st = fs.statSync(filePath);
		mtimeMs = st.mtimeMs;
	} catch { return null; }

	// 获取媒体信息
	const info = await getMediaInfo(filePath, mtimeMs);
	if (info) {
		origSize = { width: info.width, height: info.height };
		duration = info.duration;
	}

	// 检查缓存
	if (extremePerformanceMode) {
		const cached = previewCache.get(filePath);
		if (cached) return { buffer: cached.buffer, gifDuration: cached.gifDuration };
	} else {
		const cached = previewCache.get(filePath);
		if (cached && cached.mtimeMs === mtimeMs) return { buffer: cached.buffer, gifDuration: cached.gifDuration };
	}

	const ok = await ensureFfmpegAvailable();
	if (!ok) return null;

	return new Promise((resolve) => {
		const args = buildFfmpegPreviewArgs(filePath, isVideo, isGif, origSize, duration);
		const child = cp.spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		const chunks = [];
		let resolved = false;

		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				try { child.kill(); } catch { }
				resolve(null);
			}
		}, 20000);

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

				let gifDuration = 0;

				if (isVideo) {
					// ★★★ 视频：使用预期计算的时长，而非解析 buffer ★★★
					gifDuration = calculateExpectedVideoDuration(duration, extremePerformanceMode);
				} else if (isGif) {
					// ★★★ 原生 GIF：从 buffer 解析实际时长 ★★★
					gifDuration = getGifDurationFromBuffer(buffer);
					// 极限模式下 GIF 被截取为2秒
					if (extremePerformanceMode && gifDuration > 2.5) {
						gifDuration = 2.0;
					}
				}

				setPreviewCache(filePath, buffer, mtimeMs, gifDuration);
				resolve({ buffer, gifDuration });
			}
		});
	});
}

// ==========================================
//           工具函数
// ==========================================

function computeMarginLeft() { return "100px"; }

// ★★★ 修改：宽高比格式 16__9.1 ★★★
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

function createProgressSvg(durationSeconds) {
	if (!durationSeconds || durationSeconds <= 0) return null;
	const barColor = "#fdf6e3";
	const bgColor = "black";
	const svgStr = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="4" viewBox="0 0 512 4">
  <rect width="512" height="4" fill="${bgColor}" />
  <rect width="0" height="4" fill="${barColor}">
    <animate attributeName="width" from="0" to="512" dur="${durationSeconds.toFixed(3)}s" repeatCount="indefinite" fill="freeze" calcMode="linear" />
  </rect>
</svg>`.trim();
	return "data:image/svg+xml;base64," + Buffer.from(svgStr).toString("base64");
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
				if (res && res.qccess) {
					resolve({
						size: res.total_size,
						extStats: res.ext_stats,
						fileCount: res.file_count_root
					});
				} else {
					resolve(null);
				}
			} catch { resolve(null); }
		});
	});
}

// ★★★ 修改：文件统计格式 "18个文件：3_png; 11_jpg; 4_mp4; 1_; 3_null" ★★★
async function getQqqFolderSize(folderPath) {
	const now = Date.now();
	const cached = qqqFolderSizeCache.get(folderPath);

	if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) {
		return cached.data;
	}

	const data = await calculateFolderSizeWithPython(folderPath);
	if (data) {
		const parts = [];
		let totalFiles = 0;
		if (data.extStats) {
			for (const [ext, count] of Object.entries(data.extStats)) {
				totalFiles += count;
				// ★★★ 格式：count_ext，无后缀时为 count_ ★★★
				parts.push(`${count}_${ext}`);
			}
		}

		// ★★★ 用 "; " 分隔 ★★★
		const summaryStr = parts.length > 0
			? `${totalFiles}个文件：${parts.join("; ")}`
			: (data.fileCount > 0 ? `${data.fileCount}个文件`
				: "空文件夹");

		const cachedData = {
			size: data.size,
			summary: summaryStr
		};

		qqqFolderSizeCache.set(folderPath, { data: cachedData, timestamp: now });
		return cachedData;
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

			if (currentDocDecos.has(uniqueKey)) continue;

			const rawPath = match[0].slice(1, -1);
			const absPath = rawPath.replace(/\//g, "\\");

			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) continue;

			const ext = path.extname(absPath).toLowerCase();
			let isImage = isImageExt(ext);
			let isVideo = isVideoExt(ext);
			let isGif = ext === ".gif";

			let mtimeMs = 0;
			try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }

			let mediaInfo = null;

			if (!isImage && !isVideo) {
				mediaInfo = await getMediaInfo(absPath, mtimeMs);
				if (mediaInfo && mediaInfo.type === "video") {
					isVideo = true;
				} else if (mediaInfo && mediaInfo.type === "image") {
					isImage = true;
					if (mediaInfo.codec === "gif") isGif = true;
				} else {
					continue;
				}
			}

			const targetLine = pos.line + 1;
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

					let contentUrl = "";
					let actualGifDuration = 0;

					if (previewResult && previewResult.buffer) {
						let mime = "image/png";
						if (isGif || isVideo) mime = "image/gif";
						else if (extremePerformanceMode) mime = "image/jpeg";

						const b64 = previewResult.buffer.toString("base64");
						contentUrl = `url("data:${mime};base64,${b64}")`;

						if (previewResult.gifDuration && previewResult.gifDuration > 0) {
							actualGifDuration = previewResult.gifDuration;
						}
					} else if (isImage && !isVideo && !isGif) {
						const fileUri = vscode.Uri.file(absPath);
						contentUrl = `url("${fileUri.toString()}")`;
					}

					if (!contentUrl) return null;

					let progressBarUrl = null;

					if ((isGif || isVideo) && actualGifDuration > 0) {
						progressBarUrl = `url("${createProgressSvg(actualGifDuration)}")`;
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
						sizes.push("512px 4px");
						positions.push("center bottom");
						repeats.push("no-repeat");
					}

					layers.push(contentUrl);
					sizes.push("contain");
					positions.push("center center");
					repeats.push("no-repeat");

					layers.push(gridImage);
					sizes.push(gridSize);
					positions.push("0 0");
					repeats.push("repeat");

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
						textDecoration: `none;
                            display: inline-block;
                            background-image: ${layers.join(", ")};
                            background-size: ${sizes.join(", ")};
                            background-position: ${positions.join(", ")};
                            background-repeat: ${repeats.join(", ")};`
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
	updateGlobalCodeLensColor(isActive);
}

class FileCodeLensProvider {
	async provideCodeLenses(document) {
		if (!isCoreIntegretyValid) return [];

		const lenses = [];
		const regex = /\/[a-z]:[^\/]*?qqq[^\/]*?\//gi;
		const text = document.getText();
		let match;
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
				let folderData = await getQqqFolderSize(folder);

				const fSize = folderData ? folderData.size : 0;
				const fSizeStr = formatBytes(fSize);
				const folderTooltip = folderData ? folderData.summary : undefined;

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
				let isRealVideo = false;

				if (isVidOrImg) {
					const info = await getMediaInfo(absPath, mtimeMs);
					if (info && info.width && info.height) {
						let scale = 1;
						const MAX_W = PREVIEW_WIDTH;
						const MAX_H = PREVIEW_HEIGHT;

						if (info.type === "video") isRealVideo = true;

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

						// ★★★ 修改：宽高比格式 16__9.1 ★★★
						const arStr = calculateAspectRatioString(info.width, info.height);
						if (arStr) {
							tooltipText += `\n宽高比：${arStr}`;
						}

						// ★★★ 修改：时长格式 "⌛原始时长：53m + 11.11s" ★★★
						if (info.duration > 0) {
							tooltipText += `\n⌛原始时长：${formatDuration(info.duration)}`;
						}
					}
				}

				const iconPart = isRealVideo ? "🎬" : "";
				const spacePart = isRealVideo ? " " : "   ";

				const r = new vscode.Range(pos, pos);
				return [
					new vscode.CodeLens(r, {
						title: `✎( ${fSizeStr}) 🗀qqq`,
						command: "qqq.revealFileInFolder",
						arguments: [absPath],
						tooltip: folderTooltip
					}),
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


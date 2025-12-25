// src/qqq.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const readline = require("readline");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const sizeOf = require("image-size");

const q3 = require("./q3");
const global = require("./global");
const cheerio = require("cheerio");

// ★ 引用从 global.js 迁移过来的核心对象，保持本地引用名不变以兼容旧逻辑
const {
	pythonBridge,
	rustBridge,
	shellBridge,
	startDaemons,
	updateStatusBarNow,
	pasteQueue,
	metaSaveQueue
} = global;

// ============================================================================
// ★ 全局唯一真理来源：路径暗号 + 捕获组（match[1] 就是内部路径）
// ============================================================================
function createPathRegex() {
	return /\/\\\s*([\s\S]*?)\s*\\\//gi;
}

const CACHE_DIR_NAME = "qqq_cache";
const META_FILE_NAME = "meta.json";
const CACHE_MAX_SIZE = 40 * 1024 * 1024;
const CACHE_TARGET_SIZE = 28 * 1024 * 1024;
const PASTE_SIZE_THRESHOLD = 80 * 1024 * 1024;

const FINGERPRINT_HEAD = 128;
const FINGERPRINT_MID = 128;
const FINGERPRINT_TAIL = 128;

const IMAGE_EXTS_FOR_CLIPBOARD = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif",
]);

let ffmpegPath = null;
let ffprobePath = null;
try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
	ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"));
} catch (e) { }

let extensionContext = null;
let cacheDir = null;
let cacheMeta = null;
let _statusBarTimer = null;

// ============================================================================
// ★ 3) probe / gen 双 scheduler：已迁移至 global.js
// ============================================================================
// (TaskScheduler logic moved to global.js)


// ============================================================================
// ★ 4) 缓存 meta 只读快照
// ============================================================================
function getCacheStatsSnapshot() {
	const s = cacheMeta?.stats || { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };
	return {
		totalSize: s.totalSize || 0,
		fileCount: s.fileCount || 0,
		hitCount: s.hitCount || 0,
		missCount: s.missCount || 0,
	};
}

// updateStatusBarNow moved to global.js

// ============================================================================
// ★★★ 统一路径真理来源（给 q2/q1/未来模块用）
// ============================================================================
function _stripDocJunk(s) {
	if (s == null) return "";
	return String(s).trim().replace(/\r/g, "").replace(/\n/g, "");
}

function _getSystemDriveRoot() {
	const sd = process.env.SystemDrive;
	if (sd && /^[A-Za-z]:$/.test(sd)) return sd.toUpperCase() + "\\";
	const up = process.env.USERPROFILE;
	if (up && /^[A-Za-z]:[\\/]/.test(up)) return up.slice(0, 2).toUpperCase() + "\\";
	return "C:\\";
}

function toSafePath(p) {
	if (!p) return "";
	return p.startsWith("\\\\")
		? "\\\\" + p.slice(2).replace(/\\/g, "/")
		: p.replace(/\\/g, "/");
}

function normalizeNavPath(rawPath) {
	let clean = _stripDocJunk(rawPath);
	if (!clean) return "";

	if (clean === "~") clean = os.homedir();
	else if (clean.startsWith("~/") || clean.startsWith("~\\")) {
		clean = path.join(os.homedir(), clean.slice(2));
	}

	const isWin = process.platform === "win32";
	if (!isWin) return path.normalize(clean);

	if (/^[A-Za-z]:$/.test(clean)) return clean.toUpperCase() + "\\";
	if (/^[A-Za-z]:[\\/]*$/.test(clean)) return clean[0].toUpperCase() + ":\\";

	if (clean.startsWith("\\\\") || clean.startsWith("//")) return path.normalize(clean);

	if (/^[A-Za-z]:[\\/]/.test(clean)) {
		const normalized = path.normalize(clean);
		return normalized.replace(/^[a-z]:/, (m) => m.toUpperCase());
	}

	if (clean.startsWith("\\") || clean.startsWith("/")) {
		const sysRoot = _getSystemDriveRoot();
		const rest = clean.replace(/^[\\/]+/, "");
		return path.normalize(path.join(sysRoot, rest));
	}

	return path.normalize(clean);
}

function resolveNavPath(rawPath, baseDir) {
	const clean = normalizeNavPath(rawPath);
	if (!clean) return "";
	if (path.isAbsolute(clean)) return clean;
	const base = baseDir && typeof baseDir === "string" ? baseDir : process.cwd();
	return path.resolve(base, clean);
}

function canonicalizeExistingPath(p) {
	if (!p) return "";
	let out = String(p);

	try {
		if (fs.existsSync(out)) {
			if (fs.realpathSync && fs.realpathSync.native) out = fs.realpathSync.native(out);
			else out = fs.realpathSync(out);
		}
	} catch { }

	out = path.normalize(out);

	if (process.platform === "win32") {
		// ★ 修复 Windows 长路径前缀问题
		// fs.realpathSync.native 返回的路径可能包含 \\?\ 前缀，这会导致 startsWith 比较失败
		out = out.replace(/^\\\\\?\\/, "");
		out = out.replace(/^[a-z]:/, (m) => m.toUpperCase());
	}

	try {
		const root = path.parse(out).root;
		if (out.length > root.length) out = out.replace(/[\\/]+$/, "");
	} catch { }

	return out;
}

function cacheKeyForPath(p) {
	const canon = canonicalizeExistingPath(p);
	return process.platform === "win32" ? canon.toLowerCase() : canon;
}

function _nodeModeFromShellAvail() {
	// D = daemon, S = spawn
	return shellBridge?.isAvailable?.() === true ? "D" : "S";
}

// ---------- task queue ----------
// (TaskQueue logic moved to global.js)


// ---------- fingerprint ----------
const _fingerprintCache = new Map();
const _fingerprintDb = new Map();

function prefillFingerprint(filePath, fingerprint) {
	try {
		const stat = fs.statSync(filePath);
		const key = cacheKeyForPath(filePath);
		_fingerprintCache.set(key, {
			mtime: stat.mtimeMs,
			size: stat.size,
			fp: fingerprint
		});
		// 同时记录到反向查找表
		_fingerprintDb.set(fingerprint, filePath);
	} catch (e) { }
}

function findFileByFingerprint(fingerprint) {
	return _fingerprintDb.get(fingerprint);
}

function computeFingerprint(filePath) {
	try {
		const stat = fs.statSync(filePath);
		const size = stat.size;
		const mtime = stat.mtimeMs;
		const key = cacheKeyForPath(filePath);

		// 缓存检查
		const cached = _fingerprintCache.get(key);
		if (cached && cached.mtime === mtime && cached.size === size) {
			return cached.fp;
		}

		if (size === 0) return crypto.createHash("md5").update("empty:0").digest("hex");

		const fd = fs.openSync(filePath, "r");
		const chunks = [];

		const sizeBuf = Buffer.alloc(8);
		sizeBuf.writeBigUInt64LE(BigInt(size));
		chunks.push(sizeBuf);

		try {
			if (size <= FINGERPRINT_HEAD) {
				const buf = Buffer.alloc(size);
				fs.readSync(fd, buf, 0, size, 0);
				chunks.push(buf);
			} else if (size <= FINGERPRINT_HEAD + FINGERPRINT_TAIL) {
				const head = Buffer.alloc(FINGERPRINT_HEAD);
				fs.readSync(fd, head, 0, FINGERPRINT_HEAD, 0);
				chunks.push(head);

				const tailSize = Math.min(FINGERPRINT_TAIL, size - FINGERPRINT_HEAD);
				const tail = Buffer.alloc(tailSize);
				fs.readSync(fd, tail, 0, tailSize, size - tailSize);
				chunks.push(tail);
			} else {
				const head = Buffer.alloc(FINGERPRINT_HEAD);
				fs.readSync(fd, head, 0, FINGERPRINT_HEAD, 0);
				chunks.push(head);

				const midPos = Math.floor(size / 2) - Math.floor(FINGERPRINT_MID / 2);
				const mid = Buffer.alloc(FINGERPRINT_MID);
				fs.readSync(fd, mid, 0, FINGERPRINT_MID, midPos);
				chunks.push(mid);

				const tail = Buffer.alloc(FINGERPRINT_TAIL);
				fs.readSync(fd, tail, 0, FINGERPRINT_TAIL, size - FINGERPRINT_TAIL);
				chunks.push(tail);
			}
		} finally {
			fs.closeSync(fd);
		}

		const fp = crypto.createHash("md5").update(Buffer.concat(chunks)).digest("hex");

		// 写入缓存
		_fingerprintCache.set(key, { mtime, size, fp });
		// 简单的缓存清理策略：超过 2000 个条目清空一半（虽然不太可能达到）
		if (_fingerprintCache.size > 2000) _fingerprintCache.clear();

		return fp;
	} catch (e) {
		return null;
	}
}

// ---------- cache ----------
function initCache(context) {
	cacheDir = path.join(context.globalStorageUri.fsPath, CACHE_DIR_NAME);
	if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
	loadCacheMeta();
	validateCache();
}

function createEmptyMeta() {
	return {
		entries: {},
		stats: { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 },
		brokenFiles: {},
	};
}

function loadCacheMeta() {
	const metaPath = path.join(cacheDir, META_FILE_NAME);
	try {
		if (fs.existsSync(metaPath)) {
			cacheMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			if (!cacheMeta.entries) cacheMeta.entries = {};
			if (!cacheMeta.stats) cacheMeta.stats = { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };
			if (!cacheMeta.brokenFiles) cacheMeta.brokenFiles = {};
		} else {
			cacheMeta = createEmptyMeta();
		}
	} catch (e) {
		cacheMeta = createEmptyMeta();
	}
}

function saveCacheMeta() {
	if (!cacheDir || !cacheMeta) return;

	// ★ 异步序列化写入，解决 Race Condition
	metaSaveQueue.enqueue(async () => {
		try {
			const data = JSON.stringify(cacheMeta, null, 2);
			const metaPath = path.join(cacheDir, META_FILE_NAME);
			await fs.promises.writeFile(metaPath, data, "utf-8");
		} catch (e) {
			global.logMessage("Meta save failed: " + e.message, "ERROR");
		}
	});
}

function validateCache() {
	if (!cacheDir || !cacheMeta) return;

	let changed = false;
	let realSize = 0;
	let realCount = 0;
	const actualFiles = new Set();

	try {
		const files = fs.readdirSync(cacheDir);
		for (const f of files) {
			if (f !== META_FILE_NAME) actualFiles.add(f);
		}
	} catch (e) { }

	for (const [contentId, entry] of Object.entries(cacheMeta.entries)) {
		if (!entry || typeof entry !== "object") {
			delete cacheMeta.entries[contentId];
			changed = true;
			continue;
		}
		if (!entry.qualities || typeof entry.qualities !== "object") entry.qualities = {};

		for (const [q, qInfo] of Object.entries(entry.qualities)) {
			if (!qInfo) {
				delete entry.qualities[q];
				changed = true;
				continue;
			}

			const fileName = `${contentId}.${q}`;
			const filePath = path.join(cacheDir, fileName);

			if (!actualFiles.has(fileName)) {
				delete entry.qualities[q];
				changed = true;
			} else {
				actualFiles.delete(fileName);
				try {
					const st = fs.statSync(filePath);
					realSize += st.size;
					realCount++;
				} catch (e) {
					delete entry.qualities[q];
					changed = true;
				}
			}
		}

		if (Object.keys(entry.qualities).length === 0) {
			delete cacheMeta.entries[contentId];
			changed = true;
		}
	}

	for (const orphan of actualFiles) {
		try {
			fs.unlinkSync(path.join(cacheDir, orphan));
			changed = true;
		} catch (e) { }
	}

	cacheMeta.stats.totalSize = realSize;
	cacheMeta.stats.fileCount = realCount;

	if (changed) saveCacheMeta();
}

function ensureCacheSpace(neededBytes) {
	if (!cacheDir || !cacheMeta) return;
	if (cacheMeta.stats.totalSize + neededBytes <= CACHE_MAX_SIZE) return;

	const entries = Object.entries(cacheMeta.entries)
		.map(([contentId, entry]) => ({ contentId, atime: entry?.atime || 0 }))
		.sort((a, b) => a.atime - b.atime);

	while (cacheMeta.stats.totalSize + neededBytes > CACHE_TARGET_SIZE && entries.length > 0) {
		const oldest = entries.shift();
		evictEntry(oldest.contentId);
	}
}

function evictEntry(contentId) {
	const entry = cacheMeta.entries[contentId];
	if (!entry?.qualities) return;

	for (const q of Object.keys(entry.qualities)) {
		const fileName = `${contentId}.${q}`;
		try {
			const filePath = path.join(cacheDir, fileName);
			const st = fs.statSync(filePath);
			cacheMeta.stats.totalSize -= st.size;
			cacheMeta.stats.fileCount--;
			fs.unlinkSync(filePath);
		} catch (e) { }
	}

	delete cacheMeta.entries[contentId];
	saveCacheMeta();
}

function getCacheEntry(contentId) {
	if (!cacheMeta?.entries?.[contentId]) {
		cacheMeta.stats.missCount++;
		return null;
	}
	const entry = cacheMeta.entries[contentId];
	entry.atime = Date.now();
	cacheMeta.stats.hitCount++;
	return entry;
}

function getCacheQualityMeta(contentId, quality) {
	const entry = cacheMeta?.entries?.[contentId];
	const qInfo = entry?.qualities?.[quality];
	return qInfo?.meta || null;
}

function setCacheEntry(contentId, quality, buffer, meta) {
	if (!cacheDir || !cacheMeta) return null;

	if (!cacheMeta.entries[contentId]) {
		cacheMeta.entries[contentId] = { qualities: {}, atime: Date.now(), meta: {} };
	}
	const entry = cacheMeta.entries[contentId];
	if (!entry.qualities) entry.qualities = {};

	const prev = entry.qualities[quality];
	const prevSize = prev?.size || 0;
	const delta = Math.max(0, buffer.length - prevSize);

	ensureCacheSpace(delta);

	const fileName = `${contentId}.${quality}`;
	const filePath = path.join(cacheDir, fileName);

	try {
		const tmpPath = filePath + ".tmp";
		fs.writeFileSync(tmpPath, buffer);
		fs.renameSync(tmpPath, filePath);
	} catch (e) {
		try {
			fs.unlinkSync(filePath + ".tmp");
		} catch { }
		return null;
	}

	entry.qualities[quality] = { size: buffer.length, format: "webp_unified", meta: {} };
	entry.atime = Date.now();
	if (meta) Object.assign(entry.qualities[quality].meta, meta);

	if (!prev) cacheMeta.stats.fileCount++;
	cacheMeta.stats.totalSize = cacheMeta.stats.totalSize - prevSize + buffer.length;

	saveCacheMeta();
	updateStatusBarNow();

	return filePath;
}

function getCachedBuffer(contentId, quality) {
	if (!cacheDir || !cacheMeta) return null;

	const entry = cacheMeta.entries[contentId];
	if (!entry?.qualities?.[quality]) {
		cacheMeta.stats.missCount++;
		global.markCacheMiss();
		updateStatusBarNow();
		return null;
	}

	const fileName = `${contentId}.${quality}`;
	const filePath = path.join(cacheDir, fileName);

	try {
		if (fs.existsSync(filePath)) {
			entry.atime = Date.now();
			cacheMeta.stats.hitCount++;
			global.markCacheHit();
			updateStatusBarNow();
			return fs.readFileSync(filePath);
		}
	} catch (e) { }

	cacheMeta.stats.missCount++;
	global.markCacheMiss();

	delete entry.qualities[quality];
	if (Object.keys(entry.qualities).length === 0) {
		delete cacheMeta.entries[contentId];
	}
	saveCacheMeta();

	updateStatusBarNow();

	return null;
}

function _cleanReason(s) {
	if (!s) return "";
	return String(s).trim().replace(/\r/g, "").replace(/\n/g, " | ").slice(0, 300);
}

// DaemonBridge and instances moved to global.js

// ---------- io ----------
function ensureDir(dirPath) {
	if (!fs.existsSync(dirPath)) {
		try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { }
	}
}

const CLIPBOARD_PEEK_TIMEOUT_MS = 350;
const CLIPBOARD_SLOW_TIMEOUT_MS = 60000;

async function peekClipboardRichFast() {
	const pref = global.getEnginePreference();
	const order = global.getEngineTryOrder(pref);

	const promises = [];

	// 1. ShellBridge: 检查 HTML
	if (shellBridge?.isAvailable && shellBridge.isAvailable()) {
		promises.push((async () => {
			try {
				const hasHtml = await shellBridge.call("hasHtml", {}, 200);
				if (hasHtml?.value) {
					return {
						type: "peek",
						has_html: true,
						priority: 100
					};
				}
			} catch { }
			return null;
		})());
	}

	// 2. PythonBridge: 检查 Files
	if (order.includes("python") && pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
		promises.push((async () => {
			try {
				const res = await pythonBridge.call("clipboard_peek", {}, CLIPBOARD_PEEK_TIMEOUT_MS);
				if (res && !res.error && res.type === "peek") {
					return { ...res, priority: 50 };
				}
			} catch { }
			return null;
		})());
	}

	// 3. Node.js (VS Code API): 检查纯文本中的 HTML 特征
	promises.push((async () => {
		try {
			const text = await vscode.env.clipboard.readText();
			if (text && /<\/?(html|body|div|p|img|picture|source|span|a|ul|li|table|tr|td|h[1-6]|b|i|strong|em|code|pre|blockquote)\b/i.test(text)) {
				return {
					type: "peek",
					has_html: true,
					priority: 80
				};
			}
		} catch { }
		return null;
	})());

	const raceToSuccess = (promises) => {
		return new Promise((resolve) => {
			let failureCount = 0;
			let resolved = false;

			if (promises.length === 0) {
				resolve(null);
				return;
			}

			promises.forEach(p => {
				Promise.resolve(p).then(res => {
					if (resolved) return;
					if (res !== null) {
						resolved = true;
						resolve(res);
					} else {
						failureCount++;
						if (failureCount === promises.length) {
							resolve(null);
						}
					}
				}).catch(() => {
					if (resolved) return;
					failureCount++;
					if (failureCount === promises.length) {
						resolve(null);
					}
				});
			});
		});
	};

	try {
		return await raceToSuccess(promises);
	} catch { }

	return null;
}

async function raceClipboard(targetDir, callback) {
	const qStart = Date.now();
	let qStatus = { hasFile: false, hasHtml: false, hasImage: false, hasText: false };
	let handled = false;

	try {
		// ★ 优化：只要 ShellBridge 没明确挂掉 (available !== false)，就尝试调用
		// 让 call() 内部去处理启动/等待逻辑。如果超时或失败，再走 fallback。
		if (shellBridge && shellBridge.available !== false) {
			const res = await shellBridge.call("checkQ", {}, 500);
			if (res && !res.error) {
				qStatus = res;
				handled = true;
			}
		}
	} catch (e) { }

	// Fallback 1: Spawn Mode (当 Daemon 不可用时，冷启动 PowerShell 获取剪贴板状态)
	if (!handled && process.platform === "win32") {
		try {
			// 使用 PowerShell 单行命令获取 JSON 状态
			const psScript = `Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetDataObject().GetFormats();$o=@{hasFile=$false;hasHtml=$false;hasImage=$false;hasText=$false};if($f -contains 'FileDrop'){$o.hasFile=$true};if($f -contains 'HTML Format'){$o.hasHtml=$true};if(($f -contains 'Bitmap')-or($f -contains 'DeviceIndependentBitmap')-or($f -contains 'PNG')){$o.hasImage=$true};if(($f -contains 'Text')-or($f -contains 'UnicodeText')){$o.hasText=$true};$o|ConvertTo-Json -Compress`;
			const jsonStr = await spawnOutput("powershell", [
				"-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript
			]);
			if (jsonStr && jsonStr.trim()) {
				const parsed = JSON.parse(jsonStr);
				if (parsed) {
					qStatus = parsed;
					handled = true;
					global.logMessage("[Fallback] raceClipboard used Spawn PowerShell", "INFO");

					// ★ 机会：既然 Spawn 成功了，说明 PowerShell 还能用，尝试复活 ShellBridge
					if (shellBridge && !shellBridge.isAvailable() && !shellBridge.isPermDisabled) {
						global.logMessage("[SelfHealing] Spawn 成功，尝试复活 Shell Daemon...", "INFO");
						shellBridge.start().catch(() => { });
					}
				}
			}
		} catch (e) {
			global.logMessage(`[Fallback] raceClipboard Spawn failed: ${e.message}`, "WARN");
		}
	}

	// Fallback 2: VS Code API (最后的兜底，只能识别文本)
	if (!handled) {
		try {
			const text = await vscode.env.clipboard.readText();
			if (text) qStatus.hasText = true;
		} catch (e) { }
	}

	const qDuration = Date.now() - qStart;
	global.logQ(Math.round(qDuration));

	if (qStatus.hasFile) {
		try {
			const res = await handleClipboardSlow(targetDir, qStart, "file");
			if (res) callback(res, 100);
		} catch (e) { }
		return;
	}

	if (qStatus.hasHtml) {
		try {
			const res = await handleClipboardSlow(targetDir, qStart, "html", (partial) => {
				callback(partial, 100);
			});
			if (res) callback(res, 100);
		} catch (e) { }
		return;
	}

	if (qStatus.hasImage) {
		try {
			const res = await handleClipboardSlow(targetDir, qStart, "image");
			if (res) callback(res, 100);
		} catch (e) { }
		return;
	}

	if (qStatus.hasText) {
		try {
			const text = await vscode.env.clipboard.readText();
			if (text) callback({ type: "text", text }, 100);
		} catch (e) { }
		return;
	}
}

async function handleClipboardFast() {
	return null;
}


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

function getPathSize(p) {
	try {
		const stat = fs.statSync(p);
		if (stat.isDirectory()) {
			const files = fs.readdirSync(p);
			return files.reduce((acc, f) => acc + getPathSize(path.join(p, f)), 0);
		}
		return stat.size;
	} catch { return 0; }
}

async function handleClipboardSlow(targetDir, qStart = Date.now(), typeHint = null, partialCallback = null, token = null) {
	return pasteQueue.enqueue(async () => {
		if (token?.isCancellationRequested) return null;

		// ★ 1. HTML: 总是显示进度条 (Complex Paste)
		if (typeHint === "html") {
			return await global.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "qqq: 正在粘贴 HTML...",
				cancellable: true
			}, async (progress, newTok) => {
				newTok.onCancellationRequested(() => {
					global.logMessage("HTML 粘贴被用户取消", "WARN");
				});

				// 适配 progressCallback
				const progCb = (pct, msg) => {
					progress.report({ message: msg, increment: pct });
				};

				return await handleClipboardNode(targetDir, partialCallback, newTok, progCb);
			});
		}

		// ★ 2. File: 超过阈值显示进度条 (Simple Paste)
		if (typeHint === "file") {
			let files = [];

			// 优先尝试获取文件列表 (支持 Python 和 Shell 引擎)
			const pref = global.getEnginePreference();
			const order = global.getEngineTryOrder(pref); // ["python", "rust", "shell", "spawn"]

			for (const engine of order) {
				try {
					if (engine === "python" && pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
						const res = await pythonBridge.call("get_clipboard_files", {}, 2000);
						if (res && res.paths && res.paths.length > 0) {
							files = res.paths;
							break;
						}
					} else if (engine === "shell" && shellBridge?.isAvailable && shellBridge.isAvailable()) {
						const res = await shellBridge.call("getFiles", {}, 2000);
						if (res && res.files && res.files.length > 0) {
							files = res.files;
							break;
						}
					}
				} catch { }
			}

			// 如果没找到，兜底尝试 ShellBridge (因为 shellBridge 可能不在 order 里但可用)
			if (files.length === 0 && shellBridge?.isAvailable && shellBridge.isAvailable()) {
				try {
					const res = await shellBridge.call("getFiles", {}, 2000);
					files = res?.files || [];
				} catch { }
			}

			let totalSize = 0;
			if (files.length > 0) {
				for (const f of files) {
					totalSize += getPathSize(f);
				}
			}

			// 如果总大小超过阈值，或者文件数量特别多(>10)，开启进度条
			if (totalSize > PASTE_SIZE_THRESHOLD || files.length > 10) {
				const sizeStr = formatBytes(totalSize);
				return await global.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: `qqq: 正在粘贴文件 (${sizeStr})...`,
					cancellable: true
				}, async (progress, newTok) => {
					newTok.onCancellationRequested(() => {
						global.logMessage("文件粘贴被用户取消", "WARN");
					});

					const progCb = (pct, msg) => {
						progress.report({ message: msg, increment: pct });
					};

					// 传入 preFetchedFiles (files) 和 totalSize 避免重复计算
					return await handleClipboardShell(targetDir, newTok, progCb, files, totalSize);
				});
			} else {
				// 小文件直接处理
				return await handleClipboardShell(targetDir, token, null, files);
			}
		}

		if (typeHint === "image") {
			return await handleClipboardShell(targetDir, token, partialCallback);
		}

		return null;
	});
}

// ------------------------------------------------------------------------
// ★ 以下是辅助函数
// ------------------------------------------------------------------------

function computeBufferFingerprint(buffer) {
	try {
		const size = buffer.length;
		if (size === 0) return crypto.createHash("md5").update("empty:0").digest("hex");

		const chunks = [];
		const sizeBuf = Buffer.alloc(8);
		sizeBuf.writeBigUInt64LE(BigInt(size));
		chunks.push(sizeBuf);

		if (size <= FINGERPRINT_HEAD) {
			chunks.push(buffer);
		} else if (size <= FINGERPRINT_HEAD + FINGERPRINT_TAIL) {
			chunks.push(buffer.subarray(0, FINGERPRINT_HEAD));
			const tailSize = Math.min(FINGERPRINT_TAIL, size - FINGERPRINT_HEAD);
			chunks.push(buffer.subarray(size - tailSize));
		} else {
			chunks.push(buffer.subarray(0, FINGERPRINT_HEAD));

			const midPos = Math.floor(size / 2) - Math.floor(FINGERPRINT_MID / 2);
			chunks.push(buffer.subarray(midPos, midPos + FINGERPRINT_MID));

			chunks.push(buffer.subarray(size - FINGERPRINT_TAIL));
		}

		return crypto.createHash("md5").update(Buffer.concat(chunks)).digest("hex");
	} catch (e) {
		return null;
	}
}

// ============================================================================
// ★ HTML 解析（cheerio 版）辅助函数
// ============================================================================

function sanitizeHtml(html) {
	if (!html) return "";
	const $ = cheerio.load(html, { decodeEntities: false });

	$("script, iframe, object, embed").remove();

	$("*").each(function () {
		const attrs = this.attribs || {};
		for (const attr of Object.keys(attrs)) {
			if (attr.toLowerCase().startsWith("on")) {
				$(this).removeAttr(attr);
			}
		}

		const href = $(this).attr("href");
		if (href && href.toLowerCase().startsWith("javascript:")) {
			$(this).removeAttr("href");
		}

		const src = $(this).attr("src");
		if (src && src.toLowerCase().startsWith("javascript:")) {
			$(this).removeAttr("src");
		}
	});

	return $.html();
}

function _looksLikeHtml(s) {
	if (!s) return false;
	const t = String(s);
	return /<\/?(html|body|div|p|img|picture|source|span|a)\b/i.test(t) || /\b(srcset|data-src|data-srcset)\s*=/i.test(t);
}

function _cleanAttr(v) {
	if (v == null) return "";
	return String(v).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

function _normalizeUrl(raw) {
	let u = _cleanAttr(raw);
	if (!u) return "";
	const lower = u.toLowerCase();
	if (lower.startsWith("blob:")) return "";
	if (lower.startsWith("chrome-extension:")) return "";
	if (lower.startsWith("about:")) return "";

	if (u.startsWith("//")) u = "https:" + u;
	return u;
}

function _parseSrcset(srcset) {
	const out = [];
	const s = _cleanAttr(srcset);
	if (!s) return out;

	const parts = s.split(",").map(x => x.trim()).filter(Boolean);
	for (const part of parts) {
		const segs = part.split(/\s+/).filter(Boolean);
		const url = _normalizeUrl(segs[0] || "");
		if (!url) continue;
		const desc = (segs[1] || "").trim();
		out.push({ url, desc });
	}
	return out;
}

function _scoreSrcsetDesc(desc) {
	if (!desc) return 0;
	const mW = /^(\d+(?:\.\d+)?)w$/i.exec(desc);
	if (mW) return Number(mW[1]) || 0;
	const mX = /^(\d+(?:\.\d+)?)x$/i.exec(desc);
	if (mX) return (Number(mX[1]) || 0) * 100000;
	return 0;
}

function _pickBestFromSrcset(srcset) {
	const cand = _parseSrcset(srcset);
	if (!cand.length) return "";
	cand.sort((a, b) => _scoreSrcsetDesc(b.desc) - _scoreSrcsetDesc(a.desc));
	return cand[0]?.url || "";
}

function _collectElementUrls($el, isSourceTag = false) {
	const urls = [];

	const srcsetKeys = [
		"srcset",
		"data-srcset",
		"data-lazy-srcset",
		"data-lazysrcset",
		"data-src-set",
	];
	for (const k of srcsetKeys) {
		const v = _pickBestFromSrcset($el.attr(k));
		if (v) urls.push(v);
	}

	const srcKeys = isSourceTag
		? ["src", "data-src"]
		: [
			"src",
			"data-src",
			"data-original",
			"data-orig",
			"data-lazy-src",
			"data-lazysrc",
			"data-actualsrc",
			"data-url",
			"data-img",
		];
	for (const k of srcKeys) {
		const v = _normalizeUrl($el.attr(k));
		if (v) urls.push(v);
	}

	return urls;
}

function _collectHtmlMediaUrls($) {
	const seen = new Set();
	const out = [];

	$("img,source").each((_, el) => {
		const tag = (el?.tagName || "").toLowerCase();
		const $el = $(el);
		const urls = _collectElementUrls($el, tag === "source");
		for (const u of urls) {
			if (!u) continue;
			if (seen.has(u)) continue;
			seen.add(u);
			out.push(u);
		}
	});

	return out;
}

function _extFromContentType(ct) {
	const t = String(ct || "").toLowerCase().split(";")[0].trim();
	if (t === "image/jpeg") return ".jpg";
	if (t === "image/jpg") return ".jpg";
	if (t === "image/png") return ".png";
	if (t === "image/gif") return ".gif";
	if (t === "image/webp") return ".webp";
	if (t === "image/svg+xml") return ".svg";
	if (t === "image/bmp") return ".bmp";
	if (t === "image/x-icon" || t === "image/vnd.microsoft.icon") return ".ico";
	return "";
}

function _guessExtFromUrl(url, contentType) {
	const byCT = _extFromContentType(contentType);
	if (byCT) return byCT;
	try {
		const u = new URL(url);
		const p = u.pathname || "";
		const ext = path.extname(p);
		if (ext && ext.length <= 6) return ext;
	} catch { }
	return ".png";
}

function _fileUrlToFsPath(fileUrl) {
	try {
		const u = new URL(fileUrl);
		if (u.protocol !== "file:") return null;
		let p = decodeURIComponent(u.pathname || "");
		if (!p) return null;
		if (process.platform === "win32") {
			if (p.startsWith("/")) p = p.slice(1);
			p = p.replace(/\//g, "\\");
		}
		return p;
	} catch {
		return null;
	}
}

async function _downloadUrlToBuffer(url, timeoutMs = 15000, maxBytes = 12 * 1024 * 1024, redirectLeft = 5) {
	return new Promise((resolve) => {
		let done = false;
		const finish = (r) => {
			if (done) return;
			done = true;
			resolve(r);
		};

		let u;
		try { u = new URL(url); } catch { return finish({ error: "bad_url" }); }
		const client = u.protocol === "https:" ? https : (u.protocol === "http:" ? http : null);
		if (!client) return finish({ error: "unsupported_protocol" });

		const options = {
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				"Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
			}
		};

		const req = client.get(url, options, (res) => {
			const code = res.statusCode || 0;
			const loc = res.headers?.location;

			if ([301, 302, 303, 307, 308].includes(code) && loc && redirectLeft > 0) {
				res.resume();
				const nextUrl = _normalizeUrl(loc.startsWith("http") ? loc : (new URL(loc, url)).toString());
				_downloadUrlToBuffer(nextUrl, timeoutMs, maxBytes, redirectLeft - 1).then(finish);
				return;
			}

			if (code < 200 || code >= 300) {
				res.resume();
				return finish({ error: `http_${code}` });
			}

			const chunks = [];
			let total = 0;
			res.on("data", (c) => {
				total += c.length;
				if (total > maxBytes) {
					try { req.destroy(); } catch { }
					return finish({ error: "too_large" });
				}
				chunks.push(c);
			});
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				const ct = res.headers?.["content-type"] || "";
				finish({ buffer: buf, contentType: ct });
			});
		});

		req.on("error", () => finish({ error: "net_error" }));
		req.setTimeout(timeoutMs, () => {
			try { req.destroy(); } catch { }
			finish({ error: "timeout" });
		});
	});
}

async function _saveUrlToFile(url, targetDir) {
	const u = _normalizeUrl(url);
	if (!u) return null;

	ensureDir(targetDir);

	if (u.startsWith("data:")) {
		const m = /^data:([^;]+);base64,(.*)$/i.exec(u);
		if (!m) return null;
		const mime = m[1];
		const b64 = m[2];
		const buffer = Buffer.from(b64, "base64");

		const fp = computeBufferFingerprint(buffer);
		const existingPath = fp ? findFileByFingerprint(fp) : null;
		if (existingPath && fs.existsSync(existingPath)) {
			return { path: existingPath, fingerprint: fp };
		}

		const ext = _guessExtFromUrl("x://data", mime);
		const destPath = path.join(targetDir, getTimestampFilename(ext));
		fs.writeFileSync(destPath, buffer);
		if (fp) prefillFingerprint(destPath, fp);
		return { path: destPath, fingerprint: fp };
	}

	if (u.startsWith("file://")) {
		const localPath = _fileUrlToFsPath(u);
		if (!localPath || !fs.existsSync(localPath) || fs.statSync(localPath).isDirectory()) return null;

		const fp = computeFingerprint(localPath);
		const existingPath = fp ? findFileByFingerprint(fp) : null;
		if (existingPath && fs.existsSync(existingPath)) {
			return { path: existingPath, fingerprint: fp };
		}

		const ext = path.extname(localPath) || ".png";
		const destPath = path.join(targetDir, getTimestampFilename(ext));
		fs.copyFileSync(localPath, destPath);
		if (fp) prefillFingerprint(destPath, fp);
		return { path: destPath, fingerprint: fp };
	}

	if (u.startsWith("http://") || u.startsWith("https://")) {
		const dl = await _downloadUrlToBuffer(u);
		if (!dl?.buffer || dl.error) return null;

		const buffer = dl.buffer;
		const fp = computeBufferFingerprint(buffer);
		const existingPath = fp ? findFileByFingerprint(fp) : null;
		if (existingPath && fs.existsSync(existingPath)) {
			return { path: existingPath, fingerprint: fp };
		}

		const ext = _guessExtFromUrl(u, dl.contentType);
		const destPath = path.join(targetDir, getTimestampFilename(ext));
		fs.writeFileSync(destPath, buffer);
		if (fp) prefillFingerprint(destPath, fp);
		return { path: destPath, fingerprint: fp };
	}

	return null;
}

// ------------------------------------------------------------------------
// ★ 异步流式拷贝（带进度监控 & 取消支持）
// ------------------------------------------------------------------------
async function copyFileWithProgress(src, dest, onProgress, token) {
	return new Promise((resolve, reject) => {
		if (token?.isCancellationRequested) return reject(new Error("cancelled"));

		try {
			const stat = fs.statSync(src);
			const totalSize = stat.size;
			let copiedSize = 0;

			const readStream = fs.createReadStream(src);
			const writeStream = fs.createWriteStream(dest);

			readStream.on("error", reject);
			writeStream.on("error", reject);

			if (token) {
				token.onCancellationRequested(() => {
					readStream.destroy();
					writeStream.destroy();
					try { fs.unlinkSync(dest); } catch { }
					reject(new Error("cancelled"));
				});
			}

			readStream.on("data", (chunk) => {
				copiedSize += chunk.length;
				if (onProgress && totalSize > 0) {
					onProgress(chunk.length, copiedSize, totalSize);
				}
			});

			writeStream.on("finish", () => {
				resolve();
			});

			readStream.pipe(writeStream);
		} catch (e) {
			reject(e);
		}
	});
}

/**
 * ★ 补齐：downloadImage
 * 仅负责下载并保存到指定路径，同时计算指纹
 */
async function downloadImage(url, destPath) {
	const result = await _downloadUrlToBuffer(url);
	if (result.error) throw new Error(result.error);
	if (result.buffer) {
		fs.writeFileSync(destPath, result.buffer);
		const fp = computeBufferFingerprint(result.buffer);
		if (fp) prefillFingerprint(destPath, fp);
		return true;
	}
	return false;
}

// ------------------------------------------------------------------------
// ★ handleClipboardNode
// ------------------------------------------------------------------------
async function handleClipboardNode(targetDir, partialCallback = null, token = null, progressCallback = null) {
	try {
		if (token?.isCancellationRequested) return null;
		if (progressCallback) progressCallback(0, "正在解析 HTML...");

		// 1. 尝试通过 Bridge 获取 HTML (Python/Rust/Shell)
		let htmlText = null;
		const pref = global.getEnginePreference();
		const order = global.getEngineTryOrder(pref);

		for (const engine of order) {
			try {
				let res = null;
				if (engine === "python" && pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
					res = await pythonBridge.call("get_html", {}, 3000);
				} else if (engine === "rust" && rustBridge?.isAvailable && rustBridge.isAvailable()) {
					res = await rustBridge.call("get_html", {}, 3000);
				} else if (engine === "shell" && shellBridge?.isAvailable && shellBridge.isAvailable()) {
					res = await shellBridge.call("getHtml", {}, 5000);
				}

				if (res) {
					if (res.value_base64) {
						htmlText = Buffer.from(res.value_base64, "base64").toString("utf8");
						break;
					} else if (res.value) {
						htmlText = res.value;
						break;
					}
				}
			} catch (e) { }
		}

		// 兜底尝试 ShellBridge
		if (!htmlText && shellBridge && shellBridge.available !== false) {
			try {
				const res = await shellBridge.call("getHtml", {}, 5000);
				if (res) {
					if (res.value_base64) {
						htmlText = Buffer.from(res.value_base64, "base64").toString("utf8");
					} else if (res.value) {
						htmlText = res.value;
					}
				}
			} catch (e) { }
		}

		// 2. Fallback: Spawn PowerShell (当 Daemon 失败时尝试冷启动获取)
		if (!htmlText && process.platform === "win32") {
			try {
				const psScript = `Add-Type -A System.Windows.Forms;$t=[System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::Html);if($t){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))}`;
				const b64 = await spawnOutput("powershell", [
					"-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript
				]);
				if (b64 && b64.trim()) {
					htmlText = Buffer.from(b64.trim(), "base64").toString("utf8");
					global.logMessage("[Fallback] handleClipboardNode used Spawn PowerShell", "INFO");

					// ★ 机会：既然 Spawn 成功了，说明 PowerShell 还能用，尝试复活 ShellBridge
					if (shellBridge && !shellBridge.isAvailable() && !shellBridge.isPermDisabled) {
						global.logMessage("[SelfHealing] Spawn 成功，尝试复活 Shell Daemon...", "INFO");
						shellBridge.start().catch(() => { });
					}
				}
			} catch (e) {
				global.logMessage(`[Fallback] handleClipboardNode Spawn failed: ${e.message}`, "WARN");
			}
		}

		// 3. 如果 Spawn 也没拿到，尝试 VS Code API
		if (!htmlText) {
			const text = await vscode.env.clipboard.readText();
			if (text && _looksLikeHtml(text)) {
				htmlText = text;
			}
		}

		if (!htmlText || !htmlText.trim()) return { type: "text", text: await vscode.env.clipboard.readText() || "" };

		// 3. 处理 Windows 剪贴板 HTML 格式的 Header
		if (htmlText.includes("StartHTML:") && htmlText.includes("EndHTML:")) {
			const mStart = /StartHTML:(\d+)/.exec(htmlText);
			const mEnd = /EndHTML:(\d+)/.exec(htmlText);
			if (mStart && mEnd) {
				const start = parseInt(mStart[1], 10);
				const end = parseInt(mEnd[1], 10);
				if (start > 0 && end > start) {
					const htmlMatch = /<html[\s\S]*<\/html>/i.exec(htmlText);
					if (htmlMatch) {
						htmlText = htmlMatch[0];
					} else {
						const fragmentStart = /<!--StartFragment-->/.exec(htmlText);
						const fragmentEnd = /<!--EndFragment-->/.exec(htmlText);
						if (fragmentStart && fragmentEnd) {
							htmlText = htmlText.substring(fragmentStart.index + 20, fragmentEnd.index);
						}
					}
				}
			}
		}

		// ★ 安全性净化
		let safeHtml = sanitizeHtml(htmlText);
		if (!safeHtml) return { type: "text", text: htmlText }; // 如果净化后为空，但原始内容非空，降级为纯文本返回，而不是 null

		let $;
		try {
			// ★ 修复乱码关键：使用 null-encoding 加载，保持原始字节流处理
			// cheerio 默认会尝试智能推断编码，但经常翻车。
			// 这里我们假设输入已经是 UTF-8 字符串（JS 字符串本身就是 UTF-16，但内容可能是 UTF-8 转换来的）
			// 更好的做法是依赖 sanitizeHtml 清洗掉 style/class 等垃圾
			$ = cheerio.load(safeHtml, { decodeEntities: false, xmlMode: false });

			// ★ 安全升级：彻底移除潜在危险标签
			$("script, iframe, object, embed, style, link[rel=stylesheet], meta, base, form, input, button, textarea").remove();

			// ★ 暴力清洗垃圾标签和属性
			// 移除所有 style, class, data-*, width, height 等样式属性，只保留语义化内容
			$('*').each((i, el) => {
				const tag = el.tagName.toLowerCase();
				// ★ 安全升级：强制移除所有内联 style 属性，防止 CSS 注入
				$(el).removeAttr('style');

				// ★ 安全升级：移除所有 on* 事件属性
				const attribs = el.attribs || {};
				for (const attr of Object.keys(attribs)) {
					if (attr.startsWith('on')) $(el).removeAttr(attr);
				}

				if (tag === 'img' || tag === 'br' || tag === 'p' || tag === 'div' || /^h[1-6]$/.test(tag) || tag === 'li' || tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'tr' || tag === 'td' || tag === 'th') {
					// 保留白名单标签，但清洗属性
					const attribs = el.attribs || {};
					for (const attr of Object.keys(attribs)) {
						// 只保留 img 的 src/alt/title，其他全部干掉
						if (tag === 'img') {
							if (!['src', 'data-src', 'srcset', 'data-srcset', 'alt', 'title'].includes(attr)) {
								$(el).removeAttr(attr);
							}
						} else {
							// 非 img 标签，干掉所有属性（style, class, id, etc.）
							$(el).removeAttr(attr);
						}
					}
				} else if (el.type === 'tag') {
					// 非白名单标签，unwrap 内容（保留文本，去掉标签外壳）
					// 例如 <span style="...">text</span> -> text
					// 但 cheerio 的 unwrap 比较麻烦，这里简单粗暴：如果不是 img/br，就只取 text？
					// 不，linearWalk 会处理 text node。
					// 我们这里只负责清洗属性。
					const attribs = el.attribs || {};
					for (const attr of Object.keys(attribs)) {
						$(el).removeAttr(attr);
					}
				}
			});

		} catch (e) {
			global.logMessage(`cheerio.load 失败: ${e.message}`, "ERROR");
			return null;
		}

		// ★ 跳出范式：不使用 HTML 里的文本，而是用 readText 的纯文本
		// 我们只利用 HTML 来提取图片和推断图片的大致位置
		const cleanText = await vscode.env.clipboard.readText() || "";
		// 按换行符分割，并去除两端空白，过滤掉空行以便与 HTML 结构对齐
		const cleanLines = cleanText.split(/\r?\n/);
		let cleanLineIndex = 0;

		const blocks = [];
		let currentBlockHasText = false;
		let currentBlockImages = [];

		// 辅助：提交当前 Block
		function flushBlock() {
			// 1. 先处理文本
			if (currentBlockHasText) {
				// 尝试从 cleanText 中提取一行或多行非空文本
				// 简单的贪婪匹配：只要 cleanLines 还有内容，就取出一行
				// 如果 HTML 里的这个 Block 是 "长文本"，可能对应 cleanText 的多行？
				// 这里简化策略：一个 HTML Block 对应 cleanText 中的 "一段" (直到下一个空行? 或者就一行?)
				// 最稳妥策略：只要 HTML Block 有文本，我们就从 cleanLines 里取出一行 "非空行"
				// 如果 cleanLines 里全是空行了，那就取不到文本了。

				while (cleanLineIndex < cleanLines.length) {
					const line = cleanLines[cleanLineIndex++];
					// 如果是空行，可能是段落间距，跳过，直到找到有内容的行
					// 或者，我们保留空行作为间距？
					// 既然是 "cleanText"，每一行都很重要。
					// 让我们改一下策略：
					// 每次 HTML Block 结束，我们就输出 "一段" cleanText。
					// 但是 "一段" 是多少？

					// 重新思考：HTML 的 <p> 对应 cleanText 的 "视觉段落"。
					// cleanText 的 "视觉段落" 通常由空行分隔。
					// 比如: Line1 \n \n Line2

					// 让我们尝试 "非空行匹配"：
					// 每个 HTML Block (有 Text) 消耗掉 cleanLines 里的一个 "非空行"。
					if (line && line.trim()) {
						blocks.push({ type: "text", text: line });
						break;
					} else {
						// 如果是空行，我们也保留它作为格式？
						// 是的，保留空行比较好。
						blocks.push({ type: "text", text: "" }); // 空行
					}
				}
			}

			// 2. 再处理图片 (通常图片在文字后，或者独立)
			for (const img of currentBlockImages) {
				blocks.push(img);
			}

			currentBlockHasText = false;
			currentBlockImages = [];
		}

		const root = $('body').length ? $('body') : $.root();

		// 递归遍历，寻找 Block 边界
		function structuralWalk(ctx) {
			$(ctx).contents().each((i, el) => {
				if (el.type === 'text') {
					if ($(el).text().trim().length > 0) {
						currentBlockHasText = true;
					}
				} else if (el.type === 'tag') {
					const tagName = el.name.toLowerCase();
					const isBlock = ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'article', 'section', 'footer', 'header', 'blockquote'].includes(tagName);
					const isBr = tagName === 'br';
					const isImg = tagName === 'img';

					if (isImg) {
						const urls = _collectElementUrls($(el), false);
						if (urls && urls.length > 0) {
							const imgBlock = { type: "media", kind: "image", src: urls[0], status: "pending" };
							// ★ 关键修正：如果当前没有积攒文本，说明图片是独立的（或紧跟上一个Block的），直接输出，防止被吸附到下一个Block
							if (currentBlockHasText) {
								currentBlockImages.push(imgBlock);
							} else {
								blocks.push(imgBlock);
							}
						}
					} else {
						structuralWalk(el);
					}

					if (isBlock || isBr) {
						flushBlock();
					}
				}
			});
		}

		structuralWalk(root);
		flushBlock(); // 处理最后的残余

		// 如果 cleanLines 还有剩余的文本（因为 HTML 结构可能比文本少，比如 HTML 解析提前结束），全部追加到后面
		while (cleanLineIndex < cleanLines.length) {
			const line = cleanLines[cleanLineIndex++];
			blocks.push({ type: "text", text: line });
		}

		const hasMedia = blocks.some(b => b.type === "media");
		if (!hasMedia && blocks.length === 0) {
			return { type: "text", text: cleanText || "" };
		}

		const pendingTasks = [];

		for (const b of blocks) {
			if (b.type === "media" && b.kind === "image") {
				const task = (async () => {
					try {
						// 1. Initial extension guess
						let ext = ".png";
						try {
							const u = new URL(b.src, "http://x.com");
							ext = path.extname(u.pathname) || "";
						} catch {
							ext = path.extname(b.src) || "";
						}

						// 2. Download content
						const dl = await _downloadUrlToBuffer(b.src);
						if (dl.error || !dl.buffer) {
							global.logMessage(`Image download failed: ${b.src} -> ${dl.error}`, "WARN");
							return;
						}

						let finalExt = ext.toLowerCase();

						// 3. Check whitelist
						if (!IMAGE_EXTS_FOR_CLIPBOARD.has(finalExt)) {
							// Not in whitelist, try detection
							try {
								const dim = sizeOf(dl.buffer);
								if (dim && dim.type) {
									finalExt = "." + dim.type;
									// map common types if needed
									if (finalExt === ".jpeg") finalExt = ".jpg";
								} else {
									finalExt = ".webp";
								}
							} catch (e) {
								finalExt = ".webp";
							}
						}

						// 4. Save file
						const filename = getTimestampFilename(finalExt);
						const destPath = path.join(targetDir, filename);

						ensureDir(targetDir);
						fs.writeFileSync(destPath, dl.buffer);

						const fp = computeBufferFingerprint(dl.buffer);
						if (fp) prefillFingerprint(destPath, fp);

						b.filename = filename;
						b.path = destPath; // ★ q1.js 需要绝对路径来计算相对路径和空行
						b.fingerprint = fp;
						global.logMessage(`Saved image: ${filename} (${finalExt})`, "INFO");

					} catch (e) {
						global.logMessage(`Process image error: ${e.message}`, "WARN");
					}
				})();
				pendingTasks.push(task);
			}
		}

		if (pendingTasks.length > 0) {
			if (progressCallback) progressCallback(10, `发现 ${pendingTasks.length} 张图片，准备下载...`);

			// 简单的并行下载，带进度汇报
			let completedCount = 0;
			const total = pendingTasks.length;

			// 包装任务以支持进度
			const wrappedTasks = pendingTasks.map(taskPromise => {
				return taskPromise.then(() => {
					completedCount++;
					if (progressCallback) {
						// 剩余 90% 的进度分给下载
						const inc = 90 / total;
						progressCallback(inc, `下载图片 ${completedCount}/${total}`);
					}
				});
			});

			await Promise.all(wrappedTasks);
		}

		// ★ 返回结构化数据，让 q1.js 负责最终的格式化（包含空行计算）
		return { type: "html_blocks", blocks };
	} catch (e) {
		global.logMessage(`handleClipboardNode 失败: ${e?.message || e}`, "ERROR");
		return null;
	}
}

// ------------------------------------------------------------------------
// ★ 以下是辅助函数
// ------------------------------------------------------------------------

async function handleClipboardShell(targetDir, token = null, progressCallback = null, preFetchedFiles = null, preCalculatedTotalSize = 0) {
	try {
		if (token?.isCancellationRequested) return null;
		if (process.platform === "win32") {
			let files = preFetchedFiles;
			if (!files) {
				// 优先尝试获取文件列表 (支持 Python 和 Shell 引擎)
				const pref = global.getEnginePreference();
				const order = global.getEngineTryOrder(pref); // ["python", "rust", "shell", "spawn"]

				for (const engine of order) {
					try {
						if (engine === "python" && pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
							const res = await pythonBridge.call("get_clipboard_files", {}, 2000);
							if (res && res.paths && res.paths.length > 0) {
								files = res.paths;
								break;
							}
						} else if (engine === "shell" && shellBridge?.isAvailable && shellBridge.isAvailable()) {
							const res = await shellBridge.call("getFiles", {}, 2000);
							if (res && res.files && res.files.length > 0) {
								files = res.files;
								break;
							}
						}
					} catch { }
				}

				// 兜底尝试 ShellBridge
				if ((!files || files.length === 0) && shellBridge?.isAvailable && shellBridge.isAvailable()) {
					try {
						const res = await shellBridge.call("getFiles", {}, 2000);
						files = res?.files || [];
					} catch { }
				}
			}

			if (files && files.length > 0) {

				const folders = files.filter((f) => {
					try { return fs.statSync(f).isDirectory(); } catch { return false; }
				});
				const validFiles = files.filter((f) => {
					try { return fs.existsSync(f) && !fs.statSync(f).isDirectory(); } catch { return false; }
				});

				ensureDir(targetDir);
				const copiedFiles = [];
				const copiedFolders = [];
				const fingerprints = {};

				// 如果没有预计算总大小（比如直接调用的），且需要进度条，则现场计算
				let totalBytesToTransfer = preCalculatedTotalSize;
				if (progressCallback && totalBytesToTransfer <= 0) {
					// 简单估算，文件夹就不递归了，太慢
					for (const f of validFiles) {
						try { totalBytesToTransfer += fs.statSync(f).size; } catch { }
					}
				}

				let transferredBytes = 0;

				// 处理文件夹
				for (let i = 0; i < folders.length; i++) {
					if (token?.isCancellationRequested) throw new Error("cancelled");
					const folder = folders[i];
					if (progressCallback) progressCallback(0, `复制文件夹 (${i + 1}/${folders.length}): ${path.basename(folder)}`);
					try {
						const destFolder = path.join(targetDir, path.basename(folder));
						fs.cpSync(folder, destFolder, { recursive: true, force: true });
						copiedFolders.push(destFolder);
					} catch { }
				}

				// 处理文件（支持大文件流式进度）
				if (validFiles.length > 0) {
					const totalFileCount = validFiles.length;
					for (let i = 0; i < totalFileCount; i++) {
						if (token?.isCancellationRequested) throw new Error("cancelled");

						const f = validFiles[i];
						const baseName = path.basename(f);

						try {
							const srcFingerprint = computeFingerprint(f);
							if (srcFingerprint) {
								fingerprints[f] = srcFingerprint;
								let existingPath = findFileByFingerprint(srcFingerprint);
								if (existingPath && fs.existsSync(existingPath)) {
									copiedFiles.push(existingPath);

									// 秒传也算进度
									try {
										const fSize = fs.statSync(f).size;
										transferredBytes += fSize;
										if (progressCallback && totalBytesToTransfer > 0) {
											const inc = (fSize / totalBytesToTransfer) * 100;
											progressCallback(inc, `秒传: ${baseName}`);
										}
									} catch { }
									continue;
								}
							}

							const ext = path.extname(f);
							const isImg = isImageExtForClipboard(ext);
							const fname = isImg ? getTimestampFilename(ext) : baseName;
							const dest = path.join(targetDir, fname);

							if (fs.existsSync(dest)) {
								const dstFingerprint = computeFingerprint(dest);
								if (dstFingerprint === srcFingerprint) {
									copiedFiles.push(dest);
									if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);

									// 跳过也算进度
									try {
										const fSize = fs.statSync(f).size;
										transferredBytes += fSize;
										if (progressCallback && totalBytesToTransfer > 0) {
											const inc = (fSize / totalBytesToTransfer) * 100;
											progressCallback(inc, `跳过: ${baseName}`);
										}
									} catch { }
									continue;
								}
							}

							// 流式拷贝
							if (progressCallback) progressCallback(0, `正在复制 (${i + 1}/${totalFileCount}): ${baseName}`);

							await copyFileWithProgress(f, dest, (chunkSize, copied, total) => {
								transferredBytes += chunkSize;
								if (progressCallback && totalBytesToTransfer > 0) {
									const inc = (chunkSize / totalBytesToTransfer) * 100;
									const filePct = total > 0 ? Math.round((copied / total) * 100) : 0;
									progressCallback(inc, `复制 ${baseName} (${filePct}%)`);
								}
							}, token);

							if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);
							copiedFiles.push(dest);
							// 这里的进度已经在 callback 里报过了，不需要额外报 "完成" 的 increment
							if (progressCallback) progressCallback(0, `完成: ${baseName}`);

						} catch (e) {
							if (e.message === "cancelled") throw e;
							global.logMessage(`Copy failed: ${f} -> ${e.message}`, "WARN");
						}
					}
				}

				if (copiedFiles.length > 0 || copiedFolders.length > 0) {
					return {
						type: "file_folder",
						files: copiedFiles,
						folders: copiedFolders,
						fingerprints: fingerprints
					};
				}
			}
		}

		// 图片处理回退 (Python/Rust/Shell)
		const pref = global.getEnginePreference();
		const order = global.getEngineTryOrder(pref);

		for (const engine of order) {
			try {
				if (engine === "python" && pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
					// Python 引擎的 "clipboard" 动作会自动保存图片
					const res = await pythonBridge.call("clipboard", { target_dir: targetDir }, 2000);
					if (res && res.type === "image") return res;
				} else if (engine === "shell" && shellBridge?.isAvailable && shellBridge.isAvailable()) {
					const hasImg = await shellBridge.call("hasImage", {}, 2000);
					if (hasImg?.value) {
						const fname = getTimestampFilename(".png");
						const dest = path.join(targetDir, fname);
						ensureDir(targetDir);
						const saved = await shellBridge.call("saveImage", { path: dest }, 8000);
						if (saved?.success && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
							const fp = computeFingerprint(dest);
							return { type: "image", path: dest, fingerprint: fp };
						}
					}
				}
			} catch { }
		}

		// 兜底尝试 ShellBridge (如果 order 里没有)
		if (shellBridge?.isAvailable && shellBridge.isAvailable()) {
			try {
				const hasImg = await shellBridge.call("hasImage", {}, 2000);
				if (hasImg?.value) {
					const fname = getTimestampFilename(".png");
					const dest = path.join(targetDir, fname);
					ensureDir(targetDir);
					const saved = await shellBridge.call("saveImage", { path: dest }, 8000);
					if (saved?.success && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
						const fp = computeFingerprint(dest);
						return { type: "image", path: dest, fingerprint: fp };
					}
				}
			} catch { }
		}

		const text = await vscode.env.clipboard.readText();
		if (text && (text.includes("<html") || text.includes("<body") || text.includes("<div") || text.includes("<img") || text.includes("<p"))) {
			return await handleClipboardNode(targetDir);
		}
	} catch (e) {
		global.logMessage(`Shell剪贴板处理失败: ${e.message}`, "ERROR");
	}

	return null;
}

function copyFilesToTarget(files, targetDir) {
	ensureDir(targetDir);

	const copied = [];
	const fingerprints = {};

	for (const f of files) {
		try {
			const srcFingerprint = computeFingerprint(f);
			if (srcFingerprint) {
				fingerprints[f] = srcFingerprint;

				let existingPath = findFileByFingerprint(srcFingerprint);
				if (existingPath && fs.existsSync(existingPath)) {
					copied.push(existingPath);
					continue;
				}
			}

			const ext = path.extname(f);
			const isImg = isImageExtForClipboard(ext);
			const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
			const dest = path.join(targetDir, fname);

			if (fs.existsSync(dest)) {
				const dstFingerprint = computeFingerprint(dest);
				if (dstFingerprint === srcFingerprint) {
					copied.push(dest);
					if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);
					continue;
				}
			}

			fs.copyFileSync(f, dest);

			if (srcFingerprint) {
				prefillFingerprint(dest, srcFingerprint);
			}

			copied.push(dest);
		} catch { }
	}
	return { copied, fingerprints };
}

async function handleClipboardSpawn(targetDir) {
	const platform = process.platform;
	if (platform === "win32") return handleClipboardSpawnWin32(targetDir);
	if (platform === "darwin") return handleClipboardSpawnDarwin(targetDir);
	return handleClipboardSpawnLinux(targetDir);
}

async function handleClipboardSpawnWin32(targetDir) {
	// ==================================================================================
	// ★ 四层回退机制 (The 4-Layer Fallback Architecture)
	// 1. Python Daemon: 最佳体验（支持透明通道完美还原）
	// 2. Rust Daemon:   高性能备选
	// 3. Shell Daemon:  常驻 PowerShell（无冷启动开销，常规兼容性）
	// 4. Spawn Mode:    最后的倔强（冷启动 PowerShell，极慢但最稳）
	// ==================================================================================

	const pref = global.getEnginePreference(); // "auto", "python", "rust", "shell"

	// 构建尝试顺序
	const bridgeMap = {
		"python": pythonBridge,
		"rust": rustBridge,
		"shell": shellBridge
	};

	const typeOrder = global.getEngineTryOrder(pref); // ["python", "rust", "shell", "spawn"]
	const bridgeOrder = [];

	for (const type of typeOrder) {
		const b = bridgeMap[type];
		if (b) bridgeOrder.push(b);
	}

	// --- 尝试 Daemon 引擎 ---
	for (const bridge of bridgeOrder) {
		if (!bridge.isAvailable()) continue;

		try {
			// 1. Python / Rust 引擎：接口高度统一，直接通过 "clipboard" 动作一键处理
			if (bridge === pythonBridge || bridge === rustBridge) {
				const res = await bridge.call("clipboard", { target_dir: targetDir }, 10000);
				if (res && !res.error && res.type !== "unknown") {
					global.logMessage(`[FastPath] 由 ${bridge.name} 引擎处理成功`, "INFO");
					return res;
				}
			}

			// 2. Shell Bridge (PowerShell Daemon)：需要组合原子操作
			if (bridge === shellBridge) {
				// A. 检查是否有文件
				const checkRes = await bridge.call("checkQ", {}, 2000);
				if (checkRes?.hasFile) {
					const filesRes = await bridge.call("getFiles", {}, 5000);
					const files = filesRes?.files || [];
					if (files.length > 0) {
						// 复用现有的文件处理逻辑
						const result = processFilesForClipboard(files, targetDir);
						if (result) return result;
					}
				}

				// B. 检查是否有图片
				if (checkRes?.hasImage) {
					const fname = getTimestampFilename(".png");
					const dest = path.join(targetDir, fname);
					ensureDir(targetDir);

					const saveRes = await bridge.call("saveImage", { path: dest }, 8000);
					if (saveRes?.success && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
						const fp = computeFingerprint(dest);
						return { type: "image", path: dest, fingerprint: fp };
					}
				}
			}
		} catch (e) {
			global.logMessage(`${bridge.name} 处理剪贴板异常: ${e.message}`, "WARN");
		}
	}

	// --- Fallback: Spawn Mode (冷启动 PowerShell) ---
	global.logMessage("[SlowPath] 所有 Daemon 均不可用或失败，回退到 Spawn 模式", "WARN");

	const hasFiles = await spawnCheck("powershell", [
		"-STA",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsFileDropList()){\\\"1\\\"}else{\\\"0\\\"}",
	], "1");

	if (hasFiles) {
		const filesOutput = await spawnOutput("powershell", [
			"-STA",
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
			"Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetFileDropList();if($f){foreach($i in $f){$i}}",
		]);

		const files = filesOutput.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && fs.existsSync(s));
		const result = processFilesForClipboard(files, targetDir);
		if (result) return result;
	}

	const hasImg = await spawnCheck("powershell", [
		"-STA",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsImage()){\\\"1\\\"}else{\\\"0\\\"}",
	], "1");

	if (hasImg) {
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);
		ensureDir(targetDir);

		const escapedPath = dest.replace(/'/g, "''");
		const saved = await spawnCheck("powershell", [
			"-STA",
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
			`Add-Type -A System.Windows.Forms;Add-Type -A System.Drawing;$img=[System.Windows.Forms.Clipboard]::GetImage();if($img){$img.Save('${escapedPath}',[System.Drawing.Imaging.ImageFormat]::Png);'OK'}else{'FAIL'}`,
		], "OK");

		if (saved && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
			const fp = computeFingerprint(dest);
			return { type: "image", path: dest, fingerprint: fp };
		}
	}

	return { type: "unknown" };
}

// 提取公共的文件处理逻辑，供 ShellBridge 和 SpawnMode 复用
function processFilesForClipboard(files, targetDir) {
	const folders = files.filter((f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
	const validFiles = files.filter((f) => { try { return !fs.statSync(f).isDirectory(); } catch { return false; } });

	ensureDir(targetDir);
	const copiedFiles = [];
	const copiedFolders = [];
	const fingerprints = {};

	for (const folder of folders) {
		try {
			const destFolder = path.join(targetDir, path.basename(folder));
			fs.cpSync(folder, destFolder, { recursive: true, force: true });
			copiedFolders.push(destFolder);
		} catch { }
	}

	if (validFiles.length > 0) {
		const result = copyFilesToTarget(validFiles, targetDir);
		copiedFiles.push(...result.copied);
		Object.assign(fingerprints, result.fingerprints);
	}

	if (copiedFiles.length > 0 || copiedFolders.length > 0) {
		return {
			type: "file_folder",
			files: copiedFiles,
			folders: copiedFolders,
			fingerprints: fingerprints
		};
	}
	return null;
}

async function handleClipboardSpawnDarwin(targetDir) {
	const fname = getTimestampFilename(".png");
	const dest = path.join(targetDir, fname);
	const tmpName = `qqq_${Date.now()}_${Math.random().toString(16).slice(2)}.png`;
	const tmpDest = path.join(os.tmpdir(), tmpName);

	try {
		cp.execSync(`pngpaste "${tmpDest}" 2>/dev/null || pbpaste -Prefer png > "${tmpDest}" 2>/dev/null`, { timeout: 5000 });

		if (fs.existsSync(tmpDest) && fs.statSync(tmpDest).size > 0) {
			ensureDir(targetDir);
			try {
				fs.renameSync(tmpDest, dest);
			} catch (e) {
				try {
					fs.copyFileSync(tmpDest, dest);
					try { fs.unlinkSync(tmpDest); } catch { }
				} catch { }
			}

			if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
				const fp = computeFingerprint(dest);
				return { type: "image", path: dest, fingerprint: fp };
			}

			if (fs.existsSync(dest)) {
				try { fs.unlinkSync(dest); } catch { }
			}
		}

		if (fs.existsSync(tmpDest)) {
			try { fs.unlinkSync(tmpDest); } catch { }
		}
	} catch (e) {
		if (fs.existsSync(tmpDest)) {
			try { fs.unlinkSync(tmpDest); } catch { }
		}
	}

	return { type: "unknown" };
}

async function handleClipboardSpawnLinux(targetDir) {
	const fname = getTimestampFilename(".png");
	const dest = path.join(targetDir, fname);

	try {
		ensureDir(targetDir);
		cp.execSync(`xclip -selection clipboard -t image/png -o > "${dest}" 2>/dev/null`, { timeout: 5000 });

		if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
			const fp = computeFingerprint(dest);
			return { type: "image", path: dest, fingerprint: fp };
		}

		if (fs.existsSync(dest)) {
			try { fs.unlinkSync(dest); } catch { }
		}
	} catch { }

	return { type: "unknown" };
}

// ★ 修复：timer TDZ（不改逻辑，只避免极端情况下 finish 先跑导致 ReferenceError）
function spawnRun(cmd, args, opts = {}) {
	const { checkExpected, returnOutput } = opts;
	return new Promise((resolve) => {
		const child = cp.spawn(cmd, args, { windowsHide: true });
		let output = "";
		let errorOutput = "";
		let done = false;
		let timer = null;

		const finish = (val) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			resolve(val);
		};

		child.stdout.on("data", (d) => output += (returnOutput ? d.toString() : d.toString().trim()));
		child.stderr.on("data", (d) => errorOutput += d.toString().trim());

		child.on("close", (code) => {
			if (code !== 0 && errorOutput) {
				global.logMessageRateLimited(
					`spawnRun:${cmd}:${code}:${errorOutput.slice(0, 120)}`,
					`${cmd} 执行失败 (exit ${code}): ${errorOutput}`,
					"WARN",
					2 * 60 * 1000
				);
			}
			if (checkExpected) {
				finish(output.includes(checkExpected));
			} else {
				finish(returnOutput ? output : "");
			}
		});

		child.on("error", (err) => {
			global.logMessage(`${cmd} 启动失败: ${err.message}`, "ERROR");
			finish(checkExpected ? false : "");
		});

		timer = setTimeout(() => {
			try { child.kill(); } catch { }
			global.logMessageRateLimited(`spawnRunTimeout:${cmd}`, `${cmd} 执行超时`, "WARN", 2 * 60 * 1000);
			finish(checkExpected ? false : "");
		}, 5000);
	});
}

function spawnCheck(cmd, args, expected) {
	return spawnRun(cmd, args, { checkExpected: expected });
}

function spawnOutput(cmd, args) {
	return spawnRun(cmd, args, { returnOutput: true });
}

async function getFolderInfo(folderPath) {
	folderPath = canonicalizeExistingPath(folderPath) || folderPath;

	const pref = global.getEnginePreference();
	const order = global.getEngineTryOrder(pref);

	for (const engine of order) {
		try {
			if (engine === "python") {
				const started = pythonBridge.isAvailable() || await pythonBridge.start();
				if (started && pythonBridge.isAvailable()) {
					const res = await pythonBridge.call("folder_info", { path: folderPath }, 15000);
					if (res && !res.error) return res;
				}
			} else if (engine === "rust") {
				const started = rustBridge.isAvailable() || await rustBridge.start();
				if (started && rustBridge.isAvailable()) {
					const res = await rustBridge.call("folder_info", { path: folderPath }, 15000);
					if (res && !res.error) return res;
				}
			} else if (engine === "spawn" || engine === "shell") {
				return getFolderInfoJS(folderPath);
			}
		} catch { }
	}

	return getFolderInfoJS(folderPath);
}

async function getFolderInfoJS(folderPath) {
	if (!fs.existsSync(folderPath)) return { error: "not_found" };

	let totalSize = 0;
	let fileCount = 0;
	const extStats = {};

	async function walk(dir) {
		try {
			const files = await fs.promises.readdir(dir, { withFileTypes: true });
			for (const file of files) {
				const fullPath = path.join(dir, file.name);
				if (file.isDirectory()) {
					await walk(fullPath);
				} else {
					try {
						const st = await fs.promises.stat(fullPath);
						totalSize += st.size;
						fileCount++;
						const ext = path.extname(file.name).toLowerCase().replace(".", "") || "no_ext";
						extStats[ext] = (extStats[ext] || 0) + 1;
					} catch { }
				}
			}
		} catch { }
	}

	await walk(folderPath);

	return {
		success: true,
		total_size: totalSize,
		file_count_root: fileCount,
		ext_stats: extStats,
	};
}

function getTimestampFilename(ext) {
	const now = new Date();
	const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
	const time = now.toTimeString().slice(0, 8).replace(/:/g, ".");
	const day = now.getDay() || 7;
	const ms = String(now.getMilliseconds()).padStart(3, "0");

	const excluded = new Set(["l", "i", "s", "a", "m", "c", "b", "f", "t"]);
	const valid = "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
		.split("")
		.filter((c) => !excluded.has(c.toLowerCase()));

	const c1 = valid[Math.floor(Math.random() * valid.length)];
	let c2 = valid[Math.floor(Math.random() * valid.length)];

	if (c1.toLowerCase() === "g") {
		const noG = valid.filter((c) => c.toLowerCase() !== "g");
		c2 = noG[Math.floor(Math.random() * noG.length)];
	}

	return `${ms}${c1}${c2}. ${date} [${day}] ${time}${ext}`;
}

function isImageExtForClipboard(ext) {
	return IMAGE_EXTS_FOR_CLIPBOARD.has(ext.toLowerCase());
}

function shouldShowDuration(info) {
	return info && (info.type === "video" || info.type === "animated_image") && info.duration > 0.1;
}

const pendingJobs = new Map();
let tokenCounter = 0;

function createPendingToken() {
	const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
	let token = "";
	for (let i = 0; i < 8; i++) token += chars[Math.floor(Math.random() * chars.length)];
	return token + (++tokenCounter).toString(36);
}

function registerPendingJob(token, data) {
	return new Promise((resolve, reject) => {
		pendingJobs.set(token, { resolve, reject, ...data, startTime: Date.now() });
		setTimeout(() => {
			if (pendingJobs.has(token)) {
				pendingJobs.delete(token);
				reject(new Error("timeout"));
			}
		}, 30000);
	});
}

function resolvePendingJob(token, result) {
	const job = pendingJobs.get(token);
	if (job) {
		pendingJobs.delete(token);
		job.resolve(result);
	}
}

// ---------- extension activate/deactivate ----------
let q1Module = null;
let q2Module = null;

async function activate(context) {
	global.logMessage("qqq 扩展激活（中控模式）...", "INFO");

	extensionContext = context;
	global.init(context);

	initCache(context);
	global.setCacheStatsGetter(() => getCacheStatsSnapshot());

	global.setLogPath(path.join(cacheDir, "err.log"));

	global.initStatusBar();
	updateStatusBarNow();

	startDaemons();

	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.pure", q3.pureCommand),
		vscode.commands.registerCommand("qqq.allSettings", () => {
			vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("qqq.ioEngine")) {
				global.logMessage("IO 引擎配置已更改，执行热切换...", "INFO");

				// ★ 增加防抖，避免用户快速切换配置导致多次触发
				if (this._configChangeTimer) clearTimeout(this._configChangeTimer);
				this._configChangeTimer = setTimeout(async () => {
					// 1. 停止不需要的 Daemon (Python/Rust)，但【绝对不要】停止 ShellBridge
					// ShellBridge 是系统基石，必须常驻，除非扩展被禁用
					await pythonBridge.stop();
					await rustBridge.stop();
					// await shellBridge.stop(); // <--- 删除这行，ShellBridge 永不停止

					// 2. 稍作延迟，让 OS 回收资源
					setTimeout(() => {
						global.logMessage("开始重新启动守护进程 (Reload)", "DEBUG");
						startDaemons();
					}, 200);
				}, 500);
			}
		})
	);

	loadSubModules(context);

	if (_statusBarTimer) clearInterval(_statusBarTimer);
	_statusBarTimer = setInterval(() => {
		try {
			updateStatusBarNow();
		} catch { }
	}, 5000);

	global.logMessage("qqq 扩展激活完成", "INFO");
}

// startDaemons moved to global.js

function loadSubModules(context) {
	try {
		q1Module = require("./q1");
		if (q1Module?.activate) q1Module.activate(context);
	} catch (e) {
		global.logMessage(`q1 加载失败: ${e.message}`, "ERROR");
	}

	try {
		q2Module = require("./q2");
		if (q2Module?.activate) q2Module.activate(context);
	} catch (e) {
		global.logMessage(`q2 加载失败: ${e.message}`, "ERROR");
	}
}

async function deactivate() {
	pythonBridge.stop();
	rustBridge.stop();
	shellBridge.stop();

	global.finishUserTracking();

	try {
		if (_statusBarTimer) clearInterval(_statusBarTimer);
		_statusBarTimer = null;
		global.disposeStatusBar();
	} catch { }

	try { validateCache(); } catch { }
	saveCacheMeta();

	if (q1Module?.deactivate) {
		try { await q1Module.deactivate(); } catch { }
	}

	global.logMessage("qqq 扩展已停用", "INFO");
}

const exported = {
	activate,
	deactivate,

	createPathRegex,
	toSafePath,
	sanitizeHtml,

	normalizeNavPath,
	resolveNavPath,
	canonicalizeExistingPath,
	cacheKeyForPath,

	logMessage: global.logMessage,
	logMessageRateLimited: global.logMessageRateLimited,
	logQ: global.logQ,

	computeFingerprint,
	prefillFingerprint,

	initCache,
	validateCache,

	getCacheEntry,
	getCacheQualityMeta,
	getCacheStatsSnapshot,
	getPersistentCacheStatsSnapshot: global.getPersistentCacheStatsSnapshot,

	setCacheEntry,
	getCachedBuffer,

	handleClipboardFast,
	handleClipboardSlow,

	getFolderInfo,

	getTimestampFilename,
	isImageExtForClipboard,
	shouldShowDuration,

	createPendingToken,
	registerPendingJob,
	resolvePendingJob,

	raceClipboard,

	probeScheduler: global.probeScheduler,
	genScheduler: global.genScheduler,

	getActiveEngineCode: global.getActiveEngineCode,
	getActiveEngineName: global.getActiveEngineName,
	updateStatusBarNow,
};

Object.assign(module.exports, exported);

Object.defineProperty(module.exports, "LOG_PATH", { enumerable: true, get: () => global.getLogPath() });
Object.defineProperty(module.exports, "ffmpegPath", { enumerable: true, get: () => ffmpegPath });
Object.defineProperty(module.exports, "ffprobePath", { enumerable: true, get: () => ffprobePath });

process.on("uncaughtException", (error) => {
	const stack = error.stack || "";
	global.logMessage(`未捕获的异常: ${error.message}\n${error.stack}`, "ERROR");
});

process.on("unhandledRejection", (reason) => {
	const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
	global.logMessage(`未处理的Promise拒绝: ${msg}`, "ERROR");
});


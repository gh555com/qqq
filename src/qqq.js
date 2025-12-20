// src/qqq.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const readline = require("readline");
const crypto = require("crypto");

let LOG_PATH = null;
const outputChannel = vscode.window.createOutputChannel("qqq extension");

// ============================================================================
// ★ 全局唯一真理来源：路径暗号 + 捕获组（match[1] 就是内部路径）
// - 匹配形如：/\   ...qqq...   \/
// - 捕获组(1)返回中间内容（去掉外壳 /\\ 和 \\ /）
// - 用 [\s\S] 允许跨任意字符；*? 非贪婪，避免吞掉后续 marker
// ============================================================================
const QQQ_PATH_REGEX = /\/\\\s*([\s\S]*?qqq[\s\S]*?)\s*\\\//gi;

// pending 仍保持原样（有捕获组 token）
const PENDING_REGEX = /\/\\__PENDING__:([a-zA-Z0-9]+)__\\\//g;

const CACHE_DIR_NAME = "qqq_cache";
const META_FILE_NAME = "meta.json";
const CACHE_MAX_SIZE = 40 * 1024 * 1024;
const CACHE_TARGET_SIZE = 28 * 1024 * 1024;

const FINGERPRINT_HEAD = 128;
const FINGERPRINT_MID = 128;
const FINGERPRINT_TAIL = 128;

const IMAGE_EXTS_FOR_CLIPBOARD = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif"
]);

const BINARY_EXTS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
	".exe", ".dll", ".zip", ".tar", ".gz",
	".mp3", ".mp4", ".avi", ".mov", ".mkv",
	".pdf", ".doc", ".docx", ".psd", ".ai"
]);

let ffmpegPath = null;
let ffprobePath = null;
try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
	ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, m => m.replace("ffmpeg", "ffprobe"));
} catch (e) { }

let extensionContext = null;
let cacheDir = null;
let cacheMeta = null;

// ============================================================================
// ★ 5) 日志降噪（rate-limit）基础设施：同 key 在 interval 内只记一次
// ============================================================================
const _rateLimitLastTs = new Map();
function logMessageRateLimited(key, message, level = "WARN", intervalMs = 5 * 60 * 1000) {
	const now = Date.now();
	const last = _rateLimitLastTs.get(key) || 0;
	if (now - last < intervalMs) return;
	_rateLimitLastTs.set(key, now);
	logMessage(message, level);
}

// ★ 把 daemon stderr 也降噪：避免桥接层 stderr 一直刷屏
function _bridgeStderrKey(name, text) {
	const head = String(text || "").replace(/\s+/g, " ").slice(0, 120);
	return `bridge:${name}:${head}`;
}

function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}`;
	outputChannel.appendLine(line);

	if ((level === "ERROR" || level === "WARN") && LOG_PATH) {
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(LOG_PATH, line + "\n");
		} catch (e) { }
	}
}

// ============================================================================
// ★ 3) probe / gen 双 scheduler：先在 qqq 层提供可复用实现
// ============================================================================
class TaskScheduler {
	constructor(maxConcurrency = 8) {
		this.maxConcurrency = Math.max(1, maxConcurrency | 0);
		this.runningCount = 0;
		this.queue = [];
		this.pendingPromises = new Map();
	}

	async schedule(taskKey, taskGenerator) {
		if (this.pendingPromises.has(taskKey)) return this.pendingPromises.get(taskKey);

		const p = new Promise((resolve, reject) => {
			const run = async () => {
				this.runningCount++;
				try {
					const result = await taskGenerator();
					resolve(result);
				} catch (e) {
					reject(e);
				} finally {
					this.runningCount--;
					this.pendingPromises.delete(taskKey);
					this._next();
				}
			};
			this.queue.push(run);
		});

		this.pendingPromises.set(taskKey, p);
		this._next();
		return p;
	}

	_next() {
		while (this.runningCount < this.maxConcurrency && this.queue.length > 0) {
			const task = this.queue.shift();
			task();
		}
	}
}

const probeScheduler = new TaskScheduler(12);
const genScheduler = new TaskScheduler(6);

// ============================================================================
// ★ 4) 缓存 meta 只读快照：状态栏/外部模块取 stats 用（不改结构、不改命中）
// ============================================================================
function getCacheStatsSnapshot() {
	const s = cacheMeta?.stats || { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };
	return {
		totalSize: s.totalSize || 0,
		fileCount: s.fileCount || 0,
		hitCount: s.hitCount || 0,
		missCount: s.missCount || 0
	};
}

// ============================================================================
// ★ 永不清零统计：全部写 VSCode globalState（累计 hit/miss、累计使用时间）
// ============================================================================
const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
const KEY_SESSION_START = "qqq_stats_session_start";

// ★ 永不清零：缓存命中/未命中累计（写入 globalState）
const KEY_CACHE_HIT_TOTAL = "qqq_stats_cache_hit_total";
const KEY_CACHE_MISS_TOTAL = "qqq_stats_cache_miss_total";

let _cacheHitTotal = 0;
let _cacheMissTotal = 0;

let _statsFlushTimer = null;
let _statsDirty = false;

function _loadPersistentStats(context) {
	try {
		_cacheHitTotal = context?.globalState?.get(KEY_CACHE_HIT_TOTAL, 0) || 0;
		_cacheMissTotal = context?.globalState?.get(KEY_CACHE_MISS_TOTAL, 0) || 0;
	} catch { }
}

function _scheduleStatsFlush() {
	if (!extensionContext || !_statsDirty) return;
	if (_statsFlushTimer) return;

	_statsFlushTimer = setTimeout(() => {
		_statsFlushTimer = null;
		if (!extensionContext || !_statsDirty) return;
		_statsDirty = false;

		try {
			extensionContext.globalState.update(KEY_CACHE_HIT_TOTAL, _cacheHitTotal);
			extensionContext.globalState.update(KEY_CACHE_MISS_TOTAL, _cacheMissTotal);
		} catch { }
	}, 2000); // 2s 合并写一次，避免高频写 globalState
}

function _markCacheHit() {
	_cacheHitTotal++;
	_statsDirty = true;
	_scheduleStatsFlush();
}

function _markCacheMiss() {
	_cacheMissTotal++;
	_statsDirty = true;
	_scheduleStatsFlush();
}

function getPersistentCacheStatsSnapshot() {
	return {
		hitTotal: _cacheHitTotal || 0,
		missTotal: _cacheMissTotal || 0
	};
}

// ============================================================================
// ★ 状态栏：永久显示 [qqq: ⏱2222h ▥33m ⊙98% ⚡P]
// ============================================================================
let statusBarItem = null;
let _statusBarTimer = null;

function _formatBytes(size) {
	if (size == null || isNaN(size)) return "?";
	const units = ["B", "KB", "MB", "GB"];
	let idx = 0;
	let val = size;
	while (val >= 1024 && idx < units.length - 1) {
		val /= 1024;
		idx++;
	}
	return `${val.toFixed(idx > 0 ? 2 : 0)} ${units[idx]}`;
}

function _formatHours(totalSeconds) {
	const h = totalSeconds / 3600;
	return `${h.toFixed(2)} h`;
}

function _formatCompactTime(totalSeconds) {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	return { h, m };
}

function getActiveEngineCode() {
	// P: Python daemon
	// R: Rust daemon
	// S: Shell daemon
	// N: Node/spawn fallback
	if (pythonBridge?.isAvailable()) return "P";
	if (rustBridge?.isAvailable()) return "R";
	if (shellBridge?.isAvailable()) return "S";
	return "N";
}

function getActiveEngineName() {
	const code = getActiveEngineCode();
	if (code === "P") return "Python";
	if (code === "R") return "Rust";
	if (code === "S") return "Shell";
	return "Node";
}

function _getTotalSecondsIncludingSession() {
	if (!extensionContext) return 0;
	const base = extensionContext.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
	const start = extensionContext.globalState.get(KEY_SESSION_START);
	if (!start) return base;
	const diff = (Date.now() - start) / 1000;
	return base + (diff > 0 ? diff : 0);
}

function updateStatusBarNow() {
	if (!statusBarItem) return;

	const totalSeconds = _getTotalSecondsIncludingSession();
	const { h, m } = _formatCompactTime(totalSeconds);

	// 磁盘缓存当前值：meta.stats.totalSize（正确口径）
	const stats = getCacheStatsSnapshot();
	const cacheBytes = stats.totalSize;
	const cacheMB = cacheBytes / (1024 * 1024);

	// 命中率永不清零：globalState 累计 hit/miss
	const pstats = getPersistentCacheStatsSnapshot();
	const denom = pstats.hitTotal + pstats.missTotal;
	const hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;

	// 你要的状态栏末尾只显示 P / R / N（Shell 归并显示 N；tooltip 再细分）
	const engineCode = getActiveEngineCode();
	const engineDisplay = (engineCode === "S") ? "N" : engineCode;

	statusBarItem.text = `[qqq: ⏱${h}h ▥${cacheMB.toFixed(0)}m ⊙${hitRate.toFixed(0)}% ⚡${engineDisplay}]`;

	const engineName = getActiveEngineName();
	const tooltip = new vscode.MarkdownString(
		[
			`**累计使用时间：** ${_formatHours(totalSeconds)}`,
			`**磁盘缓存：** ${_formatBytes(cacheBytes)}`,
			`**缓存命中率：** ${hitRate.toFixed(2)}%  (hit=${pstats.hitTotal}, miss=${pstats.missTotal})`,
			`**IO 引擎：** ${engineName}  （状态：${engineCode}）`,
		].join("\n\n")
	);
	tooltip.isTrusted = true;
	statusBarItem.tooltip = tooltip;
	statusBarItem.show();
}

function initUserTracking(context) {
	extensionContext = context;
	context.globalState.update(KEY_SESSION_START, Date.now());

	// 读取永不清零累计 hit/miss
	_loadPersistentStats(context);

	// 创建永久状态栏
	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
		statusBarItem.command = "qqq.allSettings";
		try { context.subscriptions.push(statusBarItem); } catch { }
	}

	updateStatusBarNow();

	// 定时刷新（低开销：5s）
	if (_statusBarTimer) clearInterval(_statusBarTimer);
	_statusBarTimer = setInterval(() => {
		try { updateStatusBarNow(); } catch { }
	}, 5000);
}

function finishUserTracking(context) {
	if (!context) return;
	const start = context.globalState.get(KEY_SESSION_START);
	if (start) {
		const diff = (Date.now() - start) / 1000;
		const old = context.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
		context.globalState.update(KEY_TOTAL_DURATION, old + (diff > 0 ? diff : 0));
		context.globalState.update(KEY_SESSION_START, undefined);
	}
	try { updateStatusBarNow(); } catch { }
}

// ---------- fingerprint ----------
function computeFingerprint(filePath) {
	try {
		const stat = fs.statSync(filePath);
		const size = stat.size;
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

		return crypto.createHash("md5").update(Buffer.concat(chunks)).digest("hex");
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
		brokenFiles: {}
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
	try {
		fs.writeFileSync(path.join(cacheDir, META_FILE_NAME), JSON.stringify(cacheMeta, null, 2));
	} catch (e) { }
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

// 兼容保留：仍然按 contentId 层面记一次 hit/miss（注意：若你既调用 getCacheEntry 又调用 getCachedBuffer，会双计数）
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

// 纯 meta 读取，不污染 hit/miss
function getCacheQualityMeta(contentId, quality) {
	const entry = cacheMeta?.entries?.[contentId];
	const qInfo = entry?.qualities?.[quality];
	return qInfo?.meta || null;
}

// 覆盖写统计不再漂；原子写 tmp->rename；按增量预留空间
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
		try { fs.unlinkSync(filePath + ".tmp"); } catch { }
		return null;
	}

	entry.qualities[quality] = { size: buffer.length, format: "webp_unified", meta: {} };
	entry.atime = Date.now();
	if (meta) Object.assign(entry.qualities[quality].meta, meta);

	if (!prev) cacheMeta.stats.fileCount++;
	cacheMeta.stats.totalSize = cacheMeta.stats.totalSize - prevSize + buffer.length;

	saveCacheMeta();

	try { updateStatusBarNow(); } catch { }

	return filePath;
}

// 在“按 quality 取文件内容”处记 hit/miss（真实命中口径）
// 同时把累计 hit/miss 写入 globalState（永不清零）
function getCachedBuffer(contentId, quality) {
	if (!cacheDir || !cacheMeta) return null;

	const entry = cacheMeta.entries[contentId];
	if (!entry?.qualities?.[quality]) {
		cacheMeta.stats.missCount++;
		_markCacheMiss();
		try { updateStatusBarNow(); } catch { }
		return null;
	}

	const fileName = `${contentId}.${quality}`;
	const filePath = path.join(cacheDir, fileName);

	try {
		if (fs.existsSync(filePath)) {
			entry.atime = Date.now();
			cacheMeta.stats.hitCount++;
			_markCacheHit();
			try { updateStatusBarNow(); } catch { }
			return fs.readFileSync(filePath);
		}
	} catch (e) { }

	cacheMeta.stats.missCount++;
	_markCacheMiss();

	delete entry.qualities[quality];
	if (Object.keys(entry.qualities).length === 0) {
		delete cacheMeta.entries[contentId];
	}
	saveCacheMeta();

	try { updateStatusBarNow(); } catch { }

	return null;
}

// ---------- daemon bridge ----------
class DaemonBridge {
	constructor(name, startFn) {
		this.name = name;
		this.startFn = startFn;
		this.process = null;
		this.pending = new Map();
		this.requestId = 0;
		this.isStarting = false;
		this.startPromise = null;
		this.restartCount = 0;
		this.maxRestarts = 3;
		this.available = null;
	}

	async start() {
		if (this.process && !this.process.killed) return true;
		if (this.isStarting) return this.startPromise;

		this.isStarting = true;
		this.startPromise = this.startFn(this);

		try {
			return await this.startPromise;
		} finally {
			this.isStarting = false;
			this.startPromise = null;
		}
	}

	setupProcess(proc, resolve) {
		this.process = proc;

		const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => {
			try {
				const result = JSON.parse(line);
				const id = result._id;

				if (result.error) logMessage(`${this.name} 错误响应: ${result.error}`, "WARN");

				if (this.pending.has(id)) {
					const { resolve: res, timer } = this.pending.get(id);
					clearTimeout(timer);
					this.pending.delete(id);
					res(result);
				}
			} catch (e) {
				logMessage(`${this.name} 解析响应失败: ${line}`, "ERROR");
			}
		});

		// stderr 降噪：同类 5 分钟只记一次
		proc.stderr.on("data", (d) => {
			const text = d?.toString?.() || "";
			const key = _bridgeStderrKey(this.name, text);
			logMessageRateLimited(key, `${this.name} stderr: ${text}`, "WARN", 5 * 60 * 1000);
		});

		proc.on("error", () => this._handleCrash());
		proc.on("close", () => this._handleCrash());

		setTimeout(async () => {
			try {
				const pong = await this.call("ping", {}, 2000);
				if (pong?.status === "alive") {
					this.restartCount = 0;
					this.available = true;
					logMessage(`${this.name} started`, "INFO");
					resolve(true);
					try { updateStatusBarNow(); } catch { }
				} else {
					this.available = false;
					resolve(false);
					try { updateStatusBarNow(); } catch { }
				}
			} catch (e) {
				this.available = false;
				resolve(false);
				try { updateStatusBarNow(); } catch { }
			}
		}, 100);
	}

	_handleCrash() {
		this.process = null;

		for (const [id, { resolve, timer }] of this.pending) {
			clearTimeout(timer);
			resolve({ error: "process_crashed" });
		}
		this.pending.clear();

		if (this.restartCount < this.maxRestarts) {
			this.restartCount++;
			setTimeout(() => this.start(), 500);
		} else {
			this.available = false;
		}

		try { updateStatusBarNow(); } catch { }
	}

	async call(action, params = {}, timeout = 5000) {
		if (this.available === false) return { error: `${this.name}_not_available` };

		if (!this.process || this.process.killed) {
			const started = await this.start();
			if (!started) return { error: `${this.name}_not_available` };
		}

		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					resolve({ error: "timeout" });
				}
			}, timeout);

			this.pending.set(id, { resolve, timer });

			try {
				this.process.stdin.write(cmd);
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ error: "write_error" });
			}
		});
	}

	isAvailable() {
		return this.available === true;
	}

	stop() {
		if (this.process && !this.process.killed) {
			try { this.process.kill(); } catch (e) { }
			this.process = null;
		}
	}
}

const pythonBridge = new DaemonBridge("Python", (bridge) => {
	return new Promise((resolve) => {
		const scriptPath = path.join(__dirname, "kp.py");
		if (!fs.existsSync(scriptPath)) {
			bridge.available = false;
			resolve(false);
			return;
		}
		try {
			const proc = cp.spawn("python", [scriptPath, "--daemon"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true
			});
			bridge.setupProcess(proc, resolve);
		} catch (e) {
			bridge.available = false;
			resolve(false);
		}
	});
});

const rustBridge = new DaemonBridge("Rust", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		const arch = process.arch;

		let filename;
		if (platform === "win32") filename = arch === "arm64" ? "q_win_arm64.exe" : "q_win_x64.exe";
		else if (platform === "darwin") filename = arch === "arm64" ? "q_mac_arm64" : "q_mac_x64";
		else filename = arch === "arm64" ? "q_linux_arm64" : "q_linux_x64";

		const candidates = [
			path.join(__dirname, "..", "assets", filename),
			path.join(__dirname, "assets", filename),
			path.join(__dirname, filename)
		];

		let exePath = null;
		for (const c of candidates) {
			if (fs.existsSync(c)) { exePath = c; break; }
		}

		if (!exePath) {
			bridge.available = false;
			resolve(false);
			return;
		}

		try {
			const proc = cp.spawn(exePath, ["--daemon"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true
			});
			bridge.setupProcess(proc, resolve);
		} catch (e) {
			bridge.available = false;
			resolve(false);
		}
	});
});

const shellBridge = new DaemonBridge("Shell", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		let proc;

		if (platform === "win32") {
			const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Process-Command {
  param($cmd)
  $result = @{ _id = $cmd._id }
  try {
    switch ($cmd.action) {
      'ping' { $result.status = 'alive' }
      'hasImage' { $result.value = [System.Windows.Forms.Clipboard]::ContainsImage() }
      'hasFiles' { $result.value = [System.Windows.Forms.Clipboard]::ContainsFileDropList() }
      'getFiles' { $files = [System.Windows.Forms.Clipboard]::GetFileDropList(); $result.files = @(); if ($files) { foreach ($f in $files) { $result.files += $f } } }
      'saveImage' { $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save($cmd.path, [System.Drawing.Imaging.ImageFormat]::Png); $result.success = $true } else { $result.success = $false } }
      default { $result.error = "unknown action" }
    }
  } catch { $result.error = $_.Exception.Message }
  return $result
}
while ($true) {
  $line = [Console]::In.ReadLine();
  if ($line -eq $null) { break };
  try { $cmd = ConvertFrom-Json $line; $result = Process-Command $cmd; $result | ConvertTo-Json -Compress | Write-Host }
  catch { @{ _id = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress | Write-Host }
}`.trim();
			proc = cp.spawn("powershell", ["-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true
			});
		} else {
			const bashScript = platform === "darwin" ? `
while IFS= read -r line; do
  action=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null);
  id=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('_id',0))" 2>/dev/null);
  case "$action" in
    ping) echo '{"_id":'$id',"status":"alive"}' ;;
    hasImage) if pngpaste - >/dev/null 2>&1; then echo '{"_id":'$id',"value":true}'; else echo '{"_id":'$id',"value":false}'; fi ;;
    saveImage) dest=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('path',''))" 2>/dev/null); if pngpaste "$dest" 2>/dev/null; then echo '{"_id":'$id',"success":true}'; else echo '{"_id":'$id',"success":false}'; fi ;;
    *) echo '{"_id":'$id',"error":"unknown action"}' ;;
  esac;
done`.trim() : `
while IFS= read -r line; do
  action=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null);
  id=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('_id',0))" 2>/dev/null);
  case "$action" in
    ping) echo '{"_id":'$id',"status":"alive"}' ;;
    hasImage) if xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -q "image/png"; then echo '{"_id":'$id',"value":true}'; else echo '{"_id":'$id',"value":false}'; fi ;;
    saveImage) dest=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('path',''))" 2>/dev/null); if xclip -selection clipboard -t image/png -o > "$dest" 2>/dev/null && [ -s "$dest" ]; then echo '{"_id":'$id',"success":true}'; else echo '{"_id":'$id',"success":false}'; fi ;;
    *) echo '{"_id":'$id',"error":"unknown action"}' ;;
  esac;
done`.trim();
			proc = cp.spawn("bash", ["-c", bashScript], { stdio: ["pipe", "pipe", "pipe"] });
		}

		bridge.setupProcess(proc, resolve);
	});
});

// ---------- io ----------
function ensureDir(dirPath) {
	if (!fs.existsSync(dirPath)) {
		try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { }
	}
}

async function handleClipboardFast() {
	try {
		const text = await vscode.env.clipboard.readText();
		if (text?.trim()) return { type: "text", text };
	} catch (e) { }
	return null;
}

async function handleClipboardSlow(targetDir) {
	if (pythonBridge.isAvailable()) {
		const res = await pythonBridge.call("clipboard", { target_dir: targetDir }, 10000);
		if (!res.error && res.type !== "unknown") return res;
	}
	if (rustBridge.isAvailable()) {
		const res = await rustBridge.call("clipboard", { target_dir: targetDir }, 10000);
		if (!res.error && res.type !== "unknown") return res;
	}
	if (shellBridge.isAvailable()) {
		const shellResult = await handleClipboardShell(targetDir);
		if (shellResult) return shellResult;
	}
	return handleClipboardSpawn(targetDir);
}

async function handleClipboardShell(targetDir) {
	if (process.platform !== "win32") return null;

	try {
		const hasFiles = await shellBridge.call("hasFiles", {}, 2000);
		if (hasFiles.value) {
			const filesRes = await shellBridge.call("getFiles", {}, 3000);
			const files = filesRes.files || [];

			const folders = files.filter(f => {
				try { return fs.statSync(f).isDirectory(); } catch { return false; }
			});
			if (folders.length) return { type: "folder_text", text: folders.join("\n") };

			const validFiles = files.filter(f => {
				try { return fs.existsSync(f) && !fs.statSync(f).isDirectory(); } catch { return false; }
			});

			if (validFiles.length > 0) {
				ensureDir(targetDir);
				const copied = copyFilesToTarget(validFiles, targetDir);
				if (copied.length === 1 && isImageExtForClipboard(path.extname(copied[0]))) {
					return { type: "image", path: copied[0] };
				}
				if (copied.length) return { type: "file", files: copied };
			}
		}

		const hasImg = await shellBridge.call("hasImage", {}, 2000);
		if (hasImg.value) {
			const fname = getTimestampFilename(".png");
			const dest = path.join(targetDir, fname);
			ensureDir(targetDir);
			const saved = await shellBridge.call("saveImage", { path: dest }, 5000);
			if (saved.success && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
				return { type: "image", path: dest };
			}
		}
	} catch (e) { }

	return null;
}

function copyFilesToTarget(files, targetDir) {
	const copied = [];
	for (const f of files) {
		try {
			const ext = path.extname(f);
			const isImg = isImageExtForClipboard(ext);
			const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
			const dest = path.join(targetDir, fname);
			fs.copyFileSync(f, dest);
			copied.push(dest);
		} catch (e) { }
	}
	return copied;
}

async function handleClipboardSpawn(targetDir) {
	const platform = process.platform;
	if (platform === "win32") return handleClipboardSpawnWin32(targetDir);
	if (platform === "darwin") return handleClipboardSpawnDarwin(targetDir);
	return handleClipboardSpawnLinux(targetDir);
}

async function handleClipboardSpawnWin32(targetDir) {
	const hasFiles = await spawnCheck("powershell", [
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsFileDropList()){\"1\"}else{\"0\"}"
	], "1");

	if (hasFiles) {
		const filesOutput = await spawnOutput("powershell", [
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
			"Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetFileDropList();if($f){foreach($i in $f){$i}}"
		]);

		const files = filesOutput.split(/\r?\n/).map(s => s.trim()).filter(s => s && fs.existsSync(s));

		const folders = files.filter(f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
		if (folders.length) return { type: "folder_text", text: folders.join("\n") };

		const validFiles = files.filter(f => { try { return !fs.statSync(f).isDirectory(); } catch { return false; } });
		if (validFiles.length) {
			ensureDir(targetDir);
			const copied = copyFilesToTarget(validFiles, targetDir);
			if (copied.length === 1 && isImageExtForClipboard(path.extname(copied[0]))) {
				return { type: "image", path: copied[0] };
			}
			if (copied.length) return { type: "file", files: copied };
		}
	}

	const hasImg = await spawnCheck("powershell", [
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsImage()){\"1\"}else{\"0\"}"
	], "1");

	if (hasImg) {
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);
		ensureDir(targetDir);

		const escapedPath = dest.replace(/'/g, "''");
		const saved = await spawnCheck("powershell", [
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
			`Add-Type -A System.Windows.Forms;Add-Type -A System.Drawing;$img=[System.Windows.Forms.Clipboard]::GetImage();if($img){$img.Save('${escapedPath}',[System.Drawing.Imaging.ImageFormat]::Png);'OK'}else{'FAIL'}`
		], "OK");

		if (saved && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
			return { type: "image", path: dest };
		}
	}

	return { type: "unknown" };
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
				} catch (e2) { }
			}

			if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
				return { type: "image", path: dest };
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
			return { type: "image", path: dest };
		}

		if (fs.existsSync(dest)) {
			try { fs.unlinkSync(dest); } catch { }
		}
	} catch (e) { }

	return { type: "unknown" };
}

function spawnCheck(cmd, args, expected) {
	return new Promise(resolve => {
		const child = cp.spawn(cmd, args, { windowsHide: true });
		let output = "";
		let errorOutput = "";

		child.stdout.on("data", d => output += d.toString().trim());
		child.stderr.on("data", d => errorOutput += d.toString().trim());

		child.on("close", (code) => {
			if (code !== 0 && errorOutput) {
				logMessageRateLimited(
					`spawnCheck:${cmd}:${code}:${errorOutput.slice(0, 120)}`,
					`${cmd} 执行失败 (exit ${code}): ${errorOutput}`,
					"WARN",
					2 * 60 * 1000
				);
			}
			resolve(output.includes(expected));
		});

		child.on("error", (err) => {
			logMessage(`${cmd} 启动失败: ${err.message}`, "ERROR");
			resolve(false);
		});

		setTimeout(() => {
			try { child.kill(); } catch { }
			logMessageRateLimited(`spawnCheckTimeout:${cmd}`, `${cmd} 执行超时`, "WARN", 2 * 60 * 1000);
			resolve(false);
		}, 5000);
	});
}

function spawnOutput(cmd, args) {
	return new Promise(resolve => {
		const child = cp.spawn(cmd, args, { windowsHide: true });
		let output = "";
		let errorOutput = "";

		child.stdout.on("data", d => output += d.toString());
		child.stderr.on("data", d => errorOutput += d.toString());

		child.on("close", (code) => {
			if (code !== 0 && errorOutput) {
				logMessageRateLimited(
					`spawnOutput:${cmd}:${code}:${errorOutput.slice(0, 120)}`,
					`${cmd} 执行失败 (exit ${code}): ${errorOutput}`,
					"WARN",
					2 * 60 * 1000
				);
			}
			resolve(output);
		});

		child.on("error", (err) => {
			logMessage(`${cmd} 启动失败: ${err.message}`, "ERROR");
			resolve("");
		});

		setTimeout(() => {
			try { child.kill(); } catch { }
			logMessageRateLimited(`spawnOutputTimeout:${cmd}`, `${cmd} 执行超时`, "WARN", 2 * 60 * 1000);
			resolve("");
		}, 5000);
	});
}

// ---------- folder info ----------
async function getFolderInfo(folderPath) {
	if (pythonBridge.isAvailable()) {
		const res = await pythonBridge.call("folder_info", { path: folderPath }, 15000);
		if (!res.error) return res;
	}
	if (rustBridge.isAvailable()) {
		const res = await rustBridge.call("folder_info", { path: folderPath }, 15000);
		if (!res.error) return res;
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
					} catch (e) { }
				}
			}
		} catch (e) { }
	}

	await walk(folderPath);

	return {
		success: true,
		total_size: totalSize,
		file_count_root: fileCount,
		ext_stats: extStats
	};
}

// ---------- utils ----------
function getTimestampFilename(ext) {
	const now = new Date();
	const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
	const time = now.toTimeString().slice(0, 8).replace(/:/g, ".");
	const day = now.getDay() || 7;
	const ms = String(now.getMilliseconds()).padStart(3, "0");

	const excluded = new Set(["l", "i", "s", "a", "m", "c", "b", "f", "t"]);
	const valid = "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
		.split("")
		.filter(c => !excluded.has(c.toLowerCase()));

	const c1 = valid[Math.floor(Math.random() * valid.length)];
	let c2 = valid[Math.floor(Math.random() * valid.length)];

	if (c1.toLowerCase() === "g") {
		const noG = valid.filter(c => c.toLowerCase() !== "g");
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

// ---------- pending ----------
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

// ---------- qqq.pure ----------
async function pureCommand() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage("请先打开一个文件");
		return;
	}

	const docPath = editor.document.uri.fsPath;
	const parentDir = path.dirname(docPath);
	const qqqDir = path.join(parentDir, "qqq");

	if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) {
		vscode.window.showInformationMessage("当前目录下没有 qqq 文件夹");
		return;
	}

	let qqqFiles = [];
	try {
		qqqFiles = fs.readdirSync(qqqDir).filter(f => fs.statSync(path.join(qqqDir, f)).isFile());
	} catch (e) {
		vscode.window.showErrorMessage("读取 qqq 目录失败");
		return;
	}

	if (!qqqFiles.length) {
		vscode.window.showInformationMessage("qqq 文件夹是空的");
		return;
	}

	const referencedFiles = new Set();
	let parentFiles = [];

	try {
		parentFiles = fs.readdirSync(parentDir);
	} catch (e) {
		return;
	}

	// ★ 直接复用全局正则（带 gi + 捕获组）；每文件重置 lastIndex
	const regex = QQQ_PATH_REGEX;

	for (const fileName of parentFiles) {
		const fullPath = path.join(parentDir, fileName);
		if (fileName === "qqq" || fileName === "qqq.pure") continue;

		try { if (!fs.statSync(fullPath).isFile()) continue; } catch { continue; }
		if (isLikelyBinary(fullPath)) continue;

		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			let match;
			regex.lastIndex = 0;

			while ((match = regex.exec(content))) {
				const rawPath = (match[1] || "").trim();

				let absPath = path.isAbsolute(rawPath) ? rawPath : path.join(parentDir, rawPath);
				absPath = absPath.replace(/\//g, "\\");

				if (absPath.toLowerCase().startsWith(qqqDir.toLowerCase())) {
					referencedFiles.add(path.basename(absPath).toLowerCase());
				}
			}
		} catch (e) { }
	}

	const orphans = qqqFiles.filter(f => !referencedFiles.has(f.toLowerCase()));

	if (!orphans.length) {
		vscode.window.showInformationMessage("未发现孤儿文件");
		return;
	}

	const orphanPaths = orphans.map(f => path.join(qqqDir, f));
	const cmdStr = os.platform() === "win32"
		? `del ${orphanPaths.map(p => `"${p}"`).join(" ")}`
		: `rm ${orphanPaths.map(p => `"${p}"`).join(" ")}`;

	let content = "\n".repeat(13) + " 请在终端中执行下面命令：\n\n\n " + cmdStr + "\n\n\n";
	content += orphanPaths.map(p => `/\\${p}\\/`).join("\n\n\n\n\n");

	const purePath = path.join(parentDir, "qqq.pure");

	try {
		fs.writeFileSync(purePath, content, "utf-8");
		const doc = await vscode.workspace.openTextDocument(purePath);
		await vscode.window.showTextDocument(doc);
	} catch (e) {
		vscode.window.showErrorMessage("无法生成 qqq.pure 文件");
	}
}

function isLikelyBinary(filePath) {
	if (BINARY_EXTS.has(path.extname(filePath).toLowerCase())) return true;

	try {
		const buf = Buffer.alloc(4096);
		const fd = fs.openSync(filePath, "r");
		try {
			const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
			for (let i = 0; i < bytesRead; i++) {
				if (buf[i] === 0) return true;
			}
			return false;
		} finally {
			fs.closeSync(fd);
		}
	} catch (e) {
		return true;
	}
}

// ---------- extension activate/deactivate ----------
let q1Module = null;
let q2Module = null;

async function activate(context) {
	logMessage("qqq 扩展激活（中控模式）...", "INFO");

	extensionContext = context;
	initCache(context);

	LOG_PATH = path.join(cacheDir, "err.log");

	initUserTracking(context);

	startDaemons();

	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.pure", pureCommand),
		vscode.commands.registerCommand("qqq.allSettings", () => {
			vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
		})
	);

	loadSubModules(context);

	logMessage("qqq 扩展激活完成", "INFO");
}

function startDaemons() {
	pythonBridge.start().then(ok => {
		if (ok) {
			logMessage("Python Bridge OK", "INFO");
		} else {
			rustBridge.start().then(ok2 => {
				if (ok2) {
					logMessage("Rust Bridge OK", "INFO");
				} else {
					shellBridge.start().then(ok3 => {
						if (ok3) logMessage("Shell Bridge OK", "INFO");
						else logMessage("All daemons failed, using spawn fallback", "WARN");
						try { updateStatusBarNow(); } catch { }
					});
				}
			});
		}
	});
}

function loadSubModules(context) {
	try {
		q1Module = require("./q1");
		if (q1Module?.activate) q1Module.activate(context);
	} catch (e) {
		logMessage(`q1 加载失败: ${e.message}`, "ERROR");
	}

	try {
		q2Module = require("./q2");
		if (q2Module?.activate) q2Module.activate(context);
	} catch (e) {
		logMessage(`q2 加载失败: ${e.message}`, "ERROR");
	}
}

async function deactivate() {
	pythonBridge.stop();
	rustBridge.stop();
	shellBridge.stop();

	// 退出前先结算时长
	finishUserTracking(extensionContext);

	// ★ 退出前强制写入累计 hit/miss（防最后 2s 合并写未触发）
	try {
		if (extensionContext) {
			extensionContext.globalState.update(KEY_CACHE_HIT_TOTAL, _cacheHitTotal);
			extensionContext.globalState.update(KEY_CACHE_MISS_TOTAL, _cacheMissTotal);
		}
	} catch { }

	// ★ 清理累计统计 flush 定时器
	try {
		if (_statsFlushTimer) clearTimeout(_statsFlushTimer);
		_statsFlushTimer = null;
		_statsDirty = false;
	} catch { }

	// 退出前再校验一次，防 meta 漂移
	try { validateCache(); } catch (e) { }
	saveCacheMeta();

	if (q1Module?.deactivate) {
		try { await q1Module.deactivate(); } catch (e) { }
	}

	// 清理状态栏定时器
	try {
		if (_statusBarTimer) clearInterval(_statusBarTimer);
		_statusBarTimer = null;
		if (statusBarItem) statusBarItem.dispose();
		statusBarItem = null;
	} catch { }

	logMessage("qqq 扩展已停用", "INFO");
}

module.exports = {
	activate,
	deactivate,

	QQQ_PATH_REGEX,
	PENDING_REGEX,

	LOG_PATH,
	ffmpegPath,
	ffprobePath,

	logMessage,
	logMessageRateLimited,

	computeFingerprint,

	initCache,
	validateCache,

	getCacheEntry,
	getCacheQualityMeta,
	getCacheStatsSnapshot,
	getPersistentCacheStatsSnapshot, // ★ 永不清零累计 hit/miss（只读快照）

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

	initUserTracking,
	finishUserTracking,

	// 双 scheduler
	probeScheduler,
	genScheduler,

	// 状态栏/引擎识别（给 q1/其他模块复用）
	getActiveEngineCode,
	getActiveEngineName,
	updateStatusBarNow,
};

process.on("uncaughtException", (error) => {
	const stack = error.stack || "";
	if (stack.includes("qqq")) {
		logMessage(`未捕获的异常: ${error.message}\n${error.stack}`, "ERROR");
	}
});

process.on("unhandledRejection", (reason) => {
	const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
	if (msg.includes("qqq")) {
		logMessage(`未处理的Promise拒绝: ${msg}`, "ERROR");
	}
});

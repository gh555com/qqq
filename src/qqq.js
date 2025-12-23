// src/qqq.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const readline = require("readline");
const crypto = require("crypto");

const q1a = require("./q1a");

let LOG_PATH = null;
const outputChannel = vscode.window.createOutputChannel("qqq extension");

// ============================================================================
// ★ 全局唯一真理来源：路径暗号 + 捕获组（match[1] 就是内部路径）
// ============================================================================
const QQQ_PATH_REGEX = /\/\\\s*([\s\S]*?qqq[\s\S]*?)\s*\\\//gi;
const PENDING_REGEX = /\/\\__PENDING__:([a-zA-Z0-9]+)__\\\//g;

const CACHE_DIR_NAME = "qqq_cache";
const META_FILE_NAME = "meta.json";
const CACHE_MAX_SIZE = 40 * 1024 * 1024;
const CACHE_TARGET_SIZE = 28 * 1024 * 1024;

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

function _bridgeStderrKey(name, text) {
	const head = String(text || "").replace(/\s+/g, " ").slice(0, 120);
	return `bridge:${name}:${head}`;
}

function rotateLogIfNeeded() {
	if (!LOG_PATH) return;

	try {
		const maxLogSize = 8 * 1024 * 1024; // 8MB
		if (fs.existsSync(LOG_PATH)) {
			const stats = fs.statSync(LOG_PATH);
			if (stats.size >= maxLogSize) {
				const oldLogPath = `${LOG_PATH}.1`;
				if (fs.existsSync(oldLogPath)) {
					fs.unlinkSync(oldLogPath);
				}
				fs.renameSync(LOG_PATH, oldLogPath);
			}
		}
	} catch (e) {
		// 日志轮转失败不影响主程序
	}
}

function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}`;
	outputChannel.appendLine(line);

	if ((level === "ERROR" || level === "WARN") && LOG_PATH) {
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

			// 检查并执行日志轮转
			rotateLogIfNeeded();

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

// ============================================================================
// ★ 永不清零统计：全部写 VSCode globalState（累计 hit/miss、累计使用时间）
// ============================================================================
const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
const KEY_SESSION_START = "qqq_stats_session_start";
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
	}, 2000);
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
		missTotal: _cacheMissTotal || 0,
	};
}

// ============================================================================
// ★ 状态栏：永久显示 [qqq: ⏱2222h ▥33m ⊙98% ⚡P]
// - Node：N(D)=daemon / N(S)=spawn
// - Python：P
// - Rust：R
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

// -----------------------------
// ★ IO 引擎策略：严格按用户配置选择（shell 选项已废弃：当成 node）
// -----------------------------
function getEnginePreference() {
	try {
		const config = vscode.workspace.getConfiguration("qqq");
		const v = config.get("ioEngine", "auto");
		// 兼容老配置：shell 当成 node
		if (v === "shell") return "node";
		return v;
	} catch {
		return "auto";
	}
}

function getEngineTryOrder(pref) {
	// 内部实现仍用 shellBridge 表示 “node 的 daemon”
	switch (pref) {
		case "python":
			return ["python", "rust", "shell", "spawn"]; // python -> rust -> node(daemon) -> spawn
		case "rust":
			return ["rust", "python", "shell", "spawn"]; // rust -> python -> node(daemon) -> spawn
		case "node":
			return ["shell", "spawn"]; // node：无条件先起 shell daemon，失败就 spawn
		case "auto":
		default:
			return ["python", "rust", "shell", "spawn"];
	}
}

function _nodeModeFromShellAvail() {
	// D = daemon, S = spawn
	return shellBridge?.isAvailable?.() === true ? "D" : "S";
}

function getActiveEngineState() {
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

	const py = pythonBridge?.isAvailable?.() === true;
	const rs = rustBridge?.isAvailable?.() === true;
	const sh = shellBridge?.isAvailable?.() === true;

	const pickByOrder = () => {
		for (const e of order) {
			if (e === "python" && py) return { code: "P", name: "Python" };
			if (e === "rust" && rs) return { code: "R", name: "Rust" };
			if (e === "shell") {
				const mode = sh ? "D" : "S";
				return { code: "N", nodeMode: mode, name: mode === "D" ? "Node (Shell daemon)" : "Node (Node spawn)" };
			}
			if (e === "spawn") {
				return { code: "N", nodeMode: "S", name: "Node (Node spawn)" };
			}
		}
		// 兜底
		const mode = sh ? "D" : "S";
		return { code: "N", nodeMode: mode, name: mode === "D" ? "Node (Shell daemon)" : "Node (Node spawn)" };
	};

	return pickByOrder();
}

function getActiveEngineCode() {
	return getActiveEngineState().code; // P / R / N
}

function getActiveEngineName() {
	return getActiveEngineState().name; // Python / Rust / Node(...)
}

function _getTotalSecondsIncludingSession() {
	if (!extensionContext) return 0;
	const base = extensionContext.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
	const start = extensionContext.globalState.get(KEY_SESSION_START);
	if (!start) return base;
	const diff = (Date.now() - start) / 1000;
	return base + (diff > 0 ? diff : 0);
}

function _cleanReason(s, maxLen = 260) {
	const t = String(s || "").replace(/\s+/g, " ").trim();
	return t.length > maxLen ? t.slice(0, maxLen) + "..." : t;
}

function _collectMismatchReasons(pref, activeState) {
	const reasons = [];

	const pyReason = _cleanReason(pythonBridge?.lastStartError || pythonBridge?.lastCrashReason || pythonBridge?.lastStderrSnippet);
	const rsReason = _cleanReason(rustBridge?.lastStartError || rustBridge?.lastCrashReason || rustBridge?.lastStderrSnippet);
	const shReason = _cleanReason(shellBridge?.lastStartError || shellBridge?.lastCrashReason || shellBridge?.lastStderrSnippet);

	// Node spawn 代表 shell daemon 没起来：必须带上 shell 原因
	if (activeState.code === "N" && activeState.nodeMode === "S") {
		if (shReason) reasons.push(`Shell daemon：${shReason}`);
		else reasons.push(`Shell daemon：启动失败/不可用`);
	}

	if (pref === "python" && activeState.code !== "P") {
		if (pyReason) reasons.unshift(`Python：${pyReason}`);
		else reasons.unshift(`Python：启动失败/不可用`);
		if (activeState.code === "N") {
			if (rsReason) reasons.push(`Rust：${rsReason}`);
			else reasons.push(`Rust：启动失败/不可用`);
		}
	}

	if (pref === "rust" && activeState.code !== "R") {
		if (rsReason) reasons.unshift(`Rust：${rsReason}`);
		else reasons.unshift(`Rust：启动失败/不可用`);
		if (activeState.code === "N") {
			if (pyReason) reasons.push(`Python：${pyReason}`);
			else reasons.push(`Python：启动失败/不可用`);
		}
	}

	// auto 不是“期待不一致”，但如果最终落到 Node，也可以把失败原因露出来（不强制）
	return reasons;
}

function updateStatusBarNow() {
	if (!statusBarItem) return;

	const totalSeconds = _getTotalSecondsIncludingSession();
	const { h, m } = _formatCompactTime(totalSeconds);

	const stats = getCacheStatsSnapshot();
	const cacheBytes = stats.totalSize;
	const cacheMB = cacheBytes / (1024 * 1024);

	const pstats = getPersistentCacheStatsSnapshot();
	const denom = pstats.hitTotal + pstats.missTotal;
	const hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;

	const pref = getEnginePreference();
	const active = getActiveEngineState();

	const engineTag =
		active.code === "P"
			? "P"
			: active.code === "R"
				? "R"
				: `N(${active.nodeMode || _nodeModeFromShellAvail()})`;

	statusBarItem.text = `[qqq: ⏱${h}h ▥${cacheMB.toFixed(0)}m ⊙${hitRate.toFixed(0)}% ⚡${engineTag}]`;

	// tooltip：纯白背景 + 只保留 IO 引擎（实际使用）
	const mismatchReasons = _collectMismatchReasons(pref, active);
	let mismatchText = "";
	if ((pref === "python" && active.code !== "P") || (pref === "rust" && active.code !== "R")) {
		const expectedName = pref === "python" ? "Python" : "Rust";
		const reasonStr = mismatchReasons.length ? mismatchReasons.join("；") : "未知原因";
		mismatchText = ` ▬ 期待值${expectedName}，启动失败原因：${reasonStr}`;
	}

	const ioLine = `**IO 引擎：** ${active.name}${mismatchText}`;

	const tooltip = new vscode.MarkdownString(
		[
			`<div style="background:#fff !important; color:#000 !important; padding:8px; border-radius:4px; border:1px solid #ddd;">`,
			`**累计使用时间：** ${_formatHours(totalSeconds)}`,
			`**磁盘缓存：** ${_formatBytes(cacheBytes)}`,
			`**缓存命中率：** ${hitRate.toFixed(2)}%  (hit=${pstats.hitTotal}, miss=${pstats.missTotal})`,
			ioLine,
			`</div>`,
		].join("\n\n")
	);
	tooltip.isTrusted = true;
	tooltip.supportHtml = true;

	statusBarItem.tooltip = tooltip;
	statusBarItem.show();
}

function initUserTracking(context) {
	extensionContext = context;
	context.globalState.update(KEY_SESSION_START, Date.now());

	_loadPersistentStats(context);

	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
		statusBarItem.command = "qqq.allSettings";
		try {
			context.subscriptions.push(statusBarItem);
		} catch { }
	}

	updateStatusBarNow();

	if (_statusBarTimer) clearInterval(_statusBarTimer);
	_statusBarTimer = setInterval(() => {
		try {
			updateStatusBarNow();
		} catch { }
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
	try {
		updateStatusBarNow();
	} catch { }
}

// ---------- task queue ----------
class TaskQueue {
	constructor() {
		this.queue = [];
		this.running = false;
	}

	enqueue(task) {
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
			this.processNext();
		});
	}

	async processNext() {
		if (this.running || this.queue.length === 0) return;
		this.running = true;
		const { task, resolve, reject } = this.queue.shift();
		try {
			const result = await task();
			resolve(result);
		} catch (e) {
			reject(e);
		} finally {
			this.running = false;
			this.processNext();
		}
	}
}

const _pasteQueue = new TaskQueue();

// ---------- fingerprint ----------
const _fingerprintCache = new Map();
// 简单的内存指纹数据库：fingerprint -> filePath (relative to workspace or absolute)
// 注意：为了跨会话持久化，这个Map理想情况下应该从 meta.json 加载或初始化
// 这里暂时只做内存级，作为“真理源”的缓存层
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
	try {
		updateStatusBarNow();
	} catch { }

	return filePath;
}

function getCachedBuffer(contentId, quality) {
	if (!cacheDir || !cacheMeta) return null;

	const entry = cacheMeta.entries[contentId];
	if (!entry?.qualities?.[quality]) {
		cacheMeta.stats.missCount++;
		_markCacheMiss();
		try {
			updateStatusBarNow();
		} catch { }
		return null;
	}

	const fileName = `${contentId}.${quality}`;
	const filePath = path.join(cacheDir, fileName);

	try {
		if (fs.existsSync(filePath)) {
			entry.atime = Date.now();
			cacheMeta.stats.hitCount++;
			_markCacheHit();
			try {
				updateStatusBarNow();
			} catch { }
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

	try {
		updateStatusBarNow();
	} catch { }

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

		this._stopping = false;

		// ★ 失败原因收集（用于 tooltip + err.log）
		this.lastStartError = "";
		this.lastCrashReason = "";
		this.lastStderrSnippet = "";
	}

	_setStartError(msg) {
		this.lastStartError = _cleanReason(msg || "");
	}

	_appendStderrSnippet(text) {
		const t = String(text || "").trim();
		if (!t) return;
		const next = (this.lastStderrSnippet ? this.lastStderrSnippet + "\n" : "") + t;
		this.lastStderrSnippet = next.slice(-2000);
	}

	async start() {
		logMessage(`${this.name} start 方法被调用`, "DEBUG");

		this._stopping = false;

		if (this.process && !this.process.killed) {
			logMessage(`${this.name} 进程已存在且未被杀死，返回true`, "DEBUG");
			return true;
		}
		if (this.isStarting) {
			logMessage(`${this.name} 正在启动中，返回启动Promise`, "DEBUG");
			return this.startPromise;
		}

		this.isStarting = true;
		this.startPromise = this.startFn(this);

		logMessage(`${this.name} 开始执行启动函数`, "DEBUG");

		try {
			const result = await this.startPromise;
			logMessage(`${this.name} 启动函数执行完成，结果: ${result}`, "DEBUG");
			return result;
		} finally {
			this.isStarting = false;
			this.startPromise = null;
		}
	}

	setupProcess(proc, resolve) {
		this.process = proc;

		logMessage(`${this.name} setupProcess called`, "DEBUG");

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
				// 非JSON输出，可能是Python脚本的调试输出或错误信息
				logMessage(`${this.name} stdout: ${line}`, "WARN");
			}
		});

		proc.stderr.on("data", (d) => {
			const text = d?.toString?.() || "";
			this._appendStderrSnippet(text);
			const key = _bridgeStderrKey(this.name, text);
			logMessageRateLimited(key, `${this.name} stderr: ${text}`, "WARN", 5 * 60 * 1000);
		});

		proc.on("error", (err) => {
			logMessage(`${this.name} 进程错误: ${err.message}`, "ERROR");
			this.lastCrashReason = _cleanReason(err.message);
			this._handleCrash();
		});
		proc.on("close", (code) => {
			logMessage(`${this.name} 进程关闭，退出码: ${code}`, "INFO");
			this.lastCrashReason = _cleanReason(`exit_code=${code}`);
			this._handleCrash();
		});

		// 实现ping重试逻辑，最多重试3次
		let pingAttempts = 0;
		const maxPingAttempts = 3;
		const pingInterval = 500; // 每次ping间隔500ms
		const pingTimeout = 5000; // 增加ping超时时间到5秒

		const attemptPing = async () => {
			pingAttempts++;
			try {
				logMessage(`${this.name} 发送 ping 请求 (尝试 ${pingAttempts}/${maxPingAttempts})`, "DEBUG");
				const pong = await this.call("ping", {}, pingTimeout);
				logMessage(`${this.name} ping 响应: ${JSON.stringify(pong)}`, "DEBUG");
				if (pong?.status === "alive") {
					this.restartCount = 0;
					this.available = true;
					this._setStartError("");
					logMessage(`${this.name} started`, "INFO");
					resolve(true);
					try { updateStatusBarNow(); } catch { }
					return true;
				}
			} catch (e) {
				logMessage(`${this.name} ping 超时 (尝试 ${pingAttempts}/${maxPingAttempts}): ${e.message}`, "DEBUG");
			}

			// 如果还有重试机会，继续尝试
			if (pingAttempts < maxPingAttempts) {
				setTimeout(attemptPing, pingInterval);
				return;
			}

			// 所有ping尝试都失败
			const reason = `ping_failed_after_${maxPingAttempts}_attempts${this.lastStderrSnippet ? ` ; stderr=${this.lastStderrSnippet}` : ""}`;
			this._setStartError(reason);
			logMessage(`${this.name} ping 失败，已尝试 ${maxPingAttempts} 次`, "WARN");
			this.available = false;
			resolve(false);
			try { updateStatusBarNow(); } catch { }
		};

		// 启动ping尝试，增加初始延迟到500ms，给进程更多启动时间
		setTimeout(attemptPing, 500);
	}

	_handleCrash() {
		logMessage(`${this.name} _handleCrash 方法被调用`, "DEBUG");
		this.process = null;

		for (const [id, { resolve, timer }] of this.pending) {
			logMessage(`${this.name} 清理待处理请求，id: ${id}`, "DEBUG");
			clearTimeout(timer);
			resolve({ error: "process_crashed" });
		}
		this.pending.clear();

		if (this._stopping) {
			logMessage(`${this.name} stopping=true，忽略自动重启`, "INFO");
			this.available = false;
			try { updateStatusBarNow(); } catch { }
			return;
		}

		if (this.restartCount < this.maxRestarts) {
			this.restartCount++;
			logMessage(`${this.name} 进程崩溃，尝试重启 (${this.restartCount}/${this.maxRestarts})`, "WARN");
			setTimeout(() => this.start(), 500);
		} else {
			logMessage(`${this.name} 进程崩溃，达到最大重启次数，标记为不可用`, "ERROR");
			this.available = false;
		}

		try { updateStatusBarNow(); } catch { }
	}

	async call(action, params = {}, timeout = 5000) {
		logMessage(`${this.name} call 方法被调用，action: ${action}`, "DEBUG");
		// 允许再尝试启动/重启（尤其是 cold start/ping race）
		if (this.available === false) {
			// 如果进程还活着，给一次机会重新 ping/start
			this.available = null;
		}

		if (!this.process || this.process.killed) {
			logMessage(`${this.name} 进程不存在或已被杀死，尝试启动`, "DEBUG");
			const started = await this.start();
			if (!started) {
				logMessage(`${this.name} 启动失败，返回错误`, "DEBUG");
				return { error: `${this.name}_not_available` };
			}
		}

		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";

		logMessage(`${this.name} 发送命令: ${cmd}`, "DEBUG");

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				logMessage(`${this.name} 命令超时，id: ${id}`, "DEBUG");
				if (this.pending.has(id)) {
					this.pending.delete(id);
					resolve({ error: "timeout" });
				}
			}, timeout);

			this.pending.set(id, { resolve, timer });

			try {
				this.process.stdin.write(cmd);
				logMessage(`${this.name} 命令写入成功，id: ${id}`, "DEBUG");
			} catch (e) {
				logMessage(`${this.name} 命令写入失败: ${e.message}, id: ${id}`, "ERROR");
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
		logMessage(`${this.name} stop 方法被调用`, "DEBUG");

		this._stopping = true;

		for (const [id, { resolve, timer }] of this.pending) {
			clearTimeout(timer);
			resolve({ error: "stopped" });
		}
		this.pending.clear();

		if (this.process && !this.process.killed) {
			logMessage(`${this.name} 进程存在且未被杀死，尝试终止进程`, "DEBUG");
			try {
				this.process.kill();
				logMessage(`${this.name} 进程终止命令已发送`, "DEBUG");
			} catch (e) {
				logMessage(`${this.name} 进程终止失败: ${e.message}`, "ERROR");
			}
		} else {
			logMessage(`${this.name} 进程不存在或已被杀死`, "DEBUG");
		}

		this.process = null;
		this.available = false;
		this.restartCount = 0;

		try { updateStatusBarNow(); } catch { }
	}
}

// Python bridge：优先 python，其次 python3（非 win32）
// 改进：即使缺少某些依赖也要尽量启动Python引擎，依赖缺失在实际使用时再回退
const pythonBridge = new DaemonBridge("Python", (bridge) => {
	return new Promise((resolve) => {
		const scriptPath = path.join(__dirname, "kp.py");
		if (!fs.existsSync(scriptPath)) {
			bridge._setStartError(`kp.py 不存在：${scriptPath}`);
			bridge.available = false;
			resolve(false);
			return;
		}

		const spawnWith = (bin) => {
			return new Promise((res) => {
				let proc;
				try {
					proc = cp.spawn(bin, [scriptPath, "--daemon"], {
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
					});
				} catch (e) {
					const msg = `spawn_fail(${bin}): ${e.message}`;
					bridge._setStartError(msg);
					logMessage(`Python bridge 启动失败 (${bin}): ${e.message}`, "WARN");
					res(false);
					return;
				}

				let settled = false;
				const failFast = () => {
					if (settled) return;
					settled = true;
					try { proc.kill(); } catch { }
					bridge.available = false;
					res(false);
				};

				proc.once("error", (err) => {
					const msg = `process_error(${bin}): ${err.message}`;
					bridge._setStartError(msg);
					logMessage(`Python bridge 进程错误 (${bin}): ${err.message}`, "WARN");
					failFast();
				});

				bridge.setupProcess(proc, (ok) => {
					if (settled) return;
					settled = true;
					if (!ok && bridge.lastStartError) {
						logMessage(`Python Bridge 启动失败原因：${bridge.lastStartError}`, "WARN");
					}
					res(!!ok);
				});
			});
		};

		(async () => {
			const ok1 = await spawnWith("python");
			if (ok1) {
				logMessage("Python Bridge 使用 python 启动成功", "INFO");
				resolve(true);
				return;
			}

			if (process.platform !== "win32") {
				const ok2 = await spawnWith("python3");
				if (ok2) {
					logMessage("Python Bridge 使用 python3 启动成功", "INFO");
					resolve(true);
					return;
				}
			}

			logMessage(`Python Bridge 启动失败，所有尝试均已失败：${bridge.lastStartError || "unknown"}`, "WARN");
			resolve(false);
		})().catch((e) => {
			bridge._setStartError(`start_exception: ${e.message}`);
			logMessage(`Python Bridge 启动异常: ${e.message}`, "ERROR");
			resolve(false);
		});
	});
});

// Rust bridge：改进错误处理和日志记录
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
			path.join(__dirname, filename),
		];

		let exePath = null;
		for (const c of candidates) {
			if (fs.existsSync(c)) { exePath = c; break; }
		}

		if (!exePath) {
			bridge._setStartError(`exe_not_found: ${filename}`);
			logMessage("Rust Bridge 可执行文件未找到", "WARN");
			bridge.available = false;
			resolve(false);
			return;
		}

		try {
			logMessage(`Rust Bridge 尝试启动: ${exePath}`, "INFO");
			const proc = cp.spawn(exePath, ["--daemon"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			proc.once("error", (err) => {
				bridge._setStartError(`process_error: ${err.message}`);
				logMessage(`Rust Bridge 进程错误: ${err.message}`, "WARN");
				bridge.available = false;
				resolve(false);
			});

			bridge.setupProcess(proc, (ok) => {
				if (ok) {
					logMessage("Rust Bridge 启动成功", "INFO");
					resolve(true);
				} else {
					logMessage(`Rust Bridge 启动失败原因：${bridge.lastStartError || "unknown"}`, "WARN");
					resolve(false);
				}
			});
		} catch (e) {
			bridge._setStartError(`start_exception: ${e.message}`);
			logMessage(`Rust Bridge 启动异常: ${e.message}`, "ERROR");
			bridge.available = false;
			resolve(false);
		}
	});
});

// ★ Shell bridge：用于 Node 模式的 daemon（跨平台）
// - Windows：PowerShell + STA + Clipboard
// - mac/linux：bash + node 解析 JSON（不依赖 python3）
// ★ 修正：Windows 分支不再发生 proc 遮蔽
const shellBridge = new DaemonBridge("Shell", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		let proc = null;

		if (platform === "win32") {
			const simplePsScript = `
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
      'getFiles' {
        $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
        $result.files = @()
        if ($files) { foreach ($f in $files) { $result.files += $f } }
      }
      'saveImage' {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img) { $img.Save($cmd.path, [System.Drawing.Imaging.ImageFormat]::Png); $result.success = $true }
        else { $result.success = $false }
      }
      default { $result.error = "unknown action" }
    }
  } catch {
    $result.error = $_.Exception.Message
  }
  return $result
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $cmd = ConvertFrom-Json $line
    $result = Process-Command $cmd
    $result | ConvertTo-Json -Compress -Depth 6 | Write-Host
  } catch {
    @{ _id = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress | Write-Host
  }
}
`.trim();

			logMessage("尝试启动 PowerShell 进程", "DEBUG");
			try {
				const psOptions = [
					["powershell.exe", "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", simplePsScript],
					["powershell.exe", "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", simplePsScript],
					["pwsh.exe", "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", simplePsScript],
					["pwsh.exe", "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", simplePsScript],
				];

				let lastError = null;
				for (const [index, options] of psOptions.entries()) {
					try {
						logMessage(`尝试使用选项 ${index + 1} 启动 PowerShell: ${options[0]}`, "DEBUG");
						proc = cp.spawn(options[0], options.slice(1), {
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
						});
						logMessage(`PowerShell 进程已创建: ${options[0]}`, "DEBUG");
						break;
					} catch (e) {
						lastError = e;
						logMessage(`使用选项 ${index + 1} 启动 PowerShell 失败: ${e.message}`, "DEBUG");
					}
				}

				if (!proc) {
					bridge._setStartError(`spawn_fail: ${lastError?.message || "无法启动任何PowerShell进程"}`);
					throw lastError || new Error("无法启动任何PowerShell进程");
				}

				proc.on("error", (err) => {
					bridge._setStartError(`process_error: ${err.message}`);
					logMessage(`PowerShell 进程错误: ${err.message}`, "ERROR");
				});
				proc.on("exit", (code, signal) => {
					logMessage(`PowerShell 进程退出，代码: ${code}, 信号: ${signal}`, "INFO");
				});
			} catch (e) {
				bridge._setStartError(`create_fail: ${e.message}`);
				logMessage(`PowerShell 进程创建失败: ${e.message}`, "ERROR");
				bridge.available = false;
				resolve(false);
				return;
			}
		} else {
			const nodeBin = process.execPath.replace(/"/g, '\\"');
			const bashScript = platform === "darwin"
				? `
NODE_BIN="${nodeBin}"
json_get() { echo "$1" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j[process.argv[1]]??"")))}catch(e){}});' "$2" 2>/dev/null; }

while IFS= read -r line; do
  action=$(json_get "$line" "action")
  id=$(json_get "$line" "_id")
  case "$action" in
    ping) echo '{"_id":'"$id"',"status":"alive"}' ;;
    hasImage) if command -v pngpaste >/dev/null 2>&1 && pngpaste - >/dev/null 2>&1; then echo '{"_id":'"$id"',"value":true}'; else echo '{"_id":'"$id"',"value":false}'; fi ;;
    saveImage)
      dest=$(json_get "$line" "path")
      if command -v pngpaste >/dev/null 2>&1 && pngpaste "$dest" 2>/dev/null; then echo '{"_id":'"$id"',"success":true}'; else echo '{"_id":'"$id"',"success":false}'; fi ;;
    *) echo '{"_id":'"$id"',"error":"unknown action"}' ;;
  esac
done
`.trim()
				: `
NODE_BIN="${nodeBin}"
json_get() { echo "$1" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j[process.argv[1]]??"")))}catch(e){}});' "$2" 2>/dev/null; }

while IFS= read -r line; do
  action=$(json_get "$line" "action")
  id=$(json_get "$line" "_id")
  case "$action" in
    ping) echo '{"_id":'"$id"',"status":"alive"}' ;;
    hasImage) if command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -q "image/png"; then echo '{"_id":'"$id"',"value":true}'; else echo '{"_id":'"$id"',"value":false}'; fi ;;
    saveImage)
      dest=$(json_get "$line" "path")
      if command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t image/png -o > "$dest" 2>/dev/null && [ -s "$dest" ]; then echo '{"_id":'"$id"',"success":true}'; else echo '{"_id":'"$id"',"success":false}'; fi ;;
    *) echo '{"_id":'"$id"',"error":"unknown action"}' ;;
  esac
done
`.trim();

			logMessage("尝试启动 Bash 进程", "DEBUG");
			try {
				proc = cp.spawn("bash", ["-c", bashScript], { stdio: ["pipe", "pipe", "pipe"] });
				logMessage("Bash 进程已创建", "DEBUG");
			} catch (e) {
				bridge._setStartError(`spawn_fail(bash): ${e.message}`);
				logMessage(`Bash 进程创建失败: ${e.message}`, "ERROR");
				bridge.available = false;
				resolve(false);
				return;
			}
		}

		if (!proc) {
			bridge._setStartError("proc_null");
			resolve(false);
			return;
		}

		bridge.setupProcess(proc, (ok) => {
			if (!ok) logMessage(`Shell Bridge 启动失败原因：${bridge.lastStartError || "unknown"}`, "WARN");
			resolve(ok);
		});
	});
});

// ---------- io ----------
function ensureDir(dirPath) {
	if (!fs.existsSync(dirPath)) {
		try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { }
	}
}

const CLIPBOARD_PEEK_TIMEOUT_MS = 350;
const CLIPBOARD_SLOW_TIMEOUT_MS = 60000;

async function peekClipboardRichFast() {
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

	if (order.includes("python")) {
		try {
			if (pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
				const res = await pythonBridge.call("clipboard_peek", {}, CLIPBOARD_PEEK_TIMEOUT_MS);
				if (res && !res.error && res.type === "peek") return res;
			}
		} catch { }
	}

	// 尝试使用Node.js直接检测HTML
	try {
		const text = await vscode.env.clipboard.readText();
		if (text && (text.includes("<html") || text.includes("<body") || text.includes("<div") || text.includes("<img") || text.includes("<p"))) {
			return {
				type: "peek",
				has_html: true,
				has_files: false,
				has_image: false,
				has_text: false,
			};
		}
	} catch { }

	if (order.includes("shell")) {
		try {
			if (shellBridge?.isAvailable && shellBridge.isAvailable()) {
				const hasFiles = await shellBridge.call("hasFiles", {}, 200);
				const hasImg = await shellBridge.call("hasImage", {}, 200);
				return {
					type: "peek",
					has_html: false,
					has_files: !!hasFiles?.value,
					has_image: !!hasImg?.value,
					has_text: false,
				};
			}
		} catch { }
	}

	return null;
}

async function handleClipboardFast() {
	try {
		const text = await vscode.env.clipboard.readText();
		if (!text || !text.trim()) return null;

		const peek = await peekClipboardRichFast();
		if (peek && (peek.has_html || peek.has_files || peek.has_image)) {
			return null;
		}
		return { type: "text", text };
	} catch { }
	return null;
}

async function handleClipboardSlow(targetDir) {
	const timeoutMs = CLIPBOARD_SLOW_TIMEOUT_MS;
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

	// ★ 核心改进：创建一个临时目录作为打手（Python/Rust/Shell）的输出目标
	// 这样我们可以在文件进入正式目录前，进行指纹计算和去重
	// 如果是重复文件，直接删除临时文件；如果是新文件，移动到目标目录
	const tempDirName = `paste_tmp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
	const tempDir = path.join(os.tmpdir(), tempDirName);
	ensureDir(tempDir);

	let rawResult = null;

	try {
		for (const engine of order) {
			try {
				if (engine === "python") {
					const started = pythonBridge.isAvailable() || await pythonBridge.start();
					if (started && pythonBridge.isAvailable()) {
						rawResult = await pythonBridge.call("clipboard", { target_dir: tempDir }, timeoutMs);
						if (rawResult && !rawResult.error && rawResult.type !== "unknown") break;
					}
				} else if (engine === "rust") {
					const started = rustBridge.isAvailable() || await rustBridge.start();
					if (started && rustBridge.isAvailable()) {
						rawResult = await rustBridge.call("clipboard", { target_dir: tempDir }, timeoutMs);
						if (rawResult && !rawResult.error && rawResult.type !== "unknown") break;
					}
				} else if (engine === "shell") {
					const started = shellBridge.isAvailable() || await shellBridge.start();
					if (started && shellBridge.isAvailable()) {
						rawResult = await handleClipboardShell(tempDir);
						if (rawResult && rawResult.type && rawResult.type !== "unknown") break;
					}
				} else if (engine === "spawn") {
					rawResult = await handleClipboardSpawn(tempDir);
					if (rawResult && rawResult.type && rawResult.type !== "unknown") break;
				}
			} catch (e) {
				logMessage(`引擎 ${engine} 处理失败: ${e.message}`, "ERROR");
			}
		}

		if (!rawResult || rawResult.type === "unknown") {
			// 兜底尝试 spawn
			rawResult = await handleClipboardSpawn(tempDir);
		}

		if (!rawResult || rawResult.type === "unknown") {
			try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
			return rawResult;
		}

		// ★ 后处理：在 Node 端统一进行指纹计算和文件移动
		const finalResult = { ...rawResult };
		ensureDir(targetDir);

		if (finalResult.type === "image" && finalResult.path) {
			const tempPath = finalResult.path;
			if (fs.existsSync(tempPath)) {
				const fp = computeFingerprint(tempPath);
				const existingPath = findFileByFingerprint(fp);

				if (existingPath && fs.existsSync(existingPath)) {
					// 重复：删除临时文件，使用现有文件
					try { fs.unlinkSync(tempPath); } catch { }
					finalResult.path = existingPath;
					finalResult.fingerprint = fp;
				} else {
					// 新文件：移动到目标目录
					const ext = path.extname(tempPath);
					const finalName = getTimestampFilename(ext);
					const finalPath = path.join(targetDir, finalName);

					// 确保目标文件名唯一
					let targetPath = finalPath;
					if (fs.existsSync(targetPath)) {
						targetPath = path.join(targetDir, getTimestampFilename(ext));
					}

					try {
						fs.renameSync(tempPath, targetPath);
						finalResult.path = targetPath;
						finalResult.fingerprint = fp;
						if (fp) prefillFingerprint(targetPath, fp);
					} catch (e) {
						// 移动失败（可能是跨设备），尝试复制
						try {
							fs.copyFileSync(tempPath, targetPath);
							fs.unlinkSync(tempPath);
							finalResult.path = targetPath;
							finalResult.fingerprint = fp;
							if (fp) prefillFingerprint(targetPath, fp);
						} catch (e2) {
							// 还是失败，保留原样（虽然是在temp里，但也比丢了好）
						}
					}
				}
			}
		} else if (finalResult.type === "file_folder") {
			// 处理文件列表
			const newFiles = [];
			const newFps = {};

			if (finalResult.files && finalResult.files.length > 0) {
				for (const tempPath of finalResult.files) {
					if (!fs.existsSync(tempPath)) continue;

					const fp = computeFingerprint(tempPath);
					const existingPath = findFileByFingerprint(fp);

					if (existingPath && fs.existsSync(existingPath)) {
						try { fs.unlinkSync(tempPath); } catch { }
						newFiles.push(existingPath);
						if (fp) newFps[existingPath] = fp;
					} else {
						const fileName = path.basename(tempPath);
						let finalPath = path.join(targetDir, fileName);

						// 处理文件名冲突
						if (fs.existsSync(finalPath)) {
							// 如果目标存在，且指纹相同，则视为同一个
							const dstFp = computeFingerprint(finalPath);
							if (dstFp === fp) {
								try { fs.unlinkSync(tempPath); } catch { }
								newFiles.push(finalPath);
								if (fp) newFps[finalPath] = fp;
								continue;
							}
							// 指纹不同，重命名
							const ext = path.extname(fileName);
							const stem = path.basename(fileName, ext);
							finalPath = path.join(targetDir, `${stem}_${Date.now()}${ext}`);
						}

						try {
							fs.renameSync(tempPath, finalPath);
							newFiles.push(finalPath);
							if (fp) {
								newFps[finalPath] = fp;
								prefillFingerprint(finalPath, fp);
							}
						} catch (e) {
							try {
								fs.copyFileSync(tempPath, finalPath);
								fs.unlinkSync(tempPath);
								newFiles.push(finalPath);
								if (fp) {
									newFps[finalPath] = fp;
									prefillFingerprint(finalPath, fp);
								}
							} catch { }
						}
					}
				}
				finalResult.files = newFiles;
				finalResult.fingerprints = newFps;
			}

			// 处理文件夹 (文件夹比较复杂，暂时整体移动)
			if (finalResult.folders && finalResult.folders.length > 0) {
				const newFolders = [];
				for (const tempFolderPath of finalResult.folders) {
					if (!fs.existsSync(tempFolderPath)) continue;

					const folderName = path.basename(tempFolderPath);
					let finalFolderPath = path.join(targetDir, folderName);

					if (fs.existsSync(finalFolderPath)) {
						finalFolderPath = path.join(targetDir, `${folderName}_${Date.now()}`);
					}

					try {
						// fs.renameSync 在跨设备移动文件夹时可能会失败，保险起见用 cp + rm
						// 如果在同一盘符，renameSync 是原子的且快
						fs.renameSync(tempFolderPath, finalFolderPath);
						newFolders.push(finalFolderPath);
					} catch (e) {
						try {
							fs.cpSync(tempFolderPath, finalFolderPath, { recursive: true });
							fs.rmSync(tempFolderPath, { recursive: true, force: true });
							newFolders.push(finalFolderPath);
						} catch { }
					}
				}
				finalResult.folders = newFolders;
			}
		}

		// 清理临时目录（如果是空的）
		try { fs.rmdirSync(tempDir); } catch { }

		return finalResult;

	} catch (e) {
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
		throw e;
	}
}

// ---------- buffer hash helper ----------
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

async function handleClipboardNode(targetDir) {
	try {
		const text = await vscode.env.clipboard.readText();
		if (!text || !text.trim()) return null;

		// 检测是否为HTML
		if (!(text.includes("<html") || text.includes("<body") || text.includes("<div") || text.includes("<img") || text.includes("<p"))) {
			return null;
		}

		// 解析HTML，提取文本和图片
		const blocks = [];
		let cleanedText = text;

		// 第一步：预处理HTML，清理可能导致乱码的内容
		// 1. 移除BOM（字节顺序标记）
		cleanedText = cleanedText.replace(/^\uFEFF/, '');
		// 2. 统一换行符
		cleanedText = cleanedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

		// 第二步：移除HTML标签但保留文本内容
		cleanedText = cleanedText.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
		cleanedText = cleanedText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
		// 更安全的标签移除：保留换行符结构
		cleanedText = cleanedText.replace(/<br\s*\/?>/gi, '\n');
		cleanedText = cleanedText.replace(/<p[^>]*>/gi, '\n');
		cleanedText = cleanedText.replace(/<\/p>/gi, '\n');
		cleanedText = cleanedText.replace(/<div[^>]*>/gi, '\n');
		cleanedText = cleanedText.replace(/<\/div>/gi, '\n');
		cleanedText = cleanedText.replace(/<[^>]+>/g, ' ');

		// 第三步：简化的编码修复，确保文本正确显示
		let fixedText = cleanedText;

		// 简化编码处理，直接使用UTF-8编码
		try {
			// 直接使用UTF-8编码，避免过度复杂的转换导致乱码
			fixedText = Buffer.from(cleanedText, 'utf-8').toString('utf-8');
		} catch (e) {
			// 兜底方案，使用原始文本
			fixedText = cleanedText;
		}

		// 第四步：清理特殊字符和控制字符
		// 1. 移除控制字符，但保留换行符和制表符
		fixedText = fixedText.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
		// 2. 清理HTML实体
		fixedText = fixedText.replace(/&nbsp;/gi, ' ');
		fixedText = fixedText.replace(/&amp;/gi, '&');
		fixedText = fixedText.replace(/&lt;/gi, '<');
		fixedText = fixedText.replace(/&gt;/gi, '>');
		fixedText = fixedText.replace(/&quot;/gi, '"');
		fixedText = fixedText.replace(/&#39;/gi, "'");
		// 3. 清理多余空格和换行
		fixedText = fixedText.replace(/\s+/g, ' ').trim();

		// 最终清理后的文本
		cleanedText = fixedText;

		if (cleanedText) {
			blocks.push({ type: "text", text: cleanedText });
		}

		// 处理图片标签
		const imgRegex = /<img[^>]+src=["']?([^"'>\s]+)["']?[^>]*>/gi;
		let match;
		const imgSrcs = [];

		// 确保目标目录存在
		ensureDir(targetDir);

		while ((match = imgRegex.exec(text)) !== null) {
			const src = match[1];
			if (src && !imgSrcs.includes(src)) {
				imgSrcs.push(src);

				// 生成唯一文件名
				const timestamp = Date.now();
				const random = Math.floor(Math.random() * 10000);
				const ext = src.split('.').pop() || 'png';
				const fileName = `image_${timestamp}_${random}.${ext}`;
				const destPath = path.join(targetDir, fileName);

				// 尝试下载或保存图片
				let saved = false;
				let fingerprint = null;

				// 处理data URL
				if (src.startsWith('data:')) {
					try {
						const dataUrlRegex = /^data:([^;]+);base64,(.*)$/;
						const dataMatch = src.match(dataUrlRegex);
						if (dataMatch) {
							const base64Data = dataMatch[2];
							const buffer = Buffer.from(base64Data, 'base64');

							// ★ 核心变更：先算指纹，查重
							fingerprint = computeBufferFingerprint(buffer);
							const existingPath = findFileByFingerprint(fingerprint);

							if (existingPath && fs.existsSync(existingPath)) {
								// 命中重复，直接复用
								blocks.push({
									type: "media",
									kind: "image",
									src: existingPath,
									alt: "",
									fingerprint: fingerprint
								});
								continue; // 跳过保存
							}

							// 未命中，写入磁盘
							fs.writeFileSync(destPath, buffer);
							saved = true;
							if (fingerprint) prefillFingerprint(destPath, fingerprint);
						}
					} catch (e) {
						logMessage(`保存data URL图片失败: ${e.message}`, "ERROR");
					}
				}
				// 处理本地文件URL
				else if (src.startsWith('file://')) {
					try {
						const localPath = decodeURIComponent(src.replace('file://', ''));
						if (fs.existsSync(localPath)) {
							// ★ 核心变更：先算指纹，查重
							fingerprint = computeFingerprint(localPath);
							const existingPath = findFileByFingerprint(fingerprint);

							if (existingPath && fs.existsSync(existingPath)) {
								blocks.push({
									type: "media",
									kind: "image",
									src: existingPath,
									alt: "",
									fingerprint: fingerprint
								});
								continue;
							}

							// 未命中，复制文件
							fs.copyFileSync(localPath, destPath);
							saved = true;
							if (fingerprint) prefillFingerprint(destPath, fingerprint); // 缓存 destPath
						}
					} catch (e) {
						logMessage(`复制本地图片失败: ${e.message}`, "ERROR");
					}
				}
				// 处理 HTTP/HTTPS 图片 (接管 Python 下载逻辑)
				else if (src.startsWith('http://') || src.startsWith('https://')) {
					try {
						// 使用 axios 或 fetch 下载 (这里假设环境支持 fetch，VSCode 较新版本支持)
						// 如果不支持 fetch，可能需要引入 https 模块
						const https = require('https');
						const http = require('http');
						const client = src.startsWith('https') ? https : http;

						await new Promise((resolve, reject) => {
							client.get(src, (res) => {
								if (res.statusCode !== 200) {
									res.resume();
									return resolve();
								}
								const chunks = [];
								res.on('data', (chunk) => chunks.push(chunk));
								res.on('end', () => {
									const buffer = Buffer.concat(chunks);

									// ★ 核心变更：先算指纹，查重
									fingerprint = computeBufferFingerprint(buffer);
									const existingPath = findFileByFingerprint(fingerprint);

									if (existingPath && fs.existsSync(existingPath)) {
										blocks.push({
											type: "media",
											kind: "image",
											src: existingPath,
											alt: "",
											fingerprint: fingerprint
										});
										saved = false; // 已复用，不算新保存
									} else {
										fs.writeFileSync(destPath, buffer);
										saved = true;
										if (fingerprint) prefillFingerprint(destPath, fingerprint);
									}
									resolve();
								});
								res.on('error', reject);
							}).on('error', (e) => {
								resolve(); // 忽略错误
							});
						});
					} catch (e) {
						logMessage(`下载图片失败: ${e.message}`, "ERROR");
					}
				}


				// 如果成功保存，添加到blocks
				if (saved) {
					blocks.push({
						type: "media",
						kind: "image",
						src: destPath,
						alt: "",
						fingerprint: fingerprint
					});
				}
			}
		}

		if (blocks.length === 0) {
			return null;
		}

		return {
			type: "html_blocks",
			blocks: blocks,
			source_url: ""
		};
	} catch (e) {
		logMessage(`Node.js剪贴板处理失败: ${e.message}`, "ERROR");
		return null;
	}
}

async function handleClipboardShell(targetDir) {
	try {
		if (process.platform === "win32") {
			const hasFiles = await shellBridge.call("hasFiles", {}, 2000);
			if (hasFiles?.value) {
				const filesRes = await shellBridge.call("getFiles", {}, 3000);
				const files = filesRes?.files || [];

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

				// 复制文件夹
				for (const folder of folders) {
					try {
						const destFolder = path.join(targetDir, path.basename(folder));
						fs.cpSync(folder, destFolder, { recursive: true, force: true });
						copiedFolders.push(destFolder);
						// 文件夹暂不计算整体指纹
					} catch { }
				}

				// 复制文件
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
			}
		}

		// 先检查是否有图片
		const hasImg = await shellBridge.call("hasImage", {}, 2000);
		if (hasImg?.value) {
			const fname = getTimestampFilename(".png");
			const dest = path.join(targetDir, fname);
			ensureDir(targetDir);
			const saved = await shellBridge.call("saveImage", { path: dest }, 8000);
			if (saved?.success && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
				// ★ 立即计算指纹
				const fp = computeFingerprint(dest);
				return { type: "image", path: dest, fingerprint: fp };
			}
		}

		// 检查并处理HTML内容
		const text = await vscode.env.clipboard.readText();
		if (text && (text.includes("<html") || text.includes("<body") || text.includes("<div") || text.includes("<img") || text.includes("<p"))) {
			// 使用我们的Node.js HTML处理逻辑
			return await handleClipboardNode(targetDir);
		}
	} catch (e) {
		logMessage(`Shell剪贴板处理失败: ${e.message}`, "ERROR");
	}

	return null;
}

function copyFilesToTarget(files, targetDir) {
	// 确保目标目录存在
	ensureDir(targetDir);

	// qqq 负责构建现有文件的指纹映射 (用于本次批量操作的内部去重)
	// 注意：更高级的去重应该查询 _fingerprintDb

	const copied = [];
	const fingerprints = {}; // ★ 收集指纹返回

	for (const f of files) {
		try {
			// 计算源文件指纹
			const srcFingerprint = computeFingerprint(f);
			if (srcFingerprint) {
				fingerprints[f] = srcFingerprint;

				// ★ 1. 查全局库
				let existingPath = findFileByFingerprint(srcFingerprint);
				// 如果全局库里有，且文件确实存在
				if (existingPath && fs.existsSync(existingPath)) {
					copied.push(existingPath);
					continue;
				}

				// ★ 2. 查目标目录（双重保险，防止全局库未同步）
				// 其实如果 _fingerprintDb 维护得当，这一步可以省略，但为了稳健保留
				// 这里简化逻辑：我们只信全局库和本次操作的新增
			}

			const ext = path.extname(f);
			const isImg = isImageExtForClipboard(ext);
			const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
			const dest = path.join(targetDir, fname);

			// 再次检查目标文件是否存在（文件名冲突）
			if (fs.existsSync(dest)) {
				// 如果存在，算一下它的指纹
				const dstFingerprint = computeFingerprint(dest);
				if (dstFingerprint === srcFingerprint) {
					copied.push(dest);
					if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);
					continue;
				}
				// 指纹不同，需要重命名 (这里简单覆盖或跳过，通常应该 uniqueFilename)
				// 假设我们允许覆盖
			}

			fs.copyFileSync(f, dest);

			// 更新指纹映射
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

		const folders = files.filter((f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
		const validFiles = files.filter((f) => { try { return !fs.statSync(f).isDirectory(); } catch { return false; } });

		ensureDir(targetDir);
		const copiedFiles = [];
		const copiedFolders = [];
		const fingerprints = {};

		// 复制文件夹
		for (const folder of folders) {
			try {
				const destFolder = path.join(targetDir, path.basename(folder));
				fs.cpSync(folder, destFolder, { recursive: true, force: true });
				copiedFolders.push(destFolder);
			} catch { }
		}

		// 复制文件
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
			// ★ 立即计算指纹
			const fp = computeFingerprint(dest);
			return { type: "image", path: dest, fingerprint: fp };
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
				} catch { }
			}

			if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
				// ★ 立即计算指纹
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
			// ★ 立即计算指纹
			const fp = computeFingerprint(dest);
			return { type: "image", path: dest, fingerprint: fp };
		}

		if (fs.existsSync(dest)) {
			try { fs.unlinkSync(dest); } catch { }
		}
	} catch { }

	return { type: "unknown" };
}

function spawnCheck(cmd, args, expected) {
	return new Promise((resolve) => {
		const child = cp.spawn(cmd, args, { windowsHide: true });
		let output = "";
		let errorOutput = "";
		let done = false;

		const finish = (val) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(val);
		};

		child.stdout.on("data", (d) => output += d.toString().trim());
		child.stderr.on("data", (d) => errorOutput += d.toString().trim());

		child.on("close", (code) => {
			if (code !== 0 && errorOutput) {
				logMessageRateLimited(
					`spawnCheck:${cmd}:${code}:${errorOutput.slice(0, 120)}`,
					`${cmd} 执行失败 (exit ${code}): ${errorOutput}`,
					"WARN",
					2 * 60 * 1000
				);
			}
			finish(output.includes(expected));
		});

		child.on("error", (err) => {
			logMessage(`${cmd} 启动失败: ${err.message}`, "ERROR");
			finish(false);
		});

		const timer = setTimeout(() => {
			try { child.kill(); } catch { }
			logMessageRateLimited(`spawnCheckTimeout:${cmd}`, `${cmd} 执行超时`, "WARN", 2 * 60 * 1000);
			finish(false);
		}, 5000);
	});
}

function spawnOutput(cmd, args) {
	return new Promise((resolve) => {
		const child = cp.spawn(cmd, args, { windowsHide: true });
		let output = "";
		let errorOutput = "";
		let done = false;

		const finish = (val) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(val);
		};

		child.stdout.on("data", (d) => output += d.toString());
		child.stderr.on("data", (d) => errorOutput += d.toString());

		child.on("close", (code) => {
			if (code !== 0 && errorOutput) {
				logMessageRateLimited(
					`spawnOutput:${cmd}:${code}:${errorOutput.slice(0, 120)}`,
					`${cmd} 执行失败 (exit ${code}): ${errorOutput}`,
					"WARN",
					2 * 60 * 1000
				);
			}
			finish(output);
		});

		child.on("error", (err) => {
			logMessage(`${cmd} 启动失败: ${err.message}`, "ERROR");
			finish("");
		});

		const timer = setTimeout(() => {
			try { child.kill(); } catch { }
			logMessageRateLimited(`spawnOutputTimeout:${cmd}`, `${cmd} 执行超时`, "WARN", 2 * 60 * 1000);
			finish("");
		}, 5000);
	});
}

// ---------- folder info ----------
async function getFolderInfo(folderPath) {
	folderPath = canonicalizeExistingPath(folderPath) || folderPath;

	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

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
		vscode.commands.registerCommand("qqq.pure", q1a.pureCommand),
		vscode.commands.registerCommand("qqq.allSettings", () => {
			vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("qqq.ioEngine")) {
				logMessage("IO 引擎配置已更改，重新启动守护进程...", "INFO");

				pythonBridge.stop();
				rustBridge.stop();
				shellBridge.stop();

				setTimeout(() => {
					logMessage("开始重新启动守护进程", "DEBUG");
					startDaemons();
				}, 200);
			}
		})
	);

	loadSubModules(context);

	logMessage("qqq 扩展激活完成", "INFO");
}

// ★ 修正：加入“启动世代号”，避免旧的异步启动链在切换后继续拉起旧引擎
let _daemonBootSeq = 0;

function startDaemons() {
	const bootSeq = ++_daemonBootSeq;

	const pref = getEnginePreference();
	logMessage(`开始启动守护进程，用户选择的引擎: ${pref}`, "INFO");

	const startOne = async (bridge, isHardFail) => {
		if (bootSeq !== _daemonBootSeq) return false;

		try {
			logMessage(`尝试启动 ${bridge.name} bridge`, "DEBUG");
			const ok = await bridge.start();

			if (bootSeq !== _daemonBootSeq) {
				try { bridge.stop(); } catch { }
				return false;
			}

			if (!ok) {
				const msg = `${bridge.name} Bridge 启动失败：${bridge.lastStartError || "unknown"}`;
				logMessage(msg, isHardFail ? "ERROR" : "WARN");
			} else {
				logMessage(`${bridge.name} Bridge OK`, "INFO");
			}
			return !!ok;
		} catch (e) {
			const msg = `${bridge.name} Bridge 启动异常：${e?.message || e}`;
			logMessage(msg, isHardFail ? "ERROR" : "WARN");
			return false;
		} finally {
			try { updateStatusBarNow(); } catch { }
		}
	};

	// python/rust/node(auto) 逻辑：node = shell daemon -> spawn
	if (pref !== "auto") {
		if (pref === "python") {
			startOne(pythonBridge, false).then((pyStarted) => {
				if (bootSeq !== _daemonBootSeq) return;
				if (!pyStarted) startOne(rustBridge, false).then((rsStarted) => {
					if (bootSeq !== _daemonBootSeq) return;
					if (!rsStarted) startOne(shellBridge, false);
				});
			});
		} else if (pref === "rust") {
			startOne(rustBridge, false).then((rsStarted) => {
				if (bootSeq !== _daemonBootSeq) return;
				if (!rsStarted) startOne(pythonBridge, false).then((pyStarted) => {
					if (bootSeq !== _daemonBootSeq) return;
					if (!pyStarted) startOne(shellBridge, false);
				});
			});
		} else {
			// node：无条件 shell daemon
			startOne(shellBridge, false);
		}
		return;
	}

	(async () => {
		if (bootSeq !== _daemonBootSeq) return;
		if (await startOne(pythonBridge, false)) return;
		if (bootSeq !== _daemonBootSeq) return;
		if (await startOne(rustBridge, false)) return;
		if (bootSeq !== _daemonBootSeq) return;
		if (await startOne(shellBridge, false)) return;

		logMessage("All daemons failed, using spawn fallback", "WARN");
		try { updateStatusBarNow(); } catch { }
	})().catch(() => {
		logMessage("startDaemons auto 启动流程异常，回退 spawn fallback", "WARN");
		try { updateStatusBarNow(); } catch { }
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

	finishUserTracking(extensionContext);

	try {
		if (extensionContext) {
			extensionContext.globalState.update(KEY_CACHE_HIT_TOTAL, _cacheHitTotal);
			extensionContext.globalState.update(KEY_CACHE_MISS_TOTAL, _cacheMissTotal);
		}
	} catch { }

	try {
		if (_statsFlushTimer) clearTimeout(_statsFlushTimer);
		_statsFlushTimer = null;
		_statsDirty = false;
	} catch { }

	try { validateCache(); } catch { }
	saveCacheMeta();

	if (q1Module?.deactivate) {
		try { await q1Module.deactivate(); } catch { }
	}

	try {
		if (_statusBarTimer) clearInterval(_statusBarTimer);
		_statusBarTimer = null;
		if (statusBarItem) statusBarItem.dispose();
		statusBarItem = null;
	} catch { }

	logMessage("qqq 扩展已停用", "INFO");
}

const exported = {
	activate,
	deactivate,

	QQQ_PATH_REGEX,
	PENDING_REGEX,

	normalizeNavPath,
	resolveNavPath,
	canonicalizeExistingPath,
	cacheKeyForPath,

	logMessage,
	logMessageRateLimited,

	computeFingerprint,
	prefillFingerprint,

	initCache,
	validateCache,

	getCacheEntry,
	getCacheQualityMeta,
	getCacheStatsSnapshot,
	getPersistentCacheStatsSnapshot,

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

	probeScheduler,
	genScheduler,

	getActiveEngineCode,
	getActiveEngineName,
	updateStatusBarNow,
};

Object.defineProperty(exported, "LOG_PATH", { enumerable: true, get: () => LOG_PATH });
Object.defineProperty(exported, "ffmpegPath", { enumerable: true, get: () => ffmpegPath });
Object.defineProperty(exported, "ffprobePath", { enumerable: true, get: () => ffprobePath });

module.exports = exported;

process.on("uncaughtException", (error) => {
	const stack = error.stack || "";
	// 捕获所有未捕获异常，无论是否包含"qqq"
	logMessage(`未捕获的异常: ${error.message}\n${error.stack}`, "ERROR");
});

process.on("unhandledRejection", (reason) => {
	const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
	// 捕获所有未处理Promise拒绝，无论是否包含"qqq"
	logMessage(`未处理的Promise拒绝: ${msg}`, "ERROR");
});

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
// - 捕获组(1)返回中间内容（去掉外壳 /\ 和 \ /）
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

// ============================================================================
// ★★★ 统一路径真理来源（给 q2/q1/未来模块用）：跨平台 normalize/resolve/canonical
// - 目标：绝对路径不乱剥离；Windows 盘符/UNC/根路径行为一致；canonical 去重一致
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

/**
 * normalizeNavPath：用于“导航/打开/展示”的路径清洗
 * - 非 Windows：/ 开头保持绝对路径；~ 展开
 * - Windows：
 *   - 盘符/UNC 保持绝对
 *   - "C:" / "C:/" / "C:\" => "C:\"
 *   - "\foo" 或 "/foo" => 系统盘根路径下的 "\foo"
 *   - 其他：相对路径只 normalize，不强行 resolve（resolve 交给 resolveNavPath）
 */
function normalizeNavPath(rawPath) {
	let clean = _stripDocJunk(rawPath);
	if (!clean) return "";

	// ~ 展开
	if (clean === "~") clean = os.homedir();
	else if (clean.startsWith("~/") || clean.startsWith("~\\")) {
		clean = path.join(os.homedir(), clean.slice(2));
	}

	const isWin = process.platform === "win32";
	if (!isWin) return path.normalize(clean);

	// "C:" or "C:/"
	if (/^[A-Za-z]:$/.test(clean)) return clean.toUpperCase() + "\\";
	if (/^[A-Za-z]:[\\/]*$/.test(clean)) return clean[0].toUpperCase() + ":\\";

	// UNC
	if (clean.startsWith("\\\\") || clean.startsWith("//")) return path.normalize(clean);

	// Drive absolute
	if (/^[A-Za-z]:[\\/]/.test(clean)) {
		const normalized = path.normalize(clean);
		return normalized.replace(/^[a-z]:/, (m) => m.toUpperCase());
	}

	// "\foo" or "/foo" => system drive root
	if (clean.startsWith("\\") || clean.startsWith("/")) {
		const sysRoot = _getSystemDriveRoot();
		const rest = clean.replace(/^[\\/]+/, "");
		return path.normalize(path.join(sysRoot, rest));
	}

	return path.normalize(clean);
}

/**
 * resolveNavPath：把用户输入路径解析成最终绝对路径（用于导航）
 * - 如果 normalize 后已是绝对（含 UNC/盘符）直接返回
 * - 否则按 baseDir resolve
 */
function resolveNavPath(rawPath, baseDir) {
	const clean = normalizeNavPath(rawPath);
	if (!clean) return "";
	if (path.isAbsolute(clean)) return clean;
	const base = baseDir && typeof baseDir === "string" ? baseDir : process.cwd();
	return path.resolve(base, clean);
}

/**
 * canonicalizeExistingPath：对“存在于磁盘的路径”做 canonical key（去重/缓存稳定）
 * - realpath（尽量）
 * - normalize
 * - 去尾分隔符（保留 root）
 * - Windows 盘符大写；最终 cacheKey win32 下再 lower
 */
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
// ★ IO 引擎策略：严格按用户配置选择
// -----------------------------
function getEnginePreference() {
	try {
		const config = vscode.workspace.getConfiguration("qqq");
		return config.get("ioEngine", "auto");
	} catch {
		return "auto";
	}
}

function getEngineTryOrder(pref) {
	// 返回尝试顺序（含 spawn 兜底）
	switch (pref) {
		case "python": return ["python", "rust", "shell", "spawn"]; // python 不行 → rust →（最后可选 shell）→ spawn
		case "rust": return ["rust", "python", "shell", "spawn"];
		case "shell": return ["shell", "spawn"];
		case "node": return ["shell", "spawn"]; // node 优先 shell daemon，失败再 spawn
		case "auto":
		default: return ["python", "rust", "shell", "spawn"];
	}
}

function getActiveEngineCode() {
	// P: Python daemon
	// R: Rust daemon
	// S: Shell daemon
	// N: Node/spawn fallback

	const pref = getEnginePreference();

	// 注意：这里“只读判断”，不主动启动进程
	const py = pythonBridge?.isAvailable?.() === true;
	const rs = rustBridge?.isAvailable?.() === true;
	const sh = shellBridge?.isAvailable?.() === true;

	if (pref === "python") return py ? "P" : (rs ? "R" : (sh ? "S" : "N"));
	if (pref === "rust") return rs ? "R" : (py ? "P" : (sh ? "S" : "N"));
	if (pref === "shell") return sh ? "S" : "N";
	if (pref === "node") return sh ? "S" : "N";

	// auto
	if (py) return "P";
	if (rs) return "R";
	if (sh) return "S";
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

	const stats = getCacheStatsSnapshot();
	const cacheBytes = stats.totalSize;
	const cacheMB = cacheBytes / (1024 * 1024);

	const pstats = getPersistentCacheStatsSnapshot();
	const denom = pstats.hitTotal + pstats.missTotal;
	const hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;

	const engineCode = getActiveEngineCode();
	const engineName = getActiveEngineName();

	// 注：保持你原来“Shell 与 Node 归一显示 N”的口径不变
	const engineDisplay = (engineCode === "S") ? "N" : engineCode;
	let extraEngineInfo = "";
	if (engineCode === "N" && shellBridge?.isAvailable?.()) {
		extraEngineInfo = "(D)";
	}

	statusBarItem.text = `[qqq: ⏱${h}h ▥${cacheMB.toFixed(0)}m ⊙${hitRate.toFixed(0)}% ⚡${engineDisplay}${extraEngineInfo}]`;

	const pref = getEnginePreference();

	let engineDisplayText = `**IO 引擎：** ${engineName}`;
	if (engineCode === "N") {
		if (shellBridge?.isAvailable?.()) engineDisplayText = "**IO 引擎：** Node (Shell daemon)";
		else engineDisplayText = "**IO 引擎：** Node (Node spawn)";
	}

	let expectationMismatchText = "";
	if (pref !== "auto" && pref !== "node") {
		const expectedCode =
			pref === "python" ? "P" :
				pref === "rust" ? "R" :
					pref === "shell" ? "S" : "N";
		if (expectedCode !== engineCode) {
			let reason = "启动失败或不可用";
			if (pref === "python" && pythonBridge?.isAvailable?.() !== true) reason = "Python 引擎启动失败/不可用";
			if (pref === "rust" && rustBridge?.isAvailable?.() !== true) reason = "Rust 引擎启动失败/不可用";
			if (pref === "shell" && shellBridge?.isAvailable?.() !== true) reason = "Shell 引擎启动失败/不可用";
			expectationMismatchText = ` ▬ 期待值 ${pref}，当前回退：${engineName}（${reason}）`;
		}
	}

	const tooltip = new vscode.MarkdownString(
		[
			`<div style="background-color: #ffffff; padding: 8px; border-radius: 4px;">`,
			`**累计使用时间：** ${_formatHours(totalSeconds)}`,
			`**磁盘缓存：** ${_formatBytes(cacheBytes)}`,
			`**缓存命中率：** ${hitRate.toFixed(2)}%  (hit=${pstats.hitTotal}, miss=${pstats.missTotal})`,
			`${engineDisplayText}${expectationMismatchText}`,
			`</div>`
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
		try { context.subscriptions.push(statusBarItem); } catch { }
	}

	updateStatusBarNow();

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

		// ★ 修正：stop() 触发 close 时不再走自动重启
		this._stopping = false;
	}

	async start() {
		logMessage(`${this.name} start 方法被调用`, "DEBUG");

		// 一旦要启动，认为是“主动启动”，撤销 stopping 状态
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
				logMessage(`${this.name} 解析响应失败: ${line}`, "ERROR");
			}
		});

		proc.stderr.on("data", (d) => {
			const text = d?.toString?.() || "";
			const key = _bridgeStderrKey(this.name, text);
			logMessageRateLimited(key, `${this.name} stderr: ${text}`, "WARN", 5 * 60 * 1000);
		});

		proc.on("error", (err) => {
			logMessage(`${this.name} 进程错误: ${err.message}`, "ERROR");
			this._handleCrash();
		});
		proc.on("close", (code) => {
			logMessage(`${this.name} 进程关闭，退出码: ${code}`, "INFO");
			this._handleCrash();
		});

		setTimeout(async () => {
			try {
				logMessage(`${this.name} 发送 ping 请求`, "DEBUG");
				const pong = await this.call("ping", {}, 2000);
				logMessage(`${this.name} ping 响应: ${JSON.stringify(pong)}`, "DEBUG");
				if (pong?.status === "alive") {
					this.restartCount = 0;
					this.available = true;
					logMessage(`${this.name} started`, "INFO");
					resolve(true);
					try { updateStatusBarNow(); } catch { }
				} else {
					logMessage(`${this.name} ping 响应无效: ${JSON.stringify(pong)}`, "WARN");
					this.available = false;
					resolve(false);
					try { updateStatusBarNow(); } catch { }
				}
			} catch (e) {
				logMessage(`${this.name} ping 失败: ${e?.message || e}`, "ERROR");
				this.available = false;
				resolve(false);
				try { updateStatusBarNow(); } catch { }
			}
		}, 100);
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

		// ★ stop() 触发 close/error 时：不允许自动重启（解决“热切换只换显示不换内核”）
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
		if (this.available === false) {
			logMessage(`${this.name} 不可用，返回错误`, "DEBUG");
			return { error: `${this.name}_not_available` };
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

		// ★ stop 的语义：明确进入 stopping，防止 close 回调触发自动重启
		this._stopping = true;

		// stop 之后：清 pending，避免悬挂
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
						windowsHide: true
					});
				} catch (e) {
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
					logMessage(`Python bridge 进程错误 (${bin}): ${err.message}`, "WARN");
					failFast();
				});

				bridge.setupProcess(proc, (ok) => {
					if (settled) return;
					settled = true;
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
					resolve(!!ok2);
					return;
				}
			}

			logMessage("Python Bridge 启动失败，所有尝试均已失败", "WARN");
			resolve(false);
		})().catch((e) => {
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
			path.join(__dirname, filename)
		];

		let exePath = null;
		for (const c of candidates) {
			if (fs.existsSync(c)) { exePath = c; break; }
		}

		if (!exePath) {
			logMessage("Rust Bridge 可执行文件未找到", "WARN");
			bridge.available = false;
			resolve(false);
			return;
		}

		try {
			logMessage(`Rust Bridge 尝试启动: ${exePath}`, "INFO");
			const proc = cp.spawn(exePath, ["--daemon"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true
			});

			proc.once("error", (err) => {
				logMessage(`Rust Bridge 进程错误: ${err.message}`, "WARN");
				bridge.available = false;
				resolve(false);
			});

			bridge.setupProcess(proc, (ok) => {
				if (ok) {
					logMessage("Rust Bridge 启动成功", "INFO");
					resolve(true);
				} else {
					logMessage("Rust Bridge 启动失败", "WARN");
					resolve(false);
				}
			});
		} catch (e) {
			logMessage(`Rust Bridge 启动异常: ${e.message}`, "ERROR");
			bridge.available = false;
			resolve(false);
		}
	});
});

// ★ Shell bridge：修正 win32 proc 遮蔽 + STA + System.Drawing
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
				// ★ -STA：解决 Clipboard STA 问题
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
							windowsHide: true
						});
						logMessage(`PowerShell 进程已创建: ${options[0]}`, "DEBUG");
						break;
					} catch (e) {
						logMessage(`使用选项 ${index + 1} 启动 PowerShell 失败: ${e.message}`, "DEBUG");
						lastError = e;
					}
				}

				if (!proc) {
					throw lastError || new Error("无法启动任何PowerShell进程");
				}

				proc.on("error", (err) => logMessage(`PowerShell 进程错误: ${err.message}`, "ERROR"));
				proc.on("exit", (code, signal) => logMessage(`PowerShell 进程退出，代码: ${code}, 信号: ${signal}`, "INFO"));
			} catch (e) {
				logMessage(`PowerShell 进程创建失败: ${e.message}`, "ERROR");
				bridge.available = false;
				resolve(false);
				return;
			}
		} else {
			// ★ 非 Windows：用 process.execPath 的 node 来解析 JSON（不依赖 python3）
			const nodeBin = process.execPath.replace(/"/g, '\\"');
			const bashScript = platform === "darwin" ? `
NODE_BIN="${nodeBin}"
json_get() { echo "$1" | "$NODE_BIN" -e 'const fs=require("fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j[process.argv[1]]??"")))}catch(e){}});' "$2" 2>/dev/null; }

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
`.trim() : `
NODE_BIN="${nodeBin}"
json_get() { echo "$1" | "$NODE_BIN" -e 'const fs=require("fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j[process.argv[1]]??"")))}catch(e){}});' "$2" 2>/dev/null; }

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
				logMessage(`Bash 进程创建失败: ${e.message}`, "ERROR");
				bridge.available = false;
				resolve(false);
				return;
			}
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

// ★ Clipboard Fast/Slow timeouts（HTML 多媒体可能较慢）
const CLIPBOARD_PEEK_TIMEOUT_MS = 350;
const CLIPBOARD_SLOW_TIMEOUT_MS = 60000;

// ★ 快速嗅探：只用于决定是否走 fast-path
async function peekClipboardRichFast() {
	// 只做“轻量判断”，但也要尊重 ioEngine，避免 node 模式下硬拉起 python
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

	// python peek
	if (order.includes("python")) {
		try {
			if (pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
				const res = await pythonBridge.call("clipboard_peek", {}, CLIPBOARD_PEEK_TIMEOUT_MS);
				if (res && !res.error && res.type === "peek") return res;
			}
		} catch (e) { }
	}

	// shell peek（支持 files/image）
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
		} catch (e) { }
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
	} catch (e) { }
	return null;
}

// ★ 修正：严格按 ioEngine 顺序选择引擎；仅在允许链上回退
async function handleClipboardSlow(targetDir) {
	const timeoutMs = CLIPBOARD_SLOW_TIMEOUT_MS;
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

	for (const engine of order) {
		try {
			if (engine === "python") {
				const started = pythonBridge.isAvailable() || await pythonBridge.start();
				if (started && pythonBridge.isAvailable()) {
					const res = await pythonBridge.call("clipboard", { target_dir: targetDir }, timeoutMs);
					if (res && !res.error && res.type !== "unknown") return res;
				}
			} else if (engine === "rust") {
				const started = rustBridge.isAvailable() || await rustBridge.start();
				if (started && rustBridge.isAvailable()) {
					const res = await rustBridge.call("clipboard", { target_dir: targetDir }, timeoutMs);
					if (res && !res.error && res.type !== "unknown") return res;
				}
			} else if (engine === "shell") {
				const shellResult = await handleClipboardShell(targetDir);
				if (shellResult && shellResult.type && shellResult.type !== "unknown") return shellResult;
			} else if (engine === "spawn") {
				const res = await handleClipboardSpawn(targetDir);
				if (res && res.type && res.type !== "unknown") return res;
				return res;
			}
		} catch (e) { }
	}

	return handleClipboardSpawn(targetDir);
}

// ★ 修正：Shell daemon 在非 win32 也可做 image（bash script 已实现 hasImage/saveImage）
async function handleClipboardShell(targetDir) {
	try {
		// Windows: 支持 files + image
		if (process.platform === "win32") {
			const hasFiles = await shellBridge.call("hasFiles", {}, 2000);
			if (hasFiles?.value) {
				const filesRes = await shellBridge.call("getFiles", {}, 3000);
				const files = filesRes?.files || [];

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
		}

		// All platforms: image
		const hasImg = await shellBridge.call("hasImage", {}, 2000);
		if (hasImg?.value) {
			const fname = getTimestampFilename(".png");
			const dest = path.join(targetDir, fname);
			ensureDir(targetDir);
			const saved = await shellBridge.call("saveImage", { path: dest }, 8000);
			if (saved?.success && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
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
		"-STA",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsFileDropList()){\\\"1\\\"}else{\\\"0\\\"}"
	], "1");

	if (hasFiles) {
		const filesOutput = await spawnOutput("powershell", [
			"-STA",
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
		"-STA",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsImage()){\\\"1\\\"}else{\\\"0\\\"}"
	], "1");

	if (hasImg) {
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);
		ensureDir(targetDir);

		const escapedPath = dest.replace(/'/g, "''");
		const saved = await spawnCheck("powershell", [
			"-STA",
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

// 修正：timeout 清理 + 防重复 resolve/kill
function spawnCheck(cmd, args, expected) {
	return new Promise(resolve => {
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
	return new Promise(resolve => {
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
// ★ 修正：按 ioEngine 顺序选择（node 模式直接 JS，不拉 python/rust）
async function getFolderInfo(folderPath) {
	// ★★★ 关键：统一 canonical（保证 q2/其它模块传入各种写法也稳定一致）
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
				// shell 没 folder_info；spawn 走 JS
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
				const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(parentDir, rawPath);

				const absNorm = path.normalize(absPath).toLowerCase();
				const qqqNorm = path.normalize(qqqDir).toLowerCase();

				if (absNorm.startsWith(qqqNorm)) {
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
	content += orphanPaths.map(p => `/\\${p}\\//`).join("\n\n\n\n\n");

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

	const startOne = async (bridge, okMsg, failMsg, isHardFail) => {
		// 如果启动链已经过期，直接忽略
		if (bootSeq !== _daemonBootSeq) return false;

		try {
			logMessage(`尝试启动 ${bridge.name} bridge`, "DEBUG");
			const ok = await bridge.start();

			// 若启动完成时世代已变：把刚启动的进程关掉（避免热切换时“旧引擎复活”）
			if (bootSeq !== _daemonBootSeq) {
				try { bridge.stop(); } catch { }
				return false;
			}

			logMessage(`${bridge.name} bridge 启动结果: ${ok}`, "DEBUG");
			if (ok) logMessage(okMsg, "INFO");
			else if (isHardFail) logMessage(failMsg, "ERROR");
			return !!ok;
		} catch (e) {
			if (isHardFail) logMessage(`${failMsg}: ${e?.message || e}`, "ERROR");
			return false;
		} finally {
			try { updateStatusBarNow(); } catch { }
		}
	};

	if (pref !== "auto") {
		if (pref === "python") {
			startOne(pythonBridge, "Python Bridge OK", "Python Bridge 启动失败", false).then(pyStarted => {
				if (bootSeq !== _daemonBootSeq) return;
				if (!pyStarted) startOne(rustBridge, "Rust Bridge OK", "Rust Bridge 启动失败", false);
			});
		} else if (pref === "rust") {
			startOne(rustBridge, "Rust Bridge OK", "Rust Bridge 启动失败", false).then(rustStarted => {
				if (bootSeq !== _daemonBootSeq) return;
				if (!rustStarted) startOne(pythonBridge, "Python Bridge OK", "Python Bridge 启动失败", false);
			});
		} else if (pref === "shell") {
			startOne(shellBridge, "Shell Bridge OK", "Shell Bridge 启动失败", true);
		} else {
			// node：无条件尝试 shell daemon
			startOne(shellBridge, "Shell Bridge OK", "Shell Bridge 启动失败", false);
		}
		return;
	}

	// auto：串行兜底（只走这一条）
	(async () => {
		if (bootSeq !== _daemonBootSeq) return;
		if (await startOne(pythonBridge, "Python Bridge OK", "Python Bridge 启动失败", false)) return;
		if (bootSeq !== _daemonBootSeq) return;
		if (await startOne(rustBridge, "Rust Bridge OK", "Rust Bridge 启动失败", false)) return;
		if (bootSeq !== _daemonBootSeq) return;
		if (await startOne(shellBridge, "Shell Bridge OK", "Shell Bridge 启动失败", false)) return;

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

	try { validateCache(); } catch (e) { }
	saveCacheMeta();

	if (q1Module?.deactivate) {
		try { await q1Module.deactivate(); } catch (e) { }
	}

	try {
		if (_statusBarTimer) clearInterval(_statusBarTimer);
		_statusBarTimer = null;
		if (statusBarItem) statusBarItem.dispose();
		statusBarItem = null;
	} catch { }

	logMessage("qqq 扩展已停用", "INFO");
}

// 重要修正：导出 LOG_PATH 不再是“导出时快照”（否则一直 null），改成 getter 动态读取
const exported = {
	activate,
	deactivate,

	QQQ_PATH_REGEX,
	PENDING_REGEX,

	// ★★★ 导出：路径统一真理来源（给 q2/q1/未来模块复用）
	normalizeNavPath,
	resolveNavPath,
	canonicalizeExistingPath,
	cacheKeyForPath,

	logMessage,
	logMessageRateLimited,

	computeFingerprint,

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

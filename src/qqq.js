const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const cp = require("child_process"); // Retain for ffmpeg/spawn if needed by q3 or legacy

const q3 = require("./q3");
const global = require("./global");
const h = require("./h");
const q1 = require("./q1");
const q4 = require("./q4");

// 引用 global.js 的核心对象
const {
	pythonBridge,
	rustBridge,
	shellBridge,
	startDaemons,
	tryOneByOne,
	tryEngineCall,
	updateStatusBarNow,
	pasteQueue,
	metaSaveQueue
} = global;

function createPathRegex() {
	return /\/\\\s*([\s\S]*?)\s*\\\//gi;
}

const CACHE_DIR_NAME = "qqq_cache";
const META_FILE_NAME = "meta.json";
const CACHE_MAX_SIZE = 40 * 1048576;
const CACHE_TARGET_SIZE = 28 * 1048576;
const PASTE_SIZE_THRESHOLD = 80 * 1048576;

// =============================================================================
//  扫描取消机制（Node 引擎）
// =============================================================================
let _scanCancelVersion = 0;

/**
 * 递增取消版本号，使所有正在进行的扫描失效
 */
function cancelScansJS() {
	_scanCancelVersion++;
	global.logMessage(`[CancelScans] JS version bumped to ${_scanCancelVersion}`, "DEBUG");
	return _scanCancelVersion;
}

/**
 * 获取当前取消版本号
 */
function getScanCancelVersion() {
	return _scanCancelVersion;
}

/**
 * 检查扫描是否已被取消
 */
function isScanCancelled(myVersion) {
	return _scanCancelVersion !== myVersion;
}

// Keep ffmpeg loading in qqq as it was
let extensionContext = null;
let cacheDir = null;
let cacheMeta = null;
let _statusBarTimer = null;
let activeSidebarProvider = null;

// ============================================================================
// Cache Meta Logic (Retained in qqq)
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
	return global.canonicalizeExistingPath(p);
}

function cacheKeyForPath(p) {
	return global.cacheKeyForPath(p);
}

// ============================================================================
// Cache Initialization & Management
// ============================================================================
async function initCache(context) {
	const globalStoragePath = context.globalStorageUri?.fsPath || context.globalStoragePath;
	if (!globalStoragePath) {
		global.logMessage("initCache: globalStoragePath is undefined!", "ERROR");
		return;
	}
	cacheDir = path.join(globalStoragePath, CACHE_DIR_NAME);
	if (!fs.existsSync(cacheDir)) {
		try {
			await fs.promises.mkdir(cacheDir, { recursive: true });
		} catch (e) { }
	}
	await loadCacheMetaAsync();
	// validateCache 不在启动阶段执行，避免阻塞，改为延时后台执行
	setTimeout(() => {
		validateCacheAsync().catch(() => { });
	}, 10000);
}

async function loadCacheMetaAsync() {
	const metaPath = path.join(cacheDir, META_FILE_NAME);
	try {
		if (fs.existsSync(metaPath)) {
			const data = await fs.promises.readFile(metaPath, "utf-8");
			cacheMeta = JSON.parse(data);
			if (!cacheMeta.entries) cacheMeta.entries = {};
			if (!cacheMeta.stats) cacheMeta.stats = { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };
			if (!cacheMeta.brokenFiles) cacheMeta.brokenFiles = {};
			if (!cacheMeta.fileIndex) cacheMeta.fileIndex = {};
			if (!cacheMeta.icons) cacheMeta.icons = {};
		} else {
			cacheMeta = createEmptyMeta();
		}
	} catch (e) {
		cacheMeta = createEmptyMeta();
	}
}

async function validateCacheAsync() {
	if (!cacheDir || !cacheMeta) return;

	let changed = false;
	let realSize = 0;
	let realCount = 0;
	const actualFiles = new Set();

	try {
		const files = await fs.promises.readdir(cacheDir);
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
					const st = await fs.promises.stat(filePath);
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
		// 保护图标文件不被误删，除非它们在 meta 中已不存在
		if (orphan.startsWith("icon_") && orphan.endsWith(".png")) {
			continue;
		}
		try {
			await fs.promises.unlink(path.join(cacheDir, orphan));
			changed = true;
		} catch (e) { }
	}

	// Validate Source File Index
	if (cacheMeta.fileIndex) {
		const fps = Object.keys(cacheMeta.fileIndex);
		for (const fp of fps) {
			const p = cacheMeta.fileIndex[fp];
			if (!fs.existsSync(p)) {
				delete cacheMeta.fileIndex[fp];
				changed = true;
			}
		}
	}

	cacheMeta.stats.totalSize = realSize;
	cacheMeta.stats.fileCount = realCount;

	if (changed) {
		saveCacheMeta();
		updateStatusBarThrottled();
	}
}

function createEmptyMeta() {
	return {
		entries: {},
		stats: { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 },
		brokenFiles: {},
		fileIndex: {}, // Persistent Source File Index (Fingerprint -> Path)
		icons: {}
	};
}


// 返回一个 Promise，确保调用者可以等待 meta.json 写入完成
function saveCacheMeta() {
	if (!cacheDir || !cacheMeta) return Promise.resolve();

	return metaSaveQueue.enqueue(async () => {
		try {
			const data = JSON.stringify(cacheMeta, null, 2);
			const metaPath = path.join(cacheDir, META_FILE_NAME);
			await fs.promises.writeFile(metaPath, data, "utf-8");
		} catch (e) {
			global.logMessage("Meta save failed: " + e.message, "ERROR");
		}
	});
}

function isValidWebPBuffer(buffer) {
	if (!buffer || buffer.length < 12) return false;
	// Check for RIFF header and WEBP signature
	const isWebP = buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
	if (!isWebP) return false;

	// Basic sanity check: file size shouldn't be suspiciously small for a WebP
	// (Except for very small icons, but even then < 64 bytes is suspicious)
	if (buffer.length < 64) return false;

	return true;
}

// ============================================================================
// Performance-first helpers (status bar throttling, broken-file circuit breaker,
// fingerprint memoization, and ffprobe verification on-demand)
// ============================================================================

// Throttle status bar updates to avoid UI churn on large batches
let _nextStatusBarAt = 0;
let _statusBarPending = false;
function updateStatusBarThrottled() {
	const now = Date.now();
	if (now >= _nextStatusBarAt) {
		_nextStatusBarAt = now + 400;
		try { updateStatusBarNow(); } catch { }
		return;
	}
	if (_statusBarPending) return;
	_statusBarPending = true;
	const delay = Math.max(0, _nextStatusBarAt - now);
	setTimeout(() => {
		_statusBarPending = false;
		_nextStatusBarAt = Date.now() + 400;
		try { updateStatusBarNow(); } catch { }
	}, delay);
}

// Fingerprint memoization (dramatically reduces redundant hashing on re-render)
const _fpCache = new Map(); // key -> fingerprint
const FP_CACHE_MAX = 2048;
const _computeFingerprintRaw = h.computeFingerprint;

function computeFingerprintCached(filePath) {
	if (!filePath) return null;
	let st = null;
	try { st = fs.statSync(filePath); } catch { /* ignore */ }

	const mtimeMsNorm = st ? Math.floor(st.mtimeMs) : undefined;
	const sig = st ? `${cacheKeyForPath(filePath)}|${mtimeMsNorm}|${st.size}` : `${cacheKeyForPath(filePath)}|nostat`;

	const cached = _fpCache.get(sig);
	if (cached) {
		// LRU touch
		_fpCache.delete(sig);
		_fpCache.set(sig, cached);
		return cached;
	}

	const fp = _computeFingerprintRaw(filePath);
	if (fp) {
		// global.logMessage(`[Fingerprint] COMPUTE: filePath=${filePath.slice(-40)}, fp=${fp}, cacheKey=${cacheKeyForPath(filePath)}, mtime=${mtimeMsNorm}, size=${st?.size}`, "DEBUG");
		_fpCache.set(sig, fp);
		if (_fpCache.size > FP_CACHE_MAX) {
			const firstKey = _fpCache.keys().next().value;
			_fpCache.delete(firstKey);
		}
	}
	return fp;
}

function _isRemoteLikePath(p) {
	if (!p) return false;
	// UNC paths or network-like prefixes on Windows
	return (p.startsWith("\\\\") || p.startsWith("//"));
}

function _getFileSig(p) {
	try {
		const st = fs.statSync(p);
		return { mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return { mtimeMs: 0, size: 0 };
	}
}

// Broken-file circuit breaker (prevents repeated expensive ffmpeg retries on known-bad sources)
const BROKEN_BASE_TTL_MS = 120000;        // 2 minutes
const BROKEN_MAX_TTL_MS = 86400000;   // 24 hours
const BROKEN_GC_INTERVAL_MS = 1800000;    // 30 minutes
const BROKEN_MAX_RECORDS = 6000;
let _lastBrokenGcAt = 0;

function _gcBrokenFilesIfNeeded() {
	const now = Date.now();
	if (now - _lastBrokenGcAt < BROKEN_GC_INTERVAL_MS) return;
	_lastBrokenGcAt = now;

	if (!cacheMeta?.brokenFiles) return;

	// Drop expired
	for (const [cid, rec] of Object.entries(cacheMeta.brokenFiles)) {
		if (!rec || typeof rec !== "object") {
			delete cacheMeta.brokenFiles[cid];
			continue;
		}
		if (rec.until && now > rec.until) delete cacheMeta.brokenFiles[cid];
	}

	// Cap record count (keep most recently seen)
	const keys = Object.keys(cacheMeta.brokenFiles);
	if (keys.length > BROKEN_MAX_RECORDS) {
		keys.sort((a, b) => (cacheMeta.brokenFiles[b]?.ts || 0) - (cacheMeta.brokenFiles[a]?.ts || 0));
		for (const cid of keys.slice(BROKEN_MAX_RECORDS)) delete cacheMeta.brokenFiles[cid];
	}

	saveCacheMeta();
}

function getBrokenFileRecord(contentId) {
	if (!cacheMeta?.brokenFiles) return null;
	const rec = cacheMeta.brokenFiles[contentId];
	return rec ? { ...rec } : null;
}

function isBrokenFile(contentId, filePath = null) {
	if (!cacheMeta?.brokenFiles?.[contentId]) return false;

	_gcBrokenFilesIfNeeded();

	const rec = cacheMeta.brokenFiles[contentId];
	const now = Date.now();

	// Expired
	if (rec.until && now > rec.until) {
		delete cacheMeta.brokenFiles[contentId];
		saveCacheMeta();
		return false;
	}

	// Source changed -> auto-unbreak
	if (filePath && rec.mtimeMs && rec.size !== undefined) {
		const sig = _getFileSig(filePath);
		if (sig.mtimeMs && (sig.mtimeMs !== rec.mtimeMs || sig.size !== rec.size)) {
			delete cacheMeta.brokenFiles[contentId];
			saveCacheMeta();
			return false;
		}
	}

	return true;
}

function markFileAsBroken(contentId, filePath = null, reason = "unknown", opts = {}) {
	if (!cacheMeta) return null;
	if (!cacheMeta.brokenFiles) cacheMeta.brokenFiles = {};

	const now = Date.now();
	const prev = cacheMeta.brokenFiles[contentId] || null;

	const increment = opts.increment !== false; // default true
	const prevCount = prev?.count || 0;
	const count = increment ? (prevCount + 1) : prevCount;

	let ttl = BROKEN_BASE_TTL_MS * Math.pow(2, Math.max(0, count - 1));
	ttl = Math.min(ttl, BROKEN_MAX_TTL_MS);

	// Allow forcing TTL (e.g., verified corruption)
	if (opts.forceTtlMs && Number.isFinite(opts.forceTtlMs)) ttl = Math.min(Math.max(1000, opts.forceTtlMs), BROKEN_MAX_TTL_MS);

	const sig = filePath ? _getFileSig(filePath) : { mtimeMs: prev?.mtimeMs || 0, size: prev?.size || 0 };

	const rec = {
		ts: now,
		until: now + ttl,
		count,
		reason: String(reason || "unknown").slice(0, 160),
		mtimeMs: sig.mtimeMs || 0,
		size: sig.size || 0,
	};

	cacheMeta.brokenFiles[contentId] = rec;
	saveCacheMeta();
	return { ...rec };
}

function unmarkFileAsBroken(contentId) {
	if (!cacheMeta?.brokenFiles?.[contentId]) return;
	delete cacheMeta.brokenFiles[contentId];
	saveCacheMeta();
}

function shouldVerifySourceAfterFailure(stderr) {
	const s = String(stderr || "").toLowerCase();
	// Patterns that strongly suggest the SOURCE is corrupted or structurally invalid
	return (
		s.includes("moov atom not found") ||
		s.includes("invalid data found when processing input") ||
		s.includes("could not find codec parameters") ||
		s.includes("error while decoding") ||
		s.includes("end of file") ||
		s.includes("truncated") ||
		s.includes("invalid nal unit") ||
		s.includes("matroska:") ||
		s.includes("ebml") ||
		s.includes("header missing")
	);
}

/**
 * Verify a media file using ffprobe (on-demand only).
 * Returns {width,height,duration} or null. Skips remote paths by default.
 */
async function verifyMediaFile(filePath, opts = {}) {
	if (!global.ffprobePath()) return null;
	if (!filePath || !fs.existsSync(filePath)) return null;

	if (!opts.allowRemote && _isRemoteLikePath(filePath)) return null;

	const timeoutMs = Math.max(500, Math.min(5000, Number(opts.timeoutMs || 2000)));

	return new Promise((resolve) => {
		const args = [
			"-v", "error",
			"-select_streams", "v:0",
			"-show_entries", "stream=width,height,duration",
			"-of", "json",
			filePath
		];

		const child = cp.spawn(global.ffprobePath(), args, { windowsHide: true });
		let stdout = "";
		let done = false;

		const finish = (val) => {
			if (done) return;
			done = true;
			resolve(val);
		};

		child.stdout.on("data", (data) => {
			// Cap memory; ffprobe JSON is tiny but keep safe
			if (stdout.length < 262144) stdout += data;
		});

		child.on("close", (code) => {
			if (code !== 0) return finish(null);
			try {
				const data = JSON.parse(stdout || "{}");
				const s = data?.streams?.[0];
				if (s && Number(s.width) > 0 && Number(s.height) > 0) {
					finish({
						width: parseInt(s.width, 10),
						height: parseInt(s.height, 10),
						duration: parseFloat(s.duration) || 0
					});
					return;
				}
				finish(null);
			} catch {
				finish(null);
			}
		});

		child.on("error", () => finish(null));

		setTimeout(() => {
			try { child.kill(); } catch { }
			finish(null);
		}, timeoutMs);
	});
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

// 返回 Promise，调用者可以 await 确保 meta.json 写入完成
async function setCacheEntry(contentId, quality, buffer, meta) {
	if (!cacheDir || !cacheMeta) {
		global.logMessage(`[Cache] SETUP_FAIL: cacheDir or cacheMeta not ready`, "WARN");
		return null;
	}

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
		global.logMessage(`[Cache] WRITE: ${fileName} (${buffer.length} bytes)`, "INFO");
	} catch (e) {
		global.logMessage(`[Cache] WRITE_FAIL: ${fileName}: ${e.message}`, "WARN");
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

	global.logMessage(`[Cache] SAVED_META: ${fileName}, total=${cacheMeta.stats.totalSize}, count=${cacheMeta.stats.fileCount}`, "DEBUG");
	// 异步等待 meta.json 写入完成，确保后续 getCachedBuffer 查询时能看到最新的条目
	try {
		await saveCacheMeta();
	} catch (e) {
		global.logMessage(`[Cache] ASYNC_SAVE_FAIL: ${e.message}`, "WARN");
	}
	updateStatusBarThrottled();

	return filePath;
}

function getCachedBuffer(contentId, quality) {
	if (!cacheDir || !cacheMeta) return null;

	const entry = cacheMeta.entries[contentId];
	if (!entry?.qualities?.[quality]) {
		cacheMeta.stats.missCount++;
		global.markCacheMiss();
		updateStatusBarThrottled();
		global.logMessage(`[Cache] MISS: contentId=${contentId}, quality=${quality} (entry not in meta)`, "DEBUG");
		return null;
	}

	const fileName = `${contentId}.${quality}`;
	const filePath = path.join(cacheDir, fileName);

	try {
		if (fs.existsSync(filePath)) {
			const buffer = fs.readFileSync(filePath);
			// global.logMessage(`[Cache] FILE FOUND: ${fileName} (${buffer.length} bytes)`, "DEBUG");

			// Only enforce WebP sanity checks for unified WebP cache (backwards-compatible)
			const fmt = entry?.qualities?.[quality]?.format;
			if (!fmt || fmt === "webp_unified") {
				if (!isValidWebPBuffer(buffer)) {
					global.logMessage(`Cache file corrupted: ${fileName}`, "WARN");
					try { fs.unlinkSync(filePath); } catch { }
					// fall through to cache cleanup below
				} else {
					entry.atime = Date.now();
					cacheMeta.stats.hitCount++;
					global.markCacheHit();
					// global.logMessage(`[Cache] HIT: ${fileName} (id=${contentId.slice(0, 8)}...)`, "INFO");
					updateStatusBarThrottled();
					return buffer;
				}
			} else {
				// Unknown/legacy format: keep old behavior
				entry.atime = Date.now();
				cacheMeta.stats.hitCount++;
				global.markCacheHit();
				global.logMessage(`[Cache] HIT (legacy): ${fileName} (id=${contentId.slice(0, 8)}...)`, "INFO");
				updateStatusBarThrottled();
				return buffer;
			}
		}
	} catch (e) {
		global.logMessage(`[Cache] ERROR reading ${fileName}: ${e.message}`, "WARN");
	}

	global.logMessage(`[Cache] FILE_NOTFOUND or ERROR: ${fileName}`, "DEBUG");
	cacheMeta.stats.missCount++;
	global.markCacheMiss();

	delete entry.qualities[quality];
	if (Object.keys(entry.qualities).length === 0) {
		delete cacheMeta.entries[contentId];
	}
	saveCacheMeta();

	updateStatusBarThrottled();

	return null;
}


// ============================================================================
// Source File Index (Deduplication)
// ============================================================================
function registerSourceFile(filePath) {
	if (!filePath || !fs.existsSync(filePath)) return null;
	const fp = computeFingerprintCached(filePath);
	if (fp) {
		if (!cacheMeta.fileIndex) cacheMeta.fileIndex = {};
		cacheMeta.fileIndex[fp] = filePath;
		h.prefillFingerprint(filePath, fp); // Sync to memory
		saveCacheMeta();
	}
	return fp;
}

function findSourceFile(fingerprint) {
	if (!cacheMeta?.fileIndex) return null;
	const p = cacheMeta.fileIndex[fingerprint];
	if (p && fs.existsSync(p)) return p;
	if (p) {
		// Stale entry
		delete cacheMeta.fileIndex[fingerprint];
		saveCacheMeta();
	}
	return null;
}

// ============================================================================
// Clipboard Logic (Delegated to h.js)
// ============================================================================

// VS Code progress adapter
function makeVsProgressAdapter(progress) {
	let last = 0;
	return (absPct, msg) => {
		const now = Math.max(0, Math.min(100, Number(absPct) || 0));
		const inc = Math.max(0, now - last);
		last = now;
		try { progress.report({ message: msg, increment: inc }); } catch { }
	};
}

async function raceClipboard(targetDir, callback, autoRename = false) {
	return pasteQueue.enqueue(async () => {
		const transId = global.TransactionManager.createTransactionId();
		try {
			const res = await global.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "qqq: 文件复制...",
				cancellable: true
			}, async (progress, token) => {
				token.onCancellationRequested(async () => {
					global.logMessage(`粘贴操作被用户取消 (${transId})`, "WARN");
					await global.TransactionManager.rollback(transId);
				});

				// ★ 注册事务，让 IO 引擎享有完美的事务包裹流程
				await global.TransactionManager.saveTransaction({
					id: transId,
					targetDir: targetDir,
					tempFiles: [],
					landedFiles: [],
					landedFolders: [],
					startTime: Date.now(),
					taskType: 'local_file',
					existingFiles: await global.getDirectorySnapshot(targetDir)
				});

				const progCb = makeVsProgressAdapter(progress);

				// ★ Delegate all detection and handling to h.js, passing transId and autoRename
				const result = await h.autoDetectAndPaste(targetDir, progCb, token, transId, null, null, null, autoRename);

				if (token.isCancellationRequested) {
					// 已在 onCancellationRequested 处理 rollback
					return null;
				}

				// 成功完成，移除事务记录
				if (result) {
					await global.TransactionManager.removeTransaction(transId);
				}
				return result;
			});

			// ★ 无论结果如何都调用 callback，确保用户能看到结果
			if (res) {
				// 如果所有文件都被跳过，显示警告
				if (res.type === "file_folder" && res.files?.length === 0 && res.folders?.length === 0 && res.skippedCount > 0) {
					global.logMessage(`所有 ${res.skippedCount} 个文件都无法访问，已跳过`, "WARN");
				}
				if (callback) callback(res, 100);
			}
		} catch (e) {
			global.logMessage(`raceClipboard failed: ${e.message}`, "ERROR");
			await global.TransactionManager.rollback(transId).catch(() => { });
		}
	});
}

async function handleClipboardFast() {
	return null; // Deprecated / Not used in read code
}

async function handleClipboardSlow(targetDir, qStart = Date.now(), typeHint = null, partialCallback = null, token = null) {
	// Wrapper to match old signature if called directly, but prefer raceClipboard
	return await h.autoDetectAndPaste(targetDir, partialCallback, token);
}


// ============================================================================
// Other Helpers
// ============================================================================

async function getFolderInfo(folderPath) {
	folderPath = canonicalizeExistingPath(folderPath) || folderPath;
	const startTime = Date.now();

	const res = await tryEngineCall({
		python: "folder_info",
		rust: "folder_info"
	}, { path: folderPath }, 15000);

	if (res) {
		const elapsed = Date.now() - startTime;
		global.logMessage(`[FolderScan] ${folderPath}: ${elapsed}ms, ${res.file_count_root || 0}文件, ${global.formatBytes(res.total_size || 0)}`, "DEBUG");
		return res;
	}

	return getFolderInfoJS(folderPath, startTime);
}

async function getFolderInfoJS(folderPath, startTime = null) {
	if (!startTime) startTime = Date.now();
	if (!fs.existsSync(folderPath)) return { error: "not_found" };

	let totalSize = 0;
	let fileCount = 0;
	const extStats = {};

	// 性能优化：使用迭代而非递归，并利用 Promise.all 控制并发，避免深层目录导致的栈溢出和单线程阻塞
	const queue = [folderPath];
	while (queue.length > 0) {
		const currentDir = queue.shift();
		try {
			const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

			// 批量获取 stats
			await Promise.all(entries.map(async (entry) => {
				const fullPath = path.join(currentDir, entry.name);
				if (entry.isDirectory()) {
					queue.push(fullPath);
				} else if (entry.isFile()) {
					try {
						const st = await fs.promises.stat(fullPath);
						totalSize += st.size;
						fileCount++;
						const ext = path.extname(entry.name).toLowerCase().replace(".", "") || "no_ext";
						extStats[ext] = (extStats[ext] || 0) + 1;
					} catch { }
				}
			}));
		} catch { }
	}

	const elapsed = Date.now() - startTime;
	global.logMessage(`[FolderScan] ${folderPath}: ${elapsed}ms, ${fileCount}文件, ${global.formatBytes(totalSize)} (JS)`, "DEBUG");

	return {
		success: true,
		total_size: totalSize,
		file_count_root: fileCount,
		ext_stats: extStats,
	};
}

/**
 * 极限优化版：只获取文件/目录大小，不统计后缀名、文件数
 * 适用场景：szDisplayMode="size" 时只需要知道大小
 * @param {string} targetPath 文件或目录路径
 * @returns {Promise<{success: boolean, total_size?: number, error?: string}>}
 */
async function getPathSize(targetPath) {
	targetPath = canonicalizeExistingPath(targetPath) || targetPath;
	const startTime = Date.now();

	const res = await tryEngineCall({
		python: "path_size",
		rust: "path_size"
	}, { path: targetPath }, 15000);

	if (res) {
		const elapsed = Date.now() - startTime;
		global.logMessage(`[PathSize] ${targetPath}: ${elapsed}ms, ${global.formatBytes(res.total_size || 0)}`, "DEBUG");
		return res;
	}

	return getPathSizeJS(targetPath, startTime);
}

/**
 * JS 回退实现：只获取大小（简化版本，支持取消）
 */
async function getPathSizeJS(targetPath, startTime = null, cancelVersion = null) {
	if (!startTime) startTime = Date.now();
	if (cancelVersion === null) cancelVersion = getScanCancelVersion();

	if (!fs.existsSync(targetPath)) return { success: false, error: "not_found" };

	try {
		const st = await fs.promises.stat(targetPath);
		if (st.isFile()) {
			return { success: true, total_size: st.size };
		}
	} catch {
		return { success: false, error: "stat_failed" };
	}

	let totalSize = 0;
	let checkCount = 0;
	const queue = [targetPath];

	while (queue.length > 0) {
		// 每 100 个目录检查一次取消（Node 比 Rust/Python 慢，所以用更小的间隔）
		if (++checkCount % 100 === 0) {
			if (isScanCancelled(cancelVersion)) {
				global.logMessage(`[PathSize] ${targetPath}: cancelled after ${checkCount} dirs`, "DEBUG");
				return { success: false, cancelled: true };
			}
		}

		const currentDir = queue.shift();
		try {
			const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(currentDir, entry.name);
				if (entry.isDirectory()) {
					queue.push(fullPath);
				} else if (entry.isFile()) {
					try {
						const st = await fs.promises.stat(fullPath);
						totalSize += st.size;
					} catch { }
				}
			}
		} catch { }
	}

	const elapsed = Date.now() - startTime;
	global.logMessage(`[PathSize] ${targetPath}: ${elapsed}ms, ${global.formatBytes(totalSize)} (JS)`, "DEBUG");

	return { success: true, total_size: totalSize };
}

/**
 * 获取磁盘剩余空间
 * @param {string} drive - 盘符，如 "C:" 或 "C:\\"
 * @returns {Promise<{success: boolean, free?: number, total?: number, error?: string}>}
 */
async function getDiskFree(drive = "C:") {
	const res = await tryEngineCall({
		python: "disk_free",
		rust: "disk_free"
	}, { drive: drive }, 2000);

	if (res && res.success) {
		return res;
	}

	// JS 回退：使用 Node.js 的 fs.statfs（Node 18.15+）或 child_process
	return getDiskFreeJS(drive);
}

/**
 * JS 回退：获取磁盘剩余空间
 */
async function getDiskFreeJS(drive = "C:") {
	try {
		// 确保盘符格式正确
		let d = drive.toUpperCase().replace(/[^A-Z]/g, "") || "C";
		const drivePath = d + ":\\";

		// Node 18.15+ 有 fs.statfs
		if (fs.statfs) {
			return new Promise((resolve) => {
				fs.statfs(drivePath, (err, stats) => {
					if (err) {
						resolve({ success: false, error: err.message });
					} else {
						const free = stats.bavail * stats.bsize;
						const total = stats.blocks * stats.bsize;
						resolve({ success: true, free, total, used: total - free });
					}
				});
			});
		}

		// 回退：wmic 命令
		const cp = require("child_process");
		return new Promise((resolve) => {
			cp.execFile("wmic", ["logicaldisk", "where", `DeviceID='${d}:'`, "get", "FreeSpace", "/value"],
				{ windowsHide: true, timeout: 2000 },
				(err, stdout) => {
					if (err) {
						resolve({ success: false, error: err.message });
						return;
					}
					const match = stdout.match(/FreeSpace\s*=\s*(\d+)/i);
					if (match) {
						resolve({ success: true, free: parseInt(match[1], 10) });
					} else {
						resolve({ success: false, error: "parse_failed" });
					}
				}
			);
		});
	} catch (e) {
		return { success: false, error: e.message };
	}
}


function shouldShowDuration(info) {
	return info && (info.type === "video" || info.type === "animated_image") && info.duration > 0.1;
}

let downloadContext = null;

// =============================================================================
// 音频播放状态管理
// =============================================================================
let _pythonAudioChecked = false;
let _pythonAudioAvailable = false;
let _pythonAudioError = null;

/**
 * ★ 重置 Python 音频引擎缓存（当 Python 环境"从无到有"时调用）
 */
function resetPythonAudioCache() {
	_pythonAudioChecked = false;
	_pythonAudioAvailable = false;
	_pythonAudioError = null;
}

async function checkPythonAudioEngine() {
	if (_pythonAudioChecked) {
		return _pythonAudioAvailable;
	}

	try {
		const bridge = pythonBridge;
		if (!bridge || bridge.available !== true) {
			_pythonAudioChecked = true;
			_pythonAudioAvailable = false;
			return false;
		}

		const res = await bridge.call('check_audio_engine');
		if (res && res.has_miniaudio) {
			const version = res.miniaudio_version || 'unknown';
			global.logMessage(`[Audio] Python (miniaudio v${version}) 检测成功`, "INFO");
			global.pythonAudioDetected = true;
			_pythonAudioChecked = true;
			_pythonAudioAvailable = true;
			return true;
		} else {
			_pythonAudioError = res?.error || 'miniaudio not available';
			// 在日志面板打印错误原因
			global.logMessage(`[Audio] Python 引擎不可用: ${_pythonAudioError}`, "WARN");
		}
	} catch (e) {
		_pythonAudioError = e.message;
		global.logMessage(`[Audio] Python 引擎检测异常: ${e.message}`, "WARN");
	}

	_pythonAudioChecked = true;
	_pythonAudioAvailable = false;
	return false;
}

/**
 * 获取 Savor 音频信息（随机选择）
 */
function getSavorAudioInfo(context) {
	const getRand = (min, max) => crypto.randomInt ? crypto.randomInt(min, max) : Math.floor(Math.random() * (max - min)) + min;
	const rand = getRand(0, 30);
	let filename;
	if (rand === 0) {
		filename = "q.mp3";
	} else {
		const subRand = getRand(0, 3);
		filename = `${subRand + 1}.mp3`;
	}
	const fullPath = path.join(context.extensionPath, "assets", filename);
	return {
		path: fullPath,
		fileName: filename,
		base64: () => {
			try {
				return fs.existsSync(fullPath) ? fs.readFileSync(fullPath).toString('base64') : '';
			} catch { return ''; }
		}
	};
}

/**
 * 随机生成循环次数 (2-6)
 */
function getRandomLoopCount() {
	const getRand = (min, max) => crypto.randomInt ? crypto.randomInt(min, max) : Math.floor(Math.random() * (max - min)) + min;
	return getRand(2, 7);
}

async function savorMomentsCommand() {
	try {
		// ★ 保护性检查：确保 extensionContext 已初始化
		if (!extensionContext || !extensionContext.extensionPath) {
			global.logMessage('[Audio] extensionContext 未初始化，等待中...', "WARN");
			// 回退到 webview 播放（不打开侧边栏）
			if (activeSidebarProvider && activeSidebarProvider.isWebviewReady) {
				activeSidebarProvider.triggerSavor('normal');
				return;
			}
			// ★ 核心理念：永远不改变用户侧边栏布局，只弹窗提示
			vscode.window.showInformationMessage('qqq: 请点击侧边按钮开始放松。');
			return;
		}

		// 第一步：检测 Python 音频引擎
		const pythonAvailable = await checkPythonAudioEngine();

		if (pythonAvailable) {
			// ★ Python 引擎可用，直接播放（不需要 webview，不打开侧边栏）
			const info = getSavorAudioInfo(extensionContext);
			const loopCount = getRandomLoopCount();

			global.logMessage(`[Audio] Python 引擎播放: ${info.fileName}, 循环: ${loopCount}`, "INFO");

			try {
				const res = await pythonBridge.call('play_audio', { path: info.path, count: loopCount });
				if (res && (res.status === 'ok' || res.status === 'playing')) {
					// ★ 无论 q4 是否打开，都记录 Python 播放状态
					if (activeSidebarProvider) {
						activeSidebarProvider._pythonPlayState = {
							playing: true,
							fileName: info.fileName,
							loopCount: loopCount,
							startTime: Date.now()
						};
					}
					// ★ 如果 q4 webview 已经打开，同步 UI 状态（不主动打开）
					if (activeSidebarProvider && activeSidebarProvider.isWebviewReady) {
						activeSidebarProvider.syncPythonPlayState(info.fileName, loopCount, true);
					}
					return;
				}
				// Python 播放失败，回退到 webview
				global.logMessage(`[Audio] Python 播放失败: ${res?.error || 'unknown'}`, "WARN");
			} catch (e) {
				global.logMessage(`[Audio] Python 播放异常: ${e.message}`, "WARN");
			}
		}

		// 第二步：Python 不可用或失败，检查 webview（不打开侧边栏）
		if (activeSidebarProvider && activeSidebarProvider.isWebviewReady) {
			// Webview 已准备好，使用 webview 播放
			activeSidebarProvider.triggerSavor('normal');
			return;
		}

		// 第三步：都不可用，弹出 q弹窗（★ 核心理念：永远不改变用户侧边栏布局）
		vscode.window.showInformationMessage('qqq: 请点击侧边按钮开始放松。');
	} catch (e) {
		global.logMessage(`播放音频失败: ${e.message}`, "ERROR");
	}
}

async function downloadVideosFromUrlCommand(urlArg) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("请先打开一个文档");
		return;
	}

	if (editor.document.isUntitled) {
		vscode.window.showInformationMessage("qqq: 只能使用原始粘贴。解决方案：保存文件。");
		return;
	}

	let rawUrl = urlArg;
	if (!rawUrl) {
		rawUrl = await vscode.window.showInputBox({
			prompt: " ",
			ignoreFocusOut: true,
			placeHolder: " 直接粘贴 [ 包含视频的网址 ]",
			validateInput: (text) => {
				const s = (text || "").trim();
				if (!s) return null;
				return global.isValidUrl(s) ? null : "无效网址";
			}
		});
	}
	if (!rawUrl) return;

	// ★ 将 “已经安装 yt-dlp ” 作为一个先决必要条件 (仅针对 downloadVideosFromUrlCommand)
	const { getSharedDownloader } = require('./dow');
	const downloader = getSharedDownloader();
	const isYtdlpReady = await downloader.ensureYtdlpReady(extensionContext, { silent: true });
	if (!isYtdlpReady) {
		return;
	}

	const currentDocDir = path.dirname(editor.document.uri.fsPath);
	const targetDir = path.join(currentDocDir, "qqq");
	if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

	const transId = global.TransactionManager.createTransactionId();
	const targetUri = editor.document.uri;

	// ★ 生成 taskTitle
	const filePath = editor.document.uri.fsPath;
	const taskNum = await global.TaskCounter.increment(filePath);  // 数据库递增编号（按文件）
	const iconNum = await global.TaskCounter.incrementIcon();  // 全局图形编号（跨文件）
	const taskTitle = global.TaskCounter.formatTitle(filePath, transId, iconNum);  // 标题用 transId + 图形

	// 1. 立即插入锚点
	await global.TransactionManager.insertAnchor(editor, transId);

	// ★ 保存事务到 globalState
	await global.TransactionManager.saveTransaction({
		id: transId,
		targetDir: targetDir,
		targetUri: targetUri.fsPath,
		tempFiles: [],
		landedFiles: [],
		landedFolders: [],
		taskType: 'video',  // ★ 视频下载任务
		existingFiles: await global.getDirectorySnapshot(targetDir)  // ★ 任务开始时的目录快照
	});

	// 2. 启动带进度条的弹窗任务
	// ★ 创建自定义取消源（用于锚点丢失时主动取消）
	const anchor = `/__PENDING_${transId}/`;
	const anchorLostSource = new vscode.CancellationTokenSource();
	let anchorLost = false;
	let lastAnchorCheckTime = 0;
	const ANCHOR_CHECK_INTERVAL = 800;  // 每 800ms 检查一次锚点

	// ★ 锚点检查函数（带节流）
	const checkAnchorExists = async () => {
		if (anchorLost) return false;

		const now = Date.now();
		if (now - lastAnchorCheckTime < ANCHOR_CHECK_INTERVAL) {
			return true;
		}
		lastAnchorCheckTime = now;

		try {
			// ★ 防御性校验：确保文件依然存在，避免 VS Code 内部报错打印
			if (!fs.existsSync(targetUri.fsPath)) {
				if (!anchorLost) {
					anchorLost = true;
					global.logMessage(`[AnchorWatch] 文件不存在，视为锚点丢失: ${targetUri.fsPath}`, 'WARN');
					anchorLostSource.cancel();
				}
				return false;
			}
			const doc = await vscode.workspace.openTextDocument(targetUri);
			const text = doc.getText();
			const exists = text.includes(anchor);

			if (!exists && !anchorLost) {
				anchorLost = true;
				global.logMessage(`[AnchorWatch] 锚点丢失，立即触发回滚: ${anchor}`, 'WARN');
				anchorLostSource.cancel();
				return false;
			}
			return exists;
		} catch (e) {
			if (!anchorLost) {
				anchorLost = true;
				global.logMessage(`[AnchorWatch] 无法读取文档，视为锚点丢失: ${e.message}`, 'WARN');
				anchorLostSource.cancel();
			}
			return false;
		}
	};

	// ★ shouldCancel 回调：返回当前状态，同时触发后台检查
	const shouldCancelCallback = () => {
		// 先返回当前状态
		if (anchorLost) return true;
		// 后台触发检查（不等待结果）
		checkAnchorExists().catch(() => { });
		return anchorLost;
	};

	// 3. 定义结果处理函数（复用）
	const processResult = async (res) => {
		if (res && res.needEnhancedAction) {
			return res;
		}

		if (res && res.landedFiles && res.landedFiles.length > 0) {
			const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
			const relativePaths = res.landedFiles.map(f => {
				const rel = path.relative(currentDocDir, f).replace(/\\/g, '/');
				return `/\\${rel}\\/`;
			});
			// 按照 q1.js 的洁癖标准处理每个视频文件
			let replacement = "";
			for (let i = 0; i < res.landedFiles.length; i++) {
				const f = res.landedFiles[i];
				const relPath = path.relative(currentDocDir, f).replace(/\\/g, '/');
				const isLastItem = i === res.landedFiles.length - 1;

				// 添加文件路径
				if (i > 0) replacement += eol;
				replacement += `/\\${relPath}\\/`;

				// 为视频文件计算精确的空行数（遵循洁癖标准）
				let pxHeight = q1.LARGE_PREVIEW_HEIGHT;
				try {
					let mtimeMs = 0;
					try { mtimeMs = fs.statSync(f).mtimeMs; } catch { }
					const info = await q1.getMediaInfo(f, mtimeMs || Date.now());
					const { height } = q1.getFrameConfig(info);
					pxHeight = height;
				} catch { }

				let gapBelow = q1.calculateBlankLinesExact(pxHeight, isLastItem);
				if (!isLastItem) gapBelow = Math.max(gapBelow - 1, 0);
				replacement += eol.repeat(gapBelow);
			}
			const newText = replacement;

			// 替换锚点
			const replaced = await replaceAnchorInDoc(targetUri, anchor, newText);
			if (replaced) {
				await global.TransactionManager.removeTransaction(transId);
				return res;
			} else {
				global.logMessage("锚点替换失败，回滚事务", "ERROR");
				await global.TransactionManager.rollback(transId);
				return { ...res, anchorLost: true };
			}
		} else if (res && res.cancelled) {
			await global.TransactionManager.rollback(transId);
			await replaceAnchorInDoc(targetUri, anchor, "");
			return res;
		} else {
			// 下载失败或为 null，回滚
			await global.TransactionManager.rollback(transId);
			await replaceAnchorInDoc(targetUri, anchor, "");
			return { failed: true };
		}
	};

	let downloadResult = await global.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "",  // ★ 标题留空，由 VideoMsg.progress 生成完整消息
		cancellable: true
	}, async (progress, token) => {
		token.onCancellationRequested(() => {
			global.logMessage(`任务 ${transId} 被用户取消`, "WARN");
		});

		// ★ 锚点丢失也触发回滚提示
		anchorLostSource.token.onCancellationRequested(() => {
			global.logMessage('[AnchorLost] 锚点丢失触发取消', 'WARN');
		});

		const Qvideo = require('./qvideo');
		const controller = new Qvideo(downloadContext, module.exports);

		// ★ 进度回调中检查锚点
		const progressAdapter = async (pct, msg) => {
			progress.report({ message: msg, increment: 0 });
			await checkAnchorExists();
		};

		try {
			// ★ 传递 taskTitle 和 shouldCancel 回调
			const res = await controller.downloadEntry(rawUrl, targetDir, transId, progressAdapter, token, targetUri, taskTitle, shouldCancelCallback, taskNum);

			// ★ 检查是否已取消（用户取消 或 锚点丢失）
			if (token.isCancellationRequested || anchorLost) {
				await global.TransactionManager.rollback(transId);
				await replaceAnchorInDoc(targetUri, anchor, "");
				if (anchorLost) {
					return { anchorLost: true };
				}
				return { cancelled: true };
			}

			// ★ 使用统一处理函数
			return await processResult(res);

		} catch (e) {
			global.logMessage(`视频下载任务失败: ${e.message}`, "ERROR");
			vscode.window.showErrorMessage(`视频下载失败: ${e.message}`);
			await global.TransactionManager.rollback(transId);
			await replaceAnchorInDoc(targetUri, anchor, "");
			return null;
		}
	});

	// ★ 处理增强流程（此时前一个弹窗已关闭）
	if (downloadResult && downloadResult.needEnhancedAction) {
		const Qvideo = require('./qvideo');
		const controller = new Qvideo(downloadContext, module.exports);

		// 调用 handleForbidden 并获取最终结果
		let enhancedRes = await controller.handleForbidden(
			downloadResult.task,
			downloadResult.code,
			downloadResult.url,
			downloadResult.targetDir,
			downloadResult.progressCallback
		);

		if (!enhancedRes) enhancedRes = { cancelled: true };

		downloadResult = await processResult(enhancedRes);
	}

	// ★ 进度弹窗结束后，统一显示最终弹窗（唯一真理源）
	if (downloadResult) {
		if (downloadResult.cancelled) {
			// ★ 取消
			global.TaskMessage.showSimpleToast(`${taskTitle} 已取消并回滚`, 15000, 'cancel');
		} else if (downloadResult.anchorLost) {
			// ★ 锚点丢失
			global.TaskMessage.showSimpleToast(`${taskTitle} 锚点丢失，已回滚`, 15000, 'cancel');
		} else if (downloadResult.failed) {
			// ★ 下载失败
			global.TaskMessage.showSimpleToast(`${taskTitle} 下载失败，已回滚`, 15000, 'cancel');
		} else if (downloadResult.doneMessage) {
			// ★ 成功
			global.TaskMessage.showSimpleToast(downloadResult.doneMessage, 15000, 'success');
		}
	}
}

// ==================== 锚点替换辅助 ====================
async function replaceAnchorInDoc(uri, anchor, newText) {
	try {
		// ★ 性能无损校验：在打开前检查文件物理存在，消除 net::ERR_FILE_NOT_FOUND 噪音
		if (!fs.existsSync(uri.fsPath)) return false;
		const doc = await vscode.workspace.openTextDocument(uri);
		const text = doc.getText();
		const idx = text.indexOf(anchor);

		if (idx === -1) return false;

		const pos = doc.positionAt(idx);
		const endPos = doc.positionAt(idx + anchor.length);
		const range = new vscode.Range(pos, endPos);

		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, range, newText);
		return await vscode.workspace.applyEdit(edit);
	} catch (e) {
		return false;
	}
}

let q1Module = null;
let q2Module = null;

async function activate(context) {
	// ★ 终极最优解：启动时立即重置状态，且后续注册必须早于任何 await
	global.setDeactivated(false);
	global.logMessage("qqq 扩展激活（中控模式）...", "INFO");

	if (!context) {
		global.logMessage("activate: context is undefined!", "ERROR");
		return;
	}

	extensionContext = context;
	downloadContext = context;
	global.init(context);

	// ★ 终极版：注入 VIP 模式（待你校验完成后，把 false 换成实际的 isVip 变量）
	const isVip = false; // ★ 当前为非 VIP 模式，所有配置不能保存
	global.setVipMode(isVip);

	// ★ 非 VIP 启动时清空所有 settings.json 中的 qqq.* 配置，确保“重启还原”
	if (!isVip) {
		global.ConfigManager.nonVipBootstrapResetAll().catch(() => { });
	}

	const extensionPath = context.extensionUri?.fsPath || context.extensionPath;
	if (!extensionPath) {
		global.logMessage("activate: extensionPath is undefined!", "ERROR");
		return;
	}

	// ★ 延迟启动策略：onStartupFinished 后再等 3 秒才执行重载初始化
	setTimeout(() => {
		_delayedActivate(context).catch(e => {
			global.logMessage(`延迟初始化失败: ${e?.message || e}`, "ERROR");
		});
	}, 3000);

	// ★ 立即注册命令（不延迟，确保用户可以立即使用）
	_registerCommands(context);
}

// ★ 延迟初始化逻辑（onStartupFinished + 3秒后执行）
async function _delayedActivate(context) {
	global.logMessage("qqq 延迟初始化开始...", "INFO");

	// 已经移至 global.init(context)

	await initCache(context);

	// ★ 预热/静默安装视频引擎和 Python 引擎（延迟 10 秒）
	setTimeout(() => {
		try {
			const { getSharedDownloader } = require('./dow');
			const downloader = getSharedDownloader();
			downloader.ensureYtdlpReady(context, { background: true }).catch(() => { });
			global.logMessage("qqq dow.js 预热开始 (10秒延迟)", "INFO");
		} catch (e) { }
	}, 7000); // 相对于 _delayedActivate 开始，再延迟 7 秒 = 总共 3+7=10 秒

	// 初始化核心模块 (q4 现已合并了剪切板历史逻辑)
	try {
		const q4Api = q4.activate(context);
		global.clipboardHistoryManager = q4Api; // 保持全局引用兼容性
		activeSidebarProvider = q4Api.sidebarProvider; // ★ 正确初始化 activeSidebarProvider
	} catch (e) {
		global.logMessage(`q4 (剪切板/侧边栏) 加载失败: ${e.message}`, "ERROR");
	}
	global.setCacheStatsGetter(() => getCacheStatsSnapshot());
	global.setLogPath(path.join(cacheDir, "err.log"));
	global.initStatusBar();
	updateStatusBarThrottled();

	// ★ startDaemons 延迟 6 秒（相对于 _delayedActivate 开始，再延迟 3 秒 = 总共 3+3=6 秒）
	setTimeout(() => {
		global.logMessage("qqq startDaemons 开始 (6秒延迟)", "INFO");
		startDaemons();
	}, 3000);

	// 设置 CodeLens 样式（通过 ConfigGate 读取）
	function updateCodeLensStyle() {
		const takeOver = global.getConfig("takeOverCodelensStyle");
		if (takeOver === undefined ? true : takeOver) {
			// 设置 CodeLens 字体和字号
			vscode.workspace.getConfiguration("editor").update("codeLensFontFamily", "Tahoma", vscode.ConfigurationTarget.Global);
			vscode.workspace.getConfiguration("editor").update("codeLensFontSize", 13, vscode.ConfigurationTarget.Global);
		}
	}

	// 激活时设置一次
	updateCodeLensStyle();

	// 监听配置变化
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("qqq.takeOverCodelensStyle")) {
				updateCodeLensStyle();
			}
		})
	);
}

// ★ 抽取命令注册到单独函数（立即注册，不延迟）
function _registerCommands(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.showStatusPanel", global.withReady(() => {
			// 聚焦到侧边栏视图
			vscode.commands.executeCommand('workbench.view.extension.qqqView');
		})),
		vscode.commands.registerCommand("qqq.pure", global.withReady(q3.pureCommand)),
		vscode.commands.registerCommand("qqq.allSettings", global.withReady(() => {
			vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
		})),
		vscode.commands.registerCommand("qqq.downloadVideosFromUrl", global.withReady(downloadVideosFromUrlCommand)),
		vscode.commands.registerCommand("qqq.savorMoments", global.withReady(savorMomentsCommand)),
		vscode.commands.registerCommand("qqq.clearCache", global.withReady(async () => {
			// ★ 9秒精确进度条通知（进度条从左滚到右正好9秒后消失，带倒计时）
			const showAutoHideMessage = (message) => {
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: '',
					cancellable: false
				}, async (progress) => {
					const totalSeconds = 9;
					for (let sec = totalSeconds; sec >= 1; sec--) {
						progress.report({ increment: 86 / totalSeconds, message: `${message}    ${sec} s` });
						await new Promise(r => setTimeout(r, 1000));
					}
				});
			};

			const options = [
				{ label: "清除依赖下载滴冷却时间（默认72小时）", description: " 便于立即重新下载", id: "clearCooldown" },
				{ label: "打开缓存目录", description: ` ${cacheDir || '未初始化'}`, id: "openCacheDir" },
				{ label: "删除视频下载组件 yt-dlp", description: "可触发 yt-dlp 更新", id: "deleteYtDlp" },
				{ label: "清理 globalStates 数据库", description: "清空并丢失 ：1、漫游器快速跳转阵列；2、视频增强下载流程已指定滴浏览器入口；3、已缓存滴用于 “事物回滚和文件去重” 滴关键信息；4、漫游器关于不同文件夹 “sz 区打印偏好” 和 “排序” 滴精细记忆。", id: "clearGlobalStates" },
				{ label: "清空剪切板历史记录", description: " ", id: "clearClipboardHistory" }
			];

			const selected = await vscode.window.showQuickPick(options, {
				title: "选择缓存操作",
				placeHolder: "选择要执行的缓存操作"
			});

			if (!selected) return;

			if (selected.id === "clearCooldown") {
				// 清除依赖下载冷却时间
				try {
					// ★ 清除所有相关的 globalState key
					await context.globalState.update('pythonInstallTimestamp', 0);
					await context.globalState.update('python_cooldown_ts', 0);
					await context.globalState.update('pythonDepsInstallTimestamp', 0); // 兼容旧版
					showAutoHideMessage("qqq: 依赖下载冷却时间已清除，可以重新下载依赖。");
				} catch (e) {
					showAutoHideMessage(`qqq: 清除冷却时间失败: ${e.message}`);
				}
			} else if (selected.id === "openCacheDir") {
				// 打开缓存目录
				if (!cacheDir) {
					showAutoHideMessage("qqq: 缓存目录未初始化");
					return;
				}

				try {
					// 确保缓存目录存在
					if (!fs.existsSync(cacheDir)) {
						await fs.promises.mkdir(cacheDir, { recursive: true });
					}
					// 打开文件资源管理器
					if (process.platform === 'win32') {
						// Windows
						cp.spawn('explorer.exe', [cacheDir], { detached: true });
					} else if (process.platform === 'darwin') {
						// macOS
						cp.spawn('open', [cacheDir], { detached: true });
					} else {
						// Linux
						cp.spawn('xdg-open', [cacheDir], { detached: true });
					}
				} catch (e) {
					showAutoHideMessage(`qqq: 打开缓存目录失败: ${e.message}`);
				}
			} else if (selected.id === "deleteYtDlp") {
				// 删除视频下载组件 yt-dlp.exe
				try {
					const globalStoragePath = context?.globalStorageUri?.fsPath;
					if (!globalStoragePath) {
						showAutoHideMessage("qqq: 无法获取存储路径");
						return;
					}
					const ytDlpPath = path.join(globalStoragePath, 'yt-dlp.exe');
					if (fs.existsSync(ytDlpPath)) {
						fs.unlinkSync(ytDlpPath);
						showAutoHideMessage(`qqq: 已删除${ytDlpPath}`);
					} else {
						showAutoHideMessage("qqq: yt-dlp.exe 不存在");
					}
				} catch (e) {
					showAutoHideMessage(`qqq: 删除 yt-dlp.exe 失败: ${e.message}`);
				}
			} else if (selected.id === "clearGlobalStates") {
				// 清理 globalStates 数据库（保留状态区信息）
				try {
					// 状态区 keys（不清除）：用户使用时长、缓存命中、前摇
					const preserveKeys = new Set([
						'qqq_stats_total_seconds',    // 用户使用时长
						'qqq_stats_cache_hit_total',  // 缓存命中
						'qqq_stats_cache_miss_total', // 缓存未命中
						'qqq_wq_stats'                // 前摇时间统计
					]);

					const allKeys = context.globalState.keys();
					let clearedCount = 0;
					let totalSize = 0;

					for (const key of allKeys) {
						if (!preserveKeys.has(key)) {
							const value = context.globalState.get(key);
							try {
								const jsonString = JSON.stringify(value);
								totalSize += Buffer.byteLength(jsonString, 'utf8');
							} catch {
								// 忽略无法序列化的值
							}
							await context.globalState.update(key, undefined);
							clearedCount++;
						}
					}

					const formatBytes = (bytes) => {
						if (bytes === 0) return '0B';
						const k = 1024;
						const sizes = [' b', ' kb', ' Mb'];
						const i = Math.floor(Math.log(bytes) / Math.log(k));
						return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
					};

					showAutoHideMessage(`qqq: globalStates 已清理 ${clearedCount} 条数据，共 ${formatBytes(totalSize)}。`);
				} catch (e) {
					showAutoHideMessage(`qqq: 清理 globalStates 失败: ${e.message}`);
				}
			} else if (selected.id === "clearClipboardHistory") {
				// 清空剪切板历史记录
				try {
					const historyManager = global.clipboardHistoryManager;
					if (historyManager && typeof historyManager.clearHistory === 'function') {
						await historyManager.clearHistory({ deleteFiles: true });
						showAutoHideMessage("qqq: 剪切板历史记录已清空");
					} else {
						showAutoHideMessage("qqq: 剪切板历史管理器未初始化");
					}
				} catch (e) {
					showAutoHideMessage(`qqq: 清空剪切板历史失败: ${e.message}`);
				}
			}
		})),



		// ★ 终极版：统一的设置变更入口（通过 ConfigGate）
		vscode.workspace.onDidChangeConfiguration((event) => {
			global.ConfigManager.handleVscodeConfigChanged(event).then(() => {
				// ioEngine 切换后别处理
				if (event.affectsConfiguration("qqq.ioEngine")) {
					const val = global.getConfig("ioEngine");
					global.logMessage(`引擎切换为: ${val}，更新状态栏`, "INFO");

					if (val === "python") {
						const { getSharedDownloader } = require('./dow');
						const downloader = getSharedDownloader();
						const status = downloader.python.getL1ImperfectStatus();

						if (status.imperfect) {
							const reasonMsg = {
								'no_interpreter': 'Python 解释器未安装',
								'interpreter_invalid': 'Python 解释器不可用',
								'deps_missing': `缺少依赖: ${status.missing.join(', ')}`,
								'no_context': '环境未就绪'
							}[status.reason] || status.reason;
							global.logMessage(`[IO引擎] Python 环境不完美: ${reasonMsg}，将回退到其他引擎`, "WARN");
						}
					}

					updateStatusBarThrottled();
				}
			}).catch(() => { });
		})
	);

	loadSubModules(context);

	if (_statusBarTimer) clearInterval(_statusBarTimer);
	_statusBarTimer = setInterval(() => {
		try {
			updateStatusBarThrottled();
		} catch { }
	}, 5000);

	// ★ 终极最优解：启动时恢复/清理事务 (移至 activate 底部或后台执行)
	// 不要让它阻塞主注册流程
	(async () => {
		try {
			await global.TransactionManager.recover();
		} catch (e) {
			global.logMessage(`事务恢复失败: ${e.message}`, "ERROR");
		} finally {
			// ★ 无论成功失败，推开信号灯，允许命令执行
			global.markReady();
		}
	})();

	global.logMessage("qqq 扩展激活完成", "INFO");
}

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
	// ★ 终极最优解：焦土政策，第一时间设置停用标志位
	global.setDeactivated(true);

	// ★ 终极最优解：Await 所有 bridge 停止，且强杀所有追踪中的子进程
	await Promise.allSettled([
		pythonBridge.stop(),
		rustBridge.stop(),
		shellBridge.stop(),
		global.killAllProcesses()
	]);

	global.finishUserTracking();

	try {
		if (_statusBarTimer) clearInterval(_statusBarTimer);
		_statusBarTimer = null;
		global.disposeStatusBar();
	} catch { }

	try { await validateCacheAsync(); } catch { }
	try { await saveCacheMeta(); } catch { }  // ★ 必须 await，否则进程终止时文件会被截断为 0 字节

	if (q1Module?.deactivate) {
		try { await q1Module.deactivate(); } catch { }
	}

	if (q2Module?.deactivate) {
		try { await q2Module.deactivate(); } catch { }
	}

	// ★ 补充：停用 q4 (剪切板历史管理器)
	try { await q4.deactivate(); } catch { }

	global.logMessage("qqq 扩展已停用", "INFO");
}

function getIconCache(filePath) {
	if (!cacheMeta || !cacheMeta.icons) return null;
	try {
		// 合并文件系统调用，减少IO操作
		let mtime = 0;
		try {
			const stat = fs.statSync(filePath);
			mtime = stat.mtimeMs;
		} catch {
			return null; // 文件不存在，直接返回
		}
		const entry = cacheMeta.icons[filePath];
		if (entry && entry.mtime === mtime) {
			const iconPath = path.join(cacheDir, `icon_${entry.hash}.png`);
			try {
				// 合并existsSync和readFileSync为一次操作
				return fs.readFileSync(iconPath).toString("base64");
			} catch {
				// 图标文件不存在
				return null;
			}
		}
	} catch (e) { }
	return null;
}

function setIconCache(filePath, iconB64) {
	if (!cacheMeta || !cacheDir) return;
	if (!cacheMeta.icons) cacheMeta.icons = {};

	try {
		const mtime = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
		const hash = crypto.createHash("md5").update(filePath).digest("hex");
		const iconPath = path.join(cacheDir, `icon_${hash}.png`);

		fs.writeFileSync(iconPath, Buffer.from(iconB64, "base64"));
		cacheMeta.icons[filePath] = { hash, mtime };
		saveCacheMeta();
	} catch (e) { }
}

const exported = {
	activate,
	deactivate,

	createPathRegex,
	toSafePath,
	// Delegate to h.js
	sanitizeHtml: h.sanitizeHtml,

	normalizeNavPath,
	resolveNavPath,
	canonicalizeExistingPath,
	cacheKeyForPath,

	logMessage: global.logMessage,
	logMessageRateLimited: global.logMessageRateLimited,

	// Delegate to h.js
	computeFingerprint: computeFingerprintCached,
	prefillFingerprint: h.prefillFingerprint,

	initCache,
	validateCache: validateCacheAsync,
	getIconCache,
	setIconCache,

	getCacheEntry,
	getCacheQualityMeta,
	getCacheStatsSnapshot,
	isValidWebPBuffer,
	verifyMediaFile,
	shouldVerifySourceAfterFailure,
	isBrokenFile,
	markFileAsBroken,
	unmarkFileAsBroken,
	getBrokenFileRecord,
	updateStatusBarThrottled,
	getPersistentCacheStatsSnapshot: global.getPersistentCacheStatsSnapshot,

	setCacheEntry,
	getCachedBuffer,

	handleClipboardSlow,

	getFolderInfo,
	getPathSize,  // 极限优化版：只获取大小，不统计后缀名
	getDiskFree,  // 获取磁盘剩余空间
	cancelScansJS,  // 取消正在进行的 JS 扫描

	// Delegate to h.js
	getTimestampFilename: h.getTimestampFilename,
	isImageExtForClipboard: h.isImageExtForClipboard,

	shouldShowDuration,

	raceClipboard,

	probeScheduler: global.probeScheduler,
	genScheduler: global.genScheduler,

	registerSourceFile,
	findSourceFile,

	getActiveEngineCode: global.getActiveEngineCode,
	getActiveEngineName: global.getActiveEngineName,
	updateStatusBarNow,

	// ★ Python 环境变化时调用
	resetPythonAudioCache,
};

Object.assign(module.exports, exported);

Object.defineProperty(module.exports, "LOG_PATH", { enumerable: true, get: () => global.getLogPath() });
Object.defineProperty(module.exports, "ffmpegPath", { enumerable: true, get: () => global.ffmpegPath() });
Object.defineProperty(module.exports, "ffprobePath", { enumerable: true, get: () => global.ffprobePath() });

if (!process.__qqq_error_listeners_attached) {
	process.__qqq_error_listeners_attached = true;
	process.on("uncaughtException", (error) => {
		const stack = error.stack || "";
		// ★ 对于文件系统相关的错误，只记录日志不崩溃
		const fsErrorCodes = ['EBUSY', 'EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOSPC'];
		if (error.code && fsErrorCodes.includes(error.code)) {
			global.logMessage(`[文件系统错误] ${error.code}: ${error.message}`, "WARN");
		} else {
			global.logMessage(`未捕获的异常: ${error.message}\n${error.stack}`, "ERROR");
		}
	});

	process.on("unhandledRejection", (reason) => {
		const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
		// ★ 对于文件系统相关的错误，只记录日志不崩溃
		const fsErrorCodes = ['EBUSY', 'EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOSPC'];
		if (reason instanceof Error && reason.code && fsErrorCodes.includes(reason.code)) {
			global.logMessage(`[文件系统错误] ${reason.code}: ${reason.message}`, "WARN");
		} else {
			global.logMessage(`未处理的Promise拒绝: ${msg}`, "ERROR");
		}
	});
}



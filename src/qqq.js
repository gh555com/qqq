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
const { q, init: initI18n } = require("./i18n");

// Reference core objects from global.js
const {
	pythonBridge,
	rustBridge,
	shellBridge,
	startDaemons,
	tryOneByOne,
	tryEngineCall,
	updateStatusBarNow,
	pasteQueue,
	metaSaveQueue,
	// ★ WqReporter 统计上报
	startWqReporter,
	syncCloudConfig,
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
//  Scan cancellation mechanism (Node engine)
// =============================================================================
let _scanCancelVersion = 0;

/**
 * Increment the cancellation version so all in-progress scans become invalid
 */
function cancelScansJS() {
	_scanCancelVersion++;
	global.logMessage(`[CancelScans] JS version bumped to ${_scanCancelVersion}`, "DEBUG");
	return _scanCancelVersion;
}

/**
 * Get the current cancellation version
 */
function getScanCancelVersion() {
	return _scanCancelVersion;
}

/**
 * Check whether the scan has been cancelled
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
	// validateCache is not executed during startup to avoid blocking; changed to delayed background execution
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
		// Protect icon files from accidental deletion unless they no longer exist in meta
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


// Return a Promise to ensure the caller can wait for meta.json to be fully written
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
const BROKEN_BASE_TTL_MS = 121000;        // 2 minutes
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

// Return a Promise so the caller can await until meta.json write is completed
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
	// Asynchronously wait for meta.json write to complete, ensuring subsequent getCachedBuffer can see the latest entry
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
				title: q('qqq.ui.fileCopyProgress'),
				cancellable: true
			}, async (progress, token) => {
				token.onCancellationRequested(async () => {
					global.logMessage(q('qqq.log.pasteCancelled', transId), "WARN");
					await global.TransactionManager.rollback(transId);
				});

				// ★ Register the transaction so the IO engine can enjoy a fully wrapped transactional flow
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
					// rollback already handled in onCancellationRequested
					return null;
				}

				// Completed successfully, remove the transaction record
				if (result) {
					await global.TransactionManager.removeTransaction(transId);
				}
				return result;
			});

			// ★ Call callback regardless of result to ensure the user can see the outcome
			if (res) {
				// If all files were skipped, show a warning
				if (res.type === "file_folder" && res.files?.length === 0 && res.folders?.length === 0 && res.skippedCount > 0) {
					global.logMessage(q('qqq.log.allFilesSkipped', res.skippedCount), "WARN");
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
	// ★ 为兼容调用也生成 transId，用于文件名前缀
	const transId = global.TransactionManager.createTransactionId();
	return await h.autoDetectAndPaste(targetDir, partialCallback, token, transId);
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
		global.logMessage(`[FolderScan] ${q('qqq.log.folderScan', folderPath, elapsed, res.file_count_root || 0, global.formatBytes(res.total_size || 0))}`, "DEBUG");
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

	// Performance optimization: use iteration instead of recursion, and use Promise.all to control concurrency,
	// avoiding deep directories causing stack overflow and single-thread blocking
	const queue = [folderPath];
	while (queue.length > 0) {
		const currentDir = queue.shift();
		try {
			const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

			// Batch stat retrieval
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
	global.logMessage(`[FolderScan] ${q('qqq.log.folderScanJs', folderPath, elapsed, fileCount, global.formatBytes(totalSize))}`, "DEBUG");

	return {
		success: true,
		total_size: totalSize,
		file_count_root: fileCount,
		ext_stats: extStats,
	};
}

/**
 * Extreme optimized version: only get file/folder size, do not count extensions or file count
 * Suitable for: szDisplayMode="size" where only size is needed
 * @param {string} targetPath file or folder path
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
 * JS fallback implementation: only get size (simplified version, supports cancellation)
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
		// Check cancellation every 100 directories (Node is slower than Rust/Python, so use a smaller interval)
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
 * Batch get disk free space for multiple drives (Python only, no fallback)
 * @param {string[]} [drives] - drive letters, e.g. ["C:", "D:"]. If omitted, auto-detect.
 * @returns {Promise<{success: boolean, data?: {[drive: string]: {free: number, total: number}}}>}
 */
async function getDiskFreeBatch(drives = null) {
	const res = await tryEngineCall({
		python: "disk_free_batch"
	}, { drives: drives }, 3000);

	if (res && res.success && res.data) {
		return res;
	}

	// Python not available, return empty (no fallback)
	return { success: false, error: "python_unavailable" };
}


function shouldShowDuration(info) {
	return info && (info.type === "video" || info.type === "animated_image") && info.duration > 0.1;
}

let downloadContext = null;

// =============================================================================
// Audio playback state management
// =============================================================================
let _pythonAudioChecked = false;
let _pythonAudioAvailable = false;
let _pythonAudioError = null;

/**
 * ★ Reset Python audio engine cache (call when Python environment changes from "unavailable" to "available")
 */
function resetPythonAudioCache() {
	_pythonAudioChecked = false;
	_pythonAudioAvailable = false;
	_pythonAudioError = null;
}

async function checkPythonAudioEngine() {
	// ★ excludePython: user explicitly disabled Python Broker
	if (global.getEnginePreference() === 'excludePython') {
		_pythonAudioChecked = true;
		_pythonAudioAvailable = false;
		return false;
	}

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
			global.logMessage(q('qqq.log.pythonAudioDetected', version), "INFO");
			global.pythonAudioDetected = true;
			_pythonAudioChecked = true;
			_pythonAudioAvailable = true;
			return true;
		} else {
			_pythonAudioError = res?.error || 'miniaudio not available';
			// Print the error reason in the log panel
			global.logMessage(`[Audio] ${q('qqq.log.pythonUnavailable', _pythonAudioError)}`, "WARN");
		}
	} catch (e) {
		_pythonAudioError = e.message;
		global.logMessage(`[Audio] ${q('qqq.log.pythonCheckError', e.message)}`, "WARN");
	}

	_pythonAudioChecked = true;
	_pythonAudioAvailable = false;
	return false;
}

/**
 * Get Savor audio info (random selection)
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
 * Random loop count (2-6)
 */
function getRandomLoopCount() {
	const getRand = (min, max) => crypto.randomInt ? crypto.randomInt(min, max) : Math.floor(Math.random() * (max - min)) + min;
	return getRand(2, 7);
}

async function savorMomentsCommand() {
	try {
		// ★ Protective check: ensure extensionContext is initialized
		if (!extensionContext || !extensionContext.extensionPath) {
			global.logMessage(`[Audio] ${q('qqq.log.contextWaiting')}`, "WARN");
			// ★ Python Broker only - show 9s notification
			global.showAutoCloseNotification('warning', q('q4.log.pythonProbeFail'), 9);
			return;
		}

		// ★ Python Broker is the ONLY audio engine
		const pythonAvailable = await checkPythonAudioEngine();

		if (!pythonAvailable) {
			// ★ Python unavailable - show 9s notification (no Webview fallback)
			global.logMessage(`[Audio] Python Broker unavailable, audio disabled`, "WARN");
			global.showAutoCloseNotification('warning', q('q4.log.pythonProbeFail'), 9);
			return;
		}

		// ★ Python engine available, play directly (no webview, do not open sidebar)
		const info = getSavorAudioInfo(extensionContext);
		const loopCount = getRandomLoopCount();

		global.logMessage(`[Audio] ${q('qqq.log.pythonPlay', info.fileName, loopCount)}`, "INFO");

		try {
			const res = await pythonBridge.call('play_audio', { path: info.path, count: loopCount });
			if (res && (res.status === 'ok' || res.status === 'playing')) {
				const isRadio = res.source === 'radio';
				const displayName = isRadio ? 'Radio' : info.fileName;
				const displayCount = isRadio ? 0 : loopCount;

				// ★ Write globalState for multi-window sync (always, even if sidebar not open)
				context.globalState.update('qqq_savoring_state', {
					playing: true,
					windowId: process.pid.toString(),
					fileName: displayName,
					loopCount: displayCount,
					startTime: Date.now(),
					isRadio: isRadio
				});

				// ★ Record Python playback state whether or not q4 is open
				if (activeSidebarProvider) {
					activeSidebarProvider._pythonPlayState = {
						playing: true,
						fileName: displayName,
						loopCount: displayCount,
						startTime: Date.now(),
						isRadio: isRadio
					};
				}
				// ★ If q4 webview is already open, sync UI state (do not open proactively)
				if (activeSidebarProvider && activeSidebarProvider.isWebviewReady) {
					activeSidebarProvider.syncPythonPlayState(displayName, displayCount, true);
				}
				// ★ 偿还 ping：通知服务器用户正在偿还给自己（5min 防抖）
				global.triggerPlayingPing();
				global.setCurrentlyPlaying(true);
				return;
			}
			// Python playback failed
			global.logMessage(`[Audio] ${q('qqq.log.pythonPlayFail', res?.error || 'unknown')}`, "WARN");
		} catch (e) {
			global.logMessage(`[Audio] ${q('qqq.log.pythonPlayError', e.message)}`, "WARN");
		}

		// ★ Python failed - no Webview fallback, just show notification
		global.showAutoCloseNotification('info', q('qqq.ui.clickSidebarToRelax'));
	} catch (e) {
		global.logMessage(q('qqq.log.audioPlayError', e.message), "ERROR");
	}
}

async function downloadVideosFromUrlCommand(urlArg) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		global.showAutoCloseNotification('error', q('qqq.ui.openDocFirst'));
		return;
	}

	if (editor.document.isUntitled) {
		vscode.window.showInformationMessage(q('qqq.ui.plainPasteOnly'));
		return;
	}

	let rawUrl = urlArg;
	if (!rawUrl) {
		rawUrl = await vscode.window.showInputBox({
			prompt: " ",
			ignoreFocusOut: true,
			placeHolder: q('qqq.ui.videoUrlPlaceholder'),
			validateInput: (text) => {
				const s = (text || "").trim();
				if (!s) return null;
				return global.isValidUrl(s) ? null : q('qqq.ui.invalidUrl');
			}
		});
		// ★ Enter key sound effect
		if (rawUrl && global.pythonBridge?.isAvailable()) {
			global.pythonBridge.call("play_sfx", { category: "yz", name: "a2.mp3" }, 1000).catch(() => { });
		}
	}
	if (!rawUrl) return;

	// ★ Treat "yt-dlp is installed" as a prerequisite (only for downloadVideosFromUrlCommand)
	const { getSharedDownloader } = require('./dow');
	const downloader = getSharedDownloader();
	const isYtdlpReady = await downloader.ensureYtdlpReady(extensionContext, { silent: true });
	if (!isYtdlpReady) {
		return;
	}

	const currentDocDir = path.dirname(editor.document.uri.fsPath);
	const targetDir = path.join(currentDocDir, "qqq");
	h.ensureDir(targetDir);  // ★ Use h.ensureDir for salt handling

	const transId = global.TransactionManager.createTransactionId();
	const targetUri = editor.document.uri;

	// ★ Generate taskTitle
	const filePath = editor.document.uri.fsPath;
	const taskNum = await global.TaskCounter.increment(filePath);  // Database incremental number (per file)
	const iconNum = await global.TaskCounter.incrementIcon();  // Global icon number (across files)
	const taskTitle = global.TaskCounter.formatTitle(filePath, transId, iconNum);  // Title uses transId + icon

	// 1. Insert anchor immediately
	await global.TransactionManager.insertAnchor(editor, transId);

	// ★ Save transaction to globalState
	await global.TransactionManager.saveTransaction({
		id: transId,
		targetDir: targetDir,
		targetUri: targetUri.fsPath,
		tempFiles: [],
		landedFiles: [],
		landedFolders: [],
		taskType: 'video',  // ★ Video download task
		existingFiles: await global.getDirectorySnapshot(targetDir)  // ★ Directory snapshot at task start
	});

	// 2. Start a popup task with progress bar
	// ★ Create a custom cancellation source (used to actively cancel when anchor is lost)
	const anchor = `/__PENDING_${transId}/`;
	const anchorLostSource = new vscode.CancellationTokenSource();
	let anchorLost = false;
	let lastAnchorCheckTime = 0;
	const ANCHOR_CHECK_INTERVAL = 800;  // Check anchor every 800ms

	// ★ Anchor check function (with throttling)
	const checkAnchorExists = async () => {
		if (anchorLost) return false;

		const now = Date.now();
		if (now - lastAnchorCheckTime < ANCHOR_CHECK_INTERVAL) {
			return true;
		}
		lastAnchorCheckTime = now;

		try {
			// ★ Defensive validation: ensure file still exists to avoid VS Code internal error noise
			if (!fs.existsSync(targetUri.fsPath)) {
				if (!anchorLost) {
					anchorLost = true;
					global.logMessage(`[AnchorWatch] ${q('qqq.log.anchorFileNotExist', targetUri.fsPath)}`, 'WARN');
					anchorLostSource.cancel();
				}
				return false;
			}
			const doc = await vscode.workspace.openTextDocument(targetUri);
			const text = doc.getText();
			const exists = text.includes(anchor);

			if (!exists && !anchorLost) {
				anchorLost = true;
				global.logMessage(`[AnchorWatch] ${q('qqq.log.anchorLost', anchor)}`, 'WARN');
				anchorLostSource.cancel();
				return false;
			}
			return exists;
		} catch (e) {
			if (!anchorLost) {
				anchorLost = true;
				global.logMessage(`[AnchorWatch] ${q('qqq.log.anchorReadError', e.message)}`, 'WARN');
				anchorLostSource.cancel();
			}
			return false;
		}
	};

	// ★ shouldCancel callback: returns current state and triggers a background check
	const shouldCancelCallback = () => {
		// Return current state first
		if (anchorLost) return true;
		// Trigger check in background (do not await)
		checkAnchorExists().catch(() => { });
		return anchorLost;
	};

	// 3. Define result processing function (reusable)
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
			// Process each video file by q1.js cleanliness standards
			let replacement = "";
			for (let i = 0; i < res.landedFiles.length; i++) {
				const f = res.landedFiles[i];
				const relPath = path.relative(currentDocDir, f).replace(/\\/g, '/');
				const isLastItem = i === res.landedFiles.length - 1;

				// Add file path
				if (i > 0) replacement += eol;
				replacement += `/\\${relPath}\\/`;

				// Compute the exact number of blank lines for video files (following cleanliness standards)
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

			// Replace anchor
			const replaced = await replaceAnchorInDoc(targetUri, anchor, newText);
			if (replaced) {
				await global.TransactionManager.removeTransaction(transId);

				// ★ Force refresh document to fix screen corruption (花屏) issue
				// Flow: first render → clear cache → re-render (double render for safety fallback)
				try {
					await q1.forceRefreshDocument(targetUri);
					global.logMessage(`[VideoDownload] Document force refresh completed: ${targetUri.fsPath}`, "DEBUG");
				} catch (e) {
					global.logMessage(`[VideoDownload] Force refresh error (non-fatal): ${e.message}`, "WARN");
				}

				return res;
			} else {
				global.logMessage(q('qqq.log.anchorReplaceFail'), "ERROR");
				await global.TransactionManager.rollback(transId);
				return { ...res, anchorLost: true };
			}
		} else if (res && res.cancelled) {
			await global.TransactionManager.rollback(transId);
			await replaceAnchorInDoc(targetUri, anchor, "");
			return res;
		} else {
			// Download failed or null, rollback
			await global.TransactionManager.rollback(transId);
			await replaceAnchorInDoc(targetUri, anchor, "");
			return { failed: true };
		}
	};

	let downloadResult = await global.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "",  // ★ Leave title empty; VideoMsg.progress generates the full message
		cancellable: true
	}, async (progress, token) => {
		token.onCancellationRequested(() => {
			global.logMessage(q('qqq.log.taskCancelled', transId), "WARN");
		});

		// ★ Anchor loss also triggers rollback prompt
		anchorLostSource.token.onCancellationRequested(() => {
			global.logMessage(q('qqq.log.anchorLostCancel'), 'WARN');
		});

		const Qvideo = require('./qvideo');
		const controller = new Qvideo(downloadContext, module.exports);

		// ★ Check anchor in progress callback
		const progressAdapter = async (pct, msg) => {
			progress.report({ message: msg, increment: 0 });
			await checkAnchorExists();
		};

		try {
			// ★ Pass taskTitle and shouldCancel callback
			const res = await controller.downloadEntry(rawUrl, targetDir, transId, progressAdapter, token, targetUri, taskTitle, shouldCancelCallback, taskNum);

			// ★ BUG FIX: 如果下载成功（有文件落盘），优先处理结果，不要因为 anchorLost 而回滚
			// 之前的 bug: 即使下载成功，也会因为等待期间 anchorLost 变为 true 而被错误回滚
			const hasSuccessFiles = res && (res.landedFiles?.length > 0 || res.files?.length > 0);

			if (hasSuccessFiles) {
				// ★ 下载成功，直接处理结果
				return await processResult(res);
			}

			// ★ 下载失败或取消时，才检查 anchorLost
			if (token.isCancellationRequested || anchorLost) {
				await global.TransactionManager.rollback(transId);
				await replaceAnchorInDoc(targetUri, anchor, "");
				if (anchorLost) {
					return { anchorLost: true };
				}
				return { cancelled: true };
			}

			// ★ 其他情况（无文件但没取消）也走 processResult
			return await processResult(res);

		} catch (e) {
			global.logMessage(q('qqq.log.videoDownloadFailed', e.message), "ERROR");
			vscode.window.showErrorMessage(q('qqq.ui.videoDownloadFailed', e.message));
			await global.TransactionManager.rollback(transId);
			await replaceAnchorInDoc(targetUri, anchor, "");
			return null;
		}
	});

	// ★ Handle enhanced flow (the previous popup has been closed)
	if (downloadResult && downloadResult.needEnhancedAction) {
		const Qvideo = require('./qvideo');
		const controller = new Qvideo(downloadContext, module.exports);

		// Call handleForbidden and get the final result
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

	// ★ After the progress popup ends, show a unified final toast (single source of truth)
	if (downloadResult) {
		if (downloadResult.cancelled) {
			// ★ Cancelled
			global.TaskMessage.showSimpleToast(q('qqq.ui.taskCancelledRollback', taskTitle), 15000, 'cancel');
		} else if (downloadResult.anchorLost) {
			// ★ Anchor lost
			global.TaskMessage.showSimpleToast(q('qqq.ui.anchorLostRollback', taskTitle), 15000, 'cancel');
		} else if (downloadResult.failed) {
			// ★ Download failed
			global.TaskMessage.showSimpleToast(q('qqq.ui.downloadFailedRollback', taskTitle), 15000, 'cancel');
		} else if (downloadResult.doneMessage) {
			// ★ Success
			global.TaskMessage.showSimpleToast(downloadResult.doneMessage, 15000, 'success');
			// ★ Record video stats (was missing — root cause of video_n always 0)
			global.saveVideoStats(downloadResult.finalTotalBytes || 0);
		}
	}
}

// ==================== Anchor replacement helper ====================
async function replaceAnchorInDoc(uri, anchor, newText) {
	try {
		// ★ Zero-cost validation: check physical file existence before opening to remove net::ERR_FILE_NOT_FOUND noise
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
	// ★ Ultimate optimal solution: reset state immediately at startup, and ensure subsequent registrations happen before any await
	global.setDeactivated(false);

	if (!context) {
		global.logMessage("activate: context is undefined!", "ERROR");
		return;
	}

	extensionContext = context;
	downloadContext = context;
	global.init(context);

	const extensionPath = context.extensionUri?.fsPath || context.extensionPath;
	if (!extensionPath) {
		global.logMessage("activate: extensionPath is undefined!", "ERROR");
		return;
	}

	// ★ Initialize i18n module: must be done before any q() calls, pass context for globalState
	initI18n(extensionPath, context);

	global.logMessage(q('qqq.log.activating'), "INFO");

	// ★ Ultimate version: inject Pro mode (after you verify, replace false with actual isPro variable)
	const isPro = false; // ★ Currently non-Pro mode; all configs cannot be saved
	global.setProMode(isPro);

	// ★ On non-Pro startup, clear all qqq.* configs in settings.json to ensure "restart resets"
	if (!isPro) {
		global.ConfigManager.nonProBootstrapResetAll().catch(() => { });
	}

	// ★ Cache must be initialized immediately (no delay), otherwise user actions will trigger SETUP_FAIL
	initCache(context).catch(e => {
		global.logMessage(q('qqq.log.cacheInitError', e?.message || e), "ERROR");
	});

	// ★ Delayed startup strategy: execute reload init 3 seconds after onStartupFinished
	setTimeout(() => {
		_delayedActivate(context).catch(e => {
			global.logMessage(q('qqq.log.delayedInitError', e?.message || e), "ERROR");
		});
	}, 3000);

	// ★ Register commands immediately (no delay) to ensure user can use them right away
	_registerCommands(context);
}

// ★ Delayed initialization logic (runs after onStartupFinished + 3 seconds)
async function _delayedActivate(context) {
	global.logMessage(q('qqq.log.delayedInitStart'), "INFO");

	// initCache has been moved to activate() for immediate execution; no need to repeat here

	// ★ Warm up / silently install video engine and Python engine (delay 10 seconds)
	setTimeout(() => {
		try {
			const { getSharedDownloader } = require('./dow');
			const downloader = getSharedDownloader();
			downloader.ensureYtdlpReady(context, { background: true }).catch(() => { });
			global.logMessage(q('qqq.log.dowWarmup'), "INFO");
		} catch (e) { }
	}, 7000); // relative to _delayedActivate start, delay another 7s = total 3+7=10s

	// Initialize core modules (q4 has now merged clipboard history logic)
	try {
		const q4Api = q4.activate(context);
		global.clipboardHistoryManager = q4Api; // Keep global reference for compatibility
		activeSidebarProvider = q4Api.sidebarProvider; // ★ Correctly initialize activeSidebarProvider
		// ★ Wire A/Q button visibility to cloud config sync results
		global.onAqStateChange((visible) => {
			if (activeSidebarProvider) activeSidebarProvider.setAqVisible(visible);
		});
	} catch (e) {
		global.logMessage(q('qqq.log.q4LoadError', e.message), "ERROR");
	}
	global.setCacheStatsGetter(() => getCacheStatsSnapshot());
	global.setLogPath(path.join(cacheDir, "err.log"));
	global.initStatusBar();
	updateStatusBarThrottled();

	// ★ startDaemons delayed 6 seconds (relative to _delayedActivate start, delay 3 seconds = total 3+3=6 seconds)
	setTimeout(() => {
		global.logMessage(q('qqq.log.daemonsStart'), "INFO");
		startDaemons();
	}, 3000);

	// ★ 启动 WqReporter 统计上报（启动后 30~120s 抖动 + 每 12h 兜底）
	startWqReporter();

	// Set CodeLens style (read via ConfigGate)
	function updateCodeLensStyle() {
		const takeOver = global.getConfig("takeOverCodelensStyle");
		if (takeOver === undefined ? true : takeOver) {
			// ★ Cross-platform font stack: Tahoma (Win) → Liberation Sans (Linux) → DejaVu Sans (Linux) → sans-serif
			const fontFamily = process.platform === 'win32'
				? 'Tahoma'
				: 'Tahoma, Liberation Sans, DejaVu Sans, sans-serif';
			vscode.workspace.getConfiguration("editor").update("codeLensFontFamily", fontFamily, vscode.ConfigurationTarget.Global);
			vscode.workspace.getConfiguration("editor").update("codeLensFontSize", 13, vscode.ConfigurationTarget.Global);
		}
	}

	// Set once on activation
	updateCodeLensStyle();

	// Listen for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("qqq.takeOverCodelensStyle")) {
				updateCodeLensStyle();
			}
		})
	);

	// ★ 窗口重启时静默同步云端配置（延迟 3 秒，成功不弹窗，失败才弹窗）
	setTimeout(async () => {
		try {
			// ★ Phone from auth.json (single source of truth), silent=true skips login if not authed
			await syncCloudConfig('', { silent: true });
		} catch (e) {
			global.logMessage(`[wq] Startup sync error: ${e.message}`, 'WARN');
		}
	}, 3000);
}

// ★ Extract command registration into a separate function (register immediately, no delay)
function _registerCommands(context) {
	// ★ 防御性命令注册：防止开发环境热重载或新旧版本共存时命令重复注册导致激活失败
	const safeRegisterCommand = (commandId, handler) => {
		try {
			return vscode.commands.registerCommand(commandId, handler);
		} catch (e) {
			if (e.message?.includes('already exists')) {
				global.logMessage(`[Command] ${commandId} already exists, skipping registration`, 'WARN');
				return { dispose: () => {} }; // 返回空的 disposable，不影响 subscriptions 数组
			}
			throw e; // 其他错误继续抛出
		}
	};

	context.subscriptions.push(
		safeRegisterCommand("qqq.showStatusPanel", global.withReady(() => {
			// 状态栏点击 → 打开扩展设置界面（等同于 q4 齿轮按钮短按）
			vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extensionContext.extension.id}`);
		})),
		safeRegisterCommand("qqq.pure", global.withReady(q3.pureCommand)),
		safeRegisterCommand("qqq.allSettings", global.withReady(() => {
			vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extensionContext.extension.id}`);
		})),
		safeRegisterCommand("qqq.downloadVideosFromUrl", global.withReady(downloadVideosFromUrlCommand)),
		safeRegisterCommand("qqq.savorMoments", global.withReady(savorMomentsCommand)),
		safeRegisterCommand("qqq.clearCache", global.withReady(async () => {
			// ★ 9-second auto-close popup → unify using global.showAutoCloseNotification (single source of truth)

			const options = [
				{ label: q('qqq.clearCache.clearCooldown'), description: q('qqq.clearCache.clearCooldownDesc'), id: "clearCooldown" },
				{ label: q('qqq.clearCache.openCacheDir'), description: ` ${cacheDir || q('qqq.clearCache.uninitialized')}`, id: "openCacheDir" },
				{ label: q('qqq.clearCache.deleteYtDlp'), description: q('qqq.clearCache.deleteYtDlpDesc'), id: "deleteYtDlp" },
				{ label: q('qqq.clearCache.clearGlobalStates'), description: q('qqq.clearCache.clearGlobalStatesDesc'), id: "clearGlobalStates" },
				{ label: q('qqq.clearCache.clearClipboardHistory'), description: " ", id: "clearClipboardHistory" }
			];

			const selected = await vscode.window.showQuickPick(options, {
				title: q('qqq.clearCache.selectTitle'),
				placeHolder: q('qqq.clearCache.selectPlaceholder')
			});

			if (!selected) return;

			if (selected.id === "clearCooldown") {
				// Clear download dependency cooldown time
				try {
					// ★ Calculate remaining time before clearing
					const COOLDOWN_MS = 259200000; // 72 hours
					let ts = context.globalState.get('pythonInstallTimestamp', 0) || context.globalState.get('python_cooldown_ts', 0) || 0;
					const remainingMs = Math.max(0, COOLDOWN_MS - (Date.now() - ts));
					const erasedTime = `${Math.floor(remainingMs / 3600000)}h:${Math.floor((remainingMs % 3600000) / 60000)}m`;
					// ★ Clear all related globalState keys
					await context.globalState.update('pythonInstallTimestamp', 0);
					await context.globalState.update('python_cooldown_ts', 0);
					await context.globalState.update('pythonDepsInstallTimestamp', 0); // Backward compatibility
					global.showAutoCloseNotification('info', q('qqq.ui.cooldownCleared', erasedTime));
				} catch (e) {
					global.showAutoCloseNotification('error', q('qqq.ui.cooldownClearError', e.message));
				}
			} else if (selected.id === "openCacheDir") {
				// Open cache directory
				if (!cacheDir) {
					global.showAutoCloseNotification('warning', q('qqq.ui.cacheNotInit'));
					return;
				}

				try {
					// Ensure cache directory exists
					if (!fs.existsSync(cacheDir)) {
						await fs.promises.mkdir(cacheDir, { recursive: true });
					}
					// Open file explorer
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
					global.showAutoCloseNotification('error', q('qqq.ui.openCacheDirError', e.message));
				}
			} else if (selected.id === "deleteYtDlp") {
				// Delete video download component yt-dlp.exe
				try {
					const globalStoragePath = context?.globalStorageUri?.fsPath;
					if (!globalStoragePath) {
						global.showAutoCloseNotification('warning', q('qqq.ui.noStoragePath'));
						return;
					}
					const ytDlpPath = path.join(globalStoragePath, 'yt-dlp.exe');
					if (fs.existsSync(ytDlpPath)) {
						fs.unlinkSync(ytDlpPath);
						global.showAutoCloseNotification('info', q('qqq.ui.ytdlpDeleted', ytDlpPath));
					} else {
						global.showAutoCloseNotification('info', q('qqq.ui.ytdlpNotExist'));
					}
				} catch (e) {
					global.showAutoCloseNotification('error', q('qqq.ui.ytdlpDeleteError', e.message));
				}
			} else if (selected.id === "clearGlobalStates") {
				// Clear globalStates database (preserve status bar info)
				try {
					// Status bar keys (do not clear): user usage time, cache hit, warm-up
					const preserveKeys = new Set([
						'qqq_stats_total_seconds',    // User usage time
						'qqq_stats_cache_hit_total',  // Cache hits
						'qqq_stats_cache_miss_total', // Cache misses
						'qqq_wq_stats'                // Warm-up time stats
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
								// Ignore values that cannot be serialized
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

					global.showAutoCloseNotification('info', q('qqq.ui.globalStateCleared', clearedCount, formatBytes(totalSize)));
				} catch (e) {
					global.showAutoCloseNotification('error', q('qqq.ui.globalStateClearError', e.message));
				}
			} else if (selected.id === "clearClipboardHistory") {
				// Clear clipboard history
				try {
					const historyManager = global.clipboardHistoryManager;
					if (historyManager && typeof historyManager.clearHistory === 'function') {
						await historyManager.clearHistory({ deleteFiles: true });
						global.showAutoCloseNotification('info', q('qqq.ui.clipboardHistoryCleared'));
					} else {
						global.showAutoCloseNotification('warning', q('qqq.ui.clipboardManagerNotInit'));
					}
				} catch (e) {
					global.showAutoCloseNotification('error', q('qqq.ui.clipboardClearError', e.message));
				}
			}
		})),

		// ★ gh555.com URL 打开命令（带追踪参数）
		safeRegisterCommand('qqq.openLogin', () => {
			vscode.env.openExternal(vscode.Uri.parse(global.buildGh555Url('/login')));
		}),
		safeRegisterCommand('qqq.openBuy', () => {
			vscode.env.openExternal(vscode.Uri.parse(global.buildGh555Url('/gaea/d/qqq', 'price')));
		}),
		safeRegisterCommand('qqq.openProfile', () => {
			vscode.env.openExternal(vscode.Uri.parse(global.buildGh555Url('/gaea/d/qqq', 'profile')));
		}),
		safeRegisterCommand('qqq.logout', () => global.logoutAuth()),
		safeRegisterCommand('qqq.openProfile', () => vscode.env.openExternal(vscode.Uri.parse('https://www.gh555.com/gaea/d/qqq#profile'))),

		// ★ Cloud user data sync commands (upload/pull roam config + clipboard history)
		safeRegisterCommand('qqq.uploadUserData', global.withReady(() => global.uploadUserData())),
		safeRegisterCommand('qqq.pullUserData', global.withReady(() => global.pullUserData())),



		// ★ Ultimate version: unified settings change entry point (via ConfigGate)
		vscode.workspace.onDidChangeConfiguration((event) => {
			// ★ Only handle qqq. configuration changes
			if (!event.affectsConfiguration(global.cfgNs())) return;

			// ★ 手机号配置已废弃，身份统一由 auth.json 管理
			// (phone config listener removed — auth.json file watcher handles cross-window sync)

			global.ConfigManager.handleVscodeConfigChanged(event).then((changedKeys) => {
				// ★ Sound: only play in focused window to avoid multi-window spam
				if (changedKeys.length > 0 && vscode.window.state.focused) {
					if (global.pythonBridge && global.pythonBridge.isAvailable()) {
						global.pythonBridge.call("play_sfx", { category: "yz", name: "kj3.mp3" }, 1000).catch(() => { });
					}
				}

				// ★ Handle ioEngine switch: start the newly selected daemon
				if (event.affectsConfiguration("qqq.ioEngine")) {
					const val = global.getEnginePreference();
					global.logMessage(q('qqq.log.engineSwitch', val), "INFO");

					// ★ Start the newly selected engine daemon
					(async () => {
						// ★ excludePython: skip Python Broker entirely
						if (val === 'excludePython') {
							global.logMessage("[Engine] Exclude Python mode - Python Broker disabled", "INFO");
						} else if (!global.pythonBridge?.isAvailable()) {
							global.logMessage("[Engine] Starting Python Broker...", "INFO");
							await global.pythonBridge?.start();
						}
						global.invalidateEngineCache?.();
						updateStatusBarThrottled();
					})().catch(() => {});

					if (val === "python") {
						const { getSharedDownloader } = require('./dow');
						const downloader = getSharedDownloader();
						const status = downloader.python.getL1ImperfectStatus();

						if (status.imperfect) {
							const reasonMsg = {
								'no_interpreter': q('qqq.log.pythonNoInterpreter'),
								'interpreter_invalid': q('qqq.log.pythonInvalid'),
								'deps_missing': q('qqq.log.pythonDepsMissing', status.missing.join(', ')),
								'no_context': q('qqq.log.pythonNoContext')
							}[status.reason] || status.reason;
							global.logMessage(q('qqq.log.pythonEnvImperfect', reasonMsg), "WARN");
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
		// ★ 被动重连：非活跃窗口也能自动接上已运行的 Broker
		try {
			const { pythonBridge } = global;
			if (pythonBridge && pythonBridge.tryPassiveReconnect) {
				pythonBridge.tryPassiveReconnect();
			}
		} catch { }
	}, 5000);

	// ★ Ultimate optimal solution: recover/cleanup transactions at startup (moved to bottom of activate or run in background)
	// Do not block the main registration flow
	(async () => {
		try {
			await global.TransactionManager.recover();
		} catch (e) {
			global.logMessage(q('qqq.log.transactionRecoverError', e.message), "ERROR");
		} finally {
			// ★ No matter success or failure, open the gate so commands can run
			global.markReady();

			// ★ 空白窗口自动打开 q2 漫游器 + q4 侧边栏（仅当勾选了 roamAsStartPage）
			const isEmptyWindow = !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0;
			const roamAsStartPage = global.getConfig('roamAsStartPage');
			if (isEmptyWindow && roamAsStartPage) {
				setTimeout(() => {
					// 打开 q2 漫游器
					vscode.commands.executeCommand('qqq.q2');
					// 展开侧边栏并进入 q4
					vscode.commands.executeCommand('workbench.view.extension.qqqView');
					global.logMessage(q('qqq.log.emptyWindowAutoRover'), 'INFO');
				}, 500);
			}
		}
	})();

	global.logMessage(q('qqq.log.activateComplete'), "INFO");
}

function loadSubModules(context) {
	try {
		q1Module = require("./q1");
		if (q1Module?.activate) q1Module.activate(context);
	} catch (e) {
		global.logMessage(q('qqq.log.q1LoadError', e.message), "ERROR");
	}

	try {
		q2Module = require("./q2");
		if (q2Module?.activate) q2Module.activate(context);
	} catch (e) {
		global.logMessage(q('qqq.log.q2LoadError', e.message), "ERROR");
	}
}

async function deactivate() {
	// ★ Ultimate optimal solution: scorched-earth policy, set deactivated flag immediately
	global.setDeactivated(true);

	// ★ Ultimate optimal solution: await all bridge stops, and force-kill all tracked child processes
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
	try { await saveCacheMeta(); } catch { }  // ★ Must await, otherwise file may be truncated to 0 bytes when process exits

	if (q1Module?.deactivate) {
		try { await q1Module.deactivate(); } catch { }
	}

	if (q2Module?.deactivate) {
		try { await q2Module.deactivate(); } catch { }
	}

	// ★ Additional: deactivate q4 (clipboard history manager)
	try { await q4.deactivate(); } catch { }

	global.logMessage(q('qqq.log.deactivated'), "INFO");
}

function getIconCache(filePath) {
	if (!cacheMeta || !cacheMeta.icons) return null;
	try {
		// Merge file system calls to reduce IO operations
		let mtime = 0;
		try {
			const stat = fs.statSync(filePath);
			mtime = stat.mtimeMs;
		} catch {
			return null; // File does not exist, return directly
		}
		const entry = cacheMeta.icons[filePath];
		if (entry && entry.mtime === mtime) {
			const iconPath = path.join(cacheDir, `icon_${entry.hash}.png`);
			try {
				// Merge existsSync and readFileSync into one operation
				return fs.readFileSync(iconPath).toString("base64");
			} catch {
				// Icon file does not exist
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
	getPathSize,  // Extreme optimized version: only get size, do not count extensions
	getDiskFreeBatch,  // Batch get disk free for all drives (Python only, no fallback)
	cancelScansJS,  // Cancel in-progress JS scans

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

	// ★ Call when Python environment changes
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
		// ★ For filesystem-related errors, only log and do not crash
		const fsErrorCodes = ['EBUSY', 'EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOSPC'];
		if (error.code && fsErrorCodes.includes(error.code)) {
			global.logMessage(q('qqq.log.fsError', error.code, error.message), "WARN");
		} else {
			global.logMessage(q('qqq.log.uncaughtException', `${error.message}\n${error.stack}`), "ERROR");
		}
	});

	process.on("unhandledRejection", (reason) => {
		const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
		// ★ For filesystem-related errors, only log and do not crash
		const fsErrorCodes = ['EBUSY', 'EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOSPC'];
		if (reason instanceof Error && reason.code && fsErrorCodes.includes(reason.code)) {
			global.logMessage(q('qqq.log.fsError', reason.code, reason.message), "WARN");
		} else {
			global.logMessage(q('qqq.log.unhandledRejection', msg), "ERROR");
		}
	});
}


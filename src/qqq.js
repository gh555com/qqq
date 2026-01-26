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
const { ClipboardHistoryManager } = q4;

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
const CACHE_MAX_SIZE = 40 * 1024 * 1024;
const CACHE_TARGET_SIZE = 28 * 1024 * 1024;
const PASTE_SIZE_THRESHOLD = 80 * 1024 * 1024;

const FINGERPRINT_HEAD = 128;
const FINGERPRINT_MID = 128;
const FINGERPRINT_TAIL = 128;

// Keep ffmpeg loading in qqq as it was
let _localFfmpegPath = null;
let _localFfprobePath = null;

let extensionContext = null;
let cacheDir = null;
let cacheMeta = null;
let _statusBarTimer = null;
let clipboardHistoryManager = null;
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

// ============================================================================
// Cache Initialization & Management
// ============================================================================
function initCache(context) {
	const globalStoragePath = context.globalStorageUri?.fsPath || context.globalStoragePath;
	if (!globalStoragePath) {
		global.logMessage("initCache: globalStoragePath is undefined!", "ERROR");
		return;
	}
	cacheDir = path.join(globalStoragePath, CACHE_DIR_NAME);
	if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
	loadCacheMeta();
	validateCache();
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

function loadCacheMeta() {
	const metaPath = path.join(cacheDir, META_FILE_NAME);
	try {
		if (fs.existsSync(metaPath)) {
			cacheMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
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

function saveCacheMeta() {
	if (!cacheDir || !cacheMeta) return;

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

	const sig = st ? `${cacheKeyForPath(filePath)}|${st.mtimeMs}|${st.size}` : `${cacheKeyForPath(filePath)}|nostat`;

	const cached = _fpCache.get(sig);
	if (cached) {
		// LRU touch
		_fpCache.delete(sig);
		_fpCache.set(sig, cached);
		return cached;
	}

	const fp = _computeFingerprintRaw(filePath);
	if (fp) {
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
const BROKEN_BASE_TTL_MS = 2 * 60 * 1000;        // 2 minutes
const BROKEN_MAX_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const BROKEN_GC_INTERVAL_MS = 30 * 60 * 1000;    // 30 minutes
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
			if (stdout.length < 256 * 1024) stdout += data;
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
		// 保护图标文件不被误删，除非它们在 meta 中已不存在
		if (orphan.startsWith("icon_") && orphan.endsWith(".png")) {
			continue;
		}
		try {
			fs.unlinkSync(path.join(cacheDir, orphan));
			changed = true;
		} catch (e) { }
	}

	// Validate Source File Index
	if (cacheMeta.fileIndex) {
		const fps = Object.keys(cacheMeta.fileIndex);
		for (const fp of fps) {
			const p = cacheMeta.fileIndex[fp];
			if (!p || !fs.existsSync(p)) {
				delete cacheMeta.fileIndex[fp];
				changed = true;
			} else {
				// Sync to memory
				h.prefillFingerprint(p, fp);
			}
		}
	}

	// Validate Icons
	if (cacheMeta.icons) {
		const iconFiles = Object.keys(cacheMeta.icons);
		for (const p of iconFiles) {
			const entry = cacheMeta.icons[p];
			if (!entry || !entry.hash) {
				delete cacheMeta.icons[p];
				changed = true;
				continue;
			}
			const iconFileName = `icon_${entry.hash}.png`;
			if (!actualFiles.has(iconFileName)) {
				delete cacheMeta.icons[p];
				changed = true;
			} else {
				actualFiles.delete(iconFileName);
				try {
					const st = fs.statSync(path.join(cacheDir, iconFileName));
					realSize += st.size;
					realCount++;
				} catch (e) { }
			}
		}
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
		return null;
	}

	const fileName = `${contentId}.${quality}`;
	const filePath = path.join(cacheDir, fileName);

	try {
		if (fs.existsSync(filePath)) {
			const buffer = fs.readFileSync(filePath);

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
					updateStatusBarThrottled();
					return buffer;
				}
			} else {
				// Unknown/legacy format: keep old behavior
				entry.atime = Date.now();
				cacheMeta.stats.hitCount++;
				global.markCacheHit();
				updateStatusBarThrottled();
				return buffer;
			}
		}
	} catch (e) { }

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
					existingFiles: global.getDirectorySnapshot(targetDir)
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

	const res = await tryEngineCall({
		python: "folder_info",
		rust: "folder_info"
	}, { path: folderPath }, 15000);
	if (res) return res;

	return getFolderInfoJS(folderPath);
}

async function getFolderInfoJS(folderPath) {
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

	return {
		success: true,
		total_size: totalSize,
		file_count_root: fileCount,
		ext_stats: extStats,
	};
}

function shouldShowDuration(info) {
	return info && (info.type === "video" || info.type === "animated_image") && info.duration > 0.1;
}

let downloadContext = null;

async function savorMomentsCommand() {
	try {
		const assetsPath = path.join(extensionContext.extensionPath, 'assets');
		let selectedAudioPath;

		const randomNumber = Math.floor(Math.random() * 30);
		if (randomNumber === 0) {
			selectedAudioPath = path.join(assetsPath, 'q.mp3');
		} else {
			const randomIndex = Math.floor(Math.random() * 3);
			const audioNum = randomIndex + 1;
			selectedAudioPath = path.join(assetsPath, `${audioNum}.mp3`);
		}

		if (fs.existsSync(selectedAudioPath)) {
			const audioBase64 = fs.readFileSync(selectedAudioPath).toString('base64');
			if (activeSidebarProvider) {
				activeSidebarProvider.postMessage({
					command: 'playAudio',
					base64: audioBase64,
					times: 1
				});
			} else {
				// 如果侧边栏未打开，回退到系统播放器（或者静默，根据用户需求）
				// 用户说不要弹出系统播放器，所以这里我们尝试聚焦侧边栏
				vscode.commands.executeCommand('workbench.view.extension.qqqView').then(() => {
					setTimeout(() => {
						if (activeSidebarProvider) {
							activeSidebarProvider.postMessage({
								command: 'playAudio',
								base64: audioBase64,
								times: 1
							});
						}
					}, 500);
				});
			}
		}
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

	let rawUrl = urlArg;
	if (!rawUrl) {
		rawUrl = await vscode.window.showInputBox({
			prompt: " ",
			ignoreFocusOut: true,
			placeHolder: " 直接粘贴 [ 包含视频的网址 ]",
			validateInput: (text) => {
				const s = (text || "").trim();
				if (!s) return null;
				if (/\s/.test(s)) return "无效网址";

				// 尝试解析 (支持不带协议头的短链接，如 youtu.be/xxx)
				let toCheck = s;
				if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(s)) {
					toCheck = 'https://' + s;
				}

				try {
					const u = new URL(toCheck);
					// 至少包含一个点或者是 localhost
					if (u.hostname.includes('.') || u.hostname === 'localhost') {
						return null;
					}
				} catch { }

				return "无效网址";
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
		existingFiles: global.getDirectorySnapshot(targetDir)  // ★ 任务开始时的目录快照
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

	const extensionPath = context.extensionUri?.fsPath || context.extensionPath;
	if (!extensionPath) {
		global.logMessage("activate: extensionPath is undefined!", "ERROR");
		return;
	}

	// 已经移至 global.init(context)

	initCache(context);

	// ★ 预热/静默安装视频引擎
	try {
		const { getSharedDownloader } = require('./dow');
		getSharedDownloader().ensureYtdlpReady(context, { background: true }).catch(() => { });
	} catch (e) { }

	// 初始化剪切板历史管理器
	// 初始化核心模块 (q4 现已合并了剪切板历史逻辑)
	try {
		const q4Api = q4.activate(context);
		global.clipboardHistoryManager = q4Api; // 保持全局引用兼容性
	} catch (e) {
		global.logMessage(`q4 (剪切板/侧边栏) 加载失败: ${e.message}`, "ERROR");
	}
	global.setCacheStatsGetter(() => getCacheStatsSnapshot());
	global.setLogPath(path.join(cacheDir, "err.log"));
	global.initStatusBar();
	updateStatusBarThrottled();

	startDaemons();

	// 设置 CodeLens 样式
	function updateCodeLensStyle() {
		const config = vscode.workspace.getConfiguration("qqq");
		const takeOver = config.get("takeOverCodelensStyle", true);
		if (takeOver) {
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

	// 侧边栏 WebView 现在由 q4.activate(context) 内部自动注册
	// activeSidebarProvider 通过 q4Api 机制获取 (如有需要)

	// 保留原来的命令，但现在只是聚焦到侧边栏
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


		vscode.workspace.onDidChangeConfiguration((event) => {
			for (const key of Object.keys(global.ConfigManager.getAll())) {
				const fullKey = `qqq.${key}`;
				if (event.affectsConfiguration(fullKey)) {
					const val = vscode.workspace.getConfiguration("qqq").get(key);
					const currentStored = global.ConfigManager.get(key);
					if (val !== currentStored) {
						global.setConfig(key, val).then(() => {
							if (key === "ioEngine") {
								// ★ 核心设计：三个引擎启动时已全部启动，切换只需更新状态栏
								global.logMessage(`引擎切换为: ${val}，更新状态栏`, "INFO");
								updateStatusBarThrottled();
							}
						});
					}
				}
			}
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

	try { validateCache(); } catch { }
	saveCacheMeta();

	if (q1Module?.deactivate) {
		try { await q1Module.deactivate(); } catch { }
	}

	if (q2Module?.deactivate) {
		try { await q2Module.deactivate(); } catch { }
	}

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
	validateCache,
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



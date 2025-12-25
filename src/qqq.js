const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const sizeOf = require("image-size");

const q3 = require("./q3");
const global = require("./global");
const cheerio = require("cheerio");

// 引用 global.js 的核心对象
const {
	pythonBridge,
	rustBridge,
	shellBridge,
	startDaemons,
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
// Cache Meta Logic
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
// Fingerprint Logic
// ============================================================================
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

		_fingerprintCache.set(key, { mtime, size, fp });
		if (_fingerprintCache.size > 2000) _fingerprintCache.clear();

		return fp;
	} catch (e) {
		return null;
	}
}

// ============================================================================
// Cache Initialization & Management
// ============================================================================
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

// ============================================================================
// IO & Clipboard Logic
// ============================================================================
function ensureDir(dirPath) {
	if (!fs.existsSync(dirPath)) {
		try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { }
	}
}

const CLIPBOARD_PEEK_TIMEOUT_MS = 350;

async function peekClipboardRichFast() {
	const pref = global.getEnginePreference();
	const order = global.getEngineTryOrder(pref);

	const promises = [];

	if (shellBridge?.isAvailable && shellBridge.isAvailable()) {
		promises.push((async () => {
			try {
				const hasHtml = await shellBridge.call("hasHtml", {}, 200);
				if (hasHtml?.value) return { type: "peek", has_html: true, priority: 100 };
			} catch { }
			return null;
		})());
	}

	if (order.includes("python") && pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
		promises.push((async () => {
			try {
				const res = await pythonBridge.call("clipboard_peek", {}, CLIPBOARD_PEEK_TIMEOUT_MS);
				if (res && !res.error && res.type === "peek") return { ...res, priority: 50 };
			} catch { }
			return null;
		})());
	}

	promises.push((async () => {
		try {
			const text = await vscode.env.clipboard.readText();
			if (text && /<\/?(html|body|div|p|img|picture|source|span|a|ul|li|table|tr|td|h[1-6]|b|i|strong|em|code|pre|blockquote)\b/i.test(text)) {
				return { type: "peek", has_html: true, priority: 80 };
			}
		} catch { }
		return null;
	})());

	try {
		return await Promise.race(promises.filter(p => p !== null));
	} catch { }

	return null;
}

async function raceClipboard(targetDir, callback) {
	const qStart = Date.now();
	let qStatus = { hasFile: false, hasHtml: false, hasImage: false, hasText: false };
	let handled = false;

	try {
		if (shellBridge && shellBridge.available !== false) {
			const res = await shellBridge.call("checkQ", {}, 500);
			if (res && !res.error) {
				qStatus = res;
				handled = true;
			}
		}
	} catch (e) { }

	if (!handled && process.platform === "win32") {
		try {
			const psScript = `Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetDataObject().GetFormats();$o=@{hasFile=$false;hasHtml=$false;hasImage=$false;hasText=$false};if($f -contains 'FileDrop'){$o.hasFile=$true};if($f -contains 'HTML Format'){$o.hasHtml=$true};if(($f -contains 'Bitmap')-or($f -contains 'DeviceIndependentBitmap')-or($f -contains 'PNG')){$o.hasImage=$true};if(($f -contains 'Text')-or($f -contains 'UnicodeText')){$o.hasText=$true};$o|ConvertTo-Json -Compress`;
			const jsonStr = await spawnOutput("powershell", [
				"-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript
			]);
			if (jsonStr && jsonStr.trim()) {
				const parsed = JSON.parse(jsonStr);
				if (parsed) {
					qStatus = parsed;
					handled = true;
					if (shellBridge && !shellBridge.isAvailable() && !shellBridge.isPermDisabled) {
						shellBridge.start().catch(() => { });
					}
				}
			}
		} catch (e) {
			global.logMessage(`[Fallback] raceClipboard Spawn failed: ${e.message}`, "WARN");
		}
	}

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

		if (typeHint === "html") {
			return await global.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "qqq: 正在粘贴 HTML...",
				cancellable: true
			}, async (progress, newTok) => {
				newTok.onCancellationRequested(() => {
					global.logMessage("HTML 粘贴被用户取消", "WARN");
				});
				const progCb = (pct, msg) => {
					progress.report({ message: msg, increment: pct });
				};
				return await handleClipboardNode(targetDir, partialCallback, newTok, progCb);
			});
		}

		if (typeHint === "file") {
			let files = [];
			const pref = global.getEnginePreference();
			const order = global.getEngineTryOrder(pref);

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

			if (totalSize > PASTE_SIZE_THRESHOLD || files.length > 10) {
				const sizeStr = formatBytes(totalSize);
				return await global.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: `qqq: 正在粘贴文件 ( ${sizeStr} )`,
					cancellable: true
				}, async (progress, newTok) => {
					newTok.onCancellationRequested(() => {
						global.logMessage("文件粘贴被用户取消", "WARN");
					});
					const progCb = (pct, msg) => {
						progress.report({ message: msg, increment: pct });
					};
					return await handleClipboardShell(targetDir, newTok, progCb, files, totalSize);
				});
			} else {
				return await handleClipboardShell(targetDir, token, null, files);
			}
		}

		if (typeHint === "image") {
			return await handleClipboardShell(targetDir, token, partialCallback);
		}

		return null;
	});
}

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
// HTML Helpers
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

	const srcsetKeys = ["srcset", "data-srcset", "data-lazy-srcset", "data-lazysrcset", "data-src-set"];
	for (const k of srcsetKeys) {
		const v = _pickBestFromSrcset($el.attr(k));
		if (v) urls.push(v);
	}

	const srcKeys = isSourceTag
		? ["src", "data-src"]
		: ["src", "data-src", "data-original", "data-orig", "data-lazy-src", "data-lazysrc", "data-actualsrc", "data-url", "data-img"];
	for (const k of srcKeys) {
		const v = _normalizeUrl($el.attr(k));
		if (v) urls.push(v);
	}

	return urls;
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

// ============================================================================
// File Copy with Progress
// ============================================================================
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

// ============================================================================
// handleClipboardNode
// ============================================================================
async function handleClipboardNode(targetDir, partialCallback = null, token = null, progressCallback = null) {
	try {
		if (token?.isCancellationRequested) return null;
		if (progressCallback) progressCallback(0, "正在解析 HTML...");

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

		if (!htmlText && process.platform === "win32") {
			try {
				const psScript = `Add-Type -A System.Windows.Forms;$t=[System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::Html);if($t){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))}`;
				const b64 = await spawnOutput("powershell", [
					"-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript
				]);
				if (b64 && b64.trim()) {
					htmlText = Buffer.from(b64.trim(), "base64").toString("utf8");
					if (shellBridge && !shellBridge.isAvailable() && !shellBridge.isPermDisabled) {
						shellBridge.start().catch(() => { });
					}
				}
			} catch (e) {
				global.logMessage(`[Fallback] handleClipboardNode Spawn failed: ${e.message}`, "WARN");
			}
		}

		if (!htmlText) {
			const text = await vscode.env.clipboard.readText();
			if (text && _looksLikeHtml(text)) {
				htmlText = text;
			}
		}

		if (!htmlText || !htmlText.trim()) return { type: "text", text: await vscode.env.clipboard.readText() || "" };

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

		let safeHtml = sanitizeHtml(htmlText);
		if (!safeHtml) return { type: "text", text: htmlText };

		let $;
		try {
			$ = cheerio.load(safeHtml, { decodeEntities: false, xmlMode: false });
			$("script, iframe, object, embed, style, link[rel=stylesheet], meta, base, form, input, button, textarea").remove();

			$('*').each((i, el) => {
				const tag = el.tagName.toLowerCase();
				$(el).removeAttr('style');

				const attribs = el.attribs || {};
				for (const attr of Object.keys(attribs)) {
					if (attr.startsWith('on')) $(el).removeAttr(attr);
				}

				if (tag === 'img' || tag === 'br' || tag === 'p' || tag === 'div' || /^h[1-6]$/.test(tag) || tag === 'li' || tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'tr' || tag === 'td' || tag === 'th') {
					const attribs = el.attribs || {};
					for (const attr of Object.keys(attribs)) {
						if (tag === 'img') {
							if (!['src', 'data-src', 'srcset', 'data-srcset', 'alt', 'title'].includes(attr)) {
								$(el).removeAttr(attr);
							}
						} else {
							$(el).removeAttr(attr);
						}
					}
				} else if (el.type === 'tag') {
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

		const cleanText = await vscode.env.clipboard.readText() || "";
		const cleanLines = cleanText.split(/\r?\n/);
		let cleanLineIndex = 0;

		const blocks = [];
		let currentBlockHasText = false;
		let currentBlockImages = [];

		function flushBlock() {
			if (currentBlockHasText) {
				while (cleanLineIndex < cleanLines.length) {
					const line = cleanLines[cleanLineIndex++];
					if (line && line.trim()) {
						blocks.push({ type: "text", text: line });
						break;
					} else {
						blocks.push({ type: "text", text: "" });
					}
				}
			}

			for (const img of currentBlockImages) {
				blocks.push(img);
			}

			currentBlockHasText = false;
			currentBlockImages = [];
		}

		const root = $('body').length ? $('body') : $.root();

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
		flushBlock();

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
						let ext = ".png";
						try {
							const u = new URL(b.src, "http://x.com");
							ext = path.extname(u.pathname) || "";
						} catch {
							ext = path.extname(b.src) || "";
						}

						const dl = await _downloadUrlToBuffer(b.src);
						if (dl.error || !dl.buffer) {
							global.logMessage(`Image download failed: ${b.src} -> ${dl.error}`, "WARN");
							return;
						}

						let finalExt = ext.toLowerCase();

						if (!IMAGE_EXTS_FOR_CLIPBOARD.has(finalExt)) {
							try {
								const dim = sizeOf(dl.buffer);
								if (dim && dim.type) {
									finalExt = "." + dim.type;
									if (finalExt === ".jpeg") finalExt = ".jpg";
								} else {
									finalExt = ".webp";
								}
							} catch (e) {
								finalExt = ".webp";
							}
						}

						const filename = getTimestampFilename(finalExt);
						const destPath = path.join(targetDir, filename);

						ensureDir(targetDir);
						fs.writeFileSync(destPath, dl.buffer);

						const fp = computeBufferFingerprint(dl.buffer);
						if (fp) prefillFingerprint(destPath, fp);

						b.filename = filename;
						b.path = destPath;
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
			let completedCount = 0;
			const total = pendingTasks.length;
			const wrappedTasks = pendingTasks.map(taskPromise => {
				return taskPromise.then(() => {
					completedCount++;
					if (progressCallback) {
						const inc = 90 / total;
						progressCallback(inc, `下载图片 ${completedCount}/${total}`);
					}
				});
			});
			await Promise.all(wrappedTasks);
		}

		return { type: "html_blocks", blocks };
	} catch (e) {
		global.logMessage(`handleClipboardNode 失败: ${e?.message || e}`, "ERROR");
		return null;
	}
}

// ============================================================================
// handleClipboardShell
// ============================================================================
async function handleClipboardShell(targetDir, token = null, progressCallback = null, preFetchedFiles = null, preCalculatedTotalSize = 0) {
	try {
		if (token?.isCancellationRequested) return null;
		if (process.platform === "win32") {
			let files = preFetchedFiles;
			if (!files) {
				const pref = global.getEnginePreference();
				const order = global.getEngineTryOrder(pref);

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

				let totalBytesToTransfer = preCalculatedTotalSize;
				if (progressCallback && totalBytesToTransfer <= 0) {
					for (const f of validFiles) {
						try { totalBytesToTransfer += fs.statSync(f).size; } catch { }
					}
				}

				let transferredBytes = 0;

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

							if (progressCallback) progressCallback(0, `正在复制 (${i + 1}/${totalFileCount}): ${baseName}`);

							await copyFileWithProgress(f, dest, (chunkSize, copied, total) => {
								transferredBytes += chunkSize;
								if (progressCallback && totalBytesToTransfer > 0) {
									const inc = (chunkSize / totalBytesToTransfer) * 100;
									const filePct = total > 0 ? Math.round((copied / total) * 100) : 0;
									progressCallback(inc, ` ${baseName} (${filePct}%)`);
								}
							}, token);

							if (srcFingerprint) prefillFingerprint(dest, srcFingerprint);
							copiedFiles.push(dest);
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

		const pref = global.getEnginePreference();
		const order = global.getEngineTryOrder(pref);

		for (const engine of order) {
			try {
				if (engine === "python" && pythonBridge?.isAvailable && pythonBridge.isAvailable()) {
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
	const pref = global.getEnginePreference();

	const bridgeMap = {
		"python": pythonBridge,
		"rust": rustBridge,
		"shell": shellBridge
	};

	const typeOrder = global.getEngineTryOrder(pref);
	const bridgeOrder = [];

	for (const type of typeOrder) {
		const b = bridgeMap[type];
		if (b) bridgeOrder.push(b);
	}

	for (const bridge of bridgeOrder) {
		if (!bridge.isAvailable()) continue;

		try {
			if (bridge === pythonBridge || bridge === rustBridge) {
				const res = await bridge.call("clipboard", { target_dir: targetDir }, 10000);
				if (res && !res.error && res.type !== "unknown") {
					global.logMessage(`[FastPath] 由 ${bridge.name} 引擎处理成功`, "INFO");
					return res;
				}
			}

			if (bridge === shellBridge) {
				const checkRes = await bridge.call("checkQ", {}, 2000);
				if (checkRes?.hasFile) {
					const filesRes = await bridge.call("getFiles", {}, 5000);
					const files = filesRes?.files || [];
					if (files.length > 0) {
						const result = processFilesForClipboard(files, targetDir);
						if (result) return result;
					}
				}

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

				if (this._configChangeTimer) clearTimeout(this._configChangeTimer);
				this._configChangeTimer = setTimeout(async () => {
					// 核心修改：配置变更时不再主动 kill 任何引擎
					// 仅调用 startDaemons 确保新偏好的引擎启动
					global.logMessage("配置变更，重新评估守护进程状态...", "DEBUG");
					startDaemons();
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
	// 只有在扩展彻底停用（关闭窗口）时才停止进程
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

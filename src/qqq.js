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

// 辅助函数：状态栏更新代理
function updateStatusBarNow() {
	global.updateStatusBar(
		getCacheStatsSnapshot(),
		typeof pythonBridge !== 'undefined' ? pythonBridge : null,
		typeof rustBridge !== 'undefined' ? rustBridge : null,
		typeof shellBridge !== 'undefined' ? shellBridge : null
	);
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
const _metaSaveQueue = new TaskQueue(); // ★ 内存锁：确保 Meta 串行写入

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
	_metaSaveQueue.enqueue(async () => {
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

		// ★ DoS 防护：1分钟内崩溃超过5次则永久禁用
		this.recentCrashes = [];
		this.isPermDisabled = false;
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
		global.logMessage(`${this.name} start 方法被调用`, "DEBUG");

		this._stopping = false;

		if (this.process && !this.process.killed) {
			global.logMessage(`${this.name} 进程已存在且未被杀死，返回true`, "DEBUG");
			return true;
		}
		if (this.isStarting) {
			global.logMessage(`${this.name} 正在启动中，返回启动Promise`, "DEBUG");
			return this.startPromise;
		}

		this.isStarting = true;
		this.startPromise = this.startFn(this);

		global.logMessage(`${this.name} 开始执行启动函数`, "DEBUG");

		try {
			const result = await this.startPromise;
			global.logMessage(`${this.name} 启动函数执行完成，结果: ${result}`, "DEBUG");
			return result;
		} finally {
			this.isStarting = false;
			this.startPromise = null;
		}
	}

	setupProcess(proc, resolve) {
		this.process = proc;

		global.logMessage(`${this.name} setupProcess called`, "DEBUG");

		const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => {
			try {
				if (!line || !line.trim()) return;

				let result;
				try {
					result = JSON.parse(line);
				} catch (e) {
					// 尝试 Base64 解码 (PowerShell 模式下输出是 Base64 封装的)
					try {
						const decoded = Buffer.from(line, "base64").toString("utf8");
						result = JSON.parse(decoded);
					} catch (e2) {
						throw e;
					}
				}

				const id = result._id;

				if (result.error) global.logMessage(`${this.name} 错误响应: ${result.error}`, "WARN");

				if (this.pending.has(id)) {
					const { resolve: res, timer } = this.pending.get(id);
					clearTimeout(timer);
					this.pending.delete(id);
					res(result);
				}
			} catch (e) {
				// 非JSON输出，可能是Python脚本的调试输出或错误信息
				global.logMessage(`${this.name} stdout: ${line}`, "WARN");
			}
		});

		proc.stderr.on("data", (d) => {
			const text = d?.toString?.() || "";
			this._appendStderrSnippet(text);
			const key = global.bridgeStderrKey(this.name, text);
			global.logMessageRateLimited(key, `${this.name} stderr: ${text}`, "WARN", 5 * 60 * 1000);
		});

		proc.on("error", (err) => {
			global.logMessage(`${this.name} 进程错误: ${err.message}`, "ERROR");
			this.lastCrashReason = _cleanReason(err.message);
			this._handleCrash();
		});
		proc.on("close", (code) => {
			global.logMessage(`${this.name} 进程关闭，退出码: ${code}`, "INFO");
			this.lastCrashReason = _cleanReason(`exit_code=${code}`);
			this._handleCrash();
		});

		// 实现ping重试逻辑，最多重试 15 次，总计约 7.5 秒
		let pingAttempts = 0;
		const maxPingAttempts = 15;
		const pingInterval = 500; // 每次ping间隔500ms
		const pingTimeout = 5000; // 增加ping超时时间到5秒

		const attemptPing = async () => {
			pingAttempts++;
			try {
				global.logMessage(`${this.name} 发送 ping 请求 (尝试 ${pingAttempts}/${maxPingAttempts})`, "DEBUG");
				// ★ 增加 Ping 超时时间，防止 PowerShell 启动慢导致误判
				const pong = await this.call("ping", {}, 3000);
				global.logMessage(`${this.name} ping 响应: ${JSON.stringify(pong)}`, "DEBUG");
				if (pong?.status === "alive") {
					this.restartCount = 0;
					this.available = true;
					this._setStartError("");
					global.logMessage(`${this.name} started`, "INFO");
					resolve(true);
					updateStatusBarNow();
					return true;
				}
			} catch (e) {
				global.logMessage(`${this.name} ping 超时 (尝试 ${pingAttempts}/${maxPingAttempts}): ${e.message}`, "DEBUG");
			}

			// 如果还有重试机会，继续尝试
			if (pingAttempts < maxPingAttempts) {
				// ★ 每次重试时稍微等一下，给进程喘息机会，避免死循环刷屏
				setTimeout(attemptPing, 200);
				return;
			}

			// 所有ping尝试都失败
			const reason = `ping_failed_after_${maxPingAttempts}_attempts${this.lastStderrSnippet ? ` ; stderr=${this.lastStderrSnippet}` : ""}`;
			this._setStartError(reason);
			global.logMessage(`${this.name} ping 失败，已尝试 ${maxPingAttempts} 次`, "WARN");
			this.available = false;
			resolve(false);
			updateStatusBarNow();
		};

		// 启动ping尝试，将初始延迟恢复为 5ms，解决 500ms 延迟问题
		setTimeout(attemptPing, 5);
	}

	_handleCrash() {
		global.logMessage(`${this.name} _handleCrash 方法被调用`, "DEBUG");
		this.process = null;

		for (const [id, { resolve, timer }] of this.pending) {
			global.logMessage(`${this.name} 清理待处理请求，id: ${id}`, "DEBUG");
			clearTimeout(timer);
			resolve({ error: "process_crashed" });
		}
		this.pending.clear();

		if (this._stopping) {
			global.logMessage(`${this.name} stopping=true，忽略自动重启`, "INFO");
			this.available = false;
			updateStatusBarNow();
			return;
		}

		if (this.isPermDisabled) {
			global.logMessage(`${this.name} 已被永久禁用，忽略重启`, "WARN");
			this.available = false;
			updateStatusBarNow();
			return;
		}

		// ★ DoS 检查
		const now = Date.now();
		this.recentCrashes.push(now);
		this.recentCrashes = this.recentCrashes.filter(t => now - t < 60000); // 只保留最近1分钟

		if (this.recentCrashes.length > 5) {
			this.isPermDisabled = true;
			this.available = false;
			const msg = `${this.name} 1分钟内崩溃超过5次，已触发熔断保护，永久禁用该 Bridge。`;
			this._setStartError(msg);
			global.logMessage(msg, "ERROR");

			// ★ Shell Daemon 致命错误弹窗
			if (this.name === "Shell") {
				vscode.window.showErrorMessage(
					"Node shell Deamo 陷入异常，qqq 将停止工作。",
					{
						modal: false,
						detail: " 解决方案：重启。"
					},
					"重启窗口"
				).then(selection => {
					if (selection === "重启窗口") {
						vscode.commands.executeCommand("workbench.action.reloadWindow");
					}
				});
			}

			updateStatusBarNow();
			return;
		}

		if (this.restartCount < this.maxRestarts) {
			this.restartCount++;
			// 指数退避策略：从 50ms 开始，快速重试
			const backoff = 50 * Math.pow(2, this.restartCount - 1);
			global.logMessage(`${this.name} 进程崩溃，尝试重启 (${this.restartCount}/${this.maxRestarts})，延迟 ${backoff}ms`, "WARN");
			setTimeout(() => this.start(), backoff);
		} else {
			global.logMessage(`${this.name} 进程崩溃，达到最大重启次数，标记为不可用`, "ERROR");
			this.available = false;
		}

		updateStatusBarNow();
	}

	async call(action, params = {}, timeout = 5000) {
		global.logMessage(`${this.name} call 方法被调用，action: ${action}`, "DEBUG");

		if (this.isPermDisabled) {
			return { error: `${this.name}_disabled_too_many_crashes` };
		}

		// 允许再尝试启动/重启（尤其是 cold start/ping race）
		if (this.available === false) {
			// 如果进程还活着，给一次机会重新 ping/start
			this.available = null;
		}

		if (!this.process || this.process.killed) {
			global.logMessage(`${this.name} 进程不存在或已被杀死，尝试启动`, "DEBUG");
			const started = await this.start();
			if (!started) {
				global.logMessage(`${this.name} 启动失败，返回错误`, "DEBUG");
				return { error: `${this.name}_not_available` };
			}
		}

		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";

		global.logMessage(`${this.name} 发送命令: ${cmd}`, "DEBUG");

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				global.logMessage(`${this.name} 命令超时，id: ${id}`, "DEBUG");
				if (this.pending.has(id)) {
					this.pending.delete(id);
					resolve({ error: "timeout" });
				}
			}, timeout);

			this.pending.set(id, { resolve, timer });

			try {
				this.process.stdin.write(cmd);
				global.logMessage(`${this.name} 命令写入成功，id: ${id}`, "DEBUG");
			} catch (e) {
				global.logMessage(`${this.name} 命令写入失败: ${e.message}, id: ${id}`, "ERROR");
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ error: "write_error" });
			}
		});
	}

	isAvailable() {
		return this.available === true;
	}

	async stop() {
		global.logMessage(`${this.name} stop 方法被调用`, "DEBUG");

		this._stopping = true;

		for (const [id, { resolve, timer }] of this.pending) {
			clearTimeout(timer);
			resolve({ error: "stopped" });
		}
		this.pending.clear();

		if (!this.process) {
			this.available = false;
			this.restartCount = 0;
			updateStatusBarNow();
			return;
		}

		if (!this.process.killed) {
			global.logMessage(`${this.name} 尝试优雅退出 (SIGTERM)`, "DEBUG");
			try {
				if (process.platform === "win32") {
					// ★ Windows 专用：使用 taskkill 杀进程树，防止孤儿进程
					try {
						cp.execSync(`taskkill /pid ${this.process.pid} /T /F`);
						global.logMessage(`${this.name} Windows taskkill 成功`, "DEBUG");
					} catch (e) {
						global.logMessage(`${this.name} Windows taskkill 失败 (可能已退出): ${e.message}`, "WARN");
					}
				} else {
					// 第一阶段：温柔请求 (SIGTERM)
					this.process.kill("SIGTERM");

					// 给进程 3 秒时间优雅退出
					await new Promise((resolve) => setTimeout(resolve, 3000));

					// 第二阶段：如果还没死，强制杀掉 (SIGKILL)
					if (this.process && !this.process.killed) {
						global.logMessage(`${this.name} 进程未退出，强制杀死 (SIGKILL)`, "WARN");
						this.process.kill("SIGKILL");
					}
				}
			} catch (e) {
				global.logMessage(`${this.name} 进程终止失败: ${e.message}`, "ERROR");
			}
		} else {
			global.logMessage(`${this.name} 进程已被杀死`, "DEBUG");
		}

		this.process = null;
		this.available = false;
		this.restartCount = 0;

		updateStatusBarNow();
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
					global.logMessage(`Python bridge 启动失败 (${bin}): ${e.message}`, "WARN");
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
					global.logMessage(`Python bridge 进程错误 (${bin}): ${err.message}`, "WARN");
					failFast();
				});

				bridge.setupProcess(proc, (ok) => {
					if (settled) return;
					settled = true;
					if (!ok && bridge.lastStartError) {
						global.logMessage(`Python Bridge 启动失败原因：${bridge.lastStartError}`, "WARN");
					}
					res(!!ok);
				});
			});
		};

		(async () => {
			const ok1 = await spawnWith("python");
			if (ok1) {
				global.logMessage("Python Bridge 使用 python 启动成功", "INFO");
				resolve(true);
				return;
			}

			if (process.platform !== "win32") {
				const ok2 = await spawnWith("python3");
				if (ok2) {
					global.logMessage("Python Bridge 使用 python3 启动成功", "INFO");
					resolve(true);
					return;
				}
			}

			global.logMessage(`Python Bridge 启动失败，所有尝试均已失败：${bridge.lastStartError || "unknown"}`, "WARN");
			resolve(false);
		})().catch((e) => {
			bridge._setStartError(`start_exception: ${e.message}`);
			global.logMessage(`Python Bridge 启动异常: ${e.message}`, "ERROR");
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
			global.logMessage("Rust Bridge 可执行文件未找到", "WARN");
			bridge.available = false;
			resolve(false);
			return;
		}

		try {
			global.logMessage(`Rust Bridge 尝试启动: ${exePath}`, "INFO");
			const proc = cp.spawn(exePath, ["--daemon"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			proc.once("error", (err) => {
				bridge._setStartError(`process_error: ${err.message}`);
				global.logMessage(`Rust Bridge 进程错误: ${err.message}`, "WARN");
				bridge.available = false;
				resolve(false);
			});

			bridge.setupProcess(proc, (ok) => {
				if (ok) {
					global.logMessage("Rust Bridge 启动成功", "INFO");
					resolve(true);
				} else {
					global.logMessage(`Rust Bridge 启动失败原因：${bridge.lastStartError || "unknown"}`, "WARN");
					resolve(false);
				}
			});
		} catch (e) {
			bridge._setStartError(`start_exception: ${e.message}`);
			global.logMessage(`Rust Bridge 启动异常: ${e.message}`, "ERROR");
			bridge.available = false;
			resolve(false);
		}
	});
});

// ★ Shell bridge：用于 Node 模式的 daemon（跨平台）
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
      'checkQ' {
        $formats = [System.Windows.Forms.Clipboard]::GetDataObject().GetFormats()
        $result.hasFile = $formats -contains "FileDrop"
        $result.hasHtml = $formats -contains "HTML Format"
        $result.hasImage = ($formats -contains "Bitmap") -or ($formats -contains "DeviceIndependentBitmap") -or ($formats -contains "PNG")
        $result.hasText = ($formats -contains "UnicodeText") -or ($formats -contains "Text")
      }
      'hasImage' {
        $val = [System.Windows.Forms.Clipboard]::ContainsImage()
        $result.value = $val
      }
      'hasFiles' {
        $val = [System.Windows.Forms.Clipboard]::ContainsFileDropList()
        $result.value = $val
      }
      'hasHtml' {
        $val = [System.Windows.Forms.Clipboard]::ContainsText([System.Windows.Forms.TextDataFormat]::Html)
        $result.value = $val
      }
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
      'getHtml' {
        $obj = [System.Windows.Forms.Clipboard]::GetData("HTML Format")
        $b64 = ""
        if ($obj -is [System.IO.Stream]) {
          $ms = [System.IO.MemoryStream]::new()
          $obj.CopyTo($ms)
          $bytes = $ms.ToArray()
          $b64 = [Convert]::ToBase64String($bytes)
        } elseif ($obj -is [string]) {
          $bytes = [Text.Encoding]::UTF8.GetBytes($obj)
          $b64 = [Convert]::ToBase64String($bytes)
        } else {
           $txt = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::Html)
           if ($txt) {
             $bytes = [Text.Encoding]::UTF8.GetBytes($txt)
             $b64 = [Convert]::ToBase64String($bytes)
           }
        }
        if ($b64) {
           $result.value_base64 = $b64
        }
      }
      default { $result.error = "unknown action" }
    }
  } catch {
    $result.error = $_.Exception.Message
  }

  $json = $result | ConvertTo-Json -Compress -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $b64 = [Convert]::ToBase64String($bytes)
  [Console]::Out.WriteLine($b64)
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $cmd = ConvertFrom-Json $line
    Process-Command $cmd
  } catch {
    $err = @{ _id = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($err)
    $b64 = [Convert]::ToBase64String($bytes)
    [Console]::Out.WriteLine($b64)
  }
}
`.trim();

			global.logMessage("尝试启动 PowerShell 进程", "DEBUG");
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
						global.logMessage(`尝试使用选项 ${index + 1} 启动 PowerShell: ${options[0]}`, "DEBUG");
						proc = cp.spawn(options[0], options.slice(1), {
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
						});
						global.logMessage(`PowerShell 进程已创建: ${options[0]}`, "DEBUG");
						break;
					} catch (e) {
						lastError = e;
						global.logMessage(`使用选项 ${index + 1} 启动 PowerShell 失败: ${e.message}`, "DEBUG");
					}
				}

				if (!proc) {
					bridge._setStartError(`spawn_fail: ${lastError?.message || "无法启动任何PowerShell进程"}`);
					throw lastError || new Error("无法启动任何PowerShell进程");
				}

				proc.on("error", (err) => {
					bridge._setStartError(`process_error: ${err.message}`);
					global.logMessage(`PowerShell 进程错误: ${err.message}`, "ERROR");
				});
				proc.on("exit", (code, signal) => {
					global.logMessage(`PowerShell 进程退出，代码: ${code}, 信号: ${signal}`, "INFO");
				});
			} catch (e) {
				bridge._setStartError(`create_fail: ${e.message}`);
				global.logMessage(`PowerShell 进程创建失败: ${e.message}`, "ERROR");
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
    hasHtml) if command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -q "text/html"; then echo '{"_id":'"$id"',"value":true}'; else echo '{"_id":'"$id"',"value":false}'; fi ;;
    getHtml)
      content=$(xclip -selection clipboard -o -t text/html 2>/dev/null | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
      echo '{"_id":'"$id"',"value":'$content'}' ;;
    saveImage)
      dest=$(json_get "$line" "path")
      if command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t image/png -o > "$dest" 2>/dev/null && [ -s "$dest" ]; then echo '{"_id":'"$id"',"success":true}'; else echo '{"_id":'"$id"',"success":false}'; fi ;;
    *) echo '{"_id":'"$id"',"error":"unknown action"}' ;;
  esac
done
`.trim();

			global.logMessage("尝试启动 Bash 进程", "DEBUG");
			try {
				proc = cp.spawn("bash", ["-c", bashScript], { stdio: ["pipe", "pipe", "pipe"] });
				global.logMessage("Bash 进程已创建", "DEBUG");
			} catch (e) {
				bridge._setStartError(`spawn_fail(bash): ${e.message}`);
				global.logMessage(`Bash 进程创建失败: ${e.message}`, "ERROR");
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
			if (!ok) global.logMessage(`Shell Bridge 启动失败原因：${bridge.lastStartError || "unknown"}`, "WARN");
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

async function handleClipboardSlow(targetDir, qStart = Date.now(), typeHint = null) {
	return _pasteQueue.enqueue(async () => {
		if (typeHint === "file") {
			if (shellBridge?.isAvailable && shellBridge.isAvailable()) {
				const filesRes = await shellBridge.call("getFiles", {}, 2000);
				if (filesRes && filesRes.files && filesRes.files.length > 0) {
					ensureDir(targetDir);
					return await handleClipboardShell(targetDir);
				}
			}
			return await handleClipboardShell(targetDir);
		}

		if (typeHint === "image") {
			return await handleClipboardShell(targetDir);
		}

		if (typeHint === "html") {
			return await handleClipboardNode(targetDir);
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
// ★ handleClipboardNode（修复语法错误：补齐 try/catch + 正确闭合）
// ------------------------------------------------------------------------
async function handleClipboardNode(targetDir) {
	try {
		// 1. 尝试通过 Shell Bridge 获取 HTML
		// 只要 ShellBridge 没挂 (available !== false)，就尝试获取，利用其强大的格式支持
		let htmlText = null;
		if (shellBridge && shellBridge.available !== false) {
			try {
				const res = await shellBridge.call("getHtml", {}, 5000);
				if (res) {
					if (res.value_base64) {
						htmlText = Buffer.from(res.value_base64, "base64").toString("utf8");
					} else if (res.value) {
						htmlText = res.value;
					}
				}
			} catch (e) {
				global.logMessage(`Shell Bridge getHtml 失败: ${e.message}`, "WARN");
			}
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
			await Promise.all(pendingTasks);
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
			}
		}

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

let _daemonBootSeq = 0;

function startDaemons() {
	const bootSeq = ++_daemonBootSeq;

	const pref = global.getEnginePreference();
	global.logMessage(`开始启动守护进程，用户选择的引擎: ${pref}`, "INFO");

	const startOne = async (bridge, isHardFail) => {
		if (bootSeq !== _daemonBootSeq) return false;

		try {
			// 如果已经启动了，直接返回 true
			if (bridge.isAvailable()) return true;

			global.logMessage(`尝试启动 ${bridge.name} bridge`, "DEBUG");
			const ok = await bridge.start();

			// ★ 再次检查 bootSeq，防止启动过程中发生了新的配置切换
			if (bootSeq !== _daemonBootSeq) {
				global.logMessage(`${bridge.name} 启动被中断 (bootSeq mismatch)，立即停止`, "WARN");
				try { await bridge.stop(); } catch { }
				return false;
			}

			if (!ok) {
				const msg = `${bridge.name} Bridge 启动失败：${bridge.lastStartError || "unknown"}`;
				global.logMessage(msg, isHardFail ? "ERROR" : "WARN");
			} else {
				global.logMessage(`${bridge.name} Bridge OK`, "INFO");
			}
			return !!ok;
		} catch (e) {
			const msg = `${bridge.name} Bridge 启动异常：${e?.message || e}`;
			global.logMessage(msg, isHardFail ? "ERROR" : "WARN");
			return false;
		} finally {
			updateStatusBarNow();
		}
	};

	(async () => {
		if (bootSeq !== _daemonBootSeq) return;

		// ★ 严格按照配置来决定启动谁，避免启动不必要的进程
		// 1. ShellBridge 始终启动（它是基础能力）
		const shellTask = startOne(shellBridge, false);

		// 2. 根据 pref 决定是否启动 Python/Rust
		// 如果 pref 是 "shell" (即配置中的 node)，我们显式不启动 Py/Rust
		if (pref !== "shell") {
			// 根据回退顺序尝试启动
			let tryOrder = [];
			if (pref === "python") {
				tryOrder = [pythonBridge, rustBridge];
			} else if (pref === "rust") {
				tryOrder = [rustBridge, pythonBridge];
			} else {
				// auto
				tryOrder = [pythonBridge, rustBridge];
			}

			for (const bridge of tryOrder) {
				if (bootSeq !== _daemonBootSeq) break;

				// 启动成功一个主引擎即可
				if (await startOne(bridge, false)) {
					// ★ 关键优化：如果成功启动了高优先级的引擎，确保低优先级的引擎是停止的
					// 比如：auto 模式下，Python 启动成功了，那么 Rust 就不应该在后台跑
					for (const other of tryOrder) {
						if (other !== bridge && other.isAvailable()) {
							global.logMessage(`停止多余的引擎: ${other.name}`, "DEBUG");
							other.stop();
						}
					}
					break;
				}
			}
		} else {
			// 如果 pref 是 shell，确保 Py/Rust 是停止的 (防泄漏)
			if (pythonBridge.isAvailable()) pythonBridge.stop();
			if (rustBridge.isAvailable()) rustBridge.stop();
		}

		await shellTask;

		// 3. 最终检查
		if (bootSeq === _daemonBootSeq) {
			const anyAvailable = pythonBridge.isAvailable() || rustBridge.isAvailable() || shellBridge.isAvailable();
			if (!anyAvailable) {
				global.logMessage("All daemons failed, using spawn fallback", "WARN");
			}
			updateStatusBarNow();
		}
	})().catch((e) => {
		global.logMessage(`startDaemons 流程异常: ${e?.message || e}`, "WARN");
		updateStatusBarNow();
	});
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

	probeScheduler,
	genScheduler,

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

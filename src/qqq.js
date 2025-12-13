// File: src/qqq.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const readline = require("readline");
const crypto = require("crypto");

// ==================== 全局配置 ====================
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const outputChannel = vscode.window.createOutputChannel("qqq extension");

// ★★★ 核心正则：唯一真理源 ★★★
const QQQ_PATH_REGEX = /\/\\\s*.*?qqq.*?\s*\\\//gi;
const PENDING_REGEX = /\/\\__PENDING__:([a-zA-Z0-9]+)__\\\//g;

// ==================== 缓存配置常量 ====================
const CACHE_CONFIG = {
	MAX_DISK_CACHE_SIZE: 40 * 1024 * 1024,
	CLEANUP_TARGET_RATIO: 0.7,
	PATH_MAP_SIZE: 1000,
	MEM_CACHE_SIZE: 50,
	SAMPLE_SIZE: 128,
	FRAME_WIDTH: 512,
	FRAME_HEIGHT: 288,
	BROKEN_RETRY_DAYS: 7,
	BROKEN_MAX_ATTEMPTS: 3,
	SAVE_DEBOUNCE_MS: 5000,
	MAX_CONCURRENCY: 8,
	FFMPEG_TIMEOUT_MS: 30000,
	PROBE_TIMEOUT_MS: 10000
};

const WEB_SAFE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg']);
const ALPHA_CAPABLE_FORMATS = new Set(['png', 'apng', 'gif', 'webp', 'avif', 'tiff', 'tif', 'psd', 'ico', 'bmp']);
const OPAQUE_ONLY_FORMATS = new Set(['jpg', 'jpeg', 'heic', 'heif', 'raw', 'dng', 'cr2', 'nef', 'arw', 'dib']);

// ==================== FFmpeg 路径管理 ====================
let ffmpegPath = null;
try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
} catch (e) {
	ffmpegPath = null;
}

// ==================== 状态栏 ====================
let statusBarItem = null;
let currentEngine = "JS Spawn";
let globalExtensionContext = null;

// ==================== 缓存系统核心 ====================
let cacheDir = null;
let metaIndex = null;
let saveTimer = null;
let isDirty = false;

class LRUCache {
	constructor(maxSize) {
		this.maxSize = maxSize;
		this.cache = new Map();
	}
	get(key) {
		if (!this.cache.has(key)) return undefined;
		const value = this.cache.get(key);
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}
	set(key, value) {
		if (this.cache.has(key)) this.cache.delete(key);
		while (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			this.cache.delete(firstKey);
		}
		this.cache.set(key, value);
	}
	has(key) { return this.cache.has(key); }
	delete(key) { return this.cache.delete(key); }
	clear() { this.cache.clear(); }
	get size() { return this.cache.size; }
}

const pathMap = new LRUCache(CACHE_CONFIG.PATH_MAP_SIZE);
const memCache = new LRUCache(CACHE_CONFIG.MEM_CACHE_SIZE);
const pendingTasks = new Map();

class TaskQueue {
	constructor(concurrency = 8) {
		this.concurrency = concurrency;
		this.running = 0;
		this.queue = [];
	}
	run(taskFactory) {
		return new Promise((resolve, reject) => {
			this.queue.push({ taskFactory, resolve, reject });
			this.next();
		});
	}
	async next() {
		if (this.running >= this.concurrency || this.queue.length === 0) return;
		const { taskFactory, resolve, reject } = this.queue.shift();
		this.running++;
		try {
			const result = await taskFactory();
			resolve(result);
		} catch (e) {
			reject(e);
		} finally {
			this.running--;
			this.next();
		}
	}
}

const taskQueue = new TaskQueue(CACHE_CONFIG.MAX_CONCURRENCY);

// ==================== ★★★ 纯 JS 指纹计算（零依赖）★★★ ====================
function computeContentId(filePath) {
	try {
		const stat = fs.statSync(filePath);
		const size = stat.size;
		const SAMPLE_SIZE = CACHE_CONFIG.SAMPLE_SIZE;

		const samples = [];
		if (size <= SAMPLE_SIZE) {
			samples.push({ offset: 0, length: size });
		} else if (size <= SAMPLE_SIZE * 2) {
			samples.push({ offset: 0, length: SAMPLE_SIZE });
			samples.push({ offset: size - SAMPLE_SIZE, length: SAMPLE_SIZE });
		} else {
			samples.push({ offset: 0, length: SAMPLE_SIZE });
			samples.push({ offset: Math.floor(size / 2) - Math.floor(SAMPLE_SIZE / 2), length: SAMPLE_SIZE });
			samples.push({ offset: size - SAMPLE_SIZE, length: SAMPLE_SIZE });
		}

		const fd = fs.openSync(filePath, 'r');
		const buffers = [];
		for (const s of samples) {
			const buf = Buffer.alloc(s.length);
			fs.readSync(fd, buf, 0, s.length, s.offset);
			buffers.push(buf);
		}
		fs.closeSync(fd);

		const sizeBuffer = Buffer.alloc(8);
		sizeBuffer.writeBigUInt64LE(BigInt(size));

		const combined = Buffer.concat([sizeBuffer, ...buffers]);
		const hash = crypto.createHash('md5').update(combined).digest('hex');

		const sizeHex = size.toString(16).padStart(16, '0');
		return `${sizeHex}_${hash}`;
	} catch (e) {
		return null;
	}
}

// ==================== 缓存初始化 ====================
function initCache(globalStoragePath) {
	cacheDir = path.join(globalStoragePath, 'preview_cache');
	if (!fs.existsSync(cacheDir)) {
		fs.mkdirSync(cacheDir, { recursive: true });
	}
	const metaPath = path.join(cacheDir, 'meta.json');
	if (fs.existsSync(metaPath)) {
		try {
			const content = fs.readFileSync(metaPath, 'utf8');
			metaIndex = JSON.parse(content);
			if (metaIndex.version < 2) migrateToV2();
		} catch (e) {
			logMessage(`Failed to load meta.json, reinitializing`, "WARN");
			metaIndex = createEmptyIndex();
		}
	} else {
		metaIndex = createEmptyIndex();
	}
	validateCacheConsistency();
}

function createEmptyIndex() {
	return {
		version: 2,
		entries: {},
		stats: { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0, lastCleanup: Date.now() },
		brokenFiles: {}
	};
}

function migrateToV2() {
	metaIndex.version = 2;
	if (!metaIndex.stats) metaIndex.stats = { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0, lastCleanup: Date.now() };
	if (!metaIndex.brokenFiles) metaIndex.brokenFiles = {};
	scheduleSave();
}

function validateCacheConsistency() {
	if (!cacheDir || !metaIndex) return;
	const actualFiles = new Set();
	try {
		const files = fs.readdirSync(cacheDir);
		for (const file of files) {
			if (file.endsWith('.0') || file.endsWith('.1') || file.endsWith('.9')) {
				actualFiles.add(file);
			}
		}
	} catch (e) { return; }

	for (const [contentId, entry] of Object.entries(metaIndex.entries)) {
		for (const q of ['0', '1', '9']) {
			if (entry.qualities && entry.qualities[q]) {
				const fileName = `${contentId}.${q}`;
				if (!actualFiles.has(fileName)) {
					delete entry.qualities[q];
				}
				actualFiles.delete(fileName);
			}
		}
		if (!entry.qualities || Object.keys(entry.qualities).length === 0) {
			delete metaIndex.entries[contentId];
		}
	}

	for (const orphanFile of actualFiles) {
		try { fs.unlinkSync(path.join(cacheDir, orphanFile)); } catch (e) { }
	}
	recalculateStats();
	scheduleSave();
}

function recalculateStats() {
	let totalSize = 0, fileCount = 0;
	for (const entry of Object.values(metaIndex.entries)) {
		if (entry.qualities) {
			for (const q of ['0', '1', '9']) {
				if (entry.qualities[q]) {
					totalSize += entry.qualities[q].size || 0;
					fileCount++;
				}
			}
		}
	}
	metaIndex.stats.totalSize = totalSize;
	metaIndex.stats.fileCount = fileCount;
}

function scheduleSave() {
	isDirty = true;
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => saveToFile(), CACHE_CONFIG.SAVE_DEBOUNCE_MS);
}

function saveToFile() {
	if (!isDirty || !cacheDir || !metaIndex) return;
	const metaPath = path.join(cacheDir, 'meta.json');
	const tmpPath = path.join(cacheDir, 'meta.json.tmp');
	try {
		const content = JSON.stringify(metaIndex, null, 2);
		fs.writeFileSync(tmpPath, content, 'utf8');
		fs.renameSync(tmpPath, metaPath);
		isDirty = false;
	} catch (e) {
		logMessage(`Failed to save meta.json: ${e.message}`, "ERROR");
	}
}

function saveSync() {
	if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
	saveToFile();
}

function getCacheFilePath(contentId, quality) {
	return path.join(cacheDir, `${contentId}.${quality}`);
}

function findBestCache(contentId, requestedQuality) {
	if (!metaIndex || !metaIndex.entries[contentId]) return null;
	const entry = metaIndex.entries[contentId];
	if (!entry.qualities) return null;

	if (entry.qualities[requestedQuality]) {
		return { quality: requestedQuality, ...entry.qualities[requestedQuality], degraded: false };
	}
	const fallbackOrder = { '0': ['1', '9'], '1': ['0', '9'], '9': ['1', '0'] };
	for (const fallback of (fallbackOrder[requestedQuality] || [])) {
		if (entry.qualities[fallback]) {
			return { quality: fallback, ...entry.qualities[fallback], degraded: true };
		}
	}
	return null;
}

async function ensureCacheSpace(neededBytes) {
	if (!metaIndex) return;
	const currentSize = metaIndex.stats.totalSize;
	if (currentSize + neededBytes <= CACHE_CONFIG.MAX_DISK_CACHE_SIZE) return;

	const targetSize = CACHE_CONFIG.MAX_DISK_CACHE_SIZE * CACHE_CONFIG.CLEANUP_TARGET_RATIO;
	const bytesToFree = currentSize - targetSize + neededBytes;

	const entries = Object.entries(metaIndex.entries)
		.map(([id, e]) => {
			let size = 0;
			if (e.qualities) for (const q of ['0', '1', '9']) if (e.qualities[q]) size += e.qualities[q].size || 0;
			return { id, atime: e.atime || 0, size };
		})
		.sort((a, b) => a.atime - b.atime);

	let freed = 0;
	for (const entry of entries) {
		if (freed >= bytesToFree) break;
		for (const q of ['0', '1', '9']) {
			const filePath = getCacheFilePath(entry.id, q);
			try { fs.unlinkSync(filePath); } catch (e) { }
		}
		freed += entry.size;
		delete metaIndex.entries[entry.id];
	}
	metaIndex.stats.totalSize -= freed;
	metaIndex.stats.fileCount = Object.keys(metaIndex.entries).length;
	metaIndex.stats.lastCleanup = Date.now();
	scheduleSave();
}

function markAsBroken(contentId, reason) {
	if (!metaIndex) return;
	const broken = metaIndex.brokenFiles;
	if (broken[contentId]) {
		broken[contentId].attempts++;
		broken[contentId].time = Date.now();
		broken[contentId].reason = reason;
	} else {
		broken[contentId] = { reason, time: Date.now(), attempts: 1 };
	}
	scheduleSave();
}

function isBroken(contentId) {
	if (!metaIndex || !metaIndex.brokenFiles[contentId]) return false;
	const entry = metaIndex.brokenFiles[contentId];
	const now = Date.now();
	const expireMs = CACHE_CONFIG.BROKEN_RETRY_DAYS * 24 * 60 * 60 * 1000;
	if (now - entry.time > expireMs) {
		delete metaIndex.brokenFiles[contentId];
		scheduleSave();
		return false;
	}
	return entry.attempts >= CACHE_CONFIG.BROKEN_MAX_ATTEMPTS;
}

function updateAtime(contentId) {
	if (metaIndex && metaIndex.entries[contentId]) {
		metaIndex.entries[contentId].atime = Date.now();
		scheduleSave();
	}
}

// ==================== 日志工具 ====================
function ensureLogDir() {
	try {
		const dir = path.dirname(LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		return true;
	} catch (e) { return false; }
}

function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}`;
	outputChannel.appendLine(line);
	if (level === "ERROR" || level === "WARN") {
		if (ensureLogDir()) try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch (e) { }
	}
}

// ==================== 状态栏管理 ====================
function initStatusBar(context) {
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.command = 'qqq.showCacheStatus';
	context.subscriptions.push(statusBarItem);
	context.subscriptions.push(vscode.commands.registerCommand('qqq.showCacheStatus', showCacheStatusDetail));
	updateStatusBar();
	statusBarItem.show();

	// 每 30 秒更新一次状态栏
	setInterval(() => updateStatusBar(), 30000);
}

function updateStatusBar() {
	if (!statusBarItem) return;

	// 获取累计时长
	let totalSeconds = 0;
	if (globalExtensionContext) {
		totalSeconds = globalExtensionContext.globalState.get(KEY_TOTAL_DURATION, 0);
		const start = globalExtensionContext.globalState.get(KEY_SESSION_START);
		if (start) {
			totalSeconds += (Date.now() - start) / 1000;
		}
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const timeStr = `${hours}h${minutes}m`;

	// 获取缓存状态
	let cacheStr = "0MB";
	let hitRateStr = "100%";
	if (metaIndex && metaIndex.stats) {
		const sizeMB = (metaIndex.stats.totalSize / (1024 * 1024)).toFixed(1);
		cacheStr = `${sizeMB}MB`;
		const total = metaIndex.stats.hitCount + metaIndex.stats.missCount;
		if (total > 0) {
			const rate = Math.round((metaIndex.stats.hitCount / total) * 100);
			hitRateStr = `${rate}%`;
		}
	}

	// 引擎简写
	let engineShort = "JS";
	if (currentEngine.includes("Python")) engineShort = "Py";
	else if (currentEngine.includes("Rust")) engineShort = "Rs";
	else if (currentEngine.includes("Shell")) engineShort = "Sh";

	statusBarItem.text = `$(clock) ${timeStr} $(database) ${cacheStr} $(pulse) ${hitRateStr} $(gear) ${engineShort}`;
	statusBarItem.tooltip = `QQQ 状态\n累计使用: ${hours}小时${minutes}分钟\n磁盘缓存: ${cacheStr}/40MB\n命中率: ${hitRateStr}\n当前引擎: ${currentEngine}\n\n点击查看详情`;
}

function showCacheStatusDetail() {
	let totalSeconds = 0;
	if (globalExtensionContext) {
		totalSeconds = globalExtensionContext.globalState.get(KEY_TOTAL_DURATION, 0);
		const start = globalExtensionContext.globalState.get(KEY_SESSION_START);
		if (start) totalSeconds += (Date.now() - start) / 1000;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);

	let cacheInfo = "未初始化";
	if (metaIndex && metaIndex.stats) {
		const sizeMB = (metaIndex.stats.totalSize / (1024 * 1024)).toFixed(2);
		const pct = ((metaIndex.stats.totalSize / CACHE_CONFIG.MAX_DISK_CACHE_SIZE) * 100).toFixed(0);
		const total = metaIndex.stats.hitCount + metaIndex.stats.missCount;
		const hitRate = total > 0 ? ((metaIndex.stats.hitCount / total) * 100).toFixed(1) : '100.0';
		cacheInfo = `磁盘: ${sizeMB}MB / 40MB (${pct}%)\n缓存条目: ${Object.keys(metaIndex.entries).length}\n命中: ${metaIndex.stats.hitCount} / 未命中: ${metaIndex.stats.missCount} (${hitRate}%)`;
	}

	const msg = `📊 QQQ 状态详情\n${'─'.repeat(30)}\n⏱ 累计使用: ${hours}小时${minutes}分钟\n💾 ${cacheInfo}\n⚙ 当前引擎: ${currentEngine}`;
	vscode.window.showInformationMessage(msg, { modal: true });
}

function setCurrentEngine(engine) {
	currentEngine = engine;
	updateStatusBar();
}

// ==================== 用户时长统计 ====================
const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
const KEY_SESSION_START = "qqq_stats_session_start";

function initUserTracking(context) {
	context.globalState.update(KEY_SESSION_START, Date.now());
}

function finishUserTracking(context) {
	if (!context) return;
	const start = context.globalState.get(KEY_SESSION_START);
	if (start) {
		const now = Date.now();
		const diffSeconds = (now - start) / 1000;
		const oldTotal = context.globalState.get(KEY_TOTAL_DURATION, 0);
		context.globalState.update(KEY_TOTAL_DURATION, oldTotal + diffSeconds);
		context.globalState.update(KEY_SESSION_START, undefined);
	}
}

// ==================== 占位符 Token 管理 ====================
let tokenCounter = 0;

function createPendingToken() {
	const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
	let token = '';
	for (let i = 0; i < 8; i++) token += chars[Math.floor(Math.random() * chars.length)];
	token += (++tokenCounter).toString(36);
	return token;
}

// ==================== ★★★ Python Bridge (最高优先级) ★★★ ====================
class PythonBridge {
	constructor() {
		this.process = null;
		this.pending = new Map();
		this.requestId = 0;
		this.isStarting = false;
		this.startPromise = null;
		this.restartCount = 0;
		this.maxRestarts = 3;
		this.available = null;
		this.version = null;
	}

	async start() {
		if (this.process && !this.process.killed) return true;
		if (this.isStarting) return this.startPromise;
		this.isStarting = true;
		this.startPromise = this._doStart();
		try { return await this.startPromise; }
		finally { this.isStarting = false; this.startPromise = null; }
	}

	async _doStart() {
		return new Promise((resolve) => {
			const scriptPath = path.join(__dirname, "kp.py");
			if (!fs.existsSync(scriptPath)) {
				logMessage("kp.py not found, Python Bridge unavailable", "WARN");
				this.available = false;
				resolve(false);
				return;
			}
			try {
				this.process = cp.spawn("python", [scriptPath, "--daemon"], {
					stdio: ["pipe", "pipe", "pipe"], windowsHide: true
				});
				const rl = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
				rl.on("line", (line) => {
					try {
						const result = JSON.parse(line);
						const id = result._id;
						if (this.pending.has(id)) {
							const { resolve: res, timer } = this.pending.get(id);
							clearTimeout(timer);
							this.pending.delete(id);
							res(result);
						}
					} catch (e) { }
				});
				this.process.stderr.on("data", (data) => { logMessage(`Python stderr: ${data.toString()}`, "WARN"); });
				this.process.on("error", (err) => { logMessage(`Python process error: ${err}`, "ERROR"); this._handleCrash(); });
				this.process.on("close", (code) => { logMessage(`Python process closed: ${code}`, "WARN"); this._handleCrash(); });

				setTimeout(async () => {
					try {
						const pong = await this.call("ping", {}, 2000);
						if (pong && pong.status === "alive") {
							this.restartCount = 0;
							this.available = true;
							// 获取 Python 版本
							this._detectVersion();
							logMessage("Python Bridge started", "INFO");
							resolve(true);
						} else { this.available = false; resolve(false); }
					} catch (e) { this.available = false; resolve(false); }
				}, 100);
			} catch (e) {
				logMessage(`Python spawn error: ${e}`, "ERROR");
				this.available = false;
				resolve(false);
			}
		});
	}

	_detectVersion() {
		cp.exec("python --version", { windowsHide: true }, (err, stdout, stderr) => {
			if (!err) {
				const match = (stdout || stderr).match(/Python\s+([\d.]+)/i);
				if (match) this.version = match[1];
			}
		});
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
			logMessage(`Python Bridge restart ${this.restartCount}/${this.maxRestarts}`, "WARN");
			setTimeout(() => this.start(), 500);
		} else { this.available = false; }
	}

	async call(action, params = {}, timeout = 5000) {
		if (this.available === false) return { error: "python_not_available" };
		if (!this.process || this.process.killed) {
			const started = await this.start();
			if (!started) return { error: "python_not_available" };
		}
		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) { this.pending.delete(id); resolve({ error: "timeout" }); }
			}, timeout);
			this.pending.set(id, { resolve, timer });
			try { this.process.stdin.write(cmd); }
			catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ error: "write_error" }); }
		});
	}

	async identify(filePath) { return this.call("identify", { path: filePath }); }
	async getFolderInfo(folderPath) { return this.call("folder_info", { path: folderPath }, 15000); }
	async handleClipboard(targetDir) { return this.call("clipboard", { target_dir: targetDir }, 10000); }
	async runFFmpeg(args, timeout = 30000) { return this.call("ffmpeg", { args }, timeout); }
	isAvailable() { return this.available === true; }
	getVersionString() { return this.version ? `Python ${this.version}` : "Python"; }
	stop() { if (this.process && !this.process.killed) { try { this.process.kill(); } catch (e) { } this.process = null; } }
}

const pythonBridge = new PythonBridge();

// ==================== ★★★ Rust Bridge ★★★ ====================
class RustBridge {
	constructor() {
		this.process = null;
		this.pending = new Map();
		this.requestId = 0;
		this.isStarting = false;
		this.startPromise = null;
		this.restartCount = 0;
		this.maxRestarts = 3;
		this.exePath = null;
		this.available = null;
		this.version = null;
	}

	_getExePath() {
		if (this.exePath) return this.exePath;
		const platform = process.platform;
		const arch = process.arch;
		let filename;
		if (platform === 'win32') filename = arch === 'arm64' ? 'q_win_arm64.exe' : 'q_win_x64.exe';
		else if (platform === 'darwin') filename = arch === 'arm64' ? 'q_mac_arm64' : 'q_mac_x64';
		else filename = arch === 'arm64' ? 'q_linux_arm64' : 'q_linux_x64';
		const candidates = [
			path.join(__dirname, '..', 'assets', filename),
			path.join(__dirname, 'assets', filename),
			path.join(__dirname, filename),
		];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) { this.exePath = candidate; return this.exePath; }
		}
		return null;
	}

	async start() {
		if (this.process && !this.process.killed) return true;
		if (this.isStarting) return this.startPromise;
		this.isStarting = true;
		this.startPromise = this._doStart();
		try { return await this.startPromise; }
		finally { this.isStarting = false; this.startPromise = null; }
	}

	async _doStart() {
		return new Promise((resolve) => {
			const exePath = this._getExePath();
			if (!exePath) { logMessage("Rust daemon not found, falling back", "WARN"); this.available = false; resolve(false); return; }
			try {
				this.process = cp.spawn(exePath, ["--daemon"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
				const rl = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
				rl.on("line", (line) => {
					try {
						const result = JSON.parse(line);
						const id = result._id;
						if (this.pending.has(id)) {
							const { resolve: res, timer } = this.pending.get(id);
							clearTimeout(timer);
							this.pending.delete(id);
							res(result);
						}
					} catch (e) { }
				});
				this.process.stderr.on("data", (data) => { logMessage(`Rust stderr: ${data.toString()}`, "WARN"); });
				this.process.on("error", (err) => { logMessage(`Rust process error: ${err}`, "ERROR"); this._handleCrash(); });
				this.process.on("close", (code) => { logMessage(`Rust process closed: ${code}`, "WARN"); this._handleCrash(); });

				setTimeout(async () => {
					try {
						const pong = await this.call("ping", {}, 2000);
						if (pong && pong.status === "alive") {
							this.restartCount = 0;
							this.available = true;
							this.version = pong.version || "1.0";
							logMessage("Rust Bridge started", "INFO");
							resolve(true);
						} else { this.available = false; resolve(false); }
					} catch (e) { this.available = false; resolve(false); }
				}, 100);
			} catch (e) { logMessage(`Rust spawn error: ${e}`, "ERROR"); this.available = false; resolve(false); }
		});
	}

	_handleCrash() {
		this.process = null;
		for (const [id, { resolve, timer }] of this.pending) { clearTimeout(timer); resolve({ error: "process_crashed" }); }
		this.pending.clear();
		if (this.restartCount < this.maxRestarts) { this.restartCount++; logMessage(`Rust Bridge restart ${this.restartCount}/${this.maxRestarts}`, "WARN"); setTimeout(() => this.start(), 500); }
		else { this.available = false; }
	}

	async call(action, params = {}, timeout = 5000) {
		if (this.available === false) return { error: "rust_not_available" };
		if (!this.process || this.process.killed) { const started = await this.start(); if (!started) return { error: "rust_not_available" }; }
		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";
		return new Promise((resolve) => {
			const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ error: "timeout" }); } }, timeout);
			this.pending.set(id, { resolve, timer });
			try { this.process.stdin.write(cmd); }
			catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ error: "write_error" }); }
		});
	}

	async identify(filePath) { return this.call("identify", { path: filePath }); }
	async getFolderInfo(folderPath) { return this.call("folder_info", { path: folderPath }, 15000); }
	async handleClipboard(targetDir) { return this.call("clipboard", { target_dir: targetDir }, 10000); }
	async runFFmpeg(args, timeout = 30000) { return this.call("ffmpeg", { args }, timeout); }
	isAvailable() { return this.available === true; }
	getVersionString() { return this.version ? `Rust ${this.version}` : "Rust"; }
	stop() { if (this.process && !this.process.killed) { try { this.process.kill(); } catch (e) { } this.process = null; } }
}

const rustBridge = new RustBridge();

// ==================== ★★★ 常驻 Shell Bridge ★★★ ====================
class ShellBridge {
	constructor() {
		this.process = null;
		this.pending = new Map();
		this.requestId = 0;
		this.isStarting = false;
		this.startPromise = null;
		this.available = null;
		this.platform = process.platform;
	}

	async start() {
		if (this.process && !this.process.killed) return true;
		if (this.isStarting) return this.startPromise;
		this.isStarting = true;
		this.startPromise = this._doStart();
		try { return await this.startPromise; }
		finally { this.isStarting = false; this.startPromise = null; }
	}

	async _doStart() {
		if (this.platform === 'win32') return this._startPowerShell();
		else if (this.platform === 'darwin') return this._startMacDaemon();
		else return this._startLinuxDaemon();
	}

	async _startPowerShell() {
		return new Promise((resolve) => {
			const psScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Process-Command { param($cmd)
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
while ($true) { $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }
    try { $cmd = ConvertFrom-Json $line; $result = Process-Command $cmd; $result | ConvertTo-Json -Compress | Write-Host }
    catch { @{ _id = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress | Write-Host }
}`;
			try {
				this.process = cp.spawn('powershell', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
				this._setupProcessHandlers(resolve);
			} catch (e) { this.available = false; resolve(false); }
		});
	}

	async _startMacDaemon() {
		return new Promise((resolve) => {
			const bashScript = `#!/bin/bash
while IFS= read -r line; do
    action=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null)
    id=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('_id',0))" 2>/dev/null)
    case "$action" in
        ping) echo '{"_id":'$id',"status":"alive"}' ;;
        hasImage) if pngpaste - >/dev/null 2>&1; then echo '{"_id":'$id',"value":true}'; else echo '{"_id":'$id',"value":false}'; fi ;;
        saveImage) dest=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('path',''))" 2>/dev/null); if pngpaste "$dest" 2>/dev/null; then echo '{"_id":'$id',"success":true}'; else echo '{"_id":'$id',"success":false}'; fi ;;
        *) echo '{"_id":'$id',"error":"unknown action"}' ;;
    esac
done`;
			try { this.process = cp.spawn('bash', ['-c', bashScript], { stdio: ['pipe', 'pipe', 'pipe'] }); this._setupProcessHandlers(resolve); }
			catch (e) { this.available = false; resolve(false); }
		});
	}

	async _startLinuxDaemon() {
		return new Promise((resolve) => {
			const bashScript = `#!/bin/bash
while IFS= read -r line; do
    action=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null)
    id=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('_id',0))" 2>/dev/null)
    case "$action" in
        ping) echo '{"_id":'$id',"status":"alive"}' ;;
        hasImage) if xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -q "image/png"; then echo '{"_id":'$id',"value":true}'; else echo '{"_id":'$id',"value":false}'; fi ;;
        saveImage) dest=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('path',''))" 2>/dev/null); if xclip -selection clipboard -t image/png -o > "$dest" 2>/dev/null && [ -s "$dest" ]; then echo '{"_id":'$id',"success":true}'; else echo '{"_id":'$id',"success":false}'; fi ;;
        *) echo '{"_id":'$id',"error":"unknown action"}' ;;
    esac
done`;
			try { this.process = cp.spawn('bash', ['-c', bashScript], { stdio: ['pipe', 'pipe', 'pipe'] }); this._setupProcessHandlers(resolve); }
			catch (e) { this.available = false; resolve(false); }
		});
	}

	_setupProcessHandlers(resolve) {
		const rl = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
		rl.on('line', (line) => {
			try {
				const result = JSON.parse(line);
				const id = result._id;
				if (this.pending.has(id)) {
					const { resolve: res, timer } = this.pending.get(id);
					clearTimeout(timer);
					this.pending.delete(id);
					res(result);
				}
			} catch (e) { }
		});
		this.process.on('error', () => { this.available = false; this.process = null; });
		this.process.on('close', () => { this.process = null; });

		setTimeout(async () => {
			try {
				const pong = await this.call('ping', {}, 3000);
				if (pong && pong.status === 'alive') { this.available = true; logMessage(`Shell Bridge (${this.platform}) started`, "INFO"); resolve(true); }
				else { this.available = false; resolve(false); }
			} catch (e) { this.available = false; resolve(false); }
		}, 500);
	}

	async call(action, params = {}, timeout = 5000) {
		if (this.available === false) return { error: "shell_not_available" };
		if (!this.process || this.process.killed) { const started = await this.start(); if (!started) return { error: "shell_not_available" }; }
		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";
		return new Promise((resolve) => {
			const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ error: "timeout" }); } }, timeout);
			this.pending.set(id, { resolve, timer });
			try { this.process.stdin.write(cmd); }
			catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ error: "write_error" }); }
		});
	}

	async hasImage() { const result = await this.call('hasImage', {}, 2000); return result.value === true; }
	async hasFiles() { const result = await this.call('hasFiles', {}, 2000); return result.value === true; }
	async getFiles() { const result = await this.call('getFiles', {}, 3000); return result.files || []; }
	async saveImage(destPath) { const result = await this.call('saveImage', { path: destPath }, 5000); return result.success === true; }
	isAvailable() { return this.available === true; }
	getVersionString() { return this.platform === 'win32' ? "PowerShell" : "Shell"; }
	stop() { if (this.process && !this.process.killed) { try { this.process.kill(); } catch (e) { } this.process = null; } }
}

const shellBridge = new ShellBridge();

// ==================== 媒体文件识别 ====================
const SIGNATURES = [
	{ sig: [0x89, 0x50, 0x4E, 0x47], ext: '.png', type: 'image' },
	{ sig: [0xFF, 0xD8, 0xFF], ext: '.jpg', type: 'image' },
	{ sig: [0x47, 0x49, 0x46, 0x38], ext: '.gif', type: 'gif' },
	{ sig: [0x42, 0x4D], ext: '.bmp', type: 'image' },
	{ sig: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x57, 0x45, 0x42, 0x50], ext: '.webp', type: 'image' },
	{ sig: [0x00, 0x00, 0x01, 0x00], ext: '.ico', type: 'image' },
	{ sig: [0x1A, 0x45, 0xDF, 0xA3], ext: '.mkv', type: 'video' },
];

function identifyBySignature(buffer) {
	for (const s of SIGNATURES) {
		const offset = s.offset || 0;
		const sig = s.match || s.sig;
		if (buffer.length >= offset + sig.length) {
			let match = true;
			for (let i = 0; i < sig.length; i++) { if (buffer[offset + i] !== sig[i]) { match = false; break; } }
			if (match) return { ext: s.ext, type: s.type };
		}
	}
	if (buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return { ext: '.mp4', type: 'video' };
	return null;
}

async function probeFile(filePath) {
	if (!ffmpegPath) return null;
	return new Promise(resolve => {
		const child = cp.spawn(ffmpegPath, ["-hide_banner", "-i", filePath], { windowsHide: true });
		let stderr = "";
		child.stderr.on("data", d => { if (stderr.length < 50000) stderr += d.toString(); });
		child.on("close", () => {
			const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
			const codecMatch = /Stream.*Video:\s*(.*?)(?:,|$)/i.exec(stderr);
			const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);
			let info = { width: null, height: null, codec: null, codec_long_name: null, duration: 0, type: 'video' };
			if (resMatch) { info.width = parseInt(resMatch[1]); info.height = parseInt(resMatch[2]); }
			if (codecMatch && codecMatch[1]) {
				const codecParts = codecMatch[1].split(/[,\s]+/);
				info.codec = codecParts[0].trim();
				if (codecParts.length > 1) info.codec_long_name = codecMatch[1].trim();
			}
			if (durMatch) {
				const h = parseFloat(durMatch[1]), m = parseFloat(durMatch[2]), s = parseFloat(durMatch[3]);
				info.duration = h * 3600 + m * 60 + s;
			}
			if (info.codec) {
				const c = info.codec.toLowerCase();
				if (c.includes('png') || c.includes('bmp') || c.includes('tiff') || c.includes('jpeg')) { info.type = 'image'; info.duration = 0; }
				else if (c.includes('gif')) { info.type = (info.duration > 0.1) ? 'animated_image' : 'image'; }
				else if (c.includes('webp')) { info.type = (info.duration > 0.1) ? 'animated_image' : 'image'; }
				else if (c.includes('mjpeg')) { if (info.duration <= 0.1) { info.type = 'image'; info.duration = 0; } else { info.type = 'video'; } }
			}
			if (!info.width && stderr.includes("Audio:")) info.type = 'audio';
			resolve(info);
		});
		child.on("error", () => resolve(null));
		setTimeout(() => { try { child.kill(); } catch { } }, 5000);
	});
}

async function identifyFile(filePath) {
	if (!fs.existsSync(filePath)) return { error: "file_not_found" };

	if (pythonBridge.isAvailable()) {
		const result = await pythonBridge.identify(filePath);
		if (!result.error) return result;
	}
	if (rustBridge.isAvailable()) {
		const result = await rustBridge.identify(filePath);
		if (!result.error) return result;
	}

	let info = { type: 'unknown', ext: path.extname(filePath).toLowerCase() };
	try {
		const fd = fs.openSync(filePath, 'r');
		const buffer = Buffer.alloc(32);
		fs.readSync(fd, buffer, 0, 32, 0);
		fs.closeSync(fd);
		const res = identifyBySignature(buffer);
		if (res) info = { ...info, ...res };
	} catch (e) { }

	if (['video', 'image', 'gif', 'audio', 'unknown'].includes(info.type)) {
		const ff = await probeFile(filePath);
		if (ff && (ff.width || ff.duration > 0)) info = { ...info, ...ff };
	}
	return info;
}

// ==================== 文件夹统计 ====================
async function getFolderInfo(folderPath) {
	if (pythonBridge.isAvailable()) {
		const result = await pythonBridge.getFolderInfo(folderPath);
		if (!result.error) return result;
	}
	if (rustBridge.isAvailable()) {
		const result = await rustBridge.getFolderInfo(folderPath);
		if (!result.error) return result;
	}

	if (!fs.existsSync(folderPath)) return { error: "not_found" };
	let totalSize = 0, fileCount = 0;
	const extStats = {};

	async function walk(dir) {
		try {
			const files = await fs.promises.readdir(dir, { withFileTypes: true });
			for (const file of files) {
				const fullPath = path.join(dir, file.name);
				if (file.isDirectory()) { await walk(fullPath); }
				else {
					try {
						const stats = await fs.promises.stat(fullPath);
						totalSize += stats.size;
						fileCount++;
						const ext = path.extname(file.name).toLowerCase().replace('.', '') || 'no_ext';
						extStats[ext] = (extStats[ext] || 0) + 1;
					} catch (e) { }
				}
			}
		} catch (e) { }
	}
	await walk(folderPath);
	return { success: true, total_size: totalSize, file_count_root: fileCount, ext_stats: extStats };
}

// ==================== 文件名生成 ====================
function getTimestampFilename(ext) {
	const now = new Date();
	const datePart = now.toISOString().slice(0, 10).replace(/-/g, '.');
	const timePart = now.toTimeString().slice(0, 8).replace(/:/g, '.');
	const day = now.getDay() || 7;
	const ms = String(now.getMilliseconds()).padStart(3, '0');
	const excludedChars = ['l', 'i', 's', 'a', 'm', 'c', 'b', 'f', 't'];
	const validChars = 'abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(c => !excludedChars.includes(c.toLowerCase()));
	const firstChar = validChars[Math.floor(Math.random() * validChars.length)];
	let secondChar = validChars[Math.floor(Math.random() * validChars.length)];
	if (firstChar.toLowerCase() === 'g') {
		const withoutG = validChars.filter(c => c.toLowerCase() !== 'g');
		secondChar = withoutG[Math.floor(Math.random() * withoutG.length)];
	}
	return `${ms}${firstChar}${secondChar}.  ${datePart} [${day}] ${timePart}${ext}`;
}

function isImageExtForClipboard(ext) {
	return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif'].includes(ext.toLowerCase());
}

// ==================== ★★★ Fast Path：纯文字粘贴 ★★★ ====================
async function handleClipboardFast() {
	try {
		const text = await vscode.env.clipboard.readText();
		if (text && text.trim()) return { type: "text", text: text };
	} catch (e) { }
	return null;
}

// ==================== ★★★ Slow Path：媒体处理（四级回退）★★★ ====================
async function handleClipboardSlow(targetDir) {
	if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

	if (pythonBridge.isAvailable()) {
		const result = await pythonBridge.handleClipboard(targetDir);
		if (!result.error && result.type !== 'unknown') return result;
		logMessage("Python clipboard failed, falling back to Rust", "WARN");
	}
	if (rustBridge.isAvailable()) {
		const result = await rustBridge.handleClipboard(targetDir);
		if (!result.error && result.type !== 'unknown') return result;
		logMessage("Rust clipboard failed, falling back to Shell", "WARN");
	}
	if (shellBridge.isAvailable()) {
		try {
			const platform = process.platform;
			if (platform === 'win32') {
				const hasFiles = await shellBridge.hasFiles();
				if (hasFiles) {
					const files = await shellBridge.getFiles();
					if (files.length > 0) {
						const folders = files.filter(f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
						if (folders.length > 0) return { type: "folder_text", text: folders.join('\n') };
						const copied = [];
						for (const f of files) {
							try {
								const ext = path.extname(f);
								const isImg = isImageExtForClipboard(ext);
								const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
								const dest = path.join(targetDir, fname);
								fs.copyFileSync(f, dest);
								copied.push(dest);
							} catch (e) { logMessage(`复制文件失败: ${f} - ${e.message}`, "WARN"); }
						}
						if (copied.length === 1 && isImageExtForClipboard(path.extname(copied[0]))) return { type: "image", path: copied[0] };
						if (copied.length > 0) return { type: "file", files: copied };
					}
				}
			}
			const hasImg = await shellBridge.hasImage();
			if (hasImg) {
				const fname = getTimestampFilename(".png");
				const dest = path.join(targetDir, fname);
				const saved = await shellBridge.saveImage(dest);
				if (saved && fs.existsSync(dest) && fs.statSync(dest).size > 0) return { type: "image", path: dest };
			}
			logMessage("Shell clipboard failed, falling back to spawn", "WARN");
		} catch (e) { logMessage(`Shell clipboard error: ${e.message}`, "WARN"); }
	}
	return handleClipboardSlowFallback(targetDir);
}

async function handleClipboardSlowFallback(targetDir) {
	const platform = process.platform;
	if (platform === 'win32') {
		const hasFiles = await new Promise(resolve => {
			const child = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsFileDropList()){"1"}else{"0"}'], { windowsHide: true });
			let output = '';
			child.stdout.on('data', d => output += d.toString().trim());
			child.on('close', () => resolve(output === '1'));
			child.on('error', () => resolve(false));
			setTimeout(() => { try { child.kill(); } catch { } resolve(false); }, 3000);
		});
		if (hasFiles) {
			const files = await new Promise(resolve => {
				const child = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetFileDropList();if($f){foreach($i in $f){$i}}`], { windowsHide: true });
				let output = '';
				child.stdout.on('data', d => output += d.toString());
				child.on('close', () => { const list = output.split(/\r?\n/).map(s => s.trim()).filter(s => s && fs.existsSync(s)); resolve(list); });
				child.on('error', () => resolve([]));
				setTimeout(() => { try { child.kill(); } catch { } resolve([]); }, 5000);
			});
			if (files.length > 0) {
				const folders = files.filter(f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
				if (folders.length > 0) return { type: "folder_text", text: folders.join('\n') };
				const copied = [];
				for (const f of files) {
					try {
						const ext = path.extname(f);
						const isImg = isImageExtForClipboard(ext);
						const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
						const dest = path.join(targetDir, fname);
						fs.copyFileSync(f, dest);
						copied.push(dest);
					} catch (e) { logMessage(`复制文件失败: ${f} - ${e.message}`, "WARN"); }
				}
				if (copied.length === 1 && isImageExtForClipboard(path.extname(copied[0]))) return { type: "image", path: copied[0] };
				if (copied.length > 0) return { type: "file", files: copied };
			}
		}
		const hasImg = await new Promise(resolve => {
			const child = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsImage()){"1"}else{"0"}'], { windowsHide: true });
			let output = '';
			child.stdout.on('data', d => output += d.toString().trim());
			child.on('close', () => resolve(output === '1'));
			child.on('error', () => resolve(false));
			setTimeout(() => { try { child.kill(); } catch { } resolve(false); }, 3000);
		});
		if (hasImg) {
			const fname = getTimestampFilename(".png");
			const dest = path.join(targetDir, fname);
			const escapedPath = dest.replace(/'/g, "''");
			const saved = await new Promise(resolve => {
				const child = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Add-Type -A System.Windows.Forms;Add-Type -A System.Drawing;$img=[System.Windows.Forms.Clipboard]::GetImage();if($img){$img.Save('${escapedPath}',[System.Drawing.Imaging.ImageFormat]::Png);'OK'}else{'FAIL'}`], { windowsHide: true });
				let output = '';
				child.stdout.on('data', d => output += d.toString().trim());
				child.on('close', () => resolve(output.includes('OK')));
				child.on('error', () => resolve(false));
				setTimeout(() => { try { child.kill(); } catch { } resolve(false); }, 8000);
			});
			if (saved && fs.existsSync(dest) && fs.statSync(dest).size > 0) return { type: "image", path: dest };
		}
		return { type: "unknown" };
	} else if (platform === 'darwin') {
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);
		const imgResult = await new Promise(resolve => {
			cp.exec(`which pngpaste && pngpaste "${dest}" 2>/dev/null`, (err) => {
				if (!err && fs.existsSync(dest) && fs.statSync(dest).size > 0) resolve({ type: "image", path: dest });
				else {
					cp.exec(`pbpaste -Prefer png > "${dest}" 2>/dev/null`, (err2) => {
						if (!err2 && fs.existsSync(dest) && fs.statSync(dest).size > 0) resolve({ type: "image", path: dest });
						else { if (fs.existsSync(dest)) try { fs.unlinkSync(dest); } catch { } resolve(null); }
					});
				}
			});
		});
		if (imgResult) return imgResult;
		return { type: "unknown" };
	} else {
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);
		const imgResult = await new Promise(resolve => {
			cp.exec(`xclip -selection clipboard -t image/png -o > "${dest}" 2>/dev/null`, (err) => {
				if (!err && fs.existsSync(dest) && fs.statSync(dest).size > 0) resolve({ type: "image", path: dest });
				else { if (fs.existsSync(dest)) try { fs.unlinkSync(dest); } catch { } resolve(null); }
			});
		});
		if (imgResult) return imgResult;
		return { type: "unknown" };
	}
}

async function handleClipboard(targetDir) {
	const fast = await handleClipboardFast();
	if (fast) return fast;
	return handleClipboardSlow(targetDir);
}

// ==================== ★★★ 四层回退 FFmpeg 执行器 ★★★ ====================
async function executeFFmpeg(args) {
	if (pythonBridge.isAvailable()) {
		try {
			const result = await pythonBridge.runFFmpeg(args, CACHE_CONFIG.FFMPEG_TIMEOUT_MS);
			if (result.success) return true;
		} catch (e) { logMessage('[FFmpeg] Python daemon failed, trying next', "WARN"); }
	}
	if (rustBridge.isAvailable()) {
		try {
			const result = await rustBridge.runFFmpeg(args, CACHE_CONFIG.FFMPEG_TIMEOUT_MS);
			if (result.success) return true;
		} catch (e) { logMessage('[FFmpeg] Rust daemon failed, trying next', "WARN"); }
	}

	return new Promise((resolve) => {
		const proc = cp.spawn(ffmpegPath || 'ffmpeg', args, { windowsHide: true });
		proc.on('close', (code) => resolve(code === 0));
		proc.on('error', (e) => { logMessage(`[FFmpeg] Spawn error: ${e}`, "ERROR"); resolve(false); });
		setTimeout(() => { try { proc.kill(); } catch { } resolve(false); }, CACHE_CONFIG.FFMPEG_TIMEOUT_MS);
	});
}

// ==================== 公共工具函数 ====================
function isLikelyBinary(filePath) {
	const binaryExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".zip", ".tar", ".gz", ".7z", ".rar", ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
	const ext = path.extname(filePath).toLowerCase();
	if (binaryExts.has(ext)) return true;
	try {
		const buffer = Buffer.alloc(4096);
		const fd = fs.openSync(filePath, "r");
		try {
			const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
			if (bytesRead === 0) return false;
			for (let i = 0; i < bytesRead; i++) { if (buffer[i] === 0) return true; }
			return false;
		} finally { fs.closeSync(fd); }
	} catch (e) { return true; }
}

function shouldShowDuration(info) {
	if (!info) return false;
	return (info.type === "video" || info.type === "animated_image") && info.duration > 0.1;
}

// ==================== qqq.pure 命令 ====================
async function pureCommand() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showInformationMessage("请先打开一个文件以确定工作目录"); return; }
	const currentDocPath = editor.document.uri.fsPath;
	const parentDir = path.dirname(currentDocPath);
	const qqqDir = path.join(parentDir, "qqq");
	if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) { vscode.window.showInformationMessage("当前目录下没有 qqq 文件夹"); return; }

	let qqqFiles = [];
	try { qqqFiles = fs.readdirSync(qqqDir).filter((f) => { const fullPath = path.join(qqqDir, f); return fs.statSync(fullPath).isFile(); }); }
	catch (e) { vscode.window.showErrorMessage("读取 qqq 目录失败: " + e.message); return; }
	if (qqqFiles.length === 0) { vscode.window.showInformationMessage("qqq 文件夹是空的"); return; }

	const referencedFiles = new Set();
	let parentDirFiles = [];
	try { parentDirFiles = fs.readdirSync(parentDir); } catch (e) { vscode.window.showErrorMessage("读取当前目录失败: " + e.message); return; }
	const regex = new RegExp(QQQ_PATH_REGEX);

	for (const fileName of parentDirFiles) {
		const fullPath = path.join(parentDir, fileName);
		if (fileName === "qqq" || fileName === "qqq.pure") continue;
		let stats;
		try { stats = fs.statSync(fullPath); } catch (e) { continue; }
		if (!stats.isFile()) continue;
		if (isLikelyBinary(fullPath)) continue;
		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			let match;
			regex.lastIndex = 0;
			while ((match = regex.exec(content)) !== null) {
				const rawPath = match[0].slice(2, -2).trim();
				let absRefPath = rawPath;
				if (!path.isAbsolute(rawPath)) absRefPath = path.join(parentDir, rawPath);
				absRefPath = absRefPath.replace(/\//g, "\\");
				if (absRefPath.toLowerCase().startsWith(qqqDir.toLowerCase())) {
					const refFileName = path.basename(absRefPath);
					referencedFiles.add(refFileName.toLowerCase());
				}
			}
		} catch (e) { }
	}

	const orphans = qqqFiles.filter((f) => !referencedFiles.has(f.toLowerCase()));
	if (orphans.length === 0) { vscode.window.showInformationMessage("未发现孤儿文件"); return; }
	const orphanPaths = orphans.map((f) => path.join(qqqDir, f));
	let commandStr = "";
	if (os.platform() === "win32") { const args = orphanPaths.map((p) => `"${p}"`).join(" "); commandStr = `del ${args}`; }
	else { const args = orphanPaths.map((p) => `"${p}"`).join(" "); commandStr = `rm ${args}`; }

	let content = "\n".repeat(13);
	content += "   请在终端中执行下面命令以删除未引用的文件：\n";
	content += "\n".repeat(3);
	content += "   " + commandStr + "\n";
	content += "\n".repeat(3);
	content += orphanPaths.map((p) => `/\\${p}\\/`).join("\n\n\n\n\n");

	const purePath = path.join(parentDir, "qqq.pure");
	try {
		fs.writeFileSync(purePath, content, "utf-8");
		const doc = await vscode.workspace.openTextDocument(purePath);
		await vscode.window.showTextDocument(doc);
	} catch (e) { vscode.window.showErrorMessage("无法生成 qqq.pure 文件: " + e.message); }
}

// ==================== 预览缓存核心API ====================
async function getPreview(filePath, quality = '1') {
	if (!metaIndex) return null;
	try {
		const stat = fs.statSync(filePath);
		const mtime = stat.mtimeMs;

		const pathEntry = pathMap.get(filePath);
		let contentId;
		if (pathEntry && pathEntry.mtime === mtime) {
			contentId = pathEntry.contentId;
		} else {
			contentId = computeContentId(filePath);
			if (!contentId) return null;
			pathMap.set(filePath, { contentId, mtime });
		}

		if (isBroken(contentId)) return null;

		const memEntry = memCache.get(contentId);
		if (memEntry && (memEntry.quality === quality || memEntry.quality === 'fast')) {
			metaIndex.stats.hitCount++;
			updateAtime(contentId);
			updateStatusBar();
			return { base64: memEntry.base64, meta: memEntry.meta, degraded: memEntry.quality !== quality };
		}

		const cacheResult = findBestCache(contentId, quality);
		if (cacheResult) {
			metaIndex.stats.hitCount++;
			const cachePath = getCacheFilePath(contentId, cacheResult.quality);
			const buffer = fs.readFileSync(cachePath);
			const mimeType = cacheResult.format === 'jpg' ? 'image/jpeg' : 'image/webp';
			const base64 = `data:${mimeType};base64,${buffer.toString('base64')}`;
			const meta = metaIndex.entries[contentId].meta;
			memCache.set(contentId, { base64, quality: cacheResult.quality, meta });
			updateAtime(contentId);
			updateStatusBar();
			return { base64, meta, degraded: cacheResult.degraded };
		}

		metaIndex.stats.missCount++;
		updateStatusBar();
		return await getOrCreateTask(contentId, async () => {
			return await generatePreview(filePath, contentId, quality);
		});
	} catch (e) {
		logMessage(`[Cache] getPreview error: ${e.message}`, "ERROR");
		return null;
	}
}

async function getOrCreateTask(contentId, taskFactory) {
	if (pendingTasks.has(contentId)) return pendingTasks.get(contentId);
	const taskPromise = (async () => {
		try { return await taskFactory(); }
		finally { pendingTasks.delete(contentId); }
	})();
	pendingTasks.set(contentId, taskPromise);
	return taskPromise;
}

async function generatePreview(filePath, contentId, quality) {
	const probeResult = await taskQueue.run(() => identifyFile(filePath));
	if (!probeResult || probeResult.error) { markAsBroken(contentId, 'probe_failed'); return null; }

	const { width, height, duration, codec, type } = probeResult;
	const ext = path.extname(filePath).slice(1).toLowerCase();
	const isSmall = width <= CACHE_CONFIG.FRAME_WIDTH && height <= CACHE_CONFIG.FRAME_HEIGHT;
	const isLarge = !isSmall;
	const isWebSafe = WEB_SAFE_FORMATS.has(ext);
	const hasAlpha = ALPHA_CAPABLE_FORMATS.has(ext);
	const isVideo = type === 'video';
	const isAnimated = type === 'animated_image' || type === 'gif';

	if (isSmall && isWebSafe && !isVideo && !isAnimated) {
		return await handleFastLane(filePath, contentId, { width, height, type, duration, hasAlpha });
	}
	return await handleSlowLane(filePath, contentId, quality, { width, height, duration, codec, type, ext, isSmall, isLarge, isWebSafe, hasAlpha, isVideo, isAnimated });
}

async function handleFastLane(filePath, contentId, meta) {
	try {
		const buffer = fs.readFileSync(filePath);
		const ext = path.extname(filePath).slice(1).toLowerCase();
		const mimeMap = { 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp', 'avif': 'image/avif', 'svg': 'image/svg+xml' };
		const mimeType = mimeMap[ext] || 'application/octet-stream';
		let gifDur = 0;
		if (ext === 'gif') gifDur = getGifDurationFromBuffer(buffer);
		const base64 = `data:${mimeType};base64,${buffer.toString('base64')}`;
		const fullMeta = { ...meta, gifDur, srcDuration: meta.duration || 0 };
		memCache.set(contentId, { base64, quality: 'fast', meta: fullMeta });
		return { base64, meta: fullMeta, fastLane: true };
	} catch (e) { logMessage(`[Cache] Fast lane error: ${e.message}`, "ERROR"); return null; }
}

async function handleSlowLane(filePath, contentId, quality, info) {
	const { width, height, duration, ext, isSmall, isLarge, hasAlpha, isVideo, isAnimated } = info;
	try {
		let outputFormat;
		if (isVideo) outputFormat = (quality === '9') ? 'jpg' : 'webp';
		else if (isAnimated) outputFormat = 'webp';
		else outputFormat = hasAlpha ? 'webp' : 'jpg';

		// ★★★ 修复：临时文件加上正确扩展名 ★★★
		const outputExt = outputFormat === 'jpg' ? '.jpg' : '.webp';
		const tempPath = path.join(cacheDir, `${contentId}.${quality}.tmp${outputExt}`);
		const finalPath = getCacheFilePath(contentId, quality);
		const args = buildFFmpegArgs(filePath, tempPath, quality, info, outputFormat);

		const success = await taskQueue.run(() => executeFFmpeg(args));
		if (!success) { markAsBroken(contentId, 'ffmpeg_failed'); return null; }
		if (!fs.existsSync(tempPath)) { markAsBroken(contentId, 'output_missing'); return null; }

		const outputStat = fs.statSync(tempPath);
		const outputSize = outputStat.size;
		await ensureCacheSpace(outputSize);
		fs.renameSync(tempPath, finalPath);

		const buffer = fs.readFileSync(finalPath);
		const mimeType = outputFormat === 'jpg' ? 'image/jpeg' : 'image/webp';
		const base64 = `data:${mimeType};base64,${buffer.toString('base64')}`;

		let gifDur = 0;
		if (outputFormat === 'webp' && (isVideo || isAnimated) && quality !== '9') {
			gifDur = getWebPDurationFromBuffer(buffer);
		}

		const meta = { width, height, type: isVideo ? 'video' : (isAnimated ? 'animated_image' : 'image'), gifDur, srcDuration: duration || 0, hasAlpha };
		if (!metaIndex.entries[contentId]) metaIndex.entries[contentId] = { qualities: {}, atime: Date.now(), meta };
		metaIndex.entries[contentId].qualities[quality] = { size: outputSize, format: outputFormat };
		metaIndex.entries[contentId].atime = Date.now();
		metaIndex.stats.totalSize += outputSize;
		metaIndex.stats.fileCount++;
		scheduleSave();
		memCache.set(contentId, { base64, quality, meta });
		updateStatusBar();
		return { base64, meta };
	} catch (e) { logMessage(`[Cache] Slow lane error: ${e.message}`, "ERROR"); markAsBroken(contentId, `error: ${e.message}`); return null; }
}

function buildFFmpegArgs(src, dest, quality, info, outputFormat) {
	const { duration, isLarge, isVideo, isAnimated } = info;

	if (isVideo) {
		if (quality === '0') return buildVideoArgs0(src, dest, duration || 0, isLarge);
		else if (quality === '1') return buildVideoArgs1(src, dest, isLarge);
		else return buildVideoArgs9(src, dest, duration || 0, isLarge);
	}
	if (isAnimated) {
		if (quality === '0') return buildAnimArgs0(src, dest, isLarge);
		else if (quality === '1') return buildAnimArgs1(src, dest, isLarge);
		else return buildAnimArgs9(src, dest, isLarge);
	}
	if (outputFormat === 'webp') return buildStaticWebPArgs(src, dest, quality, isLarge);
	else return buildStaticJPGArgs(src, dest, quality, isLarge);
}

// ★★★ 修复后的 FFmpeg 参数构建函数 - 不再使用 -vf copy ★★★
function buildVideoArgs0(src, dest, duration, isLarge) {
	const midStart = Math.max(0, duration / 2 - 0.67);
	const endStart = Math.max(0, duration - 1.33);
	const scale = isLarge ? 'scale=512:-1:flags=bilinear' : 'scale=iw:ih';
	return ['-y', '-ss', '0', '-t', '1.33', '-i', src, '-ss', String(midStart), '-t', '1.33', '-i', src, '-ss', String(endStart), '-t', '1.33', '-i', src, '-filter_complex', `[0:v][1:v][2:v]concat=n=3:v=1[out];[out]fps=13,${scale}[final]`, '-map', '[final]', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '70', '-loop', '0', '-an', '-vsync', '0', dest];
}

function buildVideoArgs1(src, dest, isLarge) {
	const scale = isLarge ? 'scale=512:-1:flags=bilinear' : 'scale=iw:ih';
	return ['-y', '-ss', '0', '-t', '2', '-i', src, '-vf', `fps=6,${scale}`, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '35', '-loop', '0', '-an', '-vsync', '0', dest];
}

function buildVideoArgs9(src, dest, duration, isLarge) {
	const seekPos = Math.min(2, duration * 0.1);
	const scale = isLarge ? 'scale=512:-1:flags=fast_bilinear' : 'scale=iw:ih';
	return ['-y', '-ss', String(seekPos), '-i', src, '-vf', scale, '-frames:v', '1', '-q:v', '15', dest];
}

// ★★★ 修复：动图参数 - 小图不加 -vf，大图才加 scale ★★★
function buildAnimArgs0(src, dest, isLarge) {
	if (isLarge) {
		return ['-y', '-i', src, '-vf', 'scale=512:-1:flags=bilinear', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '70', '-loop', '0', '-an', dest];
	} else {
		return ['-y', '-i', src, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '70', '-loop', '0', '-an', dest];
	}
}

function buildAnimArgs1(src, dest, isLarge) {
	if (isLarge) {
		return ['-y', '-t', '2', '-i', src, '-vf', 'fps=6,scale=512:-1:flags=bilinear', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '35', '-loop', '0', '-an', dest];
	} else {
		return ['-y', '-t', '2', '-i', src, '-vf', 'fps=6', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '35', '-loop', '0', '-an', dest];
	}
}

function buildAnimArgs9(src, dest, isLarge) {
	if (isLarge) {
		return ['-y', '-i', src, '-vf', 'scale=512:-1:flags=fast_bilinear', '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '22', dest];
	} else {
		return ['-y', '-i', src, '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '22', dest];
	}
}

// ★★★ 修复：静态图参数 - 小图不加 -vf ★★★
function buildStaticWebPArgs(src, dest, quality, isLarge) {
	const qv = quality === '0' ? '85' : (quality === '1' ? '50' : '22');
	const flags = quality === '9' ? 'fast_bilinear' : 'bilinear';
	if (isLarge) {
		return ['-y', '-i', src, '-vf', `scale=512:-1:flags=${flags}`, '-c:v', 'libwebp', '-lossless', '0', '-q:v', qv, dest];
	} else {
		return ['-y', '-i', src, '-c:v', 'libwebp', '-lossless', '0', '-q:v', qv, dest];
	}
}

function buildStaticJPGArgs(src, dest, quality, isLarge) {
	const qv = quality === '0' ? '2' : (quality === '1' ? '8' : '15');
	const flags = quality === '9' ? 'fast_bilinear' : 'bilinear';
	if (isLarge) {
		return ['-y', '-i', src, '-vf', `scale=512:-1:flags=${flags}`, '-q:v', qv, dest];
	} else {
		return ['-y', '-i', src, '-q:v', qv, dest];
	}
}

function getGifDurationFromBuffer(buffer) {
	if (!buffer || buffer.length < 13) return 0;
	try {
		let totalDelayCs = 0, i = 13;
		const sig = buffer.slice(0, 6).toString('ascii');
		if (sig !== 'GIF87a' && sig !== 'GIF89a') return 0;
		const flags = buffer[10];
		if ((flags & 0x80) !== 0) i += 3 * Math.pow(2, (flags & 0x07) + 1);
		while (i < buffer.length - 1) {
			const blockType = buffer[i];
			if (blockType === 0x21) {
				const extLabel = buffer[i + 1];
				if (extLabel === 0xF9) { if (i + 6 < buffer.length) { totalDelayCs += buffer[i + 4] | (buffer[i + 5] << 8); } i += 8; }
				else if (extLabel === 0xFF || extLabel === 0xFE || extLabel === 0x01) { i += 2; let bs = buffer[i]; i += bs + 1; while (i < buffer.length && buffer[i] !== 0) i += buffer[i] + 1; i++; }
				else { i += 2; while (i < buffer.length && buffer[i] !== 0) i += buffer[i] + 1; i++; }
			} else if (blockType === 0x2C) { if (i + 10 > buffer.length) break; const imgFlags = buffer[i + 9]; i += 10; if ((imgFlags & 0x80) !== 0) i += 3 * Math.pow(2, (imgFlags & 0x07) + 1); i++; while (i < buffer.length && buffer[i] !== 0) i += buffer[i] + 1; i++; }
			else if (blockType === 0x3B) break;
			else i++;
		}
		return totalDelayCs / 100;
	} catch (e) { return 0; }
}

function getWebPDurationFromBuffer(buffer) {
	if (!buffer || buffer.length < 12) return 0;
	if (buffer.toString('ascii', 0, 4) !== 'RIFF') return 0;
	if (buffer.toString('ascii', 8, 12) !== 'WEBP') return 0;
	let offset = 12, duration = 0, hasAnimation = false;
	while (offset + 8 <= buffer.length) {
		const chunkId = buffer.toString('ascii', offset, offset + 4);
		const chunkSize = buffer.readUInt32LE(offset + 4);
		const dataOffset = offset + 8;
		const nextOffset = dataOffset + chunkSize + (chunkSize % 2);
		if (chunkId === 'VP8X') { if (dataOffset < buffer.length) { const flags = buffer.readUInt8(dataOffset); hasAnimation = (flags & 0x02) !== 0; } }
		else if (chunkId === 'ANMF') { if (dataOffset + 15 <= buffer.length) { const frameDuration = buffer.readUIntLE(dataOffset + 12, 3); duration += frameDuration; } }
		offset = nextOffset;
	}
	if (!hasAnimation) return 0;
	return duration / 1000;
}

function clearCache() {
	if (!cacheDir) return;
	try {
		const files = fs.readdirSync(cacheDir);
		for (const file of files) { if (file.endsWith('.0') || file.endsWith('.1') || file.endsWith('.9') || file.includes('.tmp')) { try { fs.unlinkSync(path.join(cacheDir, file)); } catch (e) { } } }
		metaIndex = createEmptyIndex();
		pathMap.clear();
		memCache.clear();
		scheduleSave();
		updateStatusBar();
		vscode.window.showInformationMessage('QQQ 缓存已清空');
	} catch (e) { vscode.window.showErrorMessage(`清空缓存失败: ${e.message}`); }
}

// ==================== 扩展激活 ====================
let q1Module = null;
let q2Module = null;

async function activate(context) {
	globalExtensionContext = context;
	logMessage("qqq 扩展开始激活 (Python + Rust + Shell + JS 四级回退)...", "INFO");

	initCache(context.globalStorageUri.fsPath);
	initUserTracking(context);
	initStatusBar(context);

	// 启动引擎并更新状态栏
	pythonBridge.start().then((pyOk) => {
		if (pyOk) {
			setCurrentEngine(pythonBridge.getVersionString());
			logMessage("Python Bridge 启动成功 (最高优先级)", "INFO");
		} else {
			logMessage("Python Bridge 不可用，尝试 Rust", "WARN");
			rustBridge.start().then((rsOk) => {
				if (rsOk) {
					setCurrentEngine(rustBridge.getVersionString());
					logMessage("Rust Bridge 启动成功", "INFO");
				} else {
					logMessage("Rust Bridge 不可用，尝试 Shell", "WARN");
					shellBridge.start().then((shOk) => {
						if (shOk) {
							setCurrentEngine(shellBridge.getVersionString());
							logMessage("Shell Bridge 启动成功", "INFO");
						} else {
							setCurrentEngine("JS Spawn");
							logMessage("Shell Bridge 也不可用，使用纯 JS spawn 兜底", "WARN");
						}
					});
				}
			});
		}
	});

	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.pure", pureCommand),
		vscode.commands.registerCommand("qqq.clearCache", clearCache),
		vscode.commands.registerCommand("qqq.allSettings", () => { vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq"); })
	);

	try { q1Module = require("./q1"); if (q1Module && typeof q1Module.activate === "function") q1Module.activate(context); }
	catch (e) { logMessage(`q1 模块加载失败: ${e.message}`, "ERROR"); vscode.window.showErrorMessage(`qqq 粘贴功能启动失败: ${e.message}`); }

	try { q2Module = require("./q2"); if (q2Module && typeof q2Module.activate === "function") q2Module.activate(context); }
	catch (e) { logMessage(`q2 模块加载失败: ${e.message}`, "ERROR"); }

	logMessage("qqq 扩展激活完成", "INFO");
}

async function deactivate() {
	saveSync();
	pythonBridge.stop();
	rustBridge.stop();
	shellBridge.stop();
	if (q1Module && typeof q1Module.deactivate === "function") { try { await q1Module.deactivate(); } catch (e) { } }
	finishUserTracking(globalExtensionContext);
	logMessage("qqq 扩展已停用", "INFO");
}

module.exports = {
	activate, deactivate, identifyFile, getFolderInfo, handleClipboard, handleClipboardFast, handleClipboardSlow,
	shouldShowDuration, logMessage, initUserTracking, finishUserTracking, createPendingToken, getPreview, clearCache,
	computeContentId, pythonBridge, rustBridge, shellBridge, executeFFmpeg, updateStatusBar,
	LOG_PATH, BASE_DIR, QQQ_PATH_REGEX, PENDING_REGEX, ffmpegPath, CACHE_CONFIG, WEB_SAFE_FORMATS, ALPHA_CAPABLE_FORMATS, OPAQUE_ONLY_FORMATS
};

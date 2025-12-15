// src/qqq.js
// ==========================================
// ★★★ 中控大脑：惰性文件夹创建 + 严格 IO 调度 ★★★
// ==========================================
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const readline = require("readline");
const crypto = require("crypto");

// ==================== 全局配置 ====================
const LOG_PATH = "D:\\view\\p\\kp.log";
const outputChannel = vscode.window.createOutputChannel("qqq extension");

// ★★★ 核心正则：唯一真理源 ★★★
const QQQ_PATH_REGEX = /\/\\\s*.*?qqq.*?\s*\\\//gi;
const PENDING_REGEX = /\/\\__PENDING__:([a-zA-Z0-9]+)__\\\//g;

// ==================== 缓存配置 ====================
const CACHE_DIR_NAME = "qqq_cache";
const META_FILE_NAME = "meta.json";
const CACHE_MAX_SIZE = 40 * 1024 * 1024;
const CACHE_TARGET_SIZE = 28 * 1024 * 1024;
const FINGERPRINT_HEAD = 128;
const FINGERPRINT_MID = 128;
const FINGERPRINT_TAIL = 128;

// ==================== FFmpeg 路径 ====================
let ffmpegPath = null;
let ffprobePath = null;
try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
	ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, m => m.replace('ffmpeg', 'ffprobe'));
} catch (e) { }

// ==================== 全局状态 ====================
let extensionContext = null;
let cacheDir = null;
let cacheMeta = null;

// ==================== 日志工具 ====================
function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}`;
	outputChannel.appendLine(line);
	if (level === "ERROR" || level === "WARN") {
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(LOG_PATH, line + "\n");
		} catch (e) { }
	}
}

// ==================== 用户时长统计 ====================
const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
const KEY_SESSION_START = "qqq_stats_session_start";

function initUserTracking(context) {
	extensionContext = context;
	context.globalState.update(KEY_SESSION_START, Date.now());
	const total = context.globalState.get(KEY_TOTAL_DURATION, 0);
	const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
	vscode.window.setStatusBarMessage(`qqq累计使用: ${h}小时${m}分钟`, 5000);
}

function finishUserTracking(context) {
	if (!context) return;
	const start = context.globalState.get(KEY_SESSION_START);
	if (start) {
		const diff = (Date.now() - start) / 1000;
		const old = context.globalState.get(KEY_TOTAL_DURATION, 0);
		context.globalState.update(KEY_TOTAL_DURATION, old + diff);
		context.globalState.update(KEY_SESSION_START, undefined);
	}
}

// ==================== ★★★ 指纹系统 ★★★ ====================

function computeFingerprint(filePath) {
	try {
		const stat = fs.statSync(filePath);
		const size = stat.size;
		if (size === 0) return crypto.createHash('md5').update('empty:0').digest('hex');

		const fd = fs.openSync(filePath, 'r');
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
		return crypto.createHash('md5').update(Buffer.concat(chunks)).digest('hex');
	} catch (e) {
		return null;
	}
}

// ==================== ★★★ 磁盘缓存管理 ★★★ ====================
// (代码保持不变，省略以节省篇幅，逻辑未修改)
function initCache(context) { cacheDir = path.join(context.globalStorageUri.fsPath, CACHE_DIR_NAME); if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true }); loadCacheMeta(); validateCache(); }
function loadCacheMeta() { const metaPath = path.join(cacheDir, META_FILE_NAME); try { if (fs.existsSync(metaPath)) { cacheMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } else { cacheMeta = { entries: {}, stats: { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 }, brokenFiles: {} }; } } catch (e) { cacheMeta = { entries: {}, stats: { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 }, brokenFiles: {} }; } }
function saveCacheMeta() { if (!cacheDir || !cacheMeta) return; try { fs.writeFileSync(path.join(cacheDir, META_FILE_NAME), JSON.stringify(cacheMeta, null, 2)); } catch (e) { } }
function validateCache() { if (!cacheDir || !cacheMeta) return; let changed = false; let realSize = 0; let realCount = 0; const actualFiles = new Set(); try { const files = fs.readdirSync(cacheDir); for (const f of files) { if (f === META_FILE_NAME) continue; actualFiles.add(f); } } catch (e) { } for (const [contentId, entry] of Object.entries(cacheMeta.entries)) { if (!entry.qualities) continue; for (const [q, qInfo] of Object.entries(entry.qualities)) { const fileName = `${contentId}.${q}`; const filePath = path.join(cacheDir, fileName); if (!actualFiles.has(fileName)) { delete entry.qualities[q]; changed = true; } else { actualFiles.delete(fileName); try { const st = fs.statSync(filePath); realSize += st.size; realCount++; } catch (e) { } } } if (Object.keys(entry.qualities).length === 0) { delete cacheMeta.entries[contentId]; changed = true; } } for (const orphan of actualFiles) { try { fs.unlinkSync(path.join(cacheDir, orphan)); changed = true; } catch (e) { } } cacheMeta.stats.totalSize = realSize; cacheMeta.stats.fileCount = realCount; if (changed) saveCacheMeta(); }
function ensureCacheSpace(neededBytes) { if (!cacheDir || !cacheMeta) return; if (cacheMeta.stats.totalSize + neededBytes <= CACHE_MAX_SIZE) return; const entries = []; for (const [contentId, entry] of Object.entries(cacheMeta.entries)) { entries.push({ contentId, atime: entry.atime || 0 }); } entries.sort((a, b) => a.atime - b.atime); while (cacheMeta.stats.totalSize + neededBytes > CACHE_TARGET_SIZE && entries.length > 0) { const oldest = entries.shift(); evictEntry(oldest.contentId); } }
function evictEntry(contentId) { const entry = cacheMeta.entries[contentId]; if (!entry || !entry.qualities) return; for (const [q, qInfo] of Object.entries(entry.qualities)) { const fileName = `${contentId}.${q}`; try { const filePath = path.join(cacheDir, fileName); const st = fs.statSync(filePath); cacheMeta.stats.totalSize -= st.size; cacheMeta.stats.fileCount--; fs.unlinkSync(filePath); } catch (e) { } } delete cacheMeta.entries[contentId]; saveCacheMeta(); }
function getCacheEntry(contentId) { if (!cacheMeta || !cacheMeta.entries[contentId]) { cacheMeta.stats.missCount++; return null; } const entry = cacheMeta.entries[contentId]; entry.atime = Date.now(); cacheMeta.stats.hitCount++; return entry; }
function setCacheEntry(contentId, quality, buffer, meta) { if (!cacheDir || !cacheMeta) return null; ensureCacheSpace(buffer.length); const fileName = `${contentId}.${quality}`; const filePath = path.join(cacheDir, fileName); try { fs.writeFileSync(filePath, buffer); } catch (e) { return null; } if (!cacheMeta.entries[contentId]) { cacheMeta.entries[contentId] = { qualities: {}, atime: Date.now(), meta: {} }; } const entry = cacheMeta.entries[contentId]; entry.qualities[quality] = { size: buffer.length, format: quality.includes('gif') ? 'gif' : 'png' }; entry.atime = Date.now(); if (meta) Object.assign(entry.meta, meta); cacheMeta.stats.totalSize += buffer.length; cacheMeta.stats.fileCount++; saveCacheMeta(); return filePath; }
function getCachedBuffer(contentId, quality) { if (!cacheDir || !cacheMeta) return null; const entry = cacheMeta.entries[contentId]; if (!entry || !entry.qualities || !entry.qualities[quality]) return null; const fileName = `${contentId}.${quality}`; const filePath = path.join(cacheDir, fileName); try { if (fs.existsSync(filePath)) { entry.atime = Date.now(); return fs.readFileSync(filePath); } } catch (e) { } delete entry.qualities[quality]; if (Object.keys(entry.qualities).length === 0) delete cacheMeta.entries[contentId]; saveCacheMeta(); return null; }

// ==================== ★★★ Daemon 桥接（四层回退）★★★ ====================

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
		try { return await this.startPromise; } finally { this.isStarting = false; this.startPromise = null; }
	}

	setupProcess(proc, resolve) {
		this.process = proc;
		const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
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
		proc.stderr.on("data", (d) => logMessage(`${this.name} stderr: ${d}`, "WARN"));
		proc.on("error", () => this._handleCrash());
		proc.on("close", () => this._handleCrash());
		setTimeout(async () => {
			try {
				const pong = await this.call("ping", {}, 2000);
				if (pong && pong.status === "alive") {
					this.restartCount = 0;
					this.available = true;
					logMessage(`${this.name} started`, "INFO");
					resolve(true);
				} else { this.available = false; resolve(false); }
			} catch (e) { this.available = false; resolve(false); }
		}, 100);
	}

	_handleCrash() {
		this.process = null;
		for (const [id, { resolve, timer }] of this.pending) { clearTimeout(timer); resolve({ error: "process_crashed" }); }
		this.pending.clear();
		if (this.restartCount < this.maxRestarts) { this.restartCount++; setTimeout(() => this.start(), 500); } else { this.available = false; }
	}

	async call(action, params = {}, timeout = 5000) {
		if (this.available === false) return { error: `${this.name}_not_available` };
		if (!this.process || this.process.killed) { const started = await this.start(); if (!started) return { error: `${this.name}_not_available` }; }
		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";
		return new Promise((resolve) => {
			const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ error: "timeout" }); } }, timeout);
			this.pending.set(id, { resolve, timer });
			try { this.process.stdin.write(cmd); } catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ error: "write_error" }); }
		});
	}

	isAvailable() { return this.available === true; }
	stop() { if (this.process && !this.process.killed) { try { this.process.kill(); } catch (e) { } this.process = null; } }
}

const pythonBridge = new DaemonBridge("Python", (bridge) => {
	return new Promise((resolve) => {
		const scriptPath = path.join(__dirname, "kp.py");
		if (!fs.existsSync(scriptPath)) { bridge.available = false; resolve(false); return; }
		try {
			const proc = cp.spawn("python", [scriptPath, "--daemon"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
			bridge.setupProcess(proc, resolve);
		} catch (e) { bridge.available = false; resolve(false); }
	});
});

const rustBridge = new DaemonBridge("Rust", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		const arch = process.arch;
		let filename;
		if (platform === 'win32') filename = arch === 'arm64' ? 'q_win_arm64.exe' : 'q_win_x64.exe';
		else if (platform === 'darwin') filename = arch === 'arm64' ? 'q_mac_arm64' : 'q_mac_x64';
		else filename = arch === 'arm64' ? 'q_linux_arm64' : 'q_linux_x64';
		const candidates = [path.join(__dirname, '..', 'assets', filename), path.join(__dirname, 'assets', filename), path.join(__dirname, filename)];
		let exePath = null;
		for (const c of candidates) if (fs.existsSync(c)) { exePath = c; break; }
		if (!exePath) { bridge.available = false; resolve(false); return; }
		try {
			const proc = cp.spawn(exePath, ["--daemon"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
			bridge.setupProcess(proc, resolve);
		} catch (e) { bridge.available = false; resolve(false); }
	});
});

const shellBridge = new DaemonBridge("Shell", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		let proc;
		if (platform === 'win32') {
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
while ($true) { $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }; try { $cmd = ConvertFrom-Json $line; $result = Process-Command $cmd; $result | ConvertTo-Json -Compress | Write-Host } catch { @{ _id = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress | Write-Host } }`;
			proc = cp.spawn('powershell', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		} else {
			const bashScript = platform === 'darwin'
				? `while IFS= read -r line; do action=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null); id=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('_id',0))" 2>/dev/null); case "$action" in ping) echo '{"_id":'$id',"status":"alive"}' ;; hasImage) if pngpaste - >/dev/null 2>&1; then echo '{"_id":'$id',"value":true}'; else echo '{"_id":'$id',"value":false}'; fi ;; saveImage) dest=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('path',''))" 2>/dev/null); if pngpaste "$dest" 2>/dev/null; then echo '{"_id":'$id',"success":true}'; else echo '{"_id":'$id',"success":false}'; fi ;; *) echo '{"_id":'$id',"error":"unknown action"}' ;; esac; done`
				: `while IFS= read -r line; do action=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null); id=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('_id',0))" 2>/dev/null); case "$action" in ping) echo '{"_id":'$id',"status":"alive"}' ;; hasImage) if xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -q "image/png"; then echo '{"_id":'$id',"value":true}'; else echo '{"_id":'$id',"value":false}'; fi ;; saveImage) dest=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('path',''))" 2>/dev/null); if xclip -selection clipboard -t image/png -o > "$dest" 2>/dev/null && [ -s "$dest" ]; then echo '{"_id":'$id',"success":true}'; else echo '{"_id":'$id',"success":false}'; fi ;; *) echo '{"_id":'$id',"error":"unknown action"}' ;; esac; done`;
			proc = cp.spawn('bash', ['-c', bashScript], { stdio: ['pipe', 'pipe', 'pipe'] });
		}
		bridge.setupProcess(proc, resolve);
	});
});

// ==================== ★★★ 统一 IO 接口 ★★★ ====================

// 辅助：惰性创建目录
function ensureDir(dirPath) {
	if (!fs.existsSync(dirPath)) {
		try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { }
	}
}

async function handleClipboardFast() {
	try {
		const text = await vscode.env.clipboard.readText();
		if (text && text.trim()) return { type: "text", text };
	} catch (e) { }
	return null;
}

async function handleClipboardSlow(targetDir) {
	// 关键修改：移除此处的 fs.mkdirSync(targetDir)。
	// 将目录创建推迟到确认有文件要保存时。

	// 优先级1：Python
	// Python 现在如果通过 ctypes 拿不到图且没有 PIL，会返回 unknown。
	// Python 也被修改为惰性创建目录。
	if (pythonBridge.isAvailable()) {
		const res = await pythonBridge.call("clipboard", { target_dir: targetDir }, 10000);
		if (!res.error && res.type !== 'unknown') return res;
	}

	// 优先级2：Rust
	if (rustBridge.isAvailable()) {
		const res = await rustBridge.call("clipboard", { target_dir: targetDir }, 10000);
		if (!res.error && res.type !== 'unknown') return res;
	}

	// 优先级3：Shell (PowerShell / Bash)
	// 这里是 DIB 的完美归宿
	if (shellBridge.isAvailable()) {
		try {
			if (process.platform === 'win32') {
				// 检查文件
				const hasFiles = await shellBridge.call('hasFiles', {}, 2000);
				if (hasFiles.value) {
					const filesRes = await shellBridge.call('getFiles', {}, 3000);
					const files = filesRes.files || [];
					const folders = files.filter(f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });

					// 如果是文件夹路径文本，不需要创建 qqq 目录
					if (folders.length) return { type: "folder_text", text: folders.join('\n') };

					const copied = [];
					const validFiles = files.filter(f => fs.existsSync(f) && !fs.statSync(f).isDirectory());

					if (validFiles.length > 0) {
						// 确认有文件要写，才创建目录
						ensureDir(targetDir);

						for (const f of validFiles) {
							try {
								const ext = path.extname(f);
								const isImg = isImageExtForClipboard(ext);
								const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
								const dest = path.join(targetDir, fname);
								fs.copyFileSync(f, dest);
								copied.push(dest);
							} catch (e) { }
						}
						if (copied.length === 1 && isImageExtForClipboard(path.extname(copied[0]))) return { type: "image", path: copied[0] };
						if (copied.length) return { type: "file", files: copied };
					}
				}
			}

			// 检查图片 (包含 DIB)
			const hasImg = await shellBridge.call('hasImage', {}, 2000);
			if (hasImg.value) {
				const fname = getTimestampFilename(".png");
				const dest = path.join(targetDir, fname);

				// 确认有图，创建目录
				ensureDir(targetDir);

				// PowerShell SaveImage 会自动处理 DIB -> PNG
				const saved = await shellBridge.call('saveImage', { path: dest }, 5000);
				if (saved.success && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
					return { type: "image", path: dest };
				}
			}
		} catch (e) { }
	}

	// 优先级4：Spawn Fallback
	return handleClipboardSpawn(targetDir);
}

async function handleClipboardSpawn(targetDir) {
	const platform = process.platform;

	if (platform === 'win32') {
		const hasFiles = await spawnCheck('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
			'Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsFileDropList()){"1"}else{"0"}'], '1');

		if (hasFiles) {
			const filesOutput = await spawnOutput('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
				`Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetFileDropList();if($f){foreach($i in $f){$i}}`]);
			const files = filesOutput.split(/\r?\n/).map(s => s.trim()).filter(s => s && fs.existsSync(s));

			const folders = files.filter(f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
			if (folders.length) return { type: "folder_text", text: folders.join('\n') };

			const validFiles = files.filter(f => !fs.statSync(f).isDirectory());
			if (validFiles.length) {
				ensureDir(targetDir);
				const copied = [];
				for (const f of validFiles) {
					try {
						const ext = path.extname(f);
						const isImg = isImageExtForClipboard(ext);
						const fname = isImg ? getTimestampFilename(ext) : path.basename(f);
						const dest = path.join(targetDir, fname);
						fs.copyFileSync(f, dest);
						copied.push(dest);
					} catch (e) { }
				}
				if (copied.length === 1 && isImageExtForClipboard(path.extname(copied[0]))) return { type: "image", path: copied[0] };
				if (copied.length) return { type: "file", files: copied };
			}
		}

		const hasImg = await spawnCheck('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
			'Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsImage()){"1"}else{"0"}'], '1');

		if (hasImg) {
			const fname = getTimestampFilename(".png");
			const dest = path.join(targetDir, fname);
			ensureDir(targetDir); // 惰性创建
			const escapedPath = dest.replace(/'/g, "''");
			const saved = await spawnCheck('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
				`Add-Type -A System.Windows.Forms;Add-Type -A System.Drawing;$img=[System.Windows.Forms.Clipboard]::GetImage();if($img){$img.Save('${escapedPath}',[System.Drawing.Imaging.ImageFormat]::Png);'OK'}else{'FAIL'}`], 'OK');
			if (saved && fs.existsSync(dest) && fs.statSync(dest).size > 0) return { type: "image", path: dest };
		}
	} else if (platform === 'darwin') {
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);

		// ★★★ 修补缺口（仅此处改动）：macOS spawn fallback 也保持惰性，但确保能写成功 ★★★
		// 做法：先写入临时目录（不要求 targetDir 存在），确认有内容后再创建 targetDir 并移动过去。
		const tmpName = `qqq_${Date.now()}_${Math.random().toString(16).slice(2)}.png`;
		const tmpDest = path.join(os.tmpdir(), tmpName);

		try {
			// 先尝试写入临时文件
			cp.execSync(`pngpaste "${tmpDest}" 2>/dev/null || pbpaste -Prefer png > "${tmpDest}" 2>/dev/null`, { timeout: 5000 });

			// 如果临时文件生成成功且有内容，则说明确实是图片
			if (fs.existsSync(tmpDest) && fs.statSync(tmpDest).size > 0) {
				// 惰性创建真正目标目录
				ensureDir(targetDir);

				// 移动到目标路径（跨盘/权限异常时降级 copy+unlink）
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
				} else {
					// 清理失败产物
					if (fs.existsSync(dest)) try { fs.unlinkSync(dest); } catch { }
				}
			}

			// 清理临时空文件
			if (fs.existsSync(tmpDest)) try { fs.unlinkSync(tmpDest); } catch { }
		} catch (e) {
			// 清理临时文件
			if (fs.existsSync(tmpDest)) try { fs.unlinkSync(tmpDest); } catch { }
		}
	} else {
		// Linux
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);
		try {
			ensureDir(targetDir); // Linux 这里比较激进，先创建
			cp.execSync(`xclip -selection clipboard -t image/png -o > "${dest}" 2>/dev/null`, { timeout: 5000 });
			if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { type: "image", path: dest };
			else if (fs.existsSync(dest)) try { fs.unlinkSync(dest); } catch { }
		} catch (e) { }
	}

	return { type: "unknown" };
}

function spawnCheck(cmd, args, expected) {
	return new Promise(resolve => {
		const child = cp.spawn(cmd, args, { windowsHide: true });
		let output = '';
		child.stdout.on('data', d => output += d.toString().trim());
		child.on('close', () => resolve(output.includes(expected)));
		child.on('error', () => resolve(false));
		setTimeout(() => { try { child.kill(); } catch { } resolve(false); }, 5000);
	});
}

function spawnOutput(cmd, args) {
	return new Promise(resolve => {
		const child = cp.spawn(cmd, args, { windowsHide: true });
		let output = '';
		child.stdout.on('data', d => output += d.toString());
		child.on('close', () => resolve(output));
		child.on('error', () => resolve(''));
		setTimeout(() => { try { child.kill(); } catch { } resolve(''); }, 5000);
	});
}

// ==================== 文件夹信息 ====================
async function getFolderInfo(folderPath) {
	if (pythonBridge.isAvailable()) { const res = await pythonBridge.call("folder_info", { path: folderPath }, 15000); if (!res.error) return res; }
	if (rustBridge.isAvailable()) { const res = await rustBridge.call("folder_info", { path: folderPath }, 15000); if (!res.error) return res; }
	return getFolderInfoJS(folderPath);
}

async function getFolderInfoJS(folderPath) {
	if (!fs.existsSync(folderPath)) return { error: "not_found" };
	let totalSize = 0, fileCount = 0;
	const extStats = {};
	async function walk(dir) {
		try {
			const files = await fs.promises.readdir(dir, { withFileTypes: true });
			for (const file of files) {
				const fullPath = path.join(dir, file.name);
				if (file.isDirectory()) await walk(fullPath);
				else {
					try {
						const st = await fs.promises.stat(fullPath);
						totalSize += st.size; fileCount++;
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

// ==================== 工具函数 ====================
function getTimestampFilename(ext) {
	const now = new Date();
	const date = now.toISOString().slice(0, 10).replace(/-/g, '.');
	const time = now.toTimeString().slice(0, 8).replace(/:/g, '.');
	const day = now.getDay() || 7;
	const ms = String(now.getMilliseconds()).padStart(3, '0');
	const excluded = ['l', 'i', 's', 'a', 'm', 'c', 'b', 'f', 't'];
	const valid = 'abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(c => !excluded.includes(c.toLowerCase()));
	const c1 = valid[Math.floor(Math.random() * valid.length)];
	let c2 = valid[Math.floor(Math.random() * valid.length)];
	if (c1.toLowerCase() === 'g') c2 = valid.filter(c => c.toLowerCase() !== 'g')[Math.floor(Math.random() * (valid.length - 2))];
	return `${ms}${c1}${c2}.  ${date} [${day}] ${time}${ext}`;
}

function isImageExtForClipboard(ext) { return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif'].includes(ext.toLowerCase()); }
function shouldShowDuration(info) { return info && (info.type === "video" || info.type === "animated_image") && info.duration > 0.1; }

// ==================== 占位符管理 ====================
const pendingJobs = new Map();
let tokenCounter = 0;
function createPendingToken() { const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; let token = ''; for (let i = 0; i < 8; i++) token += chars[Math.floor(Math.random() * chars.length)]; return token + (++tokenCounter).toString(36); }
function registerPendingJob(token, data) { return new Promise((resolve, reject) => { pendingJobs.set(token, { resolve, reject, ...data, startTime: Date.now() }); setTimeout(() => { if (pendingJobs.has(token)) { pendingJobs.delete(token); reject(new Error("timeout")); } }, 30000); }); }
function resolvePendingJob(token, result) { const job = pendingJobs.get(token); if (job) { pendingJobs.delete(token); job.resolve(result); } }

// ==================== qqq.pure 命令 ====================
async function pureCommand() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showInformationMessage("请先打开一个文件"); return; }
	const docPath = editor.document.uri.fsPath;
	const parentDir = path.dirname(docPath);
	const qqqDir = path.join(parentDir, "qqq");
	if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) { vscode.window.showInformationMessage("当前目录下没有 qqq 文件夹"); return; }
	let qqqFiles = []; try { qqqFiles = fs.readdirSync(qqqDir).filter(f => fs.statSync(path.join(qqqDir, f)).isFile()); } catch (e) { vscode.window.showErrorMessage("读取 qqq 目录失败"); return; }
	if (!qqqFiles.length) { vscode.window.showInformationMessage("qqq 文件夹是空的"); return; }
	const referencedFiles = new Set();
	let parentFiles = []; try { parentFiles = fs.readdirSync(parentDir); } catch (e) { return; }
	const regex = new RegExp(QQQ_PATH_REGEX);
	for (const fileName of parentFiles) {
		const fullPath = path.join(parentDir, fileName);
		if (fileName === "qqq" || fileName === "qqq.pure") continue;
		try { if (!fs.statSync(fullPath).isFile()) continue; } catch { continue; }
		if (isLikelyBinary(fullPath)) continue;
		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			let match; regex.lastIndex = 0;
			while ((match = regex.exec(content))) {
				const rawPath = match[0].slice(2, -2).trim();
				let absPath = path.isAbsolute(rawPath) ? rawPath : path.join(parentDir, rawPath);
				absPath = absPath.replace(/\//g, "\\");
				if (absPath.toLowerCase().startsWith(qqqDir.toLowerCase())) { referencedFiles.add(path.basename(absPath).toLowerCase()); }
			}
		} catch (e) { }
	}
	const orphans = qqqFiles.filter(f => !referencedFiles.has(f.toLowerCase()));
	if (!orphans.length) { vscode.window.showInformationMessage("未发现孤儿文件"); return; }
	const orphanPaths = orphans.map(f => path.join(qqqDir, f));
	const cmdStr = os.platform() === "win32" ? `del ${orphanPaths.map(p => `"${p}"`).join(" ")}` : `rm ${orphanPaths.map(p => `"${p}"`).join(" ")}`;
	let content = "\n".repeat(13) + "   请在终端中执行下面命令：\n\n\n   " + cmdStr + "\n\n\n";
	content += orphanPaths.map(p => `/\\${p}\\/`).join("\n\n\n\n\n");
	const purePath = path.join(parentDir, "qqq.pure");
	try { fs.writeFileSync(purePath, content, "utf-8"); const doc = await vscode.workspace.openTextDocument(purePath); await vscode.window.showTextDocument(doc); } catch (e) { vscode.window.showErrorMessage("无法生成 qqq.pure 文件"); }
}

function isLikelyBinary(filePath) {
	const binExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.exe', '.dll', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.pdf', '.doc', '.docx']);
	if (binExts.has(path.extname(filePath).toLowerCase())) return true;
	try {
		const buf = Buffer.alloc(4096);
		const fd = fs.openSync(filePath, 'r');
		try { const bytesRead = fs.readSync(fd, buf, 0, 4096, 0); for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true; return false; } finally { fs.closeSync(fd); }
	} catch (e) { return true; }
}

// ==================== 扩展激活 ====================
let q1Module = null;
let q2Module = null;
async function activate(context) {
	logMessage("qqq 扩展激活（中控模式）...", "INFO");
	extensionContext = context;
	initCache(context);
	initUserTracking(context);
	pythonBridge.start().then(ok => {
		if (ok) logMessage("Python Bridge OK", "INFO");
		else rustBridge.start().then(ok2 => {
			if (ok2) logMessage("Rust Bridge OK", "INFO");
			else shellBridge.start().then(ok3 => {
				if (ok3) logMessage("Shell Bridge OK", "INFO");
				else logMessage("All daemons failed, using spawn fallback", "WARN");
			});
		});
	});
	context.subscriptions.push(vscode.commands.registerCommand("qqq.pure", pureCommand), vscode.commands.registerCommand("qqq.allSettings", () => { vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq"); }));
	try { q1Module = require("./q1"); if (q1Module?.activate) q1Module.activate(context); } catch (e) { logMessage(`q1 加载失败: ${e.message}`, "ERROR"); }
	try { q2Module = require("./q2"); if (q2Module?.activate) q2Module.activate(context); } catch (e) { logMessage(`q2 加载失败: ${e.message}`, "ERROR"); }
	logMessage("qqq 扩展激活完成", "INFO");
}

async function deactivate() {
	pythonBridge.stop();
	rustBridge.stop();
	shellBridge.stop();
	finishUserTracking(extensionContext);
	saveCacheMeta();
	if (q1Module?.deactivate) try { await q1Module.deactivate(); } catch (e) { }
	logMessage("qqq 扩展已停用", "INFO");
}

module.exports = {
	activate, deactivate,
	QQQ_PATH_REGEX, PENDING_REGEX, ffmpegPath, ffprobePath, logMessage,
	computeFingerprint, getCacheEntry, setCacheEntry, getCachedBuffer,
	handleClipboardFast, handleClipboardSlow, getFolderInfo,
	getTimestampFilename, isImageExtForClipboard, shouldShowDuration,
	createPendingToken, registerPendingJob, resolvePendingJob,
	initUserTracking, finishUserTracking,
};

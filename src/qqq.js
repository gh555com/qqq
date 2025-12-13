// File: src/qqq.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const readline = require("readline");

// ==================== 全局配置 ====================
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const outputChannel = vscode.window.createOutputChannel("qqq extension");

// ★★★ 核心正则：唯一真理源 ★★★
const QQQ_PATH_REGEX = /\/\\\s*.*?qqq.*?\s*\\\//gi;
// ★★★ PENDING 占位符正则 ★★★
const PENDING_REGEX = /\/\\__PENDING__:([a-zA-Z0-9]+)__\\\//g;

// ==================== FFmpeg 路径管理 ====================
let ffmpegPath = null;
try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
} catch (e) {
	ffmpegPath = null;
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

// ==================== 用户时长统计 ====================
const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
const KEY_SESSION_START = "qqq_stats_session_start";

function initUserTracking(context) {
	context.globalState.update(KEY_SESSION_START, Date.now());
	const totalSeconds = context.globalState.get(KEY_TOTAL_DURATION, 0);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	vscode.window.setStatusBarMessage(`qqq累计使用: ${hours}小时${minutes}分钟`, 5000);
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
const pendingJobs = new Map();
let tokenCounter = 0;

function createPendingToken() {
	const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
	let token = '';
	for (let i = 0; i < 8; i++) {
		token += chars[Math.floor(Math.random() * chars.length)];
	}
	token += (++tokenCounter).toString(36);
	return token;
}

function registerPendingJob(token, targetDir) {
	return new Promise((resolve, reject) => {
		pendingJobs.set(token, { resolve, reject, targetDir, startTime: Date.now() });
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
		this.available = null; // null = 未检测, true/false = 检测结果
	}

	async start() {
		if (this.process && !this.process.killed) return true;
		if (this.isStarting) return this.startPromise;

		this.isStarting = true;
		this.startPromise = this._doStart();

		try {
			return await this.startPromise;
		} finally {
			this.isStarting = false;
			this.startPromise = null;
		}
	}

	async _doStart() {
		return new Promise((resolve) => {
			const scriptPath = path.join(__dirname, "kp.py");

			// 检查 kp.py 是否存在
			if (!fs.existsSync(scriptPath)) {
				logMessage("kp.py not found, Python Bridge unavailable", "WARN");
				this.available = false;
				resolve(false);
				return;
			}

			try {
				this.process = cp.spawn("python", [scriptPath, "--daemon"], {
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true
				});

				const rl = readline.createInterface({
					input: this.process.stdout,
					crlfDelay: Infinity
				});

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
					} catch (e) {
						logMessage(`Python Bridge parse error: ${e}`, "ERROR");
					}
				});

				this.process.stderr.on("data", (data) => {
					logMessage(`Python stderr: ${data.toString()}`, "WARN");
				});

				this.process.on("error", (err) => {
					logMessage(`Python process error: ${err}`, "ERROR");
					this._handleCrash();
				});

				this.process.on("close", (code) => {
					logMessage(`Python process closed: ${code}`, "WARN");
					this._handleCrash();
				});

				// Ping 测试
				setTimeout(async () => {
					try {
						const pong = await this.call("ping", {}, 2000);
						if (pong && pong.status === "alive") {
							this.restartCount = 0;
							this.available = true;
							logMessage("Python Bridge started", "INFO");
							resolve(true);
						} else {
							this.available = false;
							resolve(false);
						}
					} catch (e) {
						this.available = false;
						resolve(false);
					}
				}, 100);
			} catch (e) {
				logMessage(`Python spawn error: ${e}`, "ERROR");
				this.available = false;
				resolve(false);
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
		} else {
			this.available = false;
		}
	}

	async call(action, params = {}, timeout = 5000) {
		if (this.available === false) {
			return { error: "python_not_available" };
		}

		if (!this.process || this.process.killed) {
			const started = await this.start();
			if (!started) return { error: "python_not_available" };
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

	async identify(filePath) {
		return this.call("identify", { path: filePath });
	}

	async getFolderInfo(folderPath) {
		return this.call("folder_info", { path: folderPath }, 15000);
	}

	async handleClipboard(targetDir) {
		return this.call("clipboard", { target_dir: targetDir }, 10000);
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
		this.available = null; // null = 未检测, true/false = 检测结果
	}

	_getExePath() {
		if (this.exePath) return this.exePath;

		const platform = process.platform;
		const arch = process.arch;
		let filename;

		if (platform === 'win32') {
			filename = arch === 'arm64' ? 'q_win_arm64.exe' : 'q_win_x64.exe';
		} else if (platform === 'darwin') {
			filename = arch === 'arm64' ? 'q_mac_arm64' : 'q_mac_x64';
		} else {
			filename = arch === 'arm64' ? 'q_linux_arm64' : 'q_linux_x64';
		}

		// 尝试多个可能的路径
		const candidates = [
			path.join(__dirname, '..', 'assets', filename),
			path.join(__dirname, 'assets', filename),
			path.join(__dirname, filename),
		];

		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				this.exePath = candidate;
				return this.exePath;
			}
		}

		return null;
	}

	async start() {
		if (this.process && !this.process.killed) return true;
		if (this.isStarting) return this.startPromise;

		this.isStarting = true;
		this.startPromise = this._doStart();

		try {
			return await this.startPromise;
		} finally {
			this.isStarting = false;
			this.startPromise = null;
		}
	}

	async _doStart() {
		return new Promise((resolve) => {
			const exePath = this._getExePath();
			if (!exePath) {
				logMessage("Rust daemon not found, falling back", "WARN");
				this.available = false;
				resolve(false);
				return;
			}

			try {
				this.process = cp.spawn(exePath, ["--daemon"], {
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true
				});

				const rl = readline.createInterface({
					input: this.process.stdout,
					crlfDelay: Infinity
				});

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
					} catch (e) {
						logMessage(`Rust Bridge parse error: ${e}`, "ERROR");
					}
				});

				this.process.stderr.on("data", (data) => {
					logMessage(`Rust stderr: ${data.toString()}`, "WARN");
				});

				this.process.on("error", (err) => {
					logMessage(`Rust process error: ${err}`, "ERROR");
					this._handleCrash();
				});

				this.process.on("close", (code) => {
					logMessage(`Rust process closed: ${code}`, "WARN");
					this._handleCrash();
				});

				// Ping 测试
				setTimeout(async () => {
					try {
						const pong = await this.call("ping", {}, 2000);
						if (pong && pong.status === "alive") {
							this.restartCount = 0;
							this.available = true;
							logMessage("Rust Bridge started", "INFO");
							resolve(true);
						} else {
							this.available = false;
							resolve(false);
						}
					} catch (e) {
						this.available = false;
						resolve(false);
					}
				}, 100);
			} catch (e) {
				logMessage(`Rust spawn error: ${e}`, "ERROR");
				this.available = false;
				resolve(false);
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
			logMessage(`Rust Bridge restart ${this.restartCount}/${this.maxRestarts}`, "WARN");
			setTimeout(() => this.start(), 500);
		} else {
			this.available = false;
		}
	}

	async call(action, params = {}, timeout = 5000) {
		if (this.available === false) {
			return { error: "rust_not_available" };
		}

		if (!this.process || this.process.killed) {
			const started = await this.start();
			if (!started) return { error: "rust_not_available" };
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

	async identify(filePath) {
		return this.call("identify", { path: filePath });
	}

	async getFolderInfo(folderPath) {
		return this.call("folder_info", { path: folderPath }, 15000);
	}

	async handleClipboard(targetDir) {
		return this.call("clipboard", { target_dir: targetDir }, 10000);
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

const rustBridge = new RustBridge();

// ==================== ★★★ 常驻 Shell Bridge (回退方案) ★★★ ====================

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

		try {
			return await this.startPromise;
		} finally {
			this.isStarting = false;
			this.startPromise = null;
		}
	}

	async _doStart() {
		if (this.platform === 'win32') {
			return this._startPowerShell();
		} else if (this.platform === 'darwin') {
			return this._startMacDaemon();
		} else {
			return this._startLinuxDaemon();
		}
	}

	async _startPowerShell() {
		return new Promise((resolve) => {
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
            'getFiles' {
                $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
                $result.files = @()
                if ($files) { foreach ($f in $files) { $result.files += $f } }
            }
            'saveImage' {
                $img = [System.Windows.Forms.Clipboard]::GetImage()
                if ($img) {
                    $img.Save($cmd.path, [System.Drawing.Imaging.ImageFormat]::Png)
                    $result.success = $true
                } else { $result.success = $false }
            }
            default { $result.error = "unknown action" }
        }
    } catch { $result.error = $_.Exception.Message }
    return $result
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    try {
        $cmd = ConvertFrom-Json $line
        $result = Process-Command $cmd
        $result | ConvertTo-Json -Compress | Write-Host
    } catch {
        @{ _id = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress | Write-Host
    }
}
`;
			try {
				this.process = cp.spawn('powershell', [
					'-NoProfile', '-NoLogo', '-NonInteractive',
					'-ExecutionPolicy', 'Bypass',
					'-Command', psScript
				], {
					stdio: ['pipe', 'pipe', 'pipe'],
					windowsHide: true
				});

				this._setupProcessHandlers(resolve);
			} catch (e) {
				this.available = false;
				resolve(false);
			}
		});
	}

	async _startMacDaemon() {
		return new Promise((resolve) => {
			// macOS: 使用 bash + osascript 组合
			const bashScript = `
#!/bin/bash
while IFS= read -r line; do
    action=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null)
    id=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('_id',0))" 2>/dev/null)

    case "$action" in
        ping)
            echo '{"_id":'$id',"status":"alive"}'
            ;;
        hasImage)
            # 检查剪贴板是否有图片
            if pngpaste - >/dev/null 2>&1; then
                echo '{"_id":'$id',"value":true}'
            else
                echo '{"_id":'$id',"value":false}'
            fi
            ;;
        saveImage)
            dest=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('path',''))" 2>/dev/null)
            if pngpaste "$dest" 2>/dev/null; then
                echo '{"_id":'$id',"success":true}'
            else
                echo '{"_id":'$id',"success":false}'
            fi
            ;;
        *)
            echo '{"_id":'$id',"error":"unknown action"}'
            ;;
    esac
done
`;
			try {
				this.process = cp.spawn('bash', ['-c', bashScript], {
					stdio: ['pipe', 'pipe', 'pipe']
				});
				this._setupProcessHandlers(resolve);
			} catch (e) {
				this.available = false;
				resolve(false);
			}
		});
	}

	async _startLinuxDaemon() {
		return new Promise((resolve) => {
			// Linux: 使用 bash + xclip
			const bashScript = `
#!/bin/bash
while IFS= read -r line; do
    action=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('action',''))" 2>/dev/null)
    id=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('_id',0))" 2>/dev/null)

    case "$action" in
        ping)
            echo '{"_id":'$id',"status":"alive"}'
            ;;
        hasImage)
            if xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -q "image/png"; then
                echo '{"_id":'$id',"value":true}'
            else
                echo '{"_id":'$id',"value":false}'
            fi
            ;;
        saveImage)
            dest=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('path',''))" 2>/dev/null)
            if xclip -selection clipboard -t image/png -o > "$dest" 2>/dev/null && [ -s "$dest" ]; then
                echo '{"_id":'$id',"success":true}'
            else
                echo '{"_id":'$id',"success":false}'
            fi
            ;;
        *)
            echo '{"_id":'$id',"error":"unknown action"}'
            ;;
    esac
done
`;
			try {
				this.process = cp.spawn('bash', ['-c', bashScript], {
					stdio: ['pipe', 'pipe', 'pipe']
				});
				this._setupProcessHandlers(resolve);
			} catch (e) {
				this.available = false;
				resolve(false);
			}
		});
	}

	_setupProcessHandlers(resolve) {
		const rl = readline.createInterface({
			input: this.process.stdout,
			crlfDelay: Infinity
		});

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

		this.process.on('error', () => {
			this.available = false;
			this.process = null;
		});

		this.process.on('close', () => {
			this.process = null;
		});

		// 测试
		setTimeout(async () => {
			try {
				const pong = await this.call('ping', {}, 3000);
				if (pong && pong.status === 'alive') {
					this.available = true;
					logMessage(`Shell Bridge (${this.platform}) started`, "INFO");
					resolve(true);
				} else {
					this.available = false;
					resolve(false);
				}
			} catch (e) {
				this.available = false;
				resolve(false);
			}
		}, 500);
	}

	async call(action, params = {}, timeout = 5000) {
		if (this.available === false) {
			return { error: "shell_not_available" };
		}

		if (!this.process || this.process.killed) {
			const started = await this.start();
			if (!started) return { error: "shell_not_available" };
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

	async hasImage() {
		const result = await this.call('hasImage', {}, 2000);
		return result.value === true;
	}

	async hasFiles() {
		const result = await this.call('hasFiles', {}, 2000);
		return result.value === true;
	}

	async getFiles() {
		const result = await this.call('getFiles', {}, 3000);
		return result.files || [];
	}

	async saveImage(destPath) {
		const result = await this.call('saveImage', { path: destPath }, 5000);
		return result.success === true;
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

const shellBridge = new ShellBridge();

// ==================== 媒体文件识别 ====================
const SIGNATURES = [
	{ sig: [0x89, 0x50, 0x4E, 0x47], ext: '.png', type: 'image' },
	{ sig: [0xFF, 0xD8, 0xFF], ext: '.jpg', type: 'image' },
	{ sig: [0x47, 0x49, 0x46, 0x38], ext: '.gif', type: 'gif' },
	{ sig: [0x42, 0x4D], ext: '.bmp', type: 'image' },
	{ sig: [0x52, 0x49, 0x46, 0x46], offset: 8, match: [0x57, 0x45, 0x42, 0x50], ext: '.webp', type: 'image' },
	{ sig: [0x00, 0x00, 0x01, 0x00], ext: '.ico', type: 'image' },
	{ sig: [0x49, 0x44, 0x33], ext: '.mp3', type: 'audio' },
	{ sig: [0xFF, 0xFB], ext: '.mp3', type: 'audio' },
	{ sig: [0x1A, 0x45, 0xDF, 0xA3], ext: '.mkv', type: 'video' },
];

function identifyBySignature(buffer) {
	for (const s of SIGNATURES) {
		const offset = s.offset || 0;
		const sig = s.match || s.sig;
		if (buffer.length >= offset + sig.length) {
			let match = true;
			for (let i = 0; i < sig.length; i++) {
				if (buffer[offset + i] !== sig[i]) { match = false; break; }
			}
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
				if (c.includes('png') || c.includes('bmp') || c.includes('tiff') || c.includes('jpeg')) {
					info.type = 'image'; info.duration = 0;
				} else if (c.includes('gif')) {
					info.type = (info.duration > 0.1) ? 'animated_image' : 'image';
				} else if (c.includes('webp')) {
					info.type = (info.duration > 0.1) ? 'animated_image' : 'image';
				} else if (c.includes('mjpeg')) {
					if (info.duration <= 0.1) { info.type = 'image'; info.duration = 0; }
					else { info.type = 'video'; }
				}
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

	// ★★★ 优先级1：Python Bridge ★★★
	if (pythonBridge.isAvailable()) {
		const result = await pythonBridge.identify(filePath);
		if (!result.error) return result;
	}

	// ★★★ 优先级2：Rust Bridge ★★★
	if (rustBridge.isAvailable()) {
		const result = await rustBridge.identify(filePath);
		if (!result.error) return result;
	}

	// ★★★ 优先级3：纯 JS 回退 ★★★
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
		if (ff && (ff.width || ff.duration > 0)) {
			info = { ...info, ...ff };
		}
	}
	return info;
}

// ==================== 文件夹统计 ====================
async function getFolderInfo(folderPath) {
	// ★★★ 优先级1：Python Bridge ★★★
	if (pythonBridge.isAvailable()) {
		const result = await pythonBridge.getFolderInfo(folderPath);
		if (!result.error) return result;
	}

	// ★★★ 优先级2：Rust Bridge ★★★
	if (rustBridge.isAvailable()) {
		const result = await rustBridge.getFolderInfo(folderPath);
		if (!result.error) return result;
	}

	// ★★★ 优先级3：纯 JS 回退 ★★★
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

// ==================== ★★★ Fast Path：纯文字粘贴（<1ms）★★★ ====================
async function handleClipboardFast() {
	try {
		const text = await vscode.env.clipboard.readText();
		if (text && text.trim()) {
			return { type: "text", text: text };
		}
	} catch (e) { }
	return null;
}

// ==================== ★★★ Slow Path：媒体处理（四级回退）★★★ ====================
async function handleClipboardSlow(targetDir) {
	if (!fs.existsSync(targetDir)) {
		fs.mkdirSync(targetDir, { recursive: true });
	}

	// ★★★ 优先级1：Python daemon ★★★
	if (pythonBridge.isAvailable()) {
		const result = await pythonBridge.handleClipboard(targetDir);
		if (!result.error && result.type !== 'unknown') {
			return result;
		}
		logMessage("Python clipboard failed, falling back to Rust", "WARN");
	}

	// ★★★ 优先级2：Rust daemon ★★★
	if (rustBridge.isAvailable()) {
		const result = await rustBridge.handleClipboard(targetDir);
		if (!result.error && result.type !== 'unknown') {
			return result;
		}
		logMessage("Rust clipboard failed, falling back to Shell", "WARN");
	}

	// ★★★ 优先级3：常驻 Shell daemon ★★★
	if (shellBridge.isAvailable()) {
		try {
			const platform = process.platform;

			if (platform === 'win32') {
				// Windows: 检测文件
				const hasFiles = await shellBridge.hasFiles();
				if (hasFiles) {
					const files = await shellBridge.getFiles();
					if (files.length > 0) {
						const folders = files.filter(f => {
							try { return fs.statSync(f).isDirectory(); } catch { return false; }
						});
						if (folders.length > 0) {
							return { type: "folder_text", text: folders.join('\n') };
						}

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

						if (copied.length === 1 && isImageExtForClipboard(path.extname(copied[0]))) {
							return { type: "image", path: copied[0] };
						}
						if (copied.length > 0) {
							return { type: "file", files: copied };
						}
					}
				}
			}

			// 所有平台：检测图片
			const hasImg = await shellBridge.hasImage();
			if (hasImg) {
				const fname = getTimestampFilename(".png");
				const dest = path.join(targetDir, fname);
				const saved = await shellBridge.saveImage(dest);
				if (saved && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
					return { type: "image", path: dest };
				}
			}

			logMessage("Shell clipboard failed, falling back to spawn", "WARN");
		} catch (e) {
			logMessage(`Shell clipboard error: ${e.message}`, "WARN");
		}
	}

	// ★★★ 优先级4：每次 spawn (最慢的兜底) ★★★
	return handleClipboardSlowFallback(targetDir);
}

// 最终兜底：每次 spawn PowerShell/pbpaste/xclip
async function handleClipboardSlowFallback(targetDir) {
	const platform = process.platform;

	if (platform === 'win32') {
		// 检测文件
		const hasFiles = await new Promise(resolve => {
			const child = cp.spawn('powershell', [
				'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
				'Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsFileDropList()){"1"}else{"0"}'
			], { windowsHide: true });
			let output = '';
			child.stdout.on('data', d => output += d.toString().trim());
			child.on('close', () => resolve(output === '1'));
			child.on('error', () => resolve(false));
			setTimeout(() => { try { child.kill(); } catch { } resolve(false); }, 3000);
		});

		if (hasFiles) {
			const files = await new Promise(resolve => {
				const child = cp.spawn('powershell', [
					'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
					`Add-Type -A System.Windows.Forms;$f=[System.Windows.Forms.Clipboard]::GetFileDropList();if($f){foreach($i in $f){$i}}`
				], { windowsHide: true });
				let output = '';
				child.stdout.on('data', d => output += d.toString());
				child.on('close', () => {
					const list = output.split(/\r?\n/).map(s => s.trim()).filter(s => s && fs.existsSync(s));
					resolve(list);
				});
				child.on('error', () => resolve([]));
				setTimeout(() => { try { child.kill(); } catch { } resolve([]); }, 5000);
			});

			if (files.length > 0) {
				const folders = files.filter(f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
				if (folders.length > 0) {
					return { type: "folder_text", text: folders.join('\n') };
				}

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

				if (copied.length === 1 && isImageExtForClipboard(path.extname(copied[0]))) {
					return { type: "image", path: copied[0] };
				}
				if (copied.length > 0) {
					return { type: "file", files: copied };
				}
			}
		}

		// 检测图片
		const hasImg = await new Promise(resolve => {
			const child = cp.spawn('powershell', [
				'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
				'Add-Type -A System.Windows.Forms;if([System.Windows.Forms.Clipboard]::ContainsImage()){"1"}else{"0"}'
			], { windowsHide: true });
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
				const child = cp.spawn('powershell', [
					'-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
					`Add-Type -A System.Windows.Forms;Add-Type -A System.Drawing;$img=[System.Windows.Forms.Clipboard]::GetImage();if($img){$img.Save('${escapedPath}',[System.Drawing.Imaging.ImageFormat]::Png);'OK'}else{'FAIL'}`
				], { windowsHide: true });
				let output = '';
				child.stdout.on('data', d => output += d.toString().trim());
				child.on('close', () => resolve(output.includes('OK')));
				child.on('error', () => resolve(false));
				setTimeout(() => { try { child.kill(); } catch { } resolve(false); }, 8000);
			});

			if (saved && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
				return { type: "image", path: dest };
			}
		}

		return { type: "unknown" };
	}

	// Mac
	else if (platform === 'darwin') {
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);
		const imgResult = await new Promise(resolve => {
			cp.exec(`which pngpaste && pngpaste "${dest}" 2>/dev/null`, (err) => {
				if (!err && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
					resolve({ type: "image", path: dest });
				} else {
					cp.exec(`pbpaste -Prefer png > "${dest}" 2>/dev/null`, (err2) => {
						if (!err2 && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
							resolve({ type: "image", path: dest });
						} else {
							if (fs.existsSync(dest)) try { fs.unlinkSync(dest); } catch { }
							resolve(null);
						}
					});
				}
			});
		});
		if (imgResult) return imgResult;
		return { type: "unknown" };
	}

	// Linux
	else {
		const fname = getTimestampFilename(".png");
		const dest = path.join(targetDir, fname);
		const imgResult = await new Promise(resolve => {
			cp.exec(`xclip -selection clipboard -t image/png -o > "${dest}" 2>/dev/null`, (err) => {
				if (!err && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
					resolve({ type: "image", path: dest });
				} else {
					if (fs.existsSync(dest)) try { fs.unlinkSync(dest); } catch { }
					resolve(null);
				}
			});
		});
		if (imgResult) return imgResult;
		return { type: "unknown" };
	}
}

// ==================== 兼容旧接口 ====================
async function handleClipboard(targetDir) {
	const fast = await handleClipboardFast();
	if (fast) return fast;
	return handleClipboardSlow(targetDir);
}

// ==================== 公共工具函数 ====================
function isLikelyBinary(filePath) {
	const binaryExts = new Set([
		".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif",
		".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o",
		".zip", ".tar", ".gz", ".7z", ".rar",
		".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
		".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
	]);
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

	if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) {
		vscode.window.showInformationMessage("当前目录下没有 qqq 文件夹");
		return;
	}

	let qqqFiles = [];
	try {
		qqqFiles = fs.readdirSync(qqqDir).filter((f) => {
			const fullPath = path.join(qqqDir, f);
			return fs.statSync(fullPath).isFile();
		});
	} catch (e) { vscode.window.showErrorMessage("读取 qqq 目录失败: " + e.message); return; }

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
				if (!path.isAbsolute(rawPath)) {
					absRefPath = path.join(parentDir, rawPath);
				}
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
	if (os.platform() === "win32") {
		const args = orphanPaths.map((p) => `"${p}"`).join(" ");
		commandStr = `del ${args}`;
	} else {
		const args = orphanPaths.map((p) => `"${p}"`).join(" ");
		commandStr = `rm ${args}`;
	}

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

// ==================== 扩展激活 ====================
let q1Module = null;
let q2Module = null;

async function activate(context) {
	logMessage("qqq 扩展开始激活 (Python + Rust + Shell + JS 四级回退)...", "INFO");

	// ★★★ 启动顺序：Python > Rust > Shell ★★★
	pythonBridge.start().then((pyOk) => {
		if (pyOk) {
			logMessage("Python Bridge 启动成功 (最高优先级)", "INFO");
		} else {
			logMessage("Python Bridge 不可用，尝试 Rust", "WARN");
			rustBridge.start().then((rsOk) => {
				if (rsOk) {
					logMessage("Rust Bridge 启动成功", "INFO");
				} else {
					logMessage("Rust Bridge 不可用，尝试 Shell", "WARN");
					shellBridge.start().then((shOk) => {
						if (shOk) {
							logMessage("Shell Bridge 启动成功", "INFO");
						} else {
							logMessage("Shell Bridge 也不可用，使用纯 JS spawn 兜底", "WARN");
						}
					});
				}
			});
		}
	});

	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.pure", pureCommand),
		vscode.commands.registerCommand("qqq.allSettings", () => {
			vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
		})
	);

	try {
		q1Module = require("./q1");
		if (q1Module && typeof q1Module.activate === "function") q1Module.activate(context);
	} catch (e) {
		logMessage(`q1 模块加载失败: ${e.message}`, "ERROR");
		vscode.window.showErrorMessage(`qqq 粘贴功能启动失败: ${e.message}`);
	}

	try {
		q2Module = require("./q2");
		if (q2Module && typeof q2Module.activate === "function") q2Module.activate(context);
	} catch (e) {
		logMessage(`q2 模块加载失败: ${e.message}`, "ERROR");
	}

	logMessage("qqq 扩展激活完成", "INFO");
}

async function deactivate() {
	pythonBridge.stop();
	rustBridge.stop();
	shellBridge.stop();
	if (q1Module && typeof q1Module.deactivate === "function") {
		try { await q1Module.deactivate(); } catch (e) { console.error("Q1 cleanup failed:", e); }
	}
	logMessage("qqq 扩展已停用", "INFO");
}

module.exports = {
	activate,
	deactivate,
	identifyFile,
	getFolderInfo,
	handleClipboard,
	handleClipboardFast,
	handleClipboardSlow,
	shouldShowDuration,
	logMessage,
	initUserTracking,
	finishUserTracking,
	createPendingToken,
	registerPendingJob,
	resolvePendingJob,
	pythonBridge,
	rustBridge,
	shellBridge,
	LOG_PATH,
	BASE_DIR,
	QQQ_PATH_REGEX,
	PENDING_REGEX,
	ffmpegPath
};


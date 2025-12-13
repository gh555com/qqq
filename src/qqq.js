// File: src/qqq.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");
const readline = require("readline");

// ==================== 公共配置 ====================
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const outputChannel = vscode.window.createOutputChannel("qqq extension");

// ★★★ 核心正则：唯一真理源 ★★★
// 匹配结构： /\ ... \/
// 允许中间有空格，允许相对路径 (不再强制 [a-z]:)
// 只要包含 qqq 即可
const QQQ_PATH_REGEX = /\/\\\s*.*?qqq.*?\s*\\\//gi;

// ==================== 日志工具 ====================
function ensureLogDir() {
	try {
		const dir = path.dirname(LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		return true;
	} catch (e) {
		return false;
	}
}

function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}`;
	outputChannel.appendLine(line);
	if (level === "ERROR" || level === "WARN") {
		try {
			if (ensureLogDir()) fs.appendFileSync(LOG_PATH, line + "\n");
		} catch (e) { }
	}
}

// ==================== Python Bridge ====================
class PythonBridge {
	constructor() {
		this.process = null;
		this.pending = new Map();
		this.requestId = 0;
		this.isStarting = false;
		this.startPromise = null;
		this.restartCount = 0;
		this.maxRestarts = 3;
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

			setTimeout(async () => {
				try {
					const pong = await this.call("ping", {}, 2000);
					if (pong && pong.status === "alive") {
						this.restartCount = 0;
						logMessage("Python Bridge started", "INFO");
						resolve(true);
					} else {
						resolve(false);
					}
				} catch (e) {
					resolve(false);
				}
			}, 100);
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
		}
	}

	async call(action, params = {}, timeout = 5000) {
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

	async identify(filePath) { return this.call("identify", { path: filePath }); }
	async getFolderInfo(folderPath) { return this.call("folder_info", { path: folderPath }, 15000); }
	async getFolderSize(folderPath) { return this.call("folder_size", { path: folderPath }, 15000); }
	async handleClipboard(targetDir) { return this.call("clipboard", { target_dir: targetDir }, 10000); }
	stop() {
		if (this.process && !this.process.killed) {
			try { this.process.kill(); } catch (e) { }
			this.process = null;
		}
	}
}

const pythonBridge = new PythonBridge();

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

	if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) { vscode.window.showInformationMessage("当前目录下没有 qqq 文件夹"); return; }

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

	// 使用统一正则
	const regex = new RegExp(QQQ_PATH_REGEX);

	for (const fileName of parentDirFiles) {
		const fullPath = path.join(parentDir, fileName);
		if (fileName === "qqq" || fileName === "qqq.pure") continue;

		let stats; try { stats = fs.statSync(fullPath); } catch (e) { continue; }
		if (!stats.isFile()) continue;
		if (!fullPath.includes("qqq")) continue;
		if (isLikelyBinary(fullPath)) continue;

		try {
			const content = fs.readFileSync(fullPath, "utf-8");
			let match;
			regex.lastIndex = 0; // 重置
			while ((match = regex.exec(content)) !== null) {
				const rawPath = match[0].slice(2, -2).trim();

				// 兼容绝对路径和相对路径的匹配
				// 如果是相对路径，我们需要把它转为绝对路径来判断
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
		commandStr = `q rm ${args}`;
	}

	let content = "\n".repeat(13);
	content += "   请在 CMD 窗口中执行下面命令以删除未引用的文件：\n";
	content += "\n".repeat(3);
	content += "   " + commandStr + "\n";
	content += "\n".repeat(3);
	// 写入格式 /\ ... \/
	content += orphanPaths.map((p) => `/\\${p}\\/`).join("\n\n\n\n\n");

	const purePath = path.join(parentDir, "qqq.pure");
	try {
		fs.writeFileSync(purePath, content, "utf-8");
		const doc = await vscode.workspace.openTextDocument(purePath);
		await vscode.window.showTextDocument(doc);
	} catch (e) { vscode.window.showErrorMessage("无法生成 qqq.pure 文件: " + e.message); }
}

let q1Module = null;
let q2Module = null;

async function activate(context) {
	logMessage("qqq 扩展开始激活...", "INFO");
	pythonBridge.start().then((ok) => {
		if (ok) logMessage("Python Bridge 启动成功", "INFO");
		else logMessage("Python Bridge 启动失败，使用 JS 兜底", "WARN");
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
	} catch (e) { logMessage(`q1 模块加载失败: ${e.message}`, "ERROR"); vscode.window.showErrorMessage(`qqq 粘贴功能启动失败: ${e.message}`); }
	try {
		q2Module = require("./q2");
		if (q2Module && typeof q2Module.activate === "function") q2Module.activate(context);
	} catch (e) { logMessage(`q2 模块加载失败: ${e.message}`, "ERROR"); }
	logMessage("qqq 扩展激活完成", "INFO");
}

async function deactivate() {
	pythonBridge.stop();
	if (q1Module && typeof q1Module.deactivate === "function") {
		try { await q1Module.deactivate(); } catch (e) { console.error("Q1 cleanup failed:", e); }
	}
	logMessage("qqq 扩展已停用", "INFO");
}

module.exports = {
	activate,
	deactivate,
	pythonBridge,
	shouldShowDuration,
	logMessage,
	LOG_PATH,
	BASE_DIR,
	QQQ_PATH_REGEX
};


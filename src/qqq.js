// File: src/qqq.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ==================== 公共配置常量 ====================
// 已移除 E:\\r\\pz.ini 相关配置
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";

const outputChannel = vscode.window.createOutputChannel("QQQ Extension");

// ==================== 公共工具函数 ====================

function ensureLogDir() {
	try {
		const dir = path.dirname(LOG_PATH);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		return true;
	} catch (e) {
		outputChannel.appendLine(`[Error] 无法创建日志目录: ${e.message}`);
		return false;
	}
}

function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}`;
	outputChannel.appendLine(line);
	if (level === "ERROR" || level === "WARN") {
		try {
			if (ensureLogDir()) {
				fs.appendFileSync(LOG_PATH, line + "\n");
			}
		} catch (e) {
			console.error("本地日志写入失败:", e);
		}
	}
}

function isLikelyBinary(filePath) {
	const binaryExts = new Set([
		'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif',
		'.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o',
		'.zip', '.tar', '.gz', '.7z', '.rar',
		'.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav',
		'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
	]);

	const ext = path.extname(filePath).toLowerCase();
	if (binaryExts.has(ext)) {
		return true;
	}

	try {
		const buffer = Buffer.alloc(4096);
		const fd = fs.openSync(filePath, 'r');
		try {
			const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
			if (bytesRead === 0) return false;
			for (let i = 0; i < bytesRead; i++) {
				if (buffer[i] === 0) {
					return true;
				}
			}
			return false;
		} finally {
			fs.closeSync(fd);
		}
	} catch (e) {
		return true;
	}
}

// ==================== qqq.pure 命令逻辑 ====================

async function pureComknd() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage("请先打开一个文件以确定工作目录");
		return;
	}

	const currentDocPath = editor.document.uri.fsPath;
	const parentDir = path.dirname(currentDocPath);
	const qqqDir = path.join(parentDir, "qqq");

	if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) {
		vscode.window.showInformationMessage("当前目录下没有 qqq 文件夹");
		return;
	}

	let qqqFiles = [];
	try {
		qqqFiles = fs.readdirSync(qqqDir).filter(f => {
			const fullPath = path.join(qqqDir, f);
			return fs.statSync(fullPath).isFile();
		});
	} catch (e) {
		vscode.window.showErrorMessage("读取 qqq 目录失败: " + e.message);
		return;
	}

	if (qqqFiles.length === 0) {
		vscode.window.showInformationMessage("qqq 文件夹是空的");
		return;
	}

	const referencedFiles = new Set();
	let parentDirFiles = [];

	try {
		parentDirFiles = fs.readdirSync(parentDir);
	} catch (e) {
		vscode.window.showErrorMessage("读取当前目录失败: " + e.message);
		return;
	}

	const regex = /\[([A-Za-z]:[\\\/].*?)\]/g;

	for (const fileName of parentDirFiles) {
		const fullPath = path.join(parentDir, fileName);

		if (fileName === "qqq") continue;
		if (fileName === "qqq.pure") continue;

		let stats;
		try {
			stats = fs.statSync(fullPath);
		} catch (e) { continue; }

		if (!stats.isFile()) continue;

		if (isLikelyBinary(fullPath)) {
			continue;
		}

		try {
			const content = fs.readFileSync(fullPath, 'utf-8');
			let match;
			while ((match = regex.exec(content)) !== null) {
				const refPath = match[1].replace(/\//g, "\\");
				if (refPath.toLowerCase().startsWith(qqqDir.toLowerCase())) {
					const refFileName = path.basename(refPath);
					referencedFiles.add(refFileName.toLowerCase());
				}
			}
		} catch (e) {
		}
	}

	const orphans = qqqFiles.filter(f => !referencedFiles.has(f.toLowerCase()));

	if (orphans.length === 0) {
		vscode.window.showInformationMessage("未发现孤儿文件");
		return;
	}

	const newLine = "\n";
	const prefixSpaces = "   ";

	let comkndStr = "";
	const orphanPaths = orphans.map(f => path.join(qqqDir, f));

	if (os.platform() === 'win32') {
		const args = orphanPaths.map(p => `"${p}"`).join(" ");
		comkndStr = `del ${args}`;
	} else {
		const args = orphanPaths.map(p => `"${p}"`).join(" ");
		comkndStr = `q rm ${args}`; // sudo -> q
	}

	let content = "";

	for (let i = 0; i < 13; i++) content += newLine;
	content += prefixSpaces + "请在 CMD 窗口中执行下面命令以 删除 当前未引用滴文件：" + newLine;

	for (let i = 0; i < 3; i++) content += newLine;
	content += prefixSpaces + comkndStr + newLine;

	for (let i = 0; i < 3; i++) content += newLine;

	const orphanListStr = orphanPaths.map(p => `[${p}]`).join(newLine + newLine + newLine + newLine + newLine);
	content += orphanListStr;

	const purePath = path.join(parentDir, "qqq.pure");
	try {
		fs.writeFileSync(purePath, content, 'utf-8');
		const doc = await vscode.workspace.openTextDocument(purePath);
		await vscode.window.showTextDocument(doc);
	} catch (e) {
		vscode.window.showErrorMessage("无法生成 qqq.pure 文件: " + e.message);
	}
}

// ==================== 模块激活入口 ====================

// 定义外部引用，方便在 deactivate 中调用
let q1Module = null;

function activate(context) {
	logMessage("QQQ 扩展开始激活...", "INFO");

	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.pure", pureComknd)
	);

	// --- 加载 Q1 模块 ---
	try {
		const q1 = require('./q1');
		if (q1 && typeof q1.activate === 'function') {
			q1.activate(context);
			q1Module = q1; // 保存引用
		}
	} catch (e) {
		logMessage(`q1 模块加载失败: ${e.message}`, "ERROR");
		vscode.window.showErrorMessage(`QQQ插件警告: 粘贴功能启动失败。原因: ${e.message}`);
	}

	// --- 加载 Q2 模块 ---
	try {
		const q2 = require('./q2');
		if (q2 && typeof q2.activate === 'function') {
			q2.activate(context);
		}
	} catch (e) {
		logMessage(`q2 模块加载失败: ${e.message}`, "ERROR");
	}

	logMessage("QQQ 扩展激活流程结束", "INFO");
}

async function deactivate() {
	// 优雅退出：调用 q1 的 deactivate 来记录用户使用时长
	if (q1Module && typeof q1Module.deactivate === 'function') {
		try {
			await q1Module.deactivate();
		} catch (e) {
			console.error("Q1 cleanup failed:", e);
		}
	}
	logMessage("QQQ 扩展已停用", "INFO");
}

module.exports = {
	activate,
	deactivate,
	LOG_PATH,
	BASE_DIR,
	logMessage
};

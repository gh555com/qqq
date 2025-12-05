const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ==================== 公共配置常量 ====================
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const CONFIG_PATH = "E:\\r\\pz.ini";
const SIZE_CONFIG_KEY = "size_mode";

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

/**
 * 判断文件是否疑似二进制文件
 * 策略：
 * 1. 检查常见二进制扩展名
 * 2. 如果扩展名未知或无扩展名，读取前 4096 字节，查找 null byte (0x00)
 */
function isLikelyBinary(filePath) {
	// 1. 常见二进制扩展名列表（快速过滤）
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

	// 2. 字节检测（针对无后缀文件或未知后缀文件）
	try {
		const buffer = Buffer.alloc(4096);
		const fd = fs.openSync(filePath, 'r');
		try {
			const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
			// 只有空文件不算二进制
			if (bytesRead === 0) return false;

			// 扫描 null byte
			for (let i = 0; i < bytesRead; i++) {
				if (buffer[i] === 0) {
					return true; // 发现 null byte，认为是二进制
				}
			}
			return false; // 未发现 null byte，认为是文本
		} finally {
			fs.closeSync(fd);
		}
	} catch (e) {
		// 读取出错，保守起见视为二进制，避免报错
		return true;
	}
}

// ==================== qqq.pure 命令逻辑 ====================

async function pureCommand() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage("请先打开一个文件以确定工作目录");
		return;
	}

	const currentDocPath = editor.document.uri.fsPath;
	const parentDir = path.dirname(currentDocPath);
	const qqqDir = path.join(parentDir, "qqq");

	// 1. 检查 qqq 目录是否存在
	if (!fs.existsSync(qqqDir) || !fs.statSync(qqqDir).isDirectory()) {
		vscode.window.showInformationMessage("当前目录下没有 qqq 文件夹");
		return;
	}

	// 2. 获取 qqq 目录下的所有文件 (作为候选孤儿)
	let qqqFiles = [];
	try {
		qqqFiles = fs.readdirSync(qqqDir).filter(f => {
			const fullPath = path.join(qqqDir, f);
			// 确保是文件而不是子目录
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

	// 3. 扫描父目录下所有文件，寻找引用
	const referencedFiles = new Set();
	let parentDirFiles = [];

	try {
		parentDirFiles = fs.readdirSync(parentDir);
	} catch (e) {
		vscode.window.showErrorMessage("读取当前目录失败: " + e.message);
		return;
	}

	// 匹配 [X:\path\to\qqq\filename.ext]
	const regex = /\[([A-Za-z]:[\\\/].*?)\]/g;

	for (const fileName of parentDirFiles) {
		const fullPath = path.join(parentDir, fileName);

		// 忽略 qqq 目录本身
		if (fileName === "qqq") continue;
		// 忽略 qqq.pure 文件本身（防止读取上一轮生成的垃圾）
		if (fileName === "qqq.pure") continue;

		// 检查是否为文件
		let stats;
		try {
			stats = fs.statSync(fullPath);
		} catch (e) { continue; }

		if (!stats.isFile()) continue;

		// 关键步骤：智能判断是否为二进制文件
		// 如果是二进制文件（图片、exe、无后缀的二进制数据等），跳过扫描
		if (isLikelyBinary(fullPath)) {
			// outputChannel.appendLine(`跳过二进制文件: ${fileName}`);
			continue;
		}

		// 是文本文件，读取内容扫描
		try {
			const content = fs.readFileSync(fullPath, 'utf-8');
			let match;
			while ((match = regex.exec(content)) !== null) {
				const refPath = match[1].replace(/\//g, "\\"); // 统一为 Windows 反斜杠
				// 检查引用是否指向当前的 qqq 目录
				if (refPath.toLowerCase().startsWith(qqqDir.toLowerCase())) {
					const refFileName = path.basename(refPath);
					referencedFiles.add(refFileName.toLowerCase());
				}
			}
		} catch (e) {
			// 读取失败，忽略
		}
	}

	// 4. 找出孤儿文件 (在 qqq 中存在，但未被引用的)
	const orphans = qqqFiles.filter(f => !referencedFiles.has(f.toLowerCase()));

	if (orphans.length === 0) {
		vscode.window.showInformationMessage("未发现孤儿文件");
		return;
	}

	// 5. 生成 qqq.pure 内容
	const newLine = "\n";
	const prefixSpaces = "   "; // 3个空格

	// 构建删除命令
	let commandStr = "";
	const orphanPaths = orphans.map(f => path.join(qqqDir, f));

	if (os.platform() === 'win32') {
		// Windows: del "path1" "path2"
		const args = orphanPaths.map(p => `"${p}"`).join(" ");
		commandStr = `del ${args}`;
	} else {
		// Linux/Mac: rm "path1" "path2"
		const args = orphanPaths.map(p => `"${p}"`).join(" ");
		commandStr = `rm ${args}`;
	}

	let content = "";

	// 第一块：13个空行 + 提示语
	for (let i = 0; i < 13; i++) content += newLine;
	content += prefixSpaces + "请在 CMD 窗口中执行下面命令以 删除 当前未引用滴文件：" + newLine;

	// 第二块：3个空行 + 命令
	for (let i = 0; i < 3; i++) content += newLine;
	content += prefixSpaces + commandStr + newLine;

	// 第三块：3个空行 + 孤儿文件列表
	for (let i = 0; i < 3; i++) content += newLine;

	// 列表中的每个条目之间间隔4个空行 (即5个newLine)
	const orphanListStr = orphanPaths.map(p => `[${p}]`).join(newLine + newLine + newLine + newLine + newLine);
	content += orphanListStr;

	// 6. 写入并打开文件
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

function activate(context) {
	logMessage("QQQ 扩展开始激活...", "INFO");

	// 注册 qqq.pure 命令
	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.pure", pureCommand)
	);

	// --- 加载 Q1 模块 ---
	try {
		const q1 = require('./q1');
		if (q1 && typeof q1.activate === 'function') {
			q1.activate(context);
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

function deactivate() {
	logMessage("QQQ 扩展已停用", "INFO");
}

module.exports = {
	activate,
	deactivate,
	LOG_PATH,
	BASE_DIR,
	CONFIG_PATH,
	SIZE_CONFIG_KEY,
	logMessage
};

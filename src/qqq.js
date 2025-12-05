const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// ==================== 公共配置常量 ====================
// 注意：这些硬编码路径仅在你本机有效。
// 为了发布后的健壮性，建议将来改为 workspaceStoragePath 或配置项。
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const CONFIG_PATH = "E:\\r\\pz.ini";
const SIZE_CONFIG_KEY = "size_mode";

// 创建 VS Code 输出通道（调试神器）
// 用户可以在 "输出" -> "QQQ Extension" 中看到日志
const outputChannel = vscode.window.createOutputChannel("QQQ Extension");

// ==================== 公共工具函数 ====================

/**
 * 确保日志目录存在
 */
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

/**
 * 强化的日志记录函数
 * 1. 写入 VS Code 底部输出面板 (最安全)
 * 2. 尝试写入 D 盘文件 (你的需求)
 */
function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}`;

	// 1. 总是输出到 VS Code 面板
	outputChannel.appendLine(line);

	// 2. 尝试写入本地文件 (仅当路径存在且可写时)
	if (level === "ERROR" || level === "WARN") {
		try {
			if (ensureLogDir()) {
				fs.appendFileSync(LOG_PATH, line + "\n");
			}
		} catch (e) {
			// 忽略文件写入错误，防止炸崩插件
			console.error("本地日志写入失败:", e);
		}
	}
}

// ==================== 模块激活入口 (核心防弹逻辑) ====================

/**
 * 扩展激活函数
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	logMessage("QQQ 扩展开始激活...", "INFO");

	// --- 加载 Q1 模块 (智能粘贴/图片) ---
	try {
		logMessage("正在尝试加载 q1 模块...", "INFO");
		// 使用 try-catch 包裹 require，防止因 sharp 依赖缺失导致插件直接挂掉
		const q1 = require('./q1');

		if (q1 && typeof q1.activate === 'function') {
			q1.activate(context);
			logMessage("q1 模块激活成功", "INFO");
		} else {
			logMessage("q1 模块已加载，但未找到 activate 函数", "WARN");
		}
	} catch (e) {
		// 捕获严重错误 (如 Cannot find module 'sharp')
		const errorMsg = `q1 模块加载失败: ${e.message}`;
		logMessage(errorMsg, "ERROR");
		logMessage(e.stack, "ERROR");

		// 友好的弹窗提示
		vscode.window.showErrorMessage(`QQQ插件警告: 粘贴功能启动失败。原因: ${e.message}`);
	}

	// --- 加载 Q2 模块 (文件导航/trash) ---
	try {
		logMessage("正在尝试加载 q2 模块...", "INFO");
		const q2 = require('./q2');

		if (q2 && typeof q2.activate === 'function') {
			q2.activate(context);
			logMessage("q2 模块激活成功", "INFO");
		} else {
			logMessage("q2 模块已加载，但未找到 activate 函数", "WARN");
		}
	} catch (e) {
		const errorMsg = `q2 模块加载失败: ${e.message}`;
		logMessage(errorMsg, "ERROR");
		vscode.window.showErrorMessage(`QQQ插件警告: 文件导航功能启动失败。原因: ${e.message}`);
	}

	logMessage("QQQ 扩展激活流程结束", "INFO");
}

/**
 * 扩展停用
 */
function deactivate() {
	logMessage("QQQ 扩展已停用", "INFO");
}

// ==================== 导出 ====================
module.exports = {
	activate,
	deactivate,
	LOG_PATH,
	BASE_DIR,
	CONFIG_PATH,
	SIZE_CONFIG_KEY,
	logMessage
};

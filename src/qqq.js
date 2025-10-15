const fs = require("fs");
const path = require("path");

// ==================== 公共配置常量 ====================
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const CONFIG_PATH = "E:\\r\\pz.ini";
const SIZE_CONFIG_KEY = "size_mode";

// ==================== 公共工具函数 ====================

/**
 * 日志记录函数
 * @param {string} message - 日志消息
 * @param {string} level - 日志级别 (ERROR, WARN)
 */
function logMessage(message, level = "WARN") {
	if (level !== "ERROR" && level !== "WARN") return;
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}\n`;
	try {
		fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
		fs.appendFileSync(LOG_PATH, line);
	} catch (e) {
		console.error("日志写入失败:", e);
	}
}

// ==================== 模块导出 ====================

/**
 * 扩展激活入口
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	// 导入子模块
	const q1 = require('./q1');
	const q2 = require('./q2');

	console.log('qqq 扩展激活中...');
	console.log('q1 module:', q1);
	console.log('q2 module:', q2);

	// 注册 q1 模块的所有命令
	if (q1 && typeof q1.activate === 'function') {
		q1.activate(context);
		console.log('q1.activate 执行完成');
	} else {
		console.error('q1.activate 不存在或不是函数!');
	}

	// 注册 q2 模块的所有命令
	if (q2 && typeof q2.activate === 'function') {
		q2.activate(context);
		console.log('q2.activate 执行完成');
	} else {
		console.error('q2.activate 不存在或不是函数!');
	}

	console.log('所有命令注册完成');
}

/**
 * 扩展停用
 */
function deactivate() {
	// 清理资源
}

// ==================== 导出 ====================
module.exports = {
	activate,
	deactivate,
	// 导出公共配置供子模块使用
	LOG_PATH,
	BASE_DIR,
	CONFIG_PATH,
	SIZE_CONFIG_KEY,
	// 导出公共工具函数
	logMessage
};

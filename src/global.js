// src/global.js - 全局状态、日志和对话框管理
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// 日志相关
let LOG_PATH = null;
const outputChannel = vscode.window.createOutputChannel("qqq extension");

// 状态栏相关
let statusBarItem = null;
let _statusBarTimer = null;

// 统计持久化相关
const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
const KEY_SESSION_START = "qqq_stats_session_start";
const KEY_CACHE_HIT_TOTAL = "qqq_stats_cache_hit_total";
const KEY_CACHE_MISS_TOTAL = "qqq_stats_cache_miss_total";

let _cacheHitTotal = 0;
let _cacheMissTotal = 0;
let _statsFlushTimer = null;
let _statsDirty = false;
let extensionContext = null;

// ============================================================================// ★ 日志降噪（rate-limit）基础设施：同 key 在 interval 内只记一次
// ============================================================================
const _rateLimitLastTs = new Map();
function logMessageRateLimited(key, message, level = "WARN", intervalMs = 5 * 60 * 1000) {
	const now = Date.now();
	const last = _rateLimitLastTs.get(key) || 0;
	if (now - last < intervalMs) return;
	_rateLimitLastTs.set(key, now);
	logMessage(message, level);
}

function _bridgeStderrKey(name, text) {
	const head = String(text || "").replace(/\s+/g, " ").slice(0, 120);
	return `bridge:${name}:${head}`;
}

function rotateLogIfNeeded() {
	if (!LOG_PATH) return;
	
	try {
		const maxLogSize = 8 * 1024 * 1024; // 8MB
		if (fs.existsSync(LOG_PATH)) {
			const stats = fs.statSync(LOG_PATH);
			if (stats.size >= maxLogSize) {
				const oldLogPath = `${LOG_PATH}.1`;
				if (fs.existsSync(oldLogPath)) {
					fs.unlinkSync(oldLogPath);
				}
				fs.renameSync(LOG_PATH, oldLogPath);
			}
		}
	} catch (e) {
		// 日志轮转失败不影响主程序
	}
}

function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}`;
	outputChannel.appendLine(line);

	if ((level === "ERROR" || level === "WARN") && LOG_PATH) {
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			
			// 检查并执行日志轮转
			rotateLogIfNeeded();
			
			fs.appendFileSync(LOG_PATH, line + "\n");
		} catch (e) { }
	}
}

// ============================================================================// ★ 状态栏：永久显示 [qqq: ⏱2222h ▥33m ⊙98% ⚡P]
// - Node：N(D)=daemon / N(S)=spawn
// - Python：P
// - Rust：R
// ============================================================================
function _formatBytes(size) {
	if (size == null || isNaN(size)) return "?";
	const units = ["B", "KB", "MB", "GB"];
	let idx = 0;
	let val = size;
	while (val >= 1024 && idx < units.length - 1) {
		val /= 1024;
		idx++;
	}
	return `${val.toFixed(idx > 0 ? 2 : 0)} ${units[idx]}`;
}

function _formatHours(totalSeconds) {
	const h = totalSeconds / 3600;
	return `${h.toFixed(2)} h`;
}

function _formatCompactTime(totalSeconds) {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	return { h, m };
}

function _cleanReason(s, maxLen = 260) {
	const t = String(s || "").replace(/\s+/g, " ").trim();
	return t.length > maxLen ? t.slice(0, maxLen) + "..." : t;
}

function _collectMismatchReasons(pref, activeState, pythonBridge, rustBridge, shellBridge) {
	const reasons = [];

	const pyReason = _cleanReason(pythonBridge?.lastStartError || pythonBridge?.lastCrashReason || pythonBridge?.lastStderrSnippet);
	const rsReason = _cleanReason(rustBridge?.lastStartError || rustBridge?.lastCrashReason || rustBridge?.lastStderrSnippet);
	const shReason = _cleanReason(shellBridge?.lastStartError || shellBridge?.lastCrashReason || shellBridge?.lastStderrSnippet);

	// Node spawn 代表 shell daemon 没起来：必须带上 shell 原因
	if (activeState.code === "N" && activeState.nodeMode === "S") {
		if (shReason) reasons.push(`Shell daemon：${shReason}`);
		else reasons.push(`Shell daemon：启动失败/不可用`);
	}

	if (pref === "python" && activeState.code !== "P") {
		if (pyReason) reasons.unshift(`Python：${pyReason}`);
		else reasons.unshift(`Python：启动失败/不可用`);
		if (activeState.code === "N") {
			if (rsReason) reasons.push(`Rust：${rsReason}`);
			else reasons.push(`Rust：启动失败/不可用`);
		}
	}

	if (pref === "rust" && activeState.code !== "R") {
		if (rsReason) reasons.unshift(`Rust：${rsReason}`);
		else reasons.unshift(`Rust：启动失败/不可用`);
		if (activeState.code === "N") {
			if (pyReason) reasons.push(`Python：${pyReason}`);
			else reasons.push(`Python：启动失败/不可用`);
		}
	}

	// auto 不是“期待不一致”，但如果最终落到 Node，也可以把失败原因露出来（不强制）
	return reasons;
}

function getActiveEngineState(pythonBridge, rustBridge, shellBridge) {
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

	const py = pythonBridge?.isAvailable?.() === true;
	const rs = rustBridge?.isAvailable?.() === true;
	const sh = shellBridge?.isAvailable?.() === true;

	const pickByOrder = () => {
		for (const e of order) {
			if (e === "python" && py) return { code: "P", name: "Python" };
			if (e === "rust" && rs) return { code: "R", name: "Rust" };
			if (e === "shell") {
				const mode = sh ? "D" : "S";
				return { code: "N", nodeMode: mode, name: mode === "D" ? "Node (Shell daemon)" : "Node (Node spawn)" };
			}
			if (e === "spawn") {
				return { code: "N", nodeMode: "S", name: "Node (Node spawn)" };
			}
		}
		// 兜底
		const mode = sh ? "D" : "S";
		return { code: "N", nodeMode: mode, name: mode === "D" ? "Node (Shell daemon)" : "Node (Node spawn)" };
	};

	return pickByOrder();
}

function getActiveEngineCode(pythonBridge, rustBridge, shellBridge) {
	return getActiveEngineState(pythonBridge, rustBridge, shellBridge).code; // P / R / N
}

function getActiveEngineName(pythonBridge, rustBridge, shellBridge) {
	return getActiveEngineState(pythonBridge, rustBridge, shellBridge).name; // Python / Rust / Node(...
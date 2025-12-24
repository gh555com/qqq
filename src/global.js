// src/global.js - 全局状态、日志和对话框管理
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ============================================================================
// ★ 全局上下文
// ============================================================================
let extensionContext = null;

function init(context) {
	extensionContext = context;
	initUserTracking(context);
}

// ============================================================================
// ★ 日志相关
// ============================================================================
let LOG_PATH = null;
const outputChannel = vscode.window.createOutputChannel("qqq extension");

function setLogPath(p) {
	LOG_PATH = p;
}

function getLogPath() {
	return LOG_PATH;
}

// ★ 日志降噪（rate-limit）基础设施
const _rateLimitLastTs = new Map();
function logMessageRateLimited(key, message, level = "WARN", intervalMs = 5 * 60 * 1000) {
	const now = Date.now();
	const last = _rateLimitLastTs.get(key) || 0;
	if (now - last < intervalMs) return;
	_rateLimitLastTs.set(key, now);
	logMessage(message, level);
}

function bridgeStderrKey(name, text) {
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

			rotateLogIfNeeded();

			fs.appendFileSync(LOG_PATH, line + "\n");
		} catch (e) { }
	}
}

// ============================================================================
// ★ 对话框包装 (qqq 涉及的对话框)
// ============================================================================
function showInformationMessage(message, ...items) {
	return vscode.window.showInformationMessage(message, ...items);
}

function showErrorMessage(message, ...items) {
	return vscode.window.showErrorMessage(message, ...items);
}

function showWarningMessage(message, ...items) {
	return vscode.window.showWarningMessage(message, ...items);
}

function showInputBox(options, token) {
	return vscode.window.showInputBox(options, token);
}

function showQuickPick(items, options, token) {
	return vscode.window.showQuickPick(items, options, token);
}

function showSaveDialog(options) {
	return vscode.window.showSaveDialog(options);
}

function withProgress(options, task) {
	return vscode.window.withProgress(options, task);
}

function showTextDocument(document, column, preserveFocus) {
	return vscode.window.showTextDocument(document, column, preserveFocus);
}

function openExternal(uri) {
	return vscode.env.openExternal(uri);
}

function setStatusBarMessage(text, hideAfterTimeout) {
	return vscode.window.setStatusBarMessage(text, hideAfterTimeout);
}

// ============================================================================
// ★ 统计持久化
// ============================================================================
const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
const KEY_SESSION_START = "qqq_stats_session_start";
const KEY_CACHE_HIT_TOTAL = "qqq_stats_cache_hit_total";
const KEY_CACHE_MISS_TOTAL = "qqq_stats_cache_miss_total";

let _cacheHitTotal = 0;
let _cacheMissTotal = 0;
let _statsFlushTimer = null;
let _statsDirty = false;

function _loadPersistentStats(context) {
	try {
		_cacheHitTotal = context?.globalState?.get(KEY_CACHE_HIT_TOTAL, 0) || 0;
		_cacheMissTotal = context?.globalState?.get(KEY_CACHE_MISS_TOTAL, 0) || 0;
	} catch { }
}

function _scheduleStatsFlush() {
	if (!extensionContext || !_statsDirty) return;
	if (_statsFlushTimer) return;

	_statsFlushTimer = setTimeout(() => {
		_statsFlushTimer = null;
		if (!extensionContext || !_statsDirty) return;
		_statsDirty = false;

		try {
			extensionContext.globalState.update(KEY_CACHE_HIT_TOTAL, _cacheHitTotal);
			extensionContext.globalState.update(KEY_CACHE_MISS_TOTAL, _cacheMissTotal);
		} catch { }
	}, 2000);
}

function markCacheHit() {
	_cacheHitTotal++;
	_statsDirty = true;
	_scheduleStatsFlush();
}

function markCacheMiss() {
	_cacheMissTotal++;
	_statsDirty = true;
	_scheduleStatsFlush();
}

function getPersistentCacheStatsSnapshot() {
	return {
		hitTotal: _cacheHitTotal || 0,
		missTotal: _cacheMissTotal || 0,
	};
}

function initUserTracking(context) {
	context.globalState.update(KEY_SESSION_START, Date.now());
	_loadPersistentStats(context);
}

function finishUserTracking() {
	if (!extensionContext) return;
	const start = extensionContext.globalState.get(KEY_SESSION_START);
	if (start) {
		const diff = (Date.now() - start) / 1000;
		const old = extensionContext.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
		extensionContext.globalState.update(KEY_TOTAL_DURATION, old + (diff > 0 ? diff : 0));
		extensionContext.globalState.update(KEY_SESSION_START, undefined);
	}
	// 强制刷新统计
	if (_statsDirty) {
		try {
			extensionContext.globalState.update(KEY_CACHE_HIT_TOTAL, _cacheHitTotal);
			extensionContext.globalState.update(KEY_CACHE_MISS_TOTAL, _cacheMissTotal);
		} catch { }
	}
}

function getTotalSecondsIncludingSession() {
	if (!extensionContext) return 0;
	const base = extensionContext.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
	const start = extensionContext.globalState.get(KEY_SESSION_START);
	if (!start) return base;
	const diff = (Date.now() - start) / 1000;
	return base + (diff > 0 ? diff : 0);
}

// ============================================================================
// ★ 状态栏管理
// ============================================================================
let statusBarItem = null;

function initStatusBar() {
	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
		statusBarItem.command = "qqq.allSettings";
		if (extensionContext) extensionContext.subscriptions.push(statusBarItem);
		statusBarItem.show();
	}
}

function disposeStatusBar() {
	if (statusBarItem) {
		statusBarItem.dispose();
		statusBarItem = null;
	}
}

function formatBytes(size) {
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

function formatHours(totalSeconds) {
	const h = totalSeconds / 3600;
	return `${h.toFixed(2)} h`;
}

function formatCompactTime(totalSeconds) {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	return { h, m };
}

function cleanReason(s, maxLen = 260) {
	const t = String(s || "").replace(/\s+/g, " ").trim();
	return t.length > maxLen ? t.slice(0, maxLen) + "..." : t;
}

function getEnginePreference() {
	try {
		const config = vscode.workspace.getConfiguration("qqq");
		const v = config.get("ioEngine", "auto");
		if (v === "shell") return "node";
		return v;
	} catch {
		return "auto";
	}
}

function getEngineTryOrder(pref) {
	switch (pref) {
		case "python":
			return ["python", "rust", "shell", "spawn"];
		case "rust":
			return ["rust", "python", "shell", "spawn"];
		case "node":
			return ["node", "shell", "spawn"];
		case "auto":
		default:
			return ["python", "rust", "node", "shell", "spawn"];
	}
}

function collectMismatchReasons(pref, activeState, pythonBridge, rustBridge, shellBridge) {
	const reasons = [];

	const pyReason = cleanReason(pythonBridge?.lastStartError || pythonBridge?.lastCrashReason || pythonBridge?.lastStderrSnippet);
	const rsReason = cleanReason(rustBridge?.lastStartError || rustBridge?.lastCrashReason || rustBridge?.lastStderrSnippet);
	const shReason = cleanReason(shellBridge?.lastStartError || shellBridge?.lastCrashReason || shellBridge?.lastStderrSnippet);

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

	return reasons;
}

function getActiveEngineState(pythonBridge, rustBridge, shellBridge) {
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

	const py = pythonBridge?.isAvailable?.() === true;
	const rs = rustBridge?.isAvailable?.() === true;
	const sh = shellBridge?.isAvailable?.() === true;

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
}

function getActiveEngineCode(pythonBridge, rustBridge, shellBridge) {
	return getActiveEngineState(pythonBridge, rustBridge, shellBridge).code;
}

function getActiveEngineName(pythonBridge, rustBridge, shellBridge) {
	return getActiveEngineState(pythonBridge, rustBridge, shellBridge).name;
}

// ★ 核心更新逻辑：接收外部数据（缓存快照、Bridge对象），渲染状态栏
function updateStatusBar(cacheStatsSnapshot, pythonBridge, rustBridge, shellBridge) {
	if (!statusBarItem) return;

	const totalSeconds = getTotalSecondsIncludingSession();
	const { h, m } = formatCompactTime(totalSeconds);

	const cacheBytes = cacheStatsSnapshot.totalSize;
	const cacheMB = cacheBytes / (1024 * 1024);

	const pstats = getPersistentCacheStatsSnapshot();
	const denom = pstats.hitTotal + pstats.missTotal;
	const hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;

	const pref = getEnginePreference();
	const active = getActiveEngineState(pythonBridge, rustBridge, shellBridge);

	const engineTag =
		active.code === "P"
			? "P"
			: active.code === "R"
				? "R"
				: `N(${active.nodeMode})`;

	// 根据引擎类型选择不同的边框符号
	if (active.code === "P" || active.code === "R") {
		// 使用 ▌ 符号（适用于 P 和 R 引擎）
		statusBarItem.text = ` ▌qqq: ⧖ ${h}h  ▥ ${cacheMB.toFixed(0)}m  ⊙ ${hitRate.toFixed(0)}%  ⚡ ${engineTag} ▌`;
	} else {
		// 使用 ▪ 符号（适用于其他引擎）
		statusBarItem.text = ` ▪ qqq: ⧖ ${h}h  ▥ ${cacheMB.toFixed(0)}m  ⊙ ${hitRate.toFixed(0)}%  ⚡ ${engineTag} ▪ `;
	}

	const mismatchReasons = collectMismatchReasons(pref, active, pythonBridge, rustBridge, shellBridge);
	let mismatchText = "";
	if ((pref === "python" && active.code !== "P") || (pref === "rust" && active.code !== "R")) {
		const expectedName = pref === "python" ? "Python" : "Rust";
		const reasonStr = mismatchReasons.length ? mismatchReasons.join("；") : "未知原因";
		mismatchText = ` ▬ 期待值${expectedName}，启动失败原因：${reasonStr}`;
	}

	const ioLine = `**IO 引擎：** ${active.name}${mismatchText}`;

	const tooltip = new vscode.MarkdownString(
		[
			`<div style="background:#fff !important; color:#000 !important; padding:8px; border-radius:4px; border:1px solid #ddd;">`,
			`**累计使用时间：** ${formatHours(totalSeconds)}`,
			`**磁盘缓存：** ${formatBytes(cacheBytes)}`,
			`**缓存命中率：** ${hitRate.toFixed(2)}%  (hit=${pstats.hitTotal}, miss=${pstats.missTotal})`,
			ioLine,
			`</div>`,
		].join("\n\n")
	);
	tooltip.isTrusted = true;
	tooltip.supportHtml = true;

	statusBarItem.tooltip = tooltip;
	statusBarItem.show();
}

module.exports = {
	init,

	// 日志
	setLogPath,
	getLogPath,
	logMessage,
	logMessageRateLimited,
	bridgeStderrKey,

	// 对话框
	showInformationMessage,
	showErrorMessage,
	showWarningMessage,
	showInputBox,
	showQuickPick,
	showSaveDialog,
	withProgress,
	showTextDocument,
	openExternal,
	setStatusBarMessage,

	// 统计
	markCacheHit,
	markCacheMiss,
	getPersistentCacheStatsSnapshot,
	finishUserTracking,

	// 状态栏
	initStatusBar,
	disposeStatusBar,
	updateStatusBar,

	cleanReason,

	// 引擎辅助 (给外部用)
	getEnginePreference,
	getEngineTryOrder,
	getActiveEngineCode,
	getActiveEngineName,

	// 格式化辅助 (给 CodeLens 等用)
	formatBytes,
	formatHours
};

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process"); // Retain for ffmpeg/spawn if needed by q3 or legacy

const q3 = require("./q3");
const global = require("./global");
const h = require("./h");

// 引用 global.js 的核心对象
const {
	pythonBridge,
	rustBridge,
	shellBridge,
	startDaemons,
	tryOneByOne,
	tryEngineCall,
	updateStatusBarNow,
	pasteQueue,
	metaSaveQueue
} = global;

function createPathRegex() {
	return /\/\\\s*([\s\S]*?)\s*\\\//gi;
}

const CACHE_DIR_NAME = "qqq_cache";
const META_FILE_NAME = "meta.json";
const CACHE_MAX_SIZE = 40 * 1024 * 1024;
const CACHE_TARGET_SIZE = 28 * 1024 * 1024;
const PASTE_SIZE_THRESHOLD = 80 * 1024 * 1024;

const FINGERPRINT_HEAD = 128;
const FINGERPRINT_MID = 128;
const FINGERPRINT_TAIL = 128;

// Keep ffmpeg loading in qqq as it was
let ffmpegPath = null;
let ffprobePath = null;
try {
	const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
	ffmpegPath = ffmpegInstaller.path;
	ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"));
} catch (e) { }

let extensionContext = null;
let cacheDir = null;
let cacheMeta = null;
let _statusBarTimer = null;

// ============================================================================
// Cache Meta Logic (Retained in qqq)
// ============================================================================
function getCacheStatsSnapshot() {
	const s = cacheMeta?.stats || { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };
	return {
		totalSize: s.totalSize || 0,
		fileCount: s.fileCount || 0,
		hitCount: s.hitCount || 0,
		missCount: s.missCount || 0,
	};
}

function _stripDocJunk(s) {
	if (s == null) return "";
	return String(s).trim().replace(/\r/g, "").replace(/\n/g, "");
}

function _getSystemDriveRoot() {
	const sd = process.env.SystemDrive;
	if (sd && /^[A-Za-z]:$/.test(sd)) return sd.toUpperCase() + "\\";
	const up = process.env.USERPROFILE;
	if (up && /^[A-Za-z]:[\\/]/.test(up)) return up.slice(0, 2).toUpperCase() + "\\";
	return "C:\\";
}

function toSafePath(p) {
	if (!p) return "";
	return p.startsWith("\\\\")
		? "\\\\" + p.slice(2).replace(/\\/g, "/")
		: p.replace(/\\/g, "/");
}

function normalizeNavPath(rawPath) {
	let clean = _stripDocJunk(rawPath);
	if (!clean) return "";

	if (clean === "~") clean = os.homedir();
	else if (clean.startsWith("~/") || clean.startsWith("~\\")) {
		clean = path.join(os.homedir(), clean.slice(2));
	}

	const isWin = process.platform === "win32";
	if (!isWin) return path.normalize(clean);

	if (/^[A-Za-z]:$/.test(clean)) return clean.toUpperCase() + "\\";
	if (/^[A-Za-z]:[\\/]*$/.test(clean)) return clean[0].toUpperCase() + ":\\";

	if (clean.startsWith("\\\\") || clean.startsWith("//")) return path.normalize(clean);

	if (/^[A-Za-z]:[\\/]/.test(clean)) {
		const normalized = path.normalize(clean);
		return normalized.replace(/^[a-z]:/, (m) => m.toUpperCase());
	}

	if (clean.startsWith("\\") || clean.startsWith("/")) {
		const sysRoot = _getSystemDriveRoot();
		const rest = clean.replace(/^[\\/]+/, "");
		return path.normalize(path.join(sysRoot, rest));
	}

	return path.normalize(clean);
}

function resolveNavPath(rawPath, baseDir) {
	const clean = normalizeNavPath(rawPath);
	if (!clean) return "";
	if (path.isAbsolute(clean)) return clean;
	const base = baseDir && typeof baseDir === "string" ? baseDir : process.cwd();
	return path.resolve(base, clean);
}

function canonicalizeExistingPath(p) {
	if (!p) return "";
	let out = String(p);

	try {
		if (fs.existsSync(out)) {
			if (fs.realpathSync && fs.realpathSync.native) out = fs.realpathSync.native(out);
			else out = fs.realpathSync(out);
		}
	} catch { }

	out = path.normalize(out);

	if (process.platform === "win32") {
		out = out.replace(/^\\\\\?\\/, "");
		out = out.replace(/^[a-z]:/, (m) => m.toUpperCase());
	}

	try {
		const root = path.parse(out).root;
		if (out.length > root.length) out = out.replace(/[\\/]+$/, "");
	} catch { }

	return out;
}

function cacheKeyForPath(p) {
	const canon = canonicalizeExistingPath(p);
	return process.platform === "win32" ? canon.toLowerCase() : canon;
}

// ============================================================================
// Cache Initialization & Management
// ============================================================================
function initCache(context) {
	cacheDir = path.join(context.globalStorageUri.fsPath, CACHE_DIR_NAME);
	if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
	loadCacheMeta();
	validateCache();
}

function createEmptyMeta() {
	return {
		entries: {},
		stats: { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 },
		brokenFiles: {},
		fileIndex: {} // Persistent Source File Index (Fingerprint -> Path)
	};
}

function loadCacheMeta() {
	const metaPath = path.join(cacheDir, META_FILE_NAME);
	try {
		if (fs.existsSync(metaPath)) {
			cacheMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
			if (!cacheMeta.entries) cacheMeta.entries = {};
			if (!cacheMeta.stats) cacheMeta.stats = { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };
			if (!cacheMeta.brokenFiles) cacheMeta.brokenFiles = {};
			if (!cacheMeta.fileIndex) cacheMeta.fileIndex = {};
		} else {
			cacheMeta = createEmptyMeta();
		}
	} catch (e) {
		cacheMeta = createEmptyMeta();
	}
}

function saveCacheMeta() {
	if (!cacheDir || !cacheMeta) return;

	metaSaveQueue.enqueue(async () => {
		try {
			const data = JSON.stringify(cacheMeta, null, 2);
			const metaPath = path.join(cacheDir, META_FILE_NAME);
			await fs.promises.writeFile(metaPath, data, "utf-8");
		} catch (e) {
			global.logMessage("Meta save failed: " + e.message, "ERROR");
		}
	});
}

function validateCache() {
	if (!cacheDir || !cacheMeta) return;

	let changed = false;
	let realSize = 0;
	let realCount = 0;
	const actualFiles = new Set();

	try {
		const files = fs.readdirSync(cacheDir);
		for (const f of files) {
			if (f !== META_FILE_NAME) actualFiles.add(f);
		}
	} catch (e) { }

	for (const [contentId, entry] of Object.entries(cacheMeta.entries)) {
		if (!entry || typeof entry !== "object") {
			delete cacheMeta.entries[contentId];
			changed = true;
			continue;
		}
		if (!entry.qualities || typeof entry.qualities !== "object") entry.qualities = {};

		for (const [q, qInfo] of Object.entries(entry.qualities)) {
			if (!qInfo) {
				delete entry.qualities[q];
				changed = true;
				continue;
			}

			const fileName = `${contentId}.${q}`;
			const filePath = path.join(cacheDir, fileName);

			if (!actualFiles.has(fileName)) {
				delete entry.qualities[q];
				changed = true;
			} else {
				actualFiles.delete(fileName);
				try {
					const st = fs.statSync(filePath);
					realSize += st.size;
					realCount++;
				} catch (e) {
					delete entry.qualities[q];
					changed = true;
				}
			}
		}

		if (Object.keys(entry.qualities).length === 0) {
			delete cacheMeta.entries[contentId];
			changed = true;
		}
	}

	for (const orphan of actualFiles) {
		try {
			fs.unlinkSync(path.join(cacheDir, orphan));
			changed = true;
		} catch (e) { }
	}

	// Validate Source File Index
	if (cacheMeta.fileIndex) {
		const fps = Object.keys(cacheMeta.fileIndex);
		for (const fp of fps) {
			const p = cacheMeta.fileIndex[fp];
			if (!p || !fs.existsSync(p)) {
				delete cacheMeta.fileIndex[fp];
				changed = true;
			} else {
				// Sync to memory
				h.prefillFingerprint(p, fp);
			}
		}
	}

	cacheMeta.stats.totalSize = realSize;
	cacheMeta.stats.fileCount = realCount;

	if (changed) saveCacheMeta();
}

function ensureCacheSpace(neededBytes) {
	if (!cacheDir || !cacheMeta) return;
	if (cacheMeta.stats.totalSize + neededBytes <= CACHE_MAX_SIZE) return;

	const entries = Object.entries(cacheMeta.entries)
		.map(([contentId, entry]) => ({ contentId, atime: entry?.atime || 0 }))
		.sort((a, b) => a.atime - b.atime);

	while (cacheMeta.stats.totalSize + neededBytes > CACHE_TARGET_SIZE && entries.length > 0) {
		const oldest = entries.shift();
		evictEntry(oldest.contentId);
	}
}

function evictEntry(contentId) {
	const entry = cacheMeta.entries[contentId];
	if (!entry?.qualities) return;

	for (const q of Object.keys(entry.qualities)) {
		const fileName = `${contentId}.${q}`;
		try {
			const filePath = path.join(cacheDir, fileName);
			const st = fs.statSync(filePath);
			cacheMeta.stats.totalSize -= st.size;
			cacheMeta.stats.fileCount--;
			fs.unlinkSync(filePath);
		} catch (e) { }
	}

	delete cacheMeta.entries[contentId];
	saveCacheMeta();
}

function getCacheEntry(contentId) {
	if (!cacheMeta?.entries?.[contentId]) {
		cacheMeta.stats.missCount++;
		return null;
	}
	const entry = cacheMeta.entries[contentId];
	entry.atime = Date.now();
	cacheMeta.stats.hitCount++;
	return entry;
}

function getCacheQualityMeta(contentId, quality) {
	const entry = cacheMeta?.entries?.[contentId];
	const qInfo = entry?.qualities?.[quality];
	return qInfo?.meta || null;
}

function setCacheEntry(contentId, quality, buffer, meta) {
	if (!cacheDir || !cacheMeta) return null;

	if (!cacheMeta.entries[contentId]) {
		cacheMeta.entries[contentId] = { qualities: {}, atime: Date.now(), meta: {} };
	}
	const entry = cacheMeta.entries[contentId];
	if (!entry.qualities) entry.qualities = {};

	const prev = entry.qualities[quality];
	const prevSize = prev?.size || 0;
	const delta = Math.max(0, buffer.length - prevSize);

	ensureCacheSpace(delta);

	const fileName = `${contentId}.${quality}`;
	const filePath = path.join(cacheDir, fileName);

	try {
		const tmpPath = filePath + ".tmp";
		fs.writeFileSync(tmpPath, buffer);
		fs.renameSync(tmpPath, filePath);
	} catch (e) {
		try {
			fs.unlinkSync(filePath + ".tmp");
		} catch { }
		return null;
	}

	entry.qualities[quality] = { size: buffer.length, format: "webp_unified", meta: {} };
	entry.atime = Date.now();
	if (meta) Object.assign(entry.qualities[quality].meta, meta);

	if (!prev) cacheMeta.stats.fileCount++;
	cacheMeta.stats.totalSize = cacheMeta.stats.totalSize - prevSize + buffer.length;

	saveCacheMeta();
	updateStatusBarNow();

	return filePath;
}

function getCachedBuffer(contentId, quality) {
	if (!cacheDir || !cacheMeta) return null;

	const entry = cacheMeta.entries[contentId];
	if (!entry?.qualities?.[quality]) {
		cacheMeta.stats.missCount++;
		global.markCacheMiss();
		updateStatusBarNow();
		return null;
	}

	const fileName = `${contentId}.${quality}`;
	const filePath = path.join(cacheDir, fileName);

	try {
		if (fs.existsSync(filePath)) {
			entry.atime = Date.now();
			cacheMeta.stats.hitCount++;
			global.markCacheHit();
			updateStatusBarNow();
			return fs.readFileSync(filePath);
		}
	} catch (e) { }

	cacheMeta.stats.missCount++;
	global.markCacheMiss();

	delete entry.qualities[quality];
	if (Object.keys(entry.qualities).length === 0) {
		delete cacheMeta.entries[contentId];
	}
	saveCacheMeta();

	updateStatusBarNow();

	return null;
}


// ============================================================================
// Source File Index (Deduplication)
// ============================================================================
function registerSourceFile(filePath) {
	if (!filePath || !fs.existsSync(filePath)) return null;
	const fp = h.computeFingerprint(filePath);
	if (fp) {
		if (!cacheMeta.fileIndex) cacheMeta.fileIndex = {};
		cacheMeta.fileIndex[fp] = filePath;
		h.prefillFingerprint(filePath, fp); // Sync to memory
		saveCacheMeta();
	}
	return fp;
}

function findSourceFile(fingerprint) {
	if (!cacheMeta?.fileIndex) return null;
	const p = cacheMeta.fileIndex[fingerprint];
	if (p && fs.existsSync(p)) return p;
	if (p) {
		// Stale entry
		delete cacheMeta.fileIndex[fingerprint];
		saveCacheMeta();
	}
	return null;
}

// ============================================================================
// Clipboard Logic (Delegated to h.js)
// ============================================================================

// VS Code progress adapter
function makeVsProgressAdapter(progress) {
	let last = 0;
	return (absPct, msg) => {
		const now = Math.max(0, Math.min(100, Number(absPct) || 0));
		const inc = Math.max(0, now - last);
		last = now;
		try { progress.report({ message: msg, increment: inc }); } catch { }
	};
}

async function raceClipboard(targetDir, callback) {
	return pasteQueue.enqueue(async () => {
		try {
			const res = await global.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "qqq: 文件复制...",
				cancellable: true
			}, async (progress, token) => {
				token.onCancellationRequested(() => {
					global.logMessage("粘贴操作被用户取消", "WARN");
				});
				const progCb = makeVsProgressAdapter(progress);

				// ★ Delegate all detection and handling to h.js
				return await h.autoDetectAndPaste(targetDir, progCb, token);
			});

			// ★ 无论结果如何都调用 callback，确保用户能看到结果
			if (res) {
				// 如果所有文件都被跳过，显示警告
				if (res.type === "file_folder" && res.files?.length === 0 && res.folders?.length === 0 && res.skippedCount > 0) {
					global.logMessage(`所有 ${res.skippedCount} 个文件都无法访问，已跳过`, "WARN");
				}
				callback(res, 100);
			}
		} catch (e) {
			global.logMessage(`raceClipboard failed: ${e.message}`, "ERROR");
		}
	});
}

async function handleClipboardFast() {
	return null; // Deprecated / Not used in read code
}

async function handleClipboardSlow(targetDir, qStart = Date.now(), typeHint = null, partialCallback = null, token = null) {
	// Wrapper to match old signature if called directly, but prefer raceClipboard
	return await h.autoDetectAndPaste(targetDir, partialCallback, token);
}


// ============================================================================
// Other Helpers
// ============================================================================

async function getFolderInfo(folderPath) {
	folderPath = canonicalizeExistingPath(folderPath) || folderPath;

	const res = await tryEngineCall({
		python: "folder_info",
		rust: "folder_info"
	}, { path: folderPath }, 15000);
	if (res) return res;

	return getFolderInfoJS(folderPath);
}

async function getFolderInfoJS(folderPath) {
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
						const st = await fs.promises.stat(fullPath);
						totalSize += st.size;
						fileCount++;
						const ext = path.extname(file.name).toLowerCase().replace(".", "") || "no_ext";
						extStats[ext] = (extStats[ext] || 0) + 1;
					} catch { }
				}
			}
		} catch { }
	}

	await walk(folderPath);

	return {
		success: true,
		total_size: totalSize,
		file_count_root: fileCount,
		ext_stats: extStats,
	};
}

function shouldShowDuration(info) {
	return info && (info.type === "video" || info.type === "animated_image") && info.duration > 0.1;
}

let downloadContext = null;

async function downloadVideosFromUrlCommand() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("请先打开一个文档以便插入视频锚点。");
		return;
	}

	const rawUrl = await vscode.window.showInputBox({
		prompt: "直接粘贴 [ 包含视频滴网址 ] ",
		ignoreFocusOut: true,
		placeHolder: "https://...",
		validateInput: (text) => {
			const s = (text || "").trim();
			if (!s) return null;
			if (/\s/.test(s)) return "无效网址";

			// 尝试解析 (支持不带协议头的短链接，如 youtu.be/xxx)
			let toCheck = s;
			if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(s)) {
				toCheck = 'https://' + s;
			}

			try {
				const u = new URL(toCheck);
				// 至少包含一个点或者是 localhost
				if (u.hostname.includes('.') || u.hostname === 'localhost') {
					return null;
				}
			} catch { }

			return "无效的网址格式";
		}
	});
	if (!rawUrl) return;

	const currentDocDir = path.dirname(editor.document.uri.fsPath);
	const targetDir = path.join(currentDocDir, "qqq");
	if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

	const transId = global.TransactionManager.createTransactionId();
	const targetUri = editor.document.uri;

	// ★ 生成 taskTitle（统一任务标识）
	const filePath = editor.document.uri.fsPath;
	const taskNum = await global.TaskCounter.increment(filePath);
	const taskTitle = global.TaskCounter.formatTitle(filePath, taskNum);

	// 1. 立即插入锚点
	await global.TransactionManager.insertAnchor(editor, transId);

	// ★ 保存事务到 globalState
	await global.TransactionManager.saveTransaction({
		id: transId,
		targetDir: targetDir,
		targetUri: targetUri.fsPath,
		tempFiles: [],
		landedFiles: [],
		landedFolders: []
	});

	// 2. 启动带进度条的弹窗任务
	const downloadResult = await global.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "",  // ★ 标题留空，由 VideoMsg.progress 生成完整消息
		cancellable: true
	}, async (progress, token) => {
		// ★ 不在这里调用 rollback，让 downloadEntry 内部的 _cancelTask 统一处理
		token.onCancellationRequested(() => {
			global.logMessage(`任务 ${transId} 被用户取消`, "WARN");
		});

		const VideoDownloadController = require('./VideoDownloadController');
		const controller = new VideoDownloadController(downloadContext, module.exports);

		const progressAdapter = (pct, msg) => {
			progress.report({ message: msg, increment: 0 });
		};

		try {
			// ★ 传递 taskTitle
			const res = await controller.downloadEntry(rawUrl, targetDir, transId, progressAdapter, token, targetUri, taskTitle);

			// 3. 处理结果 & 替换锚点
			if (res && res.landedFiles && res.landedFiles.length > 0) {
				const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
				const relativePaths = res.landedFiles.map(f => {
					const rel = path.relative(currentDocDir, f).replace(/\\/g, '/');
					return `/\\${rel}\\/`;
				});
				const newText = relativePaths.join(eol);

				// 替换锚点
				const replaced = await replaceAnchorInDoc(targetUri, `/__PENDING_${transId}/`, newText);
				if (replaced) {
					await global.TransactionManager.removeTransaction(transId);
					// ★ 成功：返回结果，由外层显示弹窗
				} else {
					// ★ 锚点丢失：回滚并标记
					global.logMessage("锚点替换失败，回滚事务", "ERROR");
					await global.TransactionManager.rollback(transId);
					return { ...res, anchorLost: true };
				}
			} else if (res && res.cancelled) {
				// ★ 已取消：回滚并清理锚点
				await global.TransactionManager.rollback(transId);
				await replaceAnchorInDoc(targetUri, `/__PENDING_${transId}/`, "");
			} else {
				// 下载失败，回滚
				await global.TransactionManager.rollback(transId);
				await replaceAnchorInDoc(targetUri, `/__PENDING_${transId}/`, "");
				return { failed: true };
			}

			return res; // ★ 返回结果给外层

		} catch (e) {
			global.logMessage(`视频下载任务失败: ${e.message}`, "ERROR");
			vscode.window.showErrorMessage(`视频下载失败: ${e.message}`);
			await global.TransactionManager.rollback(transId);
			await replaceAnchorInDoc(targetUri, `/__PENDING_${transId}/`, "");
			return null;
		}
	});

	// ★ 进度弹窗结束后，统一显示最终弹窗（唯一真理源）
	if (downloadResult) {
		if (downloadResult.cancelled) {
			// ★ 取消
			global.TaskMessage.showSimpleToast(`${taskTitle} 已取消并回滚`, 15000, 'cancel');
		} else if (downloadResult.anchorLost) {
			// ★ 锚点丢失
			global.TaskMessage.showSimpleToast(`${taskTitle} 锚点丢失，已回滚`, 15000, 'cancel');
		} else if (downloadResult.failed) {
			// ★ 下载失败
			global.TaskMessage.showSimpleToast(`${taskTitle} 下载失败，已回滚`, 15000, 'cancel');
		} else if (downloadResult.doneMessage) {
			// ★ 成功
			global.TaskMessage.showSimpleToast(downloadResult.doneMessage, 15000, 'success');
		}
	}
}

// ==================== 锚点替换辅助 ====================
async function replaceAnchorInDoc(uri, anchor, newText) {
	try {
		const doc = await vscode.workspace.openTextDocument(uri);
		const text = doc.getText();
		const idx = text.indexOf(anchor);

		if (idx === -1) return false;

		const pos = doc.positionAt(idx);
		const endPos = doc.positionAt(idx + anchor.length);
		const range = new vscode.Range(pos, endPos);

		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, range, newText);
		return await vscode.workspace.applyEdit(edit);
	} catch (e) {
		return false;
	}
}

let q1Module = null;
let q2Module = null;

async function activate(context) {
	global.logMessage("qqq 扩展激活（中控模式）...", "INFO");

	extensionContext = context;
	downloadContext = context;
	global.init(context);

	initCache(context);
	global.setCacheStatsGetter(() => getCacheStatsSnapshot());
	global.setLogPath(path.join(cacheDir, "err.log"));
	global.initStatusBar();
	updateStatusBarNow();

	startDaemons();

	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.pure", q3.pureCommand),
		vscode.commands.registerCommand("qqq.allSettings", () => {
			vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
		}),
		vscode.commands.registerCommand("qqq.downloadVideosFromUrl", downloadVideosFromUrlCommand),

		vscode.workspace.onDidChangeConfiguration((event) => {
			for (const key of Object.keys(global.ConfigManager.getAll())) {
				const fullKey = `qqq.${key}`;
				if (event.affectsConfiguration(fullKey)) {
					const val = vscode.workspace.getConfiguration("qqq").get(key);
					const currentStored = global.ConfigManager.get(key);
					if (val !== currentStored) {
						global.setConfig(key, val).then(() => {
							if (key === "ioEngine" || key === "pythonPath") {
								global.logMessage(`配置变更 (${key})，重启守护进程...`, "INFO");
								startDaemons();
							}
						});
					}
				}
			}
		})
	);

	loadSubModules(context);

	if (_statusBarTimer) clearInterval(_statusBarTimer);
	_statusBarTimer = setInterval(() => {
		try {
			updateStatusBarNow();
		} catch { }
	}, 5000);

	// ★ 启动时恢复/清理事务 (确保上次崩溃留下的垃圾被清理)
	try {
		await global.TransactionManager.recover();
	} catch (e) {
		global.logMessage(`事务恢复失败: ${e.message}`, "ERROR");
	}

	global.logMessage("qqq 扩展激活完成", "INFO");
}

function loadSubModules(context) {
	try {
		q1Module = require("./q1");
		if (q1Module?.activate) q1Module.activate(context);
	} catch (e) {
		global.logMessage(`q1 加载失败: ${e.message}`, "ERROR");
	}

	try {
		q2Module = require("./q2");
		if (q2Module?.activate) q2Module.activate(context);
	} catch (e) {
		global.logMessage(`q2 加载失败: ${e.message}`, "ERROR");
	}
}

async function deactivate() {
	pythonBridge.stop();
	rustBridge.stop();
	shellBridge.stop();

	global.finishUserTracking();

	try {
		if (_statusBarTimer) clearInterval(_statusBarTimer);
		_statusBarTimer = null;
		global.disposeStatusBar();
	} catch { }

	try { validateCache(); } catch { }
	saveCacheMeta();

	if (q1Module?.deactivate) {
		try { await q1Module.deactivate(); } catch { }
	}

	global.logMessage("qqq 扩展已停用", "INFO");
}

const exported = {
	activate,
	deactivate,

	createPathRegex,
	toSafePath,
	// Delegate to h.js
	sanitizeHtml: h.sanitizeHtml,

	normalizeNavPath,
	resolveNavPath,
	canonicalizeExistingPath,
	cacheKeyForPath,

	logMessage: global.logMessage,
	logMessageRateLimited: global.logMessageRateLimited,
	logQ: global.logQ,

	// Delegate to h.js
	computeFingerprint: h.computeFingerprint,
	prefillFingerprint: h.prefillFingerprint,

	initCache,
	validateCache,

	getCacheEntry,
	getCacheQualityMeta,
	getCacheStatsSnapshot,
	getPersistentCacheStatsSnapshot: global.getPersistentCacheStatsSnapshot,

	setCacheEntry,
	getCachedBuffer,

	handleClipboardSlow,

	getFolderInfo,

	// Delegate to h.js
	getTimestampFilename: h.getTimestampFilename,
	isImageExtForClipboard: h.isImageExtForClipboard,

	shouldShowDuration,

	raceClipboard,

	probeScheduler: global.probeScheduler,
	genScheduler: global.genScheduler,

	registerSourceFile,
	findSourceFile,

	getActiveEngineCode: global.getActiveEngineCode,
	getActiveEngineName: global.getActiveEngineName,
	updateStatusBarNow,
};

Object.assign(module.exports, exported);

Object.defineProperty(module.exports, "LOG_PATH", { enumerable: true, get: () => global.getLogPath() });
Object.defineProperty(module.exports, "ffmpegPath", { enumerable: true, get: () => ffmpegPath });
Object.defineProperty(module.exports, "ffprobePath", { enumerable: true, get: () => ffprobePath });

process.on("uncaughtException", (error) => {
	const stack = error.stack || "";
	// ★ 对于文件系统相关的错误，只记录日志不崩溃
	const fsErrorCodes = ['EBUSY', 'EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOSPC'];
	if (error.code && fsErrorCodes.includes(error.code)) {
		global.logMessage(`[文件系统错误] ${error.code}: ${error.message}`, "WARN");
	} else {
		global.logMessage(`未捕获的异常: ${error.message}\n${error.stack}`, "ERROR");
	}
});

process.on("unhandledRejection", (reason) => {
	const msg = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
	// ★ 对于文件系统相关的错误，只记录日志不崩溃
	const fsErrorCodes = ['EBUSY', 'EACCES', 'EPERM', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOSPC'];
	if (reason instanceof Error && reason.code && fsErrorCodes.includes(reason.code)) {
		global.logMessage(`[文件系统错误] ${reason.code}: ${reason.message}`, "WARN");
	} else {
		global.logMessage(`未处理的Promise拒绝: ${msg}`, "ERROR");
	}
});

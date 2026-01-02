const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const h = require('./h');
const { getSharedDownloader } = require('./dow');
const https = require('https');

/**
 * ✅ 进程追踪 + 真取消：不改 dow 模块，也能在用户点“取消”时杀掉 yt-dlp/ffmpeg 等子进程
 * ✅ 推荐：ALS 作用域隔离（彻底不误伤其它扩展）
 *    - 全局只 patch 一次 child_process
 *    - 只有在 runWithTracker(...) 作用域里启动的子进程才会：
 *        * 被 track
 *        * 被强制 detached:false
 *    - 不修改原 options 对象（只做浅拷贝替换）
 */
class ChildProcessTracker {
    constructor() {
        this._procs = new Set();
        this._cancelled = false;
    }

    markCancelled() { this._cancelled = true; }
    isCancelled() { return !!this._cancelled; }

    track(proc) {
        if (!proc || typeof proc.pid !== 'number') return;
        this._procs.add(proc);
        try {
            proc.once('exit', () => this._procs.delete(proc));
            proc.once('close', () => this._procs.delete(proc));
            proc.once('error', () => this._procs.delete(proc));
        } catch (e) { }
    }

    async killAll(reason = '用户取消') {
        this._cancelled = true;

        const pids = [];
        for (const p of Array.from(this._procs)) {
            if (p && typeof p.pid === 'number') pids.push(p.pid);
        }

        // 先温柔一点，再强杀
        for (const pid of pids) {
            await this._killPidTree(pid, false);
        }
        await this._sleep(400);
        for (const pid of pids) {
            await this._killPidTree(pid, true);
        }

        this._procs.clear();
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async _killPidTree(pid, force) {
        if (!pid || typeof pid !== 'number') return;

        const isWin = process.platform === 'win32';
        if (isWin) {
            return new Promise(resolve => {
                const args = ['/PID', String(pid), '/T'];
                if (force) args.push('/F');
                cp.execFile('taskkill', args, { windowsHide: true }, () => resolve());
            });
        }

        try { cp.execFileSync('pkill', [force ? '-KILL' : '-TERM', '-P', String(pid)], { stdio: 'ignore' }); } catch (e) { }
        try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { }
        try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { }
    }

    // ==================== ALS：作用域隔离 ====================
    static _getStore() {
        try {
            if (ChildProcessTracker.__als) return ChildProcessTracker.__als.getStore() || null;
        } catch (e) { }
        // 兜底（极老 Node 才会走到这；正常 VSCode Node 不会用到）
        if (ChildProcessTracker.__fallbackActive) {
            return { tracker: ChildProcessTracker.__fallbackActive, forceDetachedFalse: true };
        }
        return null;
    }

    static async runWithTracker(tracker, fn) {
        ChildProcessTracker.ensurePatched();
        if (!tracker || typeof fn !== 'function') return await fn();

        const store = { tracker, forceDetachedFalse: true };

        if (ChildProcessTracker.__als) {
            return await new Promise((resolve, reject) => {
                ChildProcessTracker.__als.run(store, async () => {
                    try { resolve(await fn()); }
                    catch (e) { reject(e); }
                });
            });
        }

        // 兜底：无 ALS 的老环境（基本不会发生）
        ChildProcessTracker.__fallbackActive = tracker;
        try { return await fn(); }
        finally { ChildProcessTracker.__fallbackActive = null; }
    }

    // ---------- 全局 patch：只 patch 一次 ----------
    static ensurePatched() {
        if (ChildProcessTracker.__patched) return;
        ChildProcessTracker.__patched = true;

        // ALS init
        try { ChildProcessTracker.__als = new AsyncLocalStorage(); } catch (e) { ChildProcessTracker.__als = null; }

        const mod = cp;
        ChildProcessTracker.__origSpawn = mod.spawn.bind(mod);
        ChildProcessTracker.__origExecFile = mod.execFile.bind(mod);
        ChildProcessTracker.__origExec = mod.exec.bind(mod);

        const isPlainObject = (o) => {
            return !!o && typeof o === 'object' && !Array.isArray(o) && !(o instanceof Buffer);
        };

        const forceDetachedFalseIfNeeded = (options) => {
            const store = ChildProcessTracker._getStore();
            if (!store || !store.forceDetachedFalse) return options;

            // 不改原对象：只做浅拷贝
            if (isPlainObject(options)) {
                if (options.detached === false) return options;
                return Object.assign({}, options, { detached: false });
            }
            // 没 options 时无需强加（默认就是 false）
            return options;
        };

        const maybeTrack = (proc) => {
            const store = ChildProcessTracker._getStore();
            if (!store || !store.tracker) return;
            if (typeof store.tracker.track === 'function') store.tracker.track(proc);
        };

        const wrapSpawn = function (...args) {
            // spawn(file, args?, options?)
            // options 可能在 args[2] 或 args[1]
            let newArgs = args;

            const optIdx =
                (args.length >= 3 && isPlainObject(args[2])) ? 2 :
                    (args.length >= 2 && isPlainObject(args[1])) ? 1 :
                        -1;

            if (optIdx !== -1) {
                const patchedOpt = forceDetachedFalseIfNeeded(args[optIdx]);
                if (patchedOpt !== args[optIdx]) {
                    newArgs = args.slice();
                    newArgs[optIdx] = patchedOpt;
                }
            } else {
                // 没 options：不需要做任何事
            }

            const p = ChildProcessTracker.__origSpawn(...newArgs);
            maybeTrack(p);
            return p;
        };

        const wrapExecFile = function (...args) {
            // execFile(file[, args][, options][, callback])
            let newArgs = args;

            // options 可能在 args[2] 或 args[1]
            const optIdx =
                (args.length >= 3 && isPlainObject(args[2])) ? 2 :
                    (args.length >= 2 && isPlainObject(args[1])) ? 1 :
                        -1;

            if (optIdx !== -1) {
                const patchedOpt = forceDetachedFalseIfNeeded(args[optIdx]);
                if (patchedOpt !== args[optIdx]) {
                    newArgs = args.slice();
                    newArgs[optIdx] = patchedOpt;
                }
            }

            const p = ChildProcessTracker.__origExecFile(...newArgs);
            maybeTrack(p);
            return p;
        };

        const wrapExec = function (...args) {
            // exec(command[, options][, callback])
            let newArgs = args;

            const optIdx = (args.length >= 2 && isPlainObject(args[1])) ? 1 : -1;
            if (optIdx !== -1) {
                const patchedOpt = forceDetachedFalseIfNeeded(args[optIdx]);
                if (patchedOpt !== args[optIdx]) {
                    newArgs = args.slice();
                    newArgs[optIdx] = patchedOpt;
                }
            }

            const p = ChildProcessTracker.__origExec(...newArgs);
            maybeTrack(p);
            return p;
        };

        mod.spawn = wrapSpawn;
        mod.execFile = wrapExecFile;
        mod.exec = wrapExec;
    }
}
ChildProcessTracker.__patched = false;
ChildProcessTracker.__origSpawn = null;
ChildProcessTracker.__origExecFile = null;
ChildProcessTracker.__origExec = null;
ChildProcessTracker.__als = null;
ChildProcessTracker.__fallbackActive = null;

class VideoDownloadController {
    constructor(context) {
        this.context = context;
        this.downloader = getSharedDownloader();
        this.outputChannel = vscode.window.createOutputChannel("qqq: Video Downloader");

        this.chromeHome = this.context.globalStorageUri.fsPath;
        this.userDataDir = path.join(this.chromeHome, 'user-data');

        this.KEY_CUSTOM_BROWSER = 'customBrowserPath';
        this.KEY_DEDICATED_BROWSER = 'dedicatedChromeExePath';

        // 当前任务上下文（用于总耗时 + 真取消）
        this._task = null;

        ChildProcessTracker.ensurePatched();
    }

    log(msg) {
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    _formatBytesSimple(bytes) {
        if (!bytes || bytes <= 0) return "0k";
        const k = 1024;
        const m = 1024 * 1024;
        if (bytes >= m) return Math.round(bytes / m) + "m";
        return Math.round(bytes / k) + "k";
    }

    // ✅ 修正：总耗时 < 1 分钟时，不输出 0m+
    _formatDuration(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        let s = total % 60;
        let m = Math.floor(total / 60);
        let h = Math.floor(m / 60);
        m = m % 60;

        if (h > 0) return `${h}h+${m}m+${s}s`;
        if (m > 0) return `${m}m+${s}s`;
        return `${s}s`;
    }

    _parseSizeToBytes(sizeStr) {
        if (!sizeStr) return 0;
        const match = sizeStr.match(/([\d\.]+)([KMGTiB]+)/i);
        if (!match) return 0;
        const val = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        let multiplier = 1;
        if (unit.startsWith('K')) multiplier = 1024;
        else if (unit.startsWith('M')) multiplier = 1024 * 1024;
        else if (unit.startsWith('G')) multiplier = 1024 * 1024 * 1024;
        return Math.floor(val * multiplier);
    }

    _makeUrlSnippet(url) {
        const s = String(url || '');
        return s.length > 44 ? s.slice(0, 44) + "..." : s;
    }

    _sanitizeFilename(title) {
        if (!title) return null;
        let safe = title.replace(/[\\/:*?"<>|]/g, "_");
        safe = safe.replace(/\s+/g, " ").trim();
        if (safe.length > 80) safe = safe.substring(0, 80);
        return safe;
    }

    _isForbidden(code, error) {
        return code === 403 || code === 401 || (error && error.toString().includes('403'));
    }

    _deduplicateTasks(tasks) {
        const seen = new Set();
        return tasks.filter(t => {
            if (!t.url) return false;
            if (seen.has(t.url)) return false;
            seen.add(t.url);
            return true;
        });
    }

    _createTask(videoUrl, title, targetDir, referer) {
        let destPath = null;
        let fileName = null;

        if (title && title !== 'Direct Link' && title !== 'Web Resource') {
            fileName = this._sanitizeFilename(title) + ".mp4";
        } else {
            try {
                const u = new URL(videoUrl);
                const base = path.basename(u.pathname);
                if (base && base.match(/\.(mp4|webm|mkv|mov|flv|avi|wmv|m4v|mpg|mpeg|3gp|ts|ogv)$/i)) {
                    fileName = decodeURIComponent(base);
                }
            } catch (e) { }

            if (!fileName || fileName.length > 50 || !/^[a-zA-Z0-9._-]+$/.test(fileName)) {
                fileName = h.getTimestampFilename('.mp4');
            }
        }

        if (fileName) destPath = path.join(targetDir, fileName);

        const headers = {};
        if (referer) headers["Referer"] = referer;

        return {
            url: videoUrl,
            destPath: destPath,
            kind: "video",
            baseDir: targetDir,
            headers: headers
        };
    }

    // ==================== 网址宽松校验：明显不是网址就拦截 ====================
    _normalizeAndValidateUrl(raw) {
        let s = String(raw || '').trim();
        if (!s) return { ok: false };

        // 任何空白字符都直接判定为非网址（“自定义按钮 123”之类）
        if (/\s/.test(s)) return { ok: false };

        // 宽松修正：https:/xxx -> https://xxx
        s = s.replace(/^(https?):\/(?!\/)/i, '$1://');

        try {
            const u = new URL(s);
            if (u.protocol === 'http:' || u.protocol === 'https:') {
                const host = (u.hostname || '').trim();
                if (host === 'localhost' || host.includes('.') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
                    return { ok: true, url: u.toString() };
                }
            }
        } catch (e) { }

        const domainLike = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/;
        if (domainLike.test(s)) {
            try {
                const u2 = new URL('https://' + s);
                return { ok: true, url: u2.toString() };
            } catch (e) { }
        }

        return { ok: false };
    }

    // ✅ 识别 YouTube（彻底排除增强：前置排除 + 最终兜底）
    _isYouTubeUrl(rawUrl) {
        try {
            const u = new URL(String(rawUrl || ''));
            const host = (u.hostname || '').toLowerCase();
            if (host === 'youtu.be' || host.endsWith('.youtu.be')) return true;
            if (host === 'youtube.com' || host.endsWith('.youtube.com')) return true;
            if (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    // ==================== 选中最大视频文件优先 ====================
    _pickFirstFileBySize(paths) {
        if (!paths || paths.length === 0) return null;
        let best = null;
        let bestSize = -1;
        for (const p of paths) {
            try {
                if (!fs.existsSync(p)) continue;
                const s = fs.statSync(p);
                if (!s.isFile()) continue;
                if (s.size > bestSize) {
                    bestSize = s.size;
                    best = p;
                }
            } catch (e) { }
        }
        return best || paths[0] || null;
    }

    async _revealFileOrFolder(filePath, folderPath) {
        try {
            if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
                return;
            }
        } catch (e) { }

        try {
            if (folderPath && fs.existsSync(folderPath)) {
                await vscode.env.openExternal(vscode.Uri.file(folderPath));
                return;
            }
        } catch (e) { }

        try {
            if (process.platform === 'win32' && folderPath && fs.existsSync(folderPath)) {
                cp.execFile('explorer.exe', [folderPath], { windowsHide: true }, () => { });
            }
        } catch (e) { }
    }

    // ==================== 关闭通知（自动消失用） ====================
    async _hideToastsBestEffort() {
        const cmds = [
            'notifications.hideToasts',
            'workbench.action.closeMessages',
            'notifications.clearAll'
        ];
        for (const c of cmds) {
            try {
                await vscode.commands.executeCommand(c);
                return;
            } catch (e) { }
        }
    }

    // ==================== 三号弹窗：无效网址（9秒关闭） ====================
    async _showInvalidUrlToast() {
        const msg = ` qqq: 无效网址。`;
        this.log(msg);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "",
            cancellable: true
        }, async (progress, token) => {
            progress.report({ message: msg });

            let done = false;
            return await new Promise((resolve) => {
                const finish = async () => {
                    if (done) return;
                    done = true;
                    resolve(null);
                };
                token.onCancellationRequested(() => finish());
                setTimeout(() => finish(), 9000);
            });
        });
    }

    // ==================== 三号弹窗：任务结束（带按钮 + 15秒自动关） ====================
    async _showTaskDoneToast(message, canOpen, filePath, folderPath) {
        const OPEN = "[打开下载目录]";
        const actions = canOpen ? [OPEN] : [];

        const p = vscode.window.showInformationMessage(message, ...actions);

        let timer = null;
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => resolve(undefined), 15000);
        });

        const choice = await Promise.race([p, timeout]);
        try { if (timer) clearTimeout(timer); } catch (e) { }

        if (choice === OPEN) {
            await this._revealFileOrFolder(filePath, folderPath);
        }

        await this._hideToastsBestEffort();
    }

    // ==================== downloader 内部弹窗屏蔽 ====================
    async _runWithSuppressedPopups(fn) {
        const win = vscode.window;

        const origInfo = win.showInformationMessage;
        const origWarn = win.showWarningMessage;
        const origErr = win.showErrorMessage;

        const suppress = async () => undefined;

        win.showInformationMessage = async () => suppress();
        win.showWarningMessage = async () => suppress();
        win.showErrorMessage = async () => suppress();

        try {
            return await fn();
        } finally {
            win.showInformationMessage = origInfo;
            win.showWarningMessage = origWarn;
            win.showErrorMessage = origErr;
        }
    }

    // ==================== 任务上下文：总耗时 + 真取消 ====================
    _beginTask() {
        if (this._task && this._task.tracker && !this._task.tracker.isCancelled()) {
            try { this._task.tracker.killAll('新任务覆盖'); } catch (e) { }
        }

        const task = {
            startMs: Date.now(),
            tracker: new ChildProcessTracker()
        };
        this._task = task;

        return task;
    }

    async _cancelTask(reason = '用户取消') {
        const t = this._task;
        if (!t || !t.tracker) return;
        if (t.tracker.isCancelled()) return;

        t.tracker.markCancelled();

        try {
            if (typeof this.downloader.cancelAll === 'function') {
                await this.downloader.cancelAll();
            }
        } catch (e) { }

        try {
            await t.tracker.killAll(reason);
        } catch (e) { }

        this.log(`qqq: 已取消（${reason}）`);
    }

    _isCancelled() {
        return !!(this._task && this._task.tracker && this._task.tracker.isCancelled());
    }

    _endTask() {
        this._task = null;
    }

    // ==================== 任务结束打印（严格文本，不带 command 垃圾） ====================
    _buildDoneMessage(landedCount, totalStr, urlSnippet) {
        const dur = this._formatDuration(Date.now() - (this._task?.startMs || Date.now()));

        if (!landedCount || landedCount <= 0) {
            return ` qqq: 任务结束（总耗时${dur}），0 落盘，从 ${urlSnippet}`;
        }
        return ` qqq: 任务结束（总耗时${dur}） [打开下载目录]，共落盘${landedCount}个视频共: ${totalStr}，从 ${urlSnippet}`;
    }

    // ==================== start ====================
    async start() {
        const raw = await vscode.window.showInputBox({
            prompt: "直接粘贴 [ 包含视频滴网址 ] ",
            ignoreFocusOut: true,
            placeHolder: "https://..."
        });
        if (!raw) return;

        const task = this._beginTask();

        try {
            const v = this._normalizeAndValidateUrl(raw);
            if (!v.ok) {
                await this._showInvalidUrlToast();
                return;
            }

            const url = v.url;

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("请先打开一个文档以便插入视频。");
                return;
            }

            const currentDocDir = path.dirname(editor.document.uri.fsPath);
            const targetDir = path.join(currentDocDir, "qqq");
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

            this.log(`开始处理: ${url}`);
            this.outputChannel.show(true);

            // ✅ 关键：只在这条 async 调用链里生效（ALS）
            await ChildProcessTracker.runWithTracker(task.tracker, async () => {
                // 异步确保 yt-dlp（也在 ALS 内启动 => 若内部 spawn，会被 track）
                this.downloader.ensureYtdlpReady(this.context).catch(e => console.error(e));
                await this._fastProcess(url, targetDir);
            });

        } finally {
            this._endTask();
        }
    }

    // ==================== 普通流程：一号 + 三号 ====================
    async _fastProcess(url, targetDir) {
        try {
            const urlSnippet = this._makeUrlSnippet(url);
            const isYouTube = this._isYouTubeUrl(url);

            const outcome = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "",
                cancellable: true
            }, async (progress, token) => {
                progress.report({ message: `已交换 0k 于 ${urlSnippet} (正在解析...)` });

                token.onCancellationRequested(async () => {
                    await this._cancelTask('用户在一号窗口点取消');
                });

                this.log("正在智能嗅探资源...");
                let tasks = [];

                let probeForbidden = false;
                try {
                    if (this._isCancelled()) return null;

                    const res = await this.downloader.probe(url);

                    if (this._isCancelled()) return null;

                    if (res && res.success) {
                        if (res.isPlaylist && res.entries && res.entries.length > 0) {
                            this.log(`识别为列表，共 ${res.entries.length} 个视频。`);
                            tasks = res.entries.map(e => this._createTask(e.url || e.webpage_url, e.title, targetDir, url));
                        } else {
                            this.log(`识别为单个视频: ${res.title}`);
                            tasks.push(this._createTask(res.url || res.webpageUrl || url, res.title, targetDir, url));
                        }
                    } else {
                        if (this._isForbidden(403, res?.error)) {
                            if (!isYouTube) {
                                probeForbidden = true;
                                this.log("探测返回 403，尝试直接加入下载队列以触发增强流程。");
                                tasks.push(this._createTask(url, null, targetDir, url));
                            } else {
                                // ✅ 前置排除：YouTube 的 403 不作为增强信号
                                this.log("YouTube 探测 403：忽略增强触发（仍尝试交给 yt-dlp 直接下载）。");
                                tasks.push(this._createTask(url, null, targetDir, url));
                            }
                        } else {
                            this.log(`yt-dlp 探测未发现资源或不支持: ${res?.error}`);
                        }
                    }
                } catch (e) {
                    if (this._isCancelled()) return null;
                    this.log(`yt-dlp 探测异常: ${e.message}`);
                }

                // 静态分析（保留）
                try {
                    if (this._isCancelled()) return null;
                    const webUrls = await h.extractVideoUrlsFromWebPage(url);
                    if (webUrls && webUrls.length > 0) {
                        this.log(`静态分析发现 ${webUrls.length} 个资源链接。`);
                        webUrls.forEach(u => tasks.push(this._createTask(u, 'Web Resource', targetDir, url)));
                    }
                } catch (e) { }

                if (this._isCancelled()) return null;

                tasks = this._deduplicateTasks(tasks);

                if (tasks.length === 0) {
                    this.log("未探测到明确资源，尝试直接下载原链接...");
                    tasks.push(this._createTask(url, 'Direct Link', targetDir, url));
                }

                this.log(`准备下载 ${tasks.length} 个任务...`);
                progress.report({ message: `已交换 0k 于 ${urlSnippet}` });

                const activePrefixes = new Set();
                tasks.forEach(t => {
                    if (t.destPath) {
                        const name = path.basename(t.destPath, path.extname(t.destPath));
                        if (name) activePrefixes.add(name);
                    }
                });

                let diskTotalBytes = 0;
                let logTotalBytes = 0;
                const logProgressMap = new Map();

                let fileSizeTimer = null;

                try {
                    fileSizeTimer = setInterval(() => {
                        if (this._isCancelled()) return;

                        let currentDiskBytes = 0;
                        try {
                            if (fs.existsSync(targetDir)) {
                                const files = fs.readdirSync(targetDir);
                                for (const f of files) {
                                    for (const prefix of activePrefixes) {
                                        if (f.startsWith(prefix)) {
                                            try {
                                                const s = fs.statSync(path.join(targetDir, f));
                                                if (s.isFile()) currentDiskBytes += s.size;
                                            } catch (e) { }
                                            break;
                                        }
                                    }
                                }
                            }
                        } catch (e) { }
                        diskTotalBytes = currentDiskBytes;

                        const finalBytes = Math.max(diskTotalBytes, logTotalBytes);
                        const totalStr = this._formatBytesSimple(finalBytes);
                        progress.report({ message: `已交换 ${totalStr} 于 ${urlSnippet}` });
                    }, 500);

                    if (this._isCancelled()) return null;

                    let res;
                    try {
                        res = await this._runWithSuppressedPopups(async () => {
                            return await this.downloader.downloadAll(tasks, targetDir, {
                                downloadVideos: "all",
                                onProgress: (task, event) => {
                                    if (this._isCancelled()) return;

                                    if (event.type === 'start') {
                                        this.log(`开始: ${String(task.url).slice(0, 60)}...`);
                                    } else if (event.type === 'progress') {
                                        const p = event.progress;
                                        let currentBytes = 0;
                                        if (typeof p === 'object' && p.currentSize) {
                                            currentBytes = this._parseSizeToBytes(p.currentSize);
                                        }
                                        if (currentBytes > 0) {
                                            logProgressMap.set(task.url, currentBytes);
                                            let sum = 0;
                                            for (const b of logProgressMap.values()) sum += b;
                                            logTotalBytes = sum;
                                        }
                                    } else if (event.type === 'done') {
                                        this.log(`完成: ${path.basename(task.destPath || '')}`);
                                    } else if (event.type === 'error') {
                                        this.log(`失败: ${task.url} - ${event.error}`);
                                    } else if (event.type === 'retry') {
                                        this.log(`重试: ${task.url} (Wait ${event.delayMs}ms)`);
                                    }
                                }
                            });
                        });
                    } catch (e) {
                        if (this._isCancelled()) return null;
                        throw e;
                    }

                    if (this._isCancelled()) return null;

                    const results = res?.results || [];
                    const successResults = results.filter(r => r.success);
                    const failResults = results.filter(r => !r.success);

                    const landedFiles = [];
                    let finalTotalBytes = 0;

                    for (const r of successResults) {
                        if (this._isCancelled()) return null;
                        const p = r.path || r.destPath;
                        const finalPath = await this._postProcess(p);
                        if (finalPath) {
                            landedFiles.push(finalPath);
                            try { finalTotalBytes += fs.statSync(finalPath).size; } catch (e) { }
                        }
                    }

                    const forbiddenErrors = failResults.filter(r => this._isForbidden(r.code || r.httpStatus, r.error));

                    // ✅ 线性化 + 前置排除：YouTube 永不触发增强（包括第三条“落盘为空但 success>0”）
                    const needEnhanced = (!isYouTube) && (
                        forbiddenErrors.length > 0 ||
                        (probeForbidden && landedFiles.length === 0) ||
                        (landedFiles.length === 0 && successResults.length > 0)
                    );

                    return {
                        needEnhanced,
                        code: forbiddenErrors[0]?.code || 403,
                        landedFiles,
                        finalTotalBytes,
                        urlSnippet,
                        isYouTube
                    };

                } finally {
                    if (fileSizeTimer) {
                        try { clearInterval(fileSizeTimer); } catch (e) { }
                    }
                }
            });

            if (!outcome) return;
            if (this._isCancelled()) return;

            // ✅ 最终兜底：哪怕未来有人改坏 needEnhanced，这里也坚决挡住 YouTube 增强
            if (outcome.needEnhanced) {
                if (outcome.isYouTube || this._isYouTubeUrl(url)) {
                    this.log(`[增强] 检测到 YouTube 链接，忽略增强流程`);
                } else {
                    await this._handleForbidden(outcome.code || 403, url, targetDir);
                    return;
                }
            }

            const landedCount = (outcome.landedFiles || []).length;
            const totalStr = this._formatBytesSimple(outcome.finalTotalBytes || 0);

            const msg = this._buildDoneMessage(landedCount, totalStr, outcome.urlSnippet);
            this.log(msg);

            const firstFile = this._pickFirstFileBySize(outcome.landedFiles || []);
            await this._showTaskDoneToast(msg, landedCount > 0, firstFile, targetDir);

        } catch (error) {
            if (this._isCancelled()) return;
            this.log(`处理失败: ${error.message}`);
        }
    }

    // ==================== 后处理：验证 + 改名 + 插入（返回最终落盘路径） ====================
    async _postProcess(filePath) {
        if (this._isCancelled()) return null;
        if (!filePath || !fs.existsSync(filePath)) return null;

        this.log(`正在验证文件: ${path.basename(filePath)}`);

        let ffmpeg = 'ffmpeg';
        if (this.downloader.ytdlp && this.downloader.ytdlp.ffmpegPath) {
            ffmpeg = this.downloader.ytdlp.ffmpegPath;
        }

        return new Promise((resolve) => {
            const proc = cp.spawn(ffmpeg, ['-i', filePath]);
            let stderr = '';
            proc.stderr.on('data', d => stderr += d.toString());

            proc.on('close', async () => {
                if (this._isCancelled()) { resolve(null); return; }

                const isVideo = stderr.includes('Video:') || stderr.includes('Audio:');
                const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);

                if (isVideo && durationMatch) {
                    const currentName = path.basename(filePath);
                    const ext = path.extname(filePath).toLowerCase();
                    let finalPath = filePath;

                    const isTooLong = currentName.length > 100;

                    let newExt = ext;
                    if (stderr.includes("Video: h264") && !['.mp4', '.mkv', '.mov'].includes(ext)) newExt = '.mp4';
                    else if (stderr.includes("Video: vp9") && ext !== '.webm' && ext !== '.mkv') newExt = '.webm';

                    if (isTooLong) {
                        const safeName = h.getTimestampFilename(newExt || '.mp4');
                        const p2 = path.join(path.dirname(filePath), safeName);
                        try { fs.renameSync(filePath, p2); finalPath = p2; } catch (e) { finalPath = filePath; }
                    } else if (newExt !== ext) {
                        const p2 = filePath.replace(ext, newExt);
                        try { fs.renameSync(filePath, p2); finalPath = p2; } catch (e) { finalPath = filePath; }
                    }

                    await this._insertToCursor(path.basename(finalPath), finalPath);
                    resolve(finalPath);
                } else {
                    this.log(`文件无效 (非视频或损坏)，删除: ${filePath}`);
                    try { fs.unlinkSync(filePath); } catch (e) { }
                    resolve(null);
                }
            });
        });
    }

    async _insertToCursor(fileName, fullPath) {
        if (this._isCancelled()) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const docDir = path.dirname(editor.document.uri.fsPath);
        let relPath = path.relative(docDir, fullPath).replace(/\\/g, '/');

        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, `/\\${relPath}\\/\n`);
        });
    }

    // ==================== 增强流程入口 ====================
    async _handleForbidden(code, url, targetDir) {
        if (this._isCancelled()) return;

        const selection = await vscode.window.showInformationMessage(
            `qqq: 被拒绝，返回 ${code}，当前可尝试启动增强流程。`,
            { modal: false },
            "🚀启动增强流程",
            "选择类似 chrome.exe 滴浏览器入口文件"
        );

        if (this._isCancelled()) return;

        if (selection === "🚀启动增强流程") {
            await this._runEnhancedPreferSaved(url, targetDir);
        } else if (selection === "选择类似 chrome.exe 滴浏览器入口文件") {
            await this._runEnhancedForcePick(url, targetDir);
        } else {
            this.log("用户取消增强流程");
        }
    }

    async _runEnhancedPreferSaved(url, targetDir) {
        await this._cleanupSavedBrowserPaths();

        const dedicated = this.context.globalState.get(this.KEY_DEDICATED_BROWSER);
        if (dedicated && fs.existsSync(dedicated)) {
            const v = await this._validateChromiumSilently(dedicated);
            if (v.valid) {
                this.log(`[增强] 使用已保存专用浏览器: ${dedicated} (${v.version})`);
                await this._startSniffer(dedicated, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
                return;
            } else {
                await this.context.globalState.update(this.KEY_DEDICATED_BROWSER, undefined);
            }
        }

        const custom = this.context.globalState.get(this.KEY_CUSTOM_BROWSER);
        if (custom && fs.existsSync(custom)) {
            const v = await this._validateChromiumSilently(custom);
            if (v.valid) {
                this.log(`[增强] 使用已保存用户浏览器: ${custom} (${v.version})`);
                await this._startSniffer(custom, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
                return;
            } else {
                await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);
            }
        }

        await this._promptPickThenMaybeDownload(url, targetDir);
    }

    async _runEnhancedForcePick(url, targetDir) {
        await this._promptPickThenMaybeDownload(url, targetDir);
    }

    async _promptPickThenMaybeDownload(url, targetDir) {
        if (this._isCancelled()) return;

        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: process.platform === 'win32'
                ? { 'Executables': ['exe'] }
                : { 'Executables': ['', 'app'] },
            title: "请选择 Chromium 内核浏览器的可执行文件"
        });

        if (this._isCancelled()) return;

        if (!uris || uris.length === 0) {
            const sel = await vscode.window.showErrorMessage(
                "qqq: 未选择浏览器入口文件。可选下载chrome（约150m）或终止一切。",
                "下载 chrome", "终止一切"
            );
            if (sel === "下载 chrome") {
                await this._downloadChrome(url, targetDir);
            } else {
                this.log("用户终止增强流程");
            }
            return;
        }

        const exePath = uris[0].fsPath;
        this.log(`[增强] 用户选择: ${exePath}`);

        const validation = await this._validateChromiumSilently(exePath);

        if (this._isCancelled()) return;

        if (validation.valid) {
            this.log(`[增强] 用户浏览器验证通过: ${validation.version}`);
            await this._startSniffer(exePath, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
            return;
        }

        await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);

        this.log(`[增强] 用户浏览器验证失败: ${validation.error}`);

        const sel = await vscode.window.showErrorMessage(
            `qqq: 该入口文件无效，可选下载chrome（约150m）或终止一切。\n原因: ${validation.error}`,
            "下载 chrome", "终止一切"
        );

        if (sel === "下载 chrome") {
            await this._downloadChrome(url, targetDir);
        } else {
            this.log("用户终止增强流程");
        }
    }

    async _cleanupSavedBrowserPaths() {
        try {
            const savedDedicated = this.context.globalState.get(this.KEY_DEDICATED_BROWSER);
            if (savedDedicated && !fs.existsSync(savedDedicated)) {
                await this.context.globalState.update(this.KEY_DEDICATED_BROWSER, undefined);
            }
        } catch (e) { }

        try {
            const savedCustom = this.context.globalState.get(this.KEY_CUSTOM_BROWSER);
            if (savedCustom && !fs.existsSync(savedCustom)) {
                await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);
            }
        } catch (e) { }
    }

    _psQuote(s) { return String(s).replace(/'/g, "''"); }

    _validateChromiumSilently(exePath) {
        return new Promise((resolve) => {
            if (!exePath || !fs.existsSync(exePath)) {
                resolve({ valid: false, error: '文件不存在' });
                return;
            }

            const platform = process.platform;

            if (platform === 'win32') {
                const p = this._psQuote(exePath);
                const cmd = [
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy', 'Bypass',
                    '-Command',
                    `
$it = Get-Item -LiteralPath '${p}' -ErrorAction Stop;
$vi = $it.VersionInfo;
$pn = $vi.ProductName;
$fd = $vi.FileDescription;
$pv = $vi.ProductVersion;
$fv = $vi.FileVersion;
$of = $vi.OriginalFilename;
"$pn|$fd|$pv|$fv|$of"
                    `.trim()
                ];

                cp.execFile('powershell', cmd, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
                    if (err) {
                        resolve({ valid: false, error: '无法读取版本信息' });
                        return;
                    }

                    const out = String(stdout || '').trim();
                    if (!out) {
                        resolve({ valid: false, error: '版本信息为空' });
                        return;
                    }

                    const parts = out.split('|').map(s => (s || '').trim());
                    const productName = parts[0] || '';
                    const fileDesc = parts[1] || '';
                    const productVersion = parts[2] || '';
                    const fileVersion = parts[3] || '';
                    const originalFilename = parts[4] || '';

                    const text = `${productName} ${fileDesc} ${originalFilename}`.toLowerCase();
                    const isChromiumFamily =
                        text.includes('chrome') ||
                        text.includes('chromium') ||
                        text.includes('edge') ||
                        text.includes('brave') ||
                        text.includes('vivaldi') ||
                        text.includes('opera');

                    const version = productVersion || fileVersion || '';
                    const hasVersion = /\d+\.\d+\.\d+\.\d+/.test(version) || /\d+\.\d+/.test(version);

                    if (isChromiumFamily && hasVersion) {
                        resolve({ valid: true, version: `${productName || 'Chromium'} ${version}`.trim(), raw: out });
                    } else if (isChromiumFamily) {
                        resolve({ valid: true, version: (productName || fileDesc || 'Chromium').slice(0, 80), raw: out });
                    } else {
                        resolve({ valid: false, error: '不是 Chromium 内核浏览器' });
                    }
                });

                return;
            }

            cp.execFile(exePath, ['--version'], { timeout: 8000 }, (err, stdout, stderr) => {
                if (err) {
                    resolve({ valid: false, error: '无法执行 --version' });
                    return;
                }
                const output = ((stdout || '') + (stderr || '')).trim();
                const chromiumPattern = /(Chromium|Chrome|Brave|Edge|Opera|Vivaldi)[\s\/:]*([\d\.]+)/i;
                const match = output.match(chromiumPattern);
                if (match) {
                    resolve({ valid: true, version: `${match[1]} ${match[2]}`, raw: output });
                } else {
                    resolve({ valid: true, version: output.slice(0, 80) || 'Chromium', raw: output });
                }
            });
        });
    }

    _getChromeDownloadInfo() {
        const version = '123.0.6312.4';
        const platform = process.platform;
        const arch = process.arch;

        let platformKey, zipName;

        if (platform === 'win32') {
            platformKey = (arch === 'x64' || arch === 'arm64') ? 'win64' : 'win32';
            zipName = (arch === 'x64' || arch === 'arm64') ? 'chrome-win64.zip' : 'chrome-win32.zip';
        } else if (platform === 'darwin') {
            platformKey = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
            zipName = arch === 'arm64' ? 'chrome-mac-arm64.zip' : 'chrome-mac-x64.zip';
        } else {
            platformKey = 'linux64';
            zipName = 'chrome-linux64.zip';
        }

        return {
            url: `https://cdn.npmmirror.com/binaries/chrome-for-testing/${version}/${platformKey}/${zipName}`,
            version,
            platform: platformKey,
            zipName
        };
    }

    async _downloadChrome(url, targetDir) {
        if (this._isCancelled()) return;

        if (!fs.existsSync(this.chromeHome)) fs.mkdirSync(this.chromeHome, { recursive: true });

        const zipPath = path.join(this.chromeHome, 'chrome.zip');
        const chromeInfo = this._getChromeDownloadInfo();

        this.log(`[Chrome] 下载源: npmmirror (国内)`);
        this.log(`[Chrome] 版本: ${chromeInfo.version}`);
        this.log(`[Chrome] 平台: ${chromeInfo.platform}`);
        this.log(`[Chrome] URL: ${chromeInfo.url}`);
        this.log(`[Chrome] 目标目录: ${this.chromeHome}`);

        let exePath = null;

        exePath = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在下载 Chrome for Testing...",
            cancellable: true
        }, async (progress, token) => {
            let cancelled = false;
            token.onCancellationRequested(async () => {
                cancelled = true;
                await this._cancelTask('用户取消 Chrome 下载');
            });

            try {
                progress.report({ message: `0% (版本 ${chromeInfo.version})` });

                await this._downloadFile(chromeInfo.url, zipPath, progress, () => cancelled || this._isCancelled());

                if (cancelled || this._isCancelled()) {
                    try { fs.unlinkSync(zipPath); } catch (e) { }
                    return null;
                }

                progress.report({ message: "解压中..." });

                await this._extractZip(zipPath, this.chromeHome);

                try { fs.unlinkSync(zipPath); } catch (e) { }

                const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
                const foundExe = this._findFileRecursive(this.chromeHome, exeName, 6);

                if (!foundExe) throw new Error("解压完成但找不到 chrome 可执行文件");

                this.log(`[Chrome] 找到: ${foundExe}`);

                if (process.platform === 'darwin' || process.platform === 'linux') {
                    try { cp.execSync(`chmod +x "${foundExe}"`); } catch (e) { }
                }

                const validation = await this._validateChromiumSilently(foundExe);
                if (!validation.valid) throw new Error(`下载的 Chrome 验证失败: ${validation.error}`);

                this.log(`[Chrome] 验证通过: ${validation.version}`);

                return foundExe;

            } catch (e) {
                if (this._isCancelled()) return null;
                this.log(`[Chrome] 失败: ${e.message}`);
                vscode.window.showErrorMessage(`下载 Chrome 失败: ${e.message}`);
                return null;
            }
        });

        if (!exePath) return;

        await this._startSniffer(exePath, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
    }

    _downloadFile(url, destPath, progress, isCancelled) {
        return new Promise((resolve, reject) => {
            const doRequest = (currentUrl, redirectCount = 0) => {
                if (redirectCount > 10) return reject(new Error('重定向次数过多'));
                if (isCancelled && isCancelled()) return resolve();

                const protocol = currentUrl.startsWith('https') ? https : require('http');

                protocol.get(currentUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 qqq-vscode-extension' }
                }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        let next = res.headers.location;
                        if (!next.startsWith('http')) {
                            const urlObj = new URL(currentUrl);
                            next = next.startsWith('/')
                                ? `${urlObj.protocol}//${urlObj.host}${next}`
                                : `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.replace(/\/[^\/]*$/, '/')}${next}`;
                        }
                        res.resume();
                        return doRequest(next, redirectCount + 1);
                    }

                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }

                    const total = parseInt(res.headers['content-length'], 10) || 0;
                    let downloaded = 0;
                    let lastUpdate = 0;

                    const dir = path.dirname(destPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                    const file = fs.createWriteStream(destPath);

                    let cancelledMid = false;
                    const cancelNow = () => {
                        if (cancelledMid) return;
                        cancelledMid = true;
                        try { res.destroy(); } catch (e) { }
                        try { file.close(); } catch (e) { }
                        try { fs.unlinkSync(destPath); } catch (e) { }
                        resolve();
                    };

                    res.on('data', (chunk) => {
                        if (isCancelled && isCancelled()) {
                            cancelNow();
                            return;
                        }

                        downloaded += chunk.length;

                        const now = Date.now();
                        if (now - lastUpdate > 200) {
                            lastUpdate = now;
                            if (total > 0) {
                                const percent = Math.round((downloaded * 100) / total);
                                const dlMB = (downloaded / 1024 / 1024).toFixed(1);
                                const totalMB = (total / 1024 / 1024).toFixed(1);
                                progress.report({ message: `${percent}% (${dlMB}/${totalMB} MB)` });
                            } else {
                                progress.report({ message: `${(downloaded / 1024 / 1024).toFixed(1)} MB` });
                            }
                        }
                    });

                    res.on('error', (err) => {
                        if (cancelledMid || (isCancelled && isCancelled())) return resolve();
                        try { file.close(); } catch (e) { }
                        try { fs.unlinkSync(destPath); } catch (e) { }
                        reject(err);
                    });

                    file.on('error', (err) => {
                        if (cancelledMid || (isCancelled && isCancelled())) return resolve();
                        try { file.close(); } catch (e) { }
                        try { fs.unlinkSync(destPath); } catch (e) { }
                        reject(err);
                    });

                    file.on('finish', () => {
                        if (cancelledMid || (isCancelled && isCancelled())) {
                            try { fs.unlinkSync(destPath); } catch (e) { }
                            return resolve();
                        }
                        file.close(() => resolve());
                    });

                    res.pipe(file);
                }).on('error', (err) => {
                    if (isCancelled && isCancelled()) return resolve();
                    try { fs.unlinkSync(destPath); } catch (e) { }
                    reject(err);
                });
            };

            doRequest(url);
        });
    }

    _extractZip(zipPath, destFolder) {
        return new Promise((resolve, reject) => {
            const platform = process.platform;

            if (platform === 'win32') {
                const zp = this._psQuote(zipPath);
                const df = this._psQuote(destFolder);

                const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${zp}' -DestinationPath '${df}' -Force"`;
                cp.exec(cmd, { timeout: 300000, windowsHide: true }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            } else {
                cp.exec(`unzip -o "${zipPath}" -d "${destFolder}"`, { timeout: 300000 }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            }
        });
    }

    _findFileRecursive(dir, fileName, maxDepth = 5, depth = 0) {
        if (depth > maxDepth) return null;
        try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                const full = path.join(dir, f);
                let st;
                try { st = fs.statSync(full); } catch (e) { continue; }

                if (st.isDirectory()) {
                    const found = this._findFileRecursive(full, fileName, maxDepth, depth + 1);
                    if (found) return found;
                } else if (f.toLowerCase() === fileName.toLowerCase()) {
                    return full;
                }
            }
        } catch (e) { }
        return null;
    }

    // ==================== 增强：挑最好资源 ====================
    _looksLikeMaster(url) {
        if (!url) return false;
        const u = String(url);
        return u.includes('.m3u8') || u.includes('.mpd') || u.match(/\.(mp4|webm|mkv|mov)(\?|$)/i);
    }

    _dedupeAndPickBestCapturedVideo(videos) {
        if (!Array.isArray(videos) || videos.length === 0) return null;

        const map = new Map();
        for (const v of videos) {
            if (!v || !v.url) continue;
            const key = String(v.url).trim();
            const old = map.get(key);
            if (!old) map.set(key, v);
            else {
                const p1 = Number(old.priority || 0);
                const p2 = Number(v.priority || 0);
                if (p2 > p1) map.set(key, v);
            }
        }

        const uniq = Array.from(map.values());
        const masters = uniq.filter(v => this._looksLikeMaster(v.url));
        const pool = masters.length > 0 ? masters : uniq;

        pool.sort((a, b) => {
            const pa = Number(a.priority || 0);
            const pb = Number(b.priority || 0);
            if (pb !== pa) return pb - pa;
            const am = this._looksLikeMaster(a.url) ? 1 : 0;
            const bm = this._looksLikeMaster(b.url) ? 1 : 0;
            return bm - am;
        });

        return pool[0] || null;
    }

    _findLandedVideoFilesSince(targetDir, sinceMs) {
        const exts = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.wmv', '.flv']);
        const ignoreSuffix = ['.part', '.tmp', '.ytdl', '.download'];

        const out = [];
        try {
            if (!fs.existsSync(targetDir)) return out;
            const files = fs.readdirSync(targetDir);

            for (const f of files) {
                const full = path.join(targetDir, f);
                try {
                    const s = fs.statSync(full);
                    if (!s.isFile()) continue;
                    if (s.mtimeMs < sinceMs) continue;

                    const lower = f.toLowerCase();
                    if (ignoreSuffix.some(x => lower.endsWith(x))) continue;

                    const ext = path.extname(lower);
                    if (!exts.has(ext)) continue;
                    if (s.size <= 0) continue;

                    out.push({ path: full, size: s.size, mtimeMs: s.mtimeMs });
                } catch (e) { }
            }
        } catch (e) { }

        out.sort((a, b) => a.mtimeMs - b.mtimeMs);
        return out.map(x => x.path);
    }

    _scanRecentBytes(targetDir, sinceMs) {
        let total = 0;
        try {
            if (!fs.existsSync(targetDir)) return 0;
            const files = fs.readdirSync(targetDir);
            for (const f of files) {
                const full = path.join(targetDir, f);
                try {
                    const s = fs.statSync(full);
                    if (!s.isFile()) continue;
                    if (s.mtimeMs >= sinceMs) total += s.size;
                } catch (e) { }
            }
        } catch (e) { }
        return total;
    }

    async _downloadEnhancedOne(url, targetDir, bestVideo) {
        const urlSnippet = this._makeUrlSnippet(url);
        const startMs = Date.now();

        const out = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "",
            cancellable: true
        }, async (progress, token) => {
            progress.report({ message: `已交换 0k 于 ${urlSnippet} (增强下载中...)` });

            token.onCancellationRequested(async () => {
                await this._cancelTask('用户在增强下载窗口点取消');
            });

            let timer = null;
            try {
                timer = setInterval(() => {
                    if (this._isCancelled()) return;
                    const bytes = this._scanRecentBytes(targetDir, startMs);
                    progress.report({ message: `已交换 ${this._formatBytesSimple(bytes)} 于 ${urlSnippet} (增强下载中...)` });
                }, 500);

                if (this._isCancelled()) return null;

                await this._runWithSuppressedPopups(async () => {
                    await this.downloader.downloadVideos([bestVideo], targetDir);
                });

            } finally {
                if (timer) {
                    try { clearInterval(timer); } catch (e) { }
                }
            }

            if (this._isCancelled()) return null;

            await this._sleep(300);

            const landedFiles = this._findLandedVideoFilesSince(targetDir, startMs);
            let totalBytes = 0;
            for (const p of landedFiles) {
                try { totalBytes += fs.statSync(p).size; } catch (e) { }
            }

            const inserted = new Set();
            for (const p of landedFiles) {
                if (this._isCancelled()) break;
                if (inserted.has(p)) continue;
                inserted.add(p);
                try { await this._insertToCursor(path.basename(p), p); } catch (e) { }
            }

            return { landedFiles, totalBytes, urlSnippet };
        });

        return out;
    }

    // ==================== 嗅探器（增强也要任务结束三号弹窗） ====================
    async _startSniffer(browserPath, url, targetDir, opts = {}) {
        if (this._isCancelled()) return;

        this.log("启动增强嗅探流程...");
        this.log(`浏览器: ${browserPath}`);
        this.log(`用户数据目录: ${this.userDataDir}`);

        if (!fs.existsSync(this.userDataDir)) fs.mkdirSync(this.userDataDir, { recursive: true });

        let sniffer = null;
        try {
            const CdpSniffer = require('./cdp-sniffer');

            CdpSniffer.setCustomBrowserPath(browserPath);

            if (typeof CdpSniffer.setUserDataDir === 'function') {
                CdpSniffer.setUserDataDir(this.userDataDir);
            }

            sniffer = new CdpSniffer();

            const startOptions = { userDataDir: this.userDataDir };

            await sniffer.start(url, (msg) => this.log(msg), startOptions);

            if (opts.rememberKey) {
                try {
                    await this.context.globalState.update(opts.rememberKey, browserPath);
                    this.log(`[增强] 已写入 globalState: ${opts.rememberKey} = ${browserPath}`);
                } catch (e) {
                    this.log(`[增强] 写入 globalState 失败: ${e.message}`);
                }
            }

            if (this._isCancelled()) {
                try { await sniffer.stop(); } catch (e) { }
                return;
            }

            const selection = await vscode.window.showInformationMessage(
                "请在打开的浏览器中播放视频（登录信息会自动保存），完成后点击下方按钮。",
                { modal: true },
                "我已在外部播放"
            );

            if (selection !== "我已在外部播放") {
                try { await sniffer.stop(); } catch (e) { }
                this.log("用户取消增强嗅探");
                return;
            }

            if (this._isCancelled()) {
                try { await sniffer.stop(); } catch (e) { }
                return;
            }

            const videos = sniffer.getCapturedVideos();
            await sniffer.stop();

            const best = this._dedupeAndPickBestCapturedVideo(videos || []);
            const urlSnippet = this._makeUrlSnippet(url);

            if (!best) {
                const msg0 = this._buildDoneMessage(0, "0k", urlSnippet);
                this.log(msg0);
                await this._showTaskDoneToast(msg0, false, null, targetDir);
                return;
            }

            if (!best.meta) best.meta = {};
            if (best.headers) {
                best.meta.cookie = best.headers['Cookie'];
                best.meta.referer = best.headers['Referer'];
                best.meta.userAgent = best.headers['User-Agent'];
                best.meta.origin = best.headers['Origin'];
            }

            const out = await this._downloadEnhancedOne(url, targetDir, best);
            if (!out) return;
            if (this._isCancelled()) return;

            const landedCount = (out?.landedFiles || []).length;
            const totalStr = this._formatBytesSimple(out?.totalBytes || 0);

            const msg = this._buildDoneMessage(landedCount, totalStr, out?.urlSnippet || urlSnippet);
            this.log(msg);

            const firstFile = this._pickFirstFileBySize(out?.landedFiles || []);
            await this._showTaskDoneToast(msg, landedCount > 0, firstFile, targetDir);

        } catch (e) {
            if (this._isCancelled()) return;

            this.log(`增强流程出错: ${e.message}`);
            if (sniffer) {
                try { await sniffer.stop(); } catch (e2) { }
            }
        }
    }
}

module.exports = VideoDownloadController;

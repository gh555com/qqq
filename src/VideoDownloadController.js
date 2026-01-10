const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const h = require('./h');
const { getSharedDownloader } = require('./dow');
const https = require('https');
const global = require('./global');
const { TaskCounter, TaskMessage } = require('./global');

// ==================== ★ 视频下载消息适配器（使用 TaskMessage 统一真理源） ====================
const VideoMsg = {
    /**
     * 生成进度消息
     * @param {Object} task - 任务对象（含 taskTitle）
     * @param {string} sizeStr - 已交换的大小字符串，如 "7m"
     * @param {string} urlSnippet - URL 缩略
     * @param {string} [suffix] - 可选后缀，如 "(正在解析...)", "(增强下载中...)"
     */
    progress(task, sizeStr, urlSnippet, suffix = '') {
        const suffixPart = suffix ? ` ${suffix}` : '';
        return TaskMessage.progress(task?.taskTitle, `已交换 ${sizeStr} 于 ${urlSnippet}${suffixPart}`);
    },

    /**
     * 生成任务完成消息
     * @param {Object} task - 任务对象（含 taskTitle, startMs）
     * @param {number} landedCount - 落盘文件数
     * @param {string} totalStr - 总大小字符串，如 "19m"
     * @param {string} urlSnippet - URL 缩略
     */
    done(task, landedCount, totalStr, urlSnippet) {
        const elapsedMs = Date.now() - (task?.startMs || Date.now());
        let summary;
        if (!landedCount || landedCount <= 0) {
            summary = `0 落盘，从 ${urlSnippet}`;
        } else {
            summary = `共落盘 ${landedCount}个视频共 ${totalStr}，从 ${urlSnippet}`;
        }
        return TaskMessage.done(task?.taskTitle, summary, elapsedMs);
    },

    /**
     * 生成用户提示消息
     * @param {Object} task - 任务对象
     * @param {string} message - 提示内容
     */
    prompt(task, message) {
        return TaskMessage.prompt(task?.taskTitle, message);
    }
};

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
        for (const pid of pids) await this._killPidTree(pid, false);
        await this._sleep(400);
        for (const pid of pids) await this._killPidTree(pid, true);

        this._procs.clear();
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    async _killPidTree(pid, force) {
        if (!pid || typeof pid !== 'number') return;

        const cp = require('child_process'); // lazy require
        const isWin = process.platform === 'win32';

        // ⚠️ kill 本身绝不能再被 tracker 拦截/追踪，否则会递归污染
        // 所以这里强制走 “原始未 patch 的函数”（如果已 patch）
        const execFile = ChildProcessTracker.__origExecFile || cp.execFile;
        const execFileSync = ChildProcessTracker.__origExecFileSync || cp.execFileSync;

        if (isWin) {
            return new Promise(resolve => {
                const args = ['/PID', String(pid), '/T'];
                if (force) args.push('/F');
                execFile('taskkill', args, {
                    windowsHide: true,
                    // ✅ 双保险：即便有人误把 kill 放在 ALS scope 里，也不追踪
                    env: ChildProcessTracker._envNoTrack(),
                }, () => resolve());
            });
        }

        // mac/linux：先杀子，再杀父
        try { execFileSync('pkill', [force ? '-KILL' : '-TERM', '-P', String(pid)], { stdio: 'ignore', env: ChildProcessTracker._envNoTrack() }); } catch (e) { }
        try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { }
        try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { }
    }

    // ==================== ALS：只让“本任务 async 链”可见 tracker ====================
    static runWithTracker(tracker, fn) {
        ChildProcessTracker.ensurePatched();
        const store = tracker ? { tracker } : null;
        if (!store) return fn();
        return ChildProcessTracker.__als.run(store, fn);
    }

    // ✅ 最终兜底：把某个回调“绑定到当前 store”
    // VSCode 的一些回调/事件有时会脱离原 async 链，这个保证不丢 store
    static bind(fn) {
        ChildProcessTracker.ensurePatched();
        const store = ChildProcessTracker.__als.getStore();
        if (!store) return fn;
        return (...args) => ChildProcessTracker.__als.run(store, () => fn(...args));
    }

    // ==================== 全局 patch：只 patch 一次 ====================
    static ensurePatched() {
        if (ChildProcessTracker.__patched) return;
        ChildProcessTracker.__patched = true;

        const cp = require('child_process');

        // 保存原始引用（供 kill / 兜底绕过）
        ChildProcessTracker.__origSpawn = cp.spawn.bind(cp);
        ChildProcessTracker.__origExecFile = cp.execFile.bind(cp);
        ChildProcessTracker.__origExec = cp.exec.bind(cp);
        ChildProcessTracker.__origFork = typeof cp.fork === 'function' ? cp.fork.bind(cp) : null;

        ChildProcessTracker.__origSpawnSync = typeof cp.spawnSync === 'function' ? cp.spawnSync.bind(cp) : null;
        ChildProcessTracker.__origExecFileSync = typeof cp.execFileSync === 'function' ? cp.execFileSync.bind(cp) : null;
        ChildProcessTracker.__origExecSync = typeof cp.execSync === 'function' ? cp.execSync.bind(cp) : null;

        // ---------- helpers ----------
        const isObj = (x) => !!x && typeof x === 'object';
        const getCmdBase = (cmd) => {
            try { return path.basename(String(cmd || '')).toLowerCase(); } catch { return String(cmd || '').toLowerCase(); }
        };

        // ✅ 前置排除：不在 ALS scope => 完全不动（不影响其它扩展 / 其它链）
        // ✅ 前置排除：带 NO_TRACK 标记 => 完全不动（你自己也能 opt-out）
        // ✅ 前置排除：排除“打开资源管理器/系统打开器”这类 UI 子进程，避免误杀
        const shouldIntercept = (cmd, options) => {
            const store = ChildProcessTracker.__als.getStore();
            const tracker = store && store.tracker;

            if (!tracker) return false;

            // 任务取消后仍可能有人 spawn；允许拦截并 track，便于 killAll 兜底
            // if (tracker.isCancelled && tracker.isCancelled()) return false;

            if (ChildProcessTracker._hasNoTrackFlag(options)) return false;

            const base = getCmdBase(cmd);
            if (ChildProcessTracker.__excludedCmds.has(base)) return false;

            return true;
        };

        // ✅ 不改原 options 对象：只有“必须改 detached”时才 clone
        const cloneOptionsDetachedFalse = (opt) => {
            if (!isObj(opt)) return opt;
            if (opt.detached !== true) return opt; // detached 不是 true 就不动（默认本来就是 false）
            const cloned = { ...opt, detached: false };
            return cloned;
        };

        // ---------- spawn ----------
        cp.spawn = function (...args) {
            // spawn(file, args?, options?)
            const cmd = args[0];
            let optionsIndex = -1;
            let options = null;

            if (args.length >= 3 && isObj(args[2])) { optionsIndex = 2; options = args[2]; }
            else if (args.length >= 2 && isObj(args[1]) && !Array.isArray(args[1])) { optionsIndex = 1; options = args[1]; }

            if (!shouldIntercept(cmd, options)) {
                return ChildProcessTracker.__origSpawn(...args);
            }

            // 强制 detached:false（只在 detached===true 时修正；不改原对象）
            if (optionsIndex >= 0) {
                const fixed = cloneOptionsDetachedFalse(options);
                if (fixed !== options) {
                    const newArgs = args.slice();
                    newArgs[optionsIndex] = fixed;
                    const p = ChildProcessTracker.__origSpawn(...newArgs);
                    const store = ChildProcessTracker.__als.getStore();
                    if (store && store.tracker && typeof store.tracker.track === 'function') store.tracker.track(p);
                    return p;
                }
            }

            const p = ChildProcessTracker.__origSpawn(...args);
            {
                const store = ChildProcessTracker.__als.getStore();
                if (store && store.tracker && typeof store.tracker.track === 'function') store.tracker.track(p);
            }
            return p;
        };

        // ---------- execFile ----------
        cp.execFile = function (...args) {
            // execFile(file[, args][, options][, callback])
            const cmd = args[0];
            let optionsIndex = -1;
            let options = null;

            if (args.length >= 3 && Array.isArray(args[1]) && isObj(args[2])) { optionsIndex = 2; options = args[2]; }
            else if (args.length >= 2 && isObj(args[1]) && !Array.isArray(args[1])) { optionsIndex = 1; options = args[1]; }
            else if (args.length >= 3 && isObj(args[2]) && !Array.isArray(args[2])) { optionsIndex = 2; options = args[2]; }

            if (!shouldIntercept(cmd, options)) {
                return ChildProcessTracker.__origExecFile(...args);
            }

            if (optionsIndex >= 0) {
                const fixed = cloneOptionsDetachedFalse(options);
                if (fixed !== options) {
                    const newArgs = args.slice();
                    newArgs[optionsIndex] = fixed;
                    const p = ChildProcessTracker.__origExecFile(...newArgs);
                    const store = ChildProcessTracker.__als.getStore();
                    if (store && store.tracker && typeof store.tracker.track === 'function') store.tracker.track(p);
                    return p;
                }
            }

            const p = ChildProcessTracker.__origExecFile(...args);
            {
                const store = ChildProcessTracker.__als.getStore();
                if (store && store.tracker && typeof store.tracker.track === 'function') store.tracker.track(p);
            }
            return p;
        };

        // ---------- exec ----------
        cp.exec = function (...args) {
            // exec(command[, options][, callback])
            const cmd = args[0];
            let optionsIndex = -1;
            let options = null;

            if (args.length >= 2 && isObj(args[1])) { optionsIndex = 1; options = args[1]; }

            if (!shouldIntercept(cmd, options)) {
                return ChildProcessTracker.__origExec(...args);
            }

            if (optionsIndex >= 0) {
                const fixed = cloneOptionsDetachedFalse(options);
                if (fixed !== options) {
                    const newArgs = args.slice();
                    newArgs[optionsIndex] = fixed;
                    const p = ChildProcessTracker.__origExec(...newArgs);
                    const store = ChildProcessTracker.__als.getStore();
                    if (store && store.tracker && typeof store.tracker.track === 'function') store.tracker.track(p);
                    return p;
                }
            }

            const p = ChildProcessTracker.__origExec(...args);
            {
                const store = ChildProcessTracker.__als.getStore();
                if (store && store.tracker && typeof store.tracker.track === 'function') store.tracker.track(p);
            }
            return p;
        };

        // ---------- fork（如果你项目里有人用） ----------
        if (ChildProcessTracker.__origFork) {
            cp.fork = function (...args) {
                // fork(modulePath[, args][, options])
                const cmd = args[0];
                let optionsIndex = -1;
                let options = null;

                if (args.length >= 3 && isObj(args[2])) { optionsIndex = 2; options = args[2]; }
                else if (args.length >= 2 && isObj(args[1]) && !Array.isArray(args[1])) { optionsIndex = 1; options = args[1]; }

                if (!shouldIntercept(cmd, options)) {
                    return ChildProcessTracker.__origFork(...args);
                }

                if (optionsIndex >= 0) {
                    const fixed = cloneOptionsDetachedFalse(options);
                    if (fixed !== options) {
                        const newArgs = args.slice();
                        newArgs[optionsIndex] = fixed;
                        const p = ChildProcessTracker.__origFork(...newArgs);
                        const store = ChildProcessTracker.__als.getStore();
                        if (store && store.tracker && typeof store.tracker.track === 'function') store.tracker.track(p);
                        return p;
                    }
                }

                const p = ChildProcessTracker.__origFork(...args);
                {
                    const store = ChildProcessTracker.__als.getStore();
                    if (store && store.tracker && typeof store.tracker.track === 'function') store.tracker.track(p);
                }
                return p;
            };
        }

        // ---------- sync 兜底：只强制 detached:false，不 track（没意义） ----------
        if (ChildProcessTracker.__origSpawnSync) {
            cp.spawnSync = function (...args) {
                const cmd = args[0];
                let optionsIndex = -1;
                let options = null;

                if (args.length >= 3 && isObj(args[2])) { optionsIndex = 2; options = args[2]; }
                else if (args.length >= 2 && isObj(args[1]) && !Array.isArray(args[1])) { optionsIndex = 1; options = args[1]; }

                // 不在 ALS scope / NO_TRACK / 排除 => 不动
                if (!shouldIntercept(cmd, options)) return ChildProcessTracker.__origSpawnSync(...args);

                if (optionsIndex >= 0) {
                    const fixed = cloneOptionsDetachedFalse(options);
                    if (fixed !== options) {
                        const newArgs = args.slice();
                        newArgs[optionsIndex] = fixed;
                        return ChildProcessTracker.__origSpawnSync(...newArgs);
                    }
                }
                return ChildProcessTracker.__origSpawnSync(...args);
            };
        }

        if (ChildProcessTracker.__origExecFileSync) {
            cp.execFileSync = function (...args) {
                const cmd = args[0];
                let optionsIndex = -1;
                let options = null;

                // execFileSync(file[, args][, options])
                if (args.length >= 3 && Array.isArray(args[1]) && isObj(args[2])) { optionsIndex = 2; options = args[2]; }
                else if (args.length >= 2 && isObj(args[1]) && !Array.isArray(args[1])) { optionsIndex = 1; options = args[1]; }
                else if (args.length >= 3 && isObj(args[2]) && !Array.isArray(args[2])) { optionsIndex = 2; options = args[2]; }

                if (!shouldIntercept(cmd, options)) return ChildProcessTracker.__origExecFileSync(...args);

                if (optionsIndex >= 0) {
                    const fixed = cloneOptionsDetachedFalse(options);
                    if (fixed !== options) {
                        const newArgs = args.slice();
                        newArgs[optionsIndex] = fixed;
                        return ChildProcessTracker.__origExecFileSync(...newArgs);
                    }
                }
                return ChildProcessTracker.__origExecFileSync(...args);
            };
        }

        if (ChildProcessTracker.__origExecSync) {
            cp.execSync = function (...args) {
                const cmd = args[0];
                let optionsIndex = -1;
                let options = null;

                // execSync(command[, options])
                if (args.length >= 2 && isObj(args[1])) { optionsIndex = 1; options = args[1]; }

                if (!shouldIntercept(cmd, options)) return ChildProcessTracker.__origExecSync(...args);

                if (optionsIndex >= 0) {
                    const fixed = cloneOptionsDetachedFalse(options);
                    if (fixed !== options) {
                        const newArgs = args.slice();
                        newArgs[optionsIndex] = fixed;
                        return ChildProcessTracker.__origExecSync(...newArgs);
                    }
                }
                return ChildProcessTracker.__origExecSync(...args);
            };
        }
    }

    // ============ NO_TRACK 支持（你想 opt-out 的子进程可以加这个标记） ============
    static _envNoTrack() {
        // 每次 clone 一份，避免外部改写污染
        return { ...process.env, [ChildProcessTracker.NO_TRACK_ENV_KEY]: '1' };
    }

    static _hasNoTrackFlag(options) {
        try {
            if (!options || typeof options !== 'object') return false;
            if (options._qqqNoTrack === true) return true;
            const env = options.env;
            if (env && typeof env === 'object') {
                const v = env[ChildProcessTracker.NO_TRACK_ENV_KEY];
                if (v === '1' || v === 'true' || v === true) return true;
            }
        } catch (e) { }
        return false;
    }
}

ChildProcessTracker.NO_TRACK_ENV_KEY = 'QQQ_NO_TRACK';
ChildProcessTracker.__als = new AsyncLocalStorage();
ChildProcessTracker.__patched = false;

// 这些命令属于“打开/外壳 UI”，不要纳入追踪，不然取消会误杀
ChildProcessTracker.__excludedCmds = new Set([
    'explorer.exe',
    'open',
    'xdg-open',
    'gio',          // 一些 linux 桌面会用 gio open
    'rundll32.exe', // 有时系统打开会走它
]);

class VideoDownloadController {
    constructor(context, qqqManager) {
        this.context = context;
        this.qqq = qqqManager;
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

    // ✅ 识别 YouTube（彻底排除增强：前置排除 + 最终兖底）
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
    async _showInvalidUrlToast(taskTitle = '') {
        const prefix = taskTitle ? `${taskTitle} ` : 'qqq: ';
        const msg = `${prefix}无效网址。`;
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

    // ==================== 三号弹窗：任务结束（15秒自动关闭） ====================
    async _showTaskDoneToast(message, canOpen, filePath, folderPath, taskTitle = '') {
        // ★ 使用 withProgress 确保15秒自动关闭
        // VS Code 的 showInformationMessage 不支持自动关闭
        const { TaskMessage } = global;
        await TaskMessage.showSimpleToast(message, 15000, 'success');
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

    // ==================== 任务上下文：总耗时 + 真取消 + 事务 ====================
    async _beginTask(targetDir, externalTransId = null) {
        // Remove dependency on this._task (instance state)

        const task = {
            startMs: Date.now(),
            tracker: new ChildProcessTracker(),
            activeFiles: new Set(), // Track files for cleanup on cancel
            transId: externalTransId || Date.now().toString(),
            isExternalTrans: !!externalTransId,
            isCancelled: false // Local cancelled flag
        };

        // ★ 注册事务 (如果是外部事务，我们假设外部已经注册了，或者我们可以 update 一下以防万一)
        if (!task.isExternalTrans) {
            await global.TransactionManager.saveTransaction({
                id: task.transId,
                targetDir: targetDir,
                tempFiles: [],
                landedFiles: [],
                landedFolders: []
            });
        }

        return task;
    }

    async _cancelTask(task, reason = '用户取消') {
        if (!task || !task.tracker) return;
        if (task.tracker.isCancelled()) return;

        task.tracker.markCancelled();
        task.isCancelled = true;
        this.log(`qqq: 已标记取消（${reason}），正在清理...`);

        // ★ 如果是外部事务（从 performCurvedPaste 调用），不显示弹窗，由外部统一管理
        // ★ 如果是内部事务（start 方法直接调用），显示弹窗
        if (!task.isExternalTrans) {
            const cancelMsg = `${task.taskTitle || 'qqq'} 已取消并回滚`;
            global.TaskMessage.showSimpleToast(cancelMsg, 15000, 'cancel');
        }

        // ★ 事务回滚（后台执行）
        if (task.transId && !task.isExternalTrans) {
            const trans = global.TransactionManager.getTransactions().find(tr => tr.id === task.transId);
            if (trans) {
                global.TransactionManager.rollback(trans).catch(e => this.log(`回滚失败: ${e.message}`));
            }
        }

        // Clean up any active files immediately
        if (task.activeFiles) {
            for (const file of task.activeFiles) {
                try {
                    if (fs.existsSync(file)) fs.unlinkSync(file);
                    if (fs.existsSync(file + ".part")) fs.unlinkSync(file + ".part");
                    if (fs.existsSync(file + ".ytdl")) fs.unlinkSync(file + ".ytdl");
                } catch (e) { }
            }
            task.activeFiles.clear();
        }

        try {
            await task.tracker.killAll(reason);
        } catch (e) { }
    }

    _isTaskCancelled(task) {
        return !!(task && (task.isCancelled || (task.tracker && task.tracker.isCancelled())));
    }

    // ==================== 任务结束打印（★ 使用统一格式化器） ====================
    _buildDoneMessage(task, landedCount, totalStr, urlSnippet) {
        return VideoMsg.done(task, landedCount, totalStr, urlSnippet);
    }

    // ==================== start ====================
    async start() {
        const raw = await vscode.window.showInputBox({
            prompt: "直接粘贴 [ 包含视频滴网址 ] ",
            ignoreFocusOut: true,
            placeHolder: "https://..."
        });
        if (!raw) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("请先打开一个文档以便插入视频。");
            return;
        }

        const currentDocDir = path.dirname(editor.document.uri.fsPath);
        const targetDir = path.join(currentDocDir, "qqq");
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        // ★ 交互式模式也生成 taskTitle
        const filePath = editor.document.uri.fsPath;
        const taskNum = await TaskCounter.increment(filePath);
        const taskTitle = TaskCounter.formatTitle(filePath, taskNum);

        // 交互式模式：不传递 progressCallback，使用内部的 withProgress
        const result = await this.downloadEntry(raw, targetDir, null, null, null, null, taskTitle);

        // ★ 进度弹窗结束后，显示完成弹窗（15秒自动关闭）
        // ★ 取消弹窗已在 _cancelTask 中显示，这里只显示成功消息
        if (result && result.doneMessage && !result.cancelled) {
            global.TaskMessage.showSimpleToast(result.doneMessage, 15000, 'success');
        }
    }

    // ==================== Headless Entry (for q1.js concurrency) ====================
    async downloadEntry(rawUrl, targetDir, transId, progressCallback, token, targetUri = null, taskTitle = '') {
        // 1. 初始化任务上下文
        const task = await this._beginTask(targetDir, transId);

        // Save targetUri to task for insertion
        task.targetUri = targetUri;
        // ★ 保存 taskTitle 到 task 对象，供所有弹窗使用
        task.taskTitle = taskTitle;

        // 2. 绑定外部取消 Token (如果有)
        if (token) {
            token.onCancellationRequested(async () => {
                await this._cancelTask(task, '外部 Token 取消');
            });
        }

        try {
            // 3. 在 Tracker 作用域内运行
            return await ChildProcessTracker.runWithTracker(task.tracker, async () => {
                const v = this._normalizeAndValidateUrl(rawUrl);
                if (!v.ok) {
                    if (!progressCallback) await this._showInvalidUrlToast(task.taskTitle);
                    return null;
                }

                const url = v.url;

                // 异步确保 yt-dlp
                this.downloader.ensureYtdlpReady(this.context).catch(e => console.error(e));

                this.log(`开始处理: ${url}`);
                if (!progressCallback) this.outputChannel.show(true);

                // Cookies
                let cookiesFilePath = this._findBestCookieFileInGlobalStorage();
                if (cookiesFilePath) {
                    this.log(`[Cookies] 使用全局 Cookie 文件: ${cookiesFilePath}`);
                }

                // 4. 执行核心流程
                return await this._fastProcess(task, url, targetDir, cookiesFilePath, progressCallback);
            });
        } finally {
            // No explicit endTask needed as task is local variable
        }
    }

    // ==================== Cookie 辅助 ====================
    _findBestCookieFileInGlobalStorage() {
        try {
            const dir = this.context.globalStorageUri.fsPath;
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const files = fs.readdirSync(dir);
            const candidates = [];
            for (const f of files) {
                const lower = f.toLowerCase();
                if (lower.endsWith('.txt') && lower.includes('cookies')) {
                    try {
                        const full = path.join(dir, f);
                        const st = fs.statSync(full);
                        candidates.push({ path: full, mtime: st.mtimeMs });
                    } catch (e) { }
                }
            }
            if (candidates.length === 0) return null;
            // 按时间倒序，取最新的
            candidates.sort((a, b) => b.mtime - a.mtime);
            return candidates[0].path;
        } catch (e) {
            this.log(`[Cookies] 搜索出错: ${e.message}`);
            return null;
        }
    }

    async _handleCookieErrorIfNeeded(errorMsg, url) {
        if (!errorMsg) return;
        const msg = String(errorMsg);

        // 仅针对 YouTube
        if (!this._isYouTubeUrl(url)) return;

        // 关键词匹配
        const keywords = ["Sign in", "404", "cookie", "bot", "confirm", "Unsupported URL", "Private video"];
        const hit = keywords.some(k => msg.includes(k));

        if (hit) {
            this.log(`[Cookies] 检测到可能的 Cookie 失效/缺失 (${msg})，正在自动打开配置目录...`);

            // 1. 打开文件夹
            const dir = this.context.globalStorageUri.fsPath;
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                await vscode.env.openExternal(vscode.Uri.file(dir));
            } catch (e) { }

            // 2. 打开文档
            const docPath = 'e:\\s\\wol\\py\\q3\\docs\\expert_cookies.txt';
            try {
                if (fs.existsSync(docPath)) {
                    await vscode.window.showTextDocument(vscode.Uri.file(docPath));
                }
            } catch (e) { }

            vscode.window.showWarningMessage(`YouTube 下载失败，请检查 opened 文件夹下的 cookies 配置 (参考同时打开的文档)。`);
        }
    }

    // ==================== 普通流程：一号 + 三号 ====================
    async _fastProcess(task, url, targetDir, cookiesFilePath, progressCallback) {
        try {
            const urlSnippet = this._makeUrlSnippet(url);
            const isYouTube = this._isYouTubeUrl(url);

            const runLogic = async (progress, token) => {
                // ★ 使用统一格式化器
                progress.report({ message: VideoMsg.progress(task, '0k', urlSnippet, '(正在解析...)') });

                if (token) {
                    token.onCancellationRequested(
                        ChildProcessTracker.bind(async () => {
                            await this._cancelTask(task, '用户在一号窗口点取消');
                        })
                    );
                }

                this.log("正在智能嗅探资源...");
                let tasks = [];

                let probeForbidden = false;
                let hasStaticDirectVideo = false; // 标记是否有静态分析找到的直连视频
                try {
                    if (this._isTaskCancelled(task)) return null;

                    const res = await this.downloader.probe(url, { cookiesFilePath });

                    if (this._isTaskCancelled(task)) return null;

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
                            await this._handleCookieErrorIfNeeded(res?.error, url);
                        }
                    }
                } catch (e) {
                    if (this._isTaskCancelled(task)) return null;
                    this.log(`yt-dlp 探测异常: ${e.message}`);
                    await this._handleCookieErrorIfNeeded(e.message, url);
                }

                // 静态分析（优先于 403 增强）
                try {
                    if (this._isTaskCancelled(task)) return null;
                    this.log(`开始静态分析网页: ${url}`);
                    const webUrls = await h.extractVideoUrlsFromWebPage(url);
                    this.log(`静态分析结果: ${webUrls ? webUrls.length : 0} 个 URL`);
                    if (webUrls && webUrls.length > 0) {
                        this.log(`静态分析发现 ${webUrls.length} 个资源链接。`);

                        // 检查是否有直连视频 URL
                        const hasDirectVideo = webUrls.some(u => u.match(/\.(mp4|m3u8|mpd|webm|mkv)(\?|$)/i));

                        // 只要找到了直连视频，就设置标志并移除原始 403 任务
                        if (hasDirectVideo) {
                            hasStaticDirectVideo = true;
                            if (probeForbidden) {
                                this.log("静态分析找到直连视频，移除原始 403 任务，避免进入增强流程。");
                                // Filter out the task that is just the raw URL
                                tasks = tasks.filter(t => t.url !== url);
                                probeForbidden = false; // Reset forbidden flag so we don't trigger enhanced mode unnecessarily
                            }
                        }

                        webUrls.forEach(u => tasks.push(this._createTask(u, 'Web Resource', targetDir, url)));
                    }
                } catch (e) {
                    this.log(`静态分析失败: ${e.message}`);
                }

                if (this._isTaskCancelled(task)) return null;

                tasks = this._deduplicateTasks(tasks);

                if (tasks.length === 0) {
                    this.log("未探测到明确资源，尝试直接下载原链接...");
                    tasks.push(this._createTask(url, 'Direct Link', targetDir, url));
                }

                this.log(`准备下载 ${tasks.length} 个任务...`);
                progress.report({ message: VideoMsg.progress(task, '0k', urlSnippet) });

                const activePrefixes = new Set();
                tasks.forEach(t => {
                    if (t.destPath) {
                        const name = path.basename(t.destPath, path.extname(t.destPath));
                        if (name) activePrefixes.add(name);

                        // ★ 只把还不存在的文件加入 activeFiles
                        // 避免取消时误删已存在的文件（上次成功下载的）
                        if (task && task.activeFiles && !fs.existsSync(t.destPath)) {
                            task.activeFiles.add(t.destPath);
                        }
                    }
                });

                let diskTotalBytes = 0;
                let logTotalBytes = 0;
                const logProgressMap = new Map();

                let fileSizeTimer = null;

                try {
                    fileSizeTimer = setInterval(() => {
                        if (this._isTaskCancelled(task)) return;

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
                        progress.report({ message: VideoMsg.progress(task, totalStr, urlSnippet) });
                    }, 500);

                    if (this._isTaskCancelled(task)) return null;

                    let res;
                    try {
                        res = await this._runWithSuppressedPopups(async () => {
                            return await this.downloader.downloadAll(tasks, targetDir, {
                                downloadVideos: "all",
                                cookiesFilePath: cookiesFilePath, // Pass cookies here
                                onProgress: (t, event) => {
                                    if (this._isTaskCancelled(task)) return;

                                    if (event.type === 'start') {
                                        this.log(`开始: ${String(t.url).slice(0, 60)}...`);
                                    } else if (event.type === 'progress') {
                                        const p = event.progress;
                                        let currentBytes = 0;
                                        if (typeof p === 'object' && p.currentSize) {
                                            currentBytes = this._parseSizeToBytes(p.currentSize);
                                        }
                                        if (currentBytes > 0) {
                                            logProgressMap.set(t.url, currentBytes);
                                            let sum = 0;
                                            for (const b of logProgressMap.values()) sum += b;
                                            logTotalBytes = sum;
                                        }
                                    } else if (event.type === 'done') {
                                        this.log(`完成: ${path.basename(t.destPath || '')}`);
                                    } else if (event.type === 'error') {
                                        this.log(`失败: ${t.url} - ${event.error}`);
                                    } else if (event.type === 'retry') {
                                        this.log(`重试: ${t.url} (Wait ${event.delayMs}ms)`);
                                    }
                                }
                            });
                        });
                    } catch (e) {
                        if (this._isTaskCancelled(task)) return null;
                        throw e;
                    }

                    if (this._isTaskCancelled(task)) {
                        // 下载完成后的清理逻辑
                        if (res && res.results) {
                            for (const r of res.results) {
                                if (r.success) {
                                    const f = r.path || r.destPath;
                                    if (f && fs.existsSync(f)) {
                                        try { fs.unlinkSync(f); } catch (e) { }
                                    }
                                }
                            }
                        }
                        return null;
                    }

                    const results = res?.results || [];
                    const successResults = results.filter(r => r.success);
                    const failResults = results.filter(r => !r.success);

                    const landedFiles = [];
                    let finalTotalBytes = 0;

                    for (const r of successResults) {
                        if (this._isTaskCancelled(task)) return null;
                        const p = r.path || r.destPath;
                        const result = await this._postProcess(task, p);
                        // ★ result.path 是最终路径（新文件或复用旧文件）
                        // ★ 事务记录已在 _postProcess 内部处理（只记录 isNew: true 的）
                        if (result && result.path) {
                            landedFiles.push(result.path);
                            try { finalTotalBytes += fs.statSync(result.path).size; } catch (e) { }
                        }
                    }

                    const forbiddenErrors = failResults.filter(r => this._isForbidden(r.code || r.httpStatus, r.error));

                    // ✅ 线性化 + 前置排除：YouTube 永不触发增强，静态分析找到直连视频也不触发增强
                    const needEnhanced = (!isYouTube) && (!hasStaticDirectVideo) && (
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
            };

            let outcome;
            if (progressCallback) {
                // Headless adapter
                const progress = {
                    report: (p) => {
                        if (p && p.message) progressCallback(0, p.message);
                    }
                };
                outcome = await runLogic(progress, null);
            } else {
                // Interactive
                outcome = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "",
                    cancellable: true
                }, runLogic);
            }

            if (!outcome) {
                // ★ 取消弹窗已在 _cancelTask 中显示，这里只返回标记
                if (this._isTaskCancelled(task)) {
                    return {
                        landedFiles: [],
                        finalTotalBytes: 0,
                        cancelled: true,
                        targetDir: targetDir
                    };
                }
                return { landedFiles: [], finalTotalBytes: 0 };
            }

            // ★ 取消弹窗已在 _cancelTask 中显示，这里只返回标记
            if (this._isTaskCancelled(task)) {
                return {
                    landedFiles: [],
                    finalTotalBytes: 0,
                    cancelled: true,
                    targetDir: targetDir
                };
            }

            // ✅ 最终兖底：哪怕未来有人改坏 needEnhanced，这里也坚决挡住 YouTube 增强
            if (outcome.needEnhanced) {
                if (outcome.isYouTube || this._isYouTubeUrl(url)) {
                    this.log(`[增强] 检测到 YouTube 链接，忽略增强流程`);
                } else {
                    const enhancedResult = await this._handleForbidden(task, outcome.code || 403, url, targetDir, progressCallback);
                    // 增强流程也返回结果
                    return enhancedResult || { landedFiles: [], finalTotalBytes: 0 };
                }
            }

            const landedCount = (outcome.landedFiles || []).length;
            const totalStr = this._formatBytesSimple(outcome.finalTotalBytes || 0);

            const msg = this._buildDoneMessage(task, landedCount, totalStr, outcome.urlSnippet);
            this.log(msg);

            // ★ 先准备返回结果
            const result = {
                landedFiles: outcome.landedFiles || [],
                finalTotalBytes: outcome.finalTotalBytes || 0,
                // ★ 传递完成消息和相关信息，让调用者决定何时显示
                doneMessage: msg,
                canOpenDir: landedCount > 0,
                firstFile: this._pickFirstFileBySize(outcome.landedFiles || []),
                targetDir: targetDir
            };

            // ★ 返回结果给调用者（用于替换锚点等）- 不在这里显示弹窗
            return result;

        } catch (error) {
            // ★ 取消弹窗已在 _cancelTask 中显示
            if (this._isTaskCancelled(task)) {
                return {
                    landedFiles: [],
                    finalTotalBytes: 0,
                    cancelled: true,
                    targetDir: targetDir
                };
            }
            this.log(`处理失败: ${error.message}`);
            return { landedFiles: [], finalTotalBytes: 0 };
        }
    }

    // ==================== 后处理：验证 + 改名 + 插入（返回最终落盘路径） ====================
    // ★ 返回值约定：
    //   - { path, isNew: true }  → 新下载的文件，需记入事务
    //   - { path, isNew: false } → 复用旧文件，不记入事务（取消时不删除）
    //   - null                   → 失败
    async _postProcess(task, filePath) {
        if (this._isTaskCancelled(task)) {
            if (filePath && fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { }
            }
            return null;
        }
        if (!filePath || !fs.existsSync(filePath)) return null;

        // 指纹去重检查 (仅同文件夹内去重，不跨文件夹)
        try {
            const currentFp = h.computeFingerprint(filePath);
            if (currentFp) {
                // ★ 只在同一文件夹内去重，不同文件夹允许有相同文件
                const dir = path.dirname(filePath);
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    const full = path.join(dir, f);
                    if (full === filePath) continue;
                    if (!fs.statSync(full).isFile()) continue;
                    if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.tmp')) continue;

                    const otherFp = h.computeFingerprint(full);
                    if (otherFp === currentFp) {
                        this.log(`发现指纹重复文件（同文件夹），删除新下载文件: ${path.basename(filePath)} -> 复用旧文件: ${f}`);
                        try { fs.unlinkSync(filePath); } catch (e) { }
                        await this._insertToCursor(task, f, full);
                        // ★ 返回 isNew: false，表示复用旧文件，不记入事务
                        return { path: full, isNew: false };
                    }
                }
            }
        } catch (e) {
            this.log(`指纹检查出错: ${e.message}`);
        }

        this.log(`正在验证文件: ${path.basename(filePath)}`);

        // 使用公共函数进行 FFmpeg 校验
        const finalPath = await h.verifyVideoFile(filePath);

        if (finalPath) {
            // ★ 新文件：记入事务
            if (task && task.transId) {
                const trans = global.TransactionManager.getTransactions().find(t => t.id === task.transId);
                if (trans) {
                    const newLanded = [...(trans.landedFiles || []), finalPath];
                    // De-dupe
                    await global.TransactionManager.updateTransaction(task.transId, { landedFiles: [...new Set(newLanded)] });
                }
            }

            await this._insertToCursor(task, path.basename(finalPath), finalPath);
            // ★ 返回 isNew: true，表示新文件
            return { path: finalPath, isNew: true };
        } else {
            this.log(`文件无效 (非视频或损坏)，已由 verifyVideoFile 删除: ${filePath}`);
            return null;
        }
    }

    async _insertToCursor(task, fileName, fullPath) {
        if (this._isTaskCancelled(task)) return;

        // 如果是外部事务 (headless mode)，通常 q1.js 会处理插入 (通过 formatResultToText)
        if (task.isExternalTrans) return;

        const targetUri = task.targetUri;
        if (targetUri) {
            // Background insertion using WorkspaceEdit
            try {
                const doc = await vscode.workspace.openTextDocument(targetUri);
                // Insert at end of document if no selection context, or maybe just append?
                // For "Direct Paste", we usually want to replace selection.
                // But in background, selection might be gone.
                // We'll append to the end for safety in background mode, or try to use a stored range?
                // Storing range is complex. Appending is safe for "download queue" behavior.
                // Better: Insert at the end of document.
                const lastLine = doc.lineCount - 1;
                const range = new vscode.Range(lastLine, doc.lineAt(lastLine).text.length, lastLine, doc.lineAt(lastLine).text.length);

                const edit = new vscode.WorkspaceEdit();
                const relPath = path.relative(path.dirname(targetUri.fsPath), fullPath).replace(/\\/g, '/');
                edit.insert(targetUri, range, `\n/\\${relPath}\\/\n`);
                await vscode.workspace.applyEdit(edit);
            } catch (e) {
                this.log(`Background insert failed: ${e.message}`);
            }
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const docDir = path.dirname(editor.document.uri.fsPath);
        let relPath = path.relative(docDir, fullPath).replace(/\\/g, '/');

        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, `/\\${relPath}\\/\n`);
        });
    }

    // ==================== 增强流程入口 ====================
    async _handleForbidden(task, code, url, targetDir, progressCallback) {
        if (this._isTaskCancelled(task)) return null;

        const prefix = task?.taskTitle ? `${task.taskTitle} ` : 'qqq: ';
        const selection = await vscode.window.showInformationMessage(
            `${prefix}下载被拒（${code}），当前可尝试启动增强流程。`,
            { modal: false },
            "🚀启动增强流程",
            "选择类似 chrome.exe 滴浏览器入口文件"
        );

        if (this._isTaskCancelled(task)) return null;

        if (selection === "🚀启动增强流程") {
            return await this._runEnhancedPreferSaved(task, url, targetDir);
        } else if (selection === "选择类似 chrome.exe 滴浏览器入口文件") {
            return await this._runEnhancedForcePick(task, url, targetDir);
        } else {
            this.log("用户取消增强流程");
            return null;
        }
    }

    async _runEnhancedPreferSaved(task, url, targetDir) {
        await this._cleanupSavedBrowserPaths();

        const dedicated = this.context.globalState.get(this.KEY_DEDICATED_BROWSER);
        if (dedicated && fs.existsSync(dedicated)) {
            const v = await this._validateChromiumSilently(dedicated);
            if (v.valid) {
                this.log(`[增强] 使用已保存专用浏览器: ${dedicated} (${v.version})`);
                return await this._startSniffer(task, dedicated, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
            } else {
                await this.context.globalState.update(this.KEY_DEDICATED_BROWSER, undefined);
            }
        }

        const custom = this.context.globalState.get(this.KEY_CUSTOM_BROWSER);
        if (custom && fs.existsSync(custom)) {
            const v = await this._validateChromiumSilently(custom);
            if (v.valid) {
                this.log(`[增强] 使用已保存用户浏览器: ${custom} (${v.version})`);
                return await this._startSniffer(task, custom, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
            } else {
                await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);
            }
        }

        return await this._promptPickThenMaybeDownload(task, url, targetDir);
    }

    async _runEnhancedForcePick(task, url, targetDir) {
        return await this._promptPickThenMaybeDownload(task, url, targetDir);
    }

    async _promptPickThenMaybeDownload(task, url, targetDir) {
        if (this._isTaskCancelled(task)) return null;

        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: process.platform === 'win32'
                ? { 'Executables': ['exe'] }
                : { 'Executables': ['', 'app'] },
            title: "请选择 Chromium 内核浏览器的可执行文件"
        });

        if (this._isTaskCancelled(task)) return null;

        if (!uris || uris.length === 0) {
            const sel = await vscode.window.showErrorMessage(
                "qqq: 未选择浏览器入口文件。可选下载chrome（约150m）或终止一切。",
                "下载 chrome", "终止一切"
            );
            if (sel === "下载 chrome") {
                return await this._downloadChrome(task, url, targetDir);
            } else {
                this.log("用户终止增强流程");
            }
            return null;
        }

        const exePath = uris[0].fsPath;
        this.log(`[增强] 用户选择: ${exePath}`);

        const validation = await this._validateChromiumSilently(exePath);

        if (this._isTaskCancelled(task)) return null;

        if (validation.valid) {
            this.log(`[增强] 用户浏览器验证通过: ${validation.version}`);
            return await this._startSniffer(task, exePath, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
        }

        await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);

        this.log(`[增强] 用户浏览器验证失败: ${validation.error}`);

        const sel = await vscode.window.showErrorMessage(
            `qqq: 该入口文件无效，可选下载chrome（约150m）或终止一切。\n原因: ${validation.error}`,
            "下载 chrome", "终止一切"
        );

        if (sel === "下载 chrome") {
            return await this._downloadChrome(task, url, targetDir);
        } else {
            this.log("用户终止增强流程");
        }
        return null;
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

    async _downloadChrome(task, url, targetDir) {
        if (this._isTaskCancelled(task)) return;

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
            token.onCancellationRequested(
                ChildProcessTracker.bind(async () => {
                    cancelled = true;
                    await this._cancelTask(task, '用户取消 Chrome 下载');
                })
            );

            try {
                progress.report({ message: `0% (版本 ${chromeInfo.version})` });

                await this._downloadFile(chromeInfo.url, zipPath, progress, () => cancelled || this._isTaskCancelled(task));

                if (cancelled || this._isTaskCancelled(task)) {
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
                if (this._isTaskCancelled(task)) return null;
                this.log(`[Chrome] 失败: ${e.message}`);
                vscode.window.showErrorMessage(`下载 Chrome 失败: ${e.message}`);
                return null;
            }
        });

        if (!exePath) return;

        await this._startSniffer(task, exePath, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
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

    async _downloadEnhancedOne(task, url, targetDir, bestVideo) {
        const urlSnippet = this._makeUrlSnippet(url);
        const startMs = Date.now();

        const out = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "",
            cancellable: true
        }, async (progress, token) => {
            // ★ 使用统一格式化器
            progress.report({ message: VideoMsg.progress(task, '0k', urlSnippet, '(增强下载中...)') });

            token.onCancellationRequested(
                ChildProcessTracker.bind(async () => {
                    await this._cancelTask(task, '用户在增强下载窗口点取消');
                })
            );

            let timer = null;
            try {
                timer = setInterval(() => {
                    if (this._isTaskCancelled(task)) return;
                    const bytes = this._scanRecentBytes(targetDir, startMs);
                    progress.report({ message: VideoMsg.progress(task, this._formatBytesSimple(bytes), urlSnippet, '(增强下载中...)') });
                }, 500);

                if (this._isTaskCancelled(task)) return null;

                await this._runWithSuppressedPopups(async () => {
                    await this.downloader.downloadVideos([bestVideo], targetDir);
                });

            } finally {
                if (timer) {
                    try { clearInterval(timer); } catch (e) { }
                }
            }

            if (this._isTaskCancelled(task)) return null;

            await this._sleep(300);

            const rawFiles = this._findLandedVideoFilesSince(targetDir, startMs);
            const landedFiles = [];
            let totalBytes = 0;

            // ★ 增强流程也要经过 _postProcess 验证和指纹注册
            for (const p of rawFiles) {
                if (this._isTaskCancelled(task)) break;
                const result = await this._postProcess(task, p);
                // ★ result.path 是最终路径（新文件或复用旧文件）
                if (result && result.path) {
                    landedFiles.push(result.path);
                    try { totalBytes += fs.statSync(result.path).size; } catch (e) { }
                }
            }

            return { landedFiles, totalBytes, urlSnippet };
        });

        return out;
    }

    // ==================== 嗅探器（增强也要任务结束三号弹窗） ====================
    async _startSniffer(task, browserPath, url, targetDir, opts = {}) {
        if (this._isTaskCancelled(task)) return null;

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

            if (this._isTaskCancelled(task)) {
                try { await sniffer.stop(); } catch (e) { }
                return null;
            }

            // ★ 使用统一格式化器
            const selection = await vscode.window.showInformationMessage(
                VideoMsg.prompt(task, '请在打开的浏览器中播放视频（选择你期望滴分辨率），完成后点击下方按钮。'),
                { modal: true },
                "我已在外部播放"
            );

            if (selection !== "我已在外部播放") {
                try { await sniffer.stop(); } catch (e) { }
                this.log("用户取消增强嗅探");
                return null;
            }

            if (this._isTaskCancelled(task)) {
                try { await sniffer.stop(); } catch (e) { }
                return null;
            }

            const videos = sniffer.getCapturedVideos();
            await sniffer.stop();

            const best = this._dedupeAndPickBestCapturedVideo(videos || []);
            const urlSnippet = this._makeUrlSnippet(url);

            if (!best) {
                const msg0 = this._buildDoneMessage(task, 0, "0k", urlSnippet);
                this.log(msg0);
                // ★ 返回完成消息，不直接显示
                return { landedFiles: [], totalBytes: 0, doneMessage: msg0, canOpenDir: false, targetDir };
            }

            if (!best.meta) best.meta = {};
            if (best.headers) {
                best.meta.cookie = best.headers['Cookie'];
                best.meta.referer = best.headers['Referer'];
                best.meta.userAgent = best.headers['User-Agent'];
                best.meta.origin = best.headers['Origin'];
            }

            const out = await this._downloadEnhancedOne(task, url, targetDir, best);
            if (!out) return null;
            if (this._isTaskCancelled(task)) return null;

            const landedCount = (out?.landedFiles || []).length;
            const totalStr = this._formatBytesSimple(out?.totalBytes || 0);

            const msg = this._buildDoneMessage(task, landedCount, totalStr, out?.urlSnippet || urlSnippet);
            this.log(msg);

            const firstFile = this._pickFirstFileBySize(out?.landedFiles || []);
            // ★ 返回完整结果（含完成消息），不直接显示弹窗
            return {
                landedFiles: out?.landedFiles || [],
                finalTotalBytes: out?.totalBytes || 0,
                doneMessage: msg,
                canOpenDir: landedCount > 0,
                firstFile: firstFile,
                targetDir: targetDir
            };

        } catch (e) {
            if (this._isTaskCancelled(task)) return null;

            this.log(`增强流程出错: ${e.message}`);
            if (sniffer) {
                try { await sniffer.stop(); } catch (e2) { }
            }
            return null;
        }
    }
}

module.exports = VideoDownloadController;

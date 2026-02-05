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
const QvideoMsg = {
    /**
     * ★ 解析阶段消息（不显示已交换）
     */
    parsing(task, url) {
        const prefix = task?.taskTitle ? `${task.taskTitle} ` : 'qqq: ';
        const domain = this._extractDomain(url);
        return `${prefix}正在解析 ${domain}...`;
    },

    /**
     * ★ 生成进度消息
     * @param {Object} task - 任务对象（含 taskTitle, videoTitle）
     * @param {string} sizeStr - 已交换的大小字符串，如 "7m"
     * @param {string} url - 原始 URL
     * @param {number} [elapsedMs] - 已耗时毫秒（>20分钟才显示）
     * @param {string} [statusSuffix] - 状态后缀，如 "增强下载中"
     */
    progress(task, sizeStr, url, elapsedMs = 0, statusSuffix = '') {
        const prefix = task?.taskTitle ? `${task.taskTitle} ` : 'qqq: ';

        // ★ 耗时：只有 >20分钟才显示
        const TWENTY_MIN = 20 * 60 * 1000;
        const timePart = elapsedMs >= TWENTY_MIN ? ` (${this._formatTime(elapsedMs)})` : '';

        // ★ 状态后缀
        const statusPart = statusSuffix ? ` (${statusSuffix})` : '';

        // ★ 新格式：于 domain_标题...
        const domain = this._extractDomain(url);
        const titlePart = task?.videoTitle ? `_${task.videoTitle}` : '';

        return `${prefix}已交换 ${sizeStr}${timePart}${statusPart} 于 ${domain}${titlePart}`;
    },

    /**
     * ★ 提取主域名（如 youtube.com）
     */
    _extractDomain(url) {
        try {
            const u = new URL(String(url));
            // 去掉 www. 前缀
            return u.hostname.replace(/^www\./, '');
        } catch {
            return String(url).slice(0, 20);
        }
    },

    /**
     * ★ 格式化时间 mm:ss 或 h:mm:ss
     */
    _formatTime(ms) {
        const total = Math.floor(ms / 1000);
        const s = total % 60;
        const m = Math.floor(total / 60) % 60;
        const h = Math.floor(total / 3600);
        const ss = String(s).padStart(2, '0');
        const mm = String(m).padStart(2, '0');
        if (h > 0) return `${h}:${mm}:${ss}`;
        return `${m}:${ss}`;
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
        return TaskMessage.done(task?.taskTitle, summary, elapsedMs, task?.taskNum || '');
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

        // ★ 已移除 _killYtdlpProcesses()：
        // 该方法会杀死系统上所有 yt-dlp 进程，导致多任务互相干扰
        // 现在 dow.js 已改为动态获取 spawn，能被 tracker 正确追踪，无需全局兆底

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

// ★ 单例日志通道（避免多个实例创建多个通道）
let _sharedOutputChannel = null;
function getSharedOutputChannel() {
    if (!_sharedOutputChannel) {
        _sharedOutputChannel = vscode.window.createOutputChannel("qqq: Video Downloader");
    }
    return _sharedOutputChannel;
}

// ★ 活跃任务集合（用于避免多任务互相干扰）
const _activeTasks = new Set();

// ★ 弹窗兜底状态：记录消息弹窗是否被 VS Code “吃掉”（模块级变量，跨任务持久化）
let _isInfoMessageEaten = false;

class Qvideo {
    constructor(context, qqqManager) {
        this.context = context;
        this.qqq = qqqManager;
        this.downloader = getSharedDownloader();
        // ★ 使用共享的 qqq 日志通道
        this.outputChannel = getSharedOutputChannel();

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
        const m = 1048576;
        if (bytes >= m) return Math.round(bytes / m) + "m";
        return Math.round(bytes / k) + "k";
    }

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
        else if (unit.startsWith('M')) multiplier = 1048576;
        else if (unit.startsWith('G')) multiplier = 1073741824;
        return Math.floor(val * multiplier);
    }

    _makeUrlSnippet(url) {
        return this._truncateByWidth(String(url || ''), 28);
    }

    // ★ 按显示宽度截断（公认最佳实践）
    // 全角字符（中日韩等）= 2宽度，半角字符 = 1宽度
    _truncateByWidth(str, maxWidth) {
        if (!str) return '';
        let width = 0;
        let i = 0;
        for (; i < str.length; i++) {
            const code = str.charCodeAt(i);
            // 全角字符范围：CJK + 日文假名 + 全角标点 + Emoji
            const isWide = (
                (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK 基本区
                (code >= 0x3000 && code <= 0x303F) ||   // CJK 标点
                (code >= 0x3040 && code <= 0x30FF) ||   // 日文假名
                (code >= 0xFF00 && code <= 0xFFEF) ||   // 全角字符
                (code >= 0xAC00 && code <= 0xD7AF) ||   // 韩文
                (code >= 0x1F300 && code <= 0x1F9FF) || // Emoji
                (code >= 0x2600 && code <= 0x26FF)     // 杂项符号
            );
            const charWidth = isWide ? 2 : 1;
            if (width + charWidth > maxWidth) break;
            width += charWidth;
        }
        if (i < str.length) return str.slice(0, i) + '...';
        return str;
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
        let originalFileName = null;  // ★ 保存原始文件名
        let tempFileName = null;      // ★ 临时文件名（带时间戳）

        // ★ 计算原始文件名
        if (title && title !== 'Direct Link' && title !== 'Web Resource') {
            originalFileName = this._sanitizeFilename(title) + ".mp4";
        } else {
            // ★ 从 URL 提取文件名
            try {
                const u = new URL(videoUrl);
                const base = path.basename(u.pathname);
                if (base && base.match(/\.(mp4|webm|mkv|mov|flv|avi|wmv|m4v|mpg|mpeg|3gp|ts|ogv)$/i)) {
                    // ★ 解码后用 _sanitizeFilename 处理，保留中文等字符
                    const decoded = decodeURIComponent(base);
                    const ext = path.extname(decoded);
                    const nameWithoutExt = path.basename(decoded, ext);
                    const sanitized = this._sanitizeFilename(nameWithoutExt);
                    if (sanitized && sanitized.length > 0) {
                        originalFileName = sanitized + ext;
                    }
                }
            } catch (e) { }
        }

        // ★ 总是使用唯一的时间戳文件名作为临时文件，避免覆盖旧文件
        tempFileName = h.getTimestampFilename('.mp4');
        destPath = path.join(targetDir, tempFileName);

        const headers = {};
        if (referer) headers["Referer"] = referer;

        return {
            url: videoUrl,
            destPath: destPath,
            originalFileName: originalFileName,  // ★ 保存原始文件名，用于落盘时重命名
            kind: "video",
            baseDir: targetDir,
            headers: headers,
            _debug_originalFileName: originalFileName  // ★ 调试用
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

        // ★ 使用六位随机 ID
        const transId = externalTransId || global.TransactionManager.createTransactionId();

        const task = {
            startMs: Date.now(),
            tracker: new ChildProcessTracker(),
            transId: transId,
            isExternalTrans: !!externalTransId,
            isCancelled: false
        };

        // ★ 注册事务 (如果是外部事务，我们假设外部已经注册了，或者我们可以 update 一下以防万一)
        if (!task.isExternalTrans) {
            await global.TransactionManager.saveTransaction({
                id: task.transId,
                targetDir: targetDir,
                tempFiles: [],
                landedFiles: [],
                landedFolders: [],
                taskType: 'video',  // ★ 视频下载任务
                existingFiles: await global.getDirectorySnapshot(targetDir)  // ★ 任务开始时的目录快照
            });
        }

        return task;
    }

    async _cancelTask(task, reason = '用户取消') {
        if (!task || !task.tracker) return;
        // ★ 确保设置取消标志
        task.tracker.markCancelled();
        task.isCancelled = true;
        this.log(`qqq: 已标记取消（${reason}），正在清理...`);

        // ★ 如果是外部事务（从 performCurvedPaste 调用），不显示弹窗，由外部统一管理
        // ★ 如果是内部事务（start 方法直接调用），显示弹窗
        if (!task.isExternalTrans) {
            const cancelMsg = `${task.taskTitle || 'qqq'} 已取消并回滚`;
            global.TaskMessage.showSimpleToast(cancelMsg, 15000, 'cancel');
        }

        // ★ 先执行回滚（删除锚点等），但跳过延迟兜底清理
        let targetDir = null;
        if (task.transId && !task.isExternalTrans) {
            const trans = global.TransactionManager.getTransactions().find(tr => tr.id === task.transId);
            if (trans) {
                targetDir = trans.targetDir;
                // ★ video 类型任务会自动跳过延迟兜底清理
                await global.TransactionManager.rollback(trans);
            }
        }

        // ★ 先杀进程（这是关键步骤，否则文件被锁定无法删除）
        try {
            await task.tracker.killAll(reason);
        } catch (e) { }

        // ★ 进程杀完后，稍微等待一下（给 OS 时间释放文件句柄）
        await new Promise(resolve => setTimeout(resolve, 300));

        // ★ 进程杀完后立即执行兜底清理（pure）
        // 这样可以确保文件不被锁定
        if (targetDir) {
            try {
                await global.TransactionManager._cleanupOrphanFiles(targetDir);
                this.log(`[兜底清理] 已在 killAll 后立即执行`);
            } catch (e) {
                this.log(`[兜底清理] 失败: ${e.message}`);
            }
        }
    }

    _isTaskCancelled(task) {
        // ★ 检查三种取消条件：
        // 1. 任务本身的 isCancelled 标志
        // 2. tracker 的取消状态
        // 3. 外部 shouldCancel 回调（用于检测锚点丢失）
        if (!task) return false;

        if (task.isCancelled || (task.tracker && task.tracker.isCancelled())) {
            return true;
        }

        // ★ 检查外部取消回调（锚点丢失）
        if (task.shouldCancel && task.shouldCancel()) {
            // ★ 立即同步设置取消标志（不等待 async 操作）
            if (!task.isCancelled) {
                task.isCancelled = true;
                if (task.tracker) task.tracker.markCancelled();
                this.log('[AnchorLost] 检测到锚点丢失，立即标记取消并杀死进程');
                // ★ 后台执行杀进程和清理（不等待）
                this._cancelTask(task, '锚点丢失').catch(e => { });
            }
            return true;
        }

        return false;
    }

    // ==================== 任务结束打印（★ 使用统一格式化器） ====================
    _buildDoneMessage(task, landedCount, totalStr, urlSnippet) {
        return QvideoMsg.done(task, landedCount, totalStr, urlSnippet);
    }

    // ==================== start ====================
    async start() {
        const raw = await vscode.window.showInputBox({
            prompt: "直接粘贴 [ 包含视频的网址 ] ",
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

        // ★ 生成任务标识
        const filePath = editor.document.uri.fsPath;
        const taskNum = await TaskCounter.increment(filePath);  // 数据库递增编号（按文件）
        const iconNum = await TaskCounter.incrementIcon();  // 全局图形编号（跨文件）
        const transId = global.TransactionManager.createTransactionId();  // 六位随机ID
        const taskTitle = TaskCounter.formatTitle(filePath, transId, iconNum);  // 标题用 transId + 图形

        // 交互式模式
        const result = await this.downloadEntry(raw, targetDir, transId, null, null, null, taskTitle, null, taskNum);

        // ★ 进度弹窗结束后，显示完成弹窗（15秒自动关闭）
        // ★ 取消弹窗已在 _cancelTask 中显示，这里只显示成功消息
        if (result && result.doneMessage && !result.cancelled) {
            global.TaskMessage.showSimpleToast(result.doneMessage, 15000, 'success');
            // ★ 报告统计数据 (仅当独立启动时，headless 模式由 q1.js 报告)
            if (result.finalTotalBytes) {
                global.saveVideoStats(result.finalTotalBytes);
            }
        }
    }

    // ==================== Headless Entry (for q1.js concurrency) ====================
    async downloadEntry(rawUrl, targetDir, transId, progressCallback, token, targetUri = null, taskTitle = '', shouldCancel = null, taskNum = null) {
        // 1. 初始化任务上下文
        const task = await this._beginTask(targetDir, transId);

        // Save targetUri to task for insertion
        task.targetUri = targetUri;
        // ★ 保存 taskTitle 到 task 对象，供所有弹窗使用
        task.taskTitle = taskTitle;
        // ★ 保存 taskNum 到 task 对象，用于结束消息
        task.taskNum = taskNum;
        // ★ 保存 shouldCancel 回调，用于实时检查锚点是否丢失
        task.shouldCancel = shouldCancel;

        // ★ 添加到活跃任务集合
        _activeTasks.add(task);

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
            // ★ 从活跃任务集合中移除
            _activeTasks.delete(task);
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

            // ★ 修复：使用 prompt 添加统一前缀
            const promptMsg = QvideoMsg.prompt(this._task, 'youtube下载失败，可尝试配置 cookies (参考打开的文档)。 另一方面，稍做等待也是一种解决方案。');
            vscode.window.showWarningMessage(promptMsg);
        }
    }

    // ==================== 普通流程：一号 + 三号 ====================
    async _fastProcess(task, url, targetDir, cookiesFilePath, progressCallback) {
        try {
            const urlSnippet = this._makeUrlSnippet(url);
            const isYouTube = this._isYouTubeUrl(url);

            const runLogic = async (progress, token) => {
                // ★ 解析阶段：使用新的 parsing 方法
                progress.report({ message: QvideoMsg.parsing(task, url) });

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
                const staticDirectVideoUrls = new Set(); // ★ 追踪静态分析找到的直连视频 URL
                try {
                    if (this._isTaskCancelled(task)) return null;

                    const res = await this.downloader.probe(url, { cookiesFilePath });

                    if (this._isTaskCancelled(task)) return null;

                    if (res && res.success) {
                        if (res.isPlaylist && res.entries && res.entries.length > 0) {
                            this.log(`识别为列表，共 ${res.entries.length} 个视频。`);
                            tasks = res.entries.map(e => this._createTask(e.url || e.webpage_url, e.title, targetDir, url));
                            // ★ 播放列表：用第一个视频的标题
                            task.videoTitle = this._truncateByWidth(res.entries[0]?.title || '', 28);
                        } else {
                            this.log(`识别为单个视频: ${res.title}`);
                            tasks.push(this._createTask(res.url || res.webpageUrl || url, res.title, targetDir, url));
                            // ★ 单个视频：保存截断后的标题
                            task.videoTitle = this._truncateByWidth(res.title || '', 28);
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

                        // 检查是否有直连视频 URL，并记录这些 URL
                        const directVideoPattern = /\.(mp4|m3u8|mpd|webm|mkv)(\?|$)/i;
                        webUrls.forEach(u => {
                            if (u.match(directVideoPattern)) {
                                staticDirectVideoUrls.add(u);
                            }
                        });
                        const hasDirectVideo = staticDirectVideoUrls.size > 0;

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
                progress.report({ message: QvideoMsg.progress(task, '0k', url, 0, '') });

                // ★ 关键修复：预先将所有 destPath 记录到事务的 tempFiles 中
                // 这样取消时即使文件已下载但还没记录到 landedFiles，也能通过 tempFiles 删除
                if (task.transId) {
                    try {
                        const trans = global.TransactionManager.getTransactions().find(t => t.id === task.transId);
                        if (trans) {
                            const allDestPaths = tasks.map(t => t.destPath).filter(Boolean);
                            const newTempFiles = [...(trans.tempFiles || []), ...allDestPaths];
                            await global.TransactionManager.updateTransaction(task.transId, { tempFiles: [...new Set(newTempFiles)] });
                        }
                    } catch (e) {
                        this.log(`[事务] 预注册 tempFiles 失败: ${e.message}`);
                    }
                }

                // ★ 精确匹配当前任务的文件（而非前缀匹配，避免多任务互相干扰）
                const activeFileNames = new Set();
                tasks.forEach(t => {
                    if (t.destPath) {
                        const fullName = path.basename(t.destPath);  // 包含扩展名
                        const nameNoExt = path.basename(t.destPath, path.extname(t.destPath));
                        if (fullName) activeFileNames.add(fullName.toLowerCase());
                        // ★ 也添加 yt-dlp 可能创建的临时文件名模式
                        if (nameNoExt) {
                            activeFileNames.add((nameNoExt + '.mp4.part').toLowerCase());
                            activeFileNames.add((nameNoExt + '.webm.part').toLowerCase());
                            // yt-dlp 段格式: xxx.f123.mp4
                            // 由于无法预知段 ID，使用前缀匹配但记录前缀
                        }
                    }
                });
                // ★ 保留前缀集合用于匹配 yt-dlp 段文件
                const activePrefixes = new Set();
                tasks.forEach(t => {
                    if (t.destPath) {
                        const nameNoExt = path.basename(t.destPath, path.extname(t.destPath));
                        if (nameNoExt) activePrefixes.add(nameNoExt.toLowerCase());
                    }
                });

                let logTotalBytes = 0;
                // ★ 精确进度追踪：每个 URL + 每个阶段独立计数
                // key = url + stageIdx，避免多阶段覆盖
                const logProgressMap = new Map();  // url -> { completed: 0, current: 0, lastPeak: 0 }
                let useLogOnly = false;
                let noProgressTicks = 0;
                const FALLBACK_TICKS = 4;
                const downloadStartMs = Date.now();

                let fileSizeTimer = null;

                try {
                    fileSizeTimer = setInterval(() => {
                        // ★ 每 500ms 检查取消状态（包括锚点丢失）
                        if (this._isTaskCancelled(task)) {
                            // ★ 检测到取消，立即停止定时器
                            if (fileSizeTimer) {
                                clearInterval(fileSizeTimer);
                                fileSizeTimer = null;
                            }
                            // ★ 触发取消回调（如果有）
                            if (task._cancelResolve) {
                                task._cancelResolve();
                                task._cancelResolve = null;
                            }
                            return;
                        }

                        let finalBytes = 0;

                        // ★ 策略：优先用 yt-dlp 回调进度（准确且隔离）
                        if (logTotalBytes > 0) {
                            useLogOnly = true;  // 锁定
                            finalBytes = logTotalBytes;
                        } else if (useLogOnly) {
                            // ★ 已锁定但暂时为 0（可能在切换文件），继续用 log
                            finalBytes = logTotalBytes;
                        } else {
                            // ★ yt-dlp 尚未报告进度，计时
                            noProgressTicks++;
                            if (noProgressTicks >= FALLBACK_TICKS) {
                                // ★ 兜底：扫描磁盘（不准确但至少有显示）
                                let diskBytes = 0;
                                try {
                                    if (fs.existsSync(targetDir)) {
                                        const files = fs.readdirSync(targetDir);
                                        for (const f of files) {
                                            const fLower = f.toLowerCase();
                                            if (activeFileNames.has(fLower)) {
                                                try {
                                                    const s = fs.statSync(path.join(targetDir, f));
                                                    if (s.isFile()) diskBytes += s.size;
                                                } catch (e) { }
                                                continue;
                                            }
                                            for (const prefix of activePrefixes) {
                                                if (fLower.startsWith(prefix + '.f') && /\.f\d+\.(mp4|webm|m4a|mkv|part)$/i.test(f)) {
                                                    try {
                                                        const s = fs.statSync(path.join(targetDir, f));
                                                        if (s.isFile()) diskBytes += s.size;
                                                    } catch (e) { }
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                } catch (e) { }
                                finalBytes = diskBytes;
                            }
                        }

                        const totalStr = this._formatBytesSimple(finalBytes);
                        // ★ 计算已耗时（格式 mm:ss 或 hh:mm:ss）
                        const elapsedMs = Date.now() - downloadStartMs;
                        progress.report({ message: QvideoMsg.progress(task, totalStr, url, elapsedMs, '') });
                    }, 500);

                    if (this._isTaskCancelled(task)) return null;

                    let res;
                    try {
                        // ★ 创建取消 Promise，用于 Promise.race
                        const cancelPromise = new Promise(resolve => {
                            task._cancelResolve = resolve;
                        });

                        const downloadPromise = this._runWithSuppressedPopups(async () => {
                            return await this.downloader.downloadAll(tasks, targetDir, {
                                downloadVideos: "all",
                                cookiesFilePath: cookiesFilePath,
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
                                            // ★ 简化累计器：检测进度回退就累加
                                            const entry = logProgressMap.get(t.url) || { completed: 0, current: 0, lastPeak: 0 };

                                            // ★ 关键：如果 currentBytes 明显小于 lastPeak，说明新阶段开始
                                            if (currentBytes < entry.lastPeak * 0.8 && entry.lastPeak > 512 * 1024) {
                                                // 新阶段：把之前的峰值加到 completed
                                                entry.completed += entry.lastPeak;
                                                entry.current = currentBytes;
                                                entry.lastPeak = currentBytes;
                                            } else {
                                                // 同阶段：更新 current 和 lastPeak
                                                entry.current = currentBytes;
                                                entry.lastPeak = Math.max(entry.lastPeak, currentBytes);
                                            }

                                            logProgressMap.set(t.url, entry);

                                            // ★ 求和：completed + current
                                            let sum = 0;
                                            for (const e of logProgressMap.values()) {
                                                sum += e.completed + e.current;
                                            }
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

                        // ★ 使用 Promise.race：下载完成 或 取消，哪个先到就返回
                        res = await Promise.race([
                            downloadPromise,
                            cancelPromise.then(() => null)  // 取消时返回 null
                        ]);

                        // ★ 清理取消回调
                        task._cancelResolve = null;
                    } catch (e) {
                        if (this._isTaskCancelled(task)) return null;
                        throw e;
                    }

                    if (this._isTaskCancelled(task)) {
                        // ★ 取消后由 rollback 统一清理
                        return null;
                    }

                    const results = res?.results || [];
                    const successResults = results.filter(r => r.success);
                    const failResults = results.filter(r => !r.success);

                    const landedFiles = [];
                    let finalTotalBytes = 0;

                    for (const r of successResults) {
                        if (this._isTaskCancelled(task)) {
                            this.log(`[取消] 在 _postProcess 循环中检测到取消，跳出`);
                            return null;
                        }
                        const p = r.path || r.destPath;
                        // ★ 通过 destPath 找到对应的 task，获取 originalFileName
                        const matchedTask = tasks.find(t => t.destPath === p || t.destPath === r.destPath);
                        const originalFileName = matchedTask?.originalFileName || null;
                        // ★ 调试日志
                        this.log(`[Match] p=${path.basename(p)}, r.destPath=${path.basename(r.destPath || '')}, matched=${!!matchedTask}, originalFileName=${originalFileName || '(null)'}`);
                        const result = await this._postProcess(task, p, originalFileName);
                        // ★ result.path 是最终路径（新文件或复用旧文件）
                        // ★ 事务记录已在 _postProcess 内部处理（只记录 isNew: true 的）
                        if (result && result.path) {
                            landedFiles.push(result.path);
                            try { finalTotalBytes += fs.statSync(result.path).size; } catch (e) { }
                        }
                    }

                    const forbiddenErrors = failResults.filter(r => this._isForbidden(r.code || r.httpStatus, r.error));

                    // ✅ 线性化 + 前置排除：YouTube 永不触发增强
                    // ★ 精准判断：静态分析找到的直连视频是否有效
                    // - 如果这些直连视频 URL 全部都是 403 失败 → 无效，需要触发增强
                    // - 如果有任何一个成功，或失败但不是 403 → 有效，不触发增强
                    let staticVideoEffective = false;
                    if (hasStaticDirectVideo && staticDirectVideoUrls.size > 0) {
                        // 检查静态直连视频的下载结果
                        const staticVideoResults = results.filter(r => staticDirectVideoUrls.has(r.url));
                        const staticVideoAllForbidden = staticVideoResults.length > 0 &&
                            staticVideoResults.every(r => !r.success && this._isForbidden(r.code || r.httpStatus, r.error));
                        // 只有当不是全部 403 时，才认为静态分析有效
                        staticVideoEffective = !staticVideoAllForbidden;
                        if (staticVideoAllForbidden) {
                            this.log(`[增强判断] 静态分析的 ${staticVideoResults.length} 个直连视频全部 403 失败，允许进入增强流程`);
                        }
                    }
                    // ★ 只有实际有 403 错误时才触发增强
                    // - 移除了 "landedFiles.length === 0 && successResults.length > 0" 这个条件
                    // - 因为百度等网站可能下载了 HTML 而不是视频，这种情况不应触发增强
                    const needEnhanced = (!isYouTube) && (!staticVideoEffective) && (
                        forbiddenErrors.length > 0 ||
                        (probeForbidden && landedFiles.length === 0)
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

            // ✅ 最终兄底：哪怕未来有人改坏 needEnhanced，这里也坚决挡住 YouTube 增强
            if (outcome.needEnhanced) {
                if (outcome.isYouTube || this._isYouTubeUrl(url)) {
                    this.log(`[增强] 检测到 YouTube 链接，忽略增强流程`);
                } else {
                    // ★ 返回特殊标记，让外层 qqq.js 结束 withProgress 弹窗后再调用 handleForbidden
                    return {
                        needEnhancedAction: true,
                        task: task,
                        code: outcome.code || 403,
                        url: url,
                        targetDir: targetDir,
                        progressCallback: progressCallback
                    };
                }
            }

            // ★ YouTube 下载失败时，触发 cookies 配置流程（独立于 needEnhanced 判断）
            if ((outcome.isYouTube || this._isYouTubeUrl(url)) && outcome.landedFiles.length === 0) {
                await this._handleCookieErrorIfNeeded('Sign in to confirm', url);
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

    // ==================== 后处理：验证 + 指纹去重 + 重命名 + 插入（返回最终落盘路径） ====================
    // ★ 返回值约定：
    //   - { path, isNew: true }  → 新下载的文件，需记入事务
    //   - { path, isNew: false } → 复用旧文件，不记入事务（取消时不删除）
    //   - null                   → 失败
    // ★ originalFileName: 原始文件名（可选），用于落盘时重命名（去除时间戳）
    async _postProcess(task, filePath, originalFileName = null) {
        // ★ 调试日志
        this.log(`[_postProcess] 开始: filePath=${path.basename(filePath)}, originalFileName=${originalFileName || '(null)'}`);
        if (this._isTaskCancelled(task)) {
            this.log(`[_postProcess] 开始时已取消，跳过`);
            if (filePath && fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { }
            }
            return null;
        }
        if (!filePath || !fs.existsSync(filePath)) return null;

        // 指纹去重检查 (仅同文件夹内去重，不跨文件夹)
        try {
            if (this._isTaskCancelled(task)) return null;  // ★ 取消检查

            const currentFp = h.computeFingerprint(filePath);
            if (currentFp) {
                // ★ 只在同一文件夹内去重，不同文件夹允许有相同文件
                const dir = path.dirname(filePath);
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    if (this._isTaskCancelled(task)) return null;  // ★ 取消检查

                    const full = path.join(dir, f);
                    if (full === filePath) continue;
                    if (!fs.statSync(full).isFile()) continue;
                    if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.tmp')) continue;

                    const otherFp = h.computeFingerprint(full);
                    if (otherFp === currentFp) {
                        this.log(`指纹重复，删除临时文件: ${path.basename(filePath)} -> 复用旧文件: ${f}`);
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

        if (this._isTaskCancelled(task)) return null;  // ★ 取消检查

        // 使用公共函数进行 FFmpeg 校验
        const verifiedPath = await h.verifyVideoFile(filePath);

        if (this._isTaskCancelled(task)) return null;  // ★ 取消检查

        if (!verifiedPath) {
            this.log(`文件无效 (非视频或损坏)，已由 verifyVideoFile 删除: ${filePath}`);
            return null;
        }

        // ★ 重命名为原始文件名（去除时间戳）
        let finalPath = verifiedPath;
        if (originalFileName) {
            if (this._isTaskCancelled(task)) return null;  // ★ 取消检查
            const dir = path.dirname(verifiedPath);
            let targetPath = path.join(dir, originalFileName);

            // ★ 如果目标文件名已存在，添加序号避免覆盖
            if (fs.existsSync(targetPath) && targetPath !== verifiedPath) {
                const ext = path.extname(originalFileName);
                const base = path.basename(originalFileName, ext);
                let counter = 1;
                while (fs.existsSync(targetPath)) {
                    targetPath = path.join(dir, `${base} (${counter})${ext}`);
                    counter++;
                }
            }

            if (targetPath !== verifiedPath) {
                try {
                    fs.renameSync(verifiedPath, targetPath);
                    this.log(`重命名: ${path.basename(verifiedPath)} -> ${path.basename(targetPath)}`);

                    // ★ 重命名后立即更新事务：将旧路径替换为新路径
                    // 这样即使在记入 landedFiles 前取消，回滚也能正确清理
                    if (task && task.transId) {
                        try {
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === task.transId);
                            if (trans) {
                                const oldTemp = (trans.tempFiles || []).filter(f => f !== verifiedPath && f !== filePath);
                                oldTemp.push(targetPath);  // 添加新路径
                                await global.TransactionManager.updateTransaction(task.transId, { tempFiles: [...new Set(oldTemp)] });
                            }
                        } catch (e) {
                            this.log(`[事务] 更新 tempFiles 失败: ${e.message}`);
                        }
                    }

                    finalPath = targetPath;
                } catch (e) {
                    this.log(`重命名失败: ${e.message}，保留原文件名`);
                }
            }
        }

        // ★ 新文件：记入事务（使用规范化路径）
        if (this._isTaskCancelled(task)) return null;  // ★ 取消检查

        const normalizedPath = path.normalize(finalPath);
        if (task && task.transId) {
            const trans = global.TransactionManager.getTransactions().find(t => t.id === task.transId);
            if (trans) {
                const newLanded = [...(trans.landedFiles || []), normalizedPath];
                // De-dupe
                await global.TransactionManager.updateTransaction(task.transId, { landedFiles: [...new Set(newLanded)] });
            }
        }

        await this._insertToCursor(task, path.basename(finalPath), finalPath);
        // ★ 返回 isNew: true，表示新文件
        return { path: normalizedPath, isNew: true };
    }

    async _insertToCursor(task, fileName, fullPath) {
        if (this._isTaskCancelled(task)) return;

        // 如果是外部事务 (headless mode)，通常 q1.js 会处理插入 (通过 formatResultToText)
        if (task.isExternalTrans) return;

        const targetUri = task.targetUri;
        if (targetUri) {
            // Background insertion using WorkspaceEdit
            try {
                // ★ 拦截不存在的路径，防止触发编辑器找不到文件的弹窗
                if (!fs.existsSync(targetUri.fsPath)) return;
                const doc = await vscode.workspace.openTextDocument(targetUri);
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

        try {
            const docDir = path.dirname(editor.document.uri.fsPath);
            let relPath = path.relative(docDir, fullPath).replace(/\\/g, '/');

            await editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, `/\\${relPath}\\/\n`);
            });
        } catch (e) {
            this.log(`insertPathToEditor failed: ${e.message}`);
        }
    }

    // ==================== 增强流程入口 ====================
    async handleForbidden(task, code, url, targetDir, progressCallback) {
        // ★ 必须重新进入 tracker 上下文，否则后续产生的子进程（如 puppeteer/chrome）无法被追踪和通过 task.tracker 杀死
        return await ChildProcessTracker.runWithTracker(task.tracker, async () => {
            if (this._isTaskCancelled(task)) return null;

            // ★ 此处无需长时间等待，因为外部已结束 withProgress
            await this._sleep(100);

            // ★ 如果当前没有其他活跃下载任务，重置“弹窗被吃掉”的状态，以保证优先尝试 Q 弹窗
            if (_activeTasks.size <= 1) {
                if (_isInfoMessageEaten) {
                    this.log(`[增强] 检测到环境已恢复正常（活跃任务数: ${_activeTasks.size}），重置弹窗判断状态。`);
                    _isInfoMessageEaten = false;
                }
            }

            const prefix = task?.taskTitle ? `${task.taskTitle} ` : 'qqq: ';

            // ★ 如果之前已知弹窗会被吃掉且任务较多，直接走 QuickPick 流程
            let selection = undefined;
            let elapsed = 9999;

            if (!_isInfoMessageEaten) {
                const startTime = Date.now();
                selection = await vscode.window.showInformationMessage(
                    `${prefix}下载被拒（${code}），当前可尝试启动增强流程。`,
                    { modal: false },
                    "🚀启动增强流程",
                    "选择类似 chrome.exe 的浏览器入口文件"
                );
                elapsed = Date.now() - startTime;
            } else {
                this.log(`[增强] 处于弹窗被吃掉模式，跳过 InformationMessage 直接尝试兜底逻辑...`);
            }

            // ★ 如果被立即关闭（< 500ms 且 undefined），用 QuickPick 兆底
            if (selection === undefined && elapsed < 500) {
                this.log(`[增强] 弹窗被异常关闭 (${elapsed}ms)，记录状态并改用下拉选择...`);
                _isInfoMessageEaten = true;

                if (this._isTaskCancelled(task)) return null;

                const items = [
                    { label: '🚀 启动增强流程', value: 'enhanced' },
                    { label: '📂 选择类似 chrome.exe 的浏览器入口文件', value: 'pick' },
                    { label: '❌ 取消', value: 'cancel' }
                ];

                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: `${prefix}下载被拒（${code}），当前可尝试启动增强流程。（窗口被vs code吃掉，固走本下拉框流程，本质是一样）`,
                    ignoreFocusOut: true
                });

                this.log(`[增强] QuickPick 返回: ${picked?.value || 'undefined'}`);

                if (picked?.value === 'enhanced') {
                    selection = "🚀启动增强流程";
                } else if (picked?.value === 'pick') {
                    selection = "选择类似 chrome.exe 的浏览器入口文件";
                } else if (picked === undefined) {
                    // ★ QuickPick 也失败了，用 InputBox 作为终极兆底
                    this.log(`[增强] QuickPick 也失败，使用 InputBox 终极兆底...`);

                    const input = await vscode.window.showInputBox({
                        prompt: `${prefix}下载被拒（${code}），键入 1 启动增强流程，2 选择浏览器，其他取消`,
                        placeHolder: '键入 1 或 2',
                        ignoreFocusOut: true
                    });

                    this.log(`[增强] InputBox 返回: ${input}`);

                    if (input?.trim() === '1') {
                        selection = "🚀启动增强流程";
                    } else if (input?.trim() === '2') {
                        selection = "选择类似 chrome.exe 的浏览器入口文件";
                    }
                }
            }

            if (this._isTaskCancelled(task)) return null;

            if (selection === "🚀启动增强流程") {
                return await this._runEnhancedPreferSaved(task, url, targetDir);
            } else if (selection === "选择类似 chrome.exe 的浏览器入口文件") {
                return await this._runEnhancedForcePick(task, url, targetDir);
            } else {
                this.log("用户取消增强流程");
                return null;
            }
        });
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

    /**
     * ★ 获取目录中当前文件列表（用于排除已有文件）
     */
    _getExistingFileSet(targetDir) {
        const set = new Set();
        try {
            if (fs.existsSync(targetDir)) {
                const files = fs.readdirSync(targetDir);
                for (const f of files) set.add(f.toLowerCase());
            }
        } catch (e) { }
        return set;
    }

    /**
     * ★ 扫描新增文件大小（排除任务开始前已存在的文件，避免多任务互相干扰）
     */
    _scanNewBytes(targetDir, existingFiles) {
        let total = 0;
        try {
            if (!fs.existsSync(targetDir)) return 0;
            const files = fs.readdirSync(targetDir);
            for (const f of files) {
                // ★ 只计算任务开始后新增的文件
                if (existingFiles.has(f.toLowerCase())) continue;
                const full = path.join(targetDir, f);
                try {
                    const s = fs.statSync(full);
                    if (s.isFile()) total += s.size;
                } catch (e) { }
            }
        } catch (e) { }
        return total;
    }

    async _downloadEnhancedOne(task, url, targetDir, bestVideo) {
        const urlSnippet = this._makeUrlSnippet(url);
        const startMs = Date.now();
        // ★ 记录任务开始前已存在的文件，避免多任务互相干扰
        const existingFiles = this._getExistingFileSet(targetDir);

        const out = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "",
            cancellable: true
        }, async (progress, token) => {
            // ★ 增强下载解析阶段
            progress.report({ message: QvideoMsg.parsing(task, url) });

            token.onCancellationRequested(
                ChildProcessTracker.bind(async () => {
                    await this._cancelTask(task, '用户在增强下载窗口点取消');
                })
            );

            let timer = null;
            try {
                timer = setInterval(() => {
                    if (this._isTaskCancelled(task)) return;

                    // ★ 检查锚点是否丢失
                    if (task.shouldCancel && typeof task.shouldCancel === 'function') {
                        try {
                            if (task.shouldCancel()) {
                                this.log('[AnchorLost] 增强流程检测到锚点丢失');
                                task.anchorLost = true;
                                this._cancelTask(task, '锚点丢失').catch(e => { });
                                return;
                            }
                        } catch (e) { }
                    }

                    // ★ 使用新增文件扫描，避免多任务互相干扰
                    const bytes = this._scanNewBytes(targetDir, existingFiles);
                    const elapsedMs = Date.now() - startMs;
                    progress.report({ message: QvideoMsg.progress(task, this._formatBytesSimple(bytes), url, elapsedMs, '增强下载中') });
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

            this.log(`[增强] 准备显示"我已在外部播放"弹窗...`);

            // ★ 启动锚点检查定时器（在等待用户确认期间检查锚点）
            let anchorCheckTimer = null;
            let anchorLostDuringWait = false;
            anchorCheckTimer = setInterval(() => {
                if (task.shouldCancel && typeof task.shouldCancel === 'function') {
                    try {
                        if (task.shouldCancel()) {
                            this.log('[AnchorLost] 噗探等待期间检测到锚点丢失');
                            task.anchorLost = true;
                            anchorLostDuringWait = true;
                            this._cancelTask(task, '锚点丢失').catch(e => { });
                            // 尝试停止 sniffer（如果它未被 track 追踪到）
                            if (sniffer) try { sniffer.stop(); } catch (e) { }
                        }
                    } catch (e) { }
                }
            }, 500);

            // ★ 如果当前没有其他活跃下载任务，重置“弹窗被吃掉”的状态
            if (_activeTasks.size <= 1) {
                if (_isInfoMessageEaten) {
                    this.log(`[增强] 嘗探阶段检测到环境已恢复正常，重置弹窗判断状态。`);
                    _isInfoMessageEaten = false;
                }
            }

            // ★ 先尝试模态弹窗（Windows 级别，阻止其他操作，不会自动消失）
            let selection = undefined;
            let elapsed = 9999;

            if (!_isInfoMessageEaten) {
                const startTime = Date.now();
                selection = await vscode.window.showInformationMessage(
                    QvideoMsg.prompt(task, '请在打开的浏览器中播放视频（用你期望的分辨率），完成后点击下方按钮。'),
                    { modal: true },
                    "我已在外部播放"
                );
                elapsed = Date.now() - startTime;
            } else {
                this.log(`[增强] 嘗探阶段处于弹窗被吃掉模式，跳过 InformationMessage 直接尝试兜底逻辑...`);
            }

            // ★ 停止锚点检查定时器
            if (anchorCheckTimer) {
                clearInterval(anchorCheckTimer);
                anchorCheckTimer = null;
            }

            // ★ 如果等待期间锚点丢失，立即返回
            if (anchorLostDuringWait || this._isTaskCancelled(task)) {
                try { await sniffer.stop(); } catch (e) { }
                return null;
            }

            this.log(`[增强] 弹窗返回: selection=${selection}, 耗时=${elapsed}ms`);

            // ★ 如果被立即关闭，用 QuickPick 兆底
            if (selection === undefined && elapsed < 500) {
                this.log(`[增强] 嘗探确认弹窗被异常关闭 (${elapsed}ms)，记录状态并改用下拉选择...`);
                _isInfoMessageEaten = true;

                if (this._isTaskCancelled(task)) {
                    try { await sniffer.stop(); } catch (e) { }
                    return null;
                }

                const items = [
                    { label: '✅ 我已在外部播放', value: 'done' },
                    { label: '❌ 取消', value: 'cancel' }
                ];

                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: QvideoMsg.prompt(task, '请在打开的浏览器中播放视频（用你期望的分辨率），完成后点击下方按钮。'),
                    ignoreFocusOut: true
                });

                this.log(`[增强] QuickPick 返回: ${picked?.value || 'undefined'}`);

                if (picked?.value === 'done') {
                    selection = "我已在外部播放";
                } else if (picked === undefined) {
                    // ★ QuickPick 也失败了，用 InputBox 作为终极兆底
                    this.log(`[增强] QuickPick 也失败，使用 InputBox 终极兆底...`);

                    const input = await vscode.window.showInputBox({
                        prompt: QvideoMsg.prompt(task, '请在浏览器中播放视频，然后键入 ok 并回车'),
                        placeHolder: '键入 ok 确认',
                        ignoreFocusOut: true
                    });

                    this.log(`[增强] InputBox 返回: ${input}`);

                    if (input && input.toLowerCase().trim() === 'ok') {
                        selection = "我已在外部播放";
                    }
                }
            }

            if (selection !== "我已在外部播放") {
                try { await sniffer.stop(); } catch (e) { }
                this.log("用户取消增强嘗探");
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

            // ★ 等待前一个弹窗关闭（VS Code UI 有延迟，需要较长时间）
            await this._sleep(300);

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

module.exports = Qvideo;

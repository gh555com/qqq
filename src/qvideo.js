const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const h = require('./h');
const { getSharedDownloader } = require('./dow');
const https = require('https');
const global = require('./global');
const { TaskCounter, TaskMessage, formatTimeCompact, formatBytesCompact } = require('./global');
const { q } = require('./i18n');

// ★ Module-level utility function
const _sleep = ms => new Promise(r => setTimeout(r, ms));

// ==================== ★ Video download message adapter (use TaskMessage as the single source of truth) ====================
const QvideoMsg = {
    /**
     * ★ Parsing-stage message (show first 44 chars of the full URL)
     */
    parsing(task, url) {
        const prefix = task?.taskTitle ? `${task.taskTitle} ` : 'qqq: ';
        const urlSnippet = this._truncateUrl(url, 44);
        return `${prefix}${q('video.msg.parsing', urlSnippet)}`;
    },

    /**
     * ★ Build progress message
     * @param {Object} task - Task object (includes taskTitle, videoTitle)
     * @param {string} sizeStr - Exchanged size string, e.g. "7m"
     * @param {string} url - Original URL
     * @param {number} [elapsedMs] - Elapsed milliseconds (show only if > 20 minutes)
     * @param {string} [statusSuffix] - Status suffix, e.g. "Enhanced downloading"
     */
    progress(task, sizeStr, url, elapsedMs = 0, statusSuffix = '') {
        const prefix = task?.taskTitle ? `${task.taskTitle} ` : 'qqq: ';

        // ★ Elapsed time: only show if > 20 minutes
        const TWENTY_MIN = 20 * 60 * 1000;
        const timePart = elapsedMs >= TWENTY_MIN ? ` (${formatTimeCompact(elapsedMs)})` : '';

        // ★ Status suffix
        const statusPart = statusSuffix ? ` (${statusSuffix})` : '';

        // ★ With title: domain(28)▶title(44); without title: first 44 chars of URL
        let locationPart;
        if (task?.videoTitle) {
            const domain = this._truncateByWidth(this._extractDomain(url), 28);
            const title = this._truncateByWidth(task.videoTitle, 44);
            locationPart = `${domain}▶${title}`;
        } else {
            locationPart = this._truncateUrl(url, 44);
        }

        return `${prefix}${q('video.msg.exchanged', sizeStr, timePart, statusPart, locationPart)}`;
    },

    /**
     * ★ Truncate URL (keep prefixes like https://www. etc.)
     */
    _truncateUrl(url, maxLen) {
        const s = String(url || '');
        if (s.length <= maxLen) return s;
        return s.slice(0, maxLen) + '...';
    },

    /**
     * ★ Truncate by display width (widely accepted best practice)
     * Full-width chars (CJK, etc.) = width 2; half-width chars = width 1
     */
    _truncateByWidth(str, maxWidth) {
        if (!str) return '';
        const s = String(str);
        let width = 0;
        let i = 0;
        for (; i < s.length; i++) {
            const code = s.charCodeAt(i);
            // Wide-char ranges: CJK + Japanese Kana + full-width punctuation + Emoji + Arabic/Hebrew, etc.
            const isWide = (
                (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
                (code >= 0x3000 && code <= 0x303F) ||   // CJK punctuation
                (code >= 0x3040 && code <= 0x30FF) ||   // Japanese Kana
                (code >= 0xFF00 && code <= 0xFFEF) ||   // Full-width forms
                (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul
                (code >= 0x0600 && code <= 0x06FF) ||   // Arabic
                (code >= 0x0590 && code <= 0x05FF) ||   // Hebrew
                (code >= 0x0E00 && code <= 0x0E7F) ||   // Thai
                (code >= 0x1F300 && code <= 0x1F9FF) || // Emoji
                (code >= 0x2600 && code <= 0x26FF)     // Misc symbols
            );
            const charWidth = isWide ? 2 : 1;
            if (width + charWidth > maxWidth) break;
            width += charWidth;
        }
        if (i < s.length) return s.slice(0, i) + '...';
        return s;
    },

    /**
     * ★ Extract main domain (e.g. youtube.com)
     */
    _extractDomain(url) {
        try {
            const u = new URL(String(url));
            // Strip leading www.
            return u.hostname.replace(/^www\./, '');
        } catch {
            return String(url).slice(0, 20);
        }
    },

    // ★ _formatTime has been moved to global.js formatTimeCompact to avoid duplicate implementation

    /**
     * Build task done message
     * @param {Object} task - Task object (includes taskTitle, startMs)
     * @param {number} landedCount - Number of landed files
     * @param {string} totalStr - Total size string, e.g. "19m"
     * @param {string} urlSnippet - URL snippet
     */
    done(task, landedCount, totalStr, urlSnippet) {
        const elapsedMs = Date.now() - (task?.startMs || Date.now());
        let summary;
        if (!landedCount || landedCount <= 0) {
            summary = q('video.msg.landed0', urlSnippet);
        } else {
            summary = q('video.msg.landedN', landedCount, totalStr, urlSnippet);
        }
        return TaskMessage.done(task?.taskTitle, summary, elapsedMs, task?.taskNum || '');
    },

    /**
     * Build user prompt message
     * @param {Object} task - Task object
     * @param {string} message - Prompt content
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

    async killAll(reason = q('video.reason.userCancel')) {
        this._cancelled = true;

        const pids = [];
        for (const p of Array.from(this._procs)) {
            if (p && typeof p.pid === 'number') pids.push(p.pid);
        }

        // Gentle first, then force-kill
        for (const pid of pids) await this._killPidTree(pid, false);
        await _sleep(400);
        for (const pid of pids) await this._killPidTree(pid, true);

        // ★ Removed _killYtdlpProcesses():
        // This would kill all yt-dlp processes on the system, causing tasks to interfere with each other
        // Now dow.js has been changed to dynamically get spawn, so it can be correctly tracked by tracker; no need for global brute-force cleanup

        this._procs.clear();
    }

    async _killPidTree(pid, force) {
        if (!pid || typeof pid !== 'number') return;

        const cp = require('child_process'); // lazy require
        const isWin = process.platform === 'win32';

        // ⚠️ kill itself must never be intercepted/tracked again, otherwise it will recursively pollute
        // So here we force using the "raw unpatched functions" (if already patched)
        const execFile = ChildProcessTracker.__origExecFile || cp.execFile;
        const execFileSync = ChildProcessTracker.__origExecFileSync || cp.execFileSync;

        if (isWin) {
            return new Promise(resolve => {
                const args = ['/PID', String(pid), '/T'];
                if (force) args.push('/F');
                execFile('taskkill', args, {
                    windowsHide: true,
                    // ✅ Double safety: even if someone mistakenly runs kill inside ALS scope, do not track
                    env: ChildProcessTracker._envNoTrack(),
                }, () => resolve());
            });
        }

        // mac/linux: kill children first, then parent
        try { execFileSync('pkill', [force ? '-KILL' : '-TERM', '-P', String(pid)], { stdio: 'ignore', env: ChildProcessTracker._envNoTrack() }); } catch (e) { }
        try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { }
        try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { }
    }

    // ==================== ALS: only make tracker visible to "this task's async chain" ====================
    static runWithTracker(tracker, fn) {
        ChildProcessTracker.ensurePatched();
        const store = tracker ? { tracker } : null;
        if (!store) return fn();
        return ChildProcessTracker.__als.run(store, fn);
    }

    // ✅ Final safeguard: bind a callback to current store
    // Some VSCode callbacks/events may detach from the original async chain; this ensures store isn't lost
    static bind(fn) {
        ChildProcessTracker.ensurePatched();
        const store = ChildProcessTracker.__als.getStore();
        if (!store) return fn;
        return (...args) => ChildProcessTracker.__als.run(store, () => fn(...args));
    }

    // ==================== Global patch: patch only once ====================
    static ensurePatched() {
        if (ChildProcessTracker.__patched) return;
        ChildProcessTracker.__patched = true;

        const cp = require('child_process');

        // Save original references (for kill / fallback bypass)
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

        // ✅ Pre-exclude: not in ALS scope => do nothing (won't affect other extensions / other chains)
        // ✅ Pre-exclude: has NO_TRACK flag => do nothing (you can opt-out yourself)
        // ✅ Pre-exclude: exclude "open file manager/system opener" type UI sub-processes to avoid accidental kill
        const shouldIntercept = (cmd, options) => {
            const store = ChildProcessTracker.__als.getStore();
            const tracker = store && store.tracker;

            if (!tracker) return false;

            // Even after task is cancelled, someone may still spawn; allow intercept and track for killAll fallback
            // if (tracker.isCancelled && tracker.isCancelled()) return false;

            if (ChildProcessTracker._hasNoTrackFlag(options)) return false;

            const base = getCmdBase(cmd);
            if (ChildProcessTracker.__excludedCmds.has(base)) return false;

            return true;
        };

        // ✅ Do not modify the original options object: only clone when we must change detached
        const cloneOptionsDetachedFalse = (opt) => {
            if (!isObj(opt)) return opt;
            if (opt.detached !== true) return opt; // If detached isn't true, do nothing (default is already false)
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

            // Force detached:false (only fix when detached===true; do not modify original object)
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

        // ---------- fork (if anyone uses it in your project) ----------
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

        // ---------- sync fallback: only force detached:false, do not track (no point) ----------
        if (ChildProcessTracker.__origSpawnSync) {
            cp.spawnSync = function (...args) {
                const cmd = args[0];
                let optionsIndex = -1;
                let options = null;

                if (args.length >= 3 && isObj(args[2])) { optionsIndex = 2; options = args[2]; }
                else if (args.length >= 2 && isObj(args[1]) && !Array.isArray(args[1])) { optionsIndex = 1; options = args[1]; }

                // Not in ALS scope / NO_TRACK / excluded => do nothing
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

    // ============ NO_TRACK support (opt-out marker for child processes you don't want tracked) ============
    static _envNoTrack() {
        // Clone each time to avoid external mutation pollution
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

// These commands are "open/shell UI" and should not be tracked; otherwise cancel may kill by mistake
ChildProcessTracker.__excludedCmds = new Set([
    'explorer.exe',
    'open',
    'xdg-open',
    'gio',          // Some Linux desktops use gio open
    'rundll32.exe', // Sometimes system open goes through it
]);

// ★ Shared output channel singleton (avoid multiple instances creating multiple channels)
let _sharedOutputChannel = null;
function getSharedOutputChannel() {
    if (!_sharedOutputChannel) {
        _sharedOutputChannel = vscode.window.createOutputChannel("qqq: Video Downloader");
    }
    return _sharedOutputChannel;
}

// ★ Active task set (to avoid tasks interfering with each other)
const _activeTasks = new Set();

// ★ Popup fallback state: whether info message popup was "eaten" by VS Code (module-level, persists across tasks)
let _isInfoMessageEaten = false;

class Qvideo {
    constructor(context, qqqManager) {
        this.context = context;
        this.qqq = qqqManager;
        this.downloader = getSharedDownloader();
        // ★ Use shared qqq log channel
        this.outputChannel = getSharedOutputChannel();

        this.chromeHome = this.context.globalStorageUri.fsPath;
        this.userDataDir = path.join(this.chromeHome, 'user-data');

        this.KEY_CUSTOM_BROWSER = 'customBrowserPath';
        this.KEY_DEDICATED_BROWSER = 'dedicatedChromeExePath';

        // Current task context (for total elapsed + real cancel)
        this._task = null;

        ChildProcessTracker.ensurePatched();
    }

    log(msg) {
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
    }

    // ★ _formatBytesSimple has been moved to global.js formatBytesCompact to avoid duplicate implementation

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
        return QvideoMsg._truncateByWidth(String(url || ''), 28);
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

    _createTask(videoUrl, title, targetDir, referer, transId = null) {
        let destPath = null;
        let originalFileName = null;  // ★ Save original file name
        let tempFileName = null;      // ★ Temp file name (with timestamp)

        // ★ Compute original file name
        if (title && title !== 'Direct Link' && title !== 'Web Resource') {
            originalFileName = this._sanitizeFilename(title) + ".mp4";
        } else {
            // ★ Extract file name from URL
            try {
                const u = new URL(videoUrl);
                const base = path.basename(u.pathname);
                if (base && base.match(/\.(mp4|webm|mkv|mov|flv|avi|wmv|m4v|mpg|mpeg|3gp|ts|ogv)$/i)) {
                    // ★ Decode then sanitize; keep Chinese etc.
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

        // ★ Use transId as filename prefix; rollback can precisely delete by transId
        tempFileName = h.getTimestampFilename('.mp4', transId);
        destPath = path.join(targetDir, tempFileName);

        const headers = {};
        if (referer) headers["Referer"] = referer;

        return {
            url: videoUrl,
            destPath: destPath,
            originalFileName: originalFileName,  // ★ Save original file name for rename on landing
            kind: "video",
            baseDir: targetDir,
            headers: headers,
            _debug_originalFileName: originalFileName  // ★ For debugging
        };
    }

    // ==================== Loose URL validation: block obviously-not-URL ====================
    _normalizeAndValidateUrl(raw) {
        let s = String(raw || '').trim();
        if (!s) return { ok: false };

        // Any whitespace => treat as not a URL (e.g. "custom button 123")
        if (/\s/.test(s)) return { ok: false };

        // Loose fix: https:/xxx -> https://xxx
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

    // ✅ Detect YouTube (completely exclude enhanced: pre-exclude + final safeguard)
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

    // ==================== Prefer the largest video file ====================
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

    // ==================== Hide notifications (best-effort) ====================
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

    // ==================== Popup #3: invalid URL (auto close in 9s) ====================
    async _showInvalidUrlToast(taskTitle = '') {
        const prefix = taskTitle ? `${taskTitle} ` : 'qqq: ';
        const msg = `${prefix}${q('video.log.invalidUrl')}`;
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

    // ==================== Popup #3: task done (auto close in 15s) ====================
    async _showTaskDoneToast(message, canOpen, filePath, folderPath, taskTitle = '') {
        // ★ Use withProgress to ensure auto-close in 15s
        // VS Code showInformationMessage does not support auto-close
        const { TaskMessage } = global;
        await TaskMessage.showSimpleToast(message, 15000, 'success');
    }

    // ==================== Suppress downloader internal popups ====================
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

    // ==================== Task context: total elapsed + real cancel + transaction ====================
    async _beginTask(targetDir, externalTransId = null) {
        // Remove dependency on this._task (instance state)

        // ★ Use 6-digit random ID
        const transId = externalTransId || global.TransactionManager.createTransactionId();

        const task = {
            startMs: Date.now(),
            tracker: new ChildProcessTracker(),
            transId: transId,
            isExternalTrans: !!externalTransId,
            isCancelled: false
        };

        // ★ Register transaction (if it's external, we assume it's already registered, or we can update just in case)
        if (!task.isExternalTrans) {
            await global.TransactionManager.saveTransaction({
                id: task.transId,
                targetDir: targetDir,
                tempFiles: [],
                landedFiles: [],
                landedFolders: [],
                taskType: 'video',  // ★ Video download task
                existingFiles: await global.getDirectorySnapshot(targetDir)  // ★ Directory snapshot at task start
            });
        }

        return task;
    }

    async _cancelTask(task, reason = q('video.reason.userCancel')) {
        if (!task || !task.tracker) return;
        // ★ Ensure cancel flag is set
        task.tracker.markCancelled();
        task.isCancelled = true;
        this.log(`qqq: ${q('video.log.cancelled', reason)}`);

        // ★ If it's an external transaction (called from performCurvedPaste), do not show popup; managed externally
        // ★ If it's an internal transaction (start called directly), show popup
        if (!task.isExternalTrans) {
            const cancelMsg = q('video.msg.cancelledRollback', task.taskTitle || 'qqq');
            global.TaskMessage.showSimpleToast(cancelMsg, 15000, 'cancel');
        }

        // ★ Rollback first (delete anchor etc.), but skip delayed fallback cleanup
        let targetDir = null;
        if (task.transId && !task.isExternalTrans) {
            const trans = global.TransactionManager.getTransactions().find(tr => tr.id === task.transId);
            if (trans) {
                targetDir = trans.targetDir;
                // ★ video type task will automatically skip delayed fallback cleanup
                await global.TransactionManager.rollback(trans);
            }
        }

        // ★ Kill processes first (critical; otherwise file handles are locked and cannot be deleted)
        try {
            await task.tracker.killAll(reason);
        } catch (e) { }

        // ★ After killing processes, wait a bit (give OS time to release file handles)
        await new Promise(resolve => setTimeout(resolve, 300));

        // ★ Immediately do fallback cleanup after processes are killed (pure)
        // This ensures files are not locked
        if (targetDir) {
            try {
                await global.TransactionManager._cleanupOrphanFiles(targetDir);
                this.log(`[兜底清理] ${q('video.log.fallbackCleanup')}`); // qq2q
            } catch (e) {
                this.log(`[兜底清理] ${q('video.log.fallbackCleanupError', e.message)}`); // qq2q
            }
        }
    }

    _isTaskCancelled(task) {
        // ★ Check three cancel conditions:
        // 1. Task's own isCancelled flag
        // 2. Tracker cancel state
        // 3. External shouldCancel callback (used to detect anchor loss)
        if (!task) return false;

        if (task.isCancelled || (task.tracker && task.tracker.isCancelled())) {
            return true;
        }

        // ★ Check external cancel callback (anchor lost)
        if (task.shouldCancel && task.shouldCancel()) {
            // ★ Immediately set cancel flag synchronously (do not wait for async ops)
            if (!task.isCancelled) {
                task.isCancelled = true;
                if (task.tracker) task.tracker.markCancelled();
                this.log(`[AnchorLost] ${q('video.log.anchorLost')}`);
                // ★ Kill processes and cleanup in background (do not await)
                this._cancelTask(task, q('video.reason.anchorLost')).catch(e => { });
            }
            return true;
        }

        // ★ While task is running, update transaction lastActiveAt (used as time baseline for recover scenario)
        // Internal throttling: update at most once every 5 seconds; does not block main flow
        if (task.transId) {
            global.TransactionManager.touchLastActive(task.transId).catch(() => { });
        }

        return false;
    }

    // ==================== Task end print (★ use unified formatter) ====================
    _buildDoneMessage(task, landedCount, totalStr, urlSnippet) {
        return QvideoMsg.done(task, landedCount, totalStr, urlSnippet);
    }

    // ==================== start ====================
    async start() {
        const raw = await vscode.window.showInputBox({
            prompt: q('video.ui.inputPrompt'),
            ignoreFocusOut: true,
            placeHolder: "https://..."
        });
        if (!raw) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            global.showAutoCloseNotification('error', q('video.ui.noEditorError'));
            return;
        }

        const currentDocDir = path.dirname(editor.document.uri.fsPath);
        const targetDir = path.join(currentDocDir, "qqq");
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        // ★ Generate task identifier
        const filePath = editor.document.uri.fsPath;
        const taskNum = await TaskCounter.increment(filePath);  // DB increment number (per file)
        const iconNum = await TaskCounter.incrementIcon();  // Global icon number (cross-file)
        const transId = global.TransactionManager.createTransactionId();  // 6-digit random ID
        const taskTitle = TaskCounter.formatTitle(filePath, transId, iconNum);  // Title uses transId + icon

        // Interactive mode
        const result = await this.downloadEntry(raw, targetDir, transId, null, null, null, taskTitle, null, taskNum);

        // ★ After progress popup ends, show done popup (auto close in 15s)
        // ★ Cancel popup is shown in _cancelTask; here show only success message
        if (result && result.doneMessage && !result.cancelled) {
            global.TaskMessage.showSimpleToast(result.doneMessage, 15000, 'success');
            // ★ Report stats (only when started independently; headless mode is reported by q1.js)
            if (result.finalTotalBytes) {
                global.saveVideoStats(result.finalTotalBytes);
            }
        }
    }

    // ==================== Headless Entry (for q1.js concurrency) ====================
    async downloadEntry(rawUrl, targetDir, transId, progressCallback, token, targetUri = null, taskTitle = '', shouldCancel = null, taskNum = null) {
        // 1. Init task context
        const task = await this._beginTask(targetDir, transId);

        // Save targetUri to task for insertion
        task.targetUri = targetUri;
        // ★ Save taskTitle to task object for all popups
        task.taskTitle = taskTitle;
        // ★ Save taskNum to task object for end message
        task.taskNum = taskNum;
        // ★ Save shouldCancel callback to check anchor loss in real time
        task.shouldCancel = shouldCancel;

        // ★ Add to active task set
        _activeTasks.add(task);

        // 2. Bind external cancel Token (if any)
        if (token) {
            token.onCancellationRequested(async () => {
                await this._cancelTask(task, '外部 Token 取消'); // qq2q
            });
        }

        try {
            // 3. Run inside Tracker scope
            return await ChildProcessTracker.runWithTracker(task.tracker, async () => {
                const v = this._normalizeAndValidateUrl(rawUrl);
                if (!v.ok) {
                    if (!progressCallback) await this._showInvalidUrlToast(task.taskTitle);
                    return null;
                }

                const url = v.url;

                // Ensure yt-dlp asynchronously
                this.downloader.ensureYtdlpReady(this.context).catch(e => console.error(e));

                this.log(q('video.log.startProcess', url));
                if (!progressCallback) this.outputChannel.show(true);

                // Cookies
                let cookiesFilePath = this._findBestCookieFileInGlobalStorage();
                if (cookiesFilePath) {
                    this.log(`[Cookies] ${q('video.log.usingCookies', cookiesFilePath)}`);
                }

                // 4. Execute core flow
                return await this._fastProcess(task, url, targetDir, cookiesFilePath, progressCallback);
            });
        } finally {
            // ★ Remove from active task set
            _activeTasks.delete(task);
        }
    }

    // ==================== Cookie helpers ====================
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
            // Sort by time desc, pick newest
            candidates.sort((a, b) => b.mtime - a.mtime);
            return candidates[0].path;
        } catch (e) {
            this.log(`[Cookies] ${q('video.log.cookieSearchError', e.message)}`);
            return null;
        }
    }

    async _handleCookieErrorIfNeeded(errorMsg, url) {
        if (!errorMsg) return;
        const msg = String(errorMsg);

        // Only for YouTube
        if (!this._isYouTubeUrl(url)) return;

        // Keyword match
        const keywords = ["Sign in", "404", "cookie", "bot", "confirm", "Unsupported URL", "Private video"];
        const hit = keywords.some(k => msg.includes(k));

        if (hit) {
            this.log(`[Cookies] ${q('video.log.cookieInvalid', msg)}`);

            // 1. Open folder
            const dir = this.context.globalStorageUri.fsPath;
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                await vscode.env.openExternal(vscode.Uri.file(dir));
            } catch (e) { }

            // 2. Open document
            const docPath = 'e:\\s\\wol\\py\\q3\\docs\\expert_cookies.txt';
            try {
                if (fs.existsSync(docPath)) {
                    await vscode.window.showTextDocument(vscode.Uri.file(docPath));
                }
            } catch (e) { }

            // ★ Fix: use prompt to add unified prefix
            const promptMsg = QvideoMsg.prompt(this._task, q('video.ui.youtubeFailed'));
            global.showAutoCloseNotification('warning', promptMsg);
        }
    }

    // ==================== Normal flow: popup #1 + popup #3 ====================
    async _fastProcess(task, url, targetDir, cookiesFilePath, progressCallback) {
        try {
            const urlSnippet = this._makeUrlSnippet(url);
            const isYouTube = this._isYouTubeUrl(url);

            const runLogic = async (progress, token) => {
                // ★ Parsing stage: use new parsing method
                progress.report({ message: QvideoMsg.parsing(task, url) });

                if (token) {
                    token.onCancellationRequested(
                        ChildProcessTracker.bind(async () => {
                            await this._cancelTask(task, q('video.reason.userCancelWindow1'));
                        })
                    );
                }

                this.log(q('video.log.sniffing'));
                let tasks = [];

                let probeForbidden = false;
                let hasStaticDirectVideo = false; // Whether static analysis found direct video links
                const staticDirectVideoUrls = new Set(); // ★ Track direct video URLs found by static analysis
                try {
                    if (this._isTaskCancelled(task)) return null;

                    const res = await this.downloader.probe(url, { cookiesFilePath });

                    if (this._isTaskCancelled(task)) return null;

                    if (res && res.success) {
                        if (res.isPlaylist && res.entries && res.entries.length > 0) {
                            this.log(q('video.log.playlistDetected', res.entries.length));
                            tasks = res.entries.map(e => this._createTask(e.url || e.webpage_url, e.title, targetDir, url, task.transId));
                            // ★ Playlist: keep full title (truncate handled by QvideoMsg)
                            task.videoTitle = res.entries[0]?.title || '';
                        } else {
                            this.log(q('video.log.singleVideo', res.title));
                            tasks.push(this._createTask(res.url || res.webpageUrl || url, res.title, targetDir, url, task.transId));
                            // ★ Single video: keep full title (truncate handled by QvideoMsg)
                            task.videoTitle = res.title || '';
                        }
                    } else {
                        if (this._isForbidden(403, res?.error)) {
                            if (!isYouTube) {
                                probeForbidden = true;
                                this.log(q('video.log.probe403'));
                                tasks.push(this._createTask(url, null, targetDir, url, task.transId));
                            } else {
                                // ✅ Pre-exclude: YouTube 403 is not an enhanced signal
                                this.log(q('video.log.youtubeProbe403'));
                                tasks.push(this._createTask(url, null, targetDir, url, task.transId));
                            }
                        } else {
                            this.log(q('video.log.probeNoResource', res?.error));
                            await this._handleCookieErrorIfNeeded(res?.error, url);
                        }
                    }
                } catch (e) {
                    if (this._isTaskCancelled(task)) return null;
                    this.log(q('video.log.probeException', e.message));
                    await this._handleCookieErrorIfNeeded(e.message, url);
                }

                // Static analysis (higher priority than 403 enhanced)
                try {
                    if (this._isTaskCancelled(task)) return null;
                    this.log(q('video.log.staticAnalysisStart', url));
                    const webUrls = await h.extractVideoUrlsFromWebPage(url);
                    this.log(q('video.log.staticAnalysisResult', webUrls ? webUrls.length : 0));
                    if (webUrls && webUrls.length > 0) {
                        this.log(q('video.log.staticAnalysisFound', webUrls.length));

                        // Check for direct video URL and record them
                        const directVideoPattern = /\.(mp4|m3u8|mpd|webm|mkv)(\?|$)/i;
                        webUrls.forEach(u => {
                            if (u.match(directVideoPattern)) {
                                staticDirectVideoUrls.add(u);
                            }
                        });
                        const hasDirectVideo = staticDirectVideoUrls.size > 0;

                        // As long as direct video is found, set flag and remove original 403 task
                        if (hasDirectVideo) {
                            hasStaticDirectVideo = true;
                            if (probeForbidden) {
                                this.log(q('video.log.staticFoundDirect'));
                                // Filter out the task that is just the raw URL
                                tasks = tasks.filter(t => t.url !== url);
                                probeForbidden = false; // Reset forbidden flag so we don't trigger enhanced mode unnecessarily
                            }
                        }

                        webUrls.forEach(u => tasks.push(this._createTask(u, 'Web Resource', targetDir, url, task.transId)));
                    }
                } catch (e) {
                    this.log(q('video.log.staticAnalysisFailed', e.message));
                }

                if (this._isTaskCancelled(task)) return null;

                tasks = this._deduplicateTasks(tasks);

                if (tasks.length === 0) {
                    this.log(q('video.log.noResourceTryDirect'));
                    tasks.push(this._createTask(url, 'Direct Link', targetDir, url, task.transId));
                }

                this.log(q('video.log.preparingDownload', tasks.length));
                progress.report({ message: QvideoMsg.progress(task, '0k', url, 0, '') });

                // ★ Key fix: pre-record all destPath into transaction tempFiles
                // This way, on cancel, even if the file is downloaded but not yet recorded into landedFiles, it can still be deleted via tempFiles
                if (task.transId) {
                    try {
                        const trans = global.TransactionManager.getTransactions().find(t => t.id === task.transId);
                        if (trans) {
                            const allDestPaths = tasks.map(t => t.destPath).filter(Boolean);
                            const newTempFiles = [...(trans.tempFiles || []), ...allDestPaths];
                            await global.TransactionManager.updateTransaction(task.transId, { tempFiles: [...new Set(newTempFiles)] });
                        }
                    } catch (e) {
                        this.log(`[事务] 预注册 tempFiles 失败: ${e.message}`); // qq2q
                    }
                }

                // ★ Precisely match by transId prefix; 100% no cross-task pollution
                // Filename format: {transId}_{date}__{day}__{time}{ext}
                const transIdPrefix = task.transId ? (task.transId + '_') : null;

                let logTotalBytes = 0;
                // ★ Precise progress tracking: per URL + per stage independent counting
                // key = url + stageIdx, avoid multi-stage overwrite
                const logProgressMap = new Map();  // url -> { completed: 0, current: 0, lastPeak: 0 }
                let useLogOnly = false;
                let noProgressTicks = 0;
                const FALLBACK_TICKS = 4;
                const downloadStartMs = Date.now();

                let fileSizeTimer = null;

                try {
                    fileSizeTimer = setInterval(() => {
                        // ★ Check cancel state every 500ms (including anchor loss)
                        if (this._isTaskCancelled(task)) {
                            // ★ Cancel detected, stop timer immediately
                            if (fileSizeTimer) {
                                clearInterval(fileSizeTimer);
                                fileSizeTimer = null;
                            }
                            // ★ Trigger cancel resolve (if any)
                            if (task._cancelResolve) {
                                task._cancelResolve();
                                task._cancelResolve = null;
                            }
                            return;
                        }

                        let finalBytes = 0;

                        // ★ Strategy: prefer yt-dlp progress callback (accurate and isolated)
                        if (logTotalBytes > 0) {
                            useLogOnly = true;  // lock-in
                            finalBytes = logTotalBytes;
                        } else if (useLogOnly) {
                            // ★ Locked but temporarily 0 (maybe switching files), keep using log
                            finalBytes = logTotalBytes;
                        } else {
                            // ★ yt-dlp hasn't reported progress yet, count ticks
                            noProgressTicks++;
                            if (noProgressTicks >= FALLBACK_TICKS) {
                                // ★ Fallback: scan disk by transId prefix (100% precise)
                                let diskBytes = 0;
                                try {
                                    if (transIdPrefix && fs.existsSync(targetDir)) {
                                        const files = fs.readdirSync(targetDir);
                                        for (const f of files) {
                                            // ★ Only count files starting with {transId}_
                                            if (f.startsWith(transIdPrefix)) {
                                                try {
                                                    const s = fs.statSync(path.join(targetDir, f));
                                                    if (s.isFile()) diskBytes += s.size;
                                                } catch (e) { }
                                            }
                                        }
                                    }
                                } catch (e) { }
                                finalBytes = diskBytes;
                            }
                        }

                        const totalStr = formatBytesCompact(finalBytes);
                        // ★ Compute elapsed (format mm:ss or hh:mm:ss)
                        const elapsedMs = Date.now() - downloadStartMs;
                        progress.report({ message: QvideoMsg.progress(task, totalStr, url, elapsedMs, '') });
                    }, 500);

                    if (this._isTaskCancelled(task)) return null;

                    let res;
                    try {
                        // ★ Create cancel Promise for Promise.race
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
                                        this.log(`开始: ${String(t.url).slice(0, 60)}...`); // qq2q
                                    } else if (event.type === 'progress') {
                                        const p = event.progress;
                                        let currentBytes = 0;
                                        if (typeof p === 'object' && p.currentSize) {
                                            currentBytes = this._parseSizeToBytes(p.currentSize);
                                        }
                                        if (currentBytes > 0) {
                                            // ★ Simplified accumulator: detect progress rollback then accumulate
                                            const entry = logProgressMap.get(t.url) || { completed: 0, current: 0, lastPeak: 0 };

                                            // ★ Key: if currentBytes is significantly smaller than lastPeak, new stage started
                                            if (currentBytes < entry.lastPeak * 0.8 && entry.lastPeak > 512 * 1024) {
                                                // New stage: add previous peak to completed
                                                entry.completed += entry.lastPeak;
                                                entry.current = currentBytes;
                                                entry.lastPeak = currentBytes;
                                            } else {
                                                // Same stage: update current and lastPeak
                                                entry.current = currentBytes;
                                                entry.lastPeak = Math.max(entry.lastPeak, currentBytes);
                                            }

                                            logProgressMap.set(t.url, entry);

                                            // ★ Sum: completed + current
                                            let sum = 0;
                                            for (const e of logProgressMap.values()) {
                                                sum += e.completed + e.current;
                                            }
                                            logTotalBytes = sum;
                                        }
                                    } else if (event.type === 'done') {
                                        this.log(`完成: ${path.basename(t.destPath || '')}`); // qq2q
                                    } else if (event.type === 'error') {
                                        this.log(`失败: ${t.url} - ${event.error}`); // qq2q
                                    } else if (event.type === 'retry') {
                                        this.log(`重试: ${t.url} (Wait ${event.delayMs}ms)`); // qq2q
                                    }
                                }
                            });
                        });

                        // ★ Use Promise.race: download done OR cancel, whichever comes first
                        res = await Promise.race([
                            downloadPromise,
                            cancelPromise.then(() => null)  // Return null on cancel
                        ]);

                        // ★ Cleanup cancel resolve
                        task._cancelResolve = null;
                    } catch (e) {
                        if (this._isTaskCancelled(task)) return null;
                        throw e;
                    }

                    if (this._isTaskCancelled(task)) {
                        // ★ After cancel, rollback cleans up
                        return null;
                    }

                    const results = res?.results || [];
                    const successResults = results.filter(r => r.success);
                    const failResults = results.filter(r => !r.success);

                    const landedFiles = [];
                    let finalTotalBytes = 0;

                    for (const r of successResults) {
                        if (this._isTaskCancelled(task)) {
                            this.log(`[取消] 在 _postProcess 循环中检测到取消，跳出`); // qq2q
                            return null;
                        }
                        const p = r.path || r.destPath;
                        // ★ Find corresponding task by destPath to get originalFileName
                        const matchedTask = tasks.find(t => t.destPath === p || t.destPath === r.destPath);
                        const originalFileName = matchedTask?.originalFileName || null;
                        // ★ Debug log
                        this.log(`[Match] p=${path.basename(p)}, r.destPath=${path.basename(r.destPath || '')}, matched=${!!matchedTask}, originalFileName=${originalFileName || '(null)'}`);
                        const result = await this._postProcess(task, p, originalFileName);
                        // ★ result.path is final path (new file or reused old file)
                        // ★ Transaction record is handled inside _postProcess (only record isNew: true)
                        if (result && result.path) {
                            landedFiles.push(result.path);
                            try { finalTotalBytes += fs.statSync(result.path).size; } catch (e) { }
                        }
                    }

                    const forbiddenErrors = failResults.filter(r => this._isForbidden(r.code || r.httpStatus, r.error));

                    // ✅ Linearize + pre-exclude: YouTube never triggers enhanced
                    // ★ Precise判断: whether direct videos found by static analysis are effective
                    // - If all those direct video URLs fail with 403 => ineffective, allow enhanced
                    // - If any succeeds, or fails but not 403 => effective, no enhanced
                    let staticVideoEffective = false;
                    if (hasStaticDirectVideo && staticDirectVideoUrls.size > 0) {
                        // Check download results of static direct videos
                        const staticVideoResults = results.filter(r => staticDirectVideoUrls.has(r.url));
                        const staticVideoAllForbidden = staticVideoResults.length > 0 &&
                            staticVideoResults.every(r => !r.success && this._isForbidden(r.code || r.httpStatus, r.error));
                        // Only when not all 403 do we consider static analysis effective
                        staticVideoEffective = !staticVideoAllForbidden;
                        if (staticVideoAllForbidden) {
                            this.log(`[增强判断] 静态分析的 ${staticVideoResults.length} 个直连视频全部 403 失败，允许进入增强流程`); // qq2q
                        }
                    }
                    // ★ Only trigger enhanced when there are actual 403 errors
                    // - Removed condition "landedFiles.length === 0 && successResults.length > 0"
                    // - Because some sites (e.g. Baidu) may download HTML instead of video; that should not trigger enhanced
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
                // ★ Cancel popup is shown in _cancelTask; here only return marker
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

            // ★ Cancel popup is shown in _cancelTask; here only return marker
            if (this._isTaskCancelled(task)) {
                return {
                    landedFiles: [],
                    finalTotalBytes: 0,
                    cancelled: true,
                    targetDir: targetDir
                };
            }

            // ✅ Final safeguard: even if someone breaks needEnhanced in the future, hard block YouTube enhanced here
            if (outcome.needEnhanced) {
                if (outcome.isYouTube || this._isYouTubeUrl(url)) {
                    this.log(`[增强] 检测到 YouTube 链接，忽略增强流程`); // qq2q
                } else {
                    // ★ Return special marker; outer qqq.js will call handleForbidden after withProgress closes
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

            // ★ When YouTube download fails, trigger cookies setup flow (independent of needEnhanced)
            if ((outcome.isYouTube || this._isYouTubeUrl(url)) && outcome.landedFiles.length === 0) {
                await this._handleCookieErrorIfNeeded('Sign in to confirm', url);
            }

            const landedCount = (outcome.landedFiles || []).length;
            const totalStr = formatBytesCompact(outcome.finalTotalBytes);

            const msg = this._buildDoneMessage(task, landedCount, totalStr, outcome.urlSnippet);
            this.log(msg);

            // ★ Prepare return result first
            const result = {
                landedFiles: outcome.landedFiles || [],
                finalTotalBytes: outcome.finalTotalBytes || 0,
                // ★ Pass done message and related info; caller decides when to show
                doneMessage: msg,
                canOpenDir: landedCount > 0,
                firstFile: this._pickFirstFileBySize(outcome.landedFiles || []),
                targetDir: targetDir
            };

            // ★ Return result to caller (for anchor replacement etc.) - do not show popup here
            return result;

        } catch (error) {
            // ★ Cancel popup is shown in _cancelTask
            if (this._isTaskCancelled(task)) {
                return {
                    landedFiles: [],
                    finalTotalBytes: 0,
                    cancelled: true,
                    targetDir: targetDir
                };
            }
            this.log(`处理失败: ${error.message}`); // qq2q
            return { landedFiles: [], finalTotalBytes: 0 };
        }
    }

    // ==================== Post-process: verify + fingerprint dedupe + rename + insert (return final landed path) ====================
    // ★ Return contract:
    //   - { path, isNew: true }  → newly downloaded file; should be recorded in transaction
    //   - { path, isNew: false } → reused old file; do not record in transaction (do not delete on cancel)
    //   - null                   → failed
    // ★ originalFileName: original file name (optional) used for renaming on landing (remove timestamp)
    async _postProcess(task, filePath, originalFileName = null) {
        // ★ Debug log
        this.log(`[_postProcess] 开始: filePath=${path.basename(filePath)}, originalFileName=${originalFileName || '(null)'}`); // qq2q
        if (this._isTaskCancelled(task)) {
            this.log(`[_postProcess] 开始时已取消，跳过`); // qq2q
            if (filePath && fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { }
            }
            return null;
        }
        if (!filePath || !fs.existsSync(filePath)) return null;

        // Fingerprint dedupe (only within same folder; do not dedupe across folders)
        try {
            if (this._isTaskCancelled(task)) return null;  // ★ Cancel check

            const currentFp = h.computeFingerprint(filePath);
            if (currentFp) {
                // ★ Only dedupe within same folder; allow same file across different folders
                const dir = path.dirname(filePath);
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    if (this._isTaskCancelled(task)) return null;  // ★ Cancel check

                    const full = path.join(dir, f);
                    if (full === filePath) continue;
                    if (!fs.statSync(full).isFile()) continue;
                    if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.tmp')) continue;

                    const otherFp = h.computeFingerprint(full);
                    if (otherFp === currentFp) {
                        this.log(`指纹重复，删除临时文件: ${path.basename(filePath)} -> 复用旧文件: ${f}`); // qq2q
                        try { fs.unlinkSync(filePath); } catch (e) { }
                        await this._insertToCursor(task, f, full);
                        // ★ Return isNew: false (reuse old file), do not record in transaction
                        return { path: full, isNew: false };
                    }
                }
            }
        } catch (e) {
            this.log(`指纹检查出错: ${e.message}`); // qq2q
        }

        this.log(`正在验证文件: ${path.basename(filePath)}`); // qq2q

        if (this._isTaskCancelled(task)) return null;  // ★ Cancel check

        // Use shared function for FFmpeg validation
        const verifiedPath = await h.verifyVideoFile(filePath);

        if (this._isTaskCancelled(task)) return null;  // ★ Cancel check

        if (!verifiedPath) {
            this.log(`文件无效 (非视频或损坏)，已由 verifyVideoFile 删除: ${filePath}`); // qq2q
            return null;
        }

        // ★ Rename to original file name (remove timestamp)
        let finalPath = verifiedPath;
        if (originalFileName) {
            if (this._isTaskCancelled(task)) return null;  // ★ Cancel check
            const dir = path.dirname(verifiedPath);
            let targetPath = path.join(dir, originalFileName);

            // ★ If target filename exists, add index to avoid overwrite
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
                    this.log(`重命名: ${path.basename(verifiedPath)} -> ${path.basename(targetPath)}`); // qq2q

                    // ★ After rename, immediately update transaction: replace old path with new path
                    // So even if canceled before landedFiles is recorded, rollback can clean correctly
                    if (task && task.transId) {
                        try {
                            const trans = global.TransactionManager.getTransactions().find(t => t.id === task.transId);
                            if (trans) {
                                const oldTemp = (trans.tempFiles || []).filter(f => f !== verifiedPath && f !== filePath);
                                oldTemp.push(targetPath);  // Add new path
                                await global.TransactionManager.updateTransaction(task.transId, { tempFiles: [...new Set(oldTemp)] });
                            }
                        } catch (e) {
                            this.log(`[事务] 更新 tempFiles 失败: ${e.message}`); // qq2q
                        }
                    }

                    finalPath = targetPath;
                } catch (e) {
                    this.log(`重命名失败: ${e.message}，保留原文件名`); // qq2q
                }
            }
        }

        // ★ New file: record into transaction (use normalized path)
        if (this._isTaskCancelled(task)) return null;  // ★ Cancel check

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
        // ★ Return isNew: true (new file)
        return { path: normalizedPath, isNew: true };
    }

    async _insertToCursor(task, fileName, fullPath) {
        if (this._isTaskCancelled(task)) return;

        // If external transaction (headless mode), q1.js usually handles insertion (via formatResultToText)
        if (task.isExternalTrans) return;

        const targetUri = task.targetUri;
        if (targetUri) {
            // Background insertion using WorkspaceEdit
            try {
                // ★ Intercept non-existing path to avoid editor "file not found" popup
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

    // ==================== Enhanced flow entry ====================
    async handleForbidden(task, code, url, targetDir, progressCallback) {
        // ★ Must re-enter tracker context, otherwise subsequent child processes (puppeteer/chrome) cannot be tracked and killed via task.tracker
        return await ChildProcessTracker.runWithTracker(task.tracker, async () => {
            if (this._isTaskCancelled(task)) return null;

            // ★ No need to wait long here because outer has ended withProgress
            await _sleep(100);

            // ★ If there are no other active download tasks, reset the "popup eaten" state so we can try Q popup first
            if (_activeTasks.size <= 1) {
                if (_isInfoMessageEaten) {
                    this.log(`[增强] 检测到环境已恢复正常（活跃任务数: ${_activeTasks.size}），重置弹窗判断状态。`); // qq2q
                    _isInfoMessageEaten = false;
                }
            }

            const prefix = task?.taskTitle ? `${task.taskTitle} ` : 'qqq: ';

            // ★ If previously known popups get eaten and there are many tasks, go directly to QuickPick fallback
            let selection = undefined;
            let elapsed = 9999;

            if (!_isInfoMessageEaten) {
                const startTime = Date.now();
                selection = await vscode.window.showInformationMessage(
                    `${prefix}下载被拒（${code}），当前可尝试启动增强流程。`, // qq2q
                    { modal: false },
                    "🚀启动增强流程", // qq2q
                    "选择类似 chrome.exe 的浏览器入口文件" // qq2q
                );
                elapsed = Date.now() - startTime;
            } else {
                this.log(`[增强] 处于弹窗被吃掉模式，跳过 InformationMessage 直接进入 QuickPick 兜底...`); // qq2q
                elapsed = 0;  // ★ Key fix: force 0 to trigger QuickPick fallback
            }

            // ★ If closed immediately (< 500ms and undefined), use QuickPick fallback
            if (selection === undefined && elapsed < 500) {
                this.log(`[增强] 弹窗被异常关闭 (${elapsed}ms)，记录状态并改用下拉选择...`); // qq2q
                _isInfoMessageEaten = true;

                if (this._isTaskCancelled(task)) return null;

                const items = [
                    { label: q('video.ui.enhancedStart'), value: 'enhanced' },
                    { label: q('video.ui.pickBrowser'), value: 'pick' },
                    { label: q('video.ui.cancel'), value: 'cancel' }
                ];

                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: `${prefix}${q('video.ui.rejected', code)}${q('video.ui.rejectedFallback')}`,
                    ignoreFocusOut: true
                });

                this.log(`[增强] QuickPick 返回: ${picked?.value || 'undefined'}`); // qq2q

                if (picked?.value === 'enhanced') {
                    selection = "🚀启动增强流程"; // qq2q
                } else if (picked?.value === 'pick') {
                    selection = "选择类似 chrome.exe 的浏览器入口文件"; // qq2q
                } else if (picked === undefined) {
                    // ★ QuickPick also failed; use InputBox as ultimate fallback
                    this.log(`[增强] QuickPick 也失败，使用 InputBox 终极兆底...`); // qq2q

                    const input = await vscode.window.showInputBox({
                        prompt: `${prefix}${q('video.ui.input12Prompt', code)}`,
                        placeHolder: q('video.ui.input12'),
                        ignoreFocusOut: true
                    });

                    this.log(`[增强] InputBox 返回: ${input}`); // qq2q

                    if (input?.trim() === '1') {
                        selection = "🚀启动增强流程"; // qq2q
                    } else if (input?.trim() === '2') {
                        selection = "选择类似 chrome.exe 的浏览器入口文件"; // qq2q
                    }
                }
            }

            if (this._isTaskCancelled(task)) return null;

            if (selection === "🚀启动增强流程") { // qq2q
                return await this._runEnhancedPreferSaved(task, url, targetDir);
            } else if (selection === "选择类似 chrome.exe 的浏览器入口文件") { // qq2q
                return await this._runEnhancedForcePick(task, url, targetDir);
            } else {
                this.log(q('video.log.userCancelEnhanced'));
                return null;
            }
        });
    }

    // ==================== Embedded environment related ====================

    /**
     * ★ Get embedded Chrome path (do not check existence)
     */
    _getEmbeddedChromePath() {
        const platform = process.platform;
        const arch = process.arch;
        let folderName;
        if (platform === 'win32') {
            folderName = (arch === 'x64' || arch === 'arm64') ? 'chrome-win64' : 'chrome-win32';
        } else if (platform === 'darwin') {
            folderName = arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64';
        } else {
            folderName = 'chrome-linux64';
        }
        const exeName = platform === 'win32' ? 'chrome.exe' : 'chrome';
        return path.join(this.chromeHome, folderName, exeName);
    }

    /**
     * ★ z-check: check whether embedded environment is available
     * @returns {{ available: boolean, path: string, version?: string }}
     */
    async _checkEmbeddedChrome() {
        const embeddedPath = this._getEmbeddedChromePath();
        this.log(`[z判断] 检查内嵌环境: ${embeddedPath}`); // qq2q

        if (!fs.existsSync(embeddedPath)) {
            this.log(`[z判断] 内嵌环境不存在`); // qq2q
            return { available: false, path: embeddedPath };
        }

        const v = await this._validateChromiumSilently(embeddedPath);
        if (v.valid) {
            this.log(`[z判断] 内嵌环境可用: ${v.version}`); // qq2q
            return { available: true, path: embeddedPath, version: v.version };
        } else {
            this.log(`[z判断] 内嵌环境验证失败: ${v.error}`); // qq2q
            return { available: false, path: embeddedPath };
        }
    }

    // ==================== New enhanced flow (button 1)====================

    /**
     * ★ Button 1: start enhanced flow
     * Priority: saved → embedded → pick exe → secondary confirmation
     */
    async _runEnhancedPreferSaved(task, url, targetDir) {
        await this._cleanupSavedBrowserPaths();
        if (this._isTaskCancelled(task)) return null;

        // ★ 1. Check saved (user selected browser before)
        const custom = this.context.globalState.get(this.KEY_CUSTOM_BROWSER);
        if (custom && fs.existsSync(custom)) {
            const v = await this._validateChromiumSilently(custom);
            if (v.valid) {
                this.log(`[按钮一] 使用记忆的用户浏览器: ${custom} (${v.version})`); // qq2q
                return await this._startSniffer(task, custom, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
            } else {
                this.log(`[按钮一] 记忆的浏览器已失效，清除记忆`); // qq2q
                await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);
            }
        }

        if (this._isTaskCancelled(task)) return null;

        // ★ 2. z-check: check embedded environment
        const embedded = await this._checkEmbeddedChrome();
        if (embedded.available) {
            this.log(`[按钮一] 使用内嵌环境: ${embedded.path}`); // qq2q
            return await this._startSniffer(task, embedded.path, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
        }

        if (this._isTaskCancelled(task)) return null;

        // ★ 3. Embedded not available → show exe picker
        return await this._pickExeThenFallback(task, url, targetDir, true);
    }

    // ==================== New enhanced flow (button 2)====================

    /**
     * ★ Button 2: pick exe
     * Let user update preference; priority: pick exe → embedded → secondary confirmation
     */
    async _runEnhancedForcePick(task, url, targetDir) {
        if (this._isTaskCancelled(task)) return null;
        return await this._pickExeThenFallback(task, url, targetDir, false);
    }

    // ==================== Fallback logic after picking exe ====================

    /**
     * ★ Show exe picker; on failure, fallback logic depends on parameter
     * @param {boolean} skipEmbeddedFallback - If true, after failure go directly to secondary confirmation (button 1 scenario; embedded already checked)
     *                                        If false, after failure check embedded first (button 2 scenario)
     */
    async _pickExeThenFallback(task, url, targetDir, skipEmbeddedFallback) {
        if (this._isTaskCancelled(task)) return null;

        // ★ Show exe picker window
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: process.platform === 'win32'
                ? { 'Executables': ['exe'] }
                : { 'Executables': ['', 'app'] },
            title: "请选择 Chromium 内核浏览器的可执行文件" // qq2q
        });

        if (this._isTaskCancelled(task)) return null;

        // ★ User picked a file
        if (uris && uris.length > 0) {
            const exePath = uris[0].fsPath;
            this.log(`[选择exe] 用户选择: ${exePath}`); // qq2q

            const validation = await this._validateChromiumSilently(exePath);
            if (this._isTaskCancelled(task)) return null;

            if (validation.valid) {
                this.log(`[选择exe] 验证通过: ${validation.version}，记忆并启动`); // qq2q
                return await this._startSniffer(task, exePath, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
            }

            // ★ Picked a non-working exe
            this.log(`[选择exe] 验证失败: ${validation.error}`); // qq2q
        } else {
            // ★ User closed picker window
            this.log(`[选择exe] 用户关闭了选择窗口`); // qq2q
        }

        if (this._isTaskCancelled(task)) return null;

        // ★ Fallback logic after pick failure
        if (!skipEmbeddedFallback) {
            // Button 2 scenario: check embedded environment first
            const embedded = await this._checkEmbeddedChrome();
            if (embedded.available) {
                this.log(`[选择exe兜底] 内嵌环境可用，直接使用`); // qq2q
                return await this._startSniffer(task, embedded.path, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
            }
        }

        if (this._isTaskCancelled(task)) return null;

        // ★ All fallbacks failed → secondary confirmation
        return await this._showSecondaryConfirmation(task, url, targetDir);
    }

    // ==================== Secondary confirmation popup ====================

    /**
     * ★ Secondary confirmation: download chrome or terminate all
     * With QuickPick fallback to prevent popups being eaten in multi-task scenarios
     */
    async _showSecondaryConfirmation(task, url, targetDir) {
        if (this._isTaskCancelled(task)) return null;

        this.log(`[二次确认] 弹出选择: 下载chrome / 终止一切`); // qq2q

        let sel = undefined;
        const startTime = Date.now();

        sel = await vscode.window.showErrorMessage(
            q('video.ui.noBrowserConfirm'),
            q('video.ui.downloadChromeBtn'), q('video.ui.terminateBtn')
        );

        const elapsed = Date.now() - startTime;

        if (this._isTaskCancelled(task)) return null;

        // ★ Use QuickPick fallback when popup is eaten
        if (sel === undefined && elapsed < 500) {
            this.log(`[二次确认] 弹窗被吃掉 (${elapsed}ms)，使用 QuickPick 兜底...`); // qq2q

            const items = [
                { label: q('video.ui.downloadChrome'), value: 'download' },
                { label: q('video.ui.terminateAll'), value: 'cancel' }
            ];

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: q('video.ui.noBrowserSelect'),
                ignoreFocusOut: true
            });

            if (this._isTaskCancelled(task)) return null;

            if (picked?.value === 'download') {
                sel = q('video.ui.downloadChromeBtn');
            }
        }

        if (sel === q('video.ui.downloadChromeBtn')) {
            this.log(`[二次确认] 用户选择下载chrome`); // qq2q
            return await this._downloadChrome(task, url, targetDir);
        } else {
            this.log(`[二次确认] 用户终止增强流程`); // qq2q
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
                resolve({ valid: false, error: q('video.error.fileNotExist') });
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
                        resolve({ valid: false, error: q('video.error.cannotReadVersion') });
                        return;
                    }

                    const out = String(stdout || '').trim();
                    if (!out) {
                        resolve({ valid: false, error: q('video.error.versionEmpty') });
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
                        resolve({ valid: false, error: '不是 Chromium 内核浏览器' }); // qq2q
                    }
                });

                return;
            }

            cp.execFile(exePath, ['--version'], { timeout: 8000 }, (err, stdout, stderr) => {
                if (err) {
                    resolve({ valid: false, error: '无法执行 --version' }); // qq2q
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

        // ★ Multi-source fallback: npmmirror (CN) → Google official (overseas)
        return {
            sources: [
                { name: 'npmmirror (国内)', url: `https://cdn.npmmirror.com/binaries/chrome-for-testing/${version}/${platformKey}/${zipName}` }, // qq2q
                { name: 'Google (官方)', url: `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platformKey}/${zipName}` } // qq2q
            ],
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

        this.log(`[Chrome] 版本: ${chromeInfo.version}`); // qq2q
        this.log(`[Chrome] 平台: ${chromeInfo.platform}`); // qq2q
        this.log(`[Chrome] 目标目录: ${this.chromeHome}`); // qq2q
        this.log(`[Chrome] 可用源: ${chromeInfo.sources.map(s => s.name).join(', ')}`); // qq2q

        let exePath = null;

        exePath = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "qqq: 正在下载 Chrome for Testing...", // qq2q
            cancellable: true
        }, async (progress, token) => {
            let cancelled = false;
            token.onCancellationRequested(
                ChildProcessTracker.bind(async () => {
                    cancelled = true;
                    await this._cancelTask(task, '用户取消 Chrome 下载'); // qq2q
                })
            );

            // ★ Multi-source fallback download
            let lastError = null;
            for (let i = 0; i < chromeInfo.sources.length; i++) {
                const source = chromeInfo.sources[i];
                if (cancelled || this._isTaskCancelled(task)) return null;

                this.log(`[Chrome] 尝试源 ${i + 1}/${chromeInfo.sources.length}: ${source.name}`); // qq2q
                this.log(`[Chrome] URL: ${source.url}`);
                progress.report({ message: `0% - ${source.name} (版本 ${chromeInfo.version})` }); // qq2q

                try {
                    await this._downloadFile(source.url, zipPath, progress, () => cancelled || this._isTaskCancelled(task));

                    if (cancelled || this._isTaskCancelled(task)) {
                        try { fs.unlinkSync(zipPath); } catch (e) { }
                        return null;
                    }

                    // ★ Download succeeded, continue to extract
                    this.log(`[Chrome] 下载成功，来源: ${source.name}`); // qq2q
                    progress.report({ message: "解压中..." }); // qq2q

                    await this._extractZip(zipPath, this.chromeHome);

                    try { fs.unlinkSync(zipPath); } catch (e) { }

                    const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
                    const foundExe = this._findFileRecursive(this.chromeHome, exeName, 6);

                    if (!foundExe) throw new Error("解压完成但找不到 chrome 可执行文件"); // qq2q

                    this.log(`[Chrome] 找到: ${foundExe}`); // qq2q

                    if (process.platform === 'darwin' || process.platform === 'linux') {
                        try { cp.execSync(`chmod +x "${foundExe}"`); } catch (e) { }
                    }

                    const validation = await this._validateChromiumSilently(foundExe);
                    if (!validation.valid) throw new Error(`下载的 Chrome 验证失败: ${validation.error}`); // qq2q

                    this.log(`[Chrome] 验证通过: ${validation.version}`); // qq2q

                    return foundExe;

                } catch (e) {
                    lastError = e;
                    this.log(`[Chrome] 源 ${source.name} 失败: ${e.message}`); // qq2q
                    try { fs.unlinkSync(zipPath); } catch (e) { }

                    // ★ There is another source, continue
                    if (i < chromeInfo.sources.length - 1) {
                        this.log(`[Chrome] 尝试下一个源...`); // qq2q
                        continue;
                    }
                }
            }

            // ★ All sources failed
            if (this._isTaskCancelled(task)) return null;
            this.log(`[Chrome] 所有源都失败`); // qq2q
            global.showAutoCloseNotification('error', `下载 Chrome 失败: ${lastError?.message || '未知错误'}`); // qq2q
            return null;
        });

        if (!exePath) return;

        await this._startSniffer(task, exePath, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
    }

    _downloadFile(url, destPath, progress, isCancelled) {
        return new Promise((resolve, reject) => {
            const doRequest = (currentUrl, redirectCount = 0) => {
                if (redirectCount > 10) return reject(new Error('重定向次数过多')); // qq2q
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

    // ==================== Enhanced: pick best resource ====================
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
     * ★ Scan current task file size (precise match by transId prefix; 100% no cross-task pollution)
     * @param {string} targetDir - Target directory
     * @param {string} transId - Task transaction ID; filename format {transId}_{date}__{day}__{time}{ext}
     * @returns {number} Bytes downloaded so far by current task
     */
    _scanTaskBytes(targetDir, transId) {
        let total = 0;
        if (!transId) return 0;

        try {
            if (!fs.existsSync(targetDir)) return 0;
            const files = fs.readdirSync(targetDir);
            const prefix = transId + '_';  // ★ Precise prefix match

            for (const f of files) {
                // ★ Only count files starting with {transId}_ (including .part etc. temp files)
                if (!f.startsWith(prefix)) continue;
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
        // ★ existingFiles no longer needed; now use transId prefix precise match

        const out = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "",
            cancellable: true
        }, async (progress, token) => {
            // ★ Enhanced download parsing stage
            progress.report({ message: QvideoMsg.parsing(task, url) });

            token.onCancellationRequested(
                ChildProcessTracker.bind(async () => {
                    await this._cancelTask(task, q('video.reason.userCancelEnhanced'));
                })
            );

            let timer = null;
            try {
                timer = setInterval(() => {
                    if (this._isTaskCancelled(task)) return;

                    // ★ Check whether anchor is lost
                    if (task.shouldCancel && typeof task.shouldCancel === 'function') {
                        try {
                            if (task.shouldCancel()) {
                                this.log(q('video.log.anchorLostEnhanced')); // qq2q
                                task.anchorLost = true;
                                this._cancelTask(task, q('video.reason.anchorLost')).catch(e => { });
                                return;
                            }
                        } catch (e) { }
                    }

                    // ★ Precise match by transId prefix; 100% no cross-task pollution
                    const bytes = this._scanTaskBytes(targetDir, task.transId);
                    const elapsedMs = Date.now() - startMs;
                    progress.report({ message: QvideoMsg.progress(task, formatBytesCompact(bytes), url, elapsedMs, q('video.ui.enhancedDownloading')) });
                }, 500);

                if (this._isTaskCancelled(task)) return null;

                await this._runWithSuppressedPopups(async () => {
                    // ★ Pass transId so downloaded filenames have transId prefix; rollback can precisely delete
                    await this.downloader.downloadVideos([bestVideo], targetDir, null, task.transId);
                });

            } finally {
                if (timer) {
                    try { clearInterval(timer); } catch (e) { }
                }
            }

            if (this._isTaskCancelled(task)) return null;

            await _sleep(300);

            const rawFiles = this._findLandedVideoFilesSince(targetDir, startMs);
            const landedFiles = [];
            let totalBytes = 0;

            // ★ Enhanced flow also goes through _postProcess validation and fingerprint registration
            for (const p of rawFiles) {
                if (this._isTaskCancelled(task)) break;
                const result = await this._postProcess(task, p);
                // ★ result.path is final path (new file or reused old file)
                if (result && result.path) {
                    landedFiles.push(result.path);
                    try { totalBytes += fs.statSync(result.path).size; } catch (e) { }
                }
            }

            return { landedFiles, totalBytes, urlSnippet };
        });

        return out;
    }

    // ==================== Sniffer (enhanced also needs popup #3 at end) ====================
    async _startSniffer(task, browserPath, url, targetDir, opts = {}) {
        if (this._isTaskCancelled(task)) return null;

        this.log("启动增强嗅探流程..."); // qq2q
        this.log(`浏览器: ${browserPath}`); // qq2q
        this.log(`用户数据目录: ${this.userDataDir}`); // qq2q

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
                    this.log(`[增强] 已写入 globalState: ${opts.rememberKey} = ${browserPath}`); // qq2q
                } catch (e) {
                    this.log(`[增强] 写入 globalState 失败: ${e.message}`); // qq2q
                }
            }

            if (this._isTaskCancelled(task)) {
                try { await sniffer.stop(); } catch (e) { }
                return null;
            }

            this.log(`[增强] 准备显示"我已在外部播放"弹窗...`); // qq2q

            // ★ Start anchor check timer (check anchor during waiting for user confirmation)
            let anchorCheckTimer = null;
            let anchorLostDuringWait = false;
            anchorCheckTimer = setInterval(() => {
                if (task.shouldCancel && typeof task.shouldCancel === 'function') {
                    try {
                        if (task.shouldCancel()) {
                            this.log('[AnchorLost] ' + q('video.log.anchorLostEnhanced')); // qq2q
                            task.anchorLost = true;
                            anchorLostDuringWait = true;
                            this._cancelTask(task, q('video.reason.anchorLost')).catch(e => { });
                            // Try to stop sniffer (if it wasn't tracked)
                            if (sniffer) try { sniffer.stop(); } catch (e) { }
                        }
                    } catch (e) { }
                }
            }, 500);

            // ★ If there are no other active download tasks, reset the "popup eaten" state
            if (_activeTasks.size <= 1) {
                if (_isInfoMessageEaten) {
                    this.log(`[增强] 嘗探阶段检测到环境已恢复正常，重置弹窗判断状态。`); // qq2q
                    _isInfoMessageEaten = false;
                }
            }

            // ★ Try modal dialog first (OS-level, blocks other ops, won't auto-dismiss)
            let selection = undefined;
            let elapsed = 9999;

            if (!_isInfoMessageEaten) {
                const startTime = Date.now();
                selection = await vscode.window.showInformationMessage(
                    QvideoMsg.prompt(task, '请在打开的浏览器中播放视频（用你期望的分辨率），完成后点击下方按钮。'), // qq2q
                    { modal: true },
                    "我已在外部播放" // qq2q
                );
                elapsed = Date.now() - startTime;
            } else {
                this.log(`[增强] 嘗探阶段处于弹窗被吃掉模式，跳过 InformationMessage 直接尝试兜底逻辑...`); // qq2q
            }

            // ★ Stop anchor check timer
            if (anchorCheckTimer) {
                clearInterval(anchorCheckTimer);
                anchorCheckTimer = null;
            }

            // ★ If anchor lost during wait, return immediately
            if (anchorLostDuringWait || this._isTaskCancelled(task)) {
                try { await sniffer.stop(); } catch (e) { }
                return null;
            }

            this.log(`[增强] 弹窗返回: selection=${selection}, 耗时=${elapsed}ms`); // qq2q

            // ★ If closed immediately, use QuickPick fallback
            if (selection === undefined && elapsed < 500) {
                this.log(`[增强] 嘗探确认弹窗被异常关闭 (${elapsed}ms)，记录状态并改用下拉选择...`); // qq2q
                _isInfoMessageEaten = true;

                if (this._isTaskCancelled(task)) {
                    try { await sniffer.stop(); } catch (e) { }
                    return null;
                }

                const items = [
                    { label: '✅ 我已在外部播放', value: 'done' }, // qq2q
                    { label: '❌ 取消', value: 'cancel' } // qq2q
                ];

                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: QvideoMsg.prompt(task, '请在打开的浏览器中播放视频（用你期望的分辨率），完成后点击下方按钮。'), // qq2q
                    ignoreFocusOut: true
                });

                this.log(`[增强] QuickPick 返回: ${picked?.value || 'undefined'}`); // qq2q

                if (picked?.value === 'done') {
                    selection = "我已在外部播放"; // qq2q
                } else if (picked === undefined) {
                    // ★ QuickPick also failed; use InputBox as ultimate fallback
                    this.log(`[增强] QuickPick 也失败，使用 InputBox 终极兆底...`); // qq2q

                    const input = await vscode.window.showInputBox({
                        prompt: QvideoMsg.prompt(task, '请在浏览器中播放视频，然后键入 ok 并回车'), // qq2q
                        placeHolder: '键入 ok 确认', // qq2q
                        ignoreFocusOut: true
                    });

                    this.log(`[增强] InputBox 返回: ${input}`); // qq2q

                    if (input && input.toLowerCase().trim() === 'ok') {
                        selection = "我已在外部播放"; // qq2q
                    }
                }
            }

            if (selection !== "我已在外部播放") { // qq2q
                try { await sniffer.stop(); } catch (e) { }
                this.log("用户取消增强嘗探"); // qq2q
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
                // ★ Return done message; do not show popup directly
                return { landedFiles: [], totalBytes: 0, doneMessage: msg0, canOpenDir: false, targetDir };
            }

            if (!best.meta) best.meta = {};
            if (best.headers) {
                best.meta.cookie = best.headers['Cookie'];
                best.meta.referer = best.headers['Referer'];
                best.meta.userAgent = best.headers['User-Agent'];
                best.meta.origin = best.headers['Origin'];
            }

            // ★ Wait for previous popup to close (VS Code UI has delay; needs longer time)
            await _sleep(300);

            const out = await this._downloadEnhancedOne(task, url, targetDir, best);
            if (!out) return null;
            if (this._isTaskCancelled(task)) return null;

            const landedCount = (out?.landedFiles || []).length;
            const totalStr = formatBytesCompact(out?.totalBytes);

            const msg = this._buildDoneMessage(task, landedCount, totalStr, out?.urlSnippet || urlSnippet);
            this.log(msg);

            const firstFile = this._pickFirstFileBySize(out?.landedFiles || []);
            // ★ Return full result (incl. done message); do not show popup directly
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

            this.log(`增强流程出错: ${e.message}`); // qq2q
            if (sniffer) {
                try { await sniffer.stop(); } catch (e2) { }
            }
            return null;
        }
    }
}

module.exports = Qvideo;


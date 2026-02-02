"use strict";

const http2 = require("http2");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const dns = require("dns");
const net = require("net");
const { pipeline, Transform } = require("stream");
// ★ 不在顶部缓存 spawn，改为每次使用时动态获取，以便 ChildProcessTracker 能正确追踪
const { spawnSync } = require("child_process");
let vscode = null;
try { vscode = require("vscode"); } catch { }

async function runPool(items, concurrency, worker) {
    if (!items || items.length === 0) return;
    concurrency = Math.max(1, Number(concurrency) || 1);

    let i = 0;
    let running = 0;

    return new Promise((resolve) => {
        const next = () => {
            while (running < concurrency && i < items.length) {
                const item = items[i++];
                running++;
                Promise.resolve()
                    .then(() => worker(item))
                    .catch(() => { })
                    .finally(() => {
                        running--;
                        if (i >= items.length && running === 0) resolve();
                        else next();
                    });
            }
            if (items.length === 0) resolve();
        };
        next();
    });
}

function sleep(ms) {
    ms = Math.max(0, Number(ms) || 0);
    return new Promise((r) => setTimeout(r, ms));
}

function findExecutableInPath(name) {
    const isWin = process.platform === "win32";
    const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
    const pathKey = isWin ? "Path" : "PATH";
    const paths = String(process.env[pathKey] || "")
        .split(path.delimiter)
        .filter(Boolean);

    for (const p of paths) {
        for (const ext of exts) {
            const full = path.join(p, name + ext);
            try {
                fs.accessSync(full, fs.constants.X_OK);
                return full;
            } catch { }
        }
    }
    return null;
}

function findExecutableInCommonPaths(name, candidates = null) {
    const isWin = process.platform === "win32";
    if (isWin) return null;

    const list =
        candidates ||
        [
            `/usr/local/bin/${name}`,
            `/opt/homebrew/bin/${name}`,
            `/usr/bin/${name}`,
            `/bin/${name}`,
        ];

    for (const p of list) {
        try {
            if (fs.existsSync(p)) {
                fs.accessSync(p, fs.constants.X_OK);
                return p;
            }
        } catch { }
    }
    return null;
}

function isBlobUrl(u) {
    return typeof u === "string" && u.startsWith("blob:");
}

function ensureDirForFile(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeUnlink(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch { }
}

function safeClose(fd) {
    try {
        if (typeof fd === "number") fs.closeSync(fd);
    } catch { }
}

function pipelineAsync(...streams) {
    return new Promise((resolve, reject) => {
        pipeline(...streams, (err) => (err ? reject(err) : resolve()));
    });
}

function nowTsForFilename() {
    return new Date()
        .toISOString()
        .replace(/[-:]/g, ".")
        .replace("T", "_")
        .slice(0, 23);
}

function guessExtension(url, kind) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();

        if (kind === "video") {
            const m = pathname.match(/\.(mp4|webm|mov|mkv|m4v|avi|ogv)(\?|$)/);
            if (m) return "." + m[1];
            return null;
        }

        const m = pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?|$)/);
        return m ? "." + m[1].replace("jpeg", "jpg") : null;
    } catch {
        return null;
    }
}

function generateFilename(url, kind) {
    const ext = guessExtension(url, kind) || (kind === "video" ? ".mp4" : ".png");
    const ts = nowTsForFilename();
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `${rand}_${ts}${ext}`;
}

function isPlatformOrSegmentVideo(url) {
    const s = String(url || "");
    const patterns = [
        /youtube\.com|youtu\.be/i,
        /bilibili\.com|b23\.tv/i,
        /twitter\.com|x\.com/i,
        /vimeo\.com/i,
        /dailymotion\.com/i,
        /tiktok\.com|douyin\.com/i,
        /weibo\.com/i,
        /\.m3u8(\?|$)/i,
        /\.mpd(\?|$)/i,
    ];
    return patterns.some((p) => p.test(s));
}

class ByteLimitTransform extends Transform {
    constructor(maxBytes, initialBytes = 0) {
        super();
        this.maxBytes = Math.max(0, Number(maxBytes) || 0);
        this.total = Math.max(0, Number(initialBytes) || 0);
    }
    _transform(chunk, enc, cb) {
        this.total += chunk.length;
        if (this.maxBytes > 0 && this.total > this.maxBytes) {
            cb(new Error("file_too_large"));
            return;
        }
        cb(null, chunk);
    }
}

function pickDecoder(contentEncoding) {
    const enc = String(contentEncoding || "").toLowerCase();
    if (!enc || enc.includes("identity")) return null;

    if (enc.includes("br") && typeof zlib.createBrotliDecompress === "function") {
        return zlib.createBrotliDecompress();
    }
    if (enc.includes("gzip")) return zlib.createGunzip();
    if (enc.includes("deflate")) return zlib.createInflate();

    return null;
}

function parseRetryAfterMs(retryAfter) {
    if (!retryAfter) return 0;
    const v = String(retryAfter).trim();
    if (!v) return 0;


    const sec = Number(v);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 60_000);


    const t = Date.parse(v);
    if (Number.isFinite(t)) {
        const delta = t - Date.now();
        return Math.max(0, Math.min(delta, 60_000));
    }

    return 0;
}

function computeBackoffMs(attemptIndex, retryAfterMs = 0) {
    const base = 250;
    const exp = Math.min(6_000, base * Math.pow(2, Math.max(0, attemptIndex - 1)));
    const jitter = Math.floor(Math.random() * 150);
    const normal = exp + jitter;

    if (retryAfterMs > 0) return Math.max(retryAfterMs, normal);
    return normal;
}

function isRetryableHttpStatus(status) {
    return (
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504
    );
}

function isWorthAntiHotlinkRetry(status) {
    return status === 401 || status === 403 || status === 406;
}

function isRetryableNetworkError(err) {
    const code = String(err?.code || "");
    const msg = String(err?.message || "");
    const retryCodes = new Set([
        "ECONNRESET",
        "ETIMEDOUT",
        "ESOCKETTIMEDOUT",
        "EAI_AGAIN",
        "ENOTFOUND",
        "ECONNREFUSED",
        "EPIPE",
        "ERR_STREAM_PREMATURE_CLOSE",
    ]);
    if (retryCodes.has(code)) return true;

    if (code.startsWith("ERR_HTTP2")) return true;

    if (msg.toLowerCase().includes("socket hang up")) return true;

    return false;
}

class HostSlotLimiter {
    constructor(maxHosts) {
        this.maxHosts = Math.max(1, Number(maxHosts) || 1);
        this.activeCounts = new Map();
        this.waiting = [];
    }

    async acquire(origin) {
        return new Promise((resolve) => {
            const tryAcquire = () => {
                if (this.activeCounts.has(origin)) {
                    this.activeCounts.set(origin, this.activeCounts.get(origin) + 1);
                    resolve();
                    return;
                }

                if (this.activeCounts.size < this.maxHosts) {
                    this.activeCounts.set(origin, 1);
                    resolve();
                    return;
                }

                this.waiting.push({ origin, resolve: tryAcquire });
            };

            tryAcquire();
        });
    }

    release(origin) {
        if (!this.activeCounts.has(origin)) return;

        const nextCount = this.activeCounts.get(origin) - 1;
        if (nextCount <= 0) {
            this.activeCounts.delete(origin);
            while (this.waiting.length > 0) {
                const next = this.waiting.shift();
                next.resolve();
                break;
            }
        } else {
            this.activeCounts.set(origin, nextCount);
        }
    }

    clear() {
        this.activeCounts.clear();
        this.waiting = [];
    }
}

function resolveSecurityProfile(level) {
    const lv = Number(level);
    if (lv === 2) {
        return {
            enableSSRFProtection: true,
            enableUrlProtocolAndCredsGuard: true,
            enableRedirectProtocolGuard: true,
            enableBaseDirGuard: true,
            enableDownloadLock: true,
            enableHeaderSanitize: true,
            enableContentLengthRangePrecheck: true,
            enableStrictResumeChecks: true,
            enableSymlinkGuard: true,
            enableProbeOutputLimit: true,
            enableFailFast: true,
        };
    }

    if (lv === 1) {

        return {
            enableSSRFProtection: false,
            enableUrlProtocolAndCredsGuard: true,
            enableRedirectProtocolGuard: true,
            enableBaseDirGuard: false,
            enableDownloadLock: true,
            enableHeaderSanitize: true,
            enableContentLengthRangePrecheck: false,
            enableStrictResumeChecks: false,
            enableSymlinkGuard: false,
            enableProbeOutputLimit: false,
            enableFailFast: false,
        };
    }


    return {
        enableSSRFProtection: false,
        enableUrlProtocolAndCredsGuard: false,
        enableRedirectProtocolGuard: false,
        enableBaseDirGuard: false,
        enableDownloadLock: false,
        enableHeaderSanitize: false,
        enableContentLengthRangePrecheck: false,
        enableStrictResumeChecks: false,
        enableSymlinkGuard: false,
        enableProbeOutputLimit: false,
        enableFailFast: false,
    };
}

function mergeSecurityOptions(level, overrides) {
    const base = resolveSecurityProfile(level);
    const o = overrides && typeof overrides === "object" ? overrides : {};

    return { ...base, ...o };
}

function ipv4ToInt(ip) {
    const parts = String(ip).split(".").map((x) => Number(x));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;

    return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function inCidrV4(ipInt, baseInt, maskBits) {
    if (!Number.isFinite(ipInt) || !Number.isFinite(baseInt)) return false;
    const mask = maskBits === 0 ? 0 : ((0xffffffff << (32 - maskBits)) >>> 0);
    return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

function isNonPublicIPv4(ip) {
    const x = ipv4ToInt(ip);
    if (x === null) return true;


    const blocks = [
        ["0.0.0.0", 8],
        ["10.0.0.0", 8],
        ["127.0.0.0", 8],
        ["169.254.0.0", 16],
        ["172.16.0.0", 12],
        ["192.168.0.0", 16],
        ["100.64.0.0", 10],
        ["192.0.0.0", 24],
        ["192.0.2.0", 24],
        ["198.18.0.0", 15],
        ["198.51.100.0", 24],
        ["203.0.113.0", 24],
        ["224.0.0.0", 4],
        ["240.0.0.0", 4],
        ["255.255.255.255", 32],
    ];

    for (const [b, m] of blocks) {
        const bi = ipv4ToInt(b);
        if (bi !== null && inCidrV4(x, bi, m)) return true;
    }
    return false;
}

function isNonPublicIPv6(ip) {
    const s = String(ip || "").toLowerCase();


    if (s.startsWith("::ffff:")) {
        const v4 = s.slice("::ffff:".length);

        const last = v4.split(":").pop();
        if (last && net.isIP(last) === 4) return isNonPublicIPv4(last);
    }


    if (s === "::1" || s === "::") return true;


    if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true;


    if (s.startsWith("fc") || s.startsWith("fd")) return true;


    if (s.startsWith("ff")) return true;


    if (s.startsWith("2001:db8")) return true;

    return false;
}

function isNonPublicIp(ip) {
    const t = net.isIP(ip);
    if (t === 4) return isNonPublicIPv4(ip);
    if (t === 6) return isNonPublicIPv6(ip);
    return true;
}

function isLocalHostname(hostname) {
    const h = String(hostname || "").toLowerCase();
    if (!h) return true;
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (h === "local" || h.endsWith(".local")) return true;
    return false;
}

function dnsLookupAll(hostname, timeoutMs) {
    return new Promise((resolve, reject) => {
        let done = false;

        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(Object.assign(new Error("dns_timeout"), { code: "ETIMEOUT" }));
        }, Math.max(1, Number(timeoutMs) || 3000));

        dns.lookup(hostname, { all: true }, (err, addresses) => {
            if (done) return;
            clearTimeout(timer);
            done = true;
            if (err) reject(err);
            else resolve(addresses || []);
        });
    });
}

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function sanitizeHeaders(inputHeaders, failFast) {
    const out = {};
    const src = inputHeaders && typeof inputHeaders === "object" ? inputHeaders : {};
    for (const [k0, v0] of Object.entries(src)) {
        const k = String(k0 || "").trim();
        if (!k) continue;


        if (k.includes("\r") || k.includes("\n") || !HEADER_NAME_RE.test(k)) {
            if (failFast) return { ok: false, error: "invalid_header_name" };
            continue;
        }


        const v = Array.isArray(v0) ? v0.map((x) => String(x)) : [String(v0)];
        const vv = v.map((s) => s.replace(/[\r\n]+/g, " ").trim()).join(", ");
        if (!vv) continue;

        out[k.toLowerCase()] = vv;
    }
    return { ok: true, headers: out };
}

function realAbs(p) {
    return path.resolve(String(p || ""));
}

function isPathInsideBaseDir(filePath, baseDir) {
    const absFile = realAbs(filePath);
    const absBase = realAbs(baseDir);
    if (!absBase.endsWith(path.sep)) {

        return absFile === absBase || absFile.startsWith(absBase + path.sep);
    }
    return absFile.startsWith(absBase);
}

function lstatIfExists(p) {
    try {
        return fs.lstatSync(p);
    } catch {
        return null;
    }
}

function isSymlinkPath(p) {
    const st = lstatIfExists(p);
    return !!(st && st.isSymbolicLink());
}

function ensureNotSymlink(p, failFast) {
    const st = lstatIfExists(p);
    if (!st) return { ok: true };
    if (st.isSymbolicLink()) return { ok: false, error: "symlink_not_allowed" };
    if (st.isDirectory()) return { ok: false, error: "path_is_directory" };
    if (!st.isFile()) return { ok: false, error: "path_not_regular_file" };
    return { ok: true };
}

async function acquireDownloadLock(destPath, opts) {
    const lockPath = String(destPath) + ".lock";
    const waitMs = Math.max(0, Number(opts?.downloadLockWaitMs ?? 15_000));
    const pollMs = Math.max(20, Number(opts?.downloadLockPollMs ?? 120));
    const staleMs = Math.max(0, Number(opts?.downloadLockStaleMs ?? 60_000));
    const start = Date.now();

    ensureDirForFile(lockPath);

    while (true) {

        let fd = null;
        try {
            fd = fs.openSync(lockPath, "wx");
            try {
                fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, { encoding: "utf8" });
            } catch { }
            safeClose(fd);
            return {
                ok: true,
                release: () => safeUnlink(lockPath),
            };
        } catch (e) {
            safeClose(fd);


            try {
                const st = fs.statSync(lockPath);
                if (staleMs > 0 && Date.now() - st.mtimeMs > staleMs) {

                    safeUnlink(lockPath);

                    continue;
                }
            } catch { }

            if (Date.now() - start >= waitMs) {
                return { ok: false, error: "dest_locked" };
            }
            await sleep(pollMs);
        }
    }
}

function parseContentRange(cr) {

    const s = String(cr || "").trim();
    const m = s.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = m[3] === "*" ? null : Number(m[3]);
    if (![start, end].every(Number.isFinite) || start < 0 || end < start) return null;
    if (total !== null && (!Number.isFinite(total) || total < end + 1)) return null;
    return { start, end, total };
}

class SmartHttpDownloader {
    constructor(config = {}) {

        const securityLevel = config.securityLevel ?? 1;
        const securityOverrides = config.securityOverrides || null;
        this.security = mergeSecurityOptions(securityLevel, securityOverrides);

        this.config = {

            maxHosts: 8,
            maxStreamsPerHost: 50,
            maxStreamsPerHostH1: 4,
            sessionTimeoutMs: 30_000,
            connectTimeoutMs: 5_000,
            requestTimeoutMs: 15_000,
            maxRedirects: 6,


            maxBytesDefault: 200 * 1024 * 1024,


            maxAttempts: 4,
            maxTotalRetryDelayMs: 25_000,


            keepAlive: true,


            rejectUnauthorized: true,


            defaultHeaders: {},


            h2ClientSettings: null,


            baseDir: config.baseDir || null,
            dnsTimeoutMs: config.dnsTimeoutMs ?? 3000,
            dnsCacheTtlMs: config.dnsCacheTtlMs ?? 60_000,


            downloadLockWaitMs: config.downloadLockWaitMs ?? 15_000,
            downloadLockPollMs: config.downloadLockPollMs ?? 120,
            downloadLockStaleMs: config.downloadLockStaleMs ?? 60_000,

            ...config,
        };

        this.pools = new Map();
        this.hostLimiter = new HostSlotLimiter(this.config.maxHosts);

        this.httpAgent = new http.Agent({
            keepAlive: !!this.config.keepAlive,
            maxSockets: 256,
        });
        this.httpsAgent = new https.Agent({
            keepAlive: !!this.config.keepAlive,
            maxSockets: 256,
        });

        this._dnsCache = new Map();
        this.activeReqs = new Set();
    }

    cancelAll() {
        this._cancelled = true;
        for (const req of this.activeReqs) {
            try { req.destroy(); } catch (e) { }
            try { if (req.socket) req.socket.destroy(); } catch (e) { }
        }
        this.activeReqs.clear();
    }

    async downloadAll(tasks, onProgress) {
        const results = [];
        if (!Array.isArray(tasks) || tasks.length === 0) {
            return { stats: this._emptyStats(), results };
        }


        const byOrigin = new Map();
        for (const t of tasks) {
            try {
                const u = new URL(t.url);
                const origin = u.origin;


                const vr = this._validateUrlBasic(u);
                if (!vr.ok) {
                    const r = this._resultFail(t, vr.error);
                    results.push(r);
                    onProgress && onProgress(t, { type: "error", ...r });
                    continue;
                }

                if (!byOrigin.has(origin)) byOrigin.set(origin, []);
                byOrigin.get(origin).push(t);
            } catch {
                const r = this._resultFail(t, "invalid_url");
                results.push(r);
                onProgress && onProgress(t, { type: "error", ...r });
            }
        }


        const jobs = [];
        for (const [origin, list] of byOrigin) {
            jobs.push(this._processOrigin(origin, list, results, onProgress));
        }
        await Promise.all(jobs);

        this._cleanupIdleSessions();
        return { stats: this._statsFromResults(results), results };
    }

    async _processOrigin(origin, tasks, results, onProgress) {
        await this.hostLimiter.acquire(origin);
        try {
            const session = await this._getOrCreateH2Session(origin);
            if (session) {
                await this._downloadOriginH2(origin, session, tasks, results, onProgress);
            } else {
                await this._downloadOriginH1(origin, tasks, results, onProgress);
            }
        } finally {
            this.hostLimiter.release(origin);
        }
    }

    async _getOrCreateH2Session(origin) {
        const u = new URL(origin);
        if (u.protocol !== "https:") {
            this.pools.set(origin, { session: null, h2Supported: false, lastUsed: Date.now() });
            return null;
        }

        const cached = this.pools.get(origin);
        if (cached) {
            if (cached.h2Supported === false) return null;
            if (cached.session && !cached.session.closed && !cached.session.destroyed) {
                cached.lastUsed = Date.now();
                return cached.session;
            }
        }

        return new Promise((resolve) => {
            const localHint = Math.max(1, Number(this.config.maxStreamsPerHost) || 1);
            const settings = Object.assign({}, this.config.h2ClientSettings || {});
            if (!("maxConcurrentStreams" in settings)) settings.maxConcurrentStreams = localHint;

            const session = http2.connect(origin, {
                rejectUnauthorized: this.config.rejectUnauthorized,
                settings,
            });

            let settled = false;
            const settle = (s) => {
                if (settled) return;
                settled = true;
                resolve(s);
            };

            const timer = setTimeout(() => {
                try {
                    session.close();
                } catch { }
                settle(null);
            }, this.config.connectTimeoutMs);

            session.on("connect", () => {
                clearTimeout(timer);

                this.pools.set(origin, { session, h2Supported: true, lastUsed: Date.now() });

                session.on("close", () => {
                    const p = this.pools.get(origin);
                    if (p && p.session === session) p.session = null;
                });

                session.on("goaway", () => {
                    const p = this.pools.get(origin);
                    if (p && p.session === session) p.session = null;
                    try {
                        session.close();
                    } catch { }
                });

                settle(session);
            });

            session.on("error", (err) => {
                clearTimeout(timer);

                const msg = String(err?.message || "");
                const code = String(err?.code || "");
                const looksNoH2 =
                    msg.includes("ALPN") ||
                    msg.toLowerCase().includes("protocol") ||
                    code === "ERR_HTTP2_ERROR";

                if (looksNoH2) {
                    this.pools.set(origin, { session: null, h2Supported: false, lastUsed: Date.now() });
                }

                try {
                    session.close();
                } catch { }
                settle(null);
            });
        });
    }

    _effectiveH2Concurrency(session) {
        const local = Math.max(1, Number(this.config.maxStreamsPerHost) || 1);
        const remote = session?.remoteSettings?.maxConcurrentStreams;
        if (Number.isFinite(remote) && remote > 0) return Math.min(local, remote);
        return local;
    }

    async _downloadOriginH2(origin, session, tasks, results, onProgress) {
        const concurrency = this._effectiveH2Concurrency(session);

        await runPool(tasks, concurrency, async (task) => {
            const r = await this._downloadOneWithRetries(
                { protocolHint: "h2", origin, session },
                task,
                onProgress
            );
            results.push(r);
        });
    }

    async _downloadOriginH1(origin, tasks, results, onProgress) {
        await runPool(tasks, this.config.maxStreamsPerHostH1, async (task) => {
            const r = await this._downloadOneWithRetries(
                { protocolHint: "h1", origin, session: null },
                task,
                onProgress
            );
            results.push(r);
        });
    }

    async _downloadOneWithRetries(ctx, task, onProgress) {
        const maxAttempts = Math.max(1, Number(this.config.maxAttempts) || 1);
        let usedAntiHotlinkBoost = false;
        let totalDelay = 0;


        const pre = this._validateTaskPaths(task);
        if (!pre.ok) {
            const r = this._resultFail(task, pre.error);
            onProgress && onProgress(task, { type: "error", attempt: 0, ...r });
            return r;
        }


        let lock = null;
        if (this.security.enableDownloadLock) {
            const lr = await acquireDownloadLock(task.destPath, this.config);
            if (!lr.ok) {
                const r = this._resultFail(task, lr.error);
                onProgress && onProgress(task, { type: "error", attempt: 0, ...r });
                return r;
            }
            lock = lr;
        }

        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                onProgress && onProgress(task, { type: "start", attempt, protocolHint: ctx.protocolHint });

                const resumeInfo = this._getResumeInfo(task);

                const useAntiHotlink =
                    usedAntiHotlinkBoost ||
                    (attempt > 1 && usedAntiHotlinkBoost) ||
                    false;

                let r;
                try {
                    if (ctx.protocolHint === "h2") {
                        r = await this._attemptH2(ctx, task, attempt, useAntiHotlink, resumeInfo);
                        if (r?._h2SessionBroken) {
                            this._breakH2Session(ctx.origin, ctx.session);
                            ctx.session = await this._getOrCreateH2Session(ctx.origin);
                            if (!ctx.session) ctx.protocolHint = "h1";
                        }
                    } else {
                        r = await this._attemptH1(task, attempt, useAntiHotlink, resumeInfo);
                    }
                } catch (e) {
                    r = this._resultFail(task, e.message || "attempt_error");
                    r._networkError = e;
                }

                if (r.success) {
                    onProgress && onProgress(task, { type: "done", attempt, ...r });
                    return r;
                }

                if (!usedAntiHotlinkBoost && isWorthAntiHotlinkRetry(r.httpStatus || 0)) {
                    usedAntiHotlinkBoost = true;
                    const d = Math.min(400, computeBackoffMs(attempt, parseRetryAfterMs(r.retryAfter)));
                    totalDelay += d;
                    if (totalDelay > this.config.maxTotalRetryDelayMs) {
                        onProgress && onProgress(task, { type: "error", attempt, ...r });
                        return r;
                    }
                    onProgress && onProgress(task, { type: "retry", attempt, delayMs: d, reason: "anti_hotlink_boost" });
                    await sleep(d);
                    continue;
                }

                const retryAfterMs = parseRetryAfterMs(r.retryAfter);
                const retryableHttp = r.httpStatus ? isRetryableHttpStatus(r.httpStatus) : false;
                const retryableNet = r._networkError ? isRetryableNetworkError(r._networkError) : false;
                const retryable = retryableHttp || retryableNet;

                if (!retryable || attempt >= maxAttempts) {
                    onProgress && onProgress(task, { type: "error", attempt, ...r });
                    return r;
                }

                const delayMs = computeBackoffMs(attempt, retryAfterMs);
                totalDelay += delayMs;
                if (totalDelay > this.config.maxTotalRetryDelayMs) {
                    onProgress && onProgress(task, { type: "error", attempt, ...r });
                    return r;
                }

                onProgress && onProgress(task, { type: "retry", attempt, delayMs, reason: retryableHttp ? "http" : "network" });
                await sleep(delayMs);
            }

            const rr = this._resultFail(task, "exhausted");
            onProgress && onProgress(task, { type: "error", attempt: maxAttempts, ...rr });
            return rr;
        } finally {
            try {
                lock?.release && lock.release();
            } catch { }
        }
    }

    _getResumeInfo(task) {
        const destPath = task.destPath;
        const tmpPath = destPath + ".part";

        try {
            const st = fs.statSync(tmpPath);
            if (st.isFile() && st.size > 0) {
                return { tmpPath, resumeBytes: st.size, canResume: true };
            }
        } catch { }
        return { tmpPath, resumeBytes: 0, canResume: false };
    }

    _breakH2Session(origin, session) {
        try {
            session?.close();
        } catch { }
        const p = this.pools.get(origin);
        if (p && p.session === session) p.session = null;
    }

    _redirectBumpOrFail(task, nextUrl) {
        const cur = Math.max(0, Number(task?._redirectDepth || 0));
        const next = cur + 1;
        if (next > this.config.maxRedirects) {
            return { fail: true, result: this._resultFail(task, "too_many_redirects") };
        }
        const nt = { ...task, url: nextUrl, _redirectDepth: next };
        return { fail: false, task: nt };
    }

    _validateUrlBasic(urlObj) {
        const failFast = !!this.security.enableFailFast;


        if (this.security.enableUrlProtocolAndCredsGuard) {
            const proto = String(urlObj?.protocol || "");
            if (proto !== "http:" && proto !== "https:") {
                return { ok: false, error: "protocol_not_allowed" };
            }
            if (urlObj.username || urlObj.password) {
                return { ok: false, error: "url_credentials_not_allowed" };
            }
        }
        return { ok: true };
    }

    async _validateUrlSSRF(urlObj) {
        const failFast = !!this.security.enableFailFast;
        if (!this.security.enableSSRFProtection) return { ok: true };

        const hostname = String(urlObj.hostname || "");


        if (isLocalHostname(hostname)) {
            return { ok: false, error: "ssrf_blocked_local_hostname" };
        }


        const ipType = net.isIP(hostname);
        if (ipType === 4 || ipType === 6) {
            if (isNonPublicIp(hostname)) return { ok: false, error: "ssrf_blocked_ip_literal" };
            return { ok: true };
        }


        const now = Date.now();
        const cached = this._dnsCache.get(hostname);
        if (cached && now - cached.ts <= this.config.dnsCacheTtlMs) {
            if (cached.err) {
                return failFast ? { ok: false, error: "dns_lookup_failed" } : { ok: true };
            }
            for (const ip of cached.addrs || []) {
                if (isNonPublicIp(ip)) return { ok: false, error: "ssrf_blocked_resolved_private_ip" };
            }
            return { ok: true };
        }

        try {
            const addrs = await dnsLookupAll(hostname, this.config.dnsTimeoutMs);
            const ips = (addrs || []).map((x) => String(x.address || "")).filter(Boolean);
            this._dnsCache.set(hostname, { ts: now, addrs: ips });

            if (ips.length === 0) {
                return failFast ? { ok: false, error: "dns_no_records" } : { ok: true };
            }

            for (const ip of ips) {
                if (isNonPublicIp(ip)) return { ok: false, error: "ssrf_blocked_resolved_private_ip" };
            }
            return { ok: true };
        } catch {
            this._dnsCache.set(hostname, { ts: now, err: "fail" });
            return failFast ? { ok: false, error: "dns_lookup_failed" } : { ok: true };
        }
    }

    _validateTaskPaths(task) {
        const failFast = !!this.security.enableFailFast;


        if (this.security.enableBaseDirGuard) {
            const baseDir = task.baseDir || this.config.baseDir;
            if (!baseDir) {
                if (failFast) return { ok: false, error: "baseDir_required" };

            } else {
                if (!isPathInsideBaseDir(task.destPath, baseDir)) {
                    return { ok: false, error: "destPath_out_of_baseDir" };
                }
                const tmpPath = task.destPath + ".part";
                if (!isPathInsideBaseDir(tmpPath, baseDir)) {
                    return { ok: false, error: "tmpPath_out_of_baseDir" };
                }
            }
        }


        if (this.security.enableSymlinkGuard) {
            const d1 = ensureNotSymlink(task.destPath, failFast);
            if (!d1.ok) return d1;
            const d2 = ensureNotSymlink(task.destPath + ".part", failFast);
            if (!d2.ok) return d2;
        }

        return { ok: true };
    }

    _buildHeaders(urlObj, task, { useAntiHotlink, resumeBytes }) {
        const failFast = !!this.security.enableFailFast;


        const baseHeaders = {
            "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            accept: "image/*,video/*,*/*;q=0.8",
            "accept-encoding": "br, gzip, deflate",
            ...this.config.defaultHeaders,
            ...(task.headers || {}),
        };


        let headers = baseHeaders;
        if (this.security.enableHeaderSanitize) {
            const sr = sanitizeHeaders(baseHeaders, failFast);
            if (!sr.ok) {

                if (failFast) return { ok: false, error: sr.error };
                headers = {
                    "user-agent": String(baseHeaders["user-agent"] || baseHeaders["User-Agent"] || "Mozilla/5.0"),
                    accept: String(baseHeaders.accept || "image/*,video/*,*/*;q=0.8"),
                };
            } else {
                headers = sr.headers;
            }
        }


        if (resumeBytes > 0) {
            headers["range"] = `bytes=${resumeBytes}-`;
            headers["accept-encoding"] = "identity";
        }


        if (useAntiHotlink) {
            const explicitRef =
                task.referrer ||
                task.referer ||
                task.meta?.referrer ||
                task.meta?.referer ||
                task.meta?.pageUrl ||
                task.meta?.pageURL;

            const safeRef = explicitRef ? String(explicitRef) : `${urlObj.origin}/`;

            if (!("referer" in headers) && !("referrer" in headers)) headers["referer"] = safeRef;
            if (!("origin" in headers)) headers["origin"] = new URL(safeRef).origin;

            const dest = task.kind === "video" ? "video" : "image";

            if (!("sec-fetch-site" in headers)) headers["sec-fetch-site"] = "same-site";
            if (!("sec-fetch-mode" in headers)) headers["sec-fetch-mode"] = "no-cors";
            if (!("sec-fetch-dest" in headers)) headers["sec-fetch-dest"] = dest;
            if (!("accept-language" in headers)) headers["accept-language"] = "zh-CN,zh;q=0.9,en;q=0.8";
            if (!("cache-control" in headers)) headers["cache-control"] = "no-cache";
            if (!("pragma" in headers)) headers["pragma"] = "no-cache";
        }

        return { ok: true, headers };
    }

    async _attemptH2(ctx, task, attempt, useAntiHotlink, resumeInfo) {
        const failFast = !!this.security.enableFailFast;


        let urlObj;
        try {
            urlObj = new URL(task.url);
        } catch {
            return this._resultFail(task, "invalid_url");
        }
        const vb = this._validateUrlBasic(urlObj);
        if (!vb.ok) return this._resultFail(task, vb.error);


        const ss = await this._validateUrlSSRF(urlObj);
        if (!ss.ok) return this._resultFail(task, ss.error);


        const origin = ctx.origin;
        let session = ctx.session;

        if (!session || session.closed || session.destroyed) {
            session = await this._getOrCreateH2Session(origin);
            ctx.session = session;
            if (!session) {
                ctx.protocolHint = "h1";
                return await this._attemptH1(task, attempt, useAntiHotlink, resumeInfo);
            }
        }

        const pool = this.pools.get(origin);
        if (pool) pool.lastUsed = Date.now();

        const destPath = task.destPath;
        const maxBytes = Number(task.maxBytes ?? this.config.maxBytesDefault) || this.config.maxBytesDefault;

        const { tmpPath, resumeBytes, canResume } = resumeInfo || {};
        const willResume = canResume && resumeBytes > 0;

        ensureDirForFile(tmpPath);


        if (this.security.enableSymlinkGuard) {
            const d2 = ensureNotSymlink(tmpPath, failFast);
            if (!d2.ok) return this._resultFail(task, d2.error);
            const d1 = ensureNotSymlink(destPath, failFast);
            if (!d1.ok) return this._resultFail(task, d1.error);
        }

        const bh = this._buildHeaders(urlObj, task, {
            useAntiHotlink,
            resumeBytes: willResume ? resumeBytes : 0,
        });
        if (!bh.ok) return this._resultFail(task, bh.error);
        const headers = bh.headers;

        const reqHeaders = {
            ":method": "GET",
            ":path": urlObj.pathname + urlObj.search,
            ":authority": urlObj.host,
            ...headers,
        };

        return new Promise((resolve) => {
            let finished = false;
            const finish = (r) => {
                if (finished) return;
                finished = true;
                resolve(r);
            };

            let req;
            try {
                req = session.request(reqHeaders);
                this.activeReqs.add(req);
                req.once('close', () => this.activeReqs.delete(req));
            } catch (e) {
                const r = this._resultFail(task, e.message || "h2_request_failed");
                r._networkError = e;
                r._h2SessionBroken = true;
                return finish(r);
            }

            req.setTimeout(this.config.requestTimeoutMs, () => {
                try {
                    req.close();
                } catch { }
                const r = this._resultFail(task, "timeout");
                r._networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
                finish(r);
            });

            req.on("error", (e) => {
                const r = this._resultFail(task, e.message || "h2_error");
                r._networkError = e;
                if (String(e?.code || "").startsWith("ERR_HTTP2")) r._h2SessionBroken = true;
                finish(r);
            });

            req.on("response", async (h) => {
                const status = Number(h[":status"] || 0);


                if (status >= 300 && status < 400 && h.location) {
                    try {
                        req.close();
                    } catch { }
                    safeUnlink(tmpPath);

                    const newUrl = new URL(String(h.location), task.url).toString();


                    if (this.security.enableRedirectProtocolGuard) {
                        try {
                            const nu = new URL(newUrl);
                            if (nu.protocol !== "http:" && nu.protocol !== "https:") {
                                finish(this._resultFail(task, "redirect_protocol_not_allowed"));
                                return;
                            }
                        } catch {
                            finish(this._resultFail(task, "redirect_invalid_url"));
                            return;
                        }
                    }

                    const newOrigin = new URL(newUrl).origin;

                    const bumped = this._redirectBumpOrFail(task, newUrl);
                    if (bumped.fail) {
                        finish(bumped.result);
                        return;
                    }
                    const nextTask = bumped.task;

                    if (newOrigin === origin) {
                        const rr = await this._attemptH2(
                            ctx,
                            nextTask,
                            attempt,
                            useAntiHotlink,
                            { tmpPath, resumeBytes: 0, canResume: false }
                        );
                        finish(rr);
                    } else {
                        const rr = await this._downloadOneUniversal(nextTask);
                        finish(rr);
                    }
                    return;
                }


                if (status < 200 || status >= 300) {
                    try {
                        req.close();
                    } catch { }
                    const r = this._resultFail(task, `http_${status}`);
                    r.httpStatus = status;
                    r.retryAfter = h["retry-after"];
                    finish(r);
                    return;
                }


                let resumeMode = willResume;
                if (resumeMode) {
                    const contentEncoding = h["content-encoding"];

                    const wantStrict = !!this.security.enableStrictResumeChecks;

                    if (wantStrict) {

                        if (status !== 206) {
                            try { req.close(); } catch { }
                            safeUnlink(tmpPath);
                            const r = this._resultFail(task, "resume_not_supported");
                            r.httpStatus = status;
                            finish(r);
                            return;
                        }

                        if (contentEncoding && String(contentEncoding).toLowerCase() !== "identity") {
                            try { req.close(); } catch { }
                            safeUnlink(tmpPath);
                            const r = this._resultFail(task, "resume_with_encoding_unsupported");
                            r.httpStatus = status;
                            finish(r);
                            return;
                        }

                        if (this.security.enableContentLengthRangePrecheck) {
                            const cr = parseContentRange(h["content-range"]);
                            if (!cr || cr.start !== resumeBytes) {
                                try { req.close(); } catch { }
                                safeUnlink(tmpPath);
                                const r = this._resultFail(task, "content_range_mismatch");
                                r.httpStatus = status;
                                finish(r);
                                return;
                            }
                        }
                    } else {

                        const bad206 = status !== 206;
                        const badEnc = contentEncoding && String(contentEncoding).toLowerCase() !== "identity";
                        let badRange = false;
                        if (this.security.enableContentLengthRangePrecheck) {
                            const cr = parseContentRange(h["content-range"]);
                            badRange = !cr || cr.start !== resumeBytes;
                        }
                        if (bad206 || badEnc || badRange) {

                            try { req.close(); } catch { }
                            safeUnlink(tmpPath);
                            const rr = await this._attemptH2(
                                ctx,
                                { ...task },
                                attempt,
                                useAntiHotlink,
                                { tmpPath, resumeBytes: 0, canResume: false }
                            );
                            finish(rr);
                            return;
                        }
                    }
                }

                const contentEncoding = h["content-encoding"];
                const declaredLen = Number(h["content-length"] || 0) || 0;


                if (this.security.enableContentLengthRangePrecheck) {
                    const decoder = resumeMode ? null : pickDecoder(contentEncoding);

                    if (!decoder && declaredLen > 0) {
                        const initial = resumeMode ? resumeBytes : 0;
                        if (initial + declaredLen > maxBytes) {
                            try { req.close(); } catch { }
                            safeUnlink(tmpPath);
                            const r = this._resultFail(task, "declared_too_large");
                            r.httpStatus = status;
                            r.declaredLen = declaredLen;
                            finish(r);
                            return;
                        }
                    }
                }

                const initialBytes = resumeMode ? resumeBytes : 0;
                const limiter = new ByteLimitTransform(maxBytes, initialBytes);
                const decoder = resumeMode ? null : pickDecoder(contentEncoding);


                const out = fs.createWriteStream(tmpPath, { flags: resumeMode ? "a" : "w" });

                try {
                    if (decoder) await pipelineAsync(req, decoder, limiter, out);
                    else await pipelineAsync(req, limiter, out);


                    if (this.security.enableSymlinkGuard) {
                        const d1 = ensureNotSymlink(destPath, failFast);
                        if (!d1.ok) {
                            safeUnlink(tmpPath);
                            finish(this._resultFail(task, d1.error));
                            return;
                        }
                    }

                    ensureDirForFile(destPath);
                    safeUnlink(destPath);
                    fs.renameSync(tmpPath, destPath);

                    const ok = this._resultOk(task, limiter.total, {
                        httpStatus: status,
                        contentType: String(h["content-type"] || ""),
                        declaredLen,
                        resumed: resumeMode,
                    });
                    finish(ok);
                } catch (e) {
                    try {
                        req.close();
                    } catch { }
                    const emsg = String(e?.message || "download_error");
                    if (emsg === "file_too_large") safeUnlink(tmpPath);

                    const r = this._resultFail(task, emsg);
                    r._networkError = e;
                    r.httpStatus = status;
                    finish(r);
                }
            });

            req.end();
        });
    }

    async _attemptH1(task, attempt, useAntiHotlink, resumeInfo) {
        const failFast = !!this.security.enableFailFast;

        let urlObj;
        try {
            urlObj = new URL(task.url);
        } catch {
            return this._resultFail(task, "invalid_url");
        }


        const vb = this._validateUrlBasic(urlObj);
        if (!vb.ok) return this._resultFail(task, vb.error);


        const ss = await this._validateUrlSSRF(urlObj);
        if (!ss.ok) return this._resultFail(task, ss.error);

        const client = urlObj.protocol === "https:" ? https : http;
        const agent = urlObj.protocol === "https:" ? this.httpsAgent : this.httpAgent;

        const destPath = task.destPath;
        const maxBytes = Number(task.maxBytes ?? this.config.maxBytesDefault) || this.config.maxBytesDefault;

        const { tmpPath, resumeBytes, canResume } = resumeInfo || {};
        const willResume = canResume && resumeBytes > 0;

        ensureDirForFile(tmpPath);


        if (this.security.enableSymlinkGuard) {
            const d2 = ensureNotSymlink(tmpPath, failFast);
            if (!d2.ok) return this._resultFail(task, d2.error);
            const d1 = ensureNotSymlink(destPath, failFast);
            if (!d1.ok) return this._resultFail(task, d1.error);
        }

        const bh = this._buildHeaders(urlObj, task, {
            useAntiHotlink,
            resumeBytes: willResume ? resumeBytes : 0,
        });
        if (!bh.ok) return this._resultFail(task, bh.error);
        const headers = bh.headers;

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: "GET",
            agent,
            timeout: this.config.requestTimeoutMs,
            headers,
        };

        return new Promise((resolve) => {
            const req = client.request(options, async (res) => {

                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.destroy();
                    safeUnlink(tmpPath);

                    const newUrl = new URL(res.headers.location, task.url).toString();


                    if (this.security.enableRedirectProtocolGuard) {
                        try {
                            const nu = new URL(newUrl);
                            if (nu.protocol !== "http:" && nu.protocol !== "https:") {
                                resolve(this._resultFail(task, "redirect_protocol_not_allowed"));
                                return;
                            }
                        } catch {
                            resolve(this._resultFail(task, "redirect_invalid_url"));
                            return;
                        }
                    }

                    const newOrigin = new URL(newUrl).origin;
                    const oldOrigin = new URL(task.url).origin;

                    const bumped = this._redirectBumpOrFail(task, newUrl);
                    if (bumped.fail) {
                        resolve(bumped.result);
                        return;
                    }
                    const nextTask = bumped.task;

                    if (newOrigin === oldOrigin) {
                        const rr = await this._attemptH1(
                            nextTask,
                            attempt,
                            useAntiHotlink,
                            { tmpPath, resumeBytes: 0, canResume: false }
                        );
                        resolve(rr);
                    } else {
                        const rr = await this._downloadOneUniversal(nextTask);
                        resolve(rr);
                    }
                    return;
                }


                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.destroy();
                    const r = this._resultFail(task, `http_${res.statusCode}`);
                    r.httpStatus = res.statusCode;
                    r.retryAfter = res.headers["retry-after"];
                    resolve(r);
                    return;
                }


                let resumeMode = willResume;
                if (resumeMode) {
                    const contentEncoding = res.headers["content-encoding"];
                    const wantStrict = !!this.security.enableStrictResumeChecks;

                    if (wantStrict) {
                        if (res.statusCode !== 206) {
                            res.destroy();
                            safeUnlink(tmpPath);
                            const r = this._resultFail(task, "resume_not_supported");
                            r.httpStatus = res.statusCode;
                            resolve(r);
                            return;
                        }

                        if (contentEncoding && String(contentEncoding).toLowerCase() !== "identity") {
                            res.destroy();
                            safeUnlink(tmpPath);
                            const r = this._resultFail(task, "resume_with_encoding_unsupported");
                            r.httpStatus = res.statusCode;
                            resolve(r);
                            return;
                        }

                        if (this.security.enableContentLengthRangePrecheck) {
                            const cr = parseContentRange(res.headers["content-range"]);
                            if (!cr || cr.start !== resumeBytes) {
                                res.destroy();
                                safeUnlink(tmpPath);
                                const r = this._resultFail(task, "content_range_mismatch");
                                r.httpStatus = res.statusCode;
                                resolve(r);
                                return;
                            }
                        }
                    } else {
                        const bad206 = res.statusCode !== 206;
                        const badEnc = contentEncoding && String(contentEncoding).toLowerCase() !== "identity";
                        let badRange = false;
                        if (this.security.enableContentLengthRangePrecheck) {
                            const cr = parseContentRange(res.headers["content-range"]);
                            badRange = !cr || cr.start !== resumeBytes;
                        }

                        if (bad206 || badEnc || badRange) {

                            res.destroy();
                            safeUnlink(tmpPath);
                            const rr = await this._attemptH1(
                                { ...task },
                                attempt,
                                useAntiHotlink,
                                { tmpPath, resumeBytes: 0, canResume: false }
                            );
                            resolve(rr);
                            return;
                        }
                    }
                }

                const contentEncoding = res.headers["content-encoding"];
                const declaredLen = Number(res.headers["content-length"] || 0) || 0;


                if (this.security.enableContentLengthRangePrecheck) {
                    const decoder = resumeMode ? null : pickDecoder(contentEncoding);
                    if (!decoder && declaredLen > 0) {
                        const initial = resumeMode ? resumeBytes : 0;
                        if (initial + declaredLen > maxBytes) {
                            res.destroy();
                            safeUnlink(tmpPath);
                            const r = this._resultFail(task, "declared_too_large");
                            r.httpStatus = res.statusCode;
                            r.declaredLen = declaredLen;
                            resolve(r);
                            return;
                        }
                    }
                }

                const initialBytes = resumeMode ? resumeBytes : 0;
                const limiter = new ByteLimitTransform(maxBytes, initialBytes);

                const decoder = resumeMode ? null : pickDecoder(contentEncoding);
                const out = fs.createWriteStream(tmpPath, { flags: resumeMode ? "a" : "w" });

                try {
                    if (decoder) await pipelineAsync(res, decoder, limiter, out);
                    else await pipelineAsync(res, limiter, out);


                    if (this.security.enableSymlinkGuard) {
                        const d1 = ensureNotSymlink(destPath, failFast);
                        if (!d1.ok) {
                            safeUnlink(tmpPath);
                            resolve(this._resultFail(task, d1.error));
                            return;
                        }
                    }

                    ensureDirForFile(destPath);
                    safeUnlink(destPath);
                    fs.renameSync(tmpPath, destPath);

                    resolve(
                        this._resultOk(task, limiter.total, {
                            httpStatus: res.statusCode,
                            contentType: String(res.headers["content-type"] || ""),
                            declaredLen,
                            resumed: resumeMode,
                        })
                    );
                } catch (e) {
                    res.destroy();
                    const emsg = String(e?.message || "download_error");
                    if (emsg === "file_too_large") safeUnlink(tmpPath);

                    const r = this._resultFail(task, emsg);
                    r._networkError = e;
                    r.httpStatus = res.statusCode;
                    resolve(r);
                }
            });

            req.on("timeout", () => {
                req.destroy();
                const r = this._resultFail(task, "timeout");
                r._networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
                resolve(r);
            });

            req.on("error", (e) => {
                const r = this._resultFail(task, e.message || "h1_error");
                r._networkError = e;
                resolve(r);
            });

            req.end();
        });
    }

    /**
     * 跨域 redirect 专用：遵守 maxHosts，优先 H2，否则 H1
     * 这里也会走完整重试逻辑（内部调用 _downloadOneWithRetries）
     * maxRedirects 真计数：依赖 task._redirectDepth
     */
    async _downloadOneUniversal(task) {
        const d = Math.max(0, Number(task?._redirectDepth || 0));
        if (d > this.config.maxRedirects) {
            return this._resultFail(task, "too_many_redirects");
        }

        let u;
        try {
            u = new URL(task.url);
        } catch {
            return this._resultFail(task, "invalid_url");
        }


        const vb = this._validateUrlBasic(u);
        if (!vb.ok) return this._resultFail(task, vb.error);


        if (this.security.enableRedirectProtocolGuard) {
            const proto = String(u.protocol || "");
            if (proto !== "http:" && proto !== "https:") return this._resultFail(task, "protocol_not_allowed");
        }

        const origin = u.origin;

        await this.hostLimiter.acquire(origin);
        try {
            const session = await this._getOrCreateH2Session(origin);
            if (session) {
                return await this._downloadOneWithRetries({ protocolHint: "h2", origin, session }, task, null);
            }
            return await this._downloadOneWithRetries({ protocolHint: "h1", origin, session: null }, task, null);
        } finally {
            this.hostLimiter.release(origin);
        }
    }

    _cleanupIdleSessions() {
        const now = Date.now();
        for (const [origin, pool] of this.pools) {
            if (!pool?.session) continue;
            if (now - (pool.lastUsed || 0) > this.config.sessionTimeoutMs) {
                try {
                    pool.session.close();
                } catch { }
                this.pools.delete(origin);
            }
        }
    }

    destroy() {
        for (const [, pool] of this.pools) {
            if (pool?.session) {
                try {
                    pool.session.close();
                } catch { }
            }
        }
        this.pools.clear();
        this.hostLimiter.clear();
        this._dnsCache.clear();

        try {
            this.httpAgent.destroy();
        } catch { }
        try {
            this.httpsAgent.destroy();
        } catch { }
    }

    _resultOk(task, bytes, extra = {}) {
        return {
            url: task.url,
            destPath: task.destPath,
            success: true,
            bytes,
            tag: task.tag,
            meta: task.meta,
            ...extra,
        };
    }

    _resultFail(task, error) {
        return {
            url: task?.url,
            destPath: task?.destPath,
            success: false,
            error: String(error || "failed"),
            tag: task?.tag,
            meta: task?.meta,
        };
    }

    _emptyStats() {
        return { started: 0, completed: 0, failed: 0, manual: 0 };
    }

    _statsFromResults(results) {
        const s = this._emptyStats();
        for (const r of results) {
            s.started++;
            if (r.manual) s.manual++;
            else if (r.success) s.completed++;
            else s.failed++;
        }
        return s;
    }
}

class YtDlpDownloader {
    constructor(options = {}) {
        const securityLevel = options.securityLevel ?? 1;
        const securityOverrides = options.securityOverrides || null;
        this.security = mergeSecurityOptions(securityLevel, securityOverrides);

        this.ytdlpPath = options.ytdlpPath || null;
        this.ffmpegPath = options.ffmpegPath || null;


        this.maxProbeStdoutBytes = Math.max(0, Number(options.maxProbeStdoutBytes ?? 10 * 1024 * 1024));
        this.maxProbeStderrBytes = Math.max(0, Number(options.maxProbeStderrBytes ?? 1 * 1024 * 1024));


        if (!this.ytdlpPath) this.ytdlpPath = findExecutableInPath("yt-dlp");


        if (!this.ytdlpPath && process.platform !== "win32") {
            this.ytdlpPath = findExecutableInCommonPaths("yt-dlp");
        }


        if (!this.ffmpegPath) this.ffmpegPath = findExecutableInPath("ffmpeg");
        if (!this.ffmpegPath && process.platform !== "win32") {
            this.ffmpegPath = findExecutableInCommonPaths("ffmpeg");
        }
    }

    isAvailable() {
        if (!this.ytdlpPath) return false;
        try {

            if (!require('fs').existsSync(this.ytdlpPath)) return false;

            const { spawnSync } = require("child_process");
            const r = spawnSync(this.ytdlpPath, ["--version"], { stdio: "ignore", windowsHide: true });
            return r.status === 0;
        } catch {
            return false;
        }
    }

    /**
     * probe：获取视频信息而不下载
     * - 兼容单视频、以及（可能）playlist 的多行 dump-json 输出
     * - 开关 10：stdout/stderr 限制避免内存炸
     */
    async probe(url, options = {}) {
        if (!this.isAvailable()) {
            return { success: false, error: "yt-dlp_not_installed_or_invalid" };
        }

        return new Promise((resolve) => {

            const args = [
                "--dump-json",
                "--no-download",
                "--no-warnings",
                "--ignore-errors",
                "--no-flat-playlist", // 强制深入解析每个条目
                "--no-check-certificate",
                url,
            ];

            if (options.cookiesFilePath) {
                args.push("--cookies", options.cookiesFilePath);
            }


            const doProbe = (extraArgs = []) => {
                return new Promise((resolveProbe) => {
                    // ★ 动态获取 spawn（确保使用 patched 版本）
                    const { spawn } = require("child_process");
                    const proc = spawn(this.ytdlpPath, [...args, ...extraArgs], { windowsHide: true });

                    let stdout = "";
                    let stderr = "";
                    let killedByLimit = false;

                    const limitStdout = this.security.enableProbeOutputLimit ? this.maxProbeStdoutBytes : 0;
                    const limitStderr = this.security.enableProbeOutputLimit ? this.maxProbeStderrBytes : 0;

                    const killIfTooLarge = () => {
                        if (!this.security.enableProbeOutputLimit) return;
                        if (killedByLimit) return;

                        if ((limitStdout > 0 && stdout.length > limitStdout) || (limitStderr > 0 && stderr.length > limitStderr)) {
                            killedByLimit = true;
                            try { proc.kill("SIGKILL"); } catch { }
                        }
                    };

                    proc.stdout.on("data", (d) => {
                        stdout += d.toString("utf8");
                        killIfTooLarge();
                    });
                    proc.stderr.on("data", (d) => {
                        stderr += d.toString("utf8");
                        killIfTooLarge();
                    });

                    proc.on("close", (code) => {
                        if (killedByLimit) {
                            resolveProbe({ success: false, error: "probe_output_too_large" });
                            return;
                        }

                        const raw = String(stdout || "").trim();
                        if (!raw) {
                            let errorMsg = "probe_failed_empty_output";
                            const stderrStr = String(stderr || "").trim();
                            if (stderrStr) {
                                const errorMatch = stderrStr.match(/ERROR:\s*(.*)/);
                                if (errorMatch && errorMatch[1]) {
                                    errorMsg = errorMatch[1].trim();
                                } else {
                                    const lines = stderrStr.split('\n').map(l => l.trim()).filter(Boolean);
                                    if (lines.length > 0) errorMsg = lines[lines.length - 1];
                                }
                            }
                            resolveProbe({ success: false, error: errorMsg, stderr: stderrStr });
                            return;
                        }

                        const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                        const tryParseLine = (s) => {
                            try { return JSON.parse(s); } catch { return null; }
                        };

                        const parsed = [];
                        for (const ln of lines) {
                            const obj = tryParseLine(ln);
                            if (obj) parsed.push(obj);
                        }

                        if (parsed.length === 0) {
                            resolveProbe({ success: false, error: "parse_error", stderr: String(stderr || "").slice(0, 4096) });
                            return;
                        }


                        if (parsed.length === 1 && !parsed[0]._type && !parsed[0].entries) {
                            const info = parsed[0];
                            const formats = Array.isArray(info.formats) ? info.formats : [];
                            let best = null;
                            for (const f of formats) {
                                if (!f) continue;
                                const isVideo = String(f.vcodec || "").toLowerCase() !== "none";
                                if (!isVideo) continue;
                                if (!best) { best = f; continue; }
                                const hA = Number(f.height || 0), hB = Number(best.height || 0);
                                const tA = Number(f.tbr || 0), tB = Number(best.tbr || 0);
                                if (hA > hB || (hA === hB && tA > tB)) best = f;
                            }
                            const width = best ? (best.width || null) : (info.width || null);
                            const height = best ? (best.height || null) : (info.height || null);
                            const resolution = width && height ? `${width}x${height}` : (info.resolution || null);
                            const filesize = best ? (best.filesize || best.filesize_approx || null) : (info.filesize || info.filesize_approx || null);

                            resolveProbe({
                                success: true,
                                title: info.title,
                                duration: info.duration,
                                thumbnail: info.thumbnail,
                                uploader: info.uploader,
                                filename: info._filename || info.filename,
                                extractor: info.extractor,
                                isLive: info.is_live,
                                webpageUrl: info.webpage_url || info.url || url,
                                id: info.id,
                                url: info.url,
                                width,
                                height,
                                resolution,
                                filesize,

                                cookieSource: extraArgs.includes("chrome") ? "chrome" :
                                    extraArgs.includes("edge") ? "edge" :
                                        extraArgs.includes("firefox") ? "firefox" : null
                            });
                            return;
                        }


                        const first = parsed[0];
                        resolveProbe({
                            success: true,
                            isPlaylist: true,
                            entriesCount: parsed.length,
                            title: first.title || "Playlist",
                            thumbnail: first.thumbnail,
                            uploader: first.uploader,
                            extractor: first.extractor,
                            cookieSource: extraArgs.includes("chrome") ? "chrome" :
                                extraArgs.includes("edge") ? "edge" :
                                    extraArgs.includes("firefox") ? "firefox" : null,
                            entries: parsed.slice(0, 50).map((e) => ({
                                id: e.id,
                                title: e.title || `Video ${e.id}`,
                                duration: e.duration,
                                thumbnail: e.thumbnail,
                                uploader: e.uploader,
                                url: e.webpage_url || e.url || e.original_url,
                                filesize: e.filesize,
                                filesize_approx: e.filesize_approx,
                                width: e.width,
                                height: e.height,
                                resolution: e.resolution,
                                original: e
                            })),
                        });
                    });

                    proc.on("error", (e) => resolveProbe({ success: false, error: e.message }));
                });
            };

            doProbe().then(res => {


                // 成功但缺少关键信息时尝试使用浏览器 Cookie 进行深度解析
                if (res.success) {
                    const hasMeta = res.isPlaylist
                        ? Array.isArray(res.entries) && res.entries.some(e => e.width || e.height || e.resolution || e.filesize || e.filesize_approx)
                        : (res.width || res.height || res.resolution || res.filesize || res.filesize_approx);
                    if (!hasMeta) {
                        return doProbe(["--cookies-from-browser", "chrome"]).then(res2 => {
                            const res2Has = res2.success && (
                                res2.isPlaylist
                                    ? Array.isArray(res2.entries) && res2.entries.some(e => e.width || e.height || e.resolution || e.filesize || e.filesize_approx)
                                    : (res2.width || res2.height || res2.resolution || res2.filesize || res2.filesize_approx)
                            );
                            if (res2Has) return res2;
                            return doProbe(["--cookies-from-browser", "edge"]).then(res3 => {
                                const res3Has = res3.success && (
                                    res3.isPlaylist
                                        ? Array.isArray(res3.entries) && res3.entries.some(e => e.width || e.height || e.resolution || e.filesize || e.filesize_approx)
                                        : (res3.width || res3.height || res3.resolution || res3.filesize || res3.filesize_approx)
                                );
                                return res3Has ? res3 : res;
                            });
                        });
                    }
                }

                if (!res.success && (
                    res.error?.includes("403") ||
                    res.error?.includes("401") ||
                    res.error?.includes("Unable to extract") ||
                    res.error?.includes("Sign in") ||
                    res.error?.includes("Unsupported URL")
                )) {


                    return doProbe(["--cookies-from-browser", "chrome"]).then(res2 => {
                        if (res2.success) return res2;

                        return doProbe(["--cookies-from-browser", "edge"]).then(res3 => {
                            return res3.success ? res3 : res;
                        });
                    });
                }
                return res;
            }).then(resolve);
        });
    }

    async download(url, destPath, options = {}) {
        if (!this.isAvailable()) {
            return { success: false, error: "yt-dlp_not_installed_or_invalid" };
        }

        ensureDirForFile(destPath);


        const referer = options.referer || url;

        const runDownload = (extraArgs = []) => {
            return new Promise((resolve) => {
                const fmt =
                    options.format ||
                    "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";

                const args = [
                    "-o",
                    destPath,
                    "--no-warnings",
                    "--no-playlist",
                    "--force-ipv4", // 强制 IPv4
                    "--merge-output-format",
                    "mp4",
                    "-f",
                    fmt,
                    "--no-mtime", // 不修改文件时间，避免某些文件系统操作延迟
                    "--no-check-certificate",
                    "--no-cache-dir",
                    // 移除所有可能触发风控的 extractor-args
                    // "--extractor-args", "youtubetab:skip=authcheck;youtube:player_skip=webpage,configs",
                    "--referer", referer,
                    ...extraArgs
                ];

                // 只有当明确传入 userAgent 时才设置，否则完全留空让 yt-dlp 自己处理
                if (options.userAgent) {
                    args.push("--user-agent", options.userAgent);
                }


                if (options.cookie) {
                    args.push("--add-header", `Cookie:${options.cookie}`);
                }


                if (options.origin) {
                    args.push("--add-header", `Origin:${options.origin}`);
                }

                if (this.ffmpegPath) {
                    args.unshift("--ffmpeg-location", this.ffmpegPath);
                }

                if (options.rateLimit) {
                    args.push("-r", String(options.rateLimit));
                }

                args.push(url);

                // ★ 动态获取 spawn（确保使用 patched 版本）
                const { spawn } = require("child_process");
                const proc = spawn(this.ytdlpPath, args, { windowsHide: true });

                let stderr = "";

                const onLine = (line) => {
                    const str = String(line);
                    // 解析 yt-dlp 进度输出:
                    // 1. 标准格式: [download]  23.5% of 10.00MiB at  2.00MiB/s ETA 00:03
                    const match = str.match(/\[download\]\s+(\d+(\.\d+)?)%\s+of\s+([~\d\.]+\w+)(?:\s+at\s+([\d\.]+\w+\/s))?(?:\s+ETA\s+([\d:]+))?/);

                    if (match && options.onProgress) {
                        const percent = parseFloat(match[1]);
                        const totalSize = match[3];
                        const speed = match[4] || "";
                        const eta = match[5] || "";

                        // 计算已下载大小 (粗略估算)
                        let currentSize = "";
                        try {
                            const sizeMatch = totalSize.match(/([\d\.]+)(\w+)/);
                            if (sizeMatch) {
                                const val = parseFloat(sizeMatch[1]);
                                const unit = sizeMatch[2];
                                const cur = (val * percent / 100).toFixed(2);
                                currentSize = `${cur}${unit}`;
                            }
                        } catch (e) { }

                        options.onProgress({
                            percent,
                            totalSize,
                            currentSize, // 新增：已下载大小
                            speed,
                            eta,
                            raw: str.trim()
                        });
                    } else if (options.onProgress) {
                        // 2. Fragment 格式: [download] Downloading video fragment 10 of 150
                        const matchFrag = str.match(/Downloading video fragment\s+(\d+)\s+of\s+(\d+)/);
                        if (matchFrag) {
                            const currentFrag = parseInt(matchFrag[1]);
                            const totalFrag = parseInt(matchFrag[2]);
                            const percent = (currentFrag / totalFrag * 100).toFixed(1);
                            // 估算：假设每个 Fragment 2MB (HLS 常见大小)
                            const estimatedSize = (currentFrag * 2).toFixed(2) + "MiB";

                            options.onProgress({
                                percent: parseFloat(percent),
                                currentSize: estimatedSize, // 估算值，用于兜底
                                raw: str.trim()
                            });
                        }
                        // 3. 纯字节格式: [download] 123456 bytes (0%)
                        // 或者是 [download] 10.00MiB at 2.00MiB/s (没有总大小)
                        else {
                            const matchSize = str.match(/\[download\]\s+([\d\.]+\w+)\s+at/);
                            if (matchSize) {
                                options.onProgress({
                                    currentSize: matchSize[1],
                                    raw: str.trim()
                                });
                            }
                        }
                    }
                };

                proc.stdout.on("data", (d) => onLine(d.toString()));
                proc.stderr.on("data", (d) => {
                    const s = d.toString();
                    stderr += s;
                    onLine(s);
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        resolve({ success: true, path: destPath });
                    } else {

                        let errorMsg = `exit_code_${code}`;
                        const stderrStr = String(stderr || "").trim();
                        if (stderrStr) {
                            const errorMatch = stderrStr.match(/ERROR:\s*(.*)/);
                            if (errorMatch && errorMatch[1]) {
                                errorMsg = errorMatch[1].trim();
                            } else {

                                const lines = stderrStr.split('\n').map(l => l.trim()).filter(Boolean);

                                const errLines = lines.filter(l => !l.startsWith('[download]') && !l.match(/^\d+%|ETA/));
                                if (errLines.length > 0) {
                                    errorMsg = errLines.slice(-1)[0];
                                }
                            }
                        }
                        resolve({ success: false, error: errorMsg, code });
                    }
                });

                proc.on("error", (e) => resolve({ success: false, error: e.message }));
            });
        };


        if (options.cookieSource || options.browserProfilePath || options.cookiesFilePath) {
            const cs = (options.cookieSource || '').toLowerCase();

            if (options.cookiesFilePath) {
                return await runDownload(["--cookies", options.cookiesFilePath]);
            }

            if (options.browserProfilePath) {

                return await runDownload(["--cookies-from-browser", `chrome:${options.browserProfilePath}`]);
            }

            if (cs === 'chrome' || cs === 'edge' || cs === 'firefox') {
                return await runDownload(["--cookies-from-browser", cs]);
            }
        }


        let res = await runDownload();


        if (!res.success && !options.cookie && (
            res.error?.includes("403") ||
            res.error?.includes("401") ||
            res.error?.includes("Unable to extract") ||
            res.error?.includes("Sign in") ||
            res.error?.includes("exit_code")
        )) {

            const resChrome = await runDownload(["--cookies-from-browser", "chrome"]);
            if (resChrome.success) return resChrome;


            const resEdge = await runDownload(["--cookies-from-browser", "edge"]);
            if (resEdge.success) return resEdge;


            const resFirefox = await runDownload(["--cookies-from-browser", "firefox"]);
            if (resFirefox.success) return resFirefox;
        }

        return res;
    }

    setBinaryPath(path) {
        this.ytdlpPath = path;
    }

    /**
     * 尝试从全局存储路径加载 yt-dlp
     */
    trySetFromGlobalStorage(context) {
        try {
            if (!context || !context.globalStorageUri) return false;

            const os = require('os');
            const path = require('path');
            const fs = require('fs');

            const platform = os.platform();
            const binaryName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
            const installDir = context.globalStorageUri.fsPath;
            const installPath = path.join(installDir, binaryName);

            if (fs.existsSync(installPath) && fs.statSync(installPath).size > 0) {
                this.ytdlpPath = installPath;
                return true;
            }
        } catch { }
        return false;
    }

    /**
     * 自动下载安装yt-dlp
     */
    async autoInstall(context) {
        try {
            const os = require('os');
            const fs = require('fs');
            const path = require('path');
            const https = require('https');

            const platform = os.platform();
            const arch = os.arch();

            let binaryName;
            let officialUrl;
            let mirrorUrl;

            if (platform === 'win32') {
                binaryName = 'yt-dlp.exe';
                officialUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
                mirrorUrl = 'https://ghproxy.net/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
            } else if (platform === 'darwin') {
                binaryName = 'yt-dlp';
                officialUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
                mirrorUrl = 'https://ghproxy.net/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
            } else {
                binaryName = 'yt-dlp';
                officialUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
                mirrorUrl = 'https://ghproxy.net/https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
            }

            const installDir = context.globalStorageUri.fsPath;
            const installPath = path.join(installDir, binaryName);

            if (!fs.existsSync(installDir)) {
                fs.mkdirSync(installDir, { recursive: true });
            }

            if (fs.existsSync(installPath) && fs.statSync(installPath).size > 0) {
                this.ytdlpPath = installPath;
                return { success: true, path: installPath };
            }

            // 尝试下载逻辑：先官方，失败则尝试镜像
            const tryDownload = async (url, timeoutMs = 20000) => {
                return new Promise((resolve, reject) => {
                    const downloadFile = (targetUrl, redirectCount = 0) => {
                        if (redirectCount > 5) {
                            reject(new Error('Too many redirects'));
                            return;
                        }

                        const urlObj = new URL(targetUrl);
                        const options = {
                            hostname: urlObj.hostname,
                            path: urlObj.pathname + urlObj.search,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            },
                            timeout: timeoutMs
                        };

                        const req = https.get(options, (res) => {
                            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                                const location = res.headers.location;
                                if (location) {
                                    downloadFile(new URL(location, targetUrl).href, redirectCount + 1);
                                } else {
                                    reject(new Error(`Redirect without location (status: ${res.statusCode})`));
                                }
                                res.resume();
                                return;
                            }

                            if (res.statusCode === 200) {
                                const file = fs.createWriteStream(installPath);
                                res.pipe(file);
                                file.on('finish', () => {
                                    file.close(() => {
                                        try {
                                            if (fs.statSync(installPath).size > 0) resolve();
                                            else { fs.unlinkSync(installPath); reject(new Error('Empty file')); }
                                        } catch (e) { reject(e); }
                                    });
                                });
                                file.on('error', (err) => { fs.unlink(installPath, () => { }); reject(err); });
                            } else {
                                res.resume();
                                reject(new Error(`Status: ${res.statusCode}`));
                            }
                        });

                        req.on('error', (err) => reject(err));
                        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                    };
                    downloadFile(url);
                });
            };

            try {
                // 第一步：尝试官方下载 (15秒超时)
                await tryDownload(officialUrl, 15000);
            } catch (e) {
                // 第二步：官方失败，尝试镜像下载 (国内加速)
                try {
                    await tryDownload(mirrorUrl, 60000);
                } catch (mirrorErr) {
                    throw new Error(`Official and Mirror both failed. Mirror Error: ${mirrorErr.message}`);
                }
            }

            if (platform !== 'win32') {
                fs.chmodSync(installPath, '755');
            }

            this.ytdlpPath = installPath;
            return { success: true, path: installPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

class PythonEngineDownloader {
    constructor(options = {}) {
        this.pythonPath = options.pythonPath || null;
        this._installInProgress = false;
        this._installTimer = null;
    }

    /**
     * 读取上次安装时间戳（globalState）
     */
    _readState(context) {
        try {
            const ts = context.globalState.get('pythonDepsInstallTimestamp', 0);
            return { installTimestamp: ts };
        } catch (e) { }
        return { installTimestamp: 0 };
    }

    /**
     * 保存安装时间戳（globalState）
     */
    _saveState(context, state) {
        try {
            context.globalState.update('pythonDepsInstallTimestamp', state.installTimestamp);
        } catch (e) { }
    }

    /**
     * 检查是否在 72 小时冷却期内
     */
    _isInCooldown(context) {
        const COOLDOWN_MS = 72 * 60 * 60 * 1000; // 72 小时
        const state = this._readState(context);
        const now = Date.now();
        return (now - state.installTimestamp) < COOLDOWN_MS;
    }

    /**
     * 依赖名到导入名的映射
     */
    _getImportName(dep) {
        const importMap = {
            'Pillow': 'PIL',
            'pywin32': 'win32api'  // pywin32 通过 win32api 检测
        };
        return importMap[dep] || dep;
    }

    /**
     * 快速检测：Python 是否已有指定依赖
     * @param {string} pythonBin - Python 路径
     * @param {string[]} deps - 要检测的依赖列表
     * @returns {Object} - { hasAll: boolean, missing: string[], detail: { dep: boolean } }
     */
    async checkDeps(pythonBin, deps = ['miniaudio', 'Pillow']) {
        const { spawnSync } = require("child_process");

        // 构建检测脚本（修复：使用 print 输出结果，确保每个依赖都有独立的输出）
        const checkScript = deps.map(dep => {
            const importName = this._getImportName(dep);
            return `
try:
    import ${importName}
    print('DEP_CHECK:${dep}:1')
except Exception as e:
    print('DEP_CHECK:${dep}:0:${e.message.replace(/\\n/g, ' ')}')`;
        }).join('\n');

        const fullScript = `
import sys
${checkScript}
sys.exit(0)
`.trim();

        try {
            const r = spawnSync(pythonBin, ["-c", fullScript], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 15000
            });

            const stdout = r.stdout || '';
            const detail = {};
            const missing = [];
            const errors = {};

            // 解析输出，使用更可靠的匹配方式
            const lines = stdout.split('\n');
            for (const line of lines) {
                if (line.startsWith('DEP_CHECK:')) {
                    const parts = line.substring(10).split(':');
                    if (parts.length >= 2) {
                        const dep = parts[0];
                        const status = parts[1];
                        const error = parts.slice(2).join(':') || '';
                        detail[dep] = status === '1';
                        if (status !== '1') {
                            missing.push(dep);
                            errors[dep] = error;
                        }
                    }
                }
            }

            // 确保所有依赖都有检测结果
            for (const dep of deps) {
                if (!(dep in detail)) {
                    detail[dep] = false;
                    missing.push(dep);
                    errors[dep] = 'No detection result';
                }
            }

            return {
                hasAll: missing.length === 0,
                missing,
                detail,
                errors
            };
        } catch (e) {
            return { hasAll: false, missing: deps, detail: {}, errors: { all: e.message } };
        }
    }

    /**
     * 异步安装依赖（后台执行）
     * @param {string} pythonBin - Python 路径
     * @param {string[]} deps - 要安装的依赖列表
     * @param {Object} context - VS Code 扩展上下文
     */
    async _installDepsAsync(pythonBin, deps, context) {
        if (this._installInProgress) {
            return { success: false, error: '安装已在进行中' };
        }

        this._installInProgress = true;
        const global = require('./global');
        const cp = require('child_process');
        const path = require('path');
        const fs = require('fs');

        try {
            const isInternal = pythonBin.includes('python_engine');
            const engineDir = isInternal ? path.dirname(pythonBin) : null;

            // 确定目标路径
            let targetPath = null;
            if (isInternal && engineDir) {
                targetPath = path.join(engineDir, 'site-packages');
                if (!fs.existsSync(targetPath)) {
                    fs.mkdirSync(targetPath, { recursive: true });
                }
            }

            // 构建 pip install 命令
            const pkgs = deps.join(' ');
            let cmd;
            let installEnv;

            if (isInternal && targetPath) {
                cmd = `"${pythonBin}" -m pip install ${pkgs} --quiet --target="${targetPath}"`;
                installEnv = { ...process.env, PYTHONNOUSERSITE: '1' };
            } else {
                cmd = `"${pythonBin}" -m pip install ${pkgs} --quiet --user --index-url https://mirrors.aliyun.com/pypi/simple/`;
                installEnv = process.env;
            }

            global.logMessage(`[PythonCheck] 开始安装依赖: ${deps.join(', ')}`, 'INFO');

            // 执行安装
            cp.execSync(cmd, {
                windowsHide: true,
                timeout: 180000, // 3 分钟超时
                env: installEnv
            });

            global.logMessage(`[PythonCheck] 依赖安装成功: ${deps.join(', ')}`, "INFO");

            // ★ 无论成功失败，都记录安装时间（用于 72 小时冷却）
            this._saveState(context, { installTimestamp: Date.now() });

            return { success: true, installed: deps };
        } catch (e) {
            global.logMessage(`[PythonCheck] 依赖安装失败: ${e.message}`, 'ERROR');
            // ★ 失败也要记录时间，防止频繁重试
            this._saveState(context, { installTimestamp: Date.now() });
            return { success: false, error: e.message };
        } finally {
            this._installInProgress = false;
        }
    }

    /**
     * 安排后台安装（在 20 秒后执行）
     * @param {string} pythonBin - Python 路径
     * @param {string[]} deps - 要安装的依赖列表
     * @param {Object} context - VS Code 扩展上下文
     */
    scheduleInstall(pythonBin, deps, context) {
        // 清除之前的定时器
        if (this._installTimer) {
            clearTimeout(this._installTimer);
        }

        // 20 秒后执行安装
        this._installTimer = setTimeout(async () => {
            const global = require('./global');
            global.logMessage(`[PythonCheck] 触发后台依赖安装检查`, 'INFO');

            // 再次检查是否已在冷却期内
            if (this._isInCooldown(context)) {
                global.logMessage(`[PythonCheck] 在 72 小时冷却期内，跳过安装`, 'INFO');
                return;
            }

            await this._installDepsAsync(pythonBin, deps, context);
        }, 20000); // 20 秒延迟
    }

    async isAvailable(pythonBin = null) {
        const bin = pythonBin || this.pythonPath;
        if (!bin) return false;
        try {
            const fs = require('fs');
            const path = require('path');
            if (path.isAbsolute(bin) && !fs.existsSync(bin)) return false;

            const { spawnSync } = require("child_process");

            // 快速版本检测
            const checkScript = `
import sys
v = sys.version_info
ok = (3, 7) <= v < (3, 13)
msg = f'PYTHON_READY|EXE:{sys.executable}' if ok else f'VERSION_OUT_OF_RANGE:{v.major}.{v.minor}'
sys.stdout.write(msg)
sys.exit(0 if ok else 1)
`.trim();

            const r = spawnSync(bin, ["-c", checkScript], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 20000,
                cwd: path.isAbsolute(bin) ? path.dirname(bin) : undefined
            });

            if (r.status === 0 && (r.stdout || "").includes("PYTHON_READY")) {
                const stdout = r.stdout || "";
                const exeMatch = stdout.match(/EXE:([^|]+)/);
                if (exeMatch) this._resolvedPath = exeMatch[1];
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * 仅快速检测依赖是否存在（不安装）
     * @param {string} pythonBin - Python 路径
     * @returns {Object} - { missing: string[], allReady: boolean }
     */
    async quickCheckDeps(pythonBin) {
        // 基础依赖：跨平台
        const baseDeps = ['miniaudio', 'Pillow'];
        // Windows 专属依赖：pywin32 (剩下粘贴、剪贴板操作的保底方案)
        const deps = process.platform === 'win32'
            ? [...baseDeps, 'pywin32']
            : baseDeps;
        return await this.checkDeps(pythonBin, deps);
    }

    /**
     * 检查冷却期剩余时间
     * @param {Object} context - VS Code 扩展上下文
     * @returns {Object} - { inCooldown: boolean, remainingHours: number, remainingMinutes: number, remainingMs: number }
     */
    _getCooldownStatus(context) {
        const COOLDOWN_MS = 72 * 60 * 60 * 1000; // 72 小时
        const state = this._readState(context);
        const now = Date.now();
        const elapsed = now - state.installTimestamp;
        const remainingMs = Math.max(0, COOLDOWN_MS - elapsed);

        return {
            inCooldown: remainingMs > 0,
            remainingHours: Math.floor(remainingMs / (60 * 60 * 1000)),
            remainingMinutes: Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000)),
            remainingMs
        };
    }

    /**
     * 准备依赖（分离启动和安装）
     * 此方法仅快速检测，不阻塞启动
     * @param {string} pythonBin - Python 路径
     * @param {Object} context - VS Code 扩展上下文
     */
    async prepareDependencies(pythonBin, context) {
        // 快速检测依赖状态
        const checkResult = await this.quickCheckDeps(pythonBin);

        if (checkResult.hasAll) {
            // 所有依赖都已存在
            return { status: 'ready', missing: [], detail: checkResult.detail };
        }

        // 有缺失的依赖
        // 检查是否在冷却期内
        const cooldownStatus = this._getCooldownStatus(context);
        if (cooldownStatus.inCooldown) {
            // ★ 冷却期内直接跳过，什么都不做
            return {
                status: 'cooldown',
                missing: checkResult.missing,
                detail: checkResult.detail,
                errors: checkResult.errors,
                cooldown: cooldownStatus
            };
        }

        // ★ 冷却期外：安排 20 秒后后台安装一次
        this.scheduleInstall(pythonBin, checkResult.missing, context);
        return {
            status: 'scheduled',
            missing: checkResult.missing,
            detail: checkResult.detail,
            errors: checkResult.errors
        };
    }

    /**
     * 强制安装依赖（立即执行，不受冷却期限制）
     * @param {string} pythonBin - Python 路径
     * @param {Object} context - VS Code 扩展上下文
     */
    async forceInstallDeps(pythonBin, context) {
        const checkResult = await this.quickCheckDeps(pythonBin);
        if (checkResult.hasAll) {
            return { success: true, message: '依赖已存在' };
        }
        return await this._installDepsAsync(pythonBin, checkResult.missing, context);
    }

    async trySetFromGlobalStorage(context) {
        const path = require('path');
        const fs = require('fs');
        const installDir = path.join(context.globalStorageUri.fsPath, "python_engine");
        const binName = process.platform === "win32" ? "python.exe" : "bin/python3";
        const ownPath = path.join(installDir, binName);
        if (fs.existsSync(ownPath)) {
            if (await this.isAvailable(ownPath)) {
                this.pythonPath = ownPath;
                return true;
            }
        }
        return false;
    }

    /**
     * 记录依赖检测结果的综合日志
     * @param {Object} prepResult - 依赖准备结果
     */
    _logDependencyResult(prepResult) {
        const global = require('./global');
        const detail = prepResult.detail || {};
        const errors = prepResult.errors || {};
        const successDeps = Object.entries(detail).filter(([_, has]) => has).map(([dep]) => dep);
        const failedDeps = Object.entries(detail).filter(([_, has]) => !has).map(([dep]) => dep);

        let logMessage = `[PythonCheck] `;

        // 添加成功的依赖信息
        if (successDeps.length > 0) {
            logMessage += `${successDeps.join(', ')} 检测成功`;
            if (failedDeps.length > 0) {
                logMessage += `, `;
            }
        }

        // 添加失败的依赖信息
        if (failedDeps.length > 0) {
            logMessage += `缺失: ${failedDeps.join(', ')}`;
            // 添加失败原因
            const errorMessages = failedDeps.map(dep => {
                const error = errors[dep] || '未知错误';
                return `${dep}: ${error}`;
            });
            if (errorMessages.length > 0) {
                logMessage += ` (原因: ${errorMessages.join(', ')})`;
            }
        }

        // 添加冷却期信息
        if (prepResult.status === 'cooldown' && prepResult.cooldown) {
            const { remainingHours, remainingMinutes } = prepResult.cooldown;
            logMessage += `, 冷却期剩余: ${remainingHours}小时${remainingMinutes}分钟`;
        } else if (prepResult.status === 'scheduled') {
            logMessage += `, 不在冷却期，已安排后台安装`;
        }

        global.logMessage(logMessage, "INFO");
    }

    async autoInstall(context) {
        try {
            const os = require('os');
            const fs = require('fs');
            const path = require('path');
            const https = require('https');
            const cp = require('child_process');

            const platform = os.platform();
            const installDir = path.join(context.globalStorageUri.fsPath, "python_engine");
            const zipPath = path.join(context.globalStorageUri.fsPath, "python_3.8.10.tmp");
            const binName = platform === "win32" ? "python.exe" : "bin/python3";
            const installPath = path.join(installDir, binName);

            if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, {
                recursive: true
            });

            let officialUrl, mirrorUrl;
            if (platform === 'win32') {
                officialUrl = 'https://www.python.org/ftp/python/3.8.10/python-3.8.10-embed-amd64.zip';
                mirrorUrl = 'https://mirrors.aliyun.com/python/ftp/python/3.8.10/python-3.8.10-embed-amd64.zip';
            } else if (platform === 'darwin') {
                officialUrl = 'https://github.com/indygreg/python-build-standalone/releases/download/20230507/cpython-3.8.10+20230507-x86_64-apple-darwin-install_only.tar.gz';
                mirrorUrl = 'https://ghproxy.net/https://github.com/indygreg/python-build-standalone/releases/download/20230507/cpython-3.8.10+20230507-x86_64-apple-darwin-install_only.tar.gz';
            } else {
                officialUrl = 'https://github.com/indygreg/python-build-standalone/releases/download/20230507/cpython-3.8.10+20230507-x86_64-unknown-linux-gnu-install_only.tar.gz';
                mirrorUrl = 'https://ghproxy.net/https://github.com/indygreg/python-build-standalone/releases/download/20230507/cpython-3.8.10+20230507-x86_64-unknown-linux-gnu-install_only.tar.gz';
            }

            const downloadFile = (url, targetPath, timeoutMs = 30000) => {
                return new Promise((resolve, reject) => {
                    const doReq = (targetUrl, redirects = 0) => {
                        if (redirects > 5) return reject(new Error("Too many redirects"));
                        const urlObj = new URL(targetUrl);
                        const req = https.get({
                            hostname: urlObj.hostname,
                            path: urlObj.pathname + urlObj.search,
                            timeout: timeoutMs,
                            headers: {
                                'User-Agent': 'Mozilla/5.0'
                            }
                        }, (res) => {
                            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                                res.resume();
                                return doReq(new URL(res.headers.location, targetUrl).href, redirects + 1);
                            }
                            if (res.statusCode !== 200) {
                                res.resume();
                                return reject(new Error(`Status: ${res.statusCode}`));
                            }
                            const file = fs.createWriteStream(targetPath);
                            res.pipe(file);
                            file.on('finish', () => {
                                file.close();
                                resolve();
                            });
                            file.on('error', (e) => {
                                fs.unlink(targetPath, () => { });
                                reject(e);
                            });
                        });
                        req.on('error', reject);
                        req.on('timeout', () => {
                            req.destroy();
                            reject(new Error("Timeout"));
                        });
                    };
                    doReq(url);
                });
            };

            // 下载
            try {
                await downloadFile(officialUrl, zipPath, 15000);
            } catch {
                await downloadFile(mirrorUrl, zipPath, 60000);
            }

            // 解压
            if (platform === 'win32') {
                cp.execSync(`tar -xf "${zipPath}" -C "${installDir}"`, {
                    windowsHide: true
                });
                // 提前修复 ._pth，确保 isAvailable 能跑通
                const pthFile = path.join(installDir, 'python38._pth');
                if (fs.existsSync(pthFile)) {
                    let content = fs.readFileSync(pthFile, 'utf8');
                    if (content.includes('#import site')) {
                        content = content.replace('#import site', 'import site');
                        content += '\n./site-packages\n';
                        fs.writeFileSync(pthFile, content);
                    }
                }
            } else {
                cp.execSync(`tar -xzf "${zipPath}" -C "${installDir}" --strip-components=1`, {
                    windowsHide: true
                });
            }
            fs.unlinkSync(zipPath);

            if (await this.isAvailable(installPath)) {
                this.pythonPath = installPath;
                // ★ 分离：快速检测依赖，不阻塞启动
                const prepResult = await this.prepareDependencies(installPath, context);
                global.logMessage(`[PythonCheck] autoInstall 依赖准备: ${prepResult.status}`, "INFO");
                return {
                    success: true,
                    path: installPath
                };
            }
            return {
                success: false,
                error: "Validation failed after install"
            };
        } catch (e) {
            return {
                success: false,
                error: e.message
            };
        }
    }
}

class UnifiedMediaDownloader {
    constructor(options = {}) {

        const securityLevel = options.securityLevel ?? 1;
        const securityOverrides = options.securityOverrides || null;

        this.http = new SmartHttpDownloader({
            ...(options.http || {}),
            securityLevel,
            securityOverrides,
            baseDir: options.baseDir || options.http?.baseDir || null,
        });

        this.ytdlp = new YtDlpDownloader({
            ...(options.ytdlp || {}),
            securityLevel,
            securityOverrides,
        });

        this.python = new PythonEngineDownloader({
            pythonPath: options.pythonPath || null
        });

        this.options = {
            downloadVideos: options.downloadVideos || "direct-only",
            ytdlpConcurrency: Math.max(1, Number(options.ytdlpConcurrency) || 1),
            maxBytesImage: options.maxBytesImage ?? 20 * 1024 * 1024,
            maxBytesDirectVideo: options.maxBytesDirectVideo ?? 200 * 1024 * 1024,


            securityLevel,
            securityOverrides,


            baseDir: options.baseDir || null,

            ...options,
        };
    }

    /**
     * probe：用于 UI “下载前预览”
     */
    async probe(url) {
        return await this.ytdlp.probe(url);
    }

    async cancelAll() {
        try {
            if (this.http && typeof this.http.cancelAll === 'function') {
                this.http.cancelAll();
            }
        } catch (e) { }
    }

    async downloadAll(input, targetDir, opts = {}) {
        const downloadVideos = opts.downloadVideos || this.options.downloadVideos;
        const onProgress = opts.onProgress;

        const tasks = this._normalizeTasks(input, targetDir);

        const httpTasks = [];
        const ytdlpTasks = [];
        const manualResults = [];

        for (const t of tasks) {
            if (isBlobUrl(t.url)) {
                const r = { url: t.url, destPath: t.destPath, success: false, manual: true, error: "blob_url_unavailable" };
                manualResults.push(r);
                onProgress && onProgress(t, { type: "manual", reason: "blob_url_unavailable" });
                continue;
            }

            const needYtDlp = isPlatformOrSegmentVideo(t.url);

            if (needYtDlp) {
                if (downloadVideos !== "all") {
                    const r = {
                        url: t.url,
                        destPath: t.destPath,
                        success: false,
                        manual: true,
                        error: "platform_or_segment_video_requires_ytdlp",
                    };
                    manualResults.push(r);
                    onProgress && onProgress(t, { type: "manual", reason: "need_ytdlp_enable_all" });
                    continue;
                }

                if (!this.ytdlp.isAvailable()) {
                    const r = { url: t.url, destPath: t.destPath, success: false, manual: true, error: "yt-dlp_not_installed" };
                    manualResults.push(r);
                    onProgress && onProgress(t, { type: "manual", reason: "yt-dlp_not_installed" });
                    continue;
                }

                ytdlpTasks.push(t);
                continue;
            }

            if (!("maxBytes" in t)) {
                const isVideo =
                    t.kind === "video" ||
                    (t.kind === "auto" && /\.(mp4|webm|mov|mkv|m4v|avi|ogv)(\?|$)/i.test(String(t.url)));
                t.maxBytes = isVideo ? this.options.maxBytesDirectVideo : this.options.maxBytesImage;
            }

            httpTasks.push(t);
        }

        const httpRes = await this.http.downloadAll(httpTasks, onProgress);

        const ytdlpResults = [];
        if (ytdlpTasks.length > 0) {
            await runPool(ytdlpTasks, this.options.ytdlpConcurrency, async (t) => {
                onProgress && onProgress(t, { type: "start", protocol: "yt-dlp" });

                const r = await this.ytdlp.download(t.url, t.destPath, {
                    rateLimit: opts.videoRateLimit,
                    format: opts.videoFormat,

                    // ★ 优先使用全局 cookiesFilePath，其次使用 task 级别的
                    cookiesFilePath: opts.cookiesFilePath || t.meta?.cookiesFilePath,
                    cookieSource: t.meta?.cookieSource,
                    referer: t.meta?.referer,
                    cookie: t.meta?.cookie,
                    origin: t.meta?.origin,
                    browserProfilePath: t.meta?.browserProfilePath,
                    userAgent: t.meta?.userAgent,
                    onProgress: (p) => onProgress && onProgress(t, { type: "progress", protocol: "yt-dlp", progress: p }),
                });

                const rr = r.success
                    ? { url: t.url, destPath: t.destPath, success: true, path: r.path, tag: t.tag, meta: t.meta }
                    : { url: t.url, destPath: t.destPath, success: false, error: r.error, tag: t.tag, meta: t.meta };

                ytdlpResults.push(rr);

                if (rr.success) onProgress && onProgress(t, { type: "done", protocol: "yt-dlp", ...rr });
                else onProgress && onProgress(t, { type: "error", protocol: "yt-dlp", ...rr });
            });
        }

        const results = [...httpRes.results, ...ytdlpResults, ...manualResults];
        const stats = this._mergeStats(httpRes.stats, ytdlpResults, manualResults);

        return {
            stats,
            results,
            ytdlpAvailable: this.ytdlp.isAvailable(),
            securityLevel: this.options.securityLevel,
            securityEffective: mergeSecurityOptions(this.options.securityLevel, this.options.securityOverrides),
        };
    }

    async ensurePythonReady(context, options = {}) {
        const {
            background = false,
            silent = false
        } = options;

        const path = require('path');
        const fs = require('fs');
        const global = require('./global');

        // ★ 新架构：快速检测 → 立即启动 → 后台异步安装（20秒后）

        // 1. Level 1: 仅检查插件自维护目录 (gh555.qqq/python_engine)，不执行下载
        if (context && await this.python.trySetFromGlobalStorage(context)) {
            const finalPath = this.python._resolvedPath || this.python.pythonPath;
            if (this._lastLoggedPython !== finalPath) {
                global.logMessage(`[PythonCheck] Level 1 命中: 使用插件内置引擎 ${finalPath}`, "INFO");
                this._lastLoggedPython = finalPath;
            }
            // ★ 分离：快速检测依赖，不阻塞启动
            const prepResult = await this.python.prepareDependencies(this.python.pythonPath, context);
            // 记录综合日志
            this.python._logDependencyResult(prepResult);
            return this.python.pythonPath;
        }

        // 2. Level 2: 检查 VS Code 设置中的 Python 路径
        try {
            const config = vscode.workspace.getConfiguration('python');
            const settingPath = config.get('defaultInterpreterPath') || config.get('pythonPath');
            if (settingPath && await this.python.isAvailable(settingPath)) {
                this.python.pythonPath = settingPath;
                const finalPath = this.python._resolvedPath || settingPath;
                if (this._lastLoggedPython !== finalPath) {
                    global.logMessage(`[PythonCheck] Level 2 命中: 使用 VS Code 配置路径 ${finalPath}`, "INFO");
                    this._lastLoggedPython = finalPath;
                }
                // ★ 分离：快速检测依赖，不阻塞启动
                const prepResult = await this.python.prepareDependencies(settingPath, context);
                // 记录综合日志
                this.python._logDependencyResult(prepResult);
                return settingPath;
            }
        } catch (e) { }

        // 3. Level 3: 检查系统环境中的解释器 (PATH)
        const envBins = process.platform === "win32" ? ["python"] : ["python3", "python"];
        for (const bin of envBins) {
            if (await this.python.isAvailable(bin)) {
                this.python.pythonPath = bin;
                const finalPath = this.python._resolvedPath || bin;
                if (this._lastLoggedPython !== finalPath) {
                    global.logMessage(`[PythonCheck] Level 3 命中: 使用系统环境变量路径 ${finalPath}`, "INFO");
                    this._lastLoggedPython = finalPath;
                }
                // ★ 分离：快速检测依赖，不阻塞启动
                const prepResult = await this.python.prepareDependencies(bin, context);
                // 记录综合日志
                this.python._logDependencyResult(prepResult);
                return bin;
            }
        }

        // 4. Level 4: 兜底，前三项全灭，启动闭环下载/安装逻辑
        if (this._pyInstallPromise) return this._pyInstallPromise;

        this._pyInstallPromise = (async () => {
            try {
                const downloadAction = async (progress) => {
                    if (progress) progress.report({ message: "正在自举安装 Python 引擎 (3.8.10)...", increment: 10 });
                    const res = await this.python.autoInstall(context);
                    if (res.success) {
                        const finalPath = this.python._resolvedPath || res.path;
                        global.logMessage(`[PythonCheck] Level 4 命中: 下载安装成功 ${finalPath}`, "INFO");
                        this._lastLoggedPython = finalPath;
                        // ★ 分离：快速检测依赖，不阻塞启动
                        const prepResult = await this.python.prepareDependencies(res.path, context);
                        // 记录综合日志
                        this.python._logDependencyResult(prepResult);
                        return res.path;
                    } else {
                        global.logMessage(`[PythonCheck] Level 4 失败: ${res.error}`, "ERROR");
                        return null;
                    }
                };

                if (background) {
                    return await downloadAction(null);
                } else {
                    return await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "qqq: ",
                        cancellable: false
                    }, downloadAction);
                }
            } finally {
                this._pyInstallPromise = null;
            }
        })();

        return this._pyInstallPromise;
    }

    destroy() {
        this.http.destroy();
    }

    _normalizeTasks(input, targetDir) {
        const out = [];
        const arr = Array.isArray(input) ? input : [];

        for (const item of arr) {
            if (typeof item === "string") {
                if (!targetDir) throw new Error("targetDir is required when input is string[]");

                const destPath = path.join(targetDir, generateFilename(item, "image"));
                out.push({ url: item, destPath, kind: "auto", baseDir: this.options.baseDir || null });
                continue;
            }

            if (item && typeof item === "object" && item.url) {
                const kind = item.kind || "auto";
                let destPath = item.destPath;

                if (!destPath) {
                    if (!targetDir) throw new Error("destPath missing and targetDir not provided");
                    const inferredKind =
                        kind === "auto"
                            ? isPlatformOrSegmentVideo(item.url)
                                ? "video"
                                : /\.(mp4|webm|mov|mkv|m4v|avi|ogv)(\?|$)/i.test(String(item.url))
                                    ? "video"
                                    : "image"
                            : kind;

                    destPath = path.join(targetDir, item.filename || generateFilename(item.url, inferredKind));
                }

                out.push({
                    url: item.url,
                    destPath,
                    kind,
                    maxBytes: item.maxBytes,
                    headers: item.headers,
                    referrer: item.referrer || item.referer,
                    tag: item.tag,
                    meta: item.meta,
                    baseDir: item.baseDir || this.options.baseDir || null,
                });
            }
        }

        return out;
    }

    _mergeStats(httpStats, ytdlpResults, manualResults) {
        const stats = { started: 0, completed: 0, failed: 0, manual: 0 };

        if (httpStats) {
            stats.started += httpStats.started || 0;
            stats.completed += httpStats.completed || 0;
            stats.failed += httpStats.failed || 0;
            stats.manual += httpStats.manual || 0;
        }

        for (const r of ytdlpResults || []) {
            stats.started++;
            if (r.success) stats.completed++;
            else stats.failed++;
        }

        for (const r of manualResults || []) {
            stats.started++;
            stats.manual++;
        }

        return stats;
    }

    async ensureYtdlpReady(context, options = {}) {
        const {
            silent = false,      // 为 true 时：不弹出“是否安装”的询问框，直接静默开始安装
            background = false   // 为 true 时：不显示进度条，安装失败也不弹出错误提示（用于启动预热）
        } = options;

        if (context && this.ytdlp.trySetFromGlobalStorage(context)) {
            if (this.ytdlp.isAvailable()) return true;
        }

        if (!this.ytdlp.isAvailable()) {
            if (!vscode) return false;

            let shouldInstall = silent || background;

            if (!shouldInstall) {
                const installConfirmed = await vscode.window.showInformationMessage(
                    "yt-dlp 未安装，是否自动下载安装？",
                    { modal: true },
                    "是",
                    "否"
                );
                shouldInstall = (installConfirmed === "是");
            }

            if (shouldInstall) {
                if (this._installPromise) return this._installPromise;

                this._installPromise = (async () => {
                    try {
                        const downloadAction = async (progress) => {
                            if (progress) progress.report({ message: "正在下载视频引擎...", increment: 10 });
                            const res = await this.ytdlp.autoInstall(context);
                            if (res.success) {
                                if (!background) {
                                    // 使用 withProgress 实现 9 秒自动关闭的成功提示
                                    vscode.window.withProgress({
                                        location: vscode.ProgressLocation.Notification,
                                        title: "qqq: yt-dlp 安装成功",
                                        cancellable: false
                                    }, () => new Promise(resolve => setTimeout(resolve, 9000)));
                                }
                                return true;
                            } else {
                                // 仅在非后台模式下弹出错误提示
                                if (!background && vscode) {
                                    // 使用 withProgress 实现 9 秒自动关闭的失败提示
                                    vscode.window.withProgress({
                                        location: vscode.ProgressLocation.Notification,
                                        title: `qqq: 视频引擎 (yt-dlp) 下载失败: ${res.error}`,
                                        cancellable: false
                                    }, () => new Promise(resolve => setTimeout(resolve, 9000)));
                                }
                                try {
                                    const global = require('./global');
                                    global.logMessage(`yt-dlp 安装失败: ${res.error}`, "ERROR");
                                } catch { }
                                return false;
                            }
                        };

                        if (background) {
                            // 后台模式：真正静默，无 UI
                            return await downloadAction(null);
                        } else {
                            // 非后台模式：显示进度条反馈
                            return await vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: "qqq: ",
                                cancellable: false
                            }, downloadAction);
                        }
                    } finally {
                        this._installPromise = null;
                    }
                })();

                return this._installPromise;
            } else {
                if (!background) {
                    vscode.window.showWarningMessage("yt-dlp 未安装，无法下载平台视频。请安装 yt-dlp 后重试。");
                }
                return false;
            }
        }
        return true;
    }

    async probeAndSelect(url, progress) {
        if (progress) progress.report({ message: "正在探测视频资源...", increment: 10 });

        let probeResult = null;
        let probeError = null;
        try {
            probeResult = await this.ytdlp.probe(url);
        } catch (error) {
            probeError = error;
        }

        if (!probeResult || !probeResult.success) {
            if (progress) progress.report({ message: "yt-dlp探测失败，尝试直接解析网页...", increment: 15 });
            try {
                const h = require('./h');
                const videoUrls = await h.extractVideoUrlsFromWebPage(url);
                if (videoUrls && videoUrls.length > 0) {
                    probeResult = {
                        success: true,
                        isPlaylist: videoUrls.length > 1,
                        entries: videoUrls.map((videoUrl, index) => ({
                            id: `direct_video_${index}`,
                            title: `直接视频链接 ${index + 1}`,
                            url: videoUrl,
                            webpageUrl: url
                        }))
                    };
                    if (videoUrls.length === 1) {
                        probeResult.title = '直接视频链接';
                        probeResult.url = videoUrls[0];
                    } else {
                        probeResult.entriesCount = videoUrls.length;
                    }
                } else {
                    if (progress) progress.report({ message: "直接解析未找到视频，尝试使用yt-dlp探测...", increment: 20 });
                    probeResult = await this.ytdlp.probe(url);
                    if (!probeResult || !probeResult.success) {
                        if (vscode) vscode.window.showErrorMessage(`视频探测失败: ${probeError ? probeError.message : (probeResult?.error || '网页中未找到可直接下载的视频，yt-dlp也无法处理此页面')}`);
                        return null;
                    }
                }
            } catch (webError) {
                if (vscode) vscode.window.showErrorMessage(`网页解析失败: ${webError.message}`);
                return null;
            }
        }

        if (progress) progress.report({ message: "发现视频资源，准备选择...", increment: 30 });

        let videosToDownload = [];

        if (probeResult.isPlaylist) {
            if (!vscode) return null;
            const items = probeResult.entries.map((entry, index) => ({
                label: entry.title || `视频 ${index + 1}`,
                description: `${entry.duration ? Math.floor(entry.duration) + '秒' : '未知时长'}`,
                detail: entry.url,
                video: entry
            }));

            const selectedItems = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                placeHolder: "选择要下载的视频",
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!selectedItems || selectedItems.length === 0) {
                return null;
            }
            videosToDownload = selectedItems.map(item => item.video);
        } else {
            videosToDownload = [probeResult.entries ? probeResult.entries[0] : probeResult];
        }

        return videosToDownload;
    }

    async downloadVideos(videos, targetDir, progress) {
        if (!videos || videos.length === 0) return;
        if (progress) progress.report({ message: `准备下载 ${videos.length} 个视频`, increment: 50 });

        const h = require('./h');

        const downloadTasks = videos.map(video => {
            const filename = h.getTimestampFilename('.mp4');
            const destPath = require('path').join(targetDir, filename);
            return {
                url: video.url,
                destPath: destPath,
                tag: Math.random().toString(36).slice(2) + "_" + Date.now(),
                title: video.title || '网页视频',


                meta: video._meta || video.meta
            };
        });

        const downloadResult = await this.downloadAll(downloadTasks, targetDir, {
            downloadVideos: "all",
            onProgress: (task, event) => {
                if (progress) {
                    if (event.type === "progress") {
                        progress.report({ message: `下载中: ${task.title || '视频'}`, increment: 5 });
                    } else if (event.type === "done") {
                        progress.report({ message: `已下载: ${task.title || '视频'}`, increment: 10 });
                    }
                }
            }
        });

        // ★ 不在这里显示弹窗，由调用方统一处理

        if (progress) progress.report({ increment: 100 });
        return downloadResult;
    }
}

function applyResultsToItems(items, results, idKey = "id") {
    const resultMap = new Map(results.map((r) => [r.tag || r.url, r]));

    for (const item of items || []) {
        const key = item?.[idKey] || item?.url;
        if (!key) continue;

        const res = resultMap.get(key);
        if (!res) continue;

        item.downloadStatus = res.success ? "success" : "error";
        if (res.success) {
            item.localPath = res.destPath || res.path;
            item.errorMessage = "";
        } else {
            item.errorMessage = res.error || "failed";
        }
    }
}

let globalInstance = null;

function getSharedDownloader(options = {}) {
    if (!globalInstance) {
        globalInstance = new UnifiedMediaDownloader(options);
    }
    return globalInstance;
}

module.exports = {
    UnifiedMediaDownloader,
    SmartHttpDownloader,
    YtDlpDownloader,


    runPool,
    findExecutableInPath,
    isPlatformOrSegmentVideo,
    isBlobUrl,
    generateFilename,


    applyResultsToItems,
    getSharedDownloader,


    resolveSecurityProfile,
    mergeSecurityOptions,
};

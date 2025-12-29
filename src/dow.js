// unified-media-downloader.js
"use strict";

/**
 * ──────────────────────────────────────────────────────────────
 * 安全开关（前 11 项，每项独立开关） + 3 档位组合
 * ──────────────────────────────────────────────────────────────
 *
 * 11 项独立开关（与我们上面讨论的 1~11 对齐）：
 *  1) enableSSRFProtection              : SSRF 防护（阻止内网/本机/保留网段）
 *  2) enableUrlProtocolAndCredsGuard    : 仅允许 http/https + 禁止 URL credentials（user:pass@）
 *  3) enableRedirectProtocolGuard       : 重定向协议限制（仅允许跳 http/https）
 *  4) enableBaseDirGuard                : 路径越界防护（destPath 必须落在 baseDir 内）
 *  5) enableDownloadLock                : 下载锁（避免并发踩踏）
 *  6) enableHeaderSanitize              : Header 注入清洗（CRLF/非法 header name）
 *  7) enableContentLengthRangePrecheck  : content-length / content-range 校验（声明长度/范围预检）
 *  8) enableStrictResumeChecks          : 严格续传策略（206 必须 + Range+压缩拒绝）
 *  9) enableSymlinkGuard                : 符号链接防护（基础：dest/tmp 若为 symlink 直接拒绝）
 * 10) enableProbeOutputLimit            : yt-dlp probe stdout/stderr 限制（防内存炸）
 * 11) enableFailFast                    : Fail-fast（遇到“可疑/不确定”优先失败而不是宽容放行）
 *
 * 档位（securityLevel）：
 *  0 档：最宽松 —— 11 项全部关闭
 *  1 档：中等宽松 —— 我设计的组合（兼容性更好，但仍保留关键防护）
 *  2 档：严格 —— 11 项全部开启（最安全）
 *
 * 说明：
 *  - 你仍可在构造器 options.securityOverrides 里逐项覆写（独立开关优先级最高）
 *  - 某些特性在“开关开启但缺少必要参数”时：
 *      * 若 enableFailFast=true -> 直接报错
 *      * 若 enableFailFast=false -> 尽量降级继续（中等/宽松更友好）
 */

const http2 = require("http2");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const dns = require("dns");
const net = require("net");
const { pipeline, Transform } = require("stream");
const { spawn, spawnSync } = require("child_process");
let vscode = null;
try { vscode = require("vscode"); } catch { }

/* ──────────────────────────────────────────────────────────────
 * 0) 无依赖并发池
 * ────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────
 * 1) PATH 可执行文件探测（避免 which 依赖）
 * ────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────
 * 2) 基础工具
 * ────────────────────────────────────────────────────────────── */
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
        .replace("T", " ")
        .slice(0, 23);
}

function guessExtension(url, kind) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();

        if (kind === "video") {
            const m = pathname.match(/\.(mp4|webm|mov|mkv|m4v|avi|ogv)(\?|$)/);
            if (m) return "." + m[1];
            return null; // m3u8/mpd 一般交给 yt-dlp 输出 mp4
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
    return `${rand}. ${ts}${ext}`;
}

/**
 * 平台/分片视频（需要 yt-dlp）
 */
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
        /\.m3u8(\?|$)/i, // HLS
        /\.mpd(\?|$)/i, // DASH
    ];
    return patterns.some((p) => p.test(s));
}

/* ──────────────────────────────────────────────────────────────
 * 3) 字节上限 Transform（支持断点续写的初始偏移）
 * ────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────
 * 4) content-encoding 解码（更鲁棒）
 *    注意：断点续写时默认禁用压缩（Range + 压缩非常不可靠）
 * ────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────
 * 5) Retry 策略：谨慎但强力
 * ────────────────────────────────────────────────────────────── */
function parseRetryAfterMs(retryAfter) {
    if (!retryAfter) return 0;
    const v = String(retryAfter).trim();
    if (!v) return 0;

    // seconds
    const sec = Number(v);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 60_000);

    // HTTP-date
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
    const jitter = Math.floor(Math.random() * 150); // 0~150ms
    const normal = exp + jitter;

    if (retryAfterMs > 0) return Math.max(retryAfterMs, normal);
    return normal;
}

function isRetryableHttpStatus(status) {
    return (
        status === 408 || // Request Timeout
        status === 425 || // Too Early
        status === 429 || // Too Many Requests
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

/* ──────────────────────────────────────────────────────────────
 * 6) Host 槽位限制：maxHosts（可重入，跨域 redirect 不死锁）
 * ────────────────────────────────────────────────────────────── */
class HostSlotLimiter {
    constructor(maxHosts) {
        this.maxHosts = Math.max(1, Number(maxHosts) || 1);
        this.activeCounts = new Map(); // origin -> count
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

/* ──────────────────────────────────────────────────────────────
 * 安全开关与档位
 * ────────────────────────────────────────────────────────────── */
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
        // 1 档：保留4项关键防护，其余7项关
        return {
            enableSSRFProtection: false, // 关：直接允许内网/NAS/localhost/保留网段下载（最宽松）
            enableUrlProtocolAndCredsGuard: true, // 开：仅允许 http/https + 禁止 URL credentials（几乎不影响正常下载，却能砍掉一堆奇怪协议攻击面）
            enableRedirectProtocolGuard: true, // 开：重定向协议限制（避免被30x引到file/data等危险协议）
            enableBaseDirGuard: false, // 关：destPath可写任意位置（最自由）
            enableDownloadLock: true, // 开：下载锁避免并发踩踏（稳定性保护，不是安全拦截）
            enableHeaderSanitize: true, // 开：Header注入清洗（兼容性影响极小，但能避免经典CRLF注入坑）
            enableContentLengthRangePrecheck: false, // 关：不会因为服务端length写错就提前拒绝（更少误杀）
            enableStrictResumeChecks: false, // 关：更倾向"能下就下"，不纠结206/压缩等严格条件
            enableSymlinkGuard: false, // 关：允许把结果写到symlink指向的位置（更符合一些用户习惯）
            enableProbeOutputLimit: false, // 关：playlist再大也尽量给你吐（更宽松）
            enableFailFast: false, // 关：遇到不确定尽量降级继续，少失败
        };
    }

    // 0 档：全关（最宽松）
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
    // 独立开关逐项覆写
    return { ...base, ...o };
}

/* ──────────────────────────────────────────────────────────────
 * SSRF 工具：判定 IP 是否为非公网（阻止内网/本机/保留）
 * ────────────────────────────────────────────────────────────── */
function ipv4ToInt(ip) {
    const parts = String(ip).split(".").map((x) => Number(x));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    // >>> 0 转无符号 32-bit
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

    // 常见应拦截：loopback / private / link-local / CGNAT / reserved / multicast / benchmark / doc
    const blocks = [
        ["0.0.0.0", 8],
        ["10.0.0.0", 8],
        ["127.0.0.0", 8],
        ["169.254.0.0", 16],
        ["172.16.0.0", 12],
        ["192.168.0.0", 16],
        ["100.64.0.0", 10], // CGNAT
        ["192.0.0.0", 24],
        ["192.0.2.0", 24], // TEST-NET-1
        ["198.18.0.0", 15], // benchmark
        ["198.51.100.0", 24], // TEST-NET-2
        ["203.0.113.0", 24], // TEST-NET-3
        ["224.0.0.0", 4], // multicast
        ["240.0.0.0", 4], // reserved
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

    // IPv4-mapped IPv6: ::ffff:192.168.0.1
    if (s.startsWith("::ffff:")) {
        const v4 = s.slice("::ffff:".length);
        // 有的可能是 ::ffff:0:192.168.0.1 之类，这里做一次兜底提取
        const last = v4.split(":").pop();
        if (last && net.isIP(last) === 4) return isNonPublicIPv4(last);
    }

    // loopback / unspecified
    if (s === "::1" || s === "::") return true;

    // link-local fe80::/10
    if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true;

    // unique local fc00::/7 (fc00, fd00)
    if (s.startsWith("fc") || s.startsWith("fd")) return true;

    // multicast ff00::/8
    if (s.startsWith("ff")) return true;

    // documentation 2001:db8::/32
    if (s.startsWith("2001:db8")) return true;

    return false;
}

function isNonPublicIp(ip) {
    const t = net.isIP(ip);
    if (t === 4) return isNonPublicIPv4(ip);
    if (t === 6) return isNonPublicIPv6(ip);
    return true; // 非法 IP 一律当作不安全
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

/* ──────────────────────────────────────────────────────────────
 * Header 清洗（CRLF/非法 name）
 * ────────────────────────────────────────────────────────────── */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function sanitizeHeaders(inputHeaders, failFast) {
    const out = {};
    const src = inputHeaders && typeof inputHeaders === "object" ? inputHeaders : {};
    for (const [k0, v0] of Object.entries(src)) {
        const k = String(k0 || "").trim();
        if (!k) continue;

        // 防 CRLF 注入 / 非法 header name
        if (k.includes("\r") || k.includes("\n") || !HEADER_NAME_RE.test(k)) {
            if (failFast) return { ok: false, error: "invalid_header_name" };
            continue;
        }

        // value 统一转 string，去掉 CRLF
        const v = Array.isArray(v0) ? v0.map((x) => String(x)) : [String(v0)];
        const vv = v.map((s) => s.replace(/[\r\n]+/g, " ").trim()).join(", ");
        if (!vv) continue;

        out[k.toLowerCase()] = vv;
    }
    return { ok: true, headers: out };
}

/* ──────────────────────────────────────────────────────────────
 * 目标路径安全（baseDir、symlink）
 * ────────────────────────────────────────────────────────────── */
function realAbs(p) {
    return path.resolve(String(p || ""));
}

function isPathInsideBaseDir(filePath, baseDir) {
    const absFile = realAbs(filePath);
    const absBase = realAbs(baseDir);
    if (!absBase.endsWith(path.sep)) {
        // 防止 /foo/barX 被误判为 /foo/bar 内
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

/* ──────────────────────────────────────────────────────────────
 * 下载锁（destPath.lock）避免并发踩踏
 * ────────────────────────────────────────────────────────────── */
async function acquireDownloadLock(destPath, opts) {
    const lockPath = String(destPath) + ".lock";
    const waitMs = Math.max(0, Number(opts?.downloadLockWaitMs ?? 15_000));
    const pollMs = Math.max(20, Number(opts?.downloadLockPollMs ?? 120));
    const staleMs = Math.max(0, Number(opts?.downloadLockStaleMs ?? 60_000));
    const start = Date.now();

    ensureDirForFile(lockPath);

    while (true) {
        // 尝试抢锁
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

            // 检查 stale
            try {
                const st = fs.statSync(lockPath);
                if (staleMs > 0 && Date.now() - st.mtimeMs > staleMs) {
                    // stale -> 强制清理
                    safeUnlink(lockPath);
                    // 立刻重试
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

/* ──────────────────────────────────────────────────────────────
 * Content-Range 解析与校验（基础）
 * ────────────────────────────────────────────────────────────── */
function parseContentRange(cr) {
    // e.g. "bytes 100-199/1000"
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

/* ──────────────────────────────────────────────────────────────
 * 7) SmartHttpDownloader：H2 优先 + H1 降级 + 重试 + 防盗链
 *    + 11 项安全开关
 * ────────────────────────────────────────────────────────────── */
class SmartHttpDownloader {
    constructor(config = {}) {
        // 安全开关（可被 config.securityOverrides 覆写）
        const securityLevel = config.securityLevel ?? 1;
        const securityOverrides = config.securityOverrides || null;
        this.security = mergeSecurityOptions(securityLevel, securityOverrides);

        this.config = {
            // 并发/连接
            maxHosts: 8,
            maxStreamsPerHost: 50, // H2 并发流（本地上限，仍受远端限制）
            maxStreamsPerHostH1: 4, // H1 每域名并发
            sessionTimeoutMs: 30_000,
            connectTimeoutMs: 5_000,
            requestTimeoutMs: 15_000,
            maxRedirects: 6,

            // 默认大小限制（task.maxBytes 可覆盖）
            maxBytesDefault: 200 * 1024 * 1024,

            // 重试
            maxAttempts: 4,
            maxTotalRetryDelayMs: 25_000,

            // H1 keep-alive
            keepAlive: true,

            // TLS 校验默认开启
            rejectUnauthorized: true,

            // 默认 headers（你可在 task.headers 覆盖）
            defaultHeaders: {},

            // H2 客户端 settings 提示（最终以对端为准）
            h2ClientSettings: null,

            // 安全相关参数
            baseDir: config.baseDir || null, // 用于 enableBaseDirGuard
            dnsTimeoutMs: config.dnsTimeoutMs ?? 3000,
            dnsCacheTtlMs: config.dnsCacheTtlMs ?? 60_000,

            // 下载锁参数
            downloadLockWaitMs: config.downloadLockWaitMs ?? 15_000,
            downloadLockPollMs: config.downloadLockPollMs ?? 120,
            downloadLockStaleMs: config.downloadLockStaleMs ?? 60_000,

            ...config,
        };

        this.pools = new Map(); // origin -> { session, h2Supported, lastUsed }
        this.hostLimiter = new HostSlotLimiter(this.config.maxHosts);

        this.httpAgent = new http.Agent({
            keepAlive: !!this.config.keepAlive,
            maxSockets: 256,
        });
        this.httpsAgent = new https.Agent({
            keepAlive: !!this.config.keepAlive,
            maxSockets: 256,
            rejectUnauthorized: this.config.rejectUnauthorized,
        });

        this._dnsCache = new Map(); // hostname -> { ts, addrs: string[] } or { ts, err: string }
    }

    async downloadAll(tasks, onProgress) {
        const results = [];
        if (!Array.isArray(tasks) || tasks.length === 0) {
            return { stats: this._emptyStats(), results };
        }

        // 按 origin 分组
        const byOrigin = new Map();
        for (const t of tasks) {
            try {
                const u = new URL(t.url);
                const origin = u.origin;

                // URL 协议+凭据限制（开关 2）
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

        // 并行处理各 origin（实际活跃数由 hostLimiter 控制）
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

        // 安全：baseDir/锁/基础路径校验
        const pre = this._validateTaskPaths(task);
        if (!pre.ok) {
            const r = this._resultFail(task, pre.error);
            onProgress && onProgress(task, { type: "error", attempt: 0, ...r });
            return r;
        }

        // 下载锁（开关 5）
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

        // 开关 2：仅允许 http/https + 禁止 URL credentials
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

        // 直接拦截本机域名
        if (isLocalHostname(hostname)) {
            return { ok: false, error: "ssrf_blocked_local_hostname" };
        }

        // IP literal
        const ipType = net.isIP(hostname);
        if (ipType === 4 || ipType === 6) {
            if (isNonPublicIp(hostname)) return { ok: false, error: "ssrf_blocked_ip_literal" };
            return { ok: true };
        }

        // DNS resolve（严格）
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

        // 开关 4：baseDir guard
        if (this.security.enableBaseDirGuard) {
            const baseDir = task.baseDir || this.config.baseDir;
            if (!baseDir) {
                if (failFast) return { ok: false, error: "baseDir_required" };
                // 中档/宽松：没 baseDir 就降级跳过（仍可能不安全，但符合“宽松”语义）
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

        // 开关 9：symlink guard（基础：dest/tmp 若为 symlink/非普通文件则拒绝）
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

        // 默认 headers
        const baseHeaders = {
            "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            accept: "image/*,video/*,*/*;q=0.8",
            "accept-encoding": "br, gzip, deflate",
            ...this.config.defaultHeaders,
            ...(task.headers || {}),
        };

        // 开关 6：Header sanitize
        let headers = baseHeaders;
        if (this.security.enableHeaderSanitize) {
            const sr = sanitizeHeaders(baseHeaders, failFast);
            if (!sr.ok) {
                // failFast: 直接失败；非 failFast：退回最小头（避免注入）
                if (failFast) return { ok: false, error: sr.error };
                headers = {
                    "user-agent": String(baseHeaders["user-agent"] || baseHeaders["User-Agent"] || "Mozilla/5.0"),
                    accept: String(baseHeaders.accept || "image/*,video/*,*/*;q=0.8"),
                };
            } else {
                headers = sr.headers;
            }
        }

        // Range / 续传
        if (resumeBytes > 0) {
            headers["range"] = `bytes=${resumeBytes}-`;
            headers["accept-encoding"] = "identity";
        }

        // 防盗链 boost
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

        // URL 基础校验（开关 2）
        let urlObj;
        try {
            urlObj = new URL(task.url);
        } catch {
            return this._resultFail(task, "invalid_url");
        }
        const vb = this._validateUrlBasic(urlObj);
        if (!vb.ok) return this._resultFail(task, vb.error);

        // SSRF（开关 1）
        const ss = await this._validateUrlSSRF(urlObj);
        if (!ss.ok) return this._resultFail(task, ss.error);

        // session 可用性
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

        // symlink guard（开关 9）：写之前再查一次（降低 TOCTOU）
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

                // redirect
                if (status >= 300 && status < 400 && h.location) {
                    try {
                        req.close();
                    } catch { }
                    safeUnlink(tmpPath);

                    const newUrl = new URL(String(h.location), task.url).toString();

                    // 开关 3：redirect 协议限制
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

                // 非 2xx
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

                // 续传校验（开关 8：严格续传；开关 7：range/content-range 预检）
                let resumeMode = willResume;
                if (resumeMode) {
                    const contentEncoding = h["content-encoding"];

                    const wantStrict = !!this.security.enableStrictResumeChecks;

                    if (wantStrict) {
                        // 严格：必须 206
                        if (status !== 206) {
                            try { req.close(); } catch { }
                            safeUnlink(tmpPath);
                            const r = this._resultFail(task, "resume_not_supported");
                            r.httpStatus = status;
                            finish(r);
                            return;
                        }
                        // 严格：Range + content-encoding 必须 identity
                        if (contentEncoding && String(contentEncoding).toLowerCase() !== "identity") {
                            try { req.close(); } catch { }
                            safeUnlink(tmpPath);
                            const r = this._resultFail(task, "resume_with_encoding_unsupported");
                            r.httpStatus = status;
                            finish(r);
                            return;
                        }
                        // 严格：若启用预检，则 content-range 必须匹配
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
                        // 宽松：不满足续传条件就“重下”（安全但更兼容）
                        const bad206 = status !== 206;
                        const badEnc = contentEncoding && String(contentEncoding).toLowerCase() !== "identity";
                        let badRange = false;
                        if (this.security.enableContentLengthRangePrecheck) {
                            const cr = parseContentRange(h["content-range"]);
                            badRange = !cr || cr.start !== resumeBytes;
                        }
                        if (bad206 || badEnc || badRange) {
                            // 关闭当前请求，删 part，重试一次“全量请求”（本 attempt 内完成）
                            try { req.close(); } catch { }
                            safeUnlink(tmpPath);
                            const rr = await this._attemptH2(
                                ctx,
                                { ...task }, // 不带 resumeInfo（会当作不续传）
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

                // 开关 7：content-length 预检（仅在无 decoder/或 failFast 情况下更严格）
                if (this.security.enableContentLengthRangePrecheck) {
                    const decoder = resumeMode ? null : pickDecoder(contentEncoding);
                    // 如果有 decoder，content-length 是压缩后字节数，不等于输出字节数；
                    // 这里为了“不误杀”，只在无 decoder 时用声明长度做硬拦截
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

                // 写入（symlink guard 已做；这里直接写）
                const out = fs.createWriteStream(tmpPath, { flags: resumeMode ? "a" : "w" });

                try {
                    if (decoder) await pipelineAsync(req, decoder, limiter, out);
                    else await pipelineAsync(req, limiter, out);

                    // rename 前再做一次 destPath symlink guard（开关 9）
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

        // URL 基础校验（开关 2）
        const vb = this._validateUrlBasic(urlObj);
        if (!vb.ok) return this._resultFail(task, vb.error);

        // SSRF（开关 1）
        const ss = await this._validateUrlSSRF(urlObj);
        if (!ss.ok) return this._resultFail(task, ss.error);

        const client = urlObj.protocol === "https:" ? https : http;
        const agent = urlObj.protocol === "https:" ? this.httpsAgent : this.httpAgent;

        const destPath = task.destPath;
        const maxBytes = Number(task.maxBytes ?? this.config.maxBytesDefault) || this.config.maxBytesDefault;

        const { tmpPath, resumeBytes, canResume } = resumeInfo || {};
        const willResume = canResume && resumeBytes > 0;

        ensureDirForFile(tmpPath);

        // symlink guard（开关 9）
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
                // redirect
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.destroy();
                    safeUnlink(tmpPath);

                    const newUrl = new URL(res.headers.location, task.url).toString();

                    // 开关 3：redirect 协议限制
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

                // 非 2xx
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.destroy();
                    const r = this._resultFail(task, `http_${res.statusCode}`);
                    r.httpStatus = res.statusCode;
                    r.retryAfter = res.headers["retry-after"];
                    resolve(r);
                    return;
                }

                // 续传校验（开关 8/7）
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
                            // 宽松：重下（本 attempt 内完成）
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

                // 开关 7：content-length 预检（无 decoder 时硬拦截）
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

                    // rename 前 destPath symlink guard（开关 9）
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

        // 开关 2：协议/凭据限制
        const vb = this._validateUrlBasic(u);
        if (!vb.ok) return this._resultFail(task, vb.error);

        // 开关 3：redirect 协议限制（这里虽然是 universal，但仍可以挡非 http/https）
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

/* ──────────────────────────────────────────────────────────────
 * 8) yt-dlp：平台/HLS/DASH 视频下载（扩展不打包，只探测调用）
 *    + probe stdout/stderr 限制（开关 10）
 * ────────────────────────────────────────────────────────────── */
class YtDlpDownloader {
    constructor(options = {}) {
        const securityLevel = options.securityLevel ?? 1;
        const securityOverrides = options.securityOverrides || null;
        this.security = mergeSecurityOptions(securityLevel, securityOverrides);

        this.ytdlpPath = options.ytdlpPath || null;
        this.ffmpegPath = options.ffmpegPath || null;

        // probe 输出限制参数
        this.maxProbeStdoutBytes = Math.max(0, Number(options.maxProbeStdoutBytes ?? 10 * 1024 * 1024)); // 10MB
        this.maxProbeStderrBytes = Math.max(0, Number(options.maxProbeStderrBytes ?? 1 * 1024 * 1024)); // 1MB

        // 1) 优先用户传入 / PATH
        if (!this.ytdlpPath) this.ytdlpPath = findExecutableInPath("yt-dlp");

        // 2) GUI/Electron 常见：PATH 不全，尝试常见绝对路径
        if (!this.ytdlpPath && process.platform !== "win32") {
            this.ytdlpPath = findExecutableInCommonPaths("yt-dlp");
        }

        // 3) ffmpeg 同类增强
        if (!this.ffmpegPath) this.ffmpegPath = findExecutableInPath("ffmpeg");
        if (!this.ffmpegPath && process.platform !== "win32") {
            this.ffmpegPath = findExecutableInCommonPaths("ffmpeg");
        }
    }

    isAvailable() {
        if (!this.ytdlpPath) return false;
        try {
            // 简单的存在性检查
            if (!require('fs').existsSync(this.ytdlpPath)) return false;
            // 尝试执行一次 version 检查确保可用
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
    async probe(url) {
        if (!this.isAvailable()) {
            return { success: false, error: "yt-dlp_not_installed_or_invalid" };
        }

        return new Promise((resolve) => {
            // 构造参数：模拟浏览器，忽略错误，不下载，dump json
            const args = [
                "--dump-json",
                "--no-download",
                "--no-warnings",
                "--ignore-errors", // 忽略个别视频错误
                "--flat-playlist", // 快速列表探测
                "--no-check-certificate", // 忽略 SSL 错误
                "--extractor-args", "generic:impersonate", // 绕过 Cloudflare 反爬虫
                // 尝试模拟浏览器环境以提高嗅探成功率
                "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                url,
            ];

            // 第一次尝试：普通探测
            const doProbe = (extraArgs = []) => {
                return new Promise((resolveProbe) => {
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

                        // 单视频
                        if (parsed.length === 1 && !parsed[0]._type && !parsed[0].entries) {
                            const info = parsed[0];
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
                                // 透传成功的 cookieSource (如果有)
                                cookieSource: extraArgs.includes("chrome") ? "chrome" :
                                    extraArgs.includes("edge") ? "edge" :
                                        extraArgs.includes("firefox") ? "firefox" : null
                            });
                            return;
                        }

                        // 列表
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
                                original: e
                            })),
                        });
                    });

                    proc.on("error", (e) => resolveProbe({ success: false, error: e.message }));
                });
            };

            doProbe().then(res => {
                // 如果第一次失败，且看起来是 403/ExtractorError，尝试带上浏览器 Cookie 重试
                // 这能模拟 VDH 的“在浏览器中嗅探”的效果
                if (!res.success && (
                    res.error?.includes("403") ||
                    res.error?.includes("401") ||
                    res.error?.includes("Unable to extract") ||
                    res.error?.includes("Sign in") ||
                    res.error?.includes("Unsupported URL")
                )) {
                    // 尝试使用 chrome cookies (Windows 常见)
                    // 注意：这可能会稍微慢一点，但在失败时值得一试
                    return doProbe(["--cookies-from-browser", "chrome"]).then(res2 => {
                        if (res2.success) return res2;
                        // 如果 Chrome 也不行，尝试 Edge
                        return doProbe(["--cookies-from-browser", "edge"]).then(res3 => {
                            return res3.success ? res3 : res; // 如果都失败，返回第一次的错误（通常更直观）
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

        // 如果外部指定了 referer，优先使用
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
                    "--merge-output-format",
                    "mp4",
                    "-f",
                    fmt,
                    "--no-check-certificate",
                    "--no-cache-dir",
                    "--extractor-args", "generic:impersonate", // 绕过 Cloudflare 反爬虫
                    "--referer", referer, // 使用修正后的 referer
                    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    ...extraArgs
                ];

                if (this.ffmpegPath) {
                    args.unshift("--ffmpeg-location", this.ffmpegPath);
                }

                if (options.rateLimit) {
                    args.push("-r", String(options.rateLimit));
                }

                args.push(url);

                const proc = spawn(this.ytdlpPath, args, { windowsHide: true });

                let stderr = "";

                const onLine = (line) => {
                    const m = String(line).match(/(\d+(\.\d+)?)%/);
                    if (m && options.onProgress) options.onProgress(parseFloat(m[1]));
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
                        // 提取详细错误
                        let errorMsg = `exit_code_${code}`;
                        const stderrStr = String(stderr || "").trim();
                        if (stderrStr) {
                            const errorMatch = stderrStr.match(/ERROR:\s*(.*)/);
                            if (errorMatch && errorMatch[1]) {
                                errorMsg = errorMatch[1].trim();
                            } else {
                                // 取最后几行非空日志作为错误信息
                                const lines = stderrStr.split('\n').map(l => l.trim()).filter(Boolean);
                                // 过滤掉进度条等无用信息
                                const errLines = lines.filter(l => !l.startsWith('[download]') && !l.match(/^\d+%|ETA/));
                                if (errLines.length > 0) {
                                    errorMsg = errLines.slice(-1)[0]; // 取最后一行
                                }
                            }
                        }
                        resolve({ success: false, error: errorMsg, code });
                    }
                });

                proc.on("error", (e) => resolve({ success: false, error: e.message }));
            });
        };

        // 策略优化：如果明确指定了 cookieSource，直接使用它，不做无用的首次尝试
        if (options.cookieSource) {
            const cs = options.cookieSource.toLowerCase();
            if (cs === 'chrome' || cs === 'edge' || cs === 'firefox') {
                return await runDownload(["--cookies-from-browser", cs]);
            }
        }

        // 首次尝试 (默认无 Cookie)
        let res = await runDownload();

        // 如果失败且看起来是权限/解析问题，尝试带 Cookie 重试
        if (!res.success && (
            res.error?.includes("403") ||
            res.error?.includes("401") ||
            res.error?.includes("Unable to extract") ||
            res.error?.includes("Sign in") ||
            res.error?.includes("exit_code") // 宽容策略：只要失败就尝试一次 Cookie，反正用户已经在浏览器里打开了
        )) {
            // 1. Chrome
            const resChrome = await runDownload(["--cookies-from-browser", "chrome"]);
            if (resChrome.success) return resChrome;

            // 2. Edge
            const resEdge = await runDownload(["--cookies-from-browser", "edge"]);
            if (resEdge.success) return resEdge;

            // 3. Firefox (VDH 用户很多是用 Firefox)
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

            // 确定yt-dlp下载URL和文件名
            let downloadUrl;
            let binaryName;

            if (platform === 'win32') {
                // Windows
                binaryName = 'yt-dlp.exe';
                downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
            } else if (platform === 'darwin') {
                // macOS
                binaryName = 'yt-dlp';
                downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
            } else {
                // Linux和其他类Unix系统
                binaryName = 'yt-dlp';
                downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
            }

            // 确定安装路径 - 使用扩展的全局存储路径
            const installDir = context.globalStorageUri.fsPath;
            const installPath = path.join(installDir, binaryName);

            // 确保安装目录存在
            if (!fs.existsSync(installDir)) {
                fs.mkdirSync(installDir, { recursive: true });
            }

            // 检查文件是否已存在且非空
            if (fs.existsSync(installPath) && fs.statSync(installPath).size > 0) {
                this.ytdlpPath = installPath;
                return { success: true, path: installPath };
            }

            // 使用https模块下载yt-dlp，支持重定向
            await new Promise((resolve, reject) => {
                const downloadFile = (url, redirectCount = 0) => {
                    if (redirectCount > 5) {
                        reject(new Error('Too many redirects'));
                        return;
                    }

                    const urlObj = new URL(url);
                    const options = {
                        hostname: urlObj.hostname,
                        path: urlObj.pathname + urlObj.search,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36', // 保持下载器的 UA，不影响 yt-dlp
                            'Accept': '*/*',
                            'Accept-Encoding': 'identity', // 禁止压缩，简化处理
                            'Connection': 'keep-alive'
                        },
                        timeout: 30000
                    };

                    const req = https.get(options, (res) => {
                        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) {
                            const location = res.headers.location;
                            if (location) {
                                // 处理相对路径重定向
                                const nextUrl = new URL(location, url).href;
                                downloadFile(nextUrl, redirectCount + 1);
                            } else {
                                reject(new Error(`Redirect without location header (status: ${res.statusCode})`));
                            }
                            // 消耗响应流
                            res.resume();
                            return;
                        }

                        if (res.statusCode === 200) {
                            const file = fs.createWriteStream(installPath);
                            res.pipe(file);

                            file.on('finish', () => {
                                file.close(() => {
                                    // 再次验证文件大小
                                    try {
                                        const stats = fs.statSync(installPath);
                                        if (stats.size > 0) {
                                            resolve();
                                        } else {
                                            fs.unlinkSync(installPath);
                                            reject(new Error('Downloaded file is empty'));
                                        }
                                    } catch (e) {
                                        reject(e);
                                    }
                                });
                            });

                            file.on('error', (err) => {
                                fs.unlink(installPath, () => { }); // 尝试删除
                                reject(err);
                            });
                        } else {
                            res.resume();
                            reject(new Error(`Download failed with status code: ${res.statusCode}`));
                        }
                    });

                    req.on('error', (err) => {
                        reject(err);
                    });

                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Download timeout'));
                    });
                };

                downloadFile(downloadUrl);
            });

            // 如果是Unix系统，需要设置可执行权限
            if (platform !== 'win32') {
                fs.chmodSync(installPath, '755');
            }

            // 更新路径
            this.ytdlpPath = installPath;
            return { success: true, path: installPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

/* ──────────────────────────────────────────────────────────────
 * 9) UnifiedMediaDownloader：对外极简接口 + 最佳默认策略
 * ────────────────────────────────────────────────────────────── */
class UnifiedMediaDownloader {
    constructor(options = {}) {
        // 档位与安全开关覆写
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

        this.options = {
            downloadVideos: options.downloadVideos || "direct-only",
            ytdlpConcurrency: Math.max(1, Number(options.ytdlpConcurrency) || 1),
            maxBytesImage: options.maxBytesImage ?? 20 * 1024 * 1024,
            maxBytesDirectVideo: options.maxBytesDirectVideo ?? 200 * 1024 * 1024,

            // 安全档位
            securityLevel,
            securityOverrides,

            // baseDir（给 normalizeTasks 或外部约束）
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
                    // 透传元数据
                    cookieSource: t.meta?.cookieSource,
                    referer: t.meta?.referer,
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

    async ensureYtdlpReady(context) {
        // 先尝试从 context 加载（避免重复下载）
        if (context && this.ytdlp.trySetFromGlobalStorage(context)) {
            if (this.ytdlp.isAvailable()) return true;
        }

        if (!this.ytdlp.isAvailable()) {
            if (!vscode) return false;
            const installConfirmed = await vscode.window.showInformationMessage(
                "yt-dlp 未安装，是否自动下载安装？",
                { modal: true },
                "是",
                "否"
            );

            if (installConfirmed === "是") {
                return await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "正在安装 yt-dlp...",
                    cancellable: false
                }, async (progress) => {
                    progress.report({ message: "正在下载...", increment: 10 });
                    const res = await this.ytdlp.autoInstall(context);
                    if (res.success) {
                        vscode.window.showInformationMessage("yt-dlp 安装成功");
                        return true;
                    } else {
                        vscode.window.showErrorMessage(`yt-dlp 安装失败: ${res.error}`);
                        return false;
                    }
                });
            } else {
                vscode.window.showWarningMessage("yt-dlp 未安装，无法下载平台视频。请安装 yt-dlp 后重试。");
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
                // 关键修正：从 video 对象中提取并传递元数据
                // VideoDownloadController 里的 _normalizeProbeResult 会把 _meta 放在 video._meta 或 video 对象本身
                meta: video._meta || video.meta
            };
        });

        const downloadResult = await this.downloadAll(downloadTasks, targetDir, {
            downloadVideos: "all", // 显式允许下载平台视频
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

        const successfulDownloads = downloadResult.results.filter(r => r.success);
        const failedDownloads = downloadResult.results.filter(r => !r.success);

        if (vscode) {
            if (successfulDownloads.length > 0) {
                vscode.window.showInformationMessage(
                    `成功下载 ${successfulDownloads.length} 个视频，失败 ${failedDownloads.length} 个`
                );
            } else if (failedDownloads.length > 0) {
                vscode.window.showErrorMessage(
                    `所有视频下载失败: ${failedDownloads.map(f => f.error).join(', ')}`
                );
            }
        }

        if (progress) progress.report({ increment: 100 });
        return downloadResult;
    }
}

/* ──────────────────────────────────────────────────────────────
 * 10) 状态回写辅助函数（Mutation Helper）
 * ────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────
 * 11) 单例/工厂模式（共享 H2 连接复用）
 * ────────────────────────────────────────────────────────────── */
let globalInstance = null;

function getSharedDownloader(options = {}) {
    if (!globalInstance) {
        globalInstance = new UnifiedMediaDownloader(options);
    }
    return globalInstance;
}

/* ──────────────────────────────────────────────────────────────
 * exports
 * ────────────────────────────────────────────────────────────── */
module.exports = {
    UnifiedMediaDownloader,
    SmartHttpDownloader,
    YtDlpDownloader,

    // 工具
    runPool,
    findExecutableInPath,
    isPlatformOrSegmentVideo,
    isBlobUrl,
    generateFilename,

    // 新增导出
    applyResultsToItems,
    getSharedDownloader,

    // 安全档位/开关工具
    resolveSecurityProfile,
    mergeSecurityOptions,
};

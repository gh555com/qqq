
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const global = require('./global');

// ★ 终极最优解：全局实例追踪，用于生命周期强杀
let _currentHistoryManager = null;
let _currentSidebarProvider = null;  // ★ 新增：跟踪当前侧边栏实例
const zlib = require('zlib');
const { performance } = require('perf_hooks');

// ============================================================================
// 常量
// ============================================================================
const AUDIO_SOURCE = {
    DETECTING: 'DETECTING',
    PYTHON: 'PYTHON',
    WEBVIEW: 'WEBVIEW'
};

const CONSTANTS = Object.freeze({
    VERSION: 4,

    // SVG Spacers
    SPACER_5_BASE64: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNSIgaGVpZ2h0PSIxIj48L3N2Zz4=',

    // 存储
    STORAGE_DIR: 'clipboard-history',
    FILE_BIN_GZ: 'history.bin.gz',

    // 限制
    MAX_HISTORY_ITEMS: 2000,
    CLEANUP_BATCH_SIZE: 1000,
    UI_HISTORY_LIMIT: 30,
    MAX_CONTENT_LENGTH: 100000,
    PREVIEW_LENGTH: 200,

    // 监听
    CLIPBOARD_POLL_MS: 1000,
    SIDEBAR_UPDATE_MS: 5000,

    // 保存（批处理 + 节流 + 串行写入）
    BATCH_SAVE_THRESHOLD: 5,
    SAVE_THROTTLE_MS: 1000,
    SAVE_RETRY_DELAY_MS: 120,

    // 原子写
    SAVE_TEMP_SUFFIX: '.tmp',

    // 损坏隔离
    CORRUPT_SUFFIX_PREFIX: '.corrupt-',

    // watchdog
    WATCHDOG_REFRESH_MS: 30000,
    WATCHDOG_STALE_MS: 15000,

    // 时间
    MS_PER_MINUTE: 60000,
    MS_PER_HOUR: 3600000,
    MS_PER_DAY: 86400000,
});

// ============================================================================
// 正则
// ============================================================================
const REGEX = Object.freeze({
    WHITESPACE_ONLY: /^\s*$/,
    WHITESPACE_COLLAPSE: /\s+/g,
    HTML_ESCAPE: /[&<>"']/g,
});

// ============================================================================
// HTML escape（仅用于 attribute 字符串拼接）
// ============================================================================
const HTML_ESCAPE_MAP = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
});
function escapeHtmlAttr(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(REGEX.HTML_ESCAPE, (ch) => HTML_ESCAPE_MAP[ch] || ch);
}

// ============================================================================
// msgpack（可选）惰性加载
// ============================================================================
let _msgpack = null;
let _msgpackLoaded = false;
function getMsgpack() {
    if (_msgpackLoaded) return _msgpack;
    _msgpackLoaded = true;
    try {
        _msgpack = require('msgpack-lite');
    } catch (e) {
        console.error('[Q4] 严重错误：无法加载 msgpack-lite 依赖', e.message);
        _msgpack = null;
    }
    return _msgpack;
}

// ============================================================================
// 工具函数
// ============================================================================
function _bytesToHex(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, '0');
    return out;
}

function _safeRandomBytes(n) {
    try {
        if (crypto && typeof crypto.randomBytes === 'function') {
            return crypto.randomBytes(n);
        }
    } catch { /* ignore */ }

    // WebCrypto / 浏览器环境
    try {
        const c = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
        if (c && typeof c.getRandomValues === 'function') {
            const u8 = new Uint8Array(n);
            c.getRandomValues(u8);
            return u8;
        }
    } catch { /* ignore */ }

    // 兜底（不加密强度）：仅用于非安全用途
    const u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = Math.floor(Math.random() * 256);
    return u8;
}

function randomId() {
    try {
        if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch { /* ignore */ }
    return _bytesToHex(_safeRandomBytes(16));
}

// 纯 JS 的 MD5（bytes -> hex），用于没有 crypto.createHash 的运行环境
function _md5BytesToHex(input) {
    const bytes = (input instanceof Uint8Array) ? input : new Uint8Array(input);

    // 32-bit left rotate
    const rol = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

    // 常量 K[i] = floor(abs(sin(i+1)) * 2^32)
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

    // r shift amounts
    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];

    // padding
    const origLen = bytes.length;
    const bitLen = origLen * 8;

    // new length: ((len + 8) padded to 56 mod 64) + 8
    let newLen = origLen + 1;
    while ((newLen % 64) !== 56) newLen++;
    const buf = new Uint8Array(newLen + 8);
    buf.set(bytes);
    buf[origLen] = 0x80;

    // append bit length (little-endian 64-bit)
    for (let i = 0; i < 8; i++) buf[newLen + i] = (bitLen >>> (8 * i)) & 0xFF;

    let a0 = 0x67452301 >>> 0;
    let b0 = 0xefcdab89 >>> 0;
    let c0 = 0x98badcfe >>> 0;
    let d0 = 0x10325476 >>> 0;

    const M = new Uint32Array(16);

    for (let offset = 0; offset < buf.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            M[i] = (buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24)) >>> 0;
        }

        let A = a0, B = b0, C = c0, D = d0;

        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16) {
                F = (B & C) | (~B & D);
                g = i;
            } else if (i < 32) {
                F = (D & B) | (~D & C);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                F = B ^ C ^ D;
                g = (3 * i + 5) % 16;
            } else {
                F = C ^ (B | ~D);
                g = (7 * i) % 16;
            }
            const tmp = D;
            D = C;
            C = B;
            const sum = (A + F + K[i] + M[g]) >>> 0;
            B = (B + rol(sum, S[i])) >>> 0;
            A = tmp;
        }

        a0 = (a0 + A) >>> 0;
        b0 = (b0 + B) >>> 0;
        c0 = (c0 + C) >>> 0;
        d0 = (d0 + D) >>> 0;
    }

    // output little-endian a0,b0,c0,d0
    const out = new Uint8Array(16);
    const words = [a0, b0, c0, d0];
    for (let i = 0; i < 4; i++) {
        const w = words[i];
        out[i * 4 + 0] = w & 0xFF;
        out[i * 4 + 1] = (w >>> 8) & 0xFF;
        out[i * 4 + 2] = (w >>> 16) & 0xFF;
        out[i * 4 + 3] = (w >>> 24) & 0xFF;
    }
    return _bytesToHex(out);
}

function md5Hex(s) {
    const str = String(s);

    // Node 环境：优先用 createHash（最快、兼容 Buffer）
    try {
        if (crypto && typeof crypto.createHash === 'function' && typeof Buffer !== 'undefined') {
            return crypto.createHash('md5').update(Buffer.from(str, 'utf8')).digest('hex');
        }
    } catch { /* ignore */ }

    // fallback：纯 JS MD5
    let bytes;
    if (typeof TextEncoder !== 'undefined') {
        bytes = new TextEncoder().encode(str);
    } else if (typeof Buffer !== 'undefined') {
        bytes = Buffer.from(str, 'utf8');
    } else {
        const arr = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xFF;
        bytes = arr;
    }
    return _md5BytesToHex(bytes);
}

function nonceHex() {
    return _bytesToHex(_safeRandomBytes(16));
}
function clampInt(n, min, max) {
    const x = Number.isFinite(n) ? Math.trunc(n) : min;
    return Math.min(max, Math.max(min, x));
}
function gzipAsync(buf) {
    if (zlib.promises?.gzip) return zlib.promises.gzip(buf);
    return new Promise((resolve, reject) => zlib.gzip(buf, (err, out) => (err ? reject(err) : resolve(out))));
}
function gunzipAsync(buf) {
    if (zlib.promises?.gunzip) return zlib.promises.gunzip(buf);
    return new Promise((resolve, reject) => zlib.gunzip(buf, (err, out) => (err ? reject(err) : resolve(out))));
}
function estimateBytes(obj) {
    try {
        const mp = getMsgpack();
        if (mp) return mp.encode(obj).length;
        return 0; // Msgpack 缺失时，不再尝试 JSON 估算
    } catch {
        return 0;
    }
}
function makePreview(content, maxLen = CONSTANTS.PREVIEW_LENGTH) {
    if (!content) return '';
    let s = String(content).trim().replace(REGEX.WHITESPACE_COLLAPSE, ' ');
    if (s.length > maxLen) s = s.slice(0, maxLen) + '...';
    return s;
}
function formatTime(timestamp) {
    const now = Date.now();
    const t = Number(timestamp) || now;
    const diff = now - t;

    if (diff < CONSTANTS.MS_PER_MINUTE) return `${Math.floor(diff / 1000)}秒前`;
    if (diff < CONSTANTS.MS_PER_HOUR) return `${Math.floor(diff / CONSTANTS.MS_PER_MINUTE)}分钟前`;
    if (diff < CONSTANTS.MS_PER_DAY) return `${Math.floor(diff / CONSTANTS.MS_PER_HOUR)}小时前`;
    if (diff < 7 * CONSTANTS.MS_PER_DAY) return `${Math.floor(diff / CONSTANTS.MS_PER_DAY)}天前`;
    return new Intl.DateTimeFormat('zh-CN').format(new Date(t));
}

// ============================================================================
// 双向链表节点 typedef
// ============================================================================
/**
 * @typedef {Object} HistoryNode
 * @property {string} id
 * @property {string} content
 * @property {number} timestamp
 * @property {string} type
 * @property {string} preview
 * @property {number} contentLength
 * @property {string} hash
 * @property {HistoryNode|null} prev
 * @property {HistoryNode|null} next
 */

// ============================================================================
// ClipboardHistoryManager - O(1) 双向链表 + 物理隔离版本
// ============================================================================
class ClipboardHistoryManager {
    constructor(context, opts = {}) {
        this.context = context;
        this._head = null;
        this._tail = null;
        this._size = 0;
        this._idMap = new Map();   // id -> node
        this._hashMap = new Map(); // hash -> node

        this._version = 0;
        this._snapshotVersion = -1;
        this._snapshotAll = null;

        this._cache = {
            version: -1,
            uiList: null,
            uiBytes: 0,
            lastUiKey: '', // 新增：用于跟踪 limit 变化
            lastSearchKey: '',
            searchList: null,
            searchBytes: 0,
            hit: 0,
            miss: 0,
            maxBytes: 25 * 1048576,
        };

        this._storageDir = null;
        this._fileBinGz = null;
        this._preferMsgpack = !!getMsgpack();

        this._saveChain = Promise.resolve();
        this._saveTimer = null;
        this._dirty = false;

        this._clipboardTimer = null;
        this._isWatching = false;
        this._watcherBusy = false;
        this._lastClipboardContent = '';

        this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

        this.perfStats = {
            saveTimeMs: 0, loadTimeMs: 0, addTimeMs: 0,
            operations: 0, quarantinedFiles: 0,
        };
        this.sessionStartedAt = Date.now();

        this._initStorage();
        this._loadHistory().catch(() => { });
    }

    // ★ 新增：管理命令历史
    async addCommandToHistory(key, value) {
        if (!key || !value || !this.context.globalState) return;
        const fullKey = `q4_${key}_history`;
        let history = this.context.globalState.get(fullKey, []);

        // 去重并移动到最前
        const existingIndex = history.indexOf(value);
        if (existingIndex > -1) {
            history.splice(existingIndex, 1);
        }

        // 添加到开头
        history.unshift(value);

        // 限制最近 5 条
        const trimmedHistory = history.slice(0, 5);

        await this.context.globalState.update(fullKey, trimmedHistory);
    }

    // ★ 新增：获取命令历史
    async getCommandHistory(key) {
        if (!key || !this.context.globalState) return [];
        const fullKey = `q4_${key}_history`;
        return this.context.globalState.get(fullKey, []);
    }

    _initStorage() {
        try {
            const root = this.context.globalStorageUri?.fsPath;
            if (!root) return;
            this._storageDir = path.join(root, CONSTANTS.STORAGE_DIR);
            if (!fs.existsSync(this._storageDir)) fs.mkdirSync(this._storageDir, { recursive: true });
            this._fileBinGz = path.join(this._storageDir, CONSTANTS.FILE_BIN_GZ);

            // ★ 终极自愈预警：如果发现 history.json.gz (旧版遗留)，将其迁移或清理（可选，此处暂保持纯净）
        } catch { }
    }

    async _loadHistory() {
        if (!this._fileBinGz || !fs.existsSync(this._fileBinGz)) return;
        const t0 = performance.now();
        try {
            const dataBuf = await fs.promises.readFile(this._fileBinGz);

            // 1. 解压 Gzip
            const raw = await gunzipAsync(dataBuf);

            // 2. 长度预检
            if (!raw || raw.length === 0) {
                this._resetInMemory();
                return;
            }

            // 3. 唯一来源：Msgpack 解码
            const mp = getMsgpack();
            if (!mp) throw new Error('Msgpack 引擎不可用');

            const parsed = mp.decode(raw);
            if (!parsed || (!Array.isArray(parsed) && !Array.isArray(parsed.history))) {
                throw new Error('无效的二进制存储格式');
            }

            const historyArr = Array.isArray(parsed) ? parsed : parsed.history;
            this._resetInMemory();

            // 逆序插入链表
            historyArr.slice().reverse().forEach(it => {
                if (!it.content) return;
                const node = {
                    ...it,
                    id: it.id || randomId(),
                    hash: it.hash || md5Hex(it.content),
                    preview: it.preview || makePreview(it.content),
                    size: it.size || Buffer.byteLength(it.content, 'utf8'),
                    pinned: !!it.pinned,
                    pinTimestamp: it.pinTimestamp || 0,
                    prev: null, next: null
                };
                if (!this._hashMap.has(node.hash)) {
                    this._insertHead(node);
                    this._idMap.set(node.id, node);
                    this._hashMap.set(node.hash, node);
                }
            });

            while (this._size > CONSTANTS.MAX_HISTORY_ITEMS) this._popTail();
            this._touch();
            this._notifyChange();
        } catch (e) {
            console.error('[Q4] 二进制加载失败，执行隔离:', e.message);
            await this._quarantineCorruptFile(this._fileBinGz);
        } finally {
            this.perfStats.loadTimeMs += (performance.now() - t0);
            this.perfStats.operations++;
        }
    }

    _touch() {
        this._version++;
        this._snapshotVersion = -1;
        this._snapshotAll = null;
        this._cache.version = -1;
        this._cache.uiList = null;
        this._cache.uiBytes = 0;
        this._cache.lastUiKey = '';
        this._cache.searchList = null;
        this._cache.searchBytes = 0;
        this._cache.lastSearchKey = '';
    }

    // 边界保护工具：确保数值在合理范围内，防止异常数据污染统计
    _clampStat(val, min, max) {
        if (typeof val !== 'number' || isNaN(val)) return min;
        return Math.max(min, Math.min(max, val));
    }

    _resetInMemory() {
        this._head = null; this._tail = null; this._size = 0;
        this._idMap.clear(); this._hashMap.clear();
        this._lastClipboardContent = '';
        this._touch();
    }

    _insertHead(node) {
        node.prev = null;
        node.next = this._head;
        if (this._head) this._head.prev = node;
        this._head = node;
        if (!this._tail) this._tail = node;
        this._size++;
    }

    _removeNode(node) {
        if (!node) return;
        const { prev, next } = node;
        if (prev) prev.next = next;
        if (next) next.prev = prev;
        if (this._head === node) this._head = next;
        if (this._tail === node) this._tail = prev;
        node.prev = null; node.next = null;
        this._size--;
        this._idMap.delete(node.id);
        this._hashMap.delete(node.hash);
    }

    _moveToHead(node) {
        if (!node || this._head === node) return;
        const { prev, next } = node;
        if (prev) prev.next = next;
        if (next) next.prev = prev;
        if (this._tail === node) this._tail = prev;
        node.prev = null;
        node.next = this._head;
        if (this._head) this._head.prev = node;
        this._head = node;
    }

    _popTail() {
        if (!this._tail) return null;
        const node = this._tail;
        this._removeNode(node);
        return node;
    }

    _toArrayAll() {
        if (this._snapshotAll && this._snapshotVersion === this._version) return this._snapshotAll;
        const arr = [];
        let cur = this._head;
        while (cur) {
            arr.push({
                id: cur.id,
                content: cur.content,
                timestamp: cur.timestamp,
                preview: cur.preview,
                size: cur.size || 0,
                pinned: !!cur.pinned,
                pinTimestamp: cur.pinTimestamp || 0,
                hash: cur.hash
            });
            cur = cur.next;
        }
        this._snapshotAll = arr;
        this._snapshotVersion = this._version;
        return arr;
    }

    getHistory(limit = CONSTANTS.UI_HISTORY_LIMIT) {
        const cacheKey = `${this._version}|${limit}`;
        if (this._cache.uiList && this._cache.lastUiKey === cacheKey) {
            this._cache.hit++;
            return this._cache.uiList;
        }
        this._cache.miss++;

        const pinned = [];
        const others = [];
        let cur = this._head;
        while (cur) {
            const item = {
                id: cur.id,
                content: cur.content,
                timestamp: cur.timestamp,
                preview: cur.preview,
                size: cur.size || 0,
                pinned: !!cur.pinned,
                pinTimestamp: cur.pinTimestamp || 0
            };
            if (cur.pinned) pinned.push(item);
            else others.push(item);
            cur = cur.next;
        }

        // 1. 置顶项按置顶时间从小到大排序 (最近置顶的在置顶区最下方)
        pinned.sort((a, b) => (a.pinTimestamp || 0) - (b.pinTimestamp || 0));

        // 2. 普通项按复制时间从近到远排序 (最近复制的在最上方)
        others.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const out = [...pinned, ...others].slice(0, limit);

        // 激活内存检查：熔断机制，防止超大缓存撑爆内存
        const bytes = estimateBytes(out);
        if (bytes <= this._cache.maxBytes) {
            this._cache.uiList = out;
            this._cache.version = this._version;
            this._cache.lastUiKey = cacheKey;
            this._cache.uiBytes = bytes;
        }
        return out;
    }

    searchHistory(keyword, limit = CONSTANTS.UI_HISTORY_LIMIT) {
        const kw = String(keyword || '').trim();
        if (!kw) return this.getHistory(limit);

        // ★ 新功能：空格代表 AND 组合搜索（q a => 同时包含 q 和 a）
        const normalized = kw.toLowerCase().replace(REGEX.WHITESPACE_COLLAPSE, ' ').trim();
        const terms = normalized.split(' ').filter(Boolean);

        const cacheKey = `${this._version}|${limit}|${normalized}`;
        if (this._cache.searchList && this._cache.lastSearchKey === cacheKey) {
            this._cache.hit++;
            return this._cache.searchList;
        }
        this._cache.miss++;

        const pinned = [];
        const others = [];
        let cur = this._head;
        while (cur) {
            const hay = cur.content.toLowerCase();
            let ok = true;
            for (let i = 0; i < terms.length; i++) {
                if (!hay.includes(terms[i])) { ok = false; break; }
            }

            if (ok) {
                const item = {
                    id: cur.id,
                    content: cur.content,
                    timestamp: cur.timestamp,
                    preview: cur.preview,
                    size: cur.size || 0,
                    pinned: !!cur.pinned,
                    pinTimestamp: cur.pinTimestamp || 0
                };
                if (cur.pinned) pinned.push(item);
                else others.push(item);
            }
            cur = cur.next;
        }

        // 1. 搜索结果中的置顶项也按置顶时间从小到大排序
        pinned.sort((a, b) => (a.pinTimestamp || 0) - (b.pinTimestamp || 0));

        // 2. 搜索结果中的普通项按时间从近到远排序
        others.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const out = [...pinned, ...others].slice(0, limit);

        // 搜索结果缓存 + 内存防御
        const bytes = estimateBytes(out);
        if (bytes <= this._cache.maxBytes) {
            this._cache.searchList = out;
            this._cache.searchBytes = bytes;
            this._cache.lastSearchKey = cacheKey;
        }
        return out;
    }

    async togglePin(id) {
        const node = this._idMap.get(String(id || ''));
        if (!node) return false;
        node.pinned = !node.pinned;
        // 记录置顶时刻，用于排序
        node.pinTimestamp = node.pinned ? Date.now() : 0;

        this._touch();
        this._notifyChange('pin');
        this.requestSave();
        return true;
    }

    getItemById(id) { return this._idMap.get(String(id || '')); }

    async addToHistory(content, { forceUpdate = false } = {}) {
        const t0 = performance.now();
        try {
            if (typeof content !== 'string' || !content.trim()) return;
            const text = content.length > CONSTANTS.MAX_CONTENT_LENGTH ? content.slice(0, CONSTANTS.MAX_CONTENT_LENGTH) : content;

            // 除非是强制更新（内部点击），否则外部如果文本内容完全一致则跳过，避免轮询重复触发
            if (!forceUpdate && text === this._lastClipboardContent) return;

            const hash = md5Hex(text);
            const existed = this._hashMap.get(hash);
            if (existed) {
                existed.timestamp = Date.now();
                existed.content = text;
                existed.preview = makePreview(text);
                this._moveToHead(existed);
            } else {
                const node = {
                    id: randomId(),
                    content: text,
                    timestamp: Date.now(),
                    preview: makePreview(text),
                    size: Buffer.byteLength(text, 'utf8'),
                    pinned: false,
                    hash,
                    prev: null,
                    next: null
                };
                this._insertHead(node);
                this._idMap.set(node.id, node);
                this._hashMap.set(hash, node);

                // 批量容量清理：到达 2000 时，清理掉最老的 1000 条
                if (this._size >= CONSTANTS.MAX_HISTORY_ITEMS) {
                    console.log('[Q4] 触发容量熔断，执行批量清理...');
                    for (let i = 0; i < CONSTANTS.CLEANUP_BATCH_SIZE; i++) {
                        if (this._tail) this._popTail();
                    }
                }
            }
            this._lastClipboardContent = text;
            this._touch();
            this._notifyChange('add');
            this.requestSave();
        } finally {
            this.perfStats.addTimeMs += (performance.now() - t0);
            this.perfStats.operations++;
        }
    }

    async removeItem(id) {
        const t0 = performance.now();
        try {
            const node = this._idMap.get(String(id || ''));
            if (!node) return false;
            this._removeNode(node);
            this._touch();
            this._notifyChange('remove');
            this.requestSave();
            return true;
        } finally {
            this.perfStats.operations++;
        }
    }

    async clearHistory({ deleteFiles = true } = {}) {
        const t0 = performance.now();
        try {
            this._head = null; this._tail = null; this._size = 0;
            this._idMap.clear(); this._hashMap.clear();
            this._touch();
            this._notifyChange('clear');
            if (deleteFiles && this._fileBinGz && fs.existsSync(this._fileBinGz)) {
                try { fs.unlinkSync(this._fileBinGz); } catch { }
            }
            this._dirty = true;
            await this.forceSave();
        } finally {
            this.perfStats.operations++;
        }
    }

    requestSave() {
        this._dirty = true;
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.forceSave(), CONSTANTS.SAVE_THROTTLE_MS);
    }

    async forceSave() {
        if (!this._fileBinGz) return;
        this._saveChain = this._saveChain.then(() => this._doSaveOnce()).catch(() => this._doSaveOnce());
        return this._saveChain;
    }

    async _doSaveOnce() {
        if (!this._dirty) return;
        this._dirty = false;
        const t0 = performance.now();
        try {
            const payload = { version: CONSTANTS.VERSION, savedAt: Date.now(), history: this._toArrayAll() };

            const mp = getMsgpack();
            if (!mp) throw new Error('Msgpack 引擎丢失');

            const rawBuf = mp.encode(payload);
            const outBuf = await gzipAsync(rawBuf);

            await this._writeFileAtomic(this._fileBinGz, outBuf);
        } catch (e) {
            console.error('[Q4] 存储严重故障:', e.message);
            this._dirty = true;
        } finally {
            this.perfStats.saveTimeMs += (performance.now() - t0);
            this.perfStats.operations++;
        }
    }

    async _writeFileAtomic(targetPath, buf) {
        const dir = path.dirname(targetPath);
        const tmpPath = path.join(dir, `${path.basename(targetPath)}.${randomId()}.tmp`);

        await fs.promises.writeFile(tmpPath, buf);

        // ★ 终极最优解：Windows 强力原子写
        // Rename 在文件被锁时会报错，所以先尝试 unlink 旧文件再 rename，比单纯 rename 覆盖更稳
        try {
            await fs.promises.rename(tmpPath, targetPath);
        } catch {
            try {
                if (fs.existsSync(targetPath)) await fs.promises.unlink(targetPath);
            } catch { /* ignore */ }
            await fs.promises.rename(tmpPath, targetPath);
        }
    }

    async _quarantineCorruptFile(filePath) {
        try {
            const corrupted = filePath + '.corrupt-' + Date.now();
            if (fs.existsSync(filePath)) fs.renameSync(filePath, corrupted);
            this.perfStats.quarantinedFiles++;
        } catch {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    }

    startWatching() {
        if (this._isWatching) return;
        this._isWatching = true;
        this._clipboardTimer = setInterval(async () => {
            if (global.isDeactivated?.() || this._watcherBusy) return;
            this._watcherBusy = true;
            try {
                const cur = await vscode.env.clipboard.readText();
                if (cur && cur !== this._lastClipboardContent) await this.addToHistory(cur);
            } catch { } finally { this._watcherBusy = false; }
        }, CONSTANTS.CLIPBOARD_POLL_MS);
    }

    stopWatching() {
        if (this._clipboardTimer) clearInterval(this._clipboardTimer);
        this._isWatching = false;
    }

    async copyToClipboard(content) {
        try {
            const s = String(content ?? '');
            await vscode.env.clipboard.writeText(s);
            this._lastClipboardContent = s;
            return true;
        } catch { return false; }
    }

    async insertToEditor(content) {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return false;
            await editor.edit(eb => {
                if (editor.selection.isEmpty) eb.insert(editor.selection.active, content);
                else eb.replace(editor.selection, content);
            });
            return true;
        } catch { return false; }
    }

    _notifyChange(reason) { if (this._onChange) this._onChange(reason); }

    getStatsSnapshot() {
        const ops = Math.max(1, this.perfStats.operations || 1);
        const denom = this._cache.hit + this._cache.miss;
        const cacheHitRate = denom > 0 ? (this._cache.hit / denom) * 100 : 0;
        const uptimeSec = Math.floor((Date.now() - this.sessionStartedAt) / 1000);

        // 边界保护：限制平均耗时在 0-5000ms 之间，防止单次极端延迟（如磁盘休眠唤醒）永久拉高均值
        return {
            historyCount: this._size,
            isWatching: this._isWatching,
            uptime: { h: Math.floor(uptimeSec / 3600), m: Math.floor((uptimeSec % 3600) / 60) },
            perf: {
                quarantinedFiles: this.perfStats.quarantinedFiles,
                avgSaveMs: this._clampStat(this.perfStats.saveTimeMs / ops, 0, 1000),
                avgAddMs: this._clampStat(this.perfStats.addTimeMs / ops, 0, 1000),
                avgLoadMs: this._clampStat(this.perfStats.loadTimeMs / ops, 0, 5000),
            },
            cache: { hitRate: this._clampStat(cacheHitRate, 0, 100) },
            copyCount: this.context.globalState.get('qqq_copy_total_count', 0),
            savor: this._getSavorStats(),
            paste: this._getPasteStats(),
            video: this._getVideoStats(),
            roam: this._getRoamStats(),
            weave: this._getGenericStats('weave'),
            exportDoc: this._getGenericStats('exportDoc'),
            pure: this._getGenericStats('pure'),
            exportZip: this._getGenericStats('exportZip'),
            allSettings: this._getGenericStats('allSettings')
        };
    }

    async recordCopyUsage() {
        const gs = this.context.globalState;
        const count = (Number(gs.get('qqq_copy_total_count', 0)) || 0) + 1;
        await gs.update('qqq_copy_total_count', count);
        this._notifyChange('copy_stats');
    }

    _getGenericStats(type) {
        const gs = this.context.globalState;
        return gs.get(`qqq_${type}_stats`, {
            count: 0,
            firstUse: Date.now()
        });
    }

    async recordGenericUsage(type) {
        const gs = this.context.globalState;
        const key = `qqq_${type}_stats`;
        const stats = gs.get(key, { count: 0, firstUse: Date.now() });
        const newStats = {
            count: (Number(stats.count) || 0) + 1,
            firstUse: Number(stats.firstUse) || Date.now()
        };
        await gs.update(key, JSON.parse(JSON.stringify(newStats)));
        this._notifyChange(`${type}_stats`);
    }

    _getVideoStats() {
        const gs = this.context.globalState;
        return gs.get('qqq_video_stats', {
            count: 0,
            totalSize: 0,
            firstUse: Date.now()
        });
    }

    _getRoamStats() {
        const gs = this.context.globalState;
        return gs.get('qqq_roam_stats', {
            count: 0,
            filesCreated: 0,
            firstUse: Date.now()
        });
    }

    _getPasteStats() {
        const gs = this.context.globalState;
        return gs.get('qqq_paste_stats', {
            count: 0,
            totalSize: 0,
            firstUse: Date.now()
        });
    }

    _getSavorStats() {
        const gs = this.context.globalState;
        return {
            count: gs.get('qqq_savor_count', 0),
            totalMs: gs.get('qqq_savor_total_ms', 0),
            firstUse: gs.get('qqq_savor_first_use', Date.now())
        };
    }

    async recordSavorUsage(durationMs) {
        const gs = this.context.globalState;
        const count = (Number(gs.get('qqq_savor_count', 0)) || 0) + 1;
        const totalMs = (Number(gs.get('qqq_savor_total_ms', 0)) || 0) + durationMs;

        if (!gs.get('qqq_savor_first_use')) {
            await gs.update('qqq_savor_first_use', Date.now());
        }

        await gs.update('qqq_savor_count', count);
        await gs.update('qqq_savor_total_ms', totalMs);
        this._notifyChange('savor_stats');
    }

    async recordRoamUsage({ filesCreated = 0 } = {}) {
        const gs = this.context.globalState;
        const stats = gs.get('qqq_roam_stats', { count: 0, filesCreated: 0, firstUse: Date.now() });
        const newStats = {
            count: (Number(stats.count) || 0) + 1,
            filesCreated: (Number(stats.filesCreated) || 0) + filesCreated,
            firstUse: Number(stats.firstUse) || Date.now()
        };
        await gs.update('qqq_roam_stats', JSON.parse(JSON.stringify(newStats)));
        this._notifyChange('roam_stats');
    }

    async dispose() {
        this.stopWatching();
        if (this._saveTimer) clearTimeout(this._saveTimer);
        if (this._dirty) await this.forceSave();
    }
}

// ============================================================================
// Sidebar Webview Provider（Solarized Dark + 暗金 + 破高对比度）
// ============================================================================
class ClipboardHistorySidebarProvider {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {ClipboardHistoryManager} historyManager
     * @param {any} globalModule
     */
    constructor(context, historyManager, globalModule) {
        this._context = context;
        this._historyManager = historyManager;
        this._global = globalModule;
        this._view = null;
        this._updateTimer = null;
        this._watchdogTimer = null;
        this._lastHeartbeat = Date.now();
        this._lastAudioIdx = -1;
        this._currentLimit = CONSTANTS.UI_HISTORY_LIMIT;
        this._isFocused = false;
        this._needsUpdate = false;
        this._pendingReason = null;

        this._audioSource = AUDIO_SOURCE.DETECTING;
        this._pythonAudioFailed = false;

        // ★ 新增：跟踪 Python 播放状态，支持绑定/解绑
        this._pythonPlayState = {
            playing: false,
            fileName: null,
            loopCount: 0,
            startTime: 0
        };

        // ★ 新增：记录 PythonBridge 事件 handler 引用，便于 dispose 解绑，避免热重载堆监听
        this._onPythonEvent = null;
    }

    /**
     * ★ 重置音频源状态（当 Python 环境"从无到有"时调用）
     * 下次播放时会重新探测 Python 引擎
     */
    resetAudioSource() {
        this._audioSource = AUDIO_SOURCE.DETECTING;
        this._pythonAudioFailed = false;
        this._global.logMessage(`[Q4] 音频源状态已重置`, "INFO");
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };

        // ★ 闪电加载：立即渲染空骨架 HTML，1秒后再加载历史数据
        this._view.webview.html = this._getHtml([], {});

        // 1秒后加载完整数据（包括剩贴板历史 + Python 状态同步）
        setTimeout(() => {
            this.updateContent(null, null, null, true);
            // ★ 启动时检查：Python 是否正在后台播放？如果是，同步 UI
            this._syncPythonStateOnStartup();
        }, 1000);

        // 监听 Python 引擎的异步通知（如自然播放结束）
        try {
            // 防止重复绑定（热重载/视图重建）
            if (this._onPythonEvent && this._global?.pythonBridge) {
                if (typeof this._global.pythonBridge.off === 'function') {
                    this._global.pythonBridge.off('event', this._onPythonEvent);
                } else if (typeof this._global.pythonBridge.removeListener === 'function') {
                    this._global.pythonBridge.removeListener('event', this._onPythonEvent);
                }
            }
        } catch { /* ignore */ }

        this._onPythonEvent = (data) => {
            if (data && data.event === 'audio_finished') {
                // ★ 更新 Python 播放状态
                this._pythonPlayState.playing = false;
                // 通知 webview 停止播放
                this._postMessage({ command: 'stopAudio' });
            } else if (data && data.event === 'process_crashed' && data.bridge === 'Python') {
                // ★ Python 进程崩溃，立即停止 UI 播放状态
                this._pythonPlayState.playing = false;
                this._postMessage({ command: 'stopAudio' });
                this._global.logMessage(`[Q4] Python 进程崩溃，已停止播放 UI`, "WARN");
            }
        };
        this._global.pythonBridge.on('event', this._onPythonEvent);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                // ★ 新增：处理命令历史记录的获取和保存
                case 'getHistory':
                    if (msg.key) {
                        const history = await this._historyManager.getCommandHistory(msg.key);
                        this._postMessage({ command: 'historyData', key: msg.key, history: history });
                    }
                    break;
                case 'saveHistory':
                    if (msg.key && msg.value) {
                        await this._historyManager.addCommandToHistory(msg.key, msg.value);
                    }
                    break;
                case 'focusState':
                    this._isFocused = !!msg.focused;
                    if (!this._isFocused && this._needsUpdate) {
                        this._needsUpdate = false;
                        this.updateContent(this._pendingReason, null, null, true);
                    }
                    break;
                case 'executeCommand':
                    if (msg.cmd) {
                        if (msg.args && Array.isArray(msg.args)) {
                            vscode.commands.executeCommand(msg.cmd, ...msg.args);
                        } else {
                            vscode.commands.executeCommand(msg.cmd);
                        }
                    }
                    break;
                case 'copyToClipboard': {
                    const node = this._historyManager.getItemById(msg.itemId);
                    if (node) {
                        this._handleSfxFeedback();
                        await this._historyManager.copyToClipboard(node.content);
                        await this._historyManager.recordCopyUsage();
                        await this._historyManager.addToHistory(node.content, { forceUpdate: true });
                    }
                    break;
                }
                case 'pasteToEditor': {
                    const node = this._historyManager.getItemById(msg.itemId);
                    if (node) {
                        this._handleSfxFeedback();
                        await this._historyManager.copyToClipboard(node.content);
                        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
                    }
                    break;
                }
                case 'insertToEditor': {
                    const node = this._historyManager.getItemById(msg.itemId);
                    if (node) {
                        const ok = await this._historyManager.insertToEditor(node.content);
                        vscode.window.setStatusBarMessage(ok ? '已插入到编辑器' : '插入失败', 2000);
                    }
                    break;
                }
                case 'deleteHistoryItem':
                    if (msg.itemId) {
                        await this._historyManager.removeItem(msg.itemId);
                    }
                    break;
                case 'togglePinHistoryItem':
                    if (msg.itemId) {
                        await this._historyManager.togglePin(msg.itemId);
                    }
                    break;
                case 'requestData':
                    if (msg.limit) {
                        this.updateContent(null, msg.limit, msg.keyword);
                    }
                    break;
                case 'requestSavorAudio': {
                    if (msg.mode === 'stop') {
                        await this._stopAudio();
                    } else {
                        await this.triggerSavor(msg.mode || 'normal');
                    }
                    break;
                }
                case 'ready':
                    this.updateContent(null, null, null, true);
                    break;
                case 'recordSavorUsage':
                    if (msg.durationMs) await this._historyManager.recordSavorUsage(msg.durationMs);
                    break;
                case 'recordGenericUsage':
                    if (msg.type) await this._historyManager.recordGenericUsage(msg.type);
                    break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.updateContent(null, null, null, true);
                this._startPeriodicUpdate();
            } else {
                this._stopPeriodicUpdate();
            }
        });

        webviewView.onDidDispose(() => {
            this._stopPeriodicUpdate();
        });
    }

    _handleSfxFeedback() {
        let audioIdx;
        do {
            audioIdx = Math.floor(Math.random() * 7) + 1;
        } while (audioIdx === this._lastAudioIdx);
        this._lastAudioIdx = audioIdx;
        this._playEffect('kope', audioIdx);
    }

    _startPeriodicUpdate() {
        // 彻底停用 5 秒定时刷新
    }

    _stopPeriodicUpdate() {
        // 无需清理定时器
    }

    updateContent(reason, limit, keyword, force = false) {
        if (!this._view || !this._view.visible) return;
        if (limit) this._currentLimit = limit;

        // 核心逻辑：如果在聚焦状态且不是搜索、不是强制更新、且不是关键手动操作(pin/remove/clear)，则挂起更新
        const isSearchUpdate = !!keyword || (reason === null && !keyword); // 搜索键入或清空搜索
        const isImmediate = force || isSearchUpdate || ['pin', 'remove', 'clear'].includes(reason);
        if (!isImmediate && this._isFocused) {
            this._needsUpdate = true;
            this._pendingReason = reason;
            return;
        }

        try {
            const stats = this._historyManager.getStatsSnapshot();
            const savorStats = this._formatSavorStats(stats.savor);
            const pasteStats = this._formatPasteStats(stats.paste);
            const videoStats = this._formatVideoStats(stats.video);
            const roamStats = this._formatRoamStats(stats.roam);
            const weaveStats = this._formatGenericStats(stats.weave);
            const exportDocStats = this._formatGenericStats(stats.exportDoc);
            const pureStats = this._formatGenericStats(stats.pure);
            const exportZipStats = this._formatGenericStats(stats.exportZip);
            const allSettingsStats = this._formatGenericStats(stats.allSettings);

            // 构建 placeholder 统计字符串
            const hitRate = Math.round(stats.cache.hitRate || 0);
            const avgSave = Math.round(stats.perf.avgSaveMs || 0);
            const avgAdd = Math.round(stats.perf.avgAddMs || 0);
            const avgLoadMs = Math.round(stats.perf.avgLoadMs || 0);
            const copyCount = stats.copyCount || 0;
            const quarantined = Math.round(stats.perf.quarantinedFiles || 0);
            const fullStats = `${copyCount} times; count: ${stats.historyCount}, cacheHit:${hitRate}%, avgSove: ${avgSave}ms, avgAdd: ${avgAdd}ms, avgLaad: ${avgLoadMs}ms, quorantined: ${quarantined}`;

            const history = this._historyManager.searchHistory(keyword || '', this._currentLimit).map(item => ({
                id: item.id,
                time: formatTime(item.timestamp),
                preview: item.preview,
                size: item.size || 0,
                pinned: !!item.pinned
            }));

            // ★ 极致纯净：初始化必要的 HTML
            if (!this._view.webview.html || this._view.webview.html.length < 100) {
                this._view.webview.html = this._getHtml(history, {
                    savorStats, pasteStats, videoStats, roamStats,
                    weaveStats, exportDocStats, pureStats, exportZipStats, allSettingsStats
                });
            }

            this._postMessage({
                command: 'updateData',
                history: history,
                triggerStorm: (reason === 'add' || reason === 'pin'),
                savorStats: savorStats,
                pasteStats: pasteStats,
                videoStats: videoStats,
                roamStats: roamStats,
                weaveStats: weaveStats,
                exportDocStats: exportDocStats,
                pureStats: pureStats,
                exportZipStats: exportZipStats,
                allSettingsStats: allSettingsStats,
                fullStats: fullStats
            });

            const ver = this._context.extension.packageJSON.version;
            this._view.title = `v${ver}`;
        } catch (e) {
            console.error('[Q4-UI] Update failed:', e);
        }
    }

    _formatGenericStats(s) {
        if (!s) return '';
        return `${s.count} times`;
    }

    _formatSavorStats(s) {
        if (!s) return '';
        const formatDuration = (ms) => {
            const sec = Math.floor(ms / 1000);
            const min = Math.floor(sec / 60);
            const hr = Math.floor(min / 60);
            if (hr > 0) return `${hr}h ${min % 60}m`;
            if (min > 0) return `${min}m ${sec % 60}s`;
            return `${sec}s`;
        };

        const totalStr = formatDuration(s.totalMs);
        const days = Math.max(1, Math.ceil((Date.now() - s.firstUse) / 86400000));
        const avgMs = Math.floor(s.totalMs / days);
        const avgStr = formatDuration(avgMs);

        return `${s.count} times, ${totalStr}; Avg per day: ${avgStr}`;
    }

    _formatRoamStats(s) {
        if (!s) return '';
        const days = Math.max(1, Math.ceil((Date.now() - (s.firstUse || Date.now())) / 86400000));
        const avgCount = Math.round(s.count / days);
        return `${s.count} times, ${s.filesCreated || 0} files; Avg per day: ${avgCount} times`;
    }

    _formatVideoStats(s) {
        if (!s) return '';
        const formatBytes = (bytes) => {
            if (bytes === 0) return '0b';
            const k = 1024;
            const sizes = ['b', 'k', 'm', 'g', 't'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
        };

        const sizeStr = formatBytes(s.totalSize || 0);
        const days = Math.max(1, Math.ceil((Date.now() - (s.firstUse || Date.now())) / 86400000));
        const avgCount = Math.round(s.count / days);

        return `${s.count} times, ${sizeStr}; Avg per day: ${avgCount} times`;
    }

    _formatPasteStats(s) {
        if (!s) return '';
        const formatBytes = (bytes) => {
            if (bytes === 0) return '0b';
            const k = 1024;
            const sizes = ['b', 'k', 'm', 'g', 't'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
        };

        const sizeStr = formatBytes(s.totalSize || 0);
        const days = Math.max(1, Math.ceil((Date.now() - (s.firstUse || Date.now())) / 86400000));
        const avgCount = Math.round(s.count / days);

        return `${s.count} times, ${sizeStr}; Avg per day: ${avgCount} times`;
    }

    get isWebviewReady() {
        return !!this._view;
    }

    _postMessage(msg) {
        if (!this._view) return;
        try {
            // ★ 基因加固：深度纯净化，彻底根除 toJSON 报错与内部对象污染
            const safeMsg = JSON.parse(JSON.stringify(msg));
            this._view.webview.postMessage(safeMsg).then(undefined, () => { });
        } catch (e) {
            console.warn('[Q4] IPC 消息序列化失败:', e.message);
        }
    }

    /**
     * 外部接口：手动触发“品味瞬间”随机播放
     * @param {string} mode 'normal' 或 'loop'
     */
    async _ensureAudioSource() {
        if (this._pythonAudioFailed) {
            this._audioSource = AUDIO_SOURCE.WEBVIEW;
            return AUDIO_SOURCE.WEBVIEW;
        }
        if (this._audioSource !== AUDIO_SOURCE.DETECTING) {
            return this._audioSource;
        }

        const bridge = this._global.pythonBridge;

        // 探测 Python 引擎
        try {
            // ★ 修复：DaemonBridge 并没有 isAlive 方法，直接检查 available 属性
            if (bridge && bridge.available === true) {
                const res = await bridge.call('ping');
                if (res && res.status === 'alive') {
                    // 显式检查 miniaudio 状态
                    const check = await bridge.call('check_audio_engine');
                    if (check && check.has_miniaudio) {
                        const version = check.miniaudio_version || "unknown";
                        const devices = Array.isArray(check.devices) ? `(Devices: ${check.devices.length})` : "";
                        this._global.logMessage(`[Audio] Python (miniaudio v${version}) 探测成功 ${devices}，切换到高性能模式`, "INFO");
                        this._audioSource = AUDIO_SOURCE.PYTHON;
                        return AUDIO_SOURCE.PYTHON;
                    } else {
                        this._global.logMessage(`[Audio] Python 引擎已连接但未检测到 miniaudio 依赖`, "WARN");
                    }
                }
            }
        } catch (e) {
            this._global.logMessage(`[Audio] Python 探测异常: ${e.message}`, "WARN");
        }

        this._global.logMessage(`[Audio] Python 引擎探测未通过，使用 Webview 兜底`, "WARN");
        this._audioSource = AUDIO_SOURCE.WEBVIEW;
        return AUDIO_SOURCE.WEBVIEW;
    }

    _getSavorAudioInfo() {
        const getRand = (min, max) => crypto.randomInt ? crypto.randomInt(min, max) : Math.floor(Math.random() * (max - min)) + min;
        const rand = getRand(0, 30);
        let filename;
        if (rand === 0) {
            filename = "q.mp3";
        } else {
            const subRand = getRand(0, 3);
            filename = `${subRand + 1}.mp3`;
        }
        const fullPath = path.join(this._context.extensionPath, "assets", filename);
        return {
            path: fullPath,
            fileName: filename,
            base64: () => {
                try {
                    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath).toString('base64') : '';
                } catch { return ''; }
            }
        };
    }

    _getKopeAudioInfo(idx) {
        const filename = `${idx}.mp3`;
        const fullPath = path.join(this._context.extensionPath, "assets", "kope", filename);
        return {
            path: fullPath,
            fileName: filename,
            base64: () => {
                try {
                    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath).toString('base64') : '';
                } catch { return ''; }
            }
        };
    }

    async _playEffect(type, idx = null) {
        // 如果是点击音效 (kope)，强制走 Webview 且不发 playAudio 指令（不干扰 UI 文字）
        if (type === 'kope') {
            const info = idx !== null ? this._getKopeAudioInfo(idx) : this._getSavorAudioInfo();
            const b64 = info.base64();
            if (b64) {
                this._postMessage({ command: 'playSfx', base64: b64 });
            }
            return;
        }

        const source = await this._ensureAudioSource();
        const info = idx !== null ? this._getKopeAudioInfo(idx) : this._getSavorAudioInfo();
        const loopCount = 1;

        this._global.logMessage(`[Audio] ${source === AUDIO_SOURCE.PYTHON ? 'Python' : 'Webview'} 引擎播放: ${info.fileName}, 循环: ${loopCount}`, "INFO");

        if (source === AUDIO_SOURCE.PYTHON) {
            // Python 模式：先发 UI-only（无 base64）
            this._postMessage({ command: 'playAudio', fileName: info.fileName, count: loopCount });

            try {
                const res = await this._global.pythonBridge.call('play_audio', { path: info.path, count: loopCount });

                // [Fix] 兼容 'ok' (新版 kp.py) 和 'playing' (旧版习惯)
                if (res && (res.status === 'playing' || res.status === 'ok')) {
                    return;
                }

                // 优先报告明确的错误信息
                if (res && res.error) throw new Error(res.error);
                if (res && res.reason) throw new Error(res.reason);

                throw new Error(`unknown_python_error: ${JSON.stringify(res)}`);
            } catch (e) {
                console.error('[Q4] Python 播放失败，永久切换到 Webview:', e.message);
                this._pythonAudioFailed = true;
                this._audioSource = AUDIO_SOURCE.WEBVIEW;
                // 继续落到 Webview 兜底
            }
        }

        // Webview 模式：只发一次（带 base64）
        const b64 = info.base64();
        if (b64) {
            this._postMessage({
                command: 'playAudio',
                base64: b64,
                fileName: info.fileName,
                count: loopCount
            });
        }
    }

    // ★ 启动时检查：Python 是否正在后台播放？如果是，同步 UI
    async _syncPythonStateOnStartup() {
        try {
            const res = await this._global.pythonBridge.call('get_audio_state');
            if (res && res.playing) {
                // Python 正在播放，同步 UI 状态
                this._global.logMessage('[Audio] q4 启动时检测到 Python 正在播放，同步 UI', "INFO");
                // 从 Python 引擎获取当前播放的文件和循环信息
                // 由于无法直接获取文件名，使用 _pythonPlayState 中保存的信息
                if (this._pythonPlayState && this._pythonPlayState.fileName) {
                    this.syncPythonPlayState(
                        this._pythonPlayState.fileName,
                        this._pythonPlayState.loopCount,
                        true
                    );
                } else {
                    // 没有记录则只更新文字状态
                    this._postMessage({
                        command: 'playAudio',
                        fileName: 'Savoring...',
                        count: -1  // 无限循环标志
                    });
                }
            }
        } catch (e) {
            // Python 引擎不可用或调用失败，忽略
        }
    }

    async _stopAudio() {
        const source = await this._ensureAudioSource();

        // 需求：只有“自然播完的最后一次”才淡出；停止/切歌一律不淡出
        if (source === AUDIO_SOURCE.PYTHON) {
            try { await this._global.pythonBridge.call('stop_audio'); } catch (e) { }
        }

        // ★ 清除 Python 播放状态
        this._pythonPlayState.playing = false;

        // 无论 Python 还是 Webview，都让 Webview 侧 UI 进入“停止”状态
        this._postMessage({ command: 'stopAudio' });
    }

    /**
     * ★ 外部接口：同步 Python 播放状态到 Webview UI
     * 由 qqq.js 中的 savorMomentsCommand 调用，当 Python 引擎直接播放时同步 UI
     * @param {string} fileName 播放的文件名
     * @param {number} loopCount 循环次数
     * @param {boolean} isPlaying 是否正在播放
     */
    syncPythonPlayState(fileName, loopCount, isPlaying) {
        // ★ 绑定到 Python 播放器
        this._audioSource = AUDIO_SOURCE.PYTHON;
        this._pythonPlayState = {
            playing: isPlaying,
            fileName: fileName,
            loopCount: loopCount,
            startTime: isPlaying ? Date.now() : 0
        };

        // 同步 UI 状态（不发送 base64，让 webview 只更新文字状态）
        if (isPlaying) {
            this._postMessage({
                command: 'playAudio',
                fileName: fileName,
                count: loopCount
                // 不发送 base64，让 webview 知道这是 Python 播放，只更新文字
            });
        } else {
            this._postMessage({ command: 'stopAudio' });
        }
    }

    async triggerSavor(mode = 'normal') {
        // ★ 核心改进：播放前先停止，确保单实例叙事
        await this._stopAudio();

        const source = await this._ensureAudioSource();
        const info = this._getSavorAudioInfo();
        const getRand = (min, max) => crypto.randomInt ? crypto.randomInt(min, max) : Math.floor(Math.random() * (max - min)) + min;

        const loopCount = mode === 'loop' ? (source === AUDIO_SOURCE.PYTHON ? 0 : -1) : getRand(2, 7);
        const displayCount = (loopCount === -1 || loopCount === 0) ? '无限' : loopCount;

        this._global.logMessage(`[Audio] ${source === AUDIO_SOURCE.PYTHON ? 'Python' : 'Webview'} 引擎播放品味: ${info.fileName}, 循环: ${displayCount}`, "INFO");

        if (source === AUDIO_SOURCE.PYTHON) {
            // Python 模式：先发 UI-only（无 base64）
            this._postMessage({ command: 'playAudio', fileName: info.fileName, count: loopCount });

            try {
                const res = await this._global.pythonBridge.call('play_audio', { path: info.path, count: loopCount });

                if (res && (res.status === 'playing' || res.status === 'ok')) {
                    // ★ 更新 Python 播放状态
                    this._pythonPlayState = {
                        playing: true,
                        fileName: info.fileName,
                        loopCount: loopCount,
                        startTime: Date.now()
                    };
                    return;
                }

                // 优先报告明确的错误信息
                if (res && res.error) throw new Error(res.error);
                if (res && res.reason) throw new Error(res.reason);

                throw new Error(`unknown_python_error: ${JSON.stringify(res)}`);
            } catch (e) {
                console.error('[Q4] Python 播放失败，永久切换到 Webview:', e.message);
                this._pythonAudioFailed = true;
                this._audioSource = AUDIO_SOURCE.WEBVIEW;
                this._pythonPlayState.playing = false;
                // 继续落到 Webview 兜底
            }
        }

        // Webview 模式：只发一次（带 base64）
        const b64 = info.base64();
        if (b64) {
            this._postMessage({ command: 'playAudio', base64: b64, fileName: info.fileName, count: loopCount });
        }
    }

    _getHtml(history, statsObj = {}) {
        const {
            savorStats = '', pasteStats = '', videoStats = '', roamStats = '',
            weaveStats = '', exportDocStats = '', pureStats = '', exportZipStats = '', allSettingsStats = ''
        } = statsObj;
        const nonce = nonceHex();
        const csp = [
            `default-src 'none'`,
            `img-src ${this._view.webview.cspSource} data:`,
            `media-src ${this._view.webview.cspSource} data:`,
            `style-src ${this._view.webview.cspSource} 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${this._view.webview.cspSource}`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <style nonce="${nonce}">
        :root {
            --base03: #002b36; --base02: #073642; --base01: #586e75; --base00: #657b83;
            --base0: #839496; --base1: #93a1a1; --base2: #fdf6e3; --base3: #eee8d5;
            --yellow: #b58900; --orange: #cb4b16; --red: #dc322f; --magenta: #d33682;
            --violet: #6c71c4; --blue: #268bd2; --cyan: #2aa198; --green: #859900;
            --primary-color: var(--yellow); --background-color: var(--base3);
            --card-bg: var(--base2); --text-primary: #2a211c; --border-color: #d3c6aa;
        }
        html { forced-color-adjust: none !important; }
        body {
            margin: 0; padding: 0; font-family: Tahoma, sans-serif; font-size: 13px; background: var(--background-color); color: var(--text-primary); overflow: hidden;
            user-select: none; -webkit-user-select: none; /* 彻底禁用选中 */
        }
        .main-wrapper { height: 100vh; width: 100%; position: relative; overflow: hidden; background: var(--background-color) !important; display: flex; flex-direction: column; }
        .main-content { flex: 1; display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto; padding: 0 4px; scrollbar-width: none; }
        .main-content::-webkit-scrollbar { display: none; }

        .section-title { font-size: 1.1em; font-weight: 700; margin: 15px 0 10px 0; border-bottom: 2px solid var(--primary-color); color: var(--primary-color); flex-shrink: 0; }
        .captain-grid { display: grid; gap: 8px; margin-bottom: 0; flex-shrink: 0; }
        .cmd-btn { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 4px; padding: 0 10px; height: 38px; cursor: pointer; display: flex; align-items: center; gap: 10px; transition: 0.2s; position: relative; overflow: hidden; font-size: 14px; color: var(--text-primary); white-space: nowrap; box-sizing: border-box; }
        .cmd-btn:hover { border-color: var(--primary-color);  transform: translateX(2px); }
        #savorCard:hover, #videoCard:hover { transform: none; }
        .cmd-btn .btn-group { display: flex; gap: 4px; flex-shrink: 0; z-index: 10; align-items: center; }
        .cmd-btn .text-content { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; font-family: Tahoma, sans-serif; font-size: 14px; }

        .icon-loop { width: 14px; height: 14px; background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzU0NTQ1NCI+PHBhdGggZD0iTTEyIDRWMUw4IDVsNCA0VjZjMy4zMSAwIDYgMi42OSA2IDYgMCAxLjAxLS4yNSAxLjk3LS43IDIuOGwxLjQ2IDEuNDZBNy45MyA3LjkzIDAgMCAwIDIwIDEyYzAtNC40Mi0zLjU4LTgtOC04em0wIDE0Yy0zLjMxIDAtNi0yLjY5LTYtNiAwLTEuMDEuMjUtMS45Ny43LTIuOEw1LjI0IDcuNzRBNy45MyA3LjkzIDAgMCAwIDQgMTJjMCA0LjQyIDMuNTggOCA4IDh2M2w0LTQtNC00djN6Ii8+PC9zdmc+') no-repeat center; display: inline-block; vertical-align: middle; position: relative; top: -1px; }
        .icon-loop.spinning { animation: spin 2s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .icon-stop { width: 14px; height: 14px; background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzU0NTQ1NCI+PHJlY3QgeD0iNCIgeT0iNCIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMiIvPjwvc3ZnPg==') no-repeat center; display: inline-block; vertical-align: middle; position: relative; top: -1px; }
        .icon-play { width: 14px; height: 14px; background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzQ0NDQ0NCI+PHBhdGggZD0iTTggNXYxNGwxMS03eiIvPjwvc3ZnPg==') no-repeat center; display: inline-block; vertical-align: middle; position: relative; top: -1px; }
        .icon-pen { width: 14px; height: 14px; background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzU0NTQ1NCI+PHBhdGggZD0iTTMgMTcuMjVWMjFoMy43NWwxMS4wNi0xMS4wNi0zLjc1LTMuNzVMMyAxNy4yNXpNMjAuNzEgNy4wNGMuMzktLjM5LjM5LTEuMDIgMC0xLjQxbC0yLjM0LTIuMzRjLS4zOS0uMzktMS4wMi0uMzktMS40MSAw bC0xLjgzIDEuODMgMy43NSAzLjc1IDEuODMtMS44M3oiLz48L3N2Zz4=') no-repeat center; display: inline-block; vertical-align: middle; position: relative; top: -1px; }
        .icon-ufo { width: 14px; height: 14px; background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzU0NTQ1NCI+PHBhdGggZD0iTTEyIDJDMi40OCAyIDEyIDIuNDggMTIgOCAxMiAxMy41MiA3LjUyIDIyIDEyIDIyYzQuNDggMCA5LjUyLTguNDggMTAtMTQgMC01LjUyLTkuNTItMTAtMTAtMTB6bTAgMThjLTMuMzEgMC02LTIuNjktNi02IDAtMy4zMSAyLjY5LTYgNi02czYgMi42OSA2IDYtMi42OSA2LTYgNnoiLz48cGF0aCBkPSJNMjEgMTNoLTRjLS41NSAwLTEgLjQ1LTEgMXMuNDUgMSAxIDFoNGMuNTUgMCAxLS40NSAxLTFzLS40NS0xLTEtMXpNNyAxM0gzYy0uNTUgMC0xIC40NS0xIDFzLjQ1IDEgMSAxaDRjLjU1IDAgMS0uNDUgMS0xcy0uNDUtMS0xLTF6TTEyIDhjLTMuMzEgMC02IDIuNjktNiA2IDAgMy4zMSAyLjY5IDYgNiA2czYtMi42OSA2LTYtMi42LTMuMzEgMC02IDIuNjktNiA2IDAgMy4zMSAyLjY5IDYgNiA2czYtMi42OSA2LTYtMi42OS02LTYtNnoiIG9wYWNpdHk9Ii4zIi8+PC9zdmc+') no-repeat center; display: inline-block; vertical-align: middle; position: relative; top: -1px; }
        .icon-all-settings { width: 14px; height: 14px; background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzU0NTQ1NCI+PHBhdGggZD0iTTE5LjE0IDEyLjk0Yy4wNC0uMy4wNi0uNjEuMDYtLjk0IDAtLjMyLS4wMi0uNjQtLjA3LS45NGwyLjAzLTEuNThjLjE4LS4xNC4yMy0uNDEuMTItLjYxbC0xLjkyLTMuMzJjLS4xMi0uMjItLjM3LS4yOS0uNTktLjIybC0yLjM5Ljk2Yy0uNS0uMzgtMS4wMy0uNy0xLjYyLS45NGwtLjM2LTIuNTRjLS4wNC0uMjQtLjI0LS40MS0uNDgtLjQxaC0zLjg0Yy0uMjQgMC0uNDMuMTctLjQ3LjQxbC0uMzYgMi41NGMtLjU5LjI0LTEuMTMuNTctMS42Mi45NGwtMi4zOS0uOTZjLS4yMi0uMDgtLjQ3IDAtLjU5LjIybC0xLjkyIDMuMzJjLS4xMi4yLS4wNy40Ny4xMi42MWwyLjAzIDEuNThjLS4wNS4zLS4wOS42My0uMDkuOTRzLjAyLjY0LjA3Ljk0bC0yLjAzIDEuNThjLS4xOC4xNC0uMjMuNDEtLjEyLjYxbDEuOTIgMy4zMmMuMTIuMjIuMzcuMjkuNTkuMjJsMi4zOS0uOTZjLjUuMzggMS4wMy43IDEuNjIuOTRsLjM2IDIuNTRjLjA1LjI0LjI0LjQxLjQ4LjQxaDMuODRjLjI0IDAgLjQ0LS4xNy40Ny0uNDFsLjM2LTIuNTRjLjU5LS4yNCAxLjEzLS41NiAxLjYyLS45NGwyLjM5Ljk2Yy4yMi4wOC40NyAwIC41OS0uMjJsMS45Mi0zLjMyYy4xMi0uMjIuMDctLjQ3LS4xMi0uNjFsLTIuMDEtMS41OHpNMTIgMTUuNmMtMS45OCAwLTMuNi0xLjYyLTMuNi0zLjZzMS42Mi0zLjYgMy42LTMuNiAzLjYgMS42MiAzLjYgMy42LTEuNjIgMy42LTMuNiAzLjZ6Ii8+PC9zdmc+') no-repeat center; display: inline-block; vertical-align: middle; position: relative; top: -1px; }
        .spacer-5 { display: inline-block; width: 25px; height: 1px; background: url('data:image/svg+xml;base64,${CONSTANTS.SPACER_5_BASE64}') no-repeat center; vertical-align: middle; }

        #videoCard { height: 48px; overflow: visible; }
        [data-cmd="qqq.weave"] { height: 49px !important; }
        [data-cmd="qqq.q2"] { height: 41px !important; }
        .input-box-wrapper { position: relative; width: 156px; height: 30px; flex-shrink: 0; margin-left: -7px; }
        .inline-input {
            background: var(--base2);
            color: #000;
            border: 1px solid var(--vscode-input-border, #d3c6aa);
            border-radius: 2px;
            padding: 2px 36px 2px 6px;
            font-size: 14px;
            height: 30px;
            width: 100%;
            outline: none;
            box-sizing: border-box;
            font-family: Tahoma, sans-serif;
        }
        .inline-input::selection { background: #FFD302; color: #000; }
        .inline-input:focus { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color); }
        .inline-input::placeholder { color: var(--vscode-input-placeholderForeground, rgba(0,0,0,0.5)); font-size: 14px; }

        #btnVideoStart {
            position: absolute;
            right: -2px;
            top: 50%;
            transform: translateY(calc(-50% + 2px));
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 11;
            opacity: 0.7;
        }
        #btnVideoStart:hover { opacity: 1; }
        #btnVideoStart .icon-play { background-size: contain; width: 25px; height: 25px; }

        .error-tip {
            position: absolute;
            top: 110%;
            left: 0;
            background: #f8d7da;
            color: #721c24;
            padding: 4px 10px;
            border-radius: 4px;
            font-family: Tahoma, sans-serif;
            font-size: 13px;
            white-space: nowrap;
            display: none;
            z-index: 100;
            border: 1px solid #f5c6cb;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .error-tip::after { display: none; }

        .history-container { flex: 1; min-height: 400px; position: relative; margin-bottom: 10px; display: flex; flex-direction: column; overflow: hidden; }

        /* 极致强烈：金刃狂飙 4.0 (Hyper-Gold Storm Max) */
        .history-container.storm::after {
            content: '';
            position: absolute;
            top: -150%; left: -150%; right: -150%; bottom: -150%;
            pointer-events: none;
            z-index: 1000;
            background: linear-gradient(45deg,
                transparent 35%,
                rgba(181, 137, 0, 0.9) 38%,
                rgba(255, 255, 255, 1) 40%,
                rgba(181, 137, 0, 0.9) 42%,
                transparent 45%,
                rgba(181, 137, 0, 0.7) 47%,
                rgba(255, 255, 255, 1) 50%,
                rgba(181, 137, 0, 0.7) 53%,
                transparent 55%,
                rgba(181, 137, 0, 0.5) 57%,
                rgba(255, 255, 255, 1) 60%,
                rgba(181, 137, 0, 0.5) 63%,
                transparent 65%
            );
            filter: blur(3px) brightness(2.5) contrast(1.5);
            opacity: 0;
            animation: hyper-storm 0.7s cubic-bezier(0.15, 0, 0.15, 1) forwards;
        }
        @keyframes hyper-storm {
            0% { transform: translate(-40%, 40%) rotate(-10deg) scale(0.5); opacity: 0; }
            15% { opacity: 1; transform: translate(-20%, 20%) rotate(0deg) scale(1.5) skewX(5deg); }
            30% { transform: translate(-18%, 18%) scale(1.6) rotate(1deg); } /* 高能震颤点 */
            100% { transform: translate(40%, -40%) rotate(10deg) scale(3); opacity: 0; }
        }

        .history-list { flex: 1; overflow-x: hidden; overflow-y: scroll; padding: 4px 0; scrollbar-width: none; }
        .history-list::-webkit-scrollbar { display: none; }
        .history-item { background: var(--base3); border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; margin-bottom: 8px; transition: 0.2s; cursor: pointer; color: #8e8e8e; margin-right: 2px; position: relative; overflow: hidden; }
        /* Hover：边框变虚线，颜色变红，文字变黑，边框宽度保持不变，防止布局抖动 */
        .history-item:hover { border-color: var(--red); border-style: dashed; color: #000000; }
        /* 选中项（最后一次点击）使用淡雅橙色 */
        .history-item.selected { color: #e67e22; }
        /* 置顶项文字永固黑色，优先级高于选中色，背景恢复浅色 base2 */
        .history-item.pinned { background: var(--base2); color: #000000 !important; }

        /* 卡片内扫光特效 */
        .history-item.executing::before {
            content: '';
            position: absolute;
            top: 0; left: -150%; width: 100%; height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent);
            z-index: 10;
            pointer-events: none;
            animation: card-flash 0.4s ease-out forwards;
        }
        @keyframes card-flash {
            0% { left: -150%; }
            100% { left: 150%; }
        }

        .search-container { margin: 3px 0 0 0; flex-shrink: 0; position: relative; }
        .search-input { width: 100%; background: var(--base2); border: 1px solid var(--border-color); border-radius: 4px; padding: 7.5px 10px; font-family: Tahoma, sans-serif; font-size: 13px; color: #000; outline: none; transition: 0.2s; box-sizing: border-box; }
        .search-input::selection { background: #FFD302; color: #000; }
        .search-input::placeholder { color: var(--vscode-input-placeholderForeground, rgba(0,0,0,0.5)); }
        .search-input:focus { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color); }

        .item-info { display: none; }
        .item-time { font-size: 13px; color: var(--base2); }
        .item-size { font-size: 13px; color: var(--base2); font-family: Tahoma, sans-serif; }
        .item-preview {
            font-size: 13px; font-family: Tahoma, sans-serif;
            white-space: pre-wrap; word-break: break-all;
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 6;
            -webkit-box-orient: vertical;
        }

        /* 光标跟随提示框 */
        #tooltip {
            position: fixed;
            pointer-events: none;
            background: rgb(35, 30, 0); /* 近乎黑色的土黄色，B=0 */
            color: var(--base2);
            padding: 4px 10px;
            border-radius: 4px;
            font-family: Tahoma, sans-serif;
            font-size: 13px;
            z-index: 9999;
            display: none;
            box-shadow: 0 1px 2px rgba(0,0,0,0.4);
            white-space: nowrap;
            border: 1px solid var(--primary-color);
            transform: translateX(-50%); /* 水平居中 */
        }
        .item-actions { margin-top: 5px; display: flex; gap: 5px; }

        .action-mini-btn { padding: 2px 6px; font-size: 13px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--base3); cursor: pointer; color: var(--text-primary); font-family: Tahoma, sans-serif; line-height: 1.2; }
        .action-mini-btn:hover { background: var(--primary-color); color: #fff; }

        .scrollbar-outer { position: absolute; right: 0; top: 0; width: 6px; height: 100%; z-index: 1000; pointer-events: none; }
        .scrollbar-outer-thumb { position: absolute; right: 1px; width: 4px; background: #000 !important; border-radius: 3px; opacity: 1; cursor: pointer; pointer-events: auto; forced-color-adjust: none !important; transition: width 0.1s ease, right 0.1s ease; }
        .scrollbar-outer-thumb:hover { width: 6px; right: 0; }

        .scrollbar-inner { position: absolute; right: 0; top: 0; width: 6px; height: 100%; z-index: 10; pointer-events: none; }
        .scrollbar-inner-thumb { position: absolute; right: 1px; width: 4px; background: var(--red) !important; border-radius: 3px; opacity: 0.5; cursor: pointer; pointer-events: auto; forced-color-adjust: none !important; transition: width 0.1s ease, right 0.1s ease, opacity 0.1s ease; }
        .scrollbar-inner-thumb:hover { width: 6px; right: 0; opacity: 1; }

        .empty-hint { text-align: center; padding: 20px; opacity: 0.5; }
        .footer-hint { text-align: center; padding: 9px 0; font-family: Tahoma, sans-serif; font-size: 9px; opacity: 0.5; }

        /* ★ 新增：命令历史下拉框样式 */
        .history-dropdown {
            display: none;
            position: absolute;
            border: 1px solid var(--primary-color);
            background-color: var(--base2);
            z-index: 1000;
            width: 777px;
            box-sizing: border-box;
            max-height: 150px;
            overflow-y: auto;
            border-radius: 4px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            top: 100%; /* Position below the input */
            left: 0;
        }
        .history-dropdown-item {
            padding: 6px 10px;
            cursor: pointer;
            color: #000;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: 13px;
            font-family: Tahoma, sans-serif;
            position: relative;
        }
        .history-dropdown-item:hover {
            background-color: var(--primary-color);
            color: var(--base2);
        }

    </style>
</head>
<body>
    <div class="main-wrapper">
        <div class="main-content" id="mainContent">
            <div class="captain-grid">
                <div class="cmd-btn" id="savorCard">
                    <div class="btn-group">
                        <button class="action-mini-btn" id="btnSavorLoop" title="Infinite Loop"><span class="icon-loop"></span></button>
                        <button class="action-mini-btn" id="btnSavorStop" title="Stop"><span class="icon-stop"></span></button>
                    </div>
                    <div class="text-content">
                        <span id="ms-label">Savor moments for yourself</span>
                        <span class="spacer-5"></span> <span class="spacer-5"></span>
                        <span id="ms-stats">${savorStats}</span>
                    </div>
                </div>
                <div class="cmd-btn" data-cmd="qqq.q1">
                    <div class="text-content">
                        &nbsp;Paste <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="icon-pen"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> ("Ctrl+V" or "F2") <span id="paste-stats">${pasteStats}</span>
                    </div>
                </div>
                <div class="cmd-btn" id="videoCard">
                    <div class="btn-group">
                        <div class="input-box-wrapper">
                            <input type="text" class="inline-input" id="videoInput" placeholder=" Video Url" spellcheck="false">
                            <button id="btnVideoStart"><span class="icon-play"></span></button>
                            <div class="error-tip" id="urlErrorTip">无效网址</div>
                             <!-- ★ 新增：video url 历史下拉框 -->
                            <div id="videoHistoryDropdown" class="history-dropdown"></div>
                        </div>
                    </div>
                    <span class="spacer-5"></span> <span class="spacer-5"></span>
                    <div class="text-content">
                        <span id="video-stats">${videoStats}</span>
                    </div>
                </div>
                <div class="cmd-btn" data-cmd="qqq.q2">
                    <div class="text-content">
                        <span class="icon-ufo"></span> <span class="spacer-5"></span> Roam <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span>  ("Tab" or "F6") <span id="roam-stats">${roamStats}</span>
                    </div>
                </div>
                <div class="cmd-btn" data-cmd="qqq.weave">
                    <div class="text-content">
                        &nbsp;Weave <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span id="weave-stats">${weaveStats}</span>
                    </div>
                </div>
                <div class="cmd-btn" data-cmd="qqq.exportDoc">
                    <div class="text-content">
                        &nbsp;export doc <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span>  <span id="exportDoc-stats">${exportDocStats}</span>
                    </div>
                </div>
                <div class="cmd-btn" data-cmd="qqq.pure">
                    <div class="text-content">
                        &nbsp;Pure <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span id="pure-stats">${pureStats}</span>
                    </div>
                </div>
                <div class="cmd-btn" data-cmd="qqq.exportZip">
                    <div class="text-content">
                        &nbsp;export Zip <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span id="exportZip-stats">${exportZipStats}</span>
                    </div>
                </div>
                <div class="cmd-btn" data-cmd="qqq.allSettings">
                    <div class="text-content"> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="icon-all-settings"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span> <span class="spacer-5"></span>  <span id="allSettings-stats">${allSettingsStats}</span>
                    </div>
                </div>
            </div>
            <div class="search-container">
                <input type="text" class="search-input" id="searchBox" placeholder="clipboard history" spellcheck="false">
                 <!-- ★ 新增：剪贴板 history 历史下拉框 -->
                <div id="searchHistoryDropdown" class="history-dropdown"></div>
            </div>
            <div class="history-container" id="historyContainer">
                <div class="history-list" id="historyList">
                    <div class="empty-hint">加载中...</div>
                </div>
                <div class="scrollbar-inner" id="innerScrollbar"><div class="scrollbar-inner-thumb" id="innerThumb"></div></div>
            </div>
            <div class="footer-hint">GH HEALTH</div>
        </div>
        <div class="scrollbar-outer" id="outerScrollbar"><div class="scrollbar-outer-thumb" id="outerThumb"></div></div>
        <div id="tooltip"></div>
    </div>
    <script nonce="${nonce}">
        (function() {
            // ---- ES5/老环境兜底：closest/matches polyfill ----
            if (!Element.prototype.matches) {
                Element.prototype.matches = Element.prototype.msMatchesSelector || Element.prototype.webkitMatchesSelector;
            }
            if (!Element.prototype.closest) {
                Element.prototype.closest = function(sel) {
                    var el0 = this;
                    while (el0 && el0.nodeType === 1) {
                        if (el0.matches && el0.matches(sel)) return el0;
                        el0 = el0.parentElement || el0.parentNode;
                    }
                    return null;
                };
            }
            // --------------------------------------------------

            var vscode = acquireVsCodeApi();
            var el = {
                historyContainer: document.getElementById('historyContainer'),
                historyList: document.getElementById('historyList'),
                tooltip: document.getElementById('tooltip'),
                searchBox: document.getElementById('searchBox'),
                savorCard: document.getElementById('savorCard'),
                btnSavorLoop: document.getElementById('btnSavorLoop'),
                btnSavorStop: document.getElementById('btnSavorStop'),
                msStats: document.getElementById('ms-stats'),
                pasteStats: document.getElementById('paste-stats'),
                videoCard: document.getElementById('videoCard'),
                videoInput: document.getElementById('videoInput'),
                btnVideoStart: document.getElementById('btnVideoStart'),
                videoStats: document.getElementById('video-stats'),
                roamStats: document.getElementById('roam-stats'),
                weaveStats: document.getElementById('weave-stats'),
                exportDocStats: document.getElementById('exportDoc-stats'),
                pureStats: document.getElementById('pure-stats'),
                exportZipStats: document.getElementById('exportZip-stats'),
                allSettingsStats: document.getElementById('allSettings-stats'),
                mainContent: document.getElementById('mainContent'),
                innerThumb: document.getElementById('innerThumb'),
                outerThumb: document.getElementById('outerThumb'),
                innerScrollbar: document.getElementById('innerScrollbar'),
                outerScrollbar: document.getElementById('outerScrollbar'),
                // ★ 新增：历史下拉框元素
                videoHistoryDropdown: document.getElementById('videoHistoryDropdown'),
                searchHistoryDropdown: document.getElementById('searchHistoryDropdown'),
            };

            var selectedId = '';
            var selectedIndex = -1;
            var currentHistory = [];
            var currentLimit = 0;
            var batchSize = 20;
            var currentStats = '${savorStats}';

            function post(cmd, data) {
                var d = data || {};
                d.command = cmd;
                vscode.postMessage(d);
            }

            // 禁用右键菜单
            window.addEventListener('contextmenu', function(e) { e.preventDefault(); });

            function initDynamicSizing() {
                var containerH = el.historyContainer.clientHeight;
                // 估算卡片平均高度
                batchSize = Math.max(10, Math.ceil(containerH / 120));
                if (currentLimit === 0) {
                    currentLimit = batchSize * 2;
                    post('requestData', { limit: currentLimit, keyword: el.searchBox.value });
                }
            }

            // ★ 新增：历史下拉框功能
            function hideAllDropdowns() {
                if (el.videoHistoryDropdown) el.videoHistoryDropdown.style.display = 'none';
                if (el.searchHistoryDropdown) el.searchHistoryDropdown.style.display = 'none';
            }

            function showHistoryDropdown(inputEl, dropdownEl, history) {
                hideAllDropdowns();
                if (!history || history.length === 0) {
                    return;
                }
                dropdownEl.innerHTML = '';
                history.forEach(function(itemText) {
                    var itemDiv = document.createElement('div');
                    itemDiv.className = 'history-dropdown-item';
                    itemDiv.textContent = itemText;
                    itemDiv.title = itemText;
                    itemDiv.onclick = function() {
                        inputEl.value = itemText;
                        hideAllDropdowns();
                        inputEl.focus();
                        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                    };
                    dropdownEl.appendChild(itemDiv);
                });
                dropdownEl.style.display = 'block';
            }

            // --- 修改/新增事件监听 ---

            // 显示/隐藏下拉框函数
            function toggleSearchDropdown(show) {
                if (show && el.searchBox.value.trim() === '') {
                    post('getHistory', { key: 'search' });
                } else if (!show) {
                    hideAllDropdowns();
                }
            }

            function toggleVideoDropdown(show) {
                if (show && el.videoInput.value.trim() === '') {
                    post('getHistory', { key: 'video' });
                } else if (!show) {
                    hideAllDropdowns();
                }
            }

            el.searchBox.oninput = function() {
                el.historyList.scrollTop = 0;
                el.tooltip.style.display = 'none';
                post('requestData', { limit: currentLimit, keyword: el.searchBox.value });
                // 空文本时显示下拉框，否则隐藏
                toggleSearchDropdown(el.searchBox.value.trim() === '');
            };

            el.searchBox.addEventListener('focus', function() {
                toggleSearchDropdown(true);
            });

            // blur 时立即隐藏下拉框
            el.searchBox.addEventListener('blur', function(e) {
                var relatedTarget = e.relatedTarget;
                var isDropdownElement = relatedTarget && el.searchHistoryDropdown.contains(relatedTarget);
                if (!isDropdownElement) {
                    hideAllDropdowns();
                }
            });

            // 点击下拉框时阻止冒泡，防止触发 blur
            if (el.searchHistoryDropdown) {
                el.searchHistoryDropdown.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                });
            }

            el.searchBox.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    var val = el.searchBox.value;
                    if (val.trim() !== '') {
                        post('saveHistory', { key: 'search', value: val });
                    }
                    hideAllDropdowns();
                } else if (e.key === 'Escape') {
                    hideAllDropdowns();
                } else if (e.key === ' ') {
                    // 空格键隐藏下拉框（空格不算无文本，所以隐藏）
                    hideAllDropdowns();
                }
            });


            el.historyList.onscroll = function() {
                var list = el.historyList;
                if (list.scrollTop + list.clientHeight > list.scrollHeight - 100) {
                    if (currentHistory.length >= currentLimit) {
                        currentLimit += batchSize;
                        post('requestData', { limit: currentLimit, keyword: el.searchBox.value });
                    }
                }
                updateAllScrollbars();
            };

            function renderList(history, triggerStorm) {
                var newHistory = history || [];
                if (triggerStorm) {
                    el.historyContainer.classList.remove('storm');
                    void el.historyContainer.offsetWidth;
                    el.historyContainer.classList.add('storm');
                }

                currentHistory = newHistory;
                el.historyList.innerHTML = '';
                el.tooltip.style.display = 'none';

                if (currentHistory.length === 0) {
                    el.historyList.innerHTML = '<div class="empty-hint">暂无记录</div>';
                    selectedId = '';
                    selectedIndex = -1;
                    setTimeout(updateAllScrollbars, 50);
                    return;
                }

                var frag = document.createDocumentFragment();
                currentHistory.forEach(function(item, idx) {
                    var div = document.createElement('div');
                    div.className = 'history-item';
                    if (item.id === selectedId) div.classList.add('selected');
                    if (item.pinned) div.classList.add('pinned');
                    div.dataset.id = item.id;
                    div.dataset.index = idx;

                    div.onmouseenter = function(e) {
                        el.tooltip.innerHTML = item.time;
                        el.tooltip.style.display = 'block';
                    };
                    div.onmousemove = function(e) {
                        el.tooltip.style.left = e.clientX + 'px';
                        el.tooltip.style.top = (e.clientY + 22) + 'px';
                    };
                    div.onmouseleave = function() {
                        el.tooltip.style.display = 'none';
                    };

                    var prev = document.createElement('div');
                    prev.className = 'item-preview';
                    prev.textContent = item.preview;

                    var actions = document.createElement('div');
                    actions.className = 'item-actions';

                    var btnPin = document.createElement('button');
                    btnPin.className = 'action-mini-btn';
                    btnPin.dataset.action = 'pin';
                    btnPin.textContent = item.pinned ? '📍' : '📌';

                    var btnDel = document.createElement('button');
                    btnDel.className = 'action-mini-btn';
                    btnDel.dataset.action = 'delete';
                    btnDel.textContent = '🗑️ ' + (item.size || 0).toLocaleString();

                    actions.appendChild(btnPin);
                    actions.appendChild(btnDel);
                    div.appendChild(prev);
                    div.appendChild(actions);
                    frag.appendChild(div);
                });
                el.historyList.appendChild(frag);

                if (selectedId) {
                    setSelectedById(selectedId);
                } else {
                    var first = el.historyList.querySelector('.history-item');
                    if (first) setSelectedById(first.dataset.id);
                }
                setTimeout(updateAllScrollbars, 50);
            }

            function setSelectedById(id) {
                selectedId = id;
                var items = el.historyList.querySelectorAll('.history-item');
                selectedIndex = -1;
                for (var i = 0; i < items.length; i++) {
                    var it = items[i];
                    if (it.dataset.id === selectedId) {
                        it.classList.add('selected');
                        selectedIndex = i;
                    } else {
                        it.classList.remove('selected');
                    }
                }
            }

            el.historyList.addEventListener('click', function(e) {
                var btn = e.target.closest('button[data-action]');
                var item = e.target.closest('.history-item');
                if (!item) return;
                var id = item.dataset.id;

                item.classList.remove('executing');
                void item.offsetWidth;
                item.classList.add('executing');

                if (btn) {
                    var action = btn.dataset.action;
                    if (action === 'copy') post('copyToClipboard', { itemId: id });
                    if (action === 'paste') post('pasteToEditor', { itemId: id });
                    if (action === 'insert') post('insertToEditor', { itemId: id });
                    if (action === 'delete') post('deleteHistoryItem', { itemId: id });
                    if (action === 'pin') post('togglePinHistoryItem', { itemId: id });
                    e.stopPropagation();
                    return;
                }
                setSelectedById(id);
                post('copyToClipboard', { itemId: id });
            });

            document.addEventListener('click', function(e) {
                var cmdBtn = e.target.closest('.cmd-btn');
                if (cmdBtn && cmdBtn.dataset.cmd) {
                    var cmd = cmdBtn.dataset.cmd;
                    post('executeCommand', { cmd: cmd });

                    // 记录通用命令的使用次数
                    var generics = ['qqq.weave', 'qqq.exportDoc', 'qqq.pure', 'qqq.exportZip', 'qqq.allSettings'];
                    for (var i = 0; i < generics.length; i++) {
                        if (generics[i] === cmd) {
                            var type = cmd.split('.')[1];
                            post('recordGenericUsage', { type: type });
                            break;
                        }
                    }
                }
            });

            el.savorCard.onclick = function() { post('requestSavorAudio', { mode: 'normal' }); };
            el.btnSavorLoop.onclick = function(e) { e.stopPropagation(); post('requestSavorAudio', { mode: 'loop' }); };
            el.btnSavorStop.onclick = function(e) { e.stopPropagation(); post('requestSavorAudio', { mode: 'stop' }); };

            // ★ 统一真理源：从 global.js 嵌入
            var isValidUrl = ${this._global.isValidUrl.toString()};

            function showErrorTip() {
                var tip = document.getElementById('urlErrorTip');
                if (tip) {
                    tip.style.display = 'block';
                    setTimeout(function() { tip.style.display = 'none'; }, 2000);
                }
                el.videoInput.className = 'inline-input invalid';
            }

            el.videoInput.oninput = function() {
                el.videoInput.className = 'inline-input';
                // 空文本时显示下拉框，否则隐藏
                toggleVideoDropdown(el.videoInput.value.trim() === '');
            };

            el.videoInput.addEventListener('focus', function() {
                toggleVideoDropdown(true);
            });

            // blur 时立即隐藏下拉框
            el.videoInput.addEventListener('blur', function(e) {
                var relatedTarget = e.relatedTarget;
                var isDropdownElement = relatedTarget && el.videoHistoryDropdown.contains(relatedTarget);
                if (!isDropdownElement) {
                    hideAllDropdowns();
                }
            });

            // 点击下拉框时阻止冒泡，防止触发 blur
            if (el.videoHistoryDropdown) {
                el.videoHistoryDropdown.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                });
            }

            el.videoInput.onkeydown = function(e) {
                if (e.key === 'Enter') {
                    var val = el.videoInput.value.trim();
                    if (isValidUrl(val)) {
                        post('executeCommand', { cmd: 'qqq.downloadVideosFromUrl', args: [val] });
                        post('saveHistory', { key: 'video', value: val }); // ★ 保存历史
                        el.videoInput.value = '';
                    } else if (val) { showErrorTip(); }
                    hideAllDropdowns();
                } else if (e.key === 'Escape') {
                    hideAllDropdowns();
                } else if (e.key === ' ') {
                    // 空格键隐藏下拉框（空格不算无文本，所以隐藏）
                    hideAllDropdowns();
                }
                e.stopPropagation();
            };
            el.btnVideoStart.onclick = function(e) {
                e.stopPropagation();
                var val = el.videoInput.value.trim();
                if (isValidUrl(val)) {
                    post('executeCommand', { cmd: 'qqq.downloadVideosFromUrl', args: [val] });
                    post('saveHistory', { key: 'video', value: val }); // ★ 保存历史
                    el.videoInput.value = '';
                } else if (val) { showErrorTip(); }
            };
            el.videoCard.onclick = function() { el.videoInput.focus(); };

            window.addEventListener('message', function(e) {
                var m = e.data;
                if (!m) return;

                // ★ 新增：处理接收到的历史数据
                if (m.command === 'historyData') {
                    if (m.key === 'video') {
                        showHistoryDropdown(el.videoInput, el.videoHistoryDropdown, m.history);
                    } else if (m.key === 'search') {
                        showHistoryDropdown(el.searchBox, el.searchHistoryDropdown, m.history);
                    }
                    return; // 尽早返回
                }

                if (m.command === 'updateData') {
                    if (m.fullStats !== undefined && el.searchBox) {
                        el.searchBox.placeholder = 'clipboard history                                  ' + m.fullStats;
                    }
                    if (m.savorStats !== undefined) { currentStats = m.savorStats; updateSavorText(); }
                    if (m.pasteStats !== undefined && el.pasteStats) el.pasteStats.textContent = m.pasteStats;
                    if (m.videoStats !== undefined && el.videoStats) el.videoStats.textContent = m.videoStats;
                    if (m.roamStats !== undefined && el.roamStats) el.roamStats.textContent = m.roamStats;
                    if (m.weaveStats !== undefined && el.weaveStats) el.weaveStats.textContent = m.weaveStats;
                    if (m.exportDocStats !== undefined && el.exportDocStats) el.exportDocStats.textContent = m.exportDocStats;
                    if (m.pureStats !== undefined && el.pureStats) el.pureStats.textContent = m.pureStats;
                    if (m.exportZipStats !== undefined && el.exportZipStats) el.exportZipStats.textContent = m.exportZipStats;
                    if (m.allSettingsStats !== undefined && el.allSettingsStats) el.allSettingsStats.textContent = m.allSettingsStats;
                    renderList(m.history, m.triggerStorm);
                } else if (m.command === 'playAudio') {
                    playAudio(m.base64, m.count);
                } else if (m.command === 'playSfx') {
                    playSfx(m.base64);
                } else if (m.command === 'stopAudio') {
                    stopAudio();
                }
            });

            var currentAudio = null;
            var currentSfx = null;
            var loopRemaining = 0;
            var playStartTime = 0;
            var fadeTimer = null;  // ★ 淡出定时器，移到全局以便 stopAudio 清理

            function playSfx(base64) {
                if (currentSfx) { currentSfx.pause(); currentSfx = null; }
                var audio = new Audio('data:audio/mp3;base64,' + base64);
                currentSfx = audio;
                audio.play();
            }

            function updateSavorText() {
                var elLabel = document.getElementById('ms-label');
                var elStats = document.getElementById('ms-stats');
                if (!elLabel || !elStats) return;
                elStats.innerText = currentStats;

                // 纯净叙事：不显示文件名
                if (window.__isPlaying) {
                    if (loopRemaining === -1 || loopRemaining === 0) {
                        elLabel.innerText = 'Looping...';
                    } else {
                        elLabel.innerText = 'Savoring...';
                    }
                } else {
                    elLabel.innerText = 'Savor moments for yourself';
                }
            }

            function stopAudio() {
                window.__isPlaying = false;
                // ★ 清理淡出定时器
                if (fadeTimer) {
                    clearInterval(fadeTimer);
                    fadeTimer = null;
                }
                if(currentAudio) {
                    currentAudio.pause();
                    if (playStartTime > 0) {
                        var dur = Date.now() - playStartTime;
                        if (dur > 500) post('recordSavorUsage', { durationMs: dur });
                    }
                    currentAudio.onended = null;
                    currentAudio.ontimeupdate = null;
                    currentAudio = null;
                    playStartTime = 0;
                }
                updateSavorText();
                var iconLoop = document.querySelector('.icon-loop');
                if (iconLoop) iconLoop.classList.remove('spinning');
            }

            function playAudio(base64, count) {
                stopAudio();
                window.__isPlaying = true;
                // ★ 修复：count=0 表示无限循环，不能用 || 操作符
                loopRemaining = (count === undefined || count === null) ? 1 : count;

                // ★ 先更新文字和图标状态
                updateSavorText();
                if (loopRemaining === -1 || loopRemaining === 0) {
                    var iconLoop = document.querySelector('.icon-loop');
                    if (iconLoop) iconLoop.classList.add('spinning');
                }

                // ★ 如果没有 base64，说明是 Python 引擎播放，只更新 UI 状态
                if (!base64) {
                    return;
                }

                var audio = new Audio('data:audio/mp3;base64,' + base64);
                currentAudio = audio;
                playStartTime = Date.now();

                audio.onended = function() {
                    if (loopRemaining === -1 || loopRemaining === 0) {
                        audio.currentTime = 0;
                        audio.play();
                    } else if (loopRemaining > 1) {
                        loopRemaining--;
                        audio.currentTime = 0;
                        audio.play();
                    } else {
                        stopAudio(); // 正常结束，不淡出或由 ontimeupdate 预处理
                    }
                };

                // ★ 淡出条件：限定次数播放的最后一次，且时长 > 2秒
                audio.ontimeupdate = function() {
                    if (loopRemaining === 1 && audio.duration > 2 && audio.currentTime > audio.duration - 2.2) {
                        audio.ontimeupdate = null; // 触发后立即卸载，由高频 Timer 接管
                        if (fadeTimer) return;

                        fadeTimer = setInterval(function() {
                            var rem = audio.duration - audio.currentTime;
                            if (rem <= 0 || !window.__isPlaying) {
                                clearInterval(fadeTimer);
                                fadeTimer = null;
                                return;
                            }
                            audio.volume = Math.max(0, Math.min(1, rem / 2.0));
                        }, 20); // 50Hz 高频淡出
                    }
                };

                audio.play();
            }

            function setupScrollbar(container, scrollbar, thumb) {
                function update() {
                    var ch = container.clientHeight, sh = container.scrollHeight, st = container.scrollTop;
                    if (sh > ch) {
                        scrollbar.style.display = 'block';
                        var th = Math.max(20, (ch / sh) * ch);
                        thumb.style.height = th + 'px';
                        thumb.style.top = (st / (sh - ch)) * (ch - th) + 'px';
                    } else { scrollbar.style.display = 'none'; }
                }
                container.addEventListener('scroll', update);
                var isDragging = false, startY, startST;
                thumb.onmousedown = function(e) {
                    isDragging = true; startY = e.clientY; startST = container.scrollTop;
                    document.onmousemove = function(e) {
                        if (!isDragging) return;
                        var dy = e.clientY - startY;
                        var ch = container.clientHeight, sh = container.scrollHeight, th = thumb.offsetHeight;
                        container.scrollTop = startST + (dy / (ch - th)) * (sh - ch);
                    };
                    document.onmouseup = function() { isDragging = false; document.onmousemove = null; };
                    e.preventDefault();
                };
                return update;
            }
            var upO = setupScrollbar(el.mainContent, el.outerScrollbar, el.outerThumb);
            var upI = setupScrollbar(el.historyList, el.innerScrollbar, el.innerThumb);
            function updateAllScrollbars() { upO(); upI(); }
            window.onresize = function() { initDynamicSizing(); updateAllScrollbars(); };
            setTimeout(initDynamicSizing, 100);
            window.addEventListener('focus', function() { post('focusState', { focused: true }); });
            window.addEventListener('blur', function() { post('focusState', { focused: false }); });
            post('ready');
        })();
    </script>
</body>
</html>`;
    }

    // ★ 新增：供 activate() 的 subscriptions 安全调用，且解绑 pythonBridge 监听避免热重载堆监听
    dispose() {
        try { this._stopPeriodicUpdate(); } catch { }
        try {
            if (this._onPythonEvent && this._global?.pythonBridge) {
                if (typeof this._global.pythonBridge.off === 'function') {
                    this._global.pythonBridge.off('event', this._onPythonEvent);
                } else if (typeof this._global.pythonBridge.removeListener === 'function') {
                    this._global.pythonBridge.removeListener('event', this._onPythonEvent);
                }
            }
        } catch { }
        this._onPythonEvent = null;
        this._view = null;
    }
}

// ============================================================================
// 维护与辅助工具
// ============================================================================

async function searchHistoryCommand(historyManager) {
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = '键入搜索';

    const META_COMMANDS = [
        { label: '📦 全量导出', detail: 'Full Export (JSON)', cmd: 'qqq.exportHistory' },
        { label: '📥 增量导入', detail: 'Incremental Import (JSON)', cmd: 'qqq.importHistory' }
    ];

    const updateItems = (keyword) => {
        const kw = keyword.trim().toLowerCase();
        let items = [];

        // 1. 处理指令匹配
        if (!kw) {
            items.push({ label: '--- 指令 COMMANDS ---', kind: vscode.QuickPickItemKind.Separator });
            items.push(...META_COMMANDS);
        } else {
            const matchedCmds = META_COMMANDS.filter(c =>
                c.label.toLowerCase().includes(kw) ||
                c.detail.toLowerCase().includes(kw)
            );
            if (matchedCmds.length > 0) {
                items.push({ label: '--- 匹配指令 MATCHED ---', kind: vscode.QuickPickItemKind.Separator });
                items.push(...matchedCmds);
            }
        }

        // 2. 处理历史记录
        const limit = kw ? 100 : 171;
        const results = historyManager.searchHistory(kw, limit);

        if (results.length > 0) {
            items.push({ label: '--- 历史记录 HISTORY ---', kind: vscode.QuickPickItemKind.Separator });
            items.push(...results.map(it => ({
                label: it.preview,
                detail: ` ${formatTime(it.timestamp)}   📏 ${(it.size || 0).toLocaleString()}b`,
                id: it.id,
                content: it.content,
                isHistory: true
            })));
        }

        quickPick.items = items;
    };

    quickPick.onDidChangeValue(value => updateItems(value));

    quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (selected) {
            if (selected.isHistory) {
                const node = historyManager.getItemById(selected.id);
                if (node) {
                    await historyManager.copyToClipboard(node.content);
                    await historyManager.recordCopyUsage();
                    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
                }
            } else if (selected.cmd) {
                if (selected.cmd === 'qqq.qsc_all') {
                    await qsc(0, historyManager);
                } else if (selected.cmd !== 'qqq.clipboardHistory') {
                    vscode.commands.executeCommand(selected.cmd);
                }
            }
            quickPick.hide();
        }
    });

    quickPick.onDidHide(() => quickPick.dispose());

    updateItems('');
    quickPick.show();
}

async function exportHistoryCommand(historyManager) {
    const uri = await vscode.window.showSaveDialog({
        title: '全量导出剪贴板历史 (JSON)',
        filters: { 'JSON': ['json'] },
        defaultUri: vscode.Uri.file(`q4-history-${Date.now()}.json`)
    });
    if (!uri) return;

    try {
        const data = {
            version: 4,
            exportedAt: Date.now(),
            history: historyManager._toArrayAll()
        };
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
        vscode.window.showInformationMessage('📦 历史记录已全量导出');
    } catch (e) {
        vscode.window.showErrorMessage('导出失败: ' + e.message);
    }
}

async function importHistoryCommand(historyManager) {
    const uris = await vscode.window.showOpenDialog({
        title: '增量导入剪贴板历史 (JSON)',
        canSelectMany: false,
        filters: { 'JSON': ['json'] }
    });
    if (!uris || !uris[0]) return;

    try {
        const buf = await vscode.workspace.fs.readFile(uris[0]);
        const parsed = JSON.parse(buf.toString());
        const arr = Array.isArray(parsed) ? parsed : (parsed.history || []);

        let count = 0;
        for (const item of arr) {
            if (item.content) {
                // 内部 addToHistory 会自动进行 MD5 哈希查重，实现“增量”
                await historyManager.addToHistory(item.content);
                count++;
            }
        }
        vscode.window.showInformationMessage(`📥 成功增量导入 ${count} 条记录`);
    } catch (e) {
        vscode.window.showErrorMessage('导入失败: ' + e.message);
    }
}

function showStatsCommand(historyManager) {
    const snap = historyManager.getStatsSnapshot();

    const message = [
        `📊 剪贴板历史统计`,
        ``,
        `总记录数: ${snap.historyCount}`,
        `监听中: ${snap.isWatching ? '是' : '否'}`,
        `会话时长: ${snap.uptime.h}h ${snap.uptime.m}m`,
        `物理文件隔离数: ${snap.perf.quarantinedFiles}`,
    ].join('\n');

    vscode.window.showInformationMessage(message, { modal: true });
}

// ============================================================================
// 复制选中内容到历史
// ============================================================================
async function copyToHistoryCommand(historyManager) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('没有活动的编辑器');
        return;
    }

    const selection = editor.selection;
    const text = editor.document.getText(selection);

    if (!text || text.trim() === '') {
        vscode.window.showWarningMessage('没有选中任何文本');
        return;
    }

    await historyManager.copyToClipboard(text);
    await historyManager.addToHistory(text);
    // vscode.window.showInformationMessage('已复制到剪贴板并添加到历史');
}

// ============================================================================
// 状态栏项
// ============================================================================
class StatusBarManager {
    /**
     * @param {ClipboardHistoryManager} historyManager
     */
    constructor(historyManager) {
        this._historyManager = historyManager;

        this._statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );

        this._statusBarItem.command = 'qqq.clipboardHistory';
        this._statusBarItem.tooltip = '点击搜索/粘贴剪贴板历史';
        this._updateTimer = null;

        this._update();
        this._startAutoUpdate();
    }

    _update() {
        const count = this._historyManager ? this._historyManager._size : 0;
        this._statusBarItem.text = `$(clippy) ${count}`;
        this._statusBarItem.show();
    }

    _startAutoUpdate() {
        this._updateTimer = setInterval(() => this._update(), 5000);
    }

    refresh() { this._update(); }

    dispose() {
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
            this._updateTimer = null;
        }
        this._statusBarItem.dispose();
    }
}

// ============================================================================
// 终极维护工具 qsc(a)
// ============================================================================
/**
 * @param {number} a 清理级别：1-缓存, 2-剪切板, 3-globalState, 0-全清
 * @param {ClipboardHistoryManager} historyManager
 */
async function qsc(a, historyManager) {
    const context = historyManager?.context;
    console.log(`[QSC] 执行清理任务，级别: ${a}`);

    // 1. 清理 qqq_cache 文件夹
    const clearCache = async () => {
        try {
            const root = context?.globalStorageUri?.fsPath;
            if (!root) return;
            const cacheDir = path.join(root, 'qqq_cache');
            if (fs.existsSync(cacheDir)) {
                const files = fs.readdirSync(cacheDir);
                for (const file of files) {
                    const filePath = path.join(cacheDir, file);
                    try {
                        if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
                    } catch { }
                }
                console.log('[QSC] qqq_cache 已清空');
            }
        } catch (e) { console.error('[QSC] 清理 cache 失败:', e.message); }
    };

    // 2. 清空剪切板历史
    const clearHistory = async () => {
        if (historyManager) {
            await historyManager.clearHistory({ deleteFiles: true });
            console.log('[QSC] 剪切板历史已清空');
        }
    };

    // 3. 清空 globalState (高危操作)
    const clearGlobalState = async () => {
        if (!context?.globalState) return;
        try {
            const keys = ['qqq.transactions', 'qqq_config', 'qqq_clipboard_history', 'qqq_history_manager_state', 'qqq.transactions.backup'];
            for (const key of keys) {
                await context.globalState.update(key, undefined);
            }
            console.log('[QSC] globalState 已清空');
        } catch (e) { console.error('[QSC] 清理 globalState 失败:', e.message); }
    };

    if (a === 1) await clearCache();
    else if (a === 2) await clearHistory();
    else if (a === 3) await clearGlobalState();
    else if (a === 0) {
        await clearCache();
        await clearHistory();
        await clearGlobalState();
    }
}

// ============================================================================
// 扩展激活入口
// ============================================================================
function activate(context) {
    console.log('[Q4] QQQ Clipboard History (fusion-final) activating...');

    let sidebarProvider = null;
    let statusBarManager = null;

    const historyManager = new ClipboardHistoryManager(context, {
        onChange: (reason) => {
            if (sidebarProvider) sidebarProvider.updateContent(reason);
            if (statusBarManager) statusBarManager.refresh();
        },
    });

    // ★ 终极最优解：同步记录当前实例，供 deactivate 强杀
    _currentHistoryManager = historyManager;

    historyManager.startWatching();

    // 修复实例化：传入 context, historyManager 和 global 模块
    sidebarProvider = new ClipboardHistorySidebarProvider(context, historyManager, global);
    _currentSidebarProvider = sidebarProvider;  // ★ 记录当前实例

    const sidebarDisposable = vscode.window.registerWebviewViewProvider(
        'qqq.Viewq',
        sidebarProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
    );
    context.subscriptions.push(sidebarDisposable);

    statusBarManager = new StatusBarManager(historyManager);
    context.subscriptions.push(statusBarManager);

    // 命令注册
    context.subscriptions.push(
        vscode.commands.registerCommand('qqq.qsc', async () => {
            const input = await vscode.window.showInputBox({
                placeHolder: '级别: 1-缓存, 2-历史, 3-State, 0-全清',
                prompt: '执行 QSC 终极清理'
            });
            if (input !== undefined) await qsc(parseInt(input, 10), historyManager);
        }),
        vscode.commands.registerCommand('qqq.clipboardHistory', () => searchHistoryCommand(historyManager)),
        vscode.commands.registerCommand('qqq.exportHistory', () => exportHistoryCommand(historyManager)),
        vscode.commands.registerCommand('qqq.importHistory', () => importHistoryCommand(historyManager)),
        vscode.commands.registerCommand('qqq.showStats', () => showStatsCommand(historyManager)),
        vscode.commands.registerCommand('qqq.copyToHistory', () => copyToHistoryCommand(historyManager))
    );

    // 清理
    context.subscriptions.push({
        dispose: () => {
            historyManager.dispose().catch(() => { });
            if (sidebarProvider) sidebarProvider.dispose();
            if (statusBarManager) statusBarManager.dispose();
        },
    });

    console.log('[Q4] QQQ Clipboard History (fusion-final) activated.');

    return {
        getHistory: (limit) => historyManager.getHistory(limit),
        addToHistory: (content) => historyManager.addToHistory(content),
        searchHistory: (keyword, limit) => historyManager.searchHistory(keyword, limit),
        clearHistory: () => historyManager.clearHistory(),
        getStats: () => historyManager.getStatsSnapshot(),
        qsc: (a) => qsc(a, historyManager),
        recordRoamUsage: (args) => historyManager.recordRoamUsage(args),
        sidebarProvider: sidebarProvider // ★ 返回 sidebarProvider 实例
    };
}

// ============================================================================
// 扩展停用（全生命周期强杀保护）
// ============================================================================
async function deactivate() {
    console.log('[Q4] QQQ Clipboard History (fusion-final) deactivating...');
    if (_currentHistoryManager) {
        try {
            await _currentHistoryManager.dispose();
        } catch (e) {
            console.error('[Q4] Dispose 强杀失败:', e.message);
        }
        _currentHistoryManager = null;
    }
}

// ============================================================================
// 导出
// ============================================================================

/**
 * ★ 重置 Q4 的音频源状态（当 Python 环境"从无到有"时调用）
 */
function resetQ4AudioSource() {
    if (_currentSidebarProvider && typeof _currentSidebarProvider.resetAudioSource === 'function') {
        _currentSidebarProvider.resetAudioSource();
    }
}

module.exports = {
    activate,
    deactivate,
    ClipboardHistoryManager,
    ClipboardHistorySidebarProvider,
    resetQ4AudioSource,  // ★ 导出重置函数
};



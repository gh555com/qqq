// ============================================================================
// Q4.js - QQQ Clipboard History Ultimate Fusion (A+Q Final Value Edition)
// 作者: 的梦 (q)
// 版本: 4.0.0-fusion-final
//
// ✅ Solarized Dark + 暗金配色（强制自定义颜色）
// ✅ forced-color-adjust: none 破 Windows 高对比度主题（保证自定义配色可见）
// ✅ 已彻底移除一切 VS Code globalState / workspaceState 相关代码与迁移/清理逻辑（向前看，不兼容历史）
// ✅ CSP 安全：全 nonce，无 unsafe-inline，无内联事件
// ✅ O(1) 去重/查找：hashMap + idMap + 双向链表（move-to-front）
// ✅ 文件持久化：globalStorageUri + gzip + (msgpack 可选) + 原子写 + 损坏隔离
// ✅ 功能：搜索、导入/导出、复制、粘贴、插入编辑器、QuickPick、统计、状态栏
// ============================================================================

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const global = require('./global');

// ★ 终极最优解：全局实例追踪，用于生命周期强杀
let _currentHistoryManager = null;
const zlib = require('zlib');
const { performance } = require('perf_hooks');

// ============================================================================
// 常量
// ============================================================================
const CONSTANTS = Object.freeze({
    VERSION: 4,

    // 存储
    STORAGE_DIR: 'clipboard-history',
    FILE_BIN_GZ: 'history.bin.gz',
    FILE_JSON_GZ: 'history.json.gz',

    // 限制
    MAX_HISTORY_ITEMS: 100,
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

    // 自动清理
    AUTO_CLEANUP_DAYS: 30,
    AUTO_CLEANUP_INTERVAL_MS: 24 * 60 * 60 * 1000,

    // watchdog
    WATCHDOG_REFRESH_MS: 30000,
    WATCHDOG_STALE_MS: 15000,

    // 时间
    MS_PER_MINUTE: 60 * 1000,
    MS_PER_HOUR: 60 * 60 * 1000,
    MS_PER_DAY: 24 * 60 * 60 * 1000,
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
        // eslint-disable-next-line global-require
        _msgpack = require('msgpack-lite');
    } catch {
        _msgpack = null;
    }
    return _msgpack;
}

// ============================================================================
// 工具函数
// ============================================================================
function randomId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
}
function md5Hex(s) {
    return crypto.createHash('md5').update(String(s)).digest('hex');
}
function nonceHex() {
    return crypto.randomBytes(16).toString('hex');
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
        if (mp) return Buffer.from(mp.encode(obj)).length;
        return Buffer.byteLength(JSON.stringify(obj), 'utf8');
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

    if (diff < CONSTANTS.MS_PER_MINUTE) return '刚刚';
    if (diff < CONSTANTS.MS_PER_HOUR) return `${Math.floor(diff / CONSTANTS.MS_PER_MINUTE)}分钟前`;
    if (diff < CONSTANTS.MS_PER_DAY) return `${Math.floor(diff / CONSTANTS.MS_PER_HOUR)}小时前`;
    if (diff < 7 * CONSTANTS.MS_PER_DAY) return `${Math.floor(diff / CONSTANTS.MS_PER_DAY)}天前`;
    return new Date(t).toLocaleDateString('zh-CN');
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
// ClipboardHistoryManager
// ============================================================================
class ClipboardHistoryManager {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {{ onChange?: Function }=} opts
     */
    constructor(context, opts = {}) {
        this.context = context;

        /** @type {HistoryNode|null} */
        this._head = null;
        /** @type {HistoryNode|null} */
        this._tail = null;
        this._size = 0;

        this._idMap = new Map();   // id -> node
        this._hashMap = new Map(); // hash -> node

        // 快照缓存
        this._version = 0;
        this._snapshotVersion = -1;
        /** @type {Array<any>|null} */
        this._snapshotAll = null;

        // UI/Search 缓存（轻量）
        this._cache = {
            version: -1,
            uiLimit: -1,
            uiList: null,
            uiBytes: 0,
            lastSearchKey: '',
            searchList: null,
            searchBytes: 0,
            hit: 0,
            miss: 0,
            maxBytes: 25 * 1024 * 1024, // 25MB
        };

        // 存储
        this._storageDir = null;
        this._fileBinGz = null;
        this._fileJsonGz = null;

        // 序列化策略：优先 msgpack（若存在）
        this._preferMsgpack = !!getMsgpack();

        // 保存：串行 + 节流/批处理
        this._saveChain = Promise.resolve();
        this._saveTimer = null;
        this._pendingChanges = 0;
        this._dirty = false;

        // 监听剪贴板
        this._clipboardTimer = null;
        this._isWatching = false;
        this._watcherBusy = false;
        this._lastClipboardContent = '';

        // 自动清理
        this._cleanupTimer = null;

        // 回调
        this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

        // 性能统计
        this.perfStats = {
            saveTimeMs: 0,
            loadTimeMs: 0,
            addTimeMs: 0,
            removeTimeMs: 0,
            clearTimeMs: 0,
            operations: 0,
            lastSaveBytes: 0,
            lastLoadBytes: 0,
            quarantinedFiles: 0,
        };

        // 会话开始时间（不用任何 state，纯内存）
        this.sessionStartedAt = Date.now();

        this._initStorage();
        this._initHistory().catch(() => { });
        this._startAutoCleanup();
    }

    _initStorage() {
        try {
            const root = this.context.globalStorageUri?.fsPath;
            if (!root) throw new Error('globalStorageUri 不可用');

            this._storageDir = path.join(root, CONSTANTS.STORAGE_DIR);
            fs.mkdirSync(this._storageDir, { recursive: true });

            this._fileBinGz = path.join(this._storageDir, CONSTANTS.FILE_BIN_GZ);
            this._fileJsonGz = path.join(this._storageDir, CONSTANTS.FILE_JSON_GZ);
        } catch {
            this._storageDir = null;
            this._fileBinGz = null;
            this._fileJsonGz = null;
        }
    }

    async _initHistory() {
        const t0 = performance.now();
        try {
            await this._loadHistory();
            this._cleanupExpiredItems();
        } finally {
            this.perfStats.loadTimeMs += (performance.now() - t0);
            this.perfStats.operations++;
        }
    }

    _startAutoCleanup() {
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        this._cleanupTimer = setInterval(() => {
            try {
                // ★ 终极最优解：红灯预检
                if (global.isDeactivated?.()) return;
                const changed = this._cleanupExpiredItems();
                if (changed) this.requestSave();
            } catch {
                // ignore
            }
        }, CONSTANTS.AUTO_CLEANUP_INTERVAL_MS);
    }

    _cleanupExpiredItems() {
        const cutoff = Date.now() - CONSTANTS.AUTO_CLEANUP_DAYS * CONSTANTS.MS_PER_DAY;
        let changed = false;

        while (this._tail && this._tail.timestamp < cutoff) {
            this._removeNode(this._tail);
            changed = true;
        }

        if (changed) this._touch();
        return changed;
    }

    _touch() {
        this._version++;
        this._snapshotVersion = -1;
        this._snapshotAll = null;

        this._cache.version = -1;
        this._cache.uiList = null;
        this._cache.searchList = null;
        this._cache.uiBytes = 0;
        this._cache.searchBytes = 0;
    }

    _resetInMemory() {
        this._head = null;
        this._tail = null;
        this._size = 0;
        this._idMap.clear();
        this._hashMap.clear();
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

        node.prev = null;
        node.next = null;

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
        if (!this._tail) this._tail = node;
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
                type: cur.type,
                preview: cur.preview,
                contentLength: cur.contentLength,
                hash: cur.hash,
            });
            cur = cur.next;
        }

        this._snapshotAll = arr;
        this._snapshotVersion = this._version;
        return arr;
    }

    getHistory(limit = CONSTANTS.UI_HISTORY_LIMIT) {
        const lim = clampInt(limit, 1, CONSTANTS.MAX_HISTORY_ITEMS);

        if (this._cache.uiList && this._cache.version === this._version && this._cache.uiLimit === lim) {
            this._cache.hit++;
            return this._cache.uiList;
        }
        this._cache.miss++;

        const out = [];
        let cur = this._head;
        while (cur && out.length < lim) {
            out.push({
                id: cur.id,
                content: cur.content,
                timestamp: cur.timestamp,
                type: cur.type,
                preview: cur.preview,
                contentLength: cur.contentLength,
                hash: cur.hash,
            });
            cur = cur.next;
        }

        const bytes = estimateBytes(out);
        if (bytes <= this._cache.maxBytes) {
            this._cache.uiList = out;
            this._cache.uiLimit = lim;
            this._cache.version = this._version;
            this._cache.uiBytes = bytes;
        }
        return out;
    }

    searchHistory(keyword, limit = CONSTANTS.UI_HISTORY_LIMIT) {
        const kw = String(keyword || '').trim();
        const lim = clampInt(limit, 1, CONSTANTS.MAX_HISTORY_ITEMS);
        if (!kw) return this.getHistory(lim);

        const cacheKey = `${this._version}|${lim}|${kw.toLowerCase()}`;
        if (this._cache.searchList && this._cache.lastSearchKey === cacheKey) {
            this._cache.hit++;
            return this._cache.searchList;
        }
        this._cache.miss++;

        const needle = kw.toLowerCase();
        const out = [];
        let cur = this._head;
        while (cur && out.length < lim) {
            const hay = (cur.content || '').toLowerCase();
            if (hay.includes(needle)) {
                out.push({
                    id: cur.id,
                    content: cur.content,
                    timestamp: cur.timestamp,
                    type: cur.type,
                    preview: cur.preview,
                    contentLength: cur.contentLength,
                    hash: cur.hash,
                });
            }
            cur = cur.next;
        }

        const bytes = estimateBytes(out);
        if (bytes <= this._cache.maxBytes) {
            this._cache.searchList = out;
            this._cache.searchBytes = bytes;
            this._cache.lastSearchKey = cacheKey;
        }
        return out;
    }

    getItemById(id) {
        return this._idMap.get(String(id || ''));
    }

    async addToHistory(content) {
        const t0 = performance.now();
        try {
            if (typeof content !== 'string') return;
            let text = content;
            if (!text || REGEX.WHITESPACE_ONLY.test(text)) return;

            if (text.length > CONSTANTS.MAX_CONTENT_LENGTH) {
                text = text.slice(0, CONSTANTS.MAX_CONTENT_LENGTH);
            }

            // watcher 同轮重复跳过
            if (text === this._lastClipboardContent) return;

            const hash = md5Hex(text);
            const existed = this._hashMap.get(hash);

            if (existed) {
                existed.timestamp = Date.now();
                existed.content = text;
                existed.contentLength = text.length;
                existed.preview = makePreview(text);
                this._moveToHead(existed);
            } else {
                /** @type {HistoryNode} */
                const node = {
                    id: randomId(),
                    content: text,
                    timestamp: Date.now(),
                    type: 'text',
                    preview: makePreview(text),
                    contentLength: text.length,
                    hash,
                    prev: null,
                    next: null,
                };

                this._insertHead(node);
                this._idMap.set(node.id, node);
                this._hashMap.set(hash, node);

                if (this._size > CONSTANTS.MAX_HISTORY_ITEMS) {
                    this._popTail();
                }
            }

            this._lastClipboardContent = text;
            this._touch();
            this._notifyChange();

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
            this._notifyChange();
            this.requestSave();
            return true;
        } catch {
            return false;
        } finally {
            this.perfStats.removeTimeMs += (performance.now() - t0);
            this.perfStats.operations++;
        }
    }

    async clearHistory({ deleteFiles = true, writeEmptyFile = true } = {}) {
        const t0 = performance.now();
        try {
            this._resetInMemory();
            this._notifyChange();

            if (deleteFiles) {
                const targets = [this._fileBinGz, this._fileJsonGz].filter(Boolean);
                for (const fp of targets) {
                    try {
                        if (fp && fs.existsSync(fp)) await fs.promises.unlink(fp);
                    } catch {
                        // ignore
                    }
                }
            }

            if (writeEmptyFile) {
                this._dirty = true;
                await this.forceSave();
            }

            return true;
        } finally {
            this.perfStats.clearTimeMs += (performance.now() - t0);
            this.perfStats.operations++;
        }
    }

    startWatching() {
        if (this._isWatching) return;
        this._isWatching = true;
        this._lastClipboardContent = '';

        this._clipboardTimer = setInterval(async () => {
            // ★ 终极最优解：红灯预检，防止插件停用后继续执行
            if (global.isDeactivated?.() || this._watcherBusy) return;
            this._watcherBusy = true;
            try {
                const cur = await vscode.env.clipboard.readText();
                if (cur && cur !== this._lastClipboardContent) {
                    await this.addToHistory(cur);
                }
            } catch {
                // ignore
            } finally {
                this._watcherBusy = false;
            }
        }, CONSTANTS.CLIPBOARD_POLL_MS);
    }

    stopWatching() {
        if (this._clipboardTimer) {
            clearInterval(this._clipboardTimer);
            this._clipboardTimer = null;
        }
        this._isWatching = false;
    }

    async copyToClipboard(content) {
        try {
            const s = String(content ?? '');
            await vscode.env.clipboard.writeText(s);
            this._lastClipboardContent = s; // 避免 watcher 立刻反灌
            return true;
        } catch {
            return false;
        }
    }

    async insertToEditor(content) {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return false;

            const text = String(content ?? '');
            await editor.edit((editBuilder) => {
                if (editor.selection.isEmpty) editBuilder.insert(editor.selection.active, text);
                else editBuilder.replace(editor.selection, text);
            });
            return true;
        } catch {
            return false;
        }
    }

    // =========================
    // 导出 / 导入（字符串）
    // =========================
    async exportHistoryString() {
        const doc = {
            version: CONSTANTS.VERSION,
            exportedAt: Date.now(),
            history: this._toArrayAll(),
        };
        return JSON.stringify(doc, null, 2);
    }

    async importHistoryString(jsonString) {
        try {
            const parsed = JSON.parse(String(jsonString || ''));
            const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.history) ? parsed.history : []);
            if (!Array.isArray(arr)) return { success: false, error: 'invalid format' };

            let imported = 0;
            for (const it of arr) {
                const content = String((it && it.content) || '');
                if (!content || REGEX.WHITESPACE_ONLY.test(content)) continue;

                let fixed = content;
                if (fixed.length > CONSTANTS.MAX_CONTENT_LENGTH) fixed = fixed.slice(0, CONSTANTS.MAX_CONTENT_LENGTH);

                const hash = String((it && it.hash) || md5Hex(fixed));
                if (this._hashMap.has(hash)) continue;

                /** @type {HistoryNode} */
                const node = {
                    id: String((it && it.id) || randomId()),
                    content: fixed,
                    timestamp: Number((it && it.timestamp) || Date.now()),
                    type: String((it && it.type) || 'text'),
                    preview: String((it && it.preview) || makePreview(fixed)),
                    contentLength: Number((it && it.contentLength) || fixed.length),
                    hash,
                    prev: null,
                    next: null,
                };

                this._insertHead(node);
                this._idMap.set(node.id, node);
                this._hashMap.set(node.hash, node);
                imported++;
            }

            while (this._size > CONSTANTS.MAX_HISTORY_ITEMS) this._popTail();

            this._touch();
            this._notifyChange();
            this._dirty = true;
            await this.forceSave();

            return { success: true, imported };
        } catch (e) {
            return { success: false, error: e?.message || 'parse failed' };
        }
    }

    // =========================
    // 导出 / 导入（文件）
    // =========================
    async exportToJsonFile() {
        const uri = await vscode.window.showSaveDialog({
            title: '导出剪贴板历史（JSON）',
            filters: { JSON: ['json'] },
            saveLabel: '导出',
            defaultUri: vscode.Uri.file(`clipboard-history-${Date.now()}.json`),
        });
        if (!uri) return false;

        try {
            const txt = await this.exportHistoryString();
            await vscode.workspace.fs.writeFile(uri, Buffer.from(txt, 'utf8'));
            return true;
        } catch {
            return false;
        }
    }

    async importFromJsonFile() {
        const uris = await vscode.window.showOpenDialog({
            title: '导入剪贴板历史（JSON）',
            canSelectMany: false,
            filters: { JSON: ['json'] },
            openLabel: '导入',
        });
        if (!uris || !uris[0]) return { success: false, error: 'cancelled' };

        try {
            const buf = await vscode.workspace.fs.readFile(uris[0]);
            return await this.importHistoryString(buf.toString());
        } catch (e) {
            return { success: false, error: e?.message || 'read failed' };
        }
    }

    // =========================
    // 保存
    // =========================
    requestSave() {
        if (!this._fileBinGz && !this._fileJsonGz) return;

        this._dirty = true;
        this._pendingChanges++;

        if (this._pendingChanges >= CONSTANTS.BATCH_SAVE_THRESHOLD) {
            this.forceSave().catch(() => { });
            return;
        }

        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this.forceSave().catch(() => { });
        }, CONSTANTS.SAVE_THROTTLE_MS);
    }

    async forceSave() {
        if (!this._fileBinGz && !this._fileJsonGz) return;

        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }

        this._saveChain = this._saveChain
            .then(() => this._doSaveOnce())
            .catch(() => this._doSaveOnce());

        return this._saveChain;
    }

    async _doSaveOnce() {
        if (!this._dirty) return;

        const t0 = performance.now();

        // 先把 dirty 拉下去；如写失败会再置回
        this._dirty = false;

        try {
            const payload = {
                version: CONSTANTS.VERSION,
                savedAt: Date.now(),
                history: this._toArrayAll(),
            };

            const mp = getMsgpack();
            let rawBuf;
            try {
                if (this._preferMsgpack && mp) rawBuf = Buffer.from(mp.encode(payload));
                else rawBuf = Buffer.from(JSON.stringify(payload), 'utf8');
            } catch {
                rawBuf = Buffer.from(JSON.stringify(payload), 'utf8');
            }

            let outBuf = rawBuf;
            try {
                outBuf = await gzipAsync(rawBuf);
            } catch {
                outBuf = rawBuf;
            }

            const targetPath = (this._preferMsgpack && this._fileBinGz) ? this._fileBinGz : this._fileJsonGz;
            if (!targetPath) return;

            await this._writeFileAtomic(targetPath, outBuf);

            this.perfStats.lastSaveBytes = outBuf.length;
            this._pendingChanges = 0;
        } catch {
            // 写失败：恢复 dirty 并稍后重试
            this._dirty = true;
            setTimeout(() => {
                if (this._dirty) this.forceSave().catch(() => { });
            }, CONSTANTS.SAVE_RETRY_DELAY_MS);
        } finally {
            this.perfStats.saveTimeMs += (performance.now() - t0);
            this.perfStats.operations++;
        }
    }

    async _writeFileAtomic(targetPath, buf) {
        const dir = path.dirname(targetPath);
        const tmpName = `${path.basename(targetPath)}${CONSTANTS.SAVE_TEMP_SUFFIX}.${randomId()}`;
        const tmpPath = path.join(dir, tmpName);

        await fs.promises.writeFile(tmpPath, buf);

        // Windows rename 覆盖可能失败：先 unlink 再 rename
        try {
            await fs.promises.rename(tmpPath, targetPath);
        } catch {
            try { await fs.promises.unlink(targetPath); } catch { /* ignore */ }
            await fs.promises.rename(tmpPath, targetPath);
        }
    }

    // =========================
    // 加载（只认本版本的两种文件：bin.gz / json.gz；不做任何 state 迁移）
    // =========================
    async _loadHistory() {
        const t0 = performance.now();
        try {
            const candidates = [this._fileBinGz, this._fileJsonGz].filter(Boolean);

            let chosen = null;
            for (const fp of candidates) {
                if (fp && fs.existsSync(fp)) {
                    chosen = fp;
                    break;
                }
            }
            if (!chosen) return;

            let dataBuf;
            try {
                dataBuf = await fs.promises.readFile(chosen);
            } catch {
                return;
            }
            this.perfStats.lastLoadBytes = dataBuf.length;

            let raw = dataBuf;
            try {
                // ★ 严密保护解压逻辑
                raw = await gunzipAsync(dataBuf);
            } catch (e) {
                console.error('[Q4] 历史文件解压失败 (可能损坏):', e.message);
                // 如果解压失败，检查是否可能原本就是未压缩的 JSON
                if (dataBuf[0] === 0x7b) { // '{'
                    raw = dataBuf;
                } else {
                    await this._quarantineCorruptFile(chosen).catch(() => { });
                    return;
                }
            }

            const mp = getMsgpack();
            let parsed = null;

            if (mp) {
                try {
                    parsed = mp.decode(raw);
                } catch {
                    try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
                }
            } else {
                try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
            }

            if (!parsed) {
                await this._quarantineCorruptFile(chosen).catch(() => { });
                this._resetInMemory();
                return;
            }

            const historyArr = Array.isArray(parsed)
                ? parsed
                : (parsed && Array.isArray(parsed.history) ? parsed.history : []);

            this._resetInMemory();

            const normalized = historyArr
                .map((it) => {
                    const content = String((it && it.content) || '');
                    if (!content || REGEX.WHITESPACE_ONLY.test(content)) return null;

                    let fixed = content;
                    if (fixed.length > CONSTANTS.MAX_CONTENT_LENGTH) fixed = fixed.slice(0, CONSTANTS.MAX_CONTENT_LENGTH);

                    const ts = Number((it && it.timestamp) || Date.now());
                    const h = String((it && it.hash) || md5Hex(fixed));
                    const id = String((it && it.id) || randomId());
                    const type = String((it && it.type) || 'text');
                    const contentLength = Number((it && it.contentLength) || fixed.length);
                    const preview = String((it && it.preview) || makePreview(fixed));
                    return { id, content: fixed, timestamp: ts, type, preview, contentLength, hash: h };
                })
                .filter(Boolean)
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, CONSTANTS.MAX_HISTORY_ITEMS);

            for (let i = normalized.length - 1; i >= 0; i--) {
                const it = normalized[i];
                /** @type {HistoryNode} */
                const node = { ...it, prev: null, next: null };
                if (this._hashMap.has(node.hash)) continue;

                this._insertHead(node);
                this._idMap.set(node.id, node);
                this._hashMap.set(node.hash, node);
            }

            this._touch();
            this._notifyChange();
        } finally {
            this.perfStats.loadTimeMs += (performance.now() - t0);
            this.perfStats.operations++;
        }
    }

    async _quarantineCorruptFile(filePath) {
        try {
            const dir = path.dirname(filePath);
            const base = path.basename(filePath);
            const corrupted = path.join(dir, `${base}${CONSTANTS.CORRUPT_SUFFIX_PREFIX}${Date.now()}`);
            await fs.promises.rename(filePath, corrupted);
            this.perfStats.quarantinedFiles++;
        } catch {
            try { await fs.promises.unlink(filePath); } catch { /* ignore */ }
            this.perfStats.quarantinedFiles++;
        }
    }

    _notifyChange() {
        if (typeof this._onChange === 'function') {
            try { this._onChange(); } catch { /* ignore */ }
        }
    }

    getStatsSnapshot() {
        const ops = this.perfStats.operations || 1;

        const denom = this._cache.hit + this._cache.miss;
        const cacheHitRate = denom > 0 ? (this._cache.hit / denom) * 100 : 0;

        const uptimeSec = Math.max(0, Math.floor((Date.now() - this.sessionStartedAt) / 1000));
        const uptimeH = Math.floor(uptimeSec / 3600);
        const uptimeM = Math.floor((uptimeSec % 3600) / 60);

        return {
            historyCount: this._size,
            maxHistoryItems: CONSTANTS.MAX_HISTORY_ITEMS,
            isWatching: this._isWatching,
            uptime: { h: uptimeH, m: uptimeM },
            cache: {
                hit: this._cache.hit,
                miss: this._cache.miss,
                hitRate: cacheHitRate,
                uiBytes: this._cache.uiBytes,
                searchBytes: this._cache.searchBytes,
                maxBytes: this._cache.maxBytes,
            },
            perf: {
                avgSaveMs: this.perfStats.saveTimeMs / ops,
                avgAddMs: this.perfStats.addTimeMs / ops,
                avgLoadMs: this.perfStats.loadTimeMs / ops,
                lastSaveBytes: this.perfStats.lastSaveBytes,
                lastLoadBytes: this.perfStats.lastLoadBytes,
                quarantinedFiles: this.perfStats.quarantinedFiles,
            },
        };
    }

    async dispose() {
        this.stopWatching();

        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }

        try {
            this._dirty = true;
            await this.forceSave();
        } catch {
            // ignore
        }
    }
}

// ============================================================================
// Sidebar Webview Provider（Solarized Dark + 暗金 + 破高对比度）
// ============================================================================
class ClipboardHistorySidebarProvider {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {ClipboardHistoryManager} historyManager
     */
    constructor(context, historyManager) {
        this._context = context;
        this._historyManager = historyManager;

        /** @type {vscode.WebviewView|null} */
        this._view = null;

        this._updateTimer = null;
        this._watchdogTimer = null;
        this._currentNonce = '';

        this._lastHeartbeat = 0;
        this._lastKeyword = '';
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };

        this._currentNonce = nonceHex();
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, this._currentNonce);

        webviewView.webview.onDidReceiveMessage(
            (msg) => this._handleMessage(msg),
            null,
            this._context.subscriptions
        );

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._sendUpdate(this._lastKeyword);
                this._startPeriodicUpdate();
            } else {
                this._stopPeriodicUpdate();
            }
        });

        if (webviewView.visible) {
            this._sendUpdate('');
            this._startPeriodicUpdate();
        }

        this._startWatchdog();
    }

    dispose() {
        this._stopPeriodicUpdate();
        if (this._watchdogTimer) {
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;
        }
        this._view = null;
    }

    _startPeriodicUpdate() {
        this._stopPeriodicUpdate();
        this._updateTimer = setInterval(() => {
            this._sendUpdate(this._lastKeyword);
        }, CONSTANTS.SIDEBAR_UPDATE_MS);
    }

    _stopPeriodicUpdate() {
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
            this._updateTimer = null;
        }
    }

    _startWatchdog() {
        if (this._watchdogTimer) clearInterval(this._watchdogTimer);
        this._watchdogTimer = setInterval(() => {
            const now = Date.now();
            if (this._lastHeartbeat > 0 && (now - this._lastHeartbeat) > CONSTANTS.WATCHDOG_STALE_MS) {
                this._forceRefreshWebview();
            }
        }, CONSTANTS.WATCHDOG_REFRESH_MS);
    }

    _forceRefreshWebview() {
        if (this._view && this._view.visible) {
            this._currentNonce = nonceHex();
            this._view.webview.html = this._getHtmlForWebview(this._view.webview, this._currentNonce);
            this._lastHeartbeat = Date.now();
            this._sendUpdate(this._lastKeyword);
        }
    }

    async _handleMessage(msg) {
        if (!msg || typeof msg.command !== 'string') return;

        switch (msg.command) {
            case 'heartbeat':
                this._lastHeartbeat = Date.now();
                break;

            case 'ready':
                this._lastHeartbeat = Date.now();
                this._sendUpdate(this._lastKeyword);
                break;

            case 'refresh':
                this._sendUpdate(this._lastKeyword);
                break;

            case 'search': {
                const kw = String(msg.keyword || '').trim();
                this._lastKeyword = kw;
                this._sendUpdate(kw);
                break;
            }

            case 'copy': {
                const id = String(msg.id || '');
                const node = this._historyManager.getItemById(id);
                if (node) {
                    await this._historyManager.copyToClipboard(node.content);
                    vscode.window.setStatusBarMessage('已复制到剪贴板', 2000);
                }
                break;
            }

            case 'paste': {
                const id = String(msg.id || '');
                const node = this._historyManager.getItemById(id);
                if (node) {
                    await this._historyManager.copyToClipboard(node.content);
                    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
                }
                break;
            }

            case 'insert': {
                const id = String(msg.id || '');
                const node = this._historyManager.getItemById(id);
                if (node) {
                    const ok = await this._historyManager.insertToEditor(node.content);
                    vscode.window.setStatusBarMessage(ok ? '已插入到编辑器' : '插入失败（无活动编辑器？）', 2000);
                }
                break;
            }

            case 'delete': {
                const id = String(msg.id || '');
                await this._historyManager.removeItem(id);
                this._sendUpdate(this._lastKeyword);
                break;
            }

            case 'clear': {
                const confirm = await vscode.window.showWarningMessage(
                    '确定要清空所有剪贴板历史吗？此操作不可恢复。',
                    { modal: true },
                    '确定清空'
                );
                if (confirm === '确定清空') {
                    await this._historyManager.clearHistory({ deleteFiles: true, writeEmptyFile: true });
                    this._lastKeyword = '';
                    this._sendUpdate('');
                }
                break;
            }

            case 'export': {
                const ok = await this._historyManager.exportToJsonFile();
                if (ok) vscode.window.showInformationMessage('导出成功');
                else vscode.window.showErrorMessage('导出失败');
                break;
            }

            case 'import': {
                const result = await this._historyManager.importFromJsonFile();
                if (result && result.success) {
                    vscode.window.showInformationMessage(`导入成功：${result.imported} 条`);
                    this._sendUpdate(this._lastKeyword);
                } else {
                    vscode.window.showErrorMessage('导入失败：' + (result?.error || '未知错误'));
                }
                break;
            }

            case 'stats': {
                const snap = this._historyManager.getStatsSnapshot();
                this._postMessage({ command: 'statsSnapshot', stats: snap });
                break;
            }

            default:
                break;
        }
    }

    refresh() {
        this._sendUpdate(this._lastKeyword);
    }

    _buildUiPayload(keyword = '') {
        const kw = String(keyword || '').trim();

        const raw = kw
            ? this._historyManager.searchHistory(kw, CONSTANTS.UI_HISTORY_LIMIT)
            : this._historyManager.getHistory(CONSTANTS.UI_HISTORY_LIMIT);

        const history = raw.map((it) => ({
            id: String(it.id || ''),
            time: formatTime(it.timestamp),
            preview: String(it.preview || makePreview(it.content)).slice(0, CONSTANTS.PREVIEW_LENGTH),
            contentLength: Number(it.contentLength || (it.content ? String(it.content).length : 0)) || 0,
        }));

        const snap = this._historyManager.getStatsSnapshot();

        return {
            keyword: kw,
            history,
            stats: {
                historyCount: snap.historyCount,
                uptime: snap.uptime,
                cacheHitRate: snap.cache.hitRate,
                perf: snap.perf,
            },
        };
    }

    _sendUpdate(keyword = '') {
        const payload = this._buildUiPayload(keyword);
        this._postMessage({ command: 'updateData', ...payload });
    }

    _postMessage(msg) {
        try {
            if (this._view && this._view.webview) {
                // ★ 终极最优解：强制 POJO 转换，彻底解决 toJSON 报错与 Webview 崩溃风险
                const safeMsg = JSON.parse(JSON.stringify(msg));
                this._view.webview.postMessage(safeMsg).then(undefined, () => { });
            }
        } catch {
            // ignore
        }
    }

    _getHtmlForWebview(webview, nonce) {
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} data:`,
            `media-src ${webview.cspSource} data:`,
            `style-src 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`,
            `base-uri 'none'`,
            `form-action 'none'`,
            `frame-ancestors 'none'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="color-scheme" content="dark">
  <title>剪贴板历史</title>

  <style nonce="${nonce}">
    /* =========================================================================
       Solarized Dark + 暗金 / 破高对比度主题（forced-colors）
       ========================================================================= */
    :root{
      --base03:#002b36;
      --base02:#073642;
      --base01:#586e75;
      --base00:#657b83;
      --base0:#839496;
      --base1:#93a1a1;
      --base2:#eee8d5;
      --base3:#fdf6e3;

      --gold:#b58900;
      --goldDeep:#a47e00;
      --orange:#cb4b16;
      --red:#dc322f;
      --green:#859900;

      --bg:var(--base03);
      --panel:var(--base02);
      --panel2:#0b3d4a;
      --text:var(--base1);
      --muted:var(--base01);
      --border:rgba(147,161,161,0.18);
      --shadow:rgba(0,0,0,0.35);

      --btnBg:rgba(181,137,0,0.10);
      --btnHover:rgba(181,137,0,0.18);
      --dangerBg:rgba(220,50,47,0.14);
      --dangerHover:rgba(220,50,47,0.22);
    }

    /* 破 Windows 高对比度主题：强制使用我们自定义颜色 */
    html{ forced-color-adjust:none !important; -ms-high-contrast-adjust:none !important; }
    body{ forced-color-adjust:none !important; -ms-high-contrast-adjust:none !important; }
    *{ forced-color-adjust:none !important; -ms-high-contrast-adjust:none !important; }
    @media (forced-colors: active){
      html, body, *{ forced-color-adjust:none !important; -ms-high-contrast-adjust:none !important; }
    }

    *{ box-sizing:border-box; }
    html,body{
      margin:0; padding:0;
      height:100%;
      background:var(--bg) !important;
      color:var(--text) !important;
      font-family: var(--vscode-font-family, system-ui, -apple-system, Segoe UI, sans-serif);
      font-size: 13px;
      line-height: 1.45;
      overflow:hidden;
    }

    .root{
      display:flex;
      flex-direction:column;
      height:100vh;
      padding:10px;
      gap:10px;
    }

    .topbar{
      display:flex;
      gap:8px;
      align-items:center;
    }

    .search{
      flex:1;
      display:flex;
      gap:8px;
      align-items:center;
    }

    .search input{
      width:100%;
      padding:8px 10px;
      border-radius:6px;
      border:1px solid var(--border) !important;
      background:var(--panel) !important;
      color:var(--text) !important;
      outline:none;
    }
    .search input:focus{
      border-color:rgba(181,137,0,0.65) !important;
      box-shadow:0 0 0 2px rgba(181,137,0,0.18);
    }
    .search input::placeholder{
      color:rgba(147,161,161,0.55) !important;
    }

    .btn{
      padding:8px 10px;
      border-radius:6px;
      border:1px solid var(--border) !important;
      background:var(--btnBg) !important;
      color:var(--text) !important;
      cursor:pointer;
      user-select:none;
      transition: transform .06s ease, background .12s ease, border-color .12s ease;
      white-space:nowrap;
    }
    .btn:hover{
      background:var(--btnHover) !important;
      border-color:rgba(181,137,0,0.45) !important;
    }
    .btn:active{ transform: scale(0.98); }

    .btn-danger{
      background:var(--dangerBg) !important;
      border-color:rgba(220,50,47,0.35) !important;
    }
    .btn-danger:hover{
      background:var(--dangerHover) !important;
      border-color:rgba(220,50,47,0.55) !important;
    }

    .panel{
      background:linear-gradient(180deg, rgba(7,54,66,0.98), rgba(0,43,54,0.98)) !important;
      border:1px solid var(--border) !important;
      border-radius:10px;
      box-shadow: 0 8px 24px var(--shadow);
      overflow:hidden;
      display:flex;
      flex-direction:column;
      min-height:0;
      flex:1;
    }

    .panel-header{
      display:flex;
      justify-content:space-between;
      align-items:center;
      padding:10px 12px;
      border-bottom:1px solid var(--border) !important;
    }

    .title{
      font-weight:700;
      letter-spacing:0.3px;
      color:rgba(181,137,0,0.95) !important;
      text-transform:uppercase;
      font-size:12px;
    }

    .meta{
      font-size:11px;
      color:rgba(147,161,161,0.65) !important;
      display:flex;
      gap:10px;
      align-items:center;
    }

    .list{
      padding:10px;
      overflow:auto;
      min-height:0;
    }

    .item{
      border:1px solid var(--border) !important;
      border-radius:10px;
      background:rgba(11,61,74,0.55) !important;
      padding:10px;
      margin-bottom:10px;
      cursor:pointer;
      transition: transform .12s ease, border-color .12s ease, background .12s ease;
    }
    .item:hover{
      transform: translateX(2px);
      border-color:rgba(181,137,0,0.42) !important;
      background:rgba(11,61,74,0.70) !important;
    }
    .item.selected{
      outline:2px solid rgba(181,137,0,0.55);
    }

    .row1{
      display:flex;
      justify-content:space-between;
      gap:10px;
      align-items:center;
      margin-bottom:8px;
    }
    .time{
      font-size:11px;
      color:rgba(147,161,161,0.75) !important;
    }
    .size{
      font-size:11px;
      color:rgba(147,161,161,0.55) !important;
    }

    .preview{
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
      font-size:12px;
      color:rgba(238,232,213,0.90) !important;
      white-space:pre-wrap;
      word-break:break-all;
      max-height: 84px;
      overflow:hidden;
      line-height:1.5;
    }

    .actions{
      display:flex;
      gap:8px;
      margin-top:10px;
      flex-wrap:wrap;
    }

    .mini{
      padding:6px 10px;
      font-size:12px;
      border-radius:8px;
      border:1px solid var(--border) !important;
      background:rgba(181,137,0,0.10) !important;
      color:rgba(238,232,213,0.92) !important;
      cursor:pointer;
      user-select:none;
    }
    .mini:hover{ background:rgba(181,137,0,0.18) !important; }

    .mini-danger{
      background:rgba(220,50,47,0.12) !important;
      border-color:rgba(220,50,47,0.35) !important;
    }
    .mini-danger:hover{
      background:rgba(220,50,47,0.20) !important;
      border-color:rgba(220,50,47,0.55) !important;
    }

    .empty{
      padding:22px 10px;
      text-align:center;
      color:rgba(147,161,161,0.65) !important;
    }

    .footer{
      display:flex;
      justify-content:space-between;
      gap:10px;
      align-items:flex-start;
      padding:10px 12px;
      border-top:1px solid var(--border) !important;
      background:rgba(0,43,54,0.85) !important;
      font-size:11px;
      color:rgba(147,161,161,0.70) !important;
    }

    .stats{
      white-space:pre-wrap;
      font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
      color:rgba(238,232,213,0.85) !important;
      line-height:1.35;
    }

    .hidden{ display:none !important; }
  </style>
</head>

<body>
  <div class="root">
    <div class="topbar">
      <div class="search">
        <input id="searchInput" type="text" placeholder="🔍 搜索历史（Enter 不提交，只过滤）" />
      </div>

      <button class="btn" id="btnRefresh" type="button" title="刷新">🔄</button>
      <button class="btn" id="btnImport" type="button" title="导入">📥</button>
      <button class="btn" id="btnExport" type="button" title="导出">📤</button>
      <button class="btn btn-danger" id="btnClear" type="button" title="清空">🗑️</button>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div class="title">Clipboard History</div>
        <div class="meta">
          <span id="metaCount">0 items</span>
          <span id="metaUptime">0h 0m</span>
          <button class="btn" id="btnStats" type="button" title="统计">📊</button>
        </div>
      </div>

      <div class="list" id="list">
        <div class="empty">加载中...</div>
      </div>

      <div class="footer">
        <div>Solarized + 暗金 · forced-color-adjust:none · CSP safe</div>
        <div id="statsBox" class="stats hidden">-</div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function(){
      'use strict';

      let vscodeApi = null;
      try { vscodeApi = acquireVsCodeApi(); } catch(e) {}

      function postMessage(msg){
        if(vscodeApi) vscodeApi.postMessage(msg);
      }

      const el = {
        searchInput: document.getElementById('searchInput'),
        btnRefresh: document.getElementById('btnRefresh'),
        btnImport: document.getElementById('btnImport'),
        btnExport: document.getElementById('btnExport'),
        btnClear: document.getElementById('btnClear'),
        btnStats: document.getElementById('btnStats'),
        list: document.getElementById('list'),
        metaCount: document.getElementById('metaCount'),
        metaUptime: document.getElementById('metaUptime'),
        statsBox: document.getElementById('statsBox')
      };

      let current = [];
      let selectedIndex = -1;
      let selectedId = '';
      let showStats = false;
      let lastKeyword = '';
      let debounceTimer = null;

      function formatSize(n){
        const bytes = Number(n||0);
        if(bytes < 1024) return bytes + 'B';
        if(bytes < 1024*1024) return (bytes/1024).toFixed(1) + 'KB';
        return (bytes/1024/1024).toFixed(2) + 'MB';
      }

      function clearChildren(node){
        while(node && node.firstChild) node.removeChild(node.firstChild);
      }

      function setSelectedById(id){
        selectedId = id || '';
        const items = el.list ? el.list.querySelectorAll('.item') : [];
        selectedIndex = -1;
        for(let i=0;i<items.length;i++){
          const it = items[i];
          if(it && it.dataset && it.dataset.id === selectedId){
            selectedIndex = i;
            it.classList.add('selected');
          } else {
            it.classList.remove('selected');
          }
        }
      }

      function ensureSelectedVisible(){
        if(!el.list) return;
        if(selectedIndex < 0) return;
        const items = el.list.querySelectorAll('.item');
        const item = items[selectedIndex];
        if(!item) return;

        const top = item.offsetTop;
        const bottom = top + item.offsetHeight;
        const viewTop = el.list.scrollTop;
        const viewBottom = viewTop + el.list.clientHeight;

        if(top < viewTop) el.list.scrollTop = top;
        else if(bottom > viewBottom) el.list.scrollTop = bottom - el.list.clientHeight;
      }

      function renderList(history){
        current = Array.isArray(history) ? history : [];

        clearChildren(el.list);

        if(current.length === 0){
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = '暂无记录';
          el.list.appendChild(empty);

          selectedIndex = -1;
          selectedId = '';
          return;
        }

        const frag = document.createDocumentFragment();

        for(let i=0;i<current.length;i++){
          const it = current[i] || {};
          const id = String(it.id || '');
          const time = String(it.time || '');
          const preview = String(it.preview || '');
          const len = Number(it.contentLength || 0);

          const item = document.createElement('div');
          item.className = 'item';
          item.dataset.id = id;

          const row1 = document.createElement('div');
          row1.className = 'row1';

          const timeEl = document.createElement('div');
          timeEl.className = 'time';
          timeEl.textContent = time;

          const sizeEl = document.createElement('div');
          sizeEl.className = 'size';
          sizeEl.textContent = formatSize(len);

          row1.appendChild(timeEl);
          row1.appendChild(sizeEl);

          const prevEl = document.createElement('div');
          prevEl.className = 'preview';
          prevEl.textContent = preview;

          const actions = document.createElement('div');
          actions.className = 'actions';

          const btnCopy = document.createElement('button');
          btnCopy.type = 'button';
          btnCopy.className = 'mini';
          btnCopy.dataset.action = 'copy';
          btnCopy.textContent = '📋 复制';

          const btnPaste = document.createElement('button');
          btnPaste.type = 'button';
          btnPaste.className = 'mini';
          btnPaste.dataset.action = 'paste';
          btnPaste.textContent = '📌 粘贴';

          const btnInsert = document.createElement('button');
          btnInsert.type = 'button';
          btnInsert.className = 'mini';
          btnInsert.dataset.action = 'insert';
          btnInsert.textContent = '📝 插入';

          const btnDel = document.createElement('button');
          btnDel.type = 'button';
          btnDel.className = 'mini mini-danger';
          btnDel.dataset.action = 'delete';
          btnDel.textContent = '🗑️ 删除';

          actions.appendChild(btnCopy);
          actions.appendChild(btnPaste);
          actions.appendChild(btnInsert);
          actions.appendChild(btnDel);

          item.appendChild(row1);
          item.appendChild(prevEl);
          item.appendChild(actions);

          frag.appendChild(item);
        }

        el.list.appendChild(frag);

        // 默认选中第一条
        if(selectedId){
          setSelectedById(selectedId);
        }else{
          const first = el.list.querySelector('.item');
          if(first && first.dataset && first.dataset.id){
            setSelectedById(first.dataset.id);
          }
        }
      }

      function renderMeta(stats, historyCount){
        stats = stats || {};
        const uptime = stats.uptime || {h:0,m:0};

        if(el.metaCount) el.metaCount.textContent = String((historyCount||0) + ' items');
        if(el.metaUptime) el.metaUptime.textContent = String((uptime.h||0) + 'h ' + (uptime.m||0) + 'm');

        if(showStats && el.statsBox){
          const perf = stats.perf || {};
          const hitRate = stats.cacheHitRate || 0;

          const line1 = 'count: ' + (historyCount||0);
          const line2 = 'cacheHit: ' + hitRate.toFixed(1) + '%';
          const line3 = 'avgSave: ' + (perf.avgSaveMs||0).toFixed(2) + 'ms  avgAdd: ' + (perf.avgAddMs||0).toFixed(2) + 'ms';
          const line4 = 'avgLoad: ' + (perf.avgLoadMs||0).toFixed(2) + 'ms  quarantined: ' + (perf.quarantinedFiles||0);
          el.statsBox.textContent = line1 + '\\n' + line2 + '\\n' + line3 + '\\n' + line4;
        }
      }

      function toggleStats(){
        showStats = !showStats;
        if(el.statsBox){
          if(showStats) el.statsBox.classList.remove('hidden');
          else el.statsBox.classList.add('hidden');
        }
        postMessage({ command: 'stats' });
      }

      function requestRefresh(){
        postMessage({ command: 'refresh' });
      }

      function requestSearch(kw){
        postMessage({ command: 'search', keyword: kw || '' });
      }

      function requestCopy(id){
        postMessage({ command: 'copy', id: id });
      }
      function requestPaste(id){
        postMessage({ command: 'paste', id: id });
      }
      function requestInsert(id){
        postMessage({ command: 'insert', id: id });
      }
      function requestDelete(id){
        postMessage({ command: 'delete', id: id });
      }

      function bindUI(){
        if(el.btnRefresh) el.btnRefresh.addEventListener('click', requestRefresh);
        if(el.btnImport) el.btnImport.addEventListener('click', function(){ postMessage({ command: 'import' }); });
        if(el.btnExport) el.btnExport.addEventListener('click', function(){ postMessage({ command: 'export' }); });
        if(el.btnClear) el.btnClear.addEventListener('click', function(){ postMessage({ command: 'clear' }); });
        if(el.btnStats) el.btnStats.addEventListener('click', toggleStats);

        if(el.searchInput){
          el.searchInput.addEventListener('input', function(){
            const kw = String(el.searchInput.value || '').trim();
            lastKeyword = kw;
            if(debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(function(){
              requestSearch(kw);
            }, 250);
          });
        }

        if(el.list){
          el.list.addEventListener('click', function(e){
            const btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
            if(btn){
              const action = btn.dataset.action || '';
              const item = btn.closest('.item');
              const id = item ? (item.dataset.id || '') : '';

              if(action === 'copy') requestCopy(id);
              if(action === 'paste') requestPaste(id);
              if(action === 'insert') requestInsert(id);
              if(action === 'delete') requestDelete(id);
              return;
            }

            const item = e.target && e.target.closest ? e.target.closest('.item') : null;
            if(item && item.dataset && item.dataset.id){
              setSelectedById(item.dataset.id);
              requestCopy(item.dataset.id); // 点整行 = 复制
            }
          });
        }

        // 键盘：上下选择 / Enter 复制 / Ctrl+Enter 粘贴 / Delete 删除 / Ctrl+F 搜索
        document.addEventListener('keydown', function(e){
          const active = document.activeElement;
          const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');

          if(e.ctrlKey && (e.key === 'f' || e.key === 'F')){
            if(el.searchInput){
              el.searchInput.focus();
              el.searchInput.select();
              e.preventDefault();
            }
            return;
          }

          if(inInput) return;
          if(!el.list) return;

          const items = el.list.querySelectorAll('.item');
          if(!items || items.length === 0) return;

          if(e.key === 'ArrowDown'){
            selectedIndex = (selectedIndex < 0) ? 0 : Math.min(items.length - 1, selectedIndex + 1);
            const id = items[selectedIndex].dataset.id;
            setSelectedById(id);
            ensureSelectedVisible();
            e.preventDefault();
            return;
          }

          if(e.key === 'ArrowUp'){
            selectedIndex = (selectedIndex < 0) ? 0 : Math.max(0, selectedIndex - 1);
            const id = items[selectedIndex].dataset.id;
            setSelectedById(id);
            ensureSelectedVisible();
            e.preventDefault();
            return;
          }

          if(e.key === 'Enter'){
            if(selectedIndex >= 0 && items[selectedIndex]){
              const id = items[selectedIndex].dataset.id;
              if(e.ctrlKey) requestPaste(id);
              else requestCopy(id);
              e.preventDefault();
            }
            return;
          }

          if(e.key === 'Delete'){
            if(selectedIndex >= 0 && items[selectedIndex]){
              requestDelete(items[selectedIndex].dataset.id);
              e.preventDefault();
            }
          }
        });
      }

      // 接收扩展端数据
      window.addEventListener('message', function(ev){
        const msg = ev.data;
        if(!msg || typeof msg !== 'object') return;

        if(msg.command === 'updateData'){
          // 同步 keyword（仅当 input 未聚焦，避免打断输入）
          if(el.searchInput && typeof msg.keyword === 'string'){
            if(document.activeElement !== el.searchInput){
              el.searchInput.value = msg.keyword;
            }
          }

          renderList(msg.history || []);
          renderMeta(msg.stats || {}, (msg.history && msg.history.length) ? msg.history.length : 0);

          // 如开启 stats，刷新一次快照面板
          if(showStats) postMessage({ command: 'stats' });
        }

        if(msg.command === 'statsSnapshot'){
          if(!showStats) return;
          const stats = msg.stats || {};
          const historyCount = (typeof stats.historyCount === 'number') ? stats.historyCount : (current ? current.length : 0);

          // 这里复用 renderMeta 的 stats 结构要求
          renderMeta({
            uptime: stats.uptime,
            cacheHitRate: stats.cache ? stats.cache.hitRate : 0,
            perf: stats.perf
          }, historyCount);
        }
      });

      // 心跳
      setInterval(function(){
        postMessage({ command: 'heartbeat' });
      }, 10000);

      // init
      bindUI();
      postMessage({ command: 'ready' });
    })();
  </script>
</body>
</html>`;
    }
}

// ============================================================================
// QuickPick 命令
// ============================================================================
async function showHistoryQuickPick(historyManager) {
    const history = historyManager.getHistory(50);

    if (history.length === 0) {
        vscode.window.showInformationMessage('剪贴板历史为空');
        return;
    }

    const items = history.map((item) => ({
        label: item.preview || makePreview(item.content),
        description: formatTime(item.timestamp),
        detail: `${item.contentLength || (item.content ? item.content.length : 0)} 字符`,
        id: item.id,
        content: item.content,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要粘贴的历史记录',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (selected) {
        await historyManager.copyToClipboard(selected.content);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    }
}

// ============================================================================
// 搜索历史命令（QuickPick）
// ============================================================================
async function searchHistoryCommand(historyManager) {
    const keyword = await vscode.window.showInputBox({
        placeHolder: '输入搜索关键词',
        prompt: '搜索剪贴板历史',
    });

    if (!keyword) return;

    const results = historyManager.searchHistory(keyword, 30);

    if (results.length === 0) {
        vscode.window.showInformationMessage(`未找到包含 "${keyword}" 的记录`);
        return;
    }

    const items = results.map((item) => ({
        label: item.preview || makePreview(item.content),
        description: formatTime(item.timestamp),
        detail: `${item.contentLength || (item.content ? item.content.length : 0)} 字符`,
        id: item.id,
        content: item.content,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `找到 ${results.length} 条结果`,
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (selected) {
        await historyManager.copyToClipboard(selected.content);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    }
}

// ============================================================================
// 导出 / 导入 / 清空 / 统计 命令
// ============================================================================
async function exportHistoryCommand(historyManager) {
    const ok = await historyManager.exportToJsonFile();
    if (ok) vscode.window.showInformationMessage('剪贴板历史导出成功');
    else vscode.window.showErrorMessage('导出失败');
}

async function importHistoryCommand(historyManager) {
    const result = await historyManager.importFromJsonFile();
    if (result && result.success) {
        vscode.window.showInformationMessage(`导入成功：${result.imported} 条`);
    } else {
        vscode.window.showErrorMessage('导入失败：' + (result?.error || '未知错误'));
    }
}

// ============================================================================
// 终极清理函数 qsc(a)
// ============================================================================
/**
 * @param {number} a 清理级别：1-缓存, 2-剪切板, 3-globalState, 0-全清
 * @param {ClipboardHistoryManager} historyManager
 */
async function qsc(a, historyManager) {
    const context = historyManager?.context;

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
                    // ★ 终极最优解：为每一项文件操作加 try-catch，防止因单个文件占用导致清理中断
                    try {
                        if (fs.statSync(filePath).isFile()) {
                            fs.unlinkSync(filePath);
                        }
                    } catch (fileErr) {
                        console.warn(`[QSC] 跳过无法访问的文件: ${file}`, fileErr.message);
                    }
                }
                console.log('[QSC] qqq_cache 已清空');
            }
        } catch (e) { console.error('[QSC] 清理 cache 失败:', e.message); }
    };

    // 2. 清空剪切板历史
    const clearHistory = async () => {
        if (historyManager) {
            await historyManager.clearHistory({ deleteFiles: true, writeEmptyFile: true });
            console.log('[QSC] 剪切板历史已清空');
        }
    };

    // 3. 清空 globalState (高危操作)
    const clearGlobalState = async () => {
        if (!context?.globalState) return;
        try {
            const keys = ['qqq.transactions', 'qqq_config', 'qqq_clipboard_history'];
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

async function clearHistoryCommand(historyManager) {
    const confirm = await vscode.window.showWarningMessage(
        '确定要执行清空操作吗？此操作不可恢复。',
        { modal: true },
        '确定清空'
    );

    if (confirm === '确定清空') {
        // 默认执行 a=2 (清空剪切板)
        await qsc(2, historyManager);
        vscode.window.showInformationMessage('剪切板历史已清空');
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
        ``,
        `缓存命中率: ${snap.cache.hitRate.toFixed(1)}%`,
        `avgSave: ${snap.perf.avgSaveMs.toFixed(2)}ms`,
        `avgAdd:  ${snap.perf.avgAddMs.toFixed(2)}ms`,
        `avgLoad: ${snap.perf.avgLoadMs.toFixed(2)}ms`,
        `隔离损坏文件数: ${snap.perf.quarantinedFiles}`,
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
    vscode.window.showInformationMessage('已复制到剪贴板并添加到历史');
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

        this._statusBarItem.command = 'qqq.showHistoryQuickPick';
        this._statusBarItem.tooltip = '点击打开剪贴板历史';
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
// 扩展激活入口
// ============================================================================
function activate(context) {
    console.log('[Q4] QQQ Clipboard History (fusion-final) activating...');

    let sidebarProvider = null;
    let statusBarManager = null;

    const historyManager = new ClipboardHistoryManager(context, {
        onChange: () => {
            if (sidebarProvider) sidebarProvider.refresh();
            if (statusBarManager) statusBarManager.refresh();
        },
    });

    // ★ 终极最优解：同步记录当前实例，供 deactivate 强杀
    _currentHistoryManager = historyManager;

    historyManager.startWatching();

    sidebarProvider = new ClipboardHistorySidebarProvider(context, historyManager);

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
        vscode.commands.registerCommand('qqq.showHistoryQuickPick', () => showHistoryQuickPick(historyManager)),
        vscode.commands.registerCommand('qqq.searchHistory', () => searchHistoryCommand(historyManager)),
        vscode.commands.registerCommand('qqq.exportHistory', () => exportHistoryCommand(historyManager)),
        vscode.commands.registerCommand('qqq.importHistory', () => importHistoryCommand(historyManager)),
        vscode.commands.registerCommand('qqq.clearHistory', () => clearHistoryCommand(historyManager)),
        vscode.commands.registerCommand('qqq.showStats', () => showStatsCommand(historyManager)),
        vscode.commands.registerCommand('qqq.copyToHistory', () => copyToHistoryCommand(historyManager)),

        vscode.commands.registerCommand('qqq.refreshSidebar', () => {
            if (sidebarProvider) sidebarProvider.refresh();
        }),

        vscode.commands.registerCommand('qqq.pasteLastItem', async () => {
            const h = historyManager.getHistory(1);
            if (h.length > 0) {
                await historyManager.copyToClipboard(h[0].content);
                await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            } else {
                vscode.window.showInformationMessage('剪贴板历史为空');
            }
        }),

        vscode.commands.registerCommand('qqq.pasteNthItem', async () => {
            const input = await vscode.window.showInputBox({
                placeHolder: '输入序号 (1-10)',
                prompt: '粘贴第 N 条历史记录',
                validateInput: (value) => {
                    const n = parseInt(value, 10);
                    if (Number.isNaN(n) || n < 1 || n > 10) return '请输入 1-10 之间的数字';
                    return null;
                },
            });

            if (!input) return;
            const n = parseInt(input, 10);

            const history = historyManager.getHistory(n);
            if (history.length >= n) {
                const item = history[n - 1];
                await historyManager.copyToClipboard(item.content);
                await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            } else {
                vscode.window.showWarningMessage(`历史记录不足 ${n} 条`);
            }
        }),

        vscode.commands.registerCommand('qqq.copyAndAddToHistory', async () => {
            await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
            const content = await vscode.env.clipboard.readText();
            if (content) await historyManager.addToHistory(content);
        })
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
    };
}

// ============================================================================
// 扩展停用
// ============================================================================
async function deactivate() {
    console.log('[Q4] QQQ Clipboard History (fusion-final) deactivating...');
    if (_currentHistoryManager) {
        try {
            await _currentHistoryManager.dispose();
        } catch (e) {
            console.error('[Q4] Dispose error:', e);
        }
        _currentHistoryManager = null;
    }
}

// ============================================================================
// 导出
// ============================================================================
module.exports = {
    activate,
    deactivate,
    ClipboardHistoryManager,
    ClipboardHistorySidebarProvider,
};

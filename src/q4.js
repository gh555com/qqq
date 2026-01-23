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
        // ★ 直接计算 encode 后的长度，不重复创建 Buffer
        if (mp) return mp.encode(obj).length;
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
    // ★ 消除过时警告
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

                if (this._preferMsgpack && mp) {
                    rawBuf = mp.encode(payload);
                } else {
                    rawBuf = Buffer.from(JSON.stringify(payload), 'utf8');
                }
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
     * @param {any} globalModule
     */
    constructor(context, historyManager, globalModule) {
        this._context = context;
        this._historyManager = historyManager;
        this._global = globalModule;
        this._view = null;
        this._updateTimer = null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };

        // 初始内容与定时刷新
        this.updateContent();
        this._startPeriodicUpdate();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'executeCommand':
                    if (msg.cmd) vscode.commands.executeCommand(msg.cmd);
                    break;
                case 'copyToClipboard': {
                    const node = this._historyManager.getItemById(msg.itemId);
                    if (node) {
                        await this._historyManager.copyToClipboard(node.content);
                        vscode.window.setStatusBarMessage('已复制到剪切板', 2000);
                    }
                    break;
                }
                case 'pasteToEditor': {
                    const node = this._historyManager.getItemById(msg.itemId);
                    if (node) {
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
                        this.updateContent();
                    }
                    break;
                case 'clearAllHistory': {
                    const confirm = await vscode.window.showWarningMessage(
                        '确定要清空所有剪贴板历史吗？此操作不可恢复。',
                        { modal: true },
                        '确定清空'
                    );
                    if (confirm === '确定清空') {
                        await qsc(2, this._historyManager);
                        this.updateContent();
                    }
                    break;
                }
                case 'refresh':
                    this.updateContent();
                    break;
                case 'ready':
                    this.updateContent();
                    break;
                case 'heartbeat':
                    // 保持活动
                    break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.updateContent();
                this._startPeriodicUpdate();
            } else {
                this._stopPeriodicUpdate();
            }
        });

        webviewView.onDidDispose(() => {
            this._stopPeriodicUpdate();
        });
    }

    _startPeriodicUpdate() {
        this._stopPeriodicUpdate();
        this._updateTimer = setInterval(() => this.updateContent(), CONSTANTS.SIDEBAR_UPDATE_MS);
    }

    _stopPeriodicUpdate() {
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
            this._updateTimer = null;
        }
    }

    updateContent() {
        if (!this._view || !this._view.visible) return;
        try {
            const history = this._historyManager.getHistory(CONSTANTS.UI_HISTORY_LIMIT).map(item => ({
                id: item.id,
                time: formatTime(item.timestamp),
                preview: item.preview
            }));

            const stats = this._getDialStats();
            const audioBase64 = this._getAudioBase64();

            // 如果 HTML 为空（首次加载），则初始化 HTML
            if (!this._view.webview.html || this._view.webview.html.length < 100) {
                this._view.webview.html = this._getHtml(stats, history, audioBase64);
            }

            // 发送数据更新
            this._postMessage({
                command: 'updateData',
                stats: stats,
                history: history
            });

            this._view.title = `${stats.h}h ${stats.m}m`;
        } catch (e) {
            console.error('[Q4-UI] Update failed:', e);
        }
    }

    _getDialStats() {
        let h = 0, m = 0;
        const base = this._context.globalState.get("qqq_stats_total_seconds", 0) || 0;
        const lastFlush = this._context.globalState.get("qqq_stats_last_flush") || Date.now();
        const totalSeconds = base + ((Date.now() - lastFlush) / 1000);
        h = Math.floor(totalSeconds / 3600);
        m = Math.floor((totalSeconds % 3600) / 60);

        let cacheMB = 0;
        try {
            const root = this._context.globalStorageUri?.fsPath;
            const cacheDir = path.join(root, 'qqq_cache');
            if (fs.existsSync(cacheDir)) {
                cacheMB = fs.readdirSync(cacheDir).reduce((acc, f) => {
                    try { return acc + fs.statSync(path.join(cacheDir, f)).size; } catch { return acc; }
                }, 0) / (1024 * 1024);
            }
        } catch { }

        const engineInfo = { name: 'Node', details: 'Spawn 模式' };
        if (this._global?.getActiveEngineName) {
            engineInfo.name = this._global.getActiveEngineName(this._global.pythonBridge, this._global.rustBridge, this._global.shellBridge);
            engineInfo.details = engineInfo.name.includes('Python') ? 'Python 引擎' : (engineInfo.name.includes('Rust') ? 'Rust 引擎' : 'Node 引擎');
        }

        return { h, m, cacheMB, hitRate: 0, engineInfo };
    }

    _getAudioBase64() {
        try {
            const p = path.join(this._context.extensionPath, "assets", "q.mp3");
            return fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : '';
        } catch { return ''; }
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

    _getHtml(stats, history, audioBase64) {
        // ★ 核心逻辑：Webview 内部完全采用 createElement 渲染，不再依赖扩展端预生成的 HTML 字符串
        // 此处仅生成基础框架
        const nonce = nonceHex();
        const csp = [
            `default-src 'none'`,
            `img-src ${this._view.webview.cspSource} data:`,
            `media-src ${this._view.webview.cspSource} data:`,
            `style-src 'unsafe-inline' ${this._view.webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${this._view.webview.cspSource}`,
            `base-uri 'none'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <style>
        :root {
            --base03: #002b36; --base02: #073642; --base01: #586e75; --base00: #657b83;
            --base0: #839496; --base1: #93a1a1; --base2: #eee8d5; --base3: #fdf6e3;
            --yellow: #b58900; --orange: #cb4b16; --red: #dc322f; --magenta: #d33682;
            --violet: #6c71c4; --blue: #268bd2; --cyan: #2aa198; --green: #859900;
            --primary-color: var(--yellow); --background-color: var(--base3);
            --card-bg: var(--base2); --text-primary: var(--base00); --border-color: var(--base1);
        }
        html { forced-color-adjust: none !important; }
        body { margin: 0; padding: 0; font-family: sans-serif; background: var(--background-color); color: var(--text-primary); overflow: hidden; }
        .main-wrapper { height: 100vh; width: 100%; position: relative; overflow: hidden; background: var(--background-color) !important; }
        .main-content { height: 100%; overflow-y: scroll; padding: 12px; scrollbar-width: none; }
        .main-content::-webkit-scrollbar { display: none; }
        .section-title { font-size: 1.1em; font-weight: 700; margin: 20px 0 10px 0; border-bottom: 2px solid var(--primary-color); color: var(--primary-color); }

        .captain-grid { display: grid; gap: 8px; margin-bottom: 20px; }
        .cmd-btn { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 4px; padding: 10px; cursor: pointer; display: flex; align-items: center; gap: 10px; transition: 0.2s; position: relative; overflow: hidden; font-size: 0.9em; color: var(--text-primary); }
        .cmd-btn:hover { border-color: var(--primary-color); background: #fff; transform: translateX(2px); }
        .cmd-btn::before { content: ''; position: absolute; left: 0; top: 0; height: 100%; width: 4px; background: var(--primary-color); }

        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .stat-card { background: linear-gradient(135deg, var(--primary-color), var(--orange)); padding: 8px; border-radius: 4px; color: #fff; }
        .stat-card.engine-card { grid-column: span 2; background: var(--base02); }
        .stat-title { font-size: 0.75em; opacity: 0.8; }
        .stat-value { font-size: 1em; font-weight: bold; }

        .history-container { position: relative; border: 1px solid var(--border-color); border-radius: 4px; background: var(--card-bg); margin-bottom: 10px; }
        .history-list { max-height: 400px; overflow-y: scroll; padding: 8px; scrollbar-width: none; }
        .history-list::-webkit-scrollbar { display: none; }
        .history-item { background: #fff; border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; margin-bottom: 8px; transition: 0.2s; cursor: pointer; color: var(--text-primary); }
        .history-item:hover { border-color: var(--primary-color); box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .history-item.selected { outline: 2px solid var(--primary-color); border-color: var(--primary-color); }
        .item-time { font-size: 0.7em; color: var(--base01); }
        .item-preview { font-size: 0.85em; white-space: pre-wrap; word-break: break-all; max-height: 4.5em; overflow: hidden; }
        .item-actions { margin-top: 5px; display: flex; gap: 5px; }
        .action-mini-btn { padding: 2px 8px; font-size: 0.75em; border: 1px solid var(--border-color); border-radius: 3px; background: var(--base3); cursor: pointer; color: var(--text-primary); }
        .action-mini-btn:hover { background: var(--primary-color); color: #fff; }

        .music-player { background: var(--base02); color: var(--base3); padding: 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }

        .scrollbar-outer { position: absolute; right: 0; top: 0; width: 6px; height: 100%; z-index: 1000; pointer-events: none; }
        .scrollbar-outer-thumb { position: absolute; right: 1px; width: 4px; background: #000 !important; border-radius: 3px; opacity: 0.4; cursor: pointer; pointer-events: auto; }
        .scrollbar-inner { position: absolute; right: 0; top: 0; width: 6px; height: 100%; z-index: 10; pointer-events: none; }
        .scrollbar-inner-thumb { position: absolute; right: 1px; width: 4px; background: var(--red) !important; border-radius: 3px; opacity: 0.4; cursor: pointer; pointer-events: auto; }
    </style>
</head>
<body>
    <div class="main-wrapper">
        <div class="main-content" id="mainContent">
            <div class="music-player">
                <div style="font-size:0.9em">🎵 <span id="ms">Ready to Savor</span></div>
                <div>
                    <span style="cursor:pointer" id="btnPlayAudio">▶️</span>
                    <span style="cursor:pointer" id="btnStopAudio">⏹️</span>
                </div>
            </div>
            <div class="section-title">Captain</div>
            <div class="captain-grid">
                <div class="cmd-btn" data-cmd="qqq.q1">📋 Paste Everything (F2)</div>
                <div class="cmd-btn" data-cmd="qqq.q2">🌍 Roam Everywhere (F6)</div>
                <div class="cmd-btn" data-cmd="qqq.downloadVideosFromUrl">🎥 Insert Videos</div>
                <div class="cmd-btn" data-cmd="qqq.cleanUp">扫帚 Clean Up</div>
            </div>
            <div class="section-title">Passed by</div>
            <div class="history-container" id="historyContainer">
                <div class="history-list" id="historyList">
                    <div style="text-align:center;padding:20px;opacity:0.5;">加载中...</div>
                </div>
                <div class="scrollbar-inner" id="innerScrollbar"><div class="scrollbar-inner-thumb" id="innerThumb"></div></div>
            </div>
            <div style="display:flex; gap:8px; margin-bottom: 20px;">
                <button class="action-mini-btn" style="flex:1" id="btnRefresh">🔄 刷新</button>
                <button class="action-mini-btn" style="flex:1" id="btnClear">🗑️ 清空</button>
            </div>
            <div class="section-title">Dial</div>
            <div class="stats-grid" id="statsGrid"></div>
            <div style="text-align:center; padding:20px; font-size:0.7em; opacity:0.5;">qqq 领航员</div>
        </div>
        <div class="scrollbar-outer" id="outerScrollbar"><div class="scrollbar-outer-thumb" id="outerThumb"></div></div>
    </div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            const el = {
                historyList: document.getElementById('historyList'),
                statsGrid: document.getElementById('statsGrid'),
                btnRefresh: document.getElementById('btnRefresh'),
                btnClear: document.getElementById('btnClear'),
                btnPlay: document.getElementById('btnPlayAudio'),
                btnStop: document.getElementById('btnStopAudio'),
                mainContent: document.getElementById('mainContent'),
                innerThumb: document.getElementById('innerThumb'),
                outerThumb: document.getElementById('outerThumb'),
                innerScrollbar: document.getElementById('innerScrollbar'),
                outerScrollbar: document.getElementById('outerScrollbar')
            };

            let selectedId = '';
            let selectedIndex = -1;
            let currentHistory = [];

            function post(cmd, data = {}) { vscode.postMessage({ command: cmd, ...data }); }

            function renderStats(stats) {
                if (!el.statsGrid || !stats) return;
                el.statsGrid.innerHTML = '';
                const frag = document.createDocumentFragment();

                const createCard = (title, value, isEngine) => {
                    const card = document.createElement('div');
                    card.className = isEngine ? 'stat-card engine-card' : 'stat-card';
                    const t = document.createElement('div'); t.className = 'stat-title'; t.textContent = title;
                    const v = document.createElement('div'); v.className = 'stat-value'; v.textContent = value;
                    card.appendChild(t); card.appendChild(v);
                    return card;
                };

                frag.appendChild(createCard('陪伴时间', stats.h + 'h ' + stats.m + 'm'));
                frag.appendChild(createCard('缓存量', stats.cacheMB.toFixed(1) + 'MB'));
                frag.appendChild(createCard('引擎', stats.engineInfo.name + ' (' + stats.engineInfo.details + ')', true));
                el.statsGrid.appendChild(frag);
            }

            function renderList(history) {
                currentHistory = history || [];
                el.historyList.innerHTML = '';
                if (currentHistory.length === 0) {
                    el.historyList.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.5;">暂无记录</div>';
                    selectedId = '';
                    selectedIndex = -1;
                    return;
                }

                const frag = document.createDocumentFragment();
                currentHistory.forEach((item, idx) => {
                    const div = document.createElement('div');
                    div.className = 'history-item';
                    if (item.id === selectedId) div.classList.add('selected');
                    div.dataset.id = item.id;
                    div.dataset.index = idx;

                    const time = document.createElement('div'); time.className = 'item-time'; time.textContent = item.time;
                    const prev = document.createElement('div'); prev.className = 'item-preview'; prev.textContent = item.preview;

                    const actions = document.createElement('div'); actions.className = 'item-actions';
                    const btnCopy = document.createElement('button'); btnCopy.className = 'action-mini-btn'; btnCopy.dataset.action = 'copy'; btnCopy.textContent = '📋 复制';
                    const btnPaste = document.createElement('button'); btnPaste.className = 'action-mini-btn'; btnPaste.dataset.action = 'paste'; btnPaste.textContent = '📌 粘贴';
                    const btnInsert = document.createElement('button'); btnInsert.className = 'action-mini-btn'; btnInsert.dataset.action = 'insert'; btnInsert.textContent = '📝 插入';
                    const btnDel = document.createElement('button'); btnDel.className = 'action-mini-btn'; btnDel.dataset.action = 'delete'; btnDel.textContent = '🗑️ 删除';

                    actions.appendChild(btnCopy); actions.appendChild(btnPaste); actions.appendChild(btnInsert); actions.appendChild(btnDel);
                    div.appendChild(time); div.appendChild(prev); div.appendChild(actions);
                    frag.appendChild(div);
                });
                el.historyList.appendChild(frag);

                // ★ 100% 同步 qq 的防御细节：如无选中项，自动选中第一条
                if (selectedId) {
                    setSelectedById(selectedId);
                } else {
                    const first = el.historyList.querySelector('.history-item');
                    if (first) setSelectedById(first.dataset.id);
                }

                setTimeout(updateAllScrollbars, 50);
            }

            function setSelectedById(id) {
                selectedId = id;
                const items = el.historyList.querySelectorAll('.history-item');
                selectedIndex = -1;
                items.forEach((it, i) => {
                    if (it.dataset.id === selectedId) {
                        it.classList.add('selected');
                        selectedIndex = i;
                    } else {
                        it.classList.remove('selected');
                    }
                });
            }

            function ensureSelectedVisible() {
                if (selectedIndex < 0) return;
                const item = el.historyList.querySelectorAll('.history-item')[selectedIndex];
                if (!item) return;
                const top = item.offsetTop, bottom = top + item.offsetHeight;
                const vTop = el.historyList.scrollTop, vBottom = vTop + el.historyList.clientHeight;
                if (top < vTop) el.historyList.scrollTop = top;
                else if (bottom > vBottom) el.historyList.scrollTop = bottom - el.historyList.clientHeight;
            }

            // 事件委托
            el.historyList.addEventListener('click', e => {
                const btn = e.target.closest('button[data-action]');
                const item = e.target.closest('.history-item');
                if (btn) {
                    const action = btn.dataset.action;
                    const id = item.dataset.id;
                    if (action === 'copy') post('copyToClipboard', { itemId: id });
                    if (action === 'paste') post('pasteToEditor', { itemId: id });
                    if (action === 'insert') post('insertToEditor', { itemId: id });
                    if (action === 'delete') post('deleteHistoryItem', { itemId: id });
                    e.stopPropagation();
                    return;
                }
                if (item) {
                    setSelectedById(item.dataset.id);
                    post('copyToClipboard', { itemId: item.dataset.id });
                }
            });

            document.addEventListener('click', e => {
                const cmdBtn = e.target.closest('.cmd-btn');
                if (cmdBtn) post('executeCommand', { cmd: cmdBtn.dataset.cmd });
            });

            el.btnRefresh.onclick = () => post('refresh');
            el.btnClear.onclick = () => post('clearAllHistory');
            el.btnPlay.onclick = () => post('executeCommand', { cmd: 'qqq.savorMoments' });
            el.btnStop.onclick = stopAudio;

            window.addEventListener('message', e => {
                const m = e.data;
                if (m.command === 'updateData') {
                    renderStats(m.stats);
                    renderList(m.history);
                } else if (m.command === 'playAudio') {
                    playAudio(m.base64);
                }
            });

            // 键盘导航 (100% 同步 qq 键盘核心)
            document.addEventListener('keydown', e => {
                if (currentHistory.length === 0) return;
                if (e.key === 'ArrowDown') {
                    selectedIndex = (selectedIndex < 0) ? 0 : Math.min(currentHistory.length - 1, selectedIndex + 1);
                    setSelectedById(currentHistory[selectedIndex].id);
                    ensureSelectedVisible();
                    e.preventDefault();
                } else if (e.key === 'ArrowUp') {
                    selectedIndex = (selectedIndex < 0) ? 0 : Math.max(0, selectedIndex - 1);
                    setSelectedById(currentHistory[selectedIndex].id);
                    ensureSelectedVisible();
                    e.preventDefault();
                } else if (e.key === 'Enter' && selectedIndex >= 0) {
                    const id = currentHistory[selectedIndex].id;
                    if (e.ctrlKey) post('pasteToEditor', { itemId: id });
                    else post('copyToClipboard', { itemId: id });
                    e.preventDefault();
                } else if (e.key === 'Delete' && selectedIndex >= 0) {
                    post('deleteHistoryItem', { itemId: currentHistory[selectedIndex].id });
                    e.preventDefault();
                }
            });

            // 心跳
            setInterval(() => post('heartbeat'), 10000);

            // 音乐播放
            let currentAudio = null;
            function stopAudio() { if(currentAudio) { currentAudio.pause(); currentAudio = null; document.getElementById('ms').innerText = 'Stopped'; } }
            function playAudio(base64) {
                stopAudio();
                const audio = new Audio('data:audio/mp3;base64,' + base64);
                currentAudio = audio; document.getElementById('ms').innerText = 'Savoring...';
                audio.play();
            }

            // 滚动条逻辑
            function setupScrollbar(container, scrollbar, thumb) {
                function update() {
                    const ch = container.clientHeight, sh = container.scrollHeight, st = container.scrollTop;
                    if (sh > ch) {
                        scrollbar.style.display = 'block';
                        const th = Math.max(20, (ch / sh) * ch);
                        thumb.style.height = th + 'px';
                        thumb.style.top = (st / (sh - ch)) * (ch - th) + 'px';
                    } else { scrollbar.style.display = 'none'; }
                }
                container.addEventListener('scroll', update);
                let isDragging = false, startY, startST;
                thumb.onmousedown = e => {
                    isDragging = true; startY = e.clientY; startST = container.scrollTop;
                    document.onmousemove = e => {
                        if (!isDragging) return;
                        const dy = e.clientY - startY;
                        const ch = container.clientHeight, sh = container.scrollHeight, th = thumb.offsetHeight;
                        container.scrollTop = startST + (dy / (ch - th)) * (sh - ch);
                    };
                    document.onmouseup = () => { isDragging = false; document.onmousemove = null; };
                    e.preventDefault();
                };
                return update;
            }
            const upO = setupScrollbar(el.mainContent, el.outerScrollbar, el.outerThumb);
            const upI = setupScrollbar(el.historyList, el.innerScrollbar, el.innerThumb);
            function updateAllScrollbars() { upO(); upI(); }
            window.onresize = updateAllScrollbars;

            post('refresh');
        })();
    </script>
</body>
</html>`;
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

    const clearHistory = async () => {
        if (historyManager) {
            await historyManager.clearHistory({ deleteFiles: true, writeEmptyFile: true });
            // 强力手术：物理删除所有可能的文件格式，根除 BAD_DECRYPT
            try {
                const root = context?.globalStorageUri?.fsPath;
                if (root) {
                    const targets = ['q_history.msgpack', 'q_history.meta', 'history.bin.gz', 'history.json.gz'];
                    targets.forEach(t => {
                        const p = path.join(root, t);
                        if (fs.existsSync(p)) fs.unlinkSync(p);

                        // 同时清理子目录中的文件
                        const subP = path.join(root, 'clipboard-history', t);
                        if (fs.existsSync(subP)) fs.unlinkSync(subP);
                    });
                }
            } catch { }
            console.log('[QSC] 剪贴板历史及物理文件已强力清空');
        }
    };

    // 3. 清空 globalState (高危操作)
    const clearGlobalState = async () => {
        if (!context?.globalState) return;
        try {
            const keys = ['qqq.transactions', 'qqq_config', 'qqq_clipboard_history', 'qqq_history_manager_state'];
            for (const key of keys) {
                await context.globalState.update(key, undefined);
            }
            // 同时清理物理存储文件以解决 BAD_DECRYPT
            const storagePath = path.join(context.globalStorageUri.fsPath, 'q_history.msgpack');
            const metaPath = path.join(context.globalStorageUri.fsPath, 'q_history.meta');
            [storagePath, metaPath].forEach(p => { if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { } });
            console.log('[QSC] globalState 及物理数据已清空');
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

    // ★ 终极加固：启动时强制清理 globalState 中的大键值，解决日志中的 2MB 报警
    const obsoleteKeys = ['qqq_clipboard_history', 'qqq_history_manager_state', 'qqq.transactions.backup'];
    obsoleteKeys.forEach(key => {
        if (context.globalState.get(key) !== undefined) {
            context.globalState.update(key, undefined).then(() => {
                console.log(`[Q4] 已成功从 globalState 卸载旧数据键: ${key}`);
            }, () => { });
        }
    });

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

    // 修复实例化：传入 context, historyManager 和 global 模块
    sidebarProvider = new ClipboardHistorySidebarProvider(context, historyManager, require('./global'));

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

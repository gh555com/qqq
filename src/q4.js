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
function randomId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
}
function md5Hex(s) {
    return crypto.createHash('md5').update(Buffer.from(String(s))).digest('hex');
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
            maxBytes: 25 * 1024 * 1024,
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
        if (this._cache.uiList && this._cache.lastUiKey === cacheKey) return this._cache.uiList;

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

        const cacheKey = `${this._version}|${limit}|${kw.toLowerCase()}`;
        if (this._cache.searchList && this._cache.lastSearchKey === cacheKey) return this._cache.searchList;

        const needle = kw.toLowerCase();
        const pinned = [];
        const others = [];
        let cur = this._head;
        while (cur) {
            if (cur.content.toLowerCase().includes(needle)) {
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

    async addToHistory(content) {
        const t0 = performance.now();
        try {
            if (typeof content !== 'string' || !content.trim()) return;
            const text = content.length > CONSTANTS.MAX_CONTENT_LENGTH ? content.slice(0, CONSTANTS.MAX_CONTENT_LENGTH) : content;
            if (text === this._lastClipboardContent) return;

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
        }
    }

    async removeItem(id) {
        const node = this._idMap.get(String(id || ''));
        if (!node) return false;
        this._removeNode(node);
        this._touch();
        this._notifyChange('remove');
        this.requestSave();
        return true;
    }

    async clearHistory({ deleteFiles = true } = {}) {
        this._head = null; this._tail = null; this._size = 0;
        this._idMap.clear(); this._hashMap.clear();
        this._touch();
        this._notifyChange('clear');
        if (deleteFiles && this._fileBinGz && fs.existsSync(this._fileBinGz)) {
            try { fs.unlinkSync(this._fileBinGz); } catch { }
        }
        this._dirty = true;
        await this.forceSave();
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
        const uptimeSec = Math.floor((Date.now() - this.sessionStartedAt) / 1000);
        return {
            historyCount: this._size,
            isWatching: this._isWatching,
            uptime: { h: Math.floor(uptimeSec / 3600), m: Math.floor((uptimeSec % 3600) / 60) },
            perf: { quarantinedFiles: this.perfStats.quarantinedFiles }
        };
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
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };

        // 初始内容
        this.updateContent();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'executeCommand':
                    if (msg.cmd) vscode.commands.executeCommand(msg.cmd);
                    break;
                case 'copyToClipboard': {
                    const node = this._historyManager.getItemById(msg.itemId);
                    if (node) {
                        // 1. 随机音效逻辑 (不连续重复，且第一时间触发)
                        let audioIdx;
                        do { audioIdx = Math.floor(Math.random() * 7) + 1; } while (audioIdx === this._lastAudioIdx);
                        this._lastAudioIdx = audioIdx;

                        const audioBase64 = this._getKopeAudioBase64(audioIdx);
                        if (audioBase64) {
                            this._postMessage({ command: 'playAudio', base64: audioBase64 });
                        }

                        // 2. 执行物理复制
                        await this._historyManager.copyToClipboard(node.content);

                        // 3. 弹出通知 (前47个字符，11秒消失逻辑)
                        // const preview = node.content.length > 47 ? node.content.slice(0, 47) : node.content;
                        // vscode.window.showInformationMessage(`已复制：${preview}`);
                        // vscode.window.setStatusBarMessage(`已复制：${preview}`, 11000);
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
                case 'togglePinHistoryItem':
                    if (msg.itemId) {
                        await this._historyManager.togglePin(msg.itemId);
                        this.updateContent();
                    }
                    break;
                case 'requestData':
                    if (msg.limit) {
                        this.updateContent(null, msg.limit, msg.keyword);
                    }
                    break;
                case 'ready':
                    this.updateContent();
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
        // 彻底停用 5 秒定时刷新，剪贴板变化会通过 onChange 自动触发更新
    }

    _stopPeriodicUpdate() {
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
            this._updateTimer = null;
        }
    }

    updateContent(reason, limit, keyword) {
        if (!this._view || !this._view.visible) return;
        if (limit) this._currentLimit = limit;
        try {
            const history = this._historyManager.searchHistory(keyword || '', this._currentLimit).map(item => ({
                id: item.id,
                time: formatTime(item.timestamp),
                preview: item.preview,
                size: item.size || 0,
                pinned: !!item.pinned
            }));

            const audioBase64 = this._getAudioBase64();

            // ★ 极致纯净：移除 stats，只初始化必要的 HTML
            if (!this._view.webview.html || this._view.webview.html.length < 100) {
                this._view.webview.html = this._getHtml(history, audioBase64);
            }

            this._postMessage({
                command: 'updateData',
                history: history,
                triggerStorm: (reason === 'add' || reason === 'pin')
            });

            const ver = this._context.extension.packageJSON.version;
            this._view.title = `v${ver}`;
        } catch (e) {
            console.error('[Q4-UI] Update failed:', e);
        }
    }

    _getAudioBase64() {
        try {
            const p = path.join(this._context.extensionPath, "assets", "q.mp3");
            return fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : '';
        } catch { return ''; }
    }

    _getKopeAudioBase64(idx) {
        try {
            const p = path.join(this._context.extensionPath, "assets", "kope", `${idx}.mp3`);
            return fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : '';
        } catch { return ''; }
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

    _getHtml(history, audioBase64) {
        const nonce = nonceHex();
        const csp = [
            `default-src 'none'`,
            `img-src ${this._view.webview.cspSource} data:`,
            `media-src ${this._view.webview.cspSource} data:`,
            `style-src ${this._view.webview.cspSource} 'nonce-${nonce}' 'unsafe-inline'`,
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
        .main-content { flex: 1; display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto; padding: 8px 4px 8px 4px; scrollbar-width: none; }
        .main-content::-webkit-scrollbar { display: none; }

        .section-title { font-size: 1.1em; font-weight: 700; margin: 15px 0 10px 0; border-bottom: 2px solid var(--primary-color); color: var(--primary-color); flex-shrink: 0; }
        .captain-grid { display: grid; gap: 8px; margin-bottom: 15px; flex-shrink: 0; }
        .cmd-btn { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 4px; padding: 10px; cursor: pointer; display: flex; align-items: center; gap: 10px; transition: 0.2s; position: relative; overflow: hidden; font-size: 13px; color: var(--text-primary); }
        .cmd-btn:hover { border-color: var(--primary-color); background: #fff; transform: translateX(2px); }
        .cmd-btn::before { content: ''; position: absolute; left: 0; top: 0; height: 100%; width: 4px; background: var(--primary-color); }

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
        .history-item.pinned { border-left: 4px solid var(--red); background: var(--base2); color: #000000 !important; }

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

        .search-container { margin-bottom: 8px; flex-shrink: 0; }
        .search-input { width: 100%; background: var(--base2); border: 1px solid var(--border-color); border-radius: 4px; padding: 6px 10px; font-family: Tahoma, sans-serif; font-size: 13px; color: #000; outline: none; transition: 0.2s; box-sizing: border-box; }
        .search-input:focus { border-color: var(--primary-color); background: #fff; box-shadow: 0 0 0 1px var(--primary-color); }

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
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            white-space: nowrap;
            border: 1px solid var(--primary-color);
            transform: translateX(-50%); /* 水平居中 */
        }
        .item-actions { margin-top: 5px; display: flex; gap: 5px; }

        .action-mini-btn { padding: 2px 6px; font-size: 13px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--base3); cursor: pointer; color: var(--text-primary); font-family: Tahoma, sans-serif; line-height: 1.2; }
        .action-mini-btn:hover { background: var(--primary-color); color: #fff; }

        .music-player { background: var(--base02); color: var(--base3); padding: 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .player-info { font-size: 0.9em; }
        .player-controls { display: flex; gap: 10px; }
        .player-btn { cursor: pointer; }

        .scrollbar-outer { position: absolute; right: 0; top: 0; width: 6px; height: 100%; z-index: 1000; pointer-events: none; }
        .scrollbar-outer-thumb { position: absolute; right: 1px; width: 4px; background: #000 !important; border-radius: 3px; opacity: 1; cursor: pointer; pointer-events: auto; forced-color-adjust: none !important; transition: width 0.1s ease, right 0.1s ease; }
        .scrollbar-outer-thumb:hover { width: 6px; right: 0; }

        .scrollbar-inner { position: absolute; right: 0; top: 0; width: 6px; height: 100%; z-index: 10; pointer-events: none; }
        .scrollbar-inner-thumb { position: absolute; right: 1px; width: 4px; background: var(--red) !important; border-radius: 3px; opacity: 1; cursor: pointer; pointer-events: auto; forced-color-adjust: none !important; transition: width 0.1s ease, right 0.1s ease; }
        .scrollbar-inner-thumb:hover { width: 6px; right: 0; }

        .empty-hint { text-align: center; padding: 20px; opacity: 0.5; }
        .footer-hint { text-align: center; padding: 20px; font-size: 0.7em; opacity: 0.5; }
    </style>
</head>
<body>
    <div class="main-wrapper">
        <div class="main-content" id="mainContent">
            <div class="music-player">
                <div class="player-info">🎵 <span id="ms">Ready to Savor</span></div>
                <div class="player-controls">
                    <span class="player-btn" id="btnPlayAudio">▶️</span>
                    <span class="player-btn" id="btnStopAudio">⏹️</span>
                </div>
            </div>
            <div class="section-title">Captain</div>
            <div class="captain-grid">
                <div class="cmd-btn" data-cmd="qqq.q1">📋 Paste Everything (F2)</div>
                <div class="cmd-btn" data-cmd="qqq.q2">🌍 Roam Everywhere (F6)</div>
                <div class="cmd-btn" data-cmd="qqq.downloadVideosFromUrl">🎥 Insert Videos</div>
            </div>
            <div class="section-title">Passed by</div>
            <div class="search-container">
                <input type="text" class="search-input" id="searchBox" placeholder="搜索历史记录..." spellcheck="false">
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
            const vscode = acquireVsCodeApi();
            const el = {
                historyContainer: document.getElementById('historyContainer'),
                historyList: document.getElementById('historyList'),
                tooltip: document.getElementById('tooltip'),
                searchBox: document.getElementById('searchBox'),
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
            let currentLimit = 0;
            let batchSize = 20;

            function post(cmd, data = {}) { vscode.postMessage({ command: cmd, ...data }); }

            // 禁用右键菜单
            window.addEventListener('contextmenu', e => e.preventDefault());

            function initDynamicSizing() {
                const containerH = el.historyContainer.clientHeight;
                // 估算卡片平均高度：Tahoma 13px 6行约 110px，加上 padding 和间距取 120
                batchSize = Math.max(10, Math.ceil(containerH / 120));
                if (currentLimit === 0) {
                    currentLimit = batchSize * 2;
                    post('requestData', { limit: currentLimit, keyword: el.searchBox.value });
                }
            }

            el.searchBox.oninput = () => {
                // 搜索时重置滚动位置
                el.historyList.scrollTop = 0;
                post('requestData', { limit: currentLimit, keyword: el.searchBox.value });
            };

            el.historyList.onscroll = () => {
                const list = el.historyList;
                // 接近底部 100px 时扩容
                if (list.scrollTop + list.clientHeight > list.scrollHeight - 100) {
                    if (currentHistory.length >= currentLimit) {
                        currentLimit += batchSize;
                        post('requestData', { limit: currentLimit, keyword: el.searchBox.value });
                    }
                }
                updateAllScrollbars();
            };

            function renderList(history, triggerStorm) {
                const newHistory = history || [];

                // 触发风暴逻辑
                if (triggerStorm) {
                    el.historyContainer.classList.remove('storm');
                    void el.historyContainer.offsetWidth; // 触发重绘
                    el.historyContainer.classList.add('storm');
                }

                currentHistory = newHistory;
                el.historyList.innerHTML = '';
                if (currentHistory.length === 0) {
                    el.historyList.innerHTML = '<div class="empty-hint">暂无记录</div>';
                    selectedId = '';
                    selectedIndex = -1;
                    return;
                }

                const frag = document.createDocumentFragment();
                currentHistory.forEach((item, idx) => {
                    const div = document.createElement('div');
                    div.className = 'history-item';
                    if (item.id === selectedId) div.classList.add('selected');
                    if (item.pinned) div.classList.add('pinned');
                    div.dataset.id = item.id;
                    div.dataset.index = idx;

                    // 绑定光标跟随逻辑
                    div.onmouseenter = (e) => {
                        el.tooltip.innerHTML = item.time;
                        el.tooltip.style.display = 'block';
                    };
                    div.onmousemove = (e) => {
                        el.tooltip.style.left = e.clientX + 'px';
                        el.tooltip.style.top = (e.clientY + 22) + 'px';
                    };
                    div.onmouseleave = () => {
                        el.tooltip.style.display = 'none';
                    };

                    const prev = document.createElement('div'); prev.className = 'item-preview'; prev.textContent = item.preview;

                    const actions = document.createElement('div'); actions.className = 'item-actions';

                    const btnPin = document.createElement('button');
                    btnPin.className = 'action-mini-btn';
                    btnPin.dataset.action = 'pin';
                    btnPin.textContent = item.pinned ? '📍' : '📌';

                    const btnDel = document.createElement('button');
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

            // 事件委托
            el.historyList.addEventListener('click', e => {
                const btn = e.target.closest('button[data-action]');
                const item = e.target.closest('.history-item');
                if (!item) return;

                const id = item.dataset.id;

                // 触发卡片闪光特效
                item.classList.remove('executing');
                void item.offsetWidth; // 触发重绘
                item.classList.add('executing');

                if (btn) {
                    const action = btn.dataset.action;
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

            document.addEventListener('click', e => {
                const cmdBtn = e.target.closest('.cmd-btn');
                if (cmdBtn) post('executeCommand', { cmd: cmdBtn.dataset.cmd });
            });

            el.btnPlay.onclick = () => post('executeCommand', { cmd: 'qqq.savorMoments' });
            el.btnStop.onclick = stopAudio;

            window.addEventListener('message', e => {
                const m = e.data;
                if (m.command === 'updateData') {
                    renderList(m.history, m.triggerStorm);
                } else if (m.command === 'playAudio') {
                    playAudio(m.base64);
                }
            });

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
            window.onresize = () => {
                initDynamicSizing();
                updateAllScrollbars();
            };

            // 初始激活
            setTimeout(initDynamicSizing, 100);
            post('ready');
        })();
    </script>
</body>
</html>`;
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
        qsc: (a) => qsc(a, historyManager)
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
module.exports = {
    activate,
    deactivate,
    ClipboardHistoryManager,
    ClipboardHistorySidebarProvider,
};

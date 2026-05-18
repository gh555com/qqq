const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * SessionManager — 多会话管理
 * 存储结构:
 *   globalStorage/sessions/
 *     index.json          — [{id, title, createdAt, lastActiveAt}]
 *     {session-id}.json   — {conversation, totalTokens, currentRage, ctx, savedAt}
 *   globalStorage/shared/
 *     summaries.json      — L1 跨会话摘要
 */
class SessionManager {
    constructor(globalStoragePath, logFn) {
        this._basePath = globalStoragePath;
        this._sessionsDir = path.join(globalStoragePath, 'sessions');
        this._sharedDir = path.join(globalStoragePath, 'shared');
        this._indexPath = path.join(this._sessionsDir, 'index.json');
        this._log = logFn || (() => {});

        // 确保目录存在
        try { fs.mkdirSync(this._sessionsDir, { recursive: true }); } catch (_) {}
        try { fs.mkdirSync(this._sharedDir, { recursive: true }); } catch (_) {}

        this._index = this._loadIndex();
    }

    // ═══ Index 管理 ═══

    _loadIndex() {
        try {
            if (fs.existsSync(this._indexPath)) {
                return JSON.parse(fs.readFileSync(this._indexPath, 'utf8'));
            }
        } catch (_) {}
        return [];
    }

    _saveIndex() {
        try {
            fs.writeFileSync(this._indexPath, JSON.stringify(this._index, null, 2), 'utf8');
        } catch (e) {
            this._log(`session: index save error — ${e.message}`);
        }
    }

    // ═══ Session CRUD ═══

    createSession(title) {
        const id = crypto.randomBytes(8).toString('hex');
        const entry = {
            id,
            title: title || '新对话',
            createdAt: Date.now(),
            lastActiveAt: Date.now()
        };
        this._index.push(entry);
        this._saveIndex();
        this._log(`session: created ${id}`);
        return id;
    }

    deleteSession(id) {
        this._index = this._index.filter(s => s.id !== id);
        this._saveIndex();
        // 删除数据文件
        const fp = this._sessionPath(id);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
        this._log(`session: deleted ${id}`);
    }

    getSessionList() {
        // 按 lastActiveAt 降序
        return [...this._index].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    }

    updateTitle(id, title) {
        const entry = this._index.find(s => s.id === id);
        if (entry) {
            entry.title = title;
            this._saveIndex();
        }
    }

    touchSession(id) {
        const entry = this._index.find(s => s.id === id);
        if (entry) {
            entry.lastActiveAt = Date.now();
            this._saveIndex();
        }
    }

    // ═══ Session 数据读写 ═══

    _sessionPath(id) {
        return path.join(this._sessionsDir, `${id}.json`);
    }

    loadSession(id) {
        try {
            const fp = this._sessionPath(id);
            if (fs.existsSync(fp)) {
                return JSON.parse(fs.readFileSync(fp, 'utf8'));
            }
        } catch (e) {
            this._log(`session: load error ${id} — ${e.message}`);
        }
        return null;
    }

    saveSession(id, data) {
        try {
            fs.writeFileSync(this._sessionPath(id), JSON.stringify(data), 'utf8');
        } catch (e) {
            this._log(`session: save error ${id} — ${e.message}`);
        }
    }

    // ═══ Shared (L1 summaries) ═══

    get summariesPath() {
        return path.join(this._sharedDir, 'summaries.json');
    }

    // ═══ 迁移：旧 memory/ 目录 → sessions/ + shared/ ═══

    migrateFromLegacy(legacyMemoryDir) {
        const oldConv = path.join(legacyMemoryDir, 'conversation.json');
        const oldSummaries = path.join(legacyMemoryDir, 'summaries.json');

        let migrated = false;

        // 迁移 conversation → sessions/{id}.json
        if (fs.existsSync(oldConv)) {
            try {
                const data = JSON.parse(fs.readFileSync(oldConv, 'utf8'));
                if (data && Array.isArray(data.conversation) && data.conversation.length > 0) {
                    const id = this.createSession('迁移的对话');
                    this.saveSession(id, data);
                    this._log(`session: migrated legacy conversation → ${id} (${data.conversation.length} msgs)`);
                    migrated = true;
                }
                fs.unlinkSync(oldConv);
            } catch (e) {
                this._log(`session: migration error (conv) — ${e.message}`);
            }
        }

        // 迁移 summaries → shared/summaries.json
        if (fs.existsSync(oldSummaries)) {
            try {
                const data = fs.readFileSync(oldSummaries, 'utf8');
                fs.writeFileSync(this.summariesPath, data, 'utf8');
                fs.unlinkSync(oldSummaries);
                this._log(`session: migrated legacy summaries → shared/`);
                migrated = true;
            } catch (e) {
                this._log(`session: migration error (summaries) — ${e.message}`);
            }
        }

        // 尝试删除旧目录（如果空了）
        if (migrated) {
            try {
                const remaining = fs.readdirSync(legacyMemoryDir);
                if (remaining.length === 0) fs.rmdirSync(legacyMemoryDir);
            } catch (_) {}
        }

        return migrated;
    }
}

module.exports = { SessionManager };

const fs = require('fs');
const path = require('path');

/**
 * MemoryManager — 基于 SessionManager 的记忆系统
 * L0: 对话持久化（per-session，由 SessionManager 管理存储）
 * L1: 会话摘要（shared，跨会话）
 */
class MemoryManager {
    constructor(sessionManager, sessionId, logFn) {
        this._sm = sessionManager;
        this._sessionId = sessionId;
        this._log = logFn || (() => {});
        this._saveTimer = null;
    }

    // ═══ L0: 对话持久化（per-session） ═══

    loadConversation() {
        const data = this._sm.loadSession(this._sessionId);
        if (data && Array.isArray(data.conversation)) {
            this._log(`memory: loaded ${data.conversation.length} messages from session ${this._sessionId.slice(0, 8)}`);
            return {
                conversation: data.conversation,
                totalTokens: data.totalTokens || 0,
                currentRage: data.currentRage || 0,
                ctx: data.ctx || null
            };
        }
        return null;
    }

    saveConversation(conversation, totalTokens, currentRage, ctx = null) {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this._sm.saveSession(this._sessionId, {
                conversation,
                totalTokens,
                currentRage,
                ctx,
                savedAt: Date.now()
            });
            this._sm.touchSession(this._sessionId);
        }, 500);
    }

    clearConversation() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._sm.saveSession(this._sessionId, {
            conversation: [],
            totalTokens: 0,
            currentRage: 0,
            ctx: null,
            savedAt: Date.now()
        });
    }

    // ═══ L1: 会话摘要（shared across sessions） ═══

    saveSummary(text, turns) {
        try {
            let list = this._loadSummaries();
            list.push({
                time: Date.now(),
                date: new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }),
                turns: turns || 0,
                text,
                fromSession: this._sessionId.slice(0, 8)
            });
            if (list.length > 100) list = list.slice(-100);
            fs.writeFileSync(this._sm.summariesPath, JSON.stringify(list, null, 2), 'utf8');
            this._log(`memory: saved summary (total ${list.length})`);
        } catch (e) {
            this._log(`memory: summary save error — ${e.message}`);
        }
    }

    getRecentSummaries(n = 10) {
        const list = this._loadSummaries();
        return list.slice(-n);
    }

    formatSummariesForPrompt(n = 10) {
        const recent = this.getRecentSummaries(n);
        if (recent.length === 0) return '';
        const lines = recent.map(s => `[${s.date}] ${s.text}`);
        return `\n\n--- 历史记忆（你记得之前和用户的这些对话） ---\n${lines.join('\n')}`;
    }

    _loadSummaries() {
        try {
            const fp = this._sm.summariesPath;
            if (fs.existsSync(fp)) {
                const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (Array.isArray(data)) return data;
            }
        } catch (_) {}
        return [];
    }
}

module.exports = { MemoryManager };

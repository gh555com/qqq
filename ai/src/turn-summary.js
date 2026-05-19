// ═══════════════════════════════════════════════════════════════
// turn-summary.js — 流式 turn_summary 剥离器
// 从 agent.js 提取：从 AI 回复中实时分离 <turn_summary> 标签
// ═══════════════════════════════════════════════════════════════

class TurnSummaryStripper {
    constructor(onToken) {
        this.onToken = onToken;
        this.raw = '';            // 完整原始 content（含标签）
        this.emitted = 0;         // 已 emit 给 UI 的字符数（raw 中的下标）
        this._OPEN = '<turn_summary';
        this._CLOSE = '</turn_summary>';
    }
    push(chunk) {
        if (!chunk) return;
        this.raw += chunk;
        const openIdx = this.raw.indexOf(this._OPEN);
        let safeUpTo;
        if (openIdx >= 0) {
            // 已找到开始标签：标签前的内容可以全部 emit，标签开始后绝不 emit
            safeUpTo = openIdx;
        } else {
            // 未找到：保留末尾 OPEN.length 字符作为缓冲，以防标签被切碎在 chunk 边界
            safeUpTo = Math.max(this.emitted, this.raw.length - this._OPEN.length);
        }
        if (safeUpTo > this.emitted) {
            const piece = this.raw.slice(this.emitted, safeUpTo);
            if (this.onToken) this.onToken(piece);
            this.emitted = safeUpTo;
        }
    }
    // 返回 { cleanContent, summary, lang }：cleanContent 用于推入 conversation
    finalize() {
        // emit 残余（无 tag 的情况）
        const openIdx = this.raw.indexOf(this._OPEN);
        if (openIdx < 0 && this.emitted < this.raw.length) {
            const piece = this.raw.slice(this.emitted);
            if (this.onToken) this.onToken(piece);
            this.emitted = this.raw.length;
        }
        // 解析 tag
        let summary = '', lang = '';
        const m = this.raw.match(/<turn_summary([^>]*)>([\s\S]*?)(?:<\/turn_summary>|$)/);
        if (m) {
            summary = (m[2] || '').trim();
            const langMatch = m[1].match(/lang=["']([^"']+)["']/);
            if (langMatch) lang = langMatch[1];
        }
        // cleanContent：剥离整段 tag
        const cleanContent = this.raw.replace(/\s*<turn_summary[^>]*>[\s\S]*?(?:<\/turn_summary>|$)\s*$/, '').trim();
        return { cleanContent, summary, lang };
    }
}

module.exports = { TurnSummaryStripper };

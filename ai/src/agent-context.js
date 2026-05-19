// ═══════════════════════════════════════════════════════════════
// agent-context.js — 上下文引擎 mixin
// _compressContext, _digestColdMessages, _retrieveRelevantFacts,
// _buildDynamicContext, _extractTurnMarkers
// ═══════════════════════════════════════════════════════════════

const vscode = require('vscode');
const { GATEWAY_URL } = require('./prompt');

module.exports = function(Agent) {

    /**
     * 从 assistant 消息文本中抽取 📌 回合总结 和 💎 核心财宝
     */
    Agent.prototype._extractTurnMarkers = function(content) {
        if (!content) return;
        const pinMatch = content.match(/(?:^|\n)📌\s*(.+?)(?:\n|$)/);
        if (pinMatch) {
            const summary = pinMatch[1].trim().slice(0, 200);
            if (summary) {
                this._ctx.turnSummaries.push({ turn: this._ctx.totalTurns, summary });
                if (this._ctx.turnSummaries.length > 50) this._ctx.turnSummaries = this._ctx.turnSummaries.slice(-50);
            }
        }
        const treasureMatch = content.match(/(?:^|\n)💎\s*(.+?)(?:\n|$)/);
        if (treasureMatch) {
            const treasure = treasureMatch[1].trim().slice(0, 300);
            if (treasure) {
                this._ctx.treasures.push({ turn: this._ctx.totalTurns, content: treasure });
                if (this._ctx.treasures.length > 30) this._ctx.treasures = this._ctx.treasures.slice(-30);
            }
        }
    };

    /**
     * 自适应窗口压缩
     */
    Agent.prototype._compressContext = function() {
        const TOKEN_BUDGET = 800000;
        const MIN_KEEP = 6;
        let totalEst = 0;
        for (const m of this.conversation) {
            totalEst += (m.content || '').length / 4;
        }
        if (totalEst <= TOKEN_BUDGET || this.conversation.length <= MIN_KEEP) return;
        const coldMsgs = [];
        while (totalEst > TOKEN_BUDGET && this.conversation.length > MIN_KEEP) {
            const removed = this.conversation.shift();
            totalEst -= (removed.content || '').length / 4;
            coldMsgs.push(removed);
        }
        if (coldMsgs.length > 0) {
            this._log(`◆ Context engine: moved ${coldMsgs.length} msgs to cold (hot=${this.conversation.length}, ~${Math.round(totalEst)}tok)`);
            this._digestColdMessages(coldMsgs);
        }
    };

    /**
     * 结构化事实提取 + 叙事更新
     */
    Agent.prototype._digestColdMessages = async function(coldMsgs) {
        const coldText = coldMsgs.map(m => {
            const role = m.role === 'tool' ? 'tool_result' : m.role;
            const content = (m.content || '').slice(0, 500);
            return `[${role}] ${content}`;
        }).join('\n');
        if (!coldText.trim()) return;
        this._ctx.totalTurns += coldMsgs.filter(m => m.role === 'user').length;

        const extractPrompt = `You are a context memory engine. Given conversation messages, extract TWO things:

1. FACTS: Structured facts as JSON array. Each fact: {"type": "file"|"decision"|"error"|"code_change"|"preference"|"context", "content": "...", "keywords": ["k1","k2"]}
   - file: file paths read/written/mentioned
   - decision: choices made and why
   - error: problems encountered
   - code_change: what was modified
   - preference: user preferences discovered
   - context: important contextual info

2. NARRATIVE: Update the running narrative (max 200 words) to incorporate new information.

Current narrative: ${this._ctx.narrative || '(empty)'}

New messages:
${coldText}

Output ONLY valid JSON:
{"facts": [...], "narrative": "..."}`;

        try {
            const token = await this._getAuthToken();
            if (!token) return;
            const resp = await fetch(GATEWAY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'Extract structured facts and update narrative. Output ONLY valid JSON. Be extremely precise and concise.' },
                        { role: 'user', content: extractPrompt }
                    ],
                    stream: false,
                    thinking: { type: 'disabled' }
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                const text = data.choices?.[0]?.message?.content;
                if (text) {
                    const match = text.match(/\{[\s\S]*\}/);
                    if (match) {
                        const parsed = JSON.parse(match[0]);
                        if (parsed.facts && Array.isArray(parsed.facts)) {
                            for (const fact of parsed.facts) {
                                fact.turn = this._ctx.totalTurns;
                                this._ctx.facts.push(fact);
                            }
                            if (this._ctx.facts.length > 100) {
                                this._ctx.facts = this._ctx.facts.slice(-100);
                            }
                        }
                        if (parsed.narrative) {
                            this._ctx.narrative = parsed.narrative;
                        }
                        this._log(`◆ Context engine: +${parsed.facts?.length || 0} facts, narrative=${this._ctx.narrative.length}c, total facts=${this._ctx.facts.length}`);
                    }
                }
            }
        } catch (e) {
            this._log(`⚠ context digest failed: ${e.message}`);
            this._ctx.narrative = (this._ctx.narrative + ' ' + coldText.slice(0, 200)).slice(-1000);
        }
    };

    /**
     * 语义检索相关事实
     */
    Agent.prototype._retrieveRelevantFacts = function(query, maxFacts = 15) {
        if (this._ctx.facts.length === 0) return [];
        const queryTokens = query.toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff_./\\-]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 1);
        const scored = this._ctx.facts.map(fact => {
            let score = 0;
            const factText = (fact.content + ' ' + (fact.keywords || []).join(' ')).toLowerCase();
            for (const token of queryTokens) {
                if (factText.includes(token)) score += 2;
            }
            score += (fact.turn || 0) / (this._ctx.totalTurns || 1) * 0.5;
            return { fact, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.filter(s => s.score > 0).slice(0, maxFacts).map(s => s.fact);
    };

    /**
     * 构建动态上下文（注入最后一条 user message 末尾）
     */
    Agent.prototype._buildDynamicContext = function(currentQuery = '') {
        let ctx = '';
        if (this._ctx.narrative) {
            ctx += `CONVERSATION CONTEXT (compressed history):\n${this._ctx.narrative}`;
        }
        if (currentQuery && this._ctx.facts.length > 0) {
            const relevant = this._retrieveRelevantFacts(currentQuery, 15);
            if (relevant.length > 0) {
                const factsBlock = relevant.map(f => `- [${f.type}] ${f.content}`).join('\n');
                ctx += `\n\nRELEVANT FACTS FROM EARLIER (${relevant.length}/${this._ctx.facts.length} total):\n${factsBlock}`;
            }
        } else if (this._ctx.facts.length > 0) {
            const recent = this._ctx.facts.slice(-10);
            const factsBlock = recent.map(f => `- [${f.type}] ${f.content}`).join('\n');
            ctx += `\n\nRECENT CONTEXT FACTS:\n${factsBlock}`;
        }
        if (this._ctx.turnSummaries.length > 0) {
            const recentSummaries = this._ctx.turnSummaries.slice(-20);
            const summaryLines = recentSummaries.map(s => `📌 ${s.summary}`).join('\n');
            ctx += `\n\nTURN CHECKPOINTS (what was accomplished in recent turns):\n${summaryLines}`;
        }
        if (this._ctx.treasures.length > 0) {
            const recentTreasures = this._ctx.treasures.slice(-15);
            const treasureLines = recentTreasures.map(t => `💎 ${t.content}`).join('\n');
            ctx += `\n\nKEY DISCOVERIES (emerging issues / opportunities to watch):\n${treasureLines}`;
        }
        if (this.memory) {
            const memorySuffix = this.memory.formatSummariesForPrompt(10);
            if (memorySuffix) ctx += memorySuffix;
        }
        try {
            const qqqExt = vscode.extensions.getExtension('gh555.qqq');
            if (qqqExt && qqqExt.isActive && qqqExt.exports && qqqExt.exports.getScopeAPI) {
                const scope = qqqExt.exports.getScopeAPI();
                const folders = scope.getAllFolders();
                if (folders.length > 0) {
                    const list = folders.map(f => {
                        const eye = f.visible ? '\u{1F441}' : '\u{1F6AB}';
                        return `  ${eye} ${f.name} (${f.path})`;
                    }).join('\n');
                    ctx += `\n\nCURRENT VISION SCOPE:\n${list}`;
                }
            } else {
                const wf = vscode.workspace.workspaceFolders;
                if (wf && wf.length > 0) {
                    const list = wf.map(f => `  ${f.name} (${f.uri.fsPath})`).join('\n');
                    ctx += `\n\nCURRENT WORKSPACE:\n${list}`;
                }
            }
        } catch (_) {}
        return ctx.trim() ? `[DYNAMIC CONTEXT]\n${ctx}` : '';
    };
};

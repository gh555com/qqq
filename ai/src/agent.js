// ═══════════════════════════════════════════════════════════════
// agent.js — Agent 类核心
// 模块化后：构造函数 + sendMessage + executeTask + clearConversation
// 其余逻辑通过 mixin 挂载在文件末尾
// ═══════════════════════════════════════════════════════════════

const vscode = require('vscode');
const crypto = require('crypto');
const { getTools, executeTool } = require('./tools');
const { MemoryManager } = require('./memory');
const {
    GATEWAY_URL, SYSTEM_PROMPT,
    TRIVIAL_REGEX, CHAT_REGEX, TIER_FLASH, TIER_PRO_MAX
} = require('./prompt');

class Agent {
    constructor(context, logFn, memory) {
        this.context = context;
        this.conversation = [];
        this.abortController = null;
        this.totalTokens = 0;
        this.currentRage = 0;
        this._log = logFn || (() => {});
        this._onRageChange = null;
        this._onHpChange = null;
        this._onRestore = null;
        this._onRageDot = null;
        this._turnCostWge = 0;
        // ━━━ 完美上下文引擎 ━━━
        this._visionCache = new Map();
        this._ctx = {
            facts: [],
            narrative: '',
            turnSummaries: [],
            treasures: [],
            totalTurns: 0
        };
        this.memory = memory || null;
        // ━━━ 指标收集系统 ━━━
        this._metrics = {
            turn: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, toolCount: 0, costGe: 0, durationMs: 0, tier: '—', freeWindow: false, jsonMode: false, retries: 0, tokPerSec: 0, toolAvgMs: 0, toolTotalMs: 0, cnySaved: 0, maxTokens: 32768, ttftMs: 0 },
            session: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, costGe: 0, toolCount: 0, turns: 0, retries: 0, cnySaved: 0, totalDurationMs: 0 },
            engine: { factsCount: 0, narrativeLen: 0, ctxPct: 0, warmupStatus: 'none', lastCallTs: 0 }
        };
        this._onMetrics = null;
        this._turnStart = 0;
        this._requestStartMs = 0;
        this._warmupStatus = 'none';
        this._lastCallTs = 0;
        // ━━━ Lifetime 持久化 ━━━
        this._lifetime = this.context.globalState.get('qqq-ai.lifetimeMetrics') || {
            promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
            costGe: 0, cnySaved: 0, turns: 0, sessions: 0, retries: 0, durationMs: 0
        };
        this._lifetime.sessions += 1;
        this._persistLifetime();
        this._restoreFromMemory();
    }

    onRestore(fn) { this._onRestore = fn; }

    _restoreFromMemory() {
        if (!this.memory) return;
        const saved = this.memory.loadConversation();
        if (saved && saved.conversation.length > 0) {
            this.conversation = saved.conversation;
            this.totalTokens = saved.totalTokens;
            this.currentRage = saved.currentRage;
            this._ctx = saved.ctx || { facts: [], narrative: '', turnSummaries: [], treasures: [], totalTurns: 0 };
            if (!Array.isArray(this._ctx.turnSummaries)) this._ctx.turnSummaries = [];
            if (!Array.isArray(this._ctx.treasures)) this._ctx.treasures = [];
            if (typeof this._ctx.totalTurns !== 'number') this._ctx.totalTurns = this._ctx.totalTurns || 0;
            this._log(`memory: restored ${saved.conversation.length} msgs, rage=${saved.currentRage}, facts=${this._ctx.facts.length}, narrative=${this._ctx.narrative.length}c`);
        }
    }

    // ═══ UI 回调注册 ═══
    onRageChange(fn) { this._onRageChange = fn; }
    onHpChange(fn) { this._onHpChange = fn; }
    onRageDot(fn) { this._onRageDot = fn; }
    onMetrics(fn) { this._onMetrics = fn; }

    _emitMetrics() {
        this._metrics.engine.factsCount = this._ctx.facts.length;
        this._metrics.engine.narrativeLen = (this._ctx.narrative || '').length;
        this._metrics.engine.ctxPct = Math.min(100, Math.round((this.totalTokens / 800000) * 100));
        this._metrics.engine.warmupStatus = this._warmupStatus;
        this._metrics.engine.lastCallTs = this._lastCallTs;
        this._metrics.lifetime = { ...this._lifetime };
        if (this._onMetrics) {
            const m = this._metrics;
            this._onMetrics({ turn: { ...m.turn }, session: { ...m.session }, engine: { ...m.engine }, lifetime: { ...m.lifetime } });
        }
    }

    _persistLifetime() {
        if (this._lifetimeTimer) clearTimeout(this._lifetimeTimer);
        this._lifetimeTimer = setTimeout(() => {
            this.context.globalState.update('qqq-ai.lifetimeMetrics', this._lifetime);
        }, 2000);
    }

    _flushLifetime() {
        if (this._lifetimeTimer) { clearTimeout(this._lifetimeTimer); this._lifetimeTimer = null; }
        this.context.globalState.update('qqq-ai.lifetimeMetrics', this._lifetime);
    }

    // ═══ 缓存预热 ═══
    async warmupCache() {
        if (this._cacheWarmed) return;
        this._cacheWarmed = true;
        this._warmupStatus = 'pending';
        try {
            const token = await this._getAuthToken();
            if (!token) { this._cacheWarmed = false; this._warmupStatus = 'fail'; return; }
            fetch(GATEWAY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: 'ping' }
                    ],
                    stream: false, max_tokens: 1,
                    thinking: { type: 'disabled' },
                    turn_id: 'warmup'
                })
            }).then(r => {
                this._warmupStatus = r.ok ? 'ok' : 'fail';
                this._log(`cache warmup: ${r.status} (${this._warmupStatus})`);
                if (this._onMetrics) this._emitMetrics();
            }).catch(err => {
                this._warmupStatus = 'fail';
                this._log(`cache warmup failed (non-critical): ${err.message}`);
                if (this._onMetrics) this._emitMetrics();
            });
        } catch (err) {
            this._warmupStatus = 'fail';
            this._log(`cache warmup error: ${err.message}`);
        }
    }

    _updateRage(rage) {
        this.currentRage = rage;
        if (this._onRageChange) this._onRageChange(rage);
    }

    _updateHp(delta = 0) {
        this.totalTokens += delta;
        const maxTokens = 800000;
        const percent = Math.min(100, Math.round((this.totalTokens / maxTokens) * 100));
        if (this._onHpChange) this._onHpChange(percent, this.totalTokens);
    }

    _pushConversation(msg) {
        this.conversation.push(msg);
        if (msg.role === 'user') this._ctx.totalTurns++;
        const content = msg.content || '';
        this._updateHp(Math.round(content.length / 4));
        this._compressContext();
        if (this.memory) this.memory.saveConversation(this.conversation, this.totalTokens, this.currentRage, this._ctx);
        if (msg.role === 'assistant' && msg.content) {
            this._extractTurnMarkers(msg.content);
        }
    }

    // ═══ 主入口：单通道架构 ═══
    async sendMessage(doerMessage, opts = {}) {
        const { onToken, onToolCall, onDone, onError } = opts;
        this._log(`→ doer: ${doerMessage.slice(0, 80)}`);
        this._pushConversation({ role: 'user', content: doerMessage });

        this._turnCostWge = 0;
        this._turnId = crypto.randomUUID();
        this._currentTurnSummary = '';
        this._currentTurnSummaryLang = '';
        this._turnStart = Date.now();
        this._metrics.turn = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, toolCount: 0, costGe: 0, durationMs: 0, tier: '—', freeWindow: false, jsonMode: false, retries: 0, tokPerSec: 0, toolAvgMs: 0, toolTotalMs: 0, cnySaved: 0, maxTokens: 32768, ttftMs: 0 };
        this._actualModel = null;

        try {
            const isTrivial = TRIVIAL_REGEX.test(doerMessage.trim());
            const isChat = !isTrivial && CHAT_REGEX.test(doerMessage.trim());
            const tier = isTrivial ? TIER_FLASH : TIER_PRO_MAX;
            this._metrics.turn.tier = tier.label;
            this._log(`◆ ${tier.label} (trivial=${isTrivial}, chat=${isChat})`);

            // 多图自动分析
            if (this._pendingImages && this._pendingImages.length > 0) {
                this._log(`◆ Analyzing ${this._pendingImages.length} image(s) in parallel...`);
                const analyzeOne = async (img) => {
                    if (onToolCall) onToolCall({ function: { name: 'analyze_image', arguments: `{"id":${img.id}}` } });
                    const hash = crypto.createHash('md5').update(img.base64).digest('hex');
                    const cached = this._visionCache.get(hash);
                    if (cached) {
                        this._log(`  ✓ image #${img.id} cached (${hash.slice(0, 8)})`);
                        return { id: img.id, result: cached, cached: true };
                    }
                    const result = await executeTool('analyze_image', { base64: img.base64 });
                    if (typeof result === 'object' && result.description) {
                        this._visionCache.set(hash, result);
                    }
                    return { id: img.id, result, cached: false };
                };
                const results = await Promise.all(this._pendingImages.map(img => analyzeOne(img)));
                const imgResults = [];
                for (const { id, result, cached } of results) {
                    if (!cached) this._accumulateVisionCost(result);
                    const desc = (typeof result === 'object') ? result.description : result;
                    imgResults.push(`[Image #${id} Vision Analysis]:\n${desc}`);
                }
                if (imgResults.length > 0) {
                    const lastMsg = this.conversation[this.conversation.length - 1];
                    if (lastMsg && lastMsg.role === 'user') {
                        lastMsg.content += `\n\n━━━ VISION ANALYSIS RESULTS (already completed, DO NOT call analyze_image again for these) ━━━\n${imgResults.join('\n\n')}\n━━━ END VISION RESULTS ━━━`;
                    } else {
                        this._pushConversation({
                            role: 'user',
                            content: `━━━ VISION ANALYSIS RESULTS (already completed, DO NOT call analyze_image again for these) ━━━\n${imgResults.join('\n\n')}\n━━━ END VISION RESULTS ━━━\nAnswer based on the vision analysis above.`
                        });
                    }
                }
            }
            this._pendingImages = null;

            const result = await this._executeWithTools(opts, tier, { noTools: isTrivial || isChat });

            this._buildAndFlushBilling(doerMessage, result);

            // ━━━ 指标汇总 ━━━
            this._metrics.turn.durationMs = Date.now() - this._turnStart;
            this._metrics.turn.costGe = this._turnCostWge / 10000;
            this._metrics.turn.freeWindow = !!this._lastBillingFreeWindow;
            this._metrics.turn.tokPerSec = this._metrics.turn.durationMs > 0
                ? Math.round(this._metrics.turn.completionTokens / this._metrics.turn.durationMs * 1000) : 0;
            this._metrics.turn.cnySaved = this._metrics.turn.cacheHitTokens * 2.975 / 1000000;
            this._metrics.turn.toolAvgMs = this._metrics.turn.toolCount > 0
                ? Math.round(this._metrics.turn.toolTotalMs / this._metrics.turn.toolCount) : 0;
            // Session 累加
            this._metrics.session.costGe += this._metrics.turn.costGe;
            this._metrics.session.toolCount += this._metrics.turn.toolCount;
            this._metrics.session.turns += 1;
            this._metrics.session.retries += this._metrics.turn.retries;
            this._metrics.session.cnySaved += this._metrics.turn.cnySaved;
            this._metrics.session.totalDurationMs += this._metrics.turn.durationMs;
            // Lifetime 累计
            this._lifetime.promptTokens += this._metrics.turn.promptTokens;
            this._lifetime.completionTokens += this._metrics.turn.completionTokens;
            this._lifetime.cacheHitTokens += this._metrics.turn.cacheHitTokens;
            this._lifetime.cacheMissTokens += this._metrics.turn.cacheMissTokens;
            this._lifetime.costGe += this._metrics.turn.costGe;
            this._lifetime.cnySaved += this._metrics.turn.cnySaved;
            this._lifetime.retries += this._metrics.turn.retries;
            this._lifetime.durationMs += this._metrics.turn.durationMs;
            this._lifetime.turns += 1;
            this._persistLifetime();
            this._emitMetrics();

            if (opts.onCost) {
                if (this._lastBillingFreeWindow) {
                    opts.onCost('free');
                    this._log('  cost: 0 ge (免费时段)');
                } else if (this._turnCostWge > 0) {
                    const costGe = this._turnCostWge / 10000;
                    const display = costGe < 0.001 ? '<0.001' : costGe.toFixed(4);
                    this._log(`  cost: ${display} ge (from server, wge=${this._turnCostWge})`);
                    opts.onCost(display);
                }
            }
            return result;
        } catch (err) {
            this._log(`✗ agent error: ${err.message}`);
            if (onError) onError(err.message);
            return null;
        }
    }

    // ═══ 工具循环 ═══
    async _executeWithTools(opts, tier, extra = {}) {
        const { onToken, onToolCall, onDone, onError } = opts;
        const forceNoTools = extra.noTools || false;
        let maxIterations = forceNoTools ? 1 : 200;
        const conversationSnapshot = this.conversation.length;

        while (maxIterations-- > 0) {
            const wgeBefore = this._turnCostWge;
            const response = await this._callGateway(this.conversation, opts, {
                thinking: tier.thinking,
                effort: tier.effort,
                noTools: forceNoTools
            });
            const callWge = this._turnCostWge - wgeBefore;

            if (!response) {
                this.conversation.length = conversationSnapshot;
                break;
            }

            if (response.usage) {
                const u = response.usage;
                this._metrics.turn.promptTokens += u.prompt_tokens || 0;
                this._metrics.turn.completionTokens += u.completion_tokens || 0;
                this._metrics.turn.reasoningTokens += (u.completion_tokens_details?.reasoning_tokens) || 0;
                this._metrics.turn.cacheHitTokens += u.prompt_cache_hit_tokens || 0;
                this._metrics.turn.cacheMissTokens += u.prompt_cache_miss_tokens || 0;
                this._metrics.session.promptTokens += u.prompt_tokens || 0;
                this._metrics.session.completionTokens += u.completion_tokens || 0;
                this._metrics.session.cacheHitTokens += u.prompt_cache_hit_tokens || 0;
                this._metrics.session.cacheMissTokens += u.prompt_cache_miss_tokens || 0;
            }

            if (response.type === 'message') {
                const assistantMsg = { role: 'assistant', content: response.content };
                if (response.reasoning_content) assistantMsg.reasoning_content = response.reasoning_content;
                this._pushConversation(assistantMsg);
                this._emitRageDot(callWge, tier);
                if (onDone) onDone(response.content);
                return response.content;
            }

            if (response.type === 'tool_calls') {
                const assistantToolMsg = {
                    role: 'assistant', content: '',
                    tool_calls: response.tool_calls
                };
                if (response.reasoning_content) assistantToolMsg.reasoning_content = response.reasoning_content;
                this.conversation.push(assistantToolMsg);
                this._emitRageDot(callWge, tier);
                await this._executeToolCallsParallel(response.tool_calls, opts);
                continue;
            }
            break;
        }

        if (maxIterations <= 0) {
            this._log('⚠ max iterations (200) reached, forcing final answer');
            this._pushConversation({ role: 'user', content: '[System: You have used all available tool calls. Now give your final answer based on what you have gathered so far. Be concise.]' });
            const finalResp = await this._callGateway(this.conversation, opts, {
                thinking: tier.thinking, effort: tier.effort, noTools: true
            });
            if (finalResp && finalResp.content) {
                this._pushConversation({ role: 'assistant', content: finalResp.content });
                if (opts.onDone) opts.onDone(finalResp.content);
                return finalResp.content;
            }
        }
        return null;
    }

    // ═══ Plan 执行入口 ═══
    async executeTask(taskPrompt, opts = {}) {
        this._log(`→ executeTask: ${taskPrompt.slice(0, 80)}`);
        this._turnCostWge = 0;
        this._turnId = crypto.randomUUID();
        this._currentTurnSummary = '';
        this._currentTurnSummaryLang = '';

        if (!Array.isArray(this._planConversation)) {
            this._planConversation = [];
        }
        this._planConversation.push({ role: 'user', content: taskPrompt });

        const savedConversation = this.conversation;
        this.conversation = this._planConversation;

        try {
            const tier = TIER_PRO_MAX;
            const result = await this._executeWithTools(opts, tier, { noTools: false });
            this._buildAndFlushBilling(taskPrompt, result);
            return result;
        } catch (err) {
            this._log(`✗ executeTask error: ${err.message}`);
            if (opts.onError) opts.onError(err.message);
            throw err;
        } finally {
            this.conversation = savedConversation;
        }
    }

    async _getAuthToken() {
        const saved = this.context.globalState.get('qqq-ai.authToken');
        if (saved) return saved;
        const qqqExt = vscode.extensions.getExtension('gh555.qqq');
        if (qqqExt && qqqExt.isActive && qqqExt.exports && qqqExt.exports.getToken) {
            const token = await qqqExt.exports.getToken();
            if (token) return token;
        }
        return null;
    }

    abort() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    async clearConversation() {
        if (this.memory && this.conversation.length >= 4) {
            await this._generateSummary();
        }
        this.conversation = [];
        this.totalTokens = 0;
        this._ctx = { facts: [], narrative: '', turnSummaries: [], treasures: [], totalTurns: 0 };
        this._updateRage(0);
        this._updateHp(0);
        if (this.memory) this.memory.clearConversation();
    }

    async _generateSummary() {
        if (!this.memory) return;
        try {
            const turns = this.conversation.filter(m => m.role === 'user').length;
            const summaryMessages = [
                { role: 'system', content: '用3句话总结这段对话的关键信息，包括用户的意图、讨论了什么、得出了什么结论。只输出摘要，不要其他内容。' },
                { role: 'user', content: this.conversation.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `${m.role}: ${(m.content || '').slice(0, 200)}`).join('\n') }
            ];
            const token = await this._getAuthToken();
            if (!token) return;
            const summaryTurnId = crypto.randomUUID();
            const resp = await fetch(GATEWAY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ messages: summaryMessages, stream: false, thinking: { type: 'disabled' }, turn_id: summaryTurnId })
            });
            if (resp.ok) {
                const data = await resp.json();
                const text = data.choices?.[0]?.message?.content;
                if (text) {
                    this.memory.saveSummary(text.trim(), turns);
                    this._log(`memory: summary generated (${text.length} chars)`);
                }
            }
            const prevTurnId = this._turnId;
            const prevCost = this._turnCostWge;
            this._turnId = summaryTurnId;
            this._turnCostWge = 1;
            this._flushBilling('memory summary', 'en');
            this._turnId = prevTurnId;
            this._turnCostWge = prevCost;
        } catch (e) {
            this._log(`memory: summary generation failed — ${e.message}`);
        }
    }
}

// ═══ Mixin 挂载：各模块向 Agent.prototype 注入方法 ═══
require('./agent-context')(Agent);
require('./agent-gateway')(Agent);
require('./agent-tools')(Agent);
require('./agent-billing')(Agent);
require('./agent-planner')(Agent);

module.exports = { Agent };

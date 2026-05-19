// ═══════════════════════════════════════════════════════════════
// agent-gateway.js — 网关通信 mixin
// _callGateway, _parseSSE, _collectSSEContent
// ═══════════════════════════════════════════════════════════════

const { getTools } = require('./tools');
const { GATEWAY_URL, SYSTEM_PROMPT } = require('./prompt');
const { TurnSummaryStripper } = require('./turn-summary');

module.exports = function(Agent) {

    /**
     * Gateway 调用 — 完整版（带 thinking/effort + 自动重试）
     */
    Agent.prototype._callGateway = async function(messages, opts, config = {}, _retryCount = 0) {
        const { onToken } = opts;
        const { thinking, effort, noTools = false } = config;
        this.abortController = new AbortController();

        const token = await this._getAuthToken();
        if (!token) {
            this._log('✗ no auth token');
            if (opts.onError) opts.onError('未登录，请先登录 qqq 账号（Ctrl+Shift+P → qqq AI: Set Token）');
            return null;
        }
        this._log(`→ gateway POST ${GATEWAY_URL}`);
        this._requestStartMs = Date.now();

        const lastDoerMsg = [...messages].reverse().find(m => m.role === 'user');
        const currentQuery = lastDoerMsg?.content || '';

        // Prefix Caching Optimization
        const dynamicCtx = this._buildDynamicContext(currentQuery);
        let apiMessages = messages;
        if (dynamicCtx) {
            apiMessages = messages.slice();
            const lastIdx = apiMessages.length - 1;
            if (lastIdx >= 0 && apiMessages[lastIdx].role === 'user') {
                apiMessages[lastIdx] = { ...apiMessages[lastIdx], content: apiMessages[lastIdx].content + '\n\n' + dynamicCtx };
            }
        }

        const VISION_KEYWORDS = /(image|图片|截图|图像|picture|photo|\.png|\.jpe?g|\.gif|\.webp|\.bmp|视觉|分析图|看图)/i;
        const needsVision = VISION_KEYWORDS.test(currentQuery) || !!(this._pendingImages && this._pendingImages.length > 0);

        const body = {
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...apiMessages],
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 32768,
            turn_id: this._turnId || ''
        };
        if (!noTools) body.tools = getTools(needsVision);
        if (thinking) body.thinking = thinking;
        if (effort) body.reasoning_effort = effort;

        try {
            const resp = await fetch(GATEWAY_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(body),
                signal: this.abortController.signal
            });

            if (!resp.ok) {
                const text = await resp.text();
                this._log(`✗ gateway ${resp.status}: ${text.slice(0, 200)}`);
                if ((resp.status === 429 || resp.status === 502 || resp.status === 503) && _retryCount < 3) {
                    let waitSec;
                    if (resp.status === 429) {
                        try { waitSec = JSON.parse(text).retry_after || 3; } catch (_) { waitSec = 3; }
                    } else {
                        waitSec = 2 * Math.pow(2, _retryCount);
                    }
                    this._log(`  ${resp.status} → retry #${_retryCount + 1} in ${waitSec}s...`);
                    if (onToken && _retryCount === 0) onToken(`\n[网络抖动，${waitSec}s 后自动重试...]\n`);
                    this._metrics.turn.retries += 1;
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                    return this._callGateway(messages, opts, config, _retryCount + 1);
                }
                const friendly = resp.status === 502 ? '服务器暂时不可达 (502)，重试已耗尽。'
                    : resp.status === 503 ? '服务器暂时不可达 (503)，重试已耗尽。'
                    : resp.status === 401 ? 'Auth failed (401). Please re-set your token.'
                    : resp.status === 402 ? 'ge 余额不足，请充值后继续。'
                    : resp.status === 429 ? '服务繁忙，重试已耗尽。'
                    : `Server error (${resp.status}). Please try again later.`;
                if (opts.onError) opts.onError(friendly);
                return null;
            }

            this._log(`✓ gateway ${resp.status} streaming...`);
            this._lastCallTs = Date.now();
            return await this._parseSSE(resp.body, onToken);
        } catch (err) {
            if (err.name === 'AbortError') {
                this._log('■ aborted');
                return null;
            }
            if (_retryCount < 3) {
                const waitSec = 2 * Math.pow(2, _retryCount);
                this._log(`  fetch error → retry #${_retryCount + 1} in ${waitSec}s (${err.message})`);
                if (onToken && _retryCount === 0) onToken(`\n[网络错误，${waitSec}s 后自动重试...]\n`);
                this._metrics.turn.retries += 1;
                await new Promise(r => setTimeout(r, waitSec * 1000));
                return this._callGateway(messages, opts, config, _retryCount + 1);
            }
            this._log(`✗ fetch error: ${err.message}`);
            if (opts.onError) opts.onError(err.message);
            return null;
        }
    };

    /**
     * 解析 SSE 流
     */
    Agent.prototype._parseSSE = async function(body, onToken) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let reasoningContent = '';
        let toolCalls = [];
        let usage = null;
        let firstTokenSeen = false;
        const stripper = new TurnSummaryStripper(onToken);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') break;
                try {
                    const chunk = JSON.parse(data);
                    if (chunk.type === 'billing') {
                        this._turnCostWge += chunk.ge_cost || 0;
                        this._lastBillingFreeWindow = !!chunk.free_window;
                        if (chunk.model) {
                            this._actualModel = chunk.model;
                            this._metrics.turn.tier = this._modelToLabel(chunk.model);
                        }
                        continue;
                    }
                    if (chunk.model && !this._actualModel) {
                        this._actualModel = chunk.model;
                        this._metrics.turn.tier = this._modelToLabel(chunk.model);
                    }
                    if (chunk.usage) usage = chunk.usage;

                    const delta = chunk.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (!firstTokenSeen && (delta.content || delta.reasoning_content || delta.tool_calls)) {
                        firstTokenSeen = true;
                        this._metrics.turn.ttftMs = Date.now() - this._requestStartMs;
                    }
                    if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
                    if (delta.content) stripper.push(delta.content);
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            if (tc.index !== undefined) {
                                if (!toolCalls[tc.index]) {
                                    toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                                }
                                if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                            }
                        }
                    }
                } catch (e) {}
            }
        }

        const { cleanContent, summary, lang } = stripper.finalize();
        if (summary) {
            this._currentTurnSummary = summary;
            if (lang) this._currentTurnSummaryLang = lang;
        }

        if (toolCalls.length > 0) {
            return { type: 'tool_calls', tool_calls: toolCalls.filter(Boolean), usage, reasoning_content: reasoningContent || undefined };
        }
        if (cleanContent) {
            return { type: 'message', content: cleanContent, usage, reasoning_content: reasoningContent || undefined };
        }
        return null;
    };

    /**
     * 收集 SSE 流的完整 content（Plan 生成等场景）
     */
    Agent.prototype._collectSSEContent = async function(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') break;
                try {
                    const chunk = JSON.parse(data);
                    if (chunk.type === 'billing') {
                        this._turnCostWge += chunk.ge_cost || 0;
                        this._lastBillingFreeWindow = !!chunk.free_window;
                        continue;
                    }
                    const delta = chunk.choices?.[0]?.delta;
                    if (delta?.content) fullContent += delta.content;
                } catch (_) {}
            }
        }
        return fullContent;
    };
};

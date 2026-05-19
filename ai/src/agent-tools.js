// ═══════════════════════════════════════════════════════════════
// agent-tools.js — 并行工具引擎 mixin
// TOOL_CATEGORY, _buildExecutionLayers, _executeToolCallsParallel
// ═══════════════════════════════════════════════════════════════

const { executeTool } = require('./tools');

module.exports = function(Agent) {

    /**
     * 工具分类常量
     */
    Object.defineProperty(Agent, 'TOOL_CATEGORY', {
        get() {
            return {
                read_file: 'READ', search_text: 'READ', list_files: 'READ',
                find_files: 'READ', get_open_files: 'READ', get_diagnostics: 'READ',
                get_vision_context: 'READ', lsp_definitions: 'READ',
                lsp_references: 'READ', lsp_symbols: 'READ', fetch_webpage: 'READ', web_search: 'EFFECT',
                edit_file: 'WRITE', create_file: 'WRITE', delete_file: 'WRITE',
                run_command: 'EFFECT', analyze_image: 'EFFECT'
            };
        }
    });

    Agent.prototype._getToolTargetPath = function(name, args) {
        if (args.path) return args.path;
        if (args.file_path) return args.file_path;
        if (args.directory) return args.directory;
        if (name === 'run_command') return '__cmd__' + (args.command || '').slice(0, 50);
        if (name === 'analyze_image') return '__vision__';
        return '__unknown__';
    };

    Agent.prototype._buildExecutionLayers = function(calls) {
        const layers = [];
        for (const call of calls) {
            const cat = Agent.TOOL_CATEGORY[call.name] || 'EFFECT';
            const targetPath = this._getToolTargetPath(call.name, call.args);
            let placed = false;
            for (let i = layers.length - 1; i >= 0; i--) {
                const layer = layers[i];
                if (this._canPlaceInLayer(layer, call.name, cat, targetPath)) {
                    layer.items.push(call);
                    layer.fileMap.set(targetPath, this._mergeAccess(layer.fileMap.get(targetPath), cat));
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                const fileMap = new Map();
                fileMap.set(targetPath, cat);
                layers.push({ items: [call], fileMap });
            }
        }
        return layers;
    };

    Agent.prototype._canPlaceInLayer = function(layer, toolName, cat, targetPath) {
        const existing = layer.fileMap.get(targetPath);
        if (!existing) {
            if (cat === 'EFFECT') {
                const effectCount = layer.items.filter(i => (Agent.TOOL_CATEGORY[i.name] || 'EFFECT') === 'EFFECT').length;
                if (toolName === 'run_command' && effectCount >= 2) return false;
                if (toolName === 'analyze_image' && layer.items.filter(i => i.name === 'analyze_image').length >= 3) return false;
            }
            return true;
        }
        if (existing === 'READ' && cat === 'READ') return true;
        return false;
    };

    Agent.prototype._mergeAccess = function(existing, incoming) {
        if (!existing) return incoming;
        if (existing === 'WRITE' || incoming === 'WRITE') return 'WRITE';
        if (existing === 'EFFECT' || incoming === 'EFFECT') return 'EFFECT';
        return 'READ';
    };

    /**
     * 并行执行 tool_calls
     */
    Agent.prototype._executeToolCallsParallel = async function(toolCalls, opts) {
        const { onToolCall, onToolResult } = opts;
        const prepared = [];
        for (const call of toolCalls) {
            if (onToolCall) onToolCall(call);
            let toolArgs;
            try { toolArgs = JSON.parse(call.function.arguments); } catch (_) { toolArgs = {}; }

            if (call.function.name === 'analyze_image' && this._pendingImages === null && !toolArgs.path) {
                this._log(`  ⚠ blocked: analyze_image called without path after images already analyzed`);
                this.conversation.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: '[Images already analyzed above. Use the VISION ANALYSIS RESULTS in the conversation. Do NOT re-analyze.]'
                });
                continue;
            }
            prepared.push({ call, name: call.function.name, args: toolArgs });
        }

        if (prepared.length === 0) return;
        this._metrics.turn.toolCount += prepared.length;

        const layers = this._buildExecutionLayers(prepared);
        this._log(`  ║ parallel engine: ${prepared.length} tools → ${layers.length} layer(s)`);

        for (const layer of layers) {
            const promises = layer.items.map(async (item) => {
                const _toolStart = Date.now();
                const result = await executeTool(item.name, item.args);
                this._metrics.turn.toolTotalMs += (Date.now() - _toolStart);
                const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                this._log(`← tool result: ${resultStr.slice(0, 120)}`);
                if (onToolResult) {
                    const truncated = resultStr.length > 2000;
                    onToolResult(item.name, truncated ? resultStr.slice(0, 2000) + '\n... (truncated)' : resultStr, truncated);
                }
                const trimmed = resultStr.length > 4000
                    ? resultStr.slice(0, 3500) + `\n... (${resultStr.length} chars, truncated to save context)`
                    : resultStr;
                return { call: item.call, content: trimmed };
            });
            const results = await Promise.all(promises);
            for (const r of results) {
                this.conversation.push({
                    role: 'tool',
                    tool_call_id: r.call.id,
                    content: r.content
                });
            }
        }
    };
};

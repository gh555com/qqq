const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { Agent } = require('../agent');
const { MemoryManager } = require('../memory');
const { SessionManager } = require('../session');
const { PlanManager, PLAN_STATUS, TASK_STATUS } = require('../planner');
const { PlanExecutor } = require('../plan-executor');
const { setPanelRef, setAuthTokenRef } = require('../tools');

class ChatPanelProvider {
    constructor(context, logFn) {
        this.context = context;
        this._log = logFn || (() => {});
        this._view = null;
        setPanelRef(this);

        // 让 tools.js 能拿到 auth token
        const savedToken = context.globalState.get('qqq-ai.authToken');
        if (savedToken) setAuthTokenRef(savedToken);

        // 初始化 SessionManager + PlanManager
        const globalPath = context.globalStorageUri.fsPath;
        this._sessionManager = new SessionManager(globalPath, logFn);
        this._planManager = new PlanManager(globalPath, logFn);
        this._planExecutor = null; // 懒初始化（需要 agent）

        // 迁移旧数据（仅首次）
        const legacyDir = path.join(globalPath, 'memory');
        if (fs.existsSync(legacyDir)) {
            this._sessionManager.migrateFromLegacy(legacyDir);
        }

        // 确定 active session
        const list = this._sessionManager.getSessionList();
        if (list.length > 0) {
            this._activeSessionId = list[0].id; // 最近活跃的
        } else {
            this._activeSessionId = this._sessionManager.createSession('新对话');
        }

        // 创建 Agent
        this._createAgent(this._activeSessionId);
    }

    _createAgent(sessionId) {
        const memory = new MemoryManager(this._sessionManager, sessionId, this._log);
        this.agent = new Agent(this.context, this._log, memory);

        // 连接 agent 回调 → webview UI
        this.agent.onRageChange((rage) => {
            this._postMessage({ type: 'rage', value: rage });
        });
        this.agent.onHpChange((percent, tokens) => {
            this._postMessage({ type: 'hp', percent, tokens });
        });
        this.agent.onRageDot((rage, usage) => {
            this._postMessage({ type: 'rageDot', rage, usage });
        });

        // 初始化 PlanExecutor
        this._planExecutor = new PlanExecutor(this._planManager, this.agent, this._log);
        this._planExecutor.onTaskStart((task) => {
            this._postMessage({ type: 'planTaskStart', taskId: task.id, content: task.content, order: task.order });
        });
        this._planExecutor.onTaskComplete((task) => {
            this._postMessage({ type: 'planTaskComplete', taskId: task.id, result: task.result });
        });
        this._planExecutor.onTaskFail((task) => {
            this._postMessage({ type: 'planTaskFail', taskId: task.id, error: task.error });
        });
        this._planExecutor.onProgress((progress) => {
            this._postMessage({ type: 'planProgress', ...progress });
        });
        this._planExecutor.onPlanComplete((plan) => {
            this._postMessage({ type: 'planComplete', planId: plan.id, title: plan.title });
        });
        this._planExecutor.onPlanFail((plan, progress) => {
            this._postMessage({ type: 'planFail', planId: plan.id, title: plan.title, progress });
        });
        this._planExecutor.onReplan(({ action, analysis, plan }) => {
            this._postMessage({
                type: 'planRevised',
                action,
                analysis,
                planId: plan.id,
                tasks: plan.tasks.map(t => ({ id: t.id, content: t.content, status: t.status, order: t.order }))
            });
        });
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'chat'))]
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        // 处理来自 WebView 的消息
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            this._handleWebviewMessage(msg);
        });

        // 恢复：先发 session list，再恢复当前会话消息
        setTimeout(() => {
            this._syncSessionList();
            this._restoreConversationToUI();
        }, 300);
    }

    // ═══ 多会话操作 ═══

    switchSession(id) {
        if (id === this._activeSessionId) return;
        // 保存当前（debounce 会立即存）
        this._activeSessionId = id;
        this._sessionManager.touchSession(id);
        this._createAgent(id);
        // UI: 清空 → 恢复新会话
        this._postMessage({ type: 'cleared' });
        this._restoreConversationToUI();
        this._syncSessionList();
    }

    newSession() {
        const id = this._sessionManager.createSession('新对话');
        this.switchSession(id);
        return id;
    }

    closeSession(id) {
        const list = this._sessionManager.getSessionList();
        if (list.length <= 1) {
            // 最后一个会话：清空内容而非删除
            this.clearConversation();
            return;
        }
        this._sessionManager.deleteSession(id);
        // 如果关的是当前的 → 切到下一个
        if (id === this._activeSessionId) {
            const remaining = this._sessionManager.getSessionList();
            this.switchSession(remaining[0].id);
        } else {
            this._syncSessionList();
        }
    }

    _syncSessionList() {
        const list = this._sessionManager.getSessionList().slice(0, 20);
        this._postMessage({
            type: 'sessionList',
            sessions: list,
            activeId: this._activeSessionId
        });
    }

    // ═══ 消息处理 ═══

    async _handleDoerMessage(text, images) {
        if (!text.trim() && (!images || images.length === 0)) return;

        // 自动更新会话标题（取首条消息前 12 字）
        if (this.agent.conversation.length === 0 && text.trim()) {
            const title = text.trim().slice(0, 12);
            this._sessionManager.updateTitle(this._activeSessionId, title);
            this._syncSessionList();
        }

        // 多图支持
        let finalText = text;
        if (images && images.length > 0) {
            this.agent._pendingImages = images;
            const imgCount = images.length;
            const imgRef = images.map(img => `#${img.id}`).join(', ');
            if (text) {
                finalText = `${text}\n\n[ℹ️ ${imgCount} image(s) attached as ${imgRef}. Vision analysis will be appended below automatically.]`;
            } else {
                finalText = `[Doer sent ${imgCount} image(s) (${imgRef}) for analysis. Vision analysis will be appended below automatically.]`;
            }
        }

        this._postMessage({ type: 'start' });

        // ─── Plan 检测：复杂任务自动生成计划 ───
        // 条件：无图片、非闲聊、不在执行中、消息非 trivial
        const shouldPlan = !images && finalText.length > 10 && !this._planExecutor?.isRunning;
        if (shouldPlan) {
            // LLM 判定是否需要 plan（Flash 模式，~0.5s）
            const planData = await this.agent.generatePlan(finalText);
            if (planData) {
                // 创建 Plan 并发送给 UI 等待用户批准
                const plan = this._planManager.createPlan(planData);
                this._postMessage({
                    type: 'planDraft',
                    plan: {
                        id: plan.id,
                        title: plan.title,
                        overview: plan.overview,
                        tasks: plan.tasks.map(t => ({ id: t.id, content: t.content, order: t.order, files: t.files }))
                    }
                });
                // 同时作为 assistant 消息显示概览
                const taskList = plan.tasks.map((t, i) => `${i + 1}. ${t.content}`).join('\n');
                const summary = `📋 **${plan.title}**\n\n${plan.overview}\n\n**执行步骤:**\n${taskList}\n\n_点击「执行计划」开始，或继续对话修改。_`;
                this._postMessage({ type: 'done', content: summary });
                return;
            }
        }

        // ─── 常规消息处理 ───
        await this.agent.sendMessage(finalText, this._buildAgentOpts());
    }

    /**
     * 构建 Agent 回调选项
     */
    _buildAgentOpts() {
        return {
            onToken: (token) => {
                this._postMessage({ type: 'token', content: token });
            },
            onToolCall: (call) => {
                this._postMessage({
                    type: 'tool',
                    name: call.function.name,
                    args: call.function.arguments
                });
            },
            onToolResult: (toolName, output, truncated) => {
                this._postMessage({ type: 'toolResult', toolName, output, truncated });
            },
            onDone: (content) => {
                this._postMessage({ type: 'done', content });
            },
            onCost: (estimate) => {
                this._postMessage({ type: 'cost', estimate });
            },
            onError: (err) => {
                this._postMessage({ type: 'error', message: err });
            },
            _requestConfirm: (message, actions) => this.requestConfirm(message, actions)
        };
    }

    // ═══ Plan 操作 ═══

    async executePlan(planId) {
        if (!planId) {
            const active = this._planManager.getActivePlan();
            if (!active) return;
            planId = active.id;
        }
        this._planManager.approvePlan(planId);
        this._postMessage({ type: 'planExecuting', planId });
        await this._planExecutor.execute(planId, this._buildAgentOpts());
    }

    async rollbackPlan(planId, taskId) {
        if (!this._planExecutor) return;
        const result = await this._planExecutor.rollbackToTask(planId, taskId);
        if (result.ok) {
            this._postMessage({ type: 'planRolledBack', planId, taskId, ref: result.ref });
            // 刷新 plan 状态到 UI
            const plan = this._planManager.getPlan(planId);
            if (plan) {
                this._postMessage({
                    type: 'planUpdate',
                    plan: {
                        id: plan.id,
                        title: plan.title,
                        status: plan.status,
                        tasks: plan.tasks.map(t => ({ id: t.id, content: t.content, status: t.status, order: t.order }))
                    }
                });
            }
        } else {
            this._postMessage({ type: 'error', message: `回滚失败: ${result.error}` });
        }
    }

    abortPlan() {
        if (this._planExecutor?.isRunning) {
            this._planExecutor.abort();
            this._postMessage({ type: 'planPaused' });
        }
    }

    clearConversation() {
        this.agent.clearConversation().then(() => {
            this._postMessage({ type: 'cleared' });
        });
    }

    requestConfirm(message, actions = ['Apply', 'Reject']) {
        return new Promise((resolve) => {
            const id = Date.now().toString(36);
            this._pendingConfirms = this._pendingConfirms || {};
            this._pendingConfirms[id] = resolve;
            this._postMessage({ type: 'confirm', id, message, actions });
        });
    }

    _handleWebviewMessage(msg) {
        if (msg.type === 'send') {
            this._handleDoerMessage(msg.text, msg.images);
        } else if (msg.type === 'abort') {
            this.agent.abort();
        } else if (msg.type === 'clear') {
            this.clearConversation();
        } else if (msg.type === 'confirmResponse') {
            const resolve = this._pendingConfirms?.[msg.id];
            if (resolve) {
                resolve(msg.action);
                delete this._pendingConfirms[msg.id];
            }
        } else if (msg.type === 'downloadImage') {
            this._handleDownloadImage(msg.base64);
        } else if (msg.type === 'copyImage') {
            this._handleCopyImage(msg.base64);
        // ─── Tab 操作 ───
        } else if (msg.type === 'newTab') {
            this.newSession();
        } else if (msg.type === 'switchTab') {
            this.switchSession(msg.id);
        } else if (msg.type === 'closeTab') {
            this.closeSession(msg.id);
        // ─── Plan 操作 ───
        } else if (msg.type === 'planExecute') {
            this.executePlan(msg.planId);
        } else if (msg.type === 'planRollback') {
            this.rollbackPlan(msg.planId, msg.taskId);
        } else if (msg.type === 'planAbort') {
            this.abortPlan();
        } else if (msg.type === 'planResume') {
            this.executePlan(msg.planId);
        }
    }

    async _handleDownloadImage(base64) {
        const uri = await vscode.window.showSaveDialog({
            filters: { 'PNG Image': ['png'] },
            defaultUri: vscode.Uri.file('image.png')
        });
        if (uri) {
            const buf = Buffer.from(base64, 'base64');
            await vscode.workspace.fs.writeFile(uri, buf);
            vscode.window.showInformationMessage('图片已保存');
        }
    }

    async _handleCopyImage(base64) {
        try {
            const tmpPath = path.join(require('os').tmpdir(), `qqq_clip_${Date.now()}.png`);
            fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
            await vscode.commands.executeCommand('qqq.copyImageAsBitmap', tmpPath);
        } catch (e) {
            vscode.window.showErrorMessage('复制失败: ' + e.message);
        }
    }

    _postMessage(msg) {
        if (this._view) {
            this._view.webview.postMessage(msg);
        }
    }

    _getHtml(webview) {
        const htmlPath = path.join(this.context.extensionPath, 'src', 'chat', 'chat.html');
        try {
            return fs.readFileSync(htmlPath, 'utf8');
        } catch {
            return `<!DOCTYPE html><html><body><p>Error: chat.html not found</p></body></html>`;
        }
    }

    _restoreConversationToUI() {
        if (!this._view) return;

        // 恢复对话历史
        if (this.agent.conversation.length > 0) {
            const msgs = this.agent.conversation;
            for (const msg of msgs) {
                if (msg.role === 'user') {
                    this._postMessage({ type: 'restoreDoer', content: msg.content });
                } else if (msg.role === 'assistant' && msg.content) {
                    this._postMessage({ type: 'restoreAssistant', content: msg.content });
                }
            }
        }
        if (this.agent.currentRage > 0) {
            this._postMessage({ type: 'rage', value: this.agent.currentRage });
        }
        if (this.agent.totalTokens > 0) {
            const maxTokens = 800000;
            const percent = Math.min(100, Math.round((this.agent.totalTokens / maxTokens) * 100));
            this._postMessage({ type: 'hp', percent, tokens: this.agent.totalTokens });
        }

        // ━━━ 恢复活跃 Plan 卡片 ━━━
        const activePlan = this._planManager.getActivePlan();
        if (activePlan) {
            this._postMessage({
                type: 'planDraft',
                plan: {
                    id: activePlan.id,
                    title: activePlan.title,
                    overview: activePlan.overview,
                    tasks: activePlan.tasks.map(t => ({ id: t.id, content: t.content, order: t.order, files: t.files }))
                }
            });
            // 更新 task 状态
            this._postMessage({
                type: 'planUpdate',
                plan: {
                    id: activePlan.id,
                    title: activePlan.title,
                    status: activePlan.status,
                    tasks: activePlan.tasks.map(t => ({ id: t.id, content: t.content, status: t.status, order: t.order }))
                }
            });
        }
    }
}

module.exports = { ChatPanelProvider };

const { execSync } = require('child_process');
const path = require('path');
const vscode = require('vscode');
const { PLAN_STATUS, TASK_STATUS } = require('./planner');

/**
 * ═══════════════════════════════════════════════════════════
 * PlanExecutor — Task 执行引擎
 * ═══════════════════════════════════════════════════════════
 *
 * 职责:
 * 1. 按依赖顺序调度 task
 * 2. 每个 task 执行前创建 git checkpoint (lightweight tag)
 * 3. 失败/回滚时 git revert 到 checkpoint
 * 4. 通过回调向 UI 推送实时进度
 *
 * Git 策略:
 * - 使用 lightweight tag: qqq-plan/{planId}/task-{n}
 * - checkpoint = 当前 HEAD commit (git rev-parse HEAD)
 * - rollback = git reset --hard {checkpoint}
 * - 完成后清理 tags (可选)
 */

class PlanExecutor {
    constructor(planManager, agent, logFn) {
        this._planManager = planManager;
        this._agent = agent;
        this._log = logFn || (() => {});
        this._running = false;
        this._aborted = false;
        this._currentPlanId = null;

        // ━━━ 跨 task 执行上下文（解决上下文断裂） ━━━
        // 每个 task 完成后把摘要 push 进来，后续 task 能看到前面做了什么
        this._executionContext = [];

        // 回调
        this._onTaskStart = null;
        this._onTaskComplete = null;
        this._onTaskFail = null;
        this._onPlanComplete = null;
        this._onPlanFail = null;
        this._onProgress = null;
        this._onReplan = null;  // 反馈闭环：plan 被修订时通知 UI
    }

    // ═══ 回调注册 ═══
    onTaskStart(fn) { this._onTaskStart = fn; }
    onTaskComplete(fn) { this._onTaskComplete = fn; }
    onTaskFail(fn) { this._onTaskFail = fn; }
    onPlanComplete(fn) { this._onPlanComplete = fn; }
    onPlanFail(fn) { this._onPlanFail = fn; }
    onProgress(fn) { this._onProgress = fn; }
    onReplan(fn) { this._onReplan = fn; }

    get isRunning() { return this._running; }
    get currentPlanId() { return this._currentPlanId; }

    /**
     * 开始执行 Plan（从第一个 pending task 开始）
     * @param {string} planId
     * @param {object} opts - { onToken, onToolCall, onToolResult, onDone, onError, _requestConfirm }
     */
    async execute(planId, opts = {}) {
        if (this._running) {
            this._log('executor: already running');
            return;
        }

        const plan = this._planManager.startPlan(planId);
        if (!plan) {
            this._log(`executor: cannot start plan ${planId}`);
            return;
        }

        this._running = true;
        this._aborted = false;
        this._currentPlanId = planId;
        this._executionContext = []; // 重置执行上下文
        // F-1: 初始化跨 task 累积对话 — LLM 在后续 task 能看到前面的工具调用历史
        this._agent._planConversation = [];
        this._log(`executor: starting plan "${plan.title}" (${plan.tasks.length} tasks)`);

        try {
            while (!this._aborted) {
                const task = this._planManager.getNextTask(planId);
                if (!task) {
                    // 没有更多可执行的 task — 但必须确认是否真的全部完成
                    const progress = this._planManager.getProgress(planId);
                    if (progress.failed > 0) {
                        this._planManager.failPlan(planId, `${progress.failed} task(s) failed`);
                        if (this._onPlanFail) this._onPlanFail(plan, progress);
                    } else if (progress.pending === 0 && progress.inProgress === 0) {
                        // 真·全部完成
                        this._planManager.completePlan(planId);
                        if (this._onPlanComplete) this._onPlanComplete(plan, progress);
                    } else {
                        // 有 PENDING task 但 getNextTask 返回 null → 依赖死锁或状态异常
                        this._log(`executor: deadlock — ${progress.pending} pending, ${progress.inProgress} in-progress, but none executable`);
                        this._planManager.pausePlan(planId);
                        if (this._onPlanFail) this._onPlanFail(plan, { ...progress, reason: 'dependency deadlock' });
                    }
                    break;
                }

                await this._executeTask(planId, task, opts);

                // 推送进度
                const progress = this._planManager.getProgress(planId);
                if (this._onProgress) this._onProgress(progress);

                // task 失败 → 反馈闭环：分析失败原因，修订后续计划
                if (task.status === TASK_STATUS.FAILED) {
                    const replanResult = await this._handleFailureReplan(planId, task);
                    if (replanResult === 'continue') {
                        // replan 成功且 action=retry/revise → 继续执行
                        continue;
                    }
                    // replan 建议 abort 或 replan 失败 → 暂停等用户
                    this._planManager.pausePlan(planId);
                    if (this._onTaskFail) this._onTaskFail(task, plan);
                    break;
                }
            }
        } finally {
            this._running = false;
            this._currentPlanId = null;
            // F-1: 清理跨 task 累积对话，避免下次 plan 复用上一 plan 的历史
            if (this._agent) this._agent._planConversation = null;
        }
    }

    /**
     * 执行单个 Task
     */
    async _executeTask(planId, task, opts) {
        this._log(`executor: task [${task.order}] "${task.content}"`);
        this._planManager.startTask(planId, task.id);
        if (this._onTaskStart) this._onTaskStart(task);

        // ─── Step 1: Git Checkpoint ───
        const checkpoint = this._createCheckpoint(planId, task);
        if (checkpoint) {
            this._planManager.setTaskCheckpoint(planId, task.id, checkpoint);
        }

        // ─── Step 2: 构建 task prompt 并让 Agent 执行 ───
        try {
            const plan = this._planManager.getPlan(planId);
            const taskPrompt = this._buildTaskPrompt(plan, task);

            // 用 agent 执行这个 task（复用 agent 的工具循环）
            const result = await this._agent.executeTask(taskPrompt, {
                onToken: opts.onToken,
                onToolCall: opts.onToolCall,
                onToolResult: opts.onToolResult,
                onDone: (content) => {
                    // task 完成 → 累积到执行上下文
                    const summary = content?.slice(0, 500) || 'Done';
                    this._executionContext.push({
                        order: task.order,
                        content: task.content,
                        result: summary
                    });
                    this._planManager.completeTask(planId, task.id, summary);
                    if (this._onTaskComplete) this._onTaskComplete(task);
                    if (opts.onDone) opts.onDone(content);
                },
                onError: opts.onError,
                _requestConfirm: opts._requestConfirm
            });

            return result;
        } catch (e) {
            this._planManager.failTask(planId, task.id, e.message);
            if (this._onTaskFail) this._onTaskFail(task);
            this._log(`executor: task failed — ${e.message}`);
        }
    }

    /**
     * 构建 task 的执行 prompt
     * F-1：区分首个 task vs 后续 task
     * - 首个：发完整 prompt（plan 总览 + 所有步骤 + 当前 task）
     * - 后续：发轻量 prompt（依赖对话历史，LLM 已能看到前面工具调用）
     */
    _buildTaskPrompt(plan, task) {
        const isFirstTask = this._executionContext.length === 0;
        const currentFiles = task.files.length > 0
            ? `\n涉及文件: ${task.files.join(', ')}`
            : '';

        if (isFirstTask) {
            // 首个 task：完整 prompt
            const allTasks = plan.tasks
                .map((t, i) => `  ${i + 1}. ${t.content}${i === task.order ? ' ← 当前' : ''}`)
                .join('\n');

            return `你正在执行一个多步计划。

## 计划总览
${plan.overview}

## 全部步骤
${allTasks}

## 当前任务（第 ${task.order + 1}/${plan.tasks.length} 步）
${task.content}${currentFiles}

## 执行要求
- 精确执行当前任务，不多不少
- 完成后简要汇报：改了哪些文件、关键函数名、注意事项`;
        } else {
            // 后续 task：轻量 prompt — LLM 能从上下文看到前面做了什么
            return `## 下一步：第 ${task.order + 1}/${plan.tasks.length} 步——${task.content}${currentFiles}

基于上面已完成的工作（文件路径、函数签名、变量名均已确定）继续。
不要重新规划，不要重复之前的工作，精确执行当前 task 后简要汇报。`;
        }
    }

    // ═══ Git Checkpoint ═══

    /**
     * 在 task 开始前创建 git checkpoint
     * 返回 { type: 'commit', ref: commitHash } 或 null
     */
    _createCheckpoint(planId, task) {
        const workDir = this._getWorkspaceRoot();
        if (!workDir) return null;

        try {
            // 先 stage 所有变更（包括未跟踪文件）
            this._git(workDir, 'add -A');

            // 检查是否有变更需要提交
            const status = this._git(workDir, 'status --porcelain');
            if (status.trim()) {
                // 有变更 → 提交一个 checkpoint
                const msg = `[qqq-checkpoint] before task ${task.order}: ${task.content.slice(0, 50)}`;
                this._git(workDir, `commit -m "${msg.replace(/"/g, '\\"')}" --allow-empty`);
            }

            // 获取当前 HEAD
            const ref = this._git(workDir, 'rev-parse HEAD').trim();

            // 打 tag 方便定位
            const tagName = `qqq-plan/${planId}/task-${task.order}`;
            try { this._git(workDir, `tag -d ${tagName}`); } catch (_) {}
            this._git(workDir, `tag ${tagName} ${ref}`);

            this._log(`executor: checkpoint ${tagName} → ${ref.slice(0, 8)}`);
            return { type: 'commit', ref, tag: tagName };
        } catch (e) {
            this._log(`executor: checkpoint failed — ${e.message}`);
            return null;
        }
    }

    /**
     * 回滚到指定 task 的 checkpoint
     */
    async rollbackToTask(planId, taskId) {
        const plan = this._planManager.getPlan(planId);
        if (!plan) return { ok: false, error: 'Plan not found' };

        const task = plan.tasks.find(t => t.id === taskId);
        if (!task || !task.checkpoint) return { ok: false, error: 'No checkpoint for this task' };

        const workDir = this._getWorkspaceRoot();
        if (!workDir) return { ok: false, error: 'No workspace' };

        try {
            // hard reset 到 checkpoint
            this._git(workDir, `reset --hard ${task.checkpoint.ref}`);

            // 把这个 task 及之后的 task 全部标记为 rolled_back / pending
            let rollbackStarted = false;
            for (const t of plan.tasks) {
                if (t.id === taskId) rollbackStarted = true;
                if (rollbackStarted && t.status !== TASK_STATUS.PENDING) {
                    this._planManager.rollbackTask(planId, t.id);
                    // 然后改回 pending 以便重新执行
                    t.status = TASK_STATUS.PENDING;
                    t.result = null;
                    t.error = null;
                    t.startedAt = null;
                    t.completedAt = null;
                }
            }
            // 保存 plan 状态
            plan.status = PLAN_STATUS.PAUSED;
            plan.updatedAt = Date.now();
            // 直接写文件（因为我们修改了 tasks 数组）
            const fs = require('fs');
            fs.writeFileSync(
                path.join(this._planManager._plansDir, `${plan.id}.json`),
                JSON.stringify(plan, null, 2), 'utf8'
            );

            this._log(`executor: rolled back to task ${task.order} (${task.checkpoint.ref.slice(0, 8)})`);
            return { ok: true, ref: task.checkpoint.ref };
        } catch (e) {
            this._log(`executor: rollback failed — ${e.message}`);
            return { ok: false, error: e.message };
        }
    }

    /**
     * 反馈闭环：task 失败后调 LLM 分析并自动修订 plan
     * @returns {'continue'|'pause'}
     */
    async _handleFailureReplan(planId, failedTask) {
        try {
            const plan = this._planManager.getPlan(planId);
            const failedError = failedTask.error || 'Unknown error';

            this._log(`executor: replan triggered for task ${failedTask.order} failure`);

            const replanResult = await this._agent.replanAfterFailure(
                plan, failedTask, failedError, this._executionContext
            );

            if (!replanResult) {
                this._log('executor: replan returned null, pausing');
                return 'pause';
            }

            if (replanResult.action === 'abort') {
                this._log(`executor: replan advises abort — ${replanResult.analysis}`);
                return 'pause';
            }

            if (replanResult.action === 'retry') {
                // 重置失败 task 为 pending，重新执行
                failedTask.status = TASK_STATUS.PENDING;
                failedTask.error = null;
                failedTask.startedAt = null;
                this._planManager._savePlan(plan);
                this._log('executor: retrying failed task');
                if (this._onReplan) this._onReplan({ action: 'retry', analysis: replanResult.analysis, plan });
                return 'continue';
            }

            if (replanResult.action === 'revise' && replanResult.revised_tasks?.length > 0) {
                // 重置失败 task 为 pending（将被重新执行）
                failedTask.status = TASK_STATUS.PENDING;
                failedTask.error = null;
                failedTask.startedAt = null;

                // 替换后续 tasks
                const updatedPlan = this._planManager.replaceRemainingTasks(
                    planId, failedTask.order, replanResult.revised_tasks
                );
                this._log(`executor: plan revised, now ${updatedPlan.tasks.length} tasks`);
                if (this._onReplan) this._onReplan({ action: 'revise', analysis: replanResult.analysis, plan: updatedPlan });
                return 'continue';
            }

            return 'pause';
        } catch (e) {
            this._log(`executor: replan error — ${e.message}`);
            return 'pause';
        }
    }

    /**
     * 中止当前执行
     */
    abort() {
        this._aborted = true;
        if (this._agent) this._agent.abort();
        if (this._currentPlanId) {
            this._planManager.pausePlan(this._currentPlanId);
        }
    }

    /**
     * 清理 plan 的所有 git tags
     */
    cleanupTags(planId) {
        const workDir = this._getWorkspaceRoot();
        if (!workDir) return;
        try {
            const tags = this._git(workDir, 'tag -l "qqq-plan/' + planId + '/*"').trim();
            if (tags) {
                for (const tag of tags.split('\n')) {
                    if (tag.trim()) this._git(workDir, `tag -d ${tag.trim()}`);
                }
            }
        } catch (_) {}
    }

    // ═══ 内部工具 ═══

    _getWorkspaceRoot() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return null;
        return folders[0].uri.fsPath;
    }

    _git(cwd, args) {
        return execSync(`git ${args}`, {
            cwd,
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
    }
}

module.exports = { PlanExecutor };

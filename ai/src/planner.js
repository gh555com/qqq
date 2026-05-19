const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * ═══════════════════════════════════════════════════════════
 * PlanManager — Plan + Task 统一数据模型
 * ═══════════════════════════════════════════════════════════
 *
 * 数据结构:
 *   globalStorage/plans/
 *     index.json       — [{id, title, status, createdAt, updatedAt}]
 *     {plan-id}.json   — 完整 Plan 对象
 *
 * Plan {
 *   id, title, overview, status,
 *   tasks: Task[],
 *   createdAt, updatedAt
 * }
 *
 * Task {
 *   id, content, status, order,
 *   dependencies: string[],
 *   files: string[],
 *   checkpoint: { type:'stash'|'tag', ref:string } | null,
 *   result: string | null,
 *   error: string | null,
 *   startedAt, completedAt
 * }
 *
 * 状态机:
 *   Plan:  draft → approved → executing → complete | failed | paused
 *   Task:  pending → in_progress → complete | failed | rolled_back
 */

// Plan 状态
const PLAN_STATUS = {
    DRAFT: 'draft',           // LLM 刚生成，等用户审批
    APPROVED: 'approved',     // 用户批准，等待执行
    EXECUTING: 'executing',   // 正在逐步执行
    PAUSED: 'paused',         // 用户暂停
    COMPLETE: 'complete',     // 所有 task 完成
    FAILED: 'failed'          // 某个 task 失败且用户未选择继续
};

// Task 状态
const TASK_STATUS = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    COMPLETE: 'complete',
    FAILED: 'failed',
    ROLLED_BACK: 'rolled_back',
    SKIPPED: 'skipped'
};

class PlanManager {
    constructor(globalStoragePath, logFn) {
        this._basePath = globalStoragePath;
        this._plansDir = path.join(globalStoragePath, 'plans');
        this._indexPath = path.join(this._plansDir, 'index.json');
        this._log = logFn || (() => {});

        try { fs.mkdirSync(this._plansDir, { recursive: true }); } catch (_) {}
        this._index = this._loadIndex();

        // B-2: 防抖落盘 — plan 状态频繁变更时合并同步 IO
        this._pendingPlans = new Map();   // id -> plan实例（总是最新版）
        this._indexDirty = false;
        this._saveTimer = null;
        this._SAVE_DEBOUNCE_MS = 500;
    }

    // ═══ Index ═══

    _loadIndex() {
        try {
            if (fs.existsSync(this._indexPath)) {
                return JSON.parse(fs.readFileSync(this._indexPath, 'utf8'));
            }
        } catch (_) {}
        return [];
    }

    _saveIndex() {
        // B-2: 标记 dirty，由 _scheduleFlush 合并写
        this._indexDirty = true;
        this._scheduleFlush();
    }

    _writeIndexNow() {
        try {
            fs.writeFileSync(this._indexPath, JSON.stringify(this._index, null, 2), 'utf8');
        } catch (e) {
            this._log(`planner: index save error — ${e.message}`);
        }
    }

    // B-2: 防抖调度
    _scheduleFlush() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.flush();
        }, this._SAVE_DEBOUNCE_MS);
    }

    // B-2: 同步 flush 所有 pending（deactivate / deletePlan / 关键路径调用）
    flush() {
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
        for (const plan of this._pendingPlans.values()) {
            try {
                fs.writeFileSync(path.join(this._plansDir, `${plan.id}.json`), JSON.stringify(plan, null, 2), 'utf8');
            } catch (e) {
                this._log(`planner: save error ${plan.id} — ${e.message}`);
            }
        }
        this._pendingPlans.clear();
        if (this._indexDirty) {
            this._writeIndexNow();
            this._indexDirty = false;
        }
    }

    // ═══ Plan CRUD ═══

    /**
     * 创建新 Plan（通常由 LLM 生成后调用）
     * @param {object} planData - { title, overview, tasks: [{content, dependencies?, files?}] }
     * @param {string} sessionId - F-2a: 归属会话 ID（多窗口各自记录自己的 plan）
     * @returns {object} 完整 Plan 对象
     */
    createPlan(planData, sessionId = null) {
        const id = crypto.randomBytes(6).toString('hex');
        const now = Date.now();

        const tasks = (planData.tasks || []).map((t, i) => ({
            id: crypto.randomBytes(4).toString('hex'),
            content: t.content,
            status: TASK_STATUS.PENDING,
            order: i,
            dependencies: t.dependencies || [],
            files: t.files || [],
            checkpoint: null,
            result: null,
            error: null,
            startedAt: null,
            completedAt: null
        }));

        const plan = {
            id,
            sessionId,                  // F-2a: 绑定 session
            title: planData.title || 'Untitled Plan',
            overview: planData.overview || '',
            status: PLAN_STATUS.DRAFT,
            tasks,
            createdAt: now,
            updatedAt: now
        };

        // 保存
        this._savePlan(plan);
        this._index.push({ id, sessionId, title: plan.title, status: plan.status, createdAt: now, updatedAt: now });
        this._saveIndex();
        this._log(`planner: created plan ${id} "${plan.title}" with ${tasks.length} tasks (session=${sessionId || 'none'})`);
        return plan;
    }

    getPlan(id) {
        // B-2: 优先从 pending 读，保证读到未落盘的最新版
        if (this._pendingPlans.has(id)) return this._pendingPlans.get(id);
        try {
            const fp = path.join(this._plansDir, `${id}.json`);
            if (fs.existsSync(fp)) {
                return JSON.parse(fs.readFileSync(fp, 'utf8'));
            }
        } catch (e) {
            this._log(`planner: load error ${id} — ${e.message}`);
        }
        return null;
    }

    _savePlan(plan) {
        // B-2: 放入 pending 后防抖合并写 — plan 是同一实例引用，后续变更自动体现
        plan.updatedAt = Date.now();
        this._pendingPlans.set(plan.id, plan);
        // 同步 index
        const entry = this._index.find(p => p.id === plan.id);
        if (entry) {
            entry.status = plan.status;
            entry.title = plan.title;
            entry.updatedAt = plan.updatedAt;
            this._indexDirty = true;
        }
        this._scheduleFlush();
    }

    deletePlan(id) {
        // B-2: 先从 pending 移除，避免后续 flush 误写已删文件
        this._pendingPlans.delete(id);
        this._index = this._index.filter(p => p.id !== id);
        this._indexDirty = true;
        try {
            const fp = path.join(this._plansDir, `${id}.json`);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch (_) {}
        // 删除是资源释放动作，立即 flush index 以避免后续读到髆数据
        this.flush();
        this._log(`planner: deleted ${id}`);
    }

    getActivePlan(sessionId = null) {
        // F-2a: 可选按 session 过滤。传 sessionId 时只返回该 session 的活跃 plan
        const matches = sessionId
            ? this._index.filter(p => p.sessionId === sessionId)
            : this._index;
        // 返回正在执行或已批准的计划（优先 executing）
        const executing = matches.find(p => p.status === PLAN_STATUS.EXECUTING);
        if (executing) return this.getPlan(executing.id);
        const approved = matches.find(p => p.status === PLAN_STATUS.APPROVED);
        if (approved) return this.getPlan(approved.id);
        const draft = matches.find(p => p.status === PLAN_STATUS.DRAFT);
        if (draft) return this.getPlan(draft.id);
        return null;
    }

    // F-2a: 返回指定 session 的所有 plan（按 updatedAt 降序）
    getSessionPlans(sessionId, limit = 10) {
        return this._index
            .filter(p => p.sessionId === sessionId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, limit);
    }

    getRecentPlans(limit = 10) {
        return [...this._index]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, limit);
    }

    // ═══ Plan 状态转换 ═══

    approvePlan(id) {
        const plan = this.getPlan(id);
        if (!plan || plan.status !== PLAN_STATUS.DRAFT) return null;
        plan.status = PLAN_STATUS.APPROVED;
        this._savePlan(plan);
        this._log(`planner: approved ${id}`);
        return plan;
    }

    startPlan(id) {
        const plan = this.getPlan(id);
        if (!plan || (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.PAUSED)) return null;
        plan.status = PLAN_STATUS.EXECUTING;
        this._savePlan(plan);
        this._log(`planner: started ${id}`);
        return plan;
    }

    pausePlan(id) {
        const plan = this.getPlan(id);
        if (!plan || plan.status !== PLAN_STATUS.EXECUTING) return null;
        plan.status = PLAN_STATUS.PAUSED;
        this._savePlan(plan);
        this._log(`planner: paused ${id}`);
        return plan;
    }

    completePlan(id) {
        const plan = this.getPlan(id);
        if (!plan) return null;
        // 防御：仍有 pending/in-progress task 时拒绝完成
        const pending = plan.tasks.filter(t => t.status === TASK_STATUS.PENDING || t.status === TASK_STATUS.IN_PROGRESS).length;
        if (pending > 0) {
            this._log(`planner: REFUSED completePlan for ${id} — ${pending} tasks still pending/in-progress`);
            return null;
        }
        plan.status = PLAN_STATUS.COMPLETE;
        this._savePlan(plan);
        this._log(`planner: completed ${id}`);
        return plan;
    }

    failPlan(id, reason) {
        const plan = this.getPlan(id);
        if (!plan) return null;
        plan.status = PLAN_STATUS.FAILED;
        plan._failReason = reason;
        this._savePlan(plan);
        this._log(`planner: failed ${id} — ${reason}`);
        return plan;
    }

    // ═══ Task 状态转换 ═══

    startTask(planId, taskId) {
        const plan = this.getPlan(planId);
        if (!plan) return null;
        const task = plan.tasks.find(t => t.id === taskId);
        if (!task || task.status !== TASK_STATUS.PENDING) return null;
        task.status = TASK_STATUS.IN_PROGRESS;
        task.startedAt = Date.now();
        this._savePlan(plan);
        return task;
    }

    completeTask(planId, taskId, result) {
        const plan = this.getPlan(planId);
        if (!plan) return null;
        const task = plan.tasks.find(t => t.id === taskId);
        if (!task) return null;
        task.status = TASK_STATUS.COMPLETE;
        task.result = result || 'Done';
        task.completedAt = Date.now();
        this._savePlan(plan);

        // 检查是否所有 task 完成 → 自动 complete plan
        const allDone = plan.tasks.every(t =>
            t.status === TASK_STATUS.COMPLETE || t.status === TASK_STATUS.SKIPPED
        );
        if (allDone) {
            this.completePlan(planId);
        }
        return task;
    }

    failTask(planId, taskId, error) {
        const plan = this.getPlan(planId);
        if (!plan) return null;
        const task = plan.tasks.find(t => t.id === taskId);
        if (!task) return null;
        task.status = TASK_STATUS.FAILED;
        task.error = error;
        task.completedAt = Date.now();
        this._savePlan(plan);
        return task;
    }

    rollbackTask(planId, taskId) {
        const plan = this.getPlan(planId);
        if (!plan) return null;
        const task = plan.tasks.find(t => t.id === taskId);
        if (!task) return null;
        task.status = TASK_STATUS.ROLLED_BACK;
        this._savePlan(plan);
        return task;
    }

    setTaskCheckpoint(planId, taskId, checkpoint) {
        const plan = this.getPlan(planId);
        if (!plan) return null;
        const task = plan.tasks.find(t => t.id === taskId);
        if (!task) return null;
        task.checkpoint = checkpoint; // { type: 'stash'|'tag', ref: string }
        this._savePlan(plan);
        return task;
    }

    /**
     * 获取下一个可执行的 task（依赖全部满足）
     */
    getNextTask(planId) {
        const plan = this.getPlan(planId);
        if (!plan || plan.status !== PLAN_STATUS.EXECUTING) return null;

        for (const task of plan.tasks) {
            if (task.status !== TASK_STATUS.PENDING) continue;
            // 检查依赖
            const depsOk = task.dependencies.every(depId => {
                const dep = plan.tasks.find(t => t.id === depId);
                return dep && (dep.status === TASK_STATUS.COMPLETE || dep.status === TASK_STATUS.SKIPPED);
            });
            if (depsOk) return task;
        }
        return null;
    }

    /**
     * 获取 plan 进度摘要
     */
    getProgress(planId) {
        const plan = this.getPlan(planId);
        if (!plan) return null;
        const total = plan.tasks.length;
        const complete = plan.tasks.filter(t => t.status === TASK_STATUS.COMPLETE).length;
        const failed = plan.tasks.filter(t => t.status === TASK_STATUS.FAILED).length;
        const inProgress = plan.tasks.filter(t => t.status === TASK_STATUS.IN_PROGRESS).length;
        const pending = plan.tasks.filter(t => t.status === TASK_STATUS.PENDING).length;
        return { total, complete, failed, inProgress, pending, percent: Math.round((complete / total) * 100) };
    }

    /**
     * 替换失败 task 之后的所有待执行步骤（反馈闭环）
     * @param {string} planId
     * @param {number} afterOrder - 失败 task 的 order
     * @param {Array} newTasks - [{ content, files }]
     */
    replaceRemainingTasks(planId, afterOrder, newTasks) {
        const plan = this.getPlan(planId);
        if (!plan) return null;

        // 移除 afterOrder 之后的所有 pending task
        plan.tasks = plan.tasks.filter(t => t.order <= afterOrder || t.status === TASK_STATUS.COMPLETE);

        // 插入新 tasks
        const startOrder = afterOrder + 1;
        for (let i = 0; i < newTasks.length; i++) {
            plan.tasks.push({
                id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'),
                content: newTasks[i].content,
                status: TASK_STATUS.PENDING,
                order: startOrder + i,
                dependencies: [],
                files: newTasks[i].files || [],
                checkpoint: null,
                result: null,
                error: null,
                startedAt: null,
                completedAt: null
            });
        }

        plan.updatedAt = Date.now();
        this._savePlan(plan);
        return plan;
    }
}

module.exports = { PlanManager, PLAN_STATUS, TASK_STATUS };

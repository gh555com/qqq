// ═══════════════════════════════════════════════════════════════
// agent-planner.js — Plan 生成/修订/失败重规划 mixin
// generatePlan, revisePlan, replanAfterFailure
// ═══════════════════════════════════════════════════════════════

const { GATEWAY_URL } = require('./prompt');

module.exports = function(Agent) {

    /**
     * Plan 生成
     */
    Agent.prototype.generatePlan = async function(userMessage, opts = {}) {
        const token = await this._getAuthToken();
        if (!token) return null;

        const planPrompt = `You are a task planner for qqq IDE. Decide if this user request needs a multi-step Plan.

User request:
"${userMessage}"

# DEFAULT: { "needs_plan": false }

Only create a plan if the request CLEARLY requires ALL of these:
- 3+ distinct sequential steps that depend on each other
- AND modifying 3+ files OR major architectural change OR multi-stage migration
- AND the user is explicitly asking for a structured execution

# Output { "needs_plan": false } for:
- Single-file edits (any size)
- Bug fixes, even non-trivial ones
- Adding/modifying a function/class/component
- Configuration tweaks
- Adding logging/comments/types
- Style/format changes
- Code review, questions, explanations
- Refactoring within one file
- Anything that one focused edit-and-verify cycle can solve
- When in doubt, output { "needs_plan": false }

# Output a Plan JSON only when needed:
{
  "needs_plan": true,
  "title": "short title (Chinese ok)",
  "overview": "1-2 sentence summary",
  "tasks": [
    { "content": "具体步骤描述", "files": ["file paths if known"], "dependencies": [] }
  ]
}

Rules:
- Tasks should be verifiable
- Group related file changes into one task
- Max 6 tasks (the user can always ask for sub-plans)
- Output ONLY JSON, nothing else.`;

        try {
            const resp = await fetch(GATEWAY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are a precise JSON-only task planner. Output valid JSON only.' },
                        { role: 'user', content: planPrompt }
                    ],
                    stream: true,
                    stream_options: { include_usage: true },
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' }
                })
            });
            if (!resp.ok) return null;
            const fullText = await this._collectSSEContent(resp.body);
            if (!fullText) return null;
            const jsonMatch = fullText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            const parsed = JSON.parse(jsonMatch[0]);
            if (!parsed.needs_plan) return null;
            this._log(`planner: generated plan "${parsed.title}" with ${parsed.tasks?.length || 0} tasks`);
            return parsed;
        } catch (e) {
            this._log(`planner: generation failed — ${e.message}`);
            return null;
        }
    };

    /**
     * 修订现有 Plan
     */
    Agent.prototype.revisePlan = async function(currentPlan, userFeedback) {
        const token = await this._getAuthToken();
        if (!token) return null;

        const taskList = currentPlan.tasks.map((t, i) => `${i + 1}. ${t.content}`).join('\n');

        const revisePrompt = `You are revising an existing execution plan based on user feedback.

Current plan:
Title: ${currentPlan.title}
Overview: ${currentPlan.overview}
Tasks:
${taskList}

User feedback:
"${userFeedback}"

Revise the plan based on the feedback. Keep the main structure intact unless the user explicitly wants to change it. Make minimal, surgical changes.

Output the revised plan as JSON:
{
  "title": "...",
  "overview": "...",
  "tasks": [
    { "content": "...", "files": [...], "dependencies": [] }
  ]
}

Rules:
- Preserve unchanged tasks exactly as-is
- Only modify/add/remove tasks as requested
- Keep max 8 tasks
- Output ONLY the JSON, nothing else.`;

        try {
            const resp = await fetch(GATEWAY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are a precise JSON-only task planner. Output valid JSON only.' },
                        { role: 'user', content: revisePrompt }
                    ],
                    stream: true,
                    stream_options: { include_usage: true },
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' }
                })
            });
            if (!resp.ok) return null;
            const fullText = await this._collectSSEContent(resp.body);
            if (!fullText) return null;
            const jsonMatch = fullText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            const parsed = JSON.parse(jsonMatch[0]);
            this._log(`planner: revised plan "${parsed.title}" → ${parsed.tasks?.length || 0} tasks`);
            return parsed;
        } catch (e) {
            this._log(`planner: revision failed — ${e.message}`);
            return null;
        }
    };

    /**
     * 失败后重规划
     */
    Agent.prototype.replanAfterFailure = async function(plan, failedTask, failedError, executionContext) {
        const token = await this._getAuthToken();
        if (!token) return null;

        const completedBlock = executionContext.length > 0
            ? executionContext.map(c => `Task ${c.order + 1}: ${c.content}\nResult: ${c.result}`).join('\n\n')
            : '(无)';

        const remainingTasks = plan.tasks
            .filter(t => t.order > failedTask.order)
            .map((t, i) => `${i + 1}. ${t.content}`)
            .join('\n');

        const prompt = `一个多步执行计划中的某个 task 失败了。请分析原因并修订后续计划。

## 计划总览
${plan.overview}

## 已完成步骤
${completedBlock}

## 失败步骤（第 ${failedTask.order + 1} 步）
内容: ${failedTask.content}
错误: ${failedError}

## 原始后续步骤
${remainingTasks || '(无后续步骤)'}

请产出 JSON:
{
  "analysis": "一句话说明失败原因和影响",
  "action": "retry|revise|abort",
  "revised_tasks": [
    { "content": "修订后的步骤描述", "files": [] }
  ]
}

Rules:
- retry: 失败是临时性的（网络/超时），原 task 可直接重试，revised_tasks 保持原样
- revise: 失败暴露了方案问题，需要调整后续步骤
- abort: 失败是根本性的，继续没有意义
- revised_tasks 替换原始后续步骤（不含失败步骤本身）
- 只产出 JSON`;

        try {
            const resp = await fetch(GATEWAY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are a precise JSON-only task replanner. Output valid JSON only.' },
                        { role: 'user', content: prompt }
                    ],
                    stream: true,
                    stream_options: { include_usage: true },
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' }
                })
            });
            if (!resp.ok) return null;
            const fullText = await this._collectSSEContent(resp.body);
            if (!fullText) return null;
            const jsonMatch = fullText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            const parsed = JSON.parse(jsonMatch[0]);
            this._log(`replanner: action=${parsed.action}, analysis=${parsed.analysis}`);
            return parsed;
        } catch (e) {
            this._log(`replanner: failed — ${e.message}`);
            return null;
        }
    };
};

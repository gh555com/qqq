// ═══════════════════════════════════════════════════════════════
// agent-billing.js — 计费 mixin
// _flushBilling, _buildAndFlushBilling, _emitRageDot, _modelToLabel,
// _accumulateVisionCost
// ═══════════════════════════════════════════════════════════════

const vscode = require('vscode');
const { BILLING_FLUSH_URL } = require('./prompt');

module.exports = function(Agent) {

    Agent.prototype._modelToLabel = function(model) {
        if (!model) return '—';
        if (model.includes('-pro')) return '\u{1F9E0} Pro+Max';
        if (model.includes('-flash') || model.includes('-chat')) return '\u26A1 Flash';
        return model;
    };

    Agent.prototype._emitRageDot = function(callCostWge, tier) {
        const RAGE_100_WGE = 500;
        let rage = 0;
        if (callCostWge > 0) {
            rage = Math.min(100, Math.round((callCostWge / RAGE_100_WGE) * 100));
        }
        const isFlashByServer = this._actualModel && (this._actualModel.includes('-flash') || this._actualModel.includes('-chat'));
        if (isFlashByServer) rage = 0;
        this._updateRage(rage);
        if (this._onRageDot) {
            this._onRageDot(rage, { wge: callCostWge });
        }
        this._log(`  K线打点: rage=${rage} (wge=${callCostWge})`);
    };

    Agent.prototype._accumulateVisionCost = function(result) {
        if (typeof result === 'object' && result.ge_cost) {
            this._turnCostWge += result.ge_cost;
        }
    };

    Agent.prototype._flushBilling = async function(summary, lang) {
        if (!this._turnId || this._turnCostWge <= 0) return;
        try {
            const token = await this._getAuthToken();
            if (!token) return;
            const body = { turn_id: this._turnId };
            if (summary) body.summary = String(summary).slice(0, 222);
            if (lang) body.lang = String(lang).slice(0, 8);
            fetch(BILLING_FLUSH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(body)
            }).catch(() => {});
        } catch (_) {}
    };

    Agent.prototype._buildAndFlushBilling = function(userMessage, assistantResult) {
        let summary = (this._currentTurnSummary || '').trim();
        if (!summary) {
            const u = (userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            const a = (assistantResult || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            summary = u && a ? `${u} | ${a}` : (u || a || '').slice(0, 200);
        }
        summary = summary
            .replace(/(sk-[A-Za-z0-9_-]{16,})/g, '[REDACTED_KEY]')
            .replace(/(ghp_[A-Za-z0-9]{16,})/g, '[REDACTED_TOKEN]')
            .replace(/(AKIA[0-9A-Z]{12,})/g, '[REDACTED_AK]')
            .replace(/(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, '[REDACTED_PWD]')
            .replace(/-----BEGIN[\s\S]+?-----END[^-]*-----/g, '[REDACTED_PEM]')
            .slice(0, 200);
        const lang = this._currentTurnSummaryLang
            || ((vscode.env && vscode.env.language) ? vscode.env.language : 'en');
        this._flushBilling(summary, lang);
    };
};

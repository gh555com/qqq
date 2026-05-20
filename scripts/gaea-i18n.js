#!/usr/bin/env node
/**
 * gaea-i18n.js — Reference Node implementation of the gaea-i18n CLI (stub).
 *
 * Future: this will be re-implemented in Go and shipped as a single ~5MB binary
 *         (cross-OS), so any gaea software/game can install once and never depend
 *         on Node. For now, this Node stub validates the contract end-to-end.
 *
 * Contract — see ignore/qqq 拓扑/arc/我们到底要做什吗 §18:
 *   1) Read i18n.toml at repo root.
 *   2) For each [[calls]] entry, build a 6-arg request:
 *        { source_lang, target_langs, kv, domain, glossary_id, tm_namespace }
 *   3) POST to <endpoint>/api/v3/i18n/translate.
 *   4) Write result back to output_template per lang.
 *
 * Commands:
 *   gaea-i18n sync        — full pipeline (read toml → call endpoint → write files)
 *   gaea-i18n validate    — parse + validate i18n.toml only (no network)
 *   gaea-i18n dry-run     — show what calls would be made (mock 6-arg payload, no network)
 *   gaea-i18n mock        — alias of dry-run + write deterministic mock outputs
 *
 * Env:
 *   GAEA_I18N_ENDPOINT    — endpoint base URL (default: https://gaea.example.com)
 *   GAEA_I18N_TOKEN       — bearer token for auth
 *
 * Exit code: 0 ok, 1 error.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const TOML_PATH = path.join(ROOT, 'i18n.toml');

const ENDPOINT = process.env.GAEA_I18N_ENDPOINT || 'https://gaea.example.com';
const TOKEN = process.env.GAEA_I18N_TOKEN || '';

// ---------- minimal TOML parser (supports the subset we use) ----------
// Supports:
//   [[name]]                     → start a new array-of-tables entry
//   [parent.child]               → nested table under last [[name]] (or root)
//   key = "string"               → string value
//   key = ["a", "b", "c"]        → string array
//   key = true | false           → boolean
//   # comment                    → ignored
//   inline trailing # comment    → stripped (best-effort)
function parseToml(text) {
    const lines = text.split(/\r?\n/);
    const root = {};
    let curArrayKey = null;          // e.g. 'calls' if we are inside [[calls]]
    let curObj = root;               // current target table

    function setNested(obj, keyPath, value) {
        const parts = keyPath.split('.');
        let o = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const k = parts[i];
            if (!o[k] || typeof o[k] !== 'object') o[k] = {};
            o = o[k];
        }
        o[parts[parts.length - 1]] = value;
    }

    function parseValue(raw) {
        const s = raw.trim();
        if (s.startsWith('"') && s.endsWith('"')) {
            return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
        }
        if (s.startsWith('[') && s.endsWith(']')) {
            const inner = s.slice(1, -1).trim();
            if (inner === '') return [];
            const parts = [];
            let depth = 0, buf = '', inStr = false, esc = false;
            for (const ch of inner) {
                if (esc) { buf += ch; esc = false; continue; }
                if (ch === '\\') { buf += ch; esc = true; continue; }
                if (ch === '"') { inStr = !inStr; buf += ch; continue; }
                if (!inStr && ch === ',') { parts.push(buf); buf = ''; continue; }
                buf += ch;
            }
            if (buf.trim() !== '') parts.push(buf);
            return parts.map(p => parseValue(p));
        }
        if (s === 'true') return true;
        if (s === 'false') return false;
        const n = Number(s);
        if (!isNaN(n) && /^-?\d+(\.\d+)?$/.test(s)) return n;
        return s;
    }

    function stripComment(line) {
        let out = '', inStr = false, esc = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (esc) { out += ch; esc = false; continue; }
            if (ch === '\\') { out += ch; esc = true; continue; }
            if (ch === '"') { inStr = !inStr; out += ch; continue; }
            if (!inStr && ch === '#') break;
            out += ch;
        }
        return out;
    }

    for (let raw of lines) {
        const line = stripComment(raw).trim();
        if (line === '') continue;

        // [[arrayKey]]
        let m = line.match(/^\[\[([^\]]+)\]\]$/);
        if (m) {
            curArrayKey = m[1].trim();
            if (!Array.isArray(root[curArrayKey])) root[curArrayKey] = [];
            const newObj = {};
            root[curArrayKey].push(newObj);
            curObj = newObj;
            continue;
        }

        // [tableKey]
        m = line.match(/^\[([^\]]+)\]$/);
        if (m) {
            const fullKey = m[1].trim();
            // If the key starts with curArrayKey + ".", it's nested under last array entry
            if (curArrayKey && (fullKey === curArrayKey || fullKey.startsWith(curArrayKey + '.'))) {
                const subKey = fullKey === curArrayKey ? '' : fullKey.slice(curArrayKey.length + 1);
                const lastEntry = root[curArrayKey][root[curArrayKey].length - 1];
                if (subKey === '') {
                    curObj = lastEntry;
                } else {
                    const parts = subKey.split('.');
                    let o = lastEntry;
                    for (const p of parts) {
                        if (!o[p] || typeof o[p] !== 'object') o[p] = {};
                        o = o[p];
                    }
                    curObj = o;
                }
            } else {
                // top-level nested table
                curArrayKey = null;
                const parts = fullKey.split('.');
                let o = root;
                for (const p of parts) {
                    if (!o[p] || typeof o[p] !== 'object') o[p] = {};
                    o = o[p];
                }
                curObj = o;
            }
            continue;
        }

        // key = value
        m = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/);
        if (m) {
            const key = m[1];
            const val = parseValue(m[2]);
            curObj[key] = val;
            continue;
        }
    }

    return root;
}

// ---------- core ops ----------
function loadConfig() {
    if (!fs.existsSync(TOML_PATH)) {
        console.error(`[gaea-i18n] no i18n.toml at ${TOML_PATH}`);
        process.exit(1);
    }
    const text = fs.readFileSync(TOML_PATH, 'utf8');
    let cfg;
    try { cfg = parseToml(text); }
    catch (e) { console.error('[gaea-i18n] toml parse failed:', e.message); process.exit(1); }
    if (!Array.isArray(cfg.calls) || cfg.calls.length === 0) {
        console.error('[gaea-i18n] no [[calls]] entries in i18n.toml');
        process.exit(1);
    }
    return cfg;
}

function validateCall(c, idx) {
    const errs = [];
    if (!c.name) errs.push(`calls[${idx}].name missing`);
    if (!c.truth?.source_lang) errs.push(`calls[${idx}].truth.source_lang missing`);
    if (!c.truth?.source_file) errs.push(`calls[${idx}].truth.source_file missing`);
    if (!Array.isArray(c.targets?.langs) || c.targets.langs.length === 0) errs.push(`calls[${idx}].targets.langs missing/empty`);
    if (!c.targets?.output_dir) errs.push(`calls[${idx}].targets.output_dir missing`);
    if (!c.domain?.type) errs.push(`calls[${idx}].domain.type missing`);
    if (!c.glossary?.id) errs.push(`calls[${idx}].glossary.id missing`);
    if (!c.tm?.namespace) errs.push(`calls[${idx}].tm.namespace missing`);
    return errs;
}

function flatten(obj, prefix = '', out = {}) {
    if (obj === null || obj === undefined) return out;
    if (typeof obj !== 'object' || Array.isArray(obj)) { out[prefix] = obj; return out; }
    for (const k of Object.keys(obj)) {
        const next = prefix ? `${prefix}.${k}` : k;
        flatten(obj[k], next, out);
    }
    return out;
}

function unflatten(flat) {
    const out = {};
    for (const k of Object.keys(flat)) {
        const parts = k.split('.');
        let o = out;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
            o = o[parts[i]];
        }
        o[parts[parts.length - 1]] = flat[k];
    }
    return out;
}

function buildPayload(c) {
    // 6-arg payload — see arc/我们到底要做什吗 §18 唯一接口
    const sourceFile = path.join(ROOT, c.truth.source_file);
    if (!fs.existsSync(sourceFile)) throw new Error(`source_file not found: ${sourceFile}`);
    const src = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    return {
        source_lang: c.truth.source_lang,
        target_langs: c.targets.langs,
        kv: src,
        domain: { type: c.domain.type, style: c.domain.style || 'concise' },
        glossary_id: c.glossary.id,
        tm_namespace: c.tm.namespace,
    };
}

function writeOutputs(c, result) {
    const tpl = c.targets.output_template || `${c.targets.output_dir}/{lang}.json`;
    let written = 0;
    for (const lang of c.targets.langs) {
        const v = result[lang];
        if (!v) { console.warn(`[gaea-i18n]   ⚠ no output for ${lang}`); continue; }
        const outPath = path.join(ROOT, tpl.replace('{output_dir}', c.targets.output_dir).replace('{lang}', lang));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(v, null, 2), 'utf8');
        written++;
        console.log(`[gaea-i18n]   wrote ${path.relative(ROOT, outPath)}`);
    }
    return written;
}

async function callEndpoint(payload) {
    const url = `${ENDPOINT}/api/v3/i18n/translate`;
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

    const fetch = global.fetch || (() => { throw new Error('fetch not available — Node ≥ 18 required'); });
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
}

function mockTranslate(payload) {
    // Deterministic mock: prefix every value with [<lang>] for visibility.
    const out = {};
    const flat = flatten(payload.kv);
    for (const lang of payload.target_langs) {
        const t = {};
        for (const k of Object.keys(flat)) {
            const v = flat[k];
            t[k] = typeof v === 'string' ? `[${lang}] ${v}` : v;
        }
        out[lang] = unflatten(t);
    }
    return out;
}

// ---------- commands ----------
async function cmdValidate() {
    const cfg = loadConfig();
    let bad = 0;
    cfg.calls.forEach((c, i) => {
        const errs = validateCall(c, i);
        if (errs.length === 0) {
            console.log(`[gaea-i18n] ✓ calls[${i}] (${c.name}) ok — ${c.targets.langs.length} target langs`);
        } else {
            bad++;
            console.error(`[gaea-i18n] ✗ calls[${i}] (${c.name || '?'})`);
            for (const e of errs) console.error(`    - ${e}`);
        }
    });
    if (bad > 0) process.exit(1);
    console.log(`[gaea-i18n] ${cfg.calls.length} call(s) validated.`);
}

async function cmdDryRun(writeMockOutputs) {
    const cfg = loadConfig();
    for (let i = 0; i < cfg.calls.length; i++) {
        const c = cfg.calls[i];
        const errs = validateCall(c, i);
        if (errs.length > 0) {
            console.error(`[gaea-i18n] ✗ calls[${i}] invalid:`); errs.forEach(e => console.error(`    - ${e}`));
            process.exit(1);
        }
        let payload;
        try { payload = buildPayload(c); }
        catch (e) { console.error(`[gaea-i18n] ✗ calls[${i}] payload: ${e.message}`); process.exit(1); }

        console.log(`[gaea-i18n] === calls[${i}] ${c.name} ===`);
        console.log(`  endpoint    : POST ${ENDPOINT}/api/v3/i18n/translate`);
        console.log(`  source_lang : ${payload.source_lang}`);
        console.log(`  target_langs: [${payload.target_langs.join(', ')}]`);
        console.log(`  domain      : ${payload.domain.type}/${payload.domain.style}`);
        console.log(`  glossary_id : ${payload.glossary_id}`);
        console.log(`  tm_namespace: ${payload.tm_namespace}`);
        const flat = flatten(payload.kv);
        console.log(`  kv keys     : ${Object.keys(flat).length}`);

        if (writeMockOutputs) {
            const result = mockTranslate(payload);
            const n = writeOutputs(c, result);
            console.log(`  [mock] wrote ${n}/${c.targets.langs.length} files`);
        }
    }
}

async function cmdSync() {
    const cfg = loadConfig();
    for (let i = 0; i < cfg.calls.length; i++) {
        const c = cfg.calls[i];
        const errs = validateCall(c, i);
        if (errs.length > 0) {
            console.error(`[gaea-i18n] ✗ calls[${i}] invalid:`); errs.forEach(e => console.error(`    - ${e}`));
            process.exit(1);
        }
        const payload = buildPayload(c);
        console.log(`[gaea-i18n] calls[${i}] ${c.name} → POST ${ENDPOINT}/api/v3/i18n/translate ...`);
        let result;
        try {
            result = await callEndpoint(payload);
        } catch (e) {
            console.error(`[gaea-i18n] ✗ endpoint call failed: ${e.message}`);
            console.error(`[gaea-i18n]   (endpoint not implemented yet? use \`gaea-i18n mock\` for offline testing)`);
            process.exit(1);
        }
        writeOutputs(c, result);
    }
}

async function main() {
    const cmd = process.argv[2] || 'help';
    switch (cmd) {
        case 'sync':     await cmdSync(); break;
        case 'validate': await cmdValidate(); break;
        case 'dry-run':  await cmdDryRun(false); break;
        case 'mock':     await cmdDryRun(true); break;
        default:
            console.log('gaea-i18n — translate machine CLI (Node stub)');
            console.log('');
            console.log('  gaea-i18n sync       full pipeline (read toml → endpoint → write files)');
            console.log('  gaea-i18n validate   parse + validate i18n.toml only');
            console.log('  gaea-i18n dry-run    show 6-arg payload, no network, no writes');
            console.log('  gaea-i18n mock       like dry-run + write mock outputs (offline test)');
            console.log('');
            console.log('Env: GAEA_I18N_ENDPOINT, GAEA_I18N_TOKEN');
            console.log('Spec: ignore/qqq 拓扑/arc/我们到底要做什吗 §18');
    }
}

main().catch(e => { console.error('[gaea-i18n] fatal:', e.stack || e.message); process.exit(1); });

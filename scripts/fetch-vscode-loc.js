#!/usr/bin/env node
/**
 * fetch-vscode-loc.js — Pull official VS Code Language Packs from microsoft/vscode-loc.
 *
 * Source: https://github.com/microsoft/vscode-loc
 * Layout per lang: i18n/vscode-language-pack-<code>/translations/main.i18n.json
 *
 * Mapping (vscode-loc code → our 13-lang code):
 *   zh-hans  → zh         (Simplified Chinese)
 *   zh-hant  → zh-tw      (Traditional Chinese)
 *   ja       → ja
 *   ko       → ko
 *   ru       → ru
 *   de       → de
 *   es       → es
 *   fr       → fr
 *   pt-br    → pt-br      (note: also covered by call A; we still pull as fallback)
 *
 * Missing from vscode-loc (need [[calls]]B in i18n.toml):
 *   en       — source language (no pack)
 *   ar, hi, vi
 *
 * Output:
 *   staging/vscode-loc/en.json          — source (extracted from any pack key set)
 *   staging/vscode-loc/<lang>.json      — translations per supported lang
 *
 * Usage:
 *   node scripts/fetch-vscode-loc.js              # full fetch (clone + extract)
 *   node scripts/fetch-vscode-loc.js --skip-clone # extract only (assumes already cloned)
 *   node scripts/fetch-vscode-loc.js --dry-run    # show what would be done
 *
 * Requires: git in PATH.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGING = path.join(ROOT, 'staging');
const VSCODE_LOC_DIR = path.join(STAGING, 'vscode-loc.git');
const OUT_DIR = path.join(STAGING, 'vscode-loc');

const REPO_URL = 'https://github.com/microsoft/vscode-loc.git';

const SKIP_CLONE = process.argv.includes('--skip-clone');
const DRY_RUN = process.argv.includes('--dry-run');

// vscode-loc lang code → our 13-lang code
const LANG_MAP = {
    'zh-hans': 'zh',
    'zh-hant': 'zh-tw',
    'ja': 'ja',
    'ko': 'ko',
    'ru': 'ru',
    'de': 'de',
    'es': 'es',
    'fr': 'fr',
    'pt-br': 'pt-br',
};

function log(...args) { console.log('[fetch-vscode-loc]', ...args); }

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function cloneOrUpdate() {
    if (SKIP_CLONE) {
        log('--skip-clone: assuming repo exists at', VSCODE_LOC_DIR);
        return;
    }
    if (DRY_RUN) {
        log('DRY-RUN: would clone/update', REPO_URL, '→', VSCODE_LOC_DIR);
        return;
    }
    ensureDir(STAGING);
    if (fs.existsSync(VSCODE_LOC_DIR)) {
        log('updating existing clone (depth=1)...');
        cp.execSync('git fetch --depth=1 origin main', { cwd: VSCODE_LOC_DIR, stdio: 'inherit' });
        cp.execSync('git reset --hard origin/main', { cwd: VSCODE_LOC_DIR, stdio: 'inherit' });
    } else {
        log('cloning', REPO_URL, '...');
        cp.execSync(`git clone --depth=1 ${REPO_URL} "${VSCODE_LOC_DIR}"`, { stdio: 'inherit' });
    }
}

/**
 * Flatten vscode-loc i18n shape into a flat key→string map.
 *
 * vscode-loc main.i18n.json is roughly:
 *   { "contents": { "<bundle>": { "<key>": "translated", ... }, ... } }
 *
 * We flatten to "<bundle>::<key>" → string for staging.
 */
function flattenContents(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    const contents = obj.contents || obj;
    for (const bundle of Object.keys(contents)) {
        const inner = contents[bundle];
        if (!inner || typeof inner !== 'object') continue;
        for (const k of Object.keys(inner)) {
            const v = inner[k];
            if (typeof v === 'string') out[`${bundle}::${k}`] = v;
        }
    }
    return out;
}

function extractLang(vscodeCode, ourCode) {
    const mainJson = path.join(VSCODE_LOC_DIR, 'i18n', `vscode-language-pack-${vscodeCode}`, 'translations', 'main.i18n.json');
    if (!fs.existsSync(mainJson)) {
        log(`  [skip] ${vscodeCode}: ${path.relative(ROOT, mainJson)} not found`);
        return null;
    }
    if (DRY_RUN) {
        log(`  [dry-run] ${vscodeCode} → ${ourCode}.json`);
        return {};
    }
    let data;
    try { data = JSON.parse(fs.readFileSync(mainJson, 'utf8')); }
    catch (e) { log(`  [error] ${vscodeCode}: parse failed: ${e.message}`); return null; }
    const flat = flattenContents(data);
    const outFile = path.join(OUT_DIR, `${ourCode}.json`);
    ensureDir(OUT_DIR);
    fs.writeFileSync(outFile, JSON.stringify(flat, null, 2), 'utf8');
    log(`  [ok]   ${vscodeCode.padEnd(8)} → ${path.relative(ROOT, outFile)}  (${Object.keys(flat).length} keys)`);
    return flat;
}

function deriveEnFromAny(anyTranslation) {
    // We don't have an "en" pack — vscode source IS English.
    // Strategy: emit en.json with same keys as anyTranslation but values = key tail (placeholder)
    //           OR leave it for [[calls]] B to use bundle::key as English source labels.
    //
    // Practical approach used by [[calls]] B (in i18n.toml): translate FROM en → ar/hi/vi/pt-br.
    // So we need real English strings. They are available in:
    //   vscode-loc.git/i18n/vscode-language-pack-<x>/translations/main.i18n.json
    // does NOT contain en — it only has translations.
    //
    // Real English source = VS Code's own .nls.json embedded in the running OSS at compile time.
    // Future: scripts/extract-vscode-en.js will pull from ide/code-oss-1.77.3 src/**/*.nls.json
    //         and emit staging/vscode-loc/en.json.
    //
    // For now we emit a key-only en.json (placeholder) — real fill done in Phase C compile.
    if (!anyTranslation) return;
    if (DRY_RUN) { log('  [dry-run] en.json placeholder'); return; }
    const out = {};
    for (const k of Object.keys(anyTranslation)) {
        out[k] = `__EN_PLACEHOLDER__${k}`;  // will be filled by extract-vscode-en.js in Phase C
    }
    const outFile = path.join(OUT_DIR, 'en.json');
    ensureDir(OUT_DIR);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
    log(`  [ok]   en (placeholder) → ${path.relative(ROOT, outFile)}  (${Object.keys(out).length} keys, awaiting Phase C extract)`);
}

function main() {
    log('=== fetch-vscode-loc ===');
    log('repo:', REPO_URL);
    log('clone target:', VSCODE_LOC_DIR);
    log('output:', OUT_DIR);
    log('dry-run:', DRY_RUN);
    log('');

    cloneOrUpdate();

    if (DRY_RUN) {
        log('\n--- DRY-RUN: would extract ---');
        for (const [vc, oc] of Object.entries(LANG_MAP)) {
            log(`  ${vc} → ${oc}.json`);
        }
        log('  en (placeholder) → en.json');
        return;
    }

    log('\n--- extracting per-lang ---');
    let lastFlat = null;
    for (const [vc, oc] of Object.entries(LANG_MAP)) {
        const flat = extractLang(vc, oc);
        if (flat && Object.keys(flat).length > 0) lastFlat = flat;
    }

    log('\n--- emitting en.json (placeholder for Phase C) ---');
    deriveEnFromAny(lastFlat);

    log('\nDone.');
    log('Next: i18n.toml [[calls]] B will translate en → ar/hi/vi/pt-br via gaea-i18n CLI.');
}

main();

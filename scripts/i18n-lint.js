#!/usr/bin/env node
/**
 * i18n-lint.js — Lint runtime i18n files against zh truth source.
 *
 * Checks (per src/i18n/<lang>.json against src/i18n/zh.json):
 *   1) Valid JSON parse
 *   2) Missing keys (relative to zh)
 *   3) Extra keys (relative to zh)
 *   4) Placeholder mismatch ({0}{1}{2}... count differs from zh)
 *   5) Empty / whitespace-only values
 *
 * Also lints package.nls.<lang>.json against package.nls.json (default).
 *
 * Exit code: 0 = ok, 1 = errors found, 2 = warnings only (still fails strict CI).
 *
 * Usage:
 *   node scripts/i18n-lint.js              # default: warn + report
 *   node scripts/i18n-lint.js --strict     # exit 1 on any issue (for CI)
 *   node scripts/i18n-lint.js --json       # machine-readable output
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'src', 'i18n');
const NLS_DIR = ROOT;

const STRICT = process.argv.includes('--strict');
const JSON_OUT = process.argv.includes('--json');

// 13 languages
const LANGS = ['zh', 'zh-tw', 'en', 'ja', 'de', 'ru', 'ar', 'ko', 'es', 'fr', 'pt-br', 'hi', 'vi'];

const TRUTH = 'zh';

const issues = []; // {file, level, code, key?, msg}

function readJson(p) {
    try {
        const txt = fs.readFileSync(p, 'utf8');
        return { ok: true, data: JSON.parse(txt) };
    } catch (e) {
        return { ok: false, err: e.message };
    }
}

function flatten(obj, prefix = '', out = {}) {
    if (obj === null || obj === undefined) return out;
    if (typeof obj !== 'object' || Array.isArray(obj)) {
        out[prefix] = obj;
        return out;
    }
    for (const k of Object.keys(obj)) {
        const next = prefix ? `${prefix}.${k}` : k;
        flatten(obj[k], next, out);
    }
    return out;
}

function placeholderCount(s) {
    if (typeof s !== 'string') return 0;
    const m = s.match(/\{\d+\}/g);
    return m ? m.length : 0;
}

function lintPair(label, truthFile, langFile, lang) {
    const file = path.relative(ROOT, langFile).replace(/\\/g, '/');
    if (!fs.existsSync(langFile)) {
        issues.push({ file, level: 'error', code: 'MISSING_FILE', msg: `${lang}: file not found` });
        return;
    }
    const t = readJson(truthFile);
    const c = readJson(langFile);
    if (!t.ok) {
        issues.push({ file: path.relative(ROOT, truthFile).replace(/\\/g, '/'), level: 'error', code: 'INVALID_JSON', msg: `truth file parse failed: ${t.err}` });
        return;
    }
    if (!c.ok) {
        issues.push({ file, level: 'error', code: 'INVALID_JSON', msg: `parse failed: ${c.err}` });
        return;
    }
    const tFlat = flatten(t.data);
    const cFlat = flatten(c.data);
    const tKeys = new Set(Object.keys(tFlat));
    const cKeys = new Set(Object.keys(cFlat));

    let missing = 0, extra = 0, phMismatch = 0, empty = 0;

    for (const k of tKeys) {
        if (!cKeys.has(k)) {
            issues.push({ file, level: 'warn', code: 'MISSING_KEY', key: k, msg: `${lang}: missing key` });
            missing++;
        } else {
            const tv = tFlat[k], cv = cFlat[k];
            const tn = placeholderCount(tv), cn = placeholderCount(cv);
            if (tn !== cn) {
                issues.push({ file, level: 'error', code: 'PLACEHOLDER_MISMATCH', key: k,
                    msg: `${lang}: placeholder count mismatch (zh=${tn}, ${lang}=${cn})` });
                phMismatch++;
            }
            if (typeof cv === 'string' && cv.trim() === '' && (typeof tv !== 'string' || tv.trim() !== '')) {
                issues.push({ file, level: 'warn', code: 'EMPTY_VALUE', key: k, msg: `${lang}: empty value` });
                empty++;
            }
        }
    }
    for (const k of cKeys) {
        if (!tKeys.has(k)) {
            issues.push({ file, level: 'warn', code: 'EXTRA_KEY', key: k, msg: `${lang}: extra key not in zh` });
            extra++;
        }
    }
    if (!JSON_OUT) {
        const totalT = tKeys.size;
        const coverage = totalT === 0 ? 0 : Math.round(((totalT - missing) / totalT) * 1000) / 10;
        console.log(`  [${label}] ${lang.padEnd(6)} ${coverage}% coverage  (missing=${missing}, extra=${extra}, ph-mismatch=${phMismatch}, empty=${empty})`);
    }
}

function main() {
    if (!JSON_OUT) {
        console.log('=== i18n-lint ===');
        console.log(`Root: ${ROOT}`);
        console.log(`Truth lang: ${TRUTH}`);
        console.log(`Strict: ${STRICT}`);
        console.log('');
        console.log('--- Runtime i18n (src/i18n/) ---');
    }

    const truthRuntime = path.join(I18N_DIR, `${TRUTH}.json`);
    for (const lang of LANGS) {
        if (lang === TRUTH) continue;
        lintPair('runtime', truthRuntime, path.join(I18N_DIR, `${lang}.json`), lang);
    }

    if (!JSON_OUT) console.log('\n--- VS Code NLS (package.nls.*.json) ---');

    // package.nls.json is the default (en/zh combined depending on convention).
    // package.nls.zh-cn.json is the zh truth for nls. Use zh-cn as truth.
    const nlsTruth = path.join(NLS_DIR, 'package.nls.zh-cn.json');
    const nlsLangMap = {
        'zh-tw': 'package.nls.zh-tw.json',
        'en': 'package.nls.json',           // default = en
        'ja': 'package.nls.ja.json',
        'de': 'package.nls.de.json',
        'ru': 'package.nls.ru.json',
        'ar': 'package.nls.ar.json',
        'ko': 'package.nls.ko.json',
        'es': 'package.nls.es.json',
        'fr': 'package.nls.fr.json',
        'pt-br': 'package.nls.pt-br.json',
        'hi': 'package.nls.hi.json',
        'vi': 'package.nls.vi.json',
    };
    for (const [lang, fname] of Object.entries(nlsLangMap)) {
        lintPair('nls', nlsTruth, path.join(NLS_DIR, fname), lang);
    }

    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warn');

    if (JSON_OUT) {
        console.log(JSON.stringify({ errors: errors.length, warnings: warnings.length, issues }, null, 2));
    } else {
        console.log('');
        console.log(`=== Summary: ${errors.length} error(s), ${warnings.length} warning(s) ===`);
        if (errors.length > 0) {
            console.log('\nErrors (first 20):');
            for (const i of errors.slice(0, 20)) {
                console.log(`  [${i.code}] ${i.file}${i.key ? ' :: ' + i.key : ''} — ${i.msg}`);
            }
            if (errors.length > 20) console.log(`  ... and ${errors.length - 20} more`);
        }
    }

    if (errors.length > 0) process.exit(1);
    if (STRICT && warnings.length > 0) process.exit(1);
    process.exit(0);
}

main();

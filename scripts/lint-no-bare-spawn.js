#!/usr/bin/env node
/**
 * lint-no-bare-spawn — CI grep 卡口（铁律 §12 ⑨ / spawn-protocol §8 ①）
 *
 * 拒绝任何不在 .spawn-allowlist 的文件中出现 require('child_process')。
 * 新增 / 改名 / 扩展存量 → CI 红。
 *
 * 用法：
 *   node scripts/lint-no-bare-spawn.js          # 走全量扫描，违规即 exit 1
 *   node scripts/lint-no-bare-spawn.js --list   # 只输出当前命中清单
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOW_FILE = path.join(ROOT, '.spawn-allowlist');
const SCAN_DIRS = ['src', 'ai/src', 'scripts'];

// 协议入口本身永远豁免；其它存量必须显式写进 .spawn-allowlist
const EXEMPT = new Set([
    'ai/src/utils/qdirSpawn.js',
    'scripts/lint-no-bare-spawn.js',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.build']);

const PATTERN = /(?:require\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"])/;

function readAllowlist() {
    if (!fs.existsSync(ALLOW_FILE)) return new Set();
    const lines = fs.readFileSync(ALLOW_FILE, 'utf8').split(/\r?\n/);
    const out = new Set();
    for (const raw of lines) {
        const noComment = raw.split('#')[0].trim();
        if (noComment) out.add(noComment.replace(/\\/g, '/'));
    }
    return out;
}

function* walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else if (e.name.endsWith('.js') || e.name.endsWith('.cjs') || e.name.endsWith('.mjs')) {
            yield full;
        }
    }
}

function main() {
    const listOnly = process.argv.includes('--list');
    const allow = readAllowlist();
    const hits = [];   // 所有命中（含 allow / exempt）
    const violations = [];

    for (const sub of SCAN_DIRS) {
        const abs = path.join(ROOT, sub);
        if (!fs.existsSync(abs)) continue;
        for (const f of walk(abs)) {
            const rel = path.relative(ROOT, f).replace(/\\/g, '/');
            let txt;
            try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
            if (!PATTERN.test(txt)) continue;
            hits.push(rel);
            if (EXEMPT.has(rel)) continue;
            if (allow.has(rel)) continue;
            violations.push(rel);
        }
    }

    if (listOnly) {
        console.log('# all hits (' + hits.length + '):');
        for (const h of hits) console.log('  ' + h);
        console.log('# violations not in allowlist (' + violations.length + '):');
        for (const v of violations) console.log('  ' + v);
        process.exit(0);
    }

    if (violations.length) {
        console.error('[lint-no-bare-spawn] FAIL — bare child_process forbidden');
        for (const v of violations) console.error('  ✗ ' + v);
        console.error('');
        console.error('  Use:   const { qdirSpawn } = require("ai/src/utils/qdirSpawn");');
        console.error('  Spec:  ignore/qqq 拓扑/arc/spawn-protocol §8');
        console.error('  Iron:  ignore/qqq 拓扑/arc/铁律 §12');
        console.error('');
        console.error('  If this is intentional legacy that cannot be migrated yet,');
        console.error('  add the path to .spawn-allowlist with a TODO comment.');
        process.exit(1);
    }
    console.log('[lint-no-bare-spawn] OK — ' + hits.length + ' allowed hits, 0 violations');
    process.exit(0);
}

main();

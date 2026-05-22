#!/usr/bin/env node
/**
 * lint-no-foreign-aux — CI grep 卡口（铁律 §13 ⑥ + §13 ⑩）
 *
 * 铁律 §13：qqq AI × AuxiliaryBar 一对一独占绑定。
 *
 * 拒绝以下违规：
 *   ① package.json / gaea.json 的 publisher !== 'qqq' / 'gh555' 出现 contributes.viewsContainers.auxiliarybar
 *   ② package.json 的 publisher !== 'qqq' / 'gh555' 出现 viewsContainers.activitybar.id 命中 qqqAiView*
 *   ③ package.json 的 publisher !== 'qqq' / 'gh555' 在 contributes.views 下含 qqq-ai.* 视图
 *   ④ qqq-ide-src/src/vs/qqq/aux/ 之外的 IDE 壳源码出现 ViewContainerLocation.AuxiliaryBar 字面量
 *
 * 用法：
 *   node scripts/lint-no-foreign-aux.js          # 违规即 exit 1
 *   node scripts/lint-no-foreign-aux.js --list   # 仅打印命中清单
 *
 * 触发场景：CI / 提交前 / 任何贡献了「auxiliarybar 容器」的 PR。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');     // 仓库根 = q3 上一级（包含 q3、qqq-modules、qqq-ide-src）
const Q3_ROOT = path.resolve(__dirname, '..');         // q3 自身

// 允许的 publisher（qqq AI 唯一所有者）
const ALLOWED_PUBLISHERS = new Set(['qqq', 'gh555']);

// 扫描区域：相对仓库根的子目录
const SCAN_DIRS = ['q3', 'qqq-modules', 'qqq-ide-src/extensions'];

// IDE 壳源码扫描：仅 qqq-ide-src/src/vs，但豁免 vs/qqq/aux/
const IDE_SHELL_SRC = path.join(ROOT, 'qqq-ide-src', 'src', 'vs');
const IDE_SHELL_AUX_EXEMPT = path.join(IDE_SHELL_SRC, 'qqq', 'aux');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dist', 'out', '.build', 'test', 'tests', 'VSCode-win32-x64']);

// ─────── ① ② ③ Manifest 扫描 ───────

function isQqqAuxView(viewIdOrContainerId) {
    if (!viewIdOrContainerId || typeof viewIdOrContainerId !== 'string') return false;
    return viewIdOrContainerId === 'qqqAiView'
        || viewIdOrContainerId === 'qqqAiViewAux'
        || viewIdOrContainerId.startsWith('qqq-ai.');
}

function scanManifest(manifestPath, violations) {
    let raw, json;
    try {
        raw = fs.readFileSync(manifestPath, 'utf8');
        json = JSON.parse(raw);
    } catch {
        return; // 解析失败的非法 JSON 不在本卡口范围
    }

    const publisher = json.publisher || '';
    const contributes = json.contributes || {};
    const vc = contributes.viewsContainers || {};
    const views = contributes.views || {};

    // ① auxiliarybar 容器：禁止任何贡献（铁律 §13：唯一来源 = IDE 壳静态注册）
    if (vc.auxiliarybar && Array.isArray(vc.auxiliarybar) && vc.auxiliarybar.length > 0) {
        violations.push({
            file: manifestPath,
            rule: '①',
            msg: `contributes.viewsContainers.auxiliarybar 禁止贡献（唯一来源 = qqq-ide-src/src/vs/qqq/aux/qqqAuxContribution.ts）`
        });
    }

    // ② activitybar 上 qqqAi* 容器：禁止（铁律 §13 ⑥：砍 ActivityBar 入口）
    if (vc.activitybar && Array.isArray(vc.activitybar)) {
        for (const c of vc.activitybar) {
            if (c && isQqqAuxView(c.id)) {
                violations.push({
                    file: manifestPath,
                    rule: '②',
                    msg: `contributes.viewsContainers.activitybar.id='${c.id}' 禁止（铁律 §13 ⑥：qqq AI 不上 ActivityBar）`
                });
            }
        }
    }

    // ③ contributes.views 下含 qqq-ai.* 或挂在 qqqAiView*：仅 qqq publisher 允许（且实际上铁律 §13 已迁到 IDE 壳静态）
    for (const containerId of Object.keys(views)) {
        const arr = views[containerId];
        if (!Array.isArray(arr)) continue;
        for (const v of arr) {
            if (!v || !v.id) continue;
            const hits = isQqqAuxView(v.id) || isQqqAuxView(containerId);
            if (!hits) continue;
            if (!ALLOWED_PUBLISHERS.has(publisher)) {
                violations.push({
                    file: manifestPath,
                    rule: '③',
                    msg: `contributes.views.${containerId}[].id='${v.id}' 禁止（publisher='${publisher}' 不在白名单 [qqq, gh555]）`
                });
            } else {
                // 即便是 qqq publisher，铁律 §13 也要求 vscode 扩展端清空，让 IDE 壳静态注册唯一来源
                violations.push({
                    file: manifestPath,
                    rule: '③',
                    msg: `qqq publisher 也不应在 vscode 扩展 manifest 重复贡献 qqq-ai.* 视图（铁律 §13：唯一来源 = IDE 壳静态）`
                });
            }
        }
    }
}

// ─────── ④ IDE 壳源码 registerViewContainer(..., AuxiliaryBar) 调用扫描 ───────
//
// 注意：vscode 引擎本身大量使用 ViewContainerLocation.AuxiliaryBar 做 switch/case、enum 比较、布局判断、
// 事件分发，这些都是合法用途。本卡口只拦截真正「新增 AuxiliaryBar 容器」的注册调用：
//   registerViewContainer({...}, ViewContainerLocation.AuxiliaryBar, ...)
// 唯一允许的注册位置 = qqq-ide-src/src/vs/qqq/aux/qqqAuxContribution.ts。

// 多行匹配 registerViewContainer(... ViewContainerLocation.AuxiliaryBar 的调用形态
const REGISTER_AUX_PATTERN = /registerViewContainer\s*\([\s\S]{0,800}?ViewContainerLocation\s*\.\s*AuxiliaryBar/;

function* walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else yield full;
    }
}

function scanIdeShell(violations, hits) {
    if (!fs.existsSync(IDE_SHELL_SRC)) return;
    for (const f of walk(IDE_SHELL_SRC)) {
        // 豁免：vs/qqq/aux/ 是铁律 §13 唯一真理点
        if (f.startsWith(IDE_SHELL_AUX_EXEMPT + path.sep) || f === IDE_SHELL_AUX_EXEMPT) continue;
        if (!/\.(ts|js|tsx|jsx|mts|cts)$/.test(f)) continue;
        let txt;
        try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (!REGISTER_AUX_PATTERN.test(txt)) continue;
        hits.push(f);
        violations.push({
            file: f,
            rule: '④',
            msg: `检测到 registerViewContainer(..., ViewContainerLocation.AuxiliaryBar) 调用出现在 vs/qqq/aux/ 之外（铁律 §13：唯一来源 = qqqAuxContribution.ts）`
        });
    }
}

// ─────── 主流程 ───────

function findManifests(absRoot, fileNames) {
    const out = [];
    if (!fs.existsSync(absRoot)) return out;
    for (const f of walk(absRoot)) {
        const base = path.basename(f);
        if (fileNames.has(base)) out.push(f);
    }
    return out;
}

function main() {
    const listOnly = process.argv.includes('--list');
    const violations = [];
    const ideHits = [];
    const manifestFiles = [];

    // 收集所有 package.json + gaea.json
    for (const sub of SCAN_DIRS) {
        const abs = path.join(ROOT, sub);
        const found = findManifests(abs, new Set(['package.json', 'gaea.json']));
        manifestFiles.push(...found);
    }

    for (const m of manifestFiles) scanManifest(m, violations);
    scanIdeShell(violations, ideHits);

    if (listOnly) {
        console.log('# scanned manifests (' + manifestFiles.length + ')');
        for (const m of manifestFiles) console.log('  ' + path.relative(ROOT, m));
        console.log('# IDE shell hits with ViewContainerLocation.AuxiliaryBar (' + ideHits.length + ')');
        for (const h of ideHits) console.log('  ' + path.relative(ROOT, h));
        console.log('# violations (' + violations.length + ')');
        for (const v of violations) console.log('  ✗ [' + v.rule + '] ' + path.relative(ROOT, v.file) + ' — ' + v.msg);
        process.exit(0);
    }

    if (violations.length) {
        console.error('[lint-no-foreign-aux] FAIL — 违反铁律 §13（qqq AI × AuxiliaryBar 永久绑定）');
        for (const v of violations) {
            console.error('  ✗ [' + v.rule + '] ' + path.relative(ROOT, v.file));
            console.error('       ' + v.msg);
        }
        console.error('');
        console.error('  唯一真理点：qqq-ide-src/src/vs/qqq/aux/qqqAuxContribution.ts');
        console.error('  铁律：       ignore/qqq 拓扑/arc/铁律 §13');
        console.error('  落地说明：   ignore/qqq 拓扑/arc/我们到底要做什吗 §6');
        process.exit(1);
    }
    console.log('[lint-no-foreign-aux] OK — 扫描了 ' + manifestFiles.length + ' 份 manifest，IDE 壳无外部 AuxiliaryBar 注册，0 violations');
    process.exit(0);
}

main();

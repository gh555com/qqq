#!/usr/bin/env node
/**
 * lint-gaea-locations — CI grep 卡口（铁律 §14 ⑧ + §14 ⑩）
 *
 * 铁律 §14：gaea 侧边 + GaeaPanel 是平行子系统，唯一注册入口为
 *   IGaeaPanelService.registerApp（壳层）/ ctx.registerGaeaApp（gaea 模块）。
 *
 * 拒绝以下违规：
 *   ① package.json / gaea.json 出现 contributes.viewsContainers.gaeaPanel*（任何位置）
 *   ② IDE 壳层 vs/qqq/gaea/ 之外的源码 import 'vs/qqq/gaea/gaeaPanelService' 后调用 registerApp
 *      （目前未启用：service 是 DI singleton，外部只能通过 ctx.registerGaeaApp）
 *   ③ ViewContainerLocation 不应被扩展声明为 'gaeapanel*'（仅 IDE 壳合法定义）
 *
 * 与 §13 卡口的边界：
 *   - §13 lint 只看 AuxiliaryBar（qqq AI 锁定）
 *   - §14 lint 只看 gaea panel 注册（旁路检测）
 *   两套独立运行，不冲突。
 *
 * 用法：
 *   node scripts/lint-gaea-locations.js          # 违规即 exit 1
 *   node scripts/lint-gaea-locations.js --list   # 仅打印命中清单
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');     // 仓库根
const Q3_ROOT = path.resolve(__dirname, '..');

const SCAN_DIRS = ['q3', 'qqq-modules', 'qqq-ide-src/extensions'];
const SKIP_DIRS = new Set([
	'node_modules', '.git', 'dist', '.dist', 'out', '.build', 'test', 'tests',
	'VSCode-win32-x64'
]);

// 仅 IDE 壳的 vs/qqq/gaea/ 目录可以注册 GaeaPanel（铁律 §14 ⑧）
const IDE_SHELL_GAEA_EXEMPT = path.resolve(ROOT, 'qqq-ide-src', 'src', 'vs', 'qqq', 'gaea');
// vs/qqq/loader/gaeaContext.ts 是受信任的代理路径（gaea 模块通过它访问 service）
const IDE_SHELL_LOADER_EXEMPT = path.resolve(ROOT, 'qqq-ide-src', 'src', 'vs', 'qqq', 'loader');

// 命令行
const argMode = process.argv[2] === '--list' ? 'list' : 'enforce';

// ─── 扫描器 ────────────────────────────────────────────────────────────

function* walkFiles(dir, predicate) {
	if (!fs.existsSync(dir)) { return; }
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) { continue; }
			yield* walkFiles(full, predicate);
		} else if (entry.isFile() && predicate(entry.name, full)) {
			yield full;
		}
	}
}

function findManifests() {
	const out = [];
	for (const sub of SCAN_DIRS) {
		const base = path.join(ROOT, sub);
		for (const f of walkFiles(base, n => n === 'package.json' || n === 'gaea.json')) {
			out.push(f);
		}
	}
	return out;
}

function findShellSources() {
	const out = [];
	const base = path.join(ROOT, 'qqq-ide-src', 'src', 'vs');
	for (const f of walkFiles(base, n => n.endsWith('.ts'))) {
		out.push(f);
	}
	return out;
}

// ─── 违规检测 ──────────────────────────────────────────────────────────

const violations = [];

function record(file, rule, msg) {
	violations.push({ file: path.relative(ROOT, file), rule, msg });
}

// ① manifest 禁贡献 viewsContainers.gaeaPanel*
function checkRule1(manifestPath) {
	let json;
	try { json = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return; }
	const containers = json?.contributes?.viewsContainers;
	if (!containers || typeof containers !== 'object') { return; }
	for (const loc of Object.keys(containers)) {
		if (/^gaeaPanel/i.test(loc)) {
			record(manifestPath, '①',
				`manifest 不得声明 contributes.viewsContainers.${loc}（gaea panel 唯一入口为 ctx.registerGaeaApp，铁律 §14 ⑧）`);
		}
	}
}

// ③ 扩展不得自定义 'gaeapanel*' 作为 ViewContainerLocation 字符串字面量
function checkRule3(manifestPath) {
	let raw;
	try { raw = fs.readFileSync(manifestPath, 'utf8'); } catch { return; }
	if (/"location"\s*:\s*"gaeaPanel(Primary|Secondary)?"/i.test(raw)) {
		record(manifestPath, '③',
			`manifest 出现非法 ViewContainerLocation 字面量 'gaeaPanel*'（仅 IDE 壳合法）`);
	}
}

// ② IDE 壳源码：vs/qqq/gaea/ 之外不得调用 registerApp
function checkRule2(srcPath) {
	if (srcPath.startsWith(IDE_SHELL_GAEA_EXEMPT)) { return; }   // 豁免 vs/qqq/gaea/
	if (srcPath.startsWith(IDE_SHELL_LOADER_EXEMPT)) { return; } // 豁免 GaeaContext 代理
	let raw;
	try { raw = fs.readFileSync(srcPath, 'utf8'); } catch { return; }
	// 只关心壳层是否绕过 GaeaContext 直接调 service.registerApp
	const importMatch = /from\s+['"]vs\/qqq\/gaea\/gaeaPanelService['"]/.test(raw);
	const callMatch = /\.registerApp\s*\(/.test(raw);
	if (importMatch && callMatch) {
		// 进一步排除：只有 service 自身定义里的 registerApp（实现签名）
		if (/class\s+GaeaPanelService\b/.test(raw)) { return; }
		record(srcPath, '②',
			`vs/qqq/gaea/ 之外的 IDE 壳源码不得直接调用 GaeaPanelService.registerApp（请用 ctx.registerGaeaApp，铁律 §14 ⑧）`);
	}
}

// ─── 主流程 ────────────────────────────────────────────────────────────

const manifests = findManifests();
for (const m of manifests) {
	checkRule1(m);
	checkRule3(m);
}
const shellSrcs = findShellSources();
for (const s of shellSrcs) {
	checkRule2(s);
}

// ─── 产出 ──────────────────────────────────────────────────────────────

if (argMode === 'list') {
	console.log(`Scanned: ${manifests.length} manifests + ${shellSrcs.length} shell sources`);
	console.log(`Violations: ${violations.length}`);
	for (const v of violations) {
		console.log(`  [${v.rule}] ${v.file}`);
		console.log(`        ${v.msg}`);
	}
	process.exit(0);
}

if (violations.length === 0) {
	console.log(`[lint-gaea-locations] ${manifests.length} manifests + ${shellSrcs.length} shell sources scanned, 0 violations.`);
	process.exit(0);
}

console.error(`[lint-gaea-locations] FAILED: ${violations.length} violation(s)\n`);
for (const v of violations) {
	console.error(`  [Rule ${v.rule}] ${v.file}`);
	console.error(`        ${v.msg}\n`);
}
console.error('See 「网络拓扑」铁律 §14 / 「我们到底要做什吗」§6.5 for the full contract.');
process.exit(1);

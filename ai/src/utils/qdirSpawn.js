/**
 * qdirSpawn — 绿色框架反卡死任务执行的统一 JS 入口
 * ============================================================
 * 协议规范：ignore/qqq 拓扑/arc/spawn-protocol（唯一真理源）
 * 硬约束 ：ignore/qqq 拓扑/arc/铁律 §12
 * 设计动机：ignore/qqq 拓扑/arc/我们到底要做什吗 §2.5
 *
 * 调用者必须经此入口；裸 child_process.spawn / exec / execSync
 * 调外部 .exe 由 CI grep 卡口（.github/workflows/lint.yml）拦死。
 *
 * 实现者优先级：
 *   1. QDIR_GHRUN 指向的 ghrun.exe（生产路径，Rust 实现）
 *   2. scripts/runner.py（开发期 / CI / ghrun 未编译时的兜底，Python）
 *   3. 都没有 → throw（绝不裸 spawn 兜底，避免协议被绕开）
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/* eslint-disable no-restricted-syntax */
/* 本文件是协议唯一允许 child_process.spawn 的位置；CI grep 卡口对此 glob 放行 */

// ────────────────────────────────────────────────────────────────────
// 实现者发现
// ────────────────────────────────────────────────────────────────────

function _detectGhrun() {
    const p = process.env.QDIR_GHRUN;
    if (p && fs.existsSync(p)) return p;
    const qdir = process.env.QDIR;
    if (qdir) {
        const guess = path.join(qdir, 'f', process.platform === 'win32' ? 'ghrun.exe' : 'ghrun');
        if (fs.existsSync(guess)) return guess;
    }
    return null;
}

function _detectRunner() {
    // 优先环境变量；其次按本文件相对位置推断仓库根
    const env = process.env.QDIR_RUNNER_PY;
    if (env && fs.existsSync(env)) return env;
    // ai/src/utils/qdirSpawn.js → ../../../scripts/runner.py
    const guess = path.resolve(__dirname, '..', '..', '..', 'scripts', 'runner.py');
    if (fs.existsSync(guess)) return guess;
    return null;
}

function _detectPython() {
    const env = process.env.QDIR_PYTHON || process.env.PYTHON;
    if (env && fs.existsSync(env)) return env;
    // 绿色 Portable Python 优先
    const candidates = process.platform === 'win32'
        ? [
            path.join(process.env.QDIR_COMPONENTS || '', 'python', 'python.exe'),
            'E:\\s\\d\\python3810\\python.exe',
            'python.exe',
            'python',
        ]
        : ['/usr/bin/python3', 'python3', 'python'];
    for (const c of candidates) {
        if (!c) continue;
        if (c.includes(path.sep) && fs.existsSync(c)) return c;
        if (!c.includes(path.sep)) return c; // 交给 PATH 解析
    }
    return 'python3';
}

function _resolveImpl() {
    const ghrun = _detectGhrun();
    if (ghrun) return { kind: 'ghrun', exe: ghrun, args: [] };
    const py = _detectRunner();
    if (py) return { kind: 'runner', exe: _detectPython(), args: [py] };
    throw new Error(
        '[qdirSpawn] no impl found: neither ghrun.exe nor scripts/runner.py is reachable. ' +
        'Set QDIR_GHRUN or QDIR_RUNNER_PY, or build ghrun. ' +
        'See arc/spawn-protocol §1.'
    );
}

// ────────────────────────────────────────────────────────────────────
// 选项校验
// ────────────────────────────────────────────────────────────────────

function _validate(opts) {
    if (!opts || typeof opts !== 'object') throw new Error('[qdirSpawn] opts required');
    if (!opts.task || typeof opts.task !== 'string') {
        throw new Error('[qdirSpawn] opts.task (string) required');
    }
    if (!Array.isArray(opts.cmd) || opts.cmd.length === 0) {
        throw new Error('[qdirSpawn] opts.cmd (non-empty string[]) required');
    }
    if (opts.shell) {
        // 协议 §3：shell 慎用。允许但打 warn
        // eslint-disable-next-line no-console
        console.warn('[qdirSpawn] WARN shell=true — see arc/铁律 §12 ⑤');
    }
    if (typeof opts.deadline !== 'number') opts.deadline = 600;
    if (typeof opts.stall !== 'number') opts.stall = 30;
    return opts;
}

// ────────────────────────────────────────────────────────────────────
// 主入口
// ────────────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {string}   opts.task      必填，唯一任务 id（推荐 `<feature>-<hash4>`）
 * @param {string[]} opts.cmd       必填，命令及参数数组
 * @param {number}  [opts.deadline] 绝对超时秒，默认 600；0 = 不启用
 * @param {number}  [opts.stall]    日志静默判死秒，默认 30；0 = 不启用
 * @param {string}  [opts.log]      日志路径；缺省 = QDIR_LOGS/spawn-<task>.log
 * @param {string}  [opts.cwd]      工作目录；缺省 = 当前
 * @param {object}  [opts.env]      追加环境变量（KEY-VAL 对象）
 * @param {boolean} [opts.shell]    透传 shell；默认 false（强烈建议保持）
 * @param {function}[opts.onStdout] 行级回调（实时观测，非必需）
 * @returns {Promise<object>}       brief：{ task_id, pid, status, exit_code, reason, duration_ms, log, lock }
 */
function qdirSpawn(opts) {
    _validate(opts);
    const impl = _resolveImpl();

    const cliArgs = [...impl.args, 'spawn',
        '--task', opts.task,
        '--deadline', String(opts.deadline),
        '--stall', String(opts.stall),
    ];
    if (opts.log) cliArgs.push('--log', opts.log);
    if (opts.cwd) cliArgs.push('--cwd', opts.cwd);
    if (opts.env && typeof opts.env === 'object') {
        for (const [k, v] of Object.entries(opts.env)) {
            cliArgs.push('--env', `${k}=${v}`);
        }
    }
    if (opts.shell) cliArgs.push('--shell');
    cliArgs.push('--', ...opts.cmd);

    return new Promise((resolveBrief, rejectBrief) => {
        // 子进程的 stdin 接 NUL 由 runner.py / ghrun 自身处理；我们只关心收 brief。
        const child = spawn(impl.exe, cliArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let outBuf = '';
        let errBuf = '';
        const onLine = typeof opts.onStdout === 'function' ? opts.onStdout : null;

        child.stdout.on('data', (chunk) => {
            const s = chunk.toString('utf8');
            outBuf += s;
            if (onLine) {
                let idx;
                while ((idx = outBuf.indexOf('\n')) >= 0) {
                    const line = outBuf.slice(0, idx);
                    outBuf = outBuf.slice(idx + 1);
                    try { onLine(line); } catch (_) { /* swallow */ }
                }
            }
        });
        child.stderr.on('data', (chunk) => { errBuf += chunk.toString('utf8'); });

        child.on('error', (err) => {
            rejectBrief(new Error(`[qdirSpawn] impl spawn failed: ${err.message}`));
        });

        child.on('close', (code) => {
            // 协议 §5：末行 JSON 即 brief
            const lines = (outBuf + (onLine ? '' : '')).trim().split(/\r?\n/);
            const last = lines[lines.length - 1] || '';
            try {
                const brief = JSON.parse(last);
                resolveBrief(brief);
            } catch (e) {
                rejectBrief(new Error(
                    `[qdirSpawn] cannot parse brief; impl=${impl.kind} code=${code}\n` +
                    `last_line=${last.slice(0, 200)}\n` +
                    `stderr=${errBuf.slice(0, 500)}`
                ));
            }
        });
    });
}

/**
 * 终止一个进行中的任务。
 */
function qdirKill(taskId) {
    const impl = _resolveImpl();
    return new Promise((resolveOk) => {
        const child = spawn(impl.exe, [...impl.args, 'kill', taskId], {
            stdio: 'ignore', windowsHide: true,
        });
        child.on('close', (code) => resolveOk(code === 0));
        child.on('error', () => resolveOk(false));
    });
}

/**
 * 列出当前所有 lock。返回 lock JSON 数组（含 alive 字段）。
 */
function qdirList() {
    const impl = _resolveImpl();
    return new Promise((resolveList, rejectList) => {
        const child = spawn(impl.exe, [...impl.args, 'list'], {
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        let buf = '';
        child.stdout.on('data', (c) => { buf += c.toString('utf8'); });
        child.on('close', () => {
            try { resolveList(JSON.parse(buf || '[]')); }
            catch (e) { rejectList(new Error(`[qdirSpawn] list parse: ${e.message}`)); }
        });
        child.on('error', rejectList);
    });
}

/**
 * 清理孤儿 lock。返回 { cleaned: <int> }。
 */
function qdirReap() {
    const impl = _resolveImpl();
    return new Promise((resolveReap, rejectReap) => {
        const child = spawn(impl.exe, [...impl.args, 'reap'], {
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
        let buf = '';
        child.stdout.on('data', (c) => { buf += c.toString('utf8'); });
        child.on('close', () => {
            try { resolveReap(JSON.parse(buf || '{}')); }
            catch (e) { rejectReap(new Error(`[qdirSpawn] reap parse: ${e.message}`)); }
        });
        child.on('error', rejectReap);
    });
}

module.exports = {
    qdirSpawn,
    qdirKill,
    qdirList,
    qdirReap,
    // 协议常量
    PROTO_VERSION: '1.0',
    EXIT_DEADLINE: 124,
    EXIT_STALL: 125,
    EXIT_SIGINT: 130,
    EXIT_SPAWN_FAIL: 201,
};

/**
 * ★ QVEnv - 环境管理模块
 * 负责 Python、yt-dlp 及所有依赖的下载、安装、检测
 * 从 dow.js 迁移而来，提供统一的环境管理接口
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");
const { q } = require("./i18n");

let vscode = null;
try { vscode = require("vscode"); } catch { }

// ============================================================================
// ★ Python 引擎下载器
// ============================================================================

class PythonEngineDownloader {
    constructor(options = {}) {
        this.pythonPath = options.pythonPath || null;
        this._installInProgress = false;
        this._installTimer = null;
        // ★ "从无到有" 回调：当 Python 环境从无到有时触发
        this._onPythonReady = null;
        // ★ L1 "已知不完美" 状态缓存
        this._l1KnownImperfect = false;
        this._l1ImperfectReason = null;
        this._l1ImperfectMissing = [];
        // ★ 已解析的 Python 路径
        this._resolvedPath = null;
    }

    /**
     * 注册 "从无到有" 回调
     * @param {Function} callback - 当 Python 环境从无到有时调用
     */
    onPythonReady(callback) {
        this._onPythonReady = callback;
    }

    /**
     * ★ 查询 L1 是否已知不完美
     * @returns {Object} - { imperfect: boolean, reason: string|null, missing: string[] }
     */
    getL1ImperfectStatus() {
        return {
            imperfect: this._l1KnownImperfect,
            reason: this._l1ImperfectReason,
            missing: this._l1ImperfectMissing
        };
    }

    /**
     * ★ 清除 L1 不完美缓存（当环境变化时调用）
     */
    clearL1ImperfectCache() {
        this._l1KnownImperfect = false;
        this._l1ImperfectReason = null;
        this._l1ImperfectMissing = [];
    }

    /**
     * 读取上次安装时间戳（globalState）
     */
    _readState(context) {
        try {
            // ★ 先读主 key，如果为 0 则读备份 key
            let ts = context.globalState.get('pythonInstallTimestamp', 0);
            if (!ts) {
                ts = context.globalState.get('python_cooldown_ts', 0);
            }
            return { installTimestamp: ts || 0 };
        } catch (e) {
            console.error('[PythonCheck] _readState error:', e.message);
        }
        return { installTimestamp: 0 };
    }

    /**
     * 保存安装时间戳（globalState）
     */
    _saveState(context, state) {
        try {
            // ★ 关键：globalState.update 是异步的，但这里不需要等待
            // 因为 VS Code 会在内部队列处理，只要调用就会生效
            context.globalState.update('pythonInstallTimestamp', state.installTimestamp);
            // ★ 同时写入一个备份 key，确保写入成功
            context.globalState.update('python_cooldown_ts', state.installTimestamp);
        } catch (e) {
            console.error('[PythonCheck] _saveState error:', e.message);
        }
    }

    /**
     * 检查是否在 72 小时冷却期内
     */
    _isInCooldown(context) {
        const COOLDOWN_MS = 259200000; // 72 小时
        const state = this._readState(context);
        const now = Date.now();
        return (now - state.installTimestamp) < COOLDOWN_MS;
    }

    /**
     * 检查冷却期剩余时间
     */
    _getCooldownStatus(context) {
        const COOLDOWN_MS = 259200000; // 72 小时
        const state = this._readState(context);
        const now = Date.now();
        const elapsed = now - state.installTimestamp;
        const remainingMs = Math.max(0, COOLDOWN_MS - elapsed);

        return {
            inCooldown: remainingMs > 0,
            remainingHours: Math.floor(remainingMs / 3600000),
            remainingMinutes: Math.floor((remainingMs % 3600000) / 60000),
            remainingMs
        };
    }

    /**
     * 依赖名到导入名的映射
     */
    _getImportName(dep) {
        const importMap = {
            'Pillow': 'PIL',
            'pywin32': 'win32api'
        };
        return importMap[dep] || dep;
    }

    /**
     * 获取锁定版本的依赖列表
     * ★ 版本锁定：pywin32==311, Pillow==10.4.0, miniaudio==1.61, cffi==1.16.0, pycparser==2.22
     */
    _getLockedDeps() {
        const baseDeps = [
            'miniaudio==1.61',
            'Pillow==10.4.0',
            'cffi==1.16.0',
            'pycparser==2.22'
        ];
        // Windows 专属依赖：pywin32==311（不跑 postinstall）
        return process.platform === 'win32'
            ? [...baseDeps, 'pywin32==311']
            : baseDeps;
    }

    /**
     * 获取依赖检测列表（不带版本号）
     */
    _getDepsForCheck() {
        const baseDeps = ['miniaudio', 'Pillow'];
        return process.platform === 'win32'
            ? [...baseDeps, 'pywin32']
            : baseDeps;
    }

    /**
     * ★ 获取必需依赖（不包括可选的 Pillow）
     * Pillow 在 Embed 版中容易因缺少 msvcp140.dll 而失败
     */
    _getRequiredDeps() {
        const baseDeps = ['miniaudio'];
        return process.platform === 'win32'
            ? [...baseDeps, 'pywin32']
            : baseDeps;
    }

    /**
     * ★ 获取可选依赖
     */
    _getOptionalDeps() {
        return ['Pillow'];
    }

    /**
     * ★ 获取需要的 VC++ 运行时 DLL 列表
     * Pillow 10.4.0 依赖这些 DLL
     */
    _getRequiredVCDlls() {
        return [
            'msvcp140.dll',      // 核心：Pillow 必需
            'vcruntime140.dll',  // 核心：C 运行时
            'vcruntime140_1.dll' // x64 专属
        ];
    }

    /**
     * ★ 复制 VC++ 运行时 DLL 到 Python 引擎目录
     * @param {Object} context - VS Code 扩展上下文
     * @param {string} installDir - Python 引擎安装目录
     * @returns {Object} - { success: boolean, copied: string[], missing: string[] }
     */
    _copyVCRuntimeDlls(context, installDir) {
        if (process.platform !== 'win32') {
            return { success: true, copied: [], missing: [], skipped: 'not_windows' };
        }

        const arch = process.arch === 'x64' ? 'x64' : 'x86';
        const runtimesDir = path.join(context.extensionPath, 'assets', 'runtimes', arch);

        const copied = [];
        const missing = [];
        const alreadyExists = [];

        // 所有可用的 DLL
        const allDlls = [
            'msvcp140.dll',
            'msvcp140_1.dll',
            'msvcp140_2.dll',
            'vcruntime140.dll',
            'vcruntime140_1.dll',
            'concrt140.dll',
            'vccorlib140.dll'
        ];

        for (const dll of allDlls) {
            const srcPath = path.join(runtimesDir, dll);
            const dstPath = path.join(installDir, dll);

            try {
                // 已存在则跳过
                if (fs.existsSync(dstPath)) {
                    alreadyExists.push(dll);
                    continue;
                }

                // 源文件存在则复制
                if (fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, dstPath);
                    copied.push(dll);
                } else {
                    // x86 没有 vcruntime140_1.dll，不算 missing
                    if (dll === 'vcruntime140_1.dll' && arch === 'x86') continue;
                    missing.push(dll);
                }
            } catch (e) {
                missing.push(dll);
            }
        }

        return {
            success: missing.length === 0 || missing.every(d => !this._getRequiredVCDlls().includes(d)),
            copied,
            missing,
            alreadyExists
        };
    }

    /**
     * ★ 检查 VC++ 运行时 DLL 是否存在
     * @param {string} installDir - Python 引擎安装目录
     * @returns {Object} - { ok: boolean, missing: string[] }
     */
    _checkVCRuntimeDlls(installDir) {
        if (process.platform !== 'win32') {
            return { ok: true, missing: [] };
        }

        const requiredDlls = this._getRequiredVCDlls();
        const missing = [];

        for (const dll of requiredDlls) {
            const dllPath = path.join(installDir, dll);
            // x86 没有 vcruntime140_1.dll
            if (dll === 'vcruntime140_1.dll' && process.arch !== 'x64') continue;
            if (!fs.existsSync(dllPath)) {
                missing.push(dll);
            }
        }

        return {
            ok: missing.length === 0,
            missing
        };
    }

    /**
     * 快速检测依赖是否存在
     * ★ 关键：区分必需和可选依赖
     */
    async checkDeps(pythonBin) {
        const { spawnSync } = require("child_process");
        const allDeps = this._getDepsForCheck();
        const requiredDeps = this._getRequiredDeps();
        const optionalDeps = this._getOptionalDeps();

        const checkScript = allDeps.map(dep => {
            const importName = this._getImportName(dep);
            return `
try:
    import ${importName}
    print('${dep}:1')
except:
    print('${dep}:0')`;
        }).join('\n');

        const fullScript = `
import sys
${checkScript}
sys.exit(0)
`.trim();

        try {
            const r = spawnSync(pythonBin, ["-c", fullScript], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 15000,
                // ★ 关键：禁用弹窗，防止 Pillow 缺少 DLL 时弹窗
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const stdout = r.stdout || '';
            const detail = {};
            const missing = [];
            const missingRequired = [];
            const missingOptional = [];

            for (const dep of allDeps) {
                const pattern = new RegExp(`${dep}:(\\d+)`);
                const match = stdout.match(pattern);
                const hasDep = match && match[1] === '1';
                detail[dep] = hasDep;

                if (!hasDep) {
                    missing.push(dep);
                    if (requiredDeps.includes(dep)) {
                        missingRequired.push(dep);
                    } else if (optionalDeps.includes(dep)) {
                        missingOptional.push(dep);
                    }
                }
            }

            // ★ 关键：只要必需依赖完整，就认为 hasAll=true
            return {
                hasAll: missingRequired.length === 0,
                missing: missingRequired,  // 只返回必需的缺失
                missingOptional,  // 可选的缺失
                detail
            };
        } catch (e) {
            return {
                hasAll: false,
                missing: requiredDeps,
                missingOptional: optionalDeps,
                detail: {},
                error: e.message
            };
        }
    }

    /**
     * 检查 Python 解释器是否可用（简化版，不检查版本范围）
     */
    async isAvailable(pythonBin = null) {
        const bin = pythonBin || this.pythonPath;
        if (!bin) return false;
        try {
            const fs = require('fs');
            const path = require('path');
            if (path.isAbsolute(bin) && !fs.existsSync(bin)) return false;

            const { spawnSync } = require("child_process");
            const checkScript = `import sys; sys.stdout.write(f'PYTHON_READY|EXE:{sys.executable}')`;

            const r = spawnSync(bin, ["-c", checkScript], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 10000,
                cwd: path.isAbsolute(bin) ? path.dirname(bin) : undefined
            });

            if (r.status === 0 && (r.stdout || "").includes("PYTHON_READY")) {
                const exeMatch = (r.stdout || "").match(/EXE:([^|]+)/);
                if (exeMatch) this._resolvedPath = exeMatch[1];
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * ★ L1 完美性检查：解释器存在 + 依赖完整 + VC++ DLL 存在才算完美
     * @returns {Object} - { perfect: boolean, pythonPath: string|null, missing: string[] }
     */
    async checkL1Perfect(context) {
        const path = require('path');
        const fs = require('fs');

        // ★ 辅助函数：记录不完美状态
        const markImperfect = (reason, missing = []) => {
            this._l1KnownImperfect = true;
            this._l1ImperfectReason = reason;
            this._l1ImperfectMissing = missing;
        };

        if (!context || !context.globalStorageUri) {
            markImperfect('no_context');
            return { perfect: false, pythonPath: null, missing: [], reason: 'no_context' };
        }

        const installDir = path.join(context.globalStorageUri.fsPath, "python_engine");
        const binName = process.platform === "win32" ? "python.exe" : "bin/python3";
        const pythonPath = path.join(installDir, binName);

        // 1. 检查解释器是否存在
        if (!fs.existsSync(pythonPath)) {
            markImperfect('no_interpreter');
            return { perfect: false, pythonPath: null, missing: [], reason: 'no_interpreter' };
        }

        // 2. 检查解释器是否可用
        if (!await this.isAvailable(pythonPath)) {
            markImperfect('interpreter_invalid');
            return { perfect: false, pythonPath, missing: [], reason: 'interpreter_invalid' };
        }

        // 3. ★ 检查并自动复制 VC++ 运行时 DLL（Windows 专属）
        // ★ 关键：DLL 缺失不阻塞启动，只是尝试复制并记录
        let missingDlls = [];
        if (process.platform === 'win32' && context.extensionPath) {
            const dllCheck = this._checkVCRuntimeDlls(installDir);
            if (!dllCheck.ok) {
                // 尝试自动复制 DLL
                const copyResult = this._copyVCRuntimeDlls(context, installDir);
                if (copyResult.copied.length > 0) {
                    const global = require('./global');
                    global.logMessage(q('qvenv.vcppDllCopy', copyResult.copied.join(', ')), 'INFO');
                }
                // 再次检查，但不阻塞
                const recheckDll = this._checkVCRuntimeDlls(installDir);
                if (!recheckDll.ok) {
                    missingDlls = recheckDll.missing;
                    const global = require('./global');
                    global.logMessage(q('qvenv.vcppDllMissing', missingDlls.join(', ')), 'WARN');
                    // ★ 不返回，继续检查依赖
                }
            }
        }

        // 4. 检查依赖是否完整
        const depsResult = await this.checkDeps(pythonPath);
        if (!depsResult.hasAll) {
            markImperfect('deps_missing', depsResult.missing);
            return {
                perfect: false,
                pythonPath,
                missing: depsResult.missing,
                missingOptional: depsResult.missingOptional || [],
                missingDlls,
                reason: 'deps_missing'
            };
        }

        // ★ 记录可选依赖的状态（Pillow 静默失败不阻塞）
        const missingOptional = depsResult.missingOptional || [];
        if (missingOptional.length > 0) {
            const global = require('./global');
            global.logMessage(q('qvenv.optionalDepsMissing', missingOptional.join(', ')), 'INFO');
        }

        // 完美！清除不完美缓存
        this.clearL1ImperfectCache();
        this.pythonPath = pythonPath;
        return {
            perfect: true,
            pythonPath,
            missing: [],
            missingOptional: missingOptional,
            missingDlls,  // ★ 记录但不阻塞
            reason: 'ok'
        };
    }

    /**
     * ★ Python 精简器 - 激进版
     * 策略：不动 python38.zip，删除所有不需要的文件
     * 预期释放：~20MB+
     */
    async _slimPython(installDir, pythonBin) {
        const global = require('./global');
        const os = require('os');

        if (os.platform() !== 'win32') return;

        let totalSaved = 0;

        // ★ 步骤1：删除不需要的 .pyd 文件（C 扩展模块）
        const unneededPyd = [
            '_sqlite3.pyd',      // SQLite 数据库 (~1MB)
            '_tkinter.pyd',      // GUI
            '_testcapi.pyd',     // 测试
            '_testbuffer.pyd',   // 测试
            '_testconsole.pyd',  // 测试
            '_testimportmultiple.pyd', // 测试
            '_testmultiphase.pyd', // 测试
            'winsound.pyd',      // Windows 声音（我们用 miniaudio）
            '_msi.pyd',          // MSI 安装包
            '_distutils_findvs.pyd', // VS 查找
            '_lzma.pyd',         // LZMA 压缩
            '_bz2.pyd',          // BZ2 压缩
            '_decimal.pyd',      // 高精度小数
            'pyexpat.pyd',       // XML 解析
            '_elementtree.pyd',  // XML 解析
        ];

        for (const pyd of unneededPyd) {
            const p = path.join(installDir, pyd);
            try {
                if (fs.existsSync(p)) {
                    const sz = fs.statSync(p).size;
                    fs.unlinkSync(p);
                    totalSaved += sz;
                }
            } catch { }
        }

        // ★ 步骤2：删除不需要的大文件和 DLL
        const unneededFiles = [
            'python.cat',        // 签名目录 (~500KB)
            'LICENSE.txt',       // 许可证
            'NEWS.txt',          // 新闻
            'sqlite3.dll',       // SQLite DLL (~1.5MB)
        ];

        for (const f of unneededFiles) {
            const p = path.join(installDir, f);
            try {
                if (fs.existsSync(p)) {
                    const sz = fs.statSync(p).size;
                    fs.unlinkSync(p);
                    totalSaved += sz;
                }
            } catch { }
        }

        // ★ 步骤3：删除不需要的目录
        const unneededDirs = [
            'Scripts',           // pip 脚本目录 (~432KB)
            'Lib',               // 解压出来的库（如果存在）
        ];

        for (const d of unneededDirs) {
            const p = path.join(installDir, d);
            try {
                if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
                    totalSaved += this._getDirSize(p);
                    this._rmDir(p);
                }
            } catch { }
        }

        // ★ 步骤4：深度清理 site-packages
        const siteDir = path.join(installDir, 'site-packages');
        if (fs.existsSync(siteDir)) {
            totalSaved += this._deepCleanSitePackages(siteDir);
        }

        const savedMB = totalSaved / 1024 / 1024;
        if (savedMB > 0.1) {
            global.logMessage(q('qvenv.slimComplete', savedMB.toFixed(1)), 'INFO');
        }
    }

    /**
     * ★ 深度清理 site-packages
     * 删除 pip/setuptools/wheel + pywin32 垃圾 + 文档/测试
     */
    _deepCleanSitePackages(siteDir) {
        let saved = 0;

        // ★ 删除 pip/setuptools/wheel 相关（安装完不再需要）
        const pipRelated = [
            'pip', '_pip', 'pip-*',
            'setuptools', 'pkg_resources', '_distutils_hack',
            'wheel', 'distutils-precedence.pth',
        ];

        // ★ 删除 pywin32 不需要的组件
        const pywin32Junk = [
            'pythonwin',         // GUI 编辑器 (~9.3MB)
            'PyWin32.chm',       // 帮助文件 (~2.6MB)
            'isapi',             // IIS 扩展 (~177KB)
            'adodbapi',          // 数据库 ADO (~162KB)
            'win32comext',       // COM 扩展 (~2.8MB)，测试后可考虑保留
        ];

        const toDelete = [...pipRelated, ...pywin32Junk];

        try {
            const items = fs.readdirSync(siteDir, { withFileTypes: true });

            for (const item of items) {
                const p = path.join(siteDir, item.name);
                const name = item.name.toLowerCase();

                // 删除指定的目录/文件
                const shouldDelete = toDelete.some(pattern => {
                    if (pattern.endsWith('*')) {
                        return name.startsWith(pattern.slice(0, -1).toLowerCase());
                    }
                    return name === pattern.toLowerCase() || name === pattern.toLowerCase() + '.py';
                });

                if (shouldDelete) {
                    if (item.isDirectory()) {
                        saved += this._getDirSize(p);
                        this._rmDir(p);
                    } else {
                        saved += fs.statSync(p).size;
                        fs.unlinkSync(p);
                    }
                    continue;
                }

                // 删除 .dist-info 和 .egg-info 目录
                if (item.isDirectory() && (name.endsWith('.dist-info') || name.endsWith('.egg-info'))) {
                    saved += this._getDirSize(p);
                    this._rmDir(p);
                    continue;
                }

                // 递归清理子目录
                if (item.isDirectory()) {
                    saved += this._cleanPackageDir(p);
                }
            }
        } catch { }

        return saved;
    }

    /**
     * 清理单个包目录（深度清理版）
     */
    _cleanPackageDir(dir) {
        let saved = 0;

        // ★ 要删除的目录名
        const junkDirs = [
            '__pycache__',
            'tests', 'test', 'testing',
            'docs', 'doc', 'documentation',
            'examples', 'example', 'samples',
            'benchmarks', 'benchmark',
            '.git', '.github', '.svn',
        ];

        // ★ 要删除的文件名/扩展名
        const junkFiles = [
            '.pyc', '.pyo', '.pyd.lib', '.pdb',
            '.md', '.rst', '.txt', '.html',
            '.yml', '.yaml', '.toml', '.cfg', '.ini',
            'LICENSE', 'COPYING', 'AUTHORS', 'CONTRIBUTORS',
            'CHANGELOG', 'CHANGES', 'HISTORY', 'NEWS',
            'README', 'MANIFEST.in', 'setup.py', 'setup.cfg',
            'pyproject.toml', 'tox.ini', 'pytest.ini',
            '.coveragerc', '.flake8', '.pylintrc',
        ];

        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });

            for (const item of items) {
                const p = path.join(dir, item.name);
                const nameLower = item.name.toLowerCase();

                // 删除垃圾目录
                if (item.isDirectory() && junkDirs.includes(nameLower)) {
                    saved += this._getDirSize(p);
                    this._rmDir(p);
                    continue;
                }

                // 删除垃圾文件
                if (item.isFile()) {
                    const shouldDelete = junkFiles.some(pattern => {
                        if (pattern.startsWith('.')) {
                            return nameLower.endsWith(pattern);
                        }
                        return nameLower === pattern.toLowerCase() ||
                            nameLower.startsWith(pattern.toLowerCase() + '.');
                    });

                    if (shouldDelete) {
                        saved += fs.statSync(p).size;
                        fs.unlinkSync(p);
                        continue;
                    }
                }

                // 递归清理子目录
                if (item.isDirectory()) {
                    saved += this._cleanPackageDir(p);
                }
            }
        } catch { }

        return saved;
    }

    _getDirSize(dir) {
        let total = 0;
        try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const it of items) {
                const p = path.join(dir, it.name);
                if (it.isDirectory()) total += this._getDirSize(p);
                else total += fs.statSync(p).size;
            }
        } catch { }
        return total;
    }

    _rmDir(dir) {
        try {
            if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
            else {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const it of items) {
                    const p = path.join(dir, it.name);
                    it.isDirectory() ? this._rmDir(p) : fs.unlinkSync(p);
                }
                fs.rmdirSync(dir);
            }
        } catch { }
    }

    /**
     * ★ 完整的 Python 自动安装流程
     * 包含下载、解压、pip 安装、pywin32 配置、精简
     */
    async autoInstall(context) {
        const global = require('./global');

        try {
            const os = require('os');
            const https = require('https');
            const cp = require('child_process');

            const platform = os.platform();
            const arch = os.arch();
            const installDir = path.join(context.globalStorageUri.fsPath, "python_engine");
            const zipPath = path.join(context.globalStorageUri.fsPath, "python_3.8.10.tmp");
            const binName = platform === "win32" ? "python.exe" : "bin/python3";
            const installPath = path.join(installDir, binName);

            if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });

            // 平台检测
            let officialUrl, mirrorUrl;
            const releaseDate = '20230507';
            const pyVersion = '3.8.10';

            if (platform === 'win32') {
                if (arch === 'x64' || arch === 'arm64') {
                    officialUrl = `https://www.python.org/ftp/python/${pyVersion}/python-${pyVersion}-embed-amd64.zip`;
                    mirrorUrl = `https://registry.npmmirror.com/-/binary/python/${pyVersion}/python-${pyVersion}-embed-amd64.zip`;
                } else {
                    officialUrl = `https://www.python.org/ftp/python/${pyVersion}/python-${pyVersion}-embed-win32.zip`;
                    mirrorUrl = `https://registry.npmmirror.com/-/binary/python/${pyVersion}/python-${pyVersion}-embed-win32.zip`;
                }
            } else if (platform === 'darwin') {
                const archSuffix = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
                officialUrl = `https://github.com/indygreg/python-build-standalone/releases/download/${releaseDate}/cpython-${pyVersion}+${releaseDate}-${archSuffix}-install_only.tar.gz`;
                mirrorUrl = `https://ghproxy.net/https://github.com/indygreg/python-build-standalone/releases/download/${releaseDate}/cpython-${pyVersion}+${releaseDate}-${archSuffix}-install_only.tar.gz`;
            } else {
                const archSuffix = arch === 'arm64' ? 'aarch64' : (arch === 'arm' ? 'armv7' : 'x86_64');
                const gnuSuffix = arch === 'arm' ? 'gnueabihf' : 'gnu';
                officialUrl = `https://github.com/indygreg/python-build-standalone/releases/download/${releaseDate}/cpython-${pyVersion}+${releaseDate}-${archSuffix}-unknown-linux-${gnuSuffix}-install_only.tar.gz`;
                mirrorUrl = officialUrl.replace('https://github.com/', 'https://ghproxy.net/https://github.com/');
            }

            global.logMessage(q('qvenv.platformArch', platform, arch, officialUrl), "INFO");

            // 下载函数
            const downloadFile = (url, targetPath, timeoutMs = 30000) => {
                return new Promise((resolve, reject) => {
                    const doReq = (targetUrl, redirects = 0) => {
                        if (redirects > 5) return reject(new Error("Too many redirects"));
                        const urlObj = new URL(targetUrl);
                        const req = https.get({
                            hostname: urlObj.hostname,
                            path: urlObj.pathname + urlObj.search,
                            timeout: timeoutMs,
                            headers: { 'User-Agent': 'Mozilla/5.0' }
                        }, (res) => {
                            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                                res.resume();
                                return doReq(new URL(res.headers.location, targetUrl).href, redirects + 1);
                            }
                            if (res.statusCode !== 200) {
                                res.resume();
                                return reject(new Error(`Status: ${res.statusCode}`));
                            }
                            const file = fs.createWriteStream(targetPath);
                            res.pipe(file);
                            file.on('finish', () => { file.close(); resolve(); });
                            file.on('error', (e) => { fs.unlink(targetPath, () => { }); reject(e); });
                        });
                        req.on('error', reject);
                        req.on('timeout', () => { req.destroy(); reject(new Error("Timeout")); });
                    };
                    doReq(url);
                });
            };

            // 级联下载
            const downloadUrls = platform === 'win32'
                ? [{ url: mirrorUrl, timeout: 30000, name: '淘宝NPM' }, { url: officialUrl, timeout: 30000, name: '官方' }]
                : [{ url: officialUrl, timeout: 15000, name: '官方' }, { url: mirrorUrl, timeout: 60000, name: 'ghproxy' }];

            for (const { url, timeout, name } of downloadUrls) {
                try {
                    global.logMessage(q('qvenv.trySource', name), "INFO");
                    await downloadFile(url, zipPath, timeout);
                    global.logMessage(q('qvenv.sourceSuccess', name), "INFO");
                    break;
                } catch (e) {
                    global.logMessage(q('qvenv.sourceFailed', name, e.message), "WARN");
                    if (url === downloadUrls[downloadUrls.length - 1].url) {
                        throw new Error(`所有源均失败: ${e.message}`);
                    }
                }
            }

            // 解压
            if (platform === 'win32') {
                cp.execSync(`tar -xf "${zipPath}" -C "${installDir}"`, { windowsHide: true });
                // 修复 ._pth
                const pthFile = path.join(installDir, 'python38._pth');
                if (fs.existsSync(pthFile)) {
                    let content = fs.readFileSync(pthFile, 'utf8');
                    content = content.replace('#import site', 'import site');
                    if (!content.includes('site-packages')) content += '\n./site-packages\n';
                    if (!content.includes('./Lib')) content = './Lib\n' + content;
                    fs.writeFileSync(pthFile, content);
                }
            } else {
                cp.execSync(`tar -xzf "${zipPath}" -C "${installDir}" --strip-components=1`, { windowsHide: true });
            }
            fs.unlinkSync(zipPath);

            if (!await this.isAvailable(installPath)) {
                return { success: false, error: "解压后验证失败" };
            }

            this.pythonPath = installPath;
            const sitePackagesDir = path.join(installDir, 'site-packages');
            if (!fs.existsSync(sitePackagesDir)) fs.mkdirSync(sitePackagesDir, { recursive: true });

            // 安装 pip (Windows embed)
            if (platform === 'win32') {
                global.logMessage(q('qvenv.installPip'), 'INFO');
                const getPipPath = path.join(installDir, 'get-pip.py');
                await new Promise((resolve, reject) => {
                    const downloadGetPip = (url, redirectCount = 0) => {
                        if (redirectCount > 5) return reject(new Error('重定向过多'));
                        const urlObj = new URL(url);
                        https.get({
                            hostname: urlObj.hostname,
                            path: urlObj.pathname,
                            headers: { 'User-Agent': 'Mozilla/5.0' }
                        }, (res) => {
                            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                                res.resume();
                                downloadGetPip(new URL(res.headers.location, url).href, redirectCount + 1);
                                return;
                            }
                            if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
                            const file = fs.createWriteStream(getPipPath);
                            res.pipe(file);
                            file.on('finish', () => { file.close(); resolve(); });
                            file.on('error', reject);
                        }).on('error', reject);
                    };
                    downloadGetPip('https://bootstrap.pypa.io/pip/3.8/get-pip.py');
                });

                cp.execSync(`"${installPath}" "${getPipPath}"`, {
                    windowsHide: true,
                    timeout: 120000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env, PYTHONNOUSERSITE: '1' }
                });
                try { fs.unlinkSync(getPipPath); } catch { }
            }

            // 安装依赖
            const lockedDeps = this._getLockedDeps();
            global.logMessage(q('qvenv.installDeps', lockedDeps.join(', ')), 'INFO');
            const pipCmd = `"${installPath}" -m pip install ${lockedDeps.join(' ')} --upgrade --force-reinstall --quiet --target="${sitePackagesDir}" --index-url https://mirrors.aliyun.com/pypi/simple/`;
            cp.execSync(pipCmd, {
                windowsHide: true,
                timeout: 300000,
                env: { ...process.env, PYTHONNOUSERSITE: '1' }
            });

            // ★ 最聪明的调用时机：依赖安装完成后，pywin32配置之前
            // 原因：此时包已完整，但还未被使用，删除最安全
            global.logMessage(q('qvenv.startSlim'), 'INFO');
            await this._slimPython(installDir, installPath);

            // pywin32 配置
            if (platform === 'win32') {
                const pywin32System32 = path.join(sitePackagesDir, 'pywin32_system32');
                if (fs.existsSync(pywin32System32)) {
                    const dlls = fs.readdirSync(pywin32System32).filter(f => f.endsWith('.dll'));
                    for (const dll of dlls) {
                        fs.copyFileSync(path.join(pywin32System32, dll), path.join(installDir, dll));
                    }
                    const sitecustomizeCode = `# Auto-generated pywin32 fix
import sys, os
site_packages = os.path.dirname(__file__)
for p in [os.path.join(site_packages, 'win32'), os.path.join(site_packages, 'win32', 'lib'), os.path.join(site_packages, 'Pythonwin')]:
    if os.path.isdir(p) and p not in sys.path: sys.path.insert(0, p)
`;
                    fs.writeFileSync(path.join(sitePackagesDir, 'sitecustomize.py'), sitecustomizeCode, 'utf8');
                    global.logMessage(q('qvenv.pywin32Done'), 'INFO');
                }

                // ★ 复制 VC++ 运行时 DLL（Pillow 依赖）
                if (context.extensionPath) {
                    const copyResult = this._copyVCRuntimeDlls(context, installDir);
                    if (copyResult.copied.length > 0) {
                        global.logMessage(q('qvenv.copyVcDll', copyResult.copied.join(', ')), 'INFO');
                    }
                }
            }

            // 保存状态
            this._saveState(context, { installTimestamp: Date.now() });
            this.clearL1ImperfectCache();

            return { success: true, path: installPath, fromScratch: true };
        } catch (e) {
            this._saveState(context, { installTimestamp: Date.now() });
            global.logMessage(q('qvenv.installFailed', e.message), 'ERROR');
            return { success: false, error: e.message };
        }
    }
}

// ============================================================================
// ★ 导出（只导出 Python 相关）
// ============================================================================

module.exports = {
    PythonEngineDownloader
};

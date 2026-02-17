/**
* ★ QVEnv - Environment Management Module
* Responsible for downloading, installing, and checking Python, yt-dlp, and all dependencies
* Migrated from dow.js, providing a unified environment management interface
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
// ★ Python Engine Downloader
// ============================================================================

class PythonEngineDownloader {
    constructor(options = {}) {
        this.pythonPath = options.pythonPath || null;
        this._installInProgress = false;
        this._installTimer = null;
        // ★ "From scratch" callback: triggered when Python environment goes from absent to present
        this._onPythonReady = null;
        // ★ L1 "known imperfect" status cache
        this._l1KnownImperfect = false;
        this._l1ImperfectReason = null;
        this._l1ImperfectMissing = [];
        // ★ Resolved Python path
        this._resolvedPath = null;
    }

    /**
     * Register "from scratch" callback
     * @param {Function} callback - Called when Python environment goes from absent to present
     */
    onPythonReady(callback) {
        this._onPythonReady = callback;
    }

    /**
     * ★ Query whether L1 is known imperfect
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
     * ★ Clear L1 imperfect cache (call when environment changes)
     */
    clearL1ImperfectCache() {
        this._l1KnownImperfect = false;
        this._l1ImperfectReason = null;
        this._l1ImperfectMissing = [];
    }

    /**
     * Read last install timestamp (globalState)
     */
    _readState(context) {
        try {
            // ★ First read primary key; if 0 then read backup key
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
     * Save install timestamp (globalState)
     */
    _saveState(context, state) {
        try {
            // ★ Key: globalState.update is async, but no need to await here
            // Because VS Code processes it in an internal queue; calling it is enough
            context.globalState.update('pythonInstallTimestamp', state.installTimestamp);
            // ★ Also write a backup key to ensure persistence
            context.globalState.update('python_cooldown_ts', state.installTimestamp);
        } catch (e) {
            console.error('[PythonCheck] _saveState error:', e.message);
        }
    }

    /**
     * Check whether within 72-hour cooldown
     */
    _isInCooldown(context) {
        const COOLDOWN_MS = 259200000; // 72 hours
        const state = this._readState(context);
        const now = Date.now();
        return (now - state.installTimestamp) < COOLDOWN_MS;
    }

    /**
     * Check remaining cooldown time
     */
    _getCooldownStatus(context) {
        const COOLDOWN_MS = 259200000; // 72 hours
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
     * Mapping from dependency name to import name
     */
    _getImportName(dep) {
        const importMap = {
            'Pillow': 'PIL',
            'pywin32': 'win32api'
        };
        return importMap[dep] || dep;
    }

    /**
     * Get locked-version dependency list
     * ★ Version lock: pywin32==311, Pillow==10.4.0, miniaudio==1.61, cffi==1.16.0, pycparser==2.22
     */
    _getLockedDeps() {
        const baseDeps = [
            'miniaudio==1.61',
            'Pillow==10.4.0',
            'cffi==1.16.0',
            'pycparser==2.22'
        ];
        // Windows-only dependency: pywin32==311 (no postinstall)
        return process.platform === 'win32'
            ? [...baseDeps, 'pywin32==311']
            : baseDeps;
    }

    /**
     * Get dependency check list (without versions)
     */
    _getDepsForCheck() {
        const baseDeps = ['miniaudio', 'Pillow'];
        return process.platform === 'win32'
            ? [...baseDeps, 'pywin32']
            : baseDeps;
    }

    /**
     * ★ Get required dependencies (excluding optional Pillow)
     * Pillow in embed builds can easily fail due to missing msvcp140.dll
     */
    _getRequiredDeps() {
        const baseDeps = ['miniaudio'];
        return process.platform === 'win32'
            ? [...baseDeps, 'pywin32']
            : baseDeps;
    }

    /**
     * ★ Get optional dependencies
     */
    _getOptionalDeps() {
        return ['Pillow'];
    }

    /**
     * ★ Get required VC++ runtime DLL list
     * Pillow 10.4.0 depends on these DLLs
     */
    _getRequiredVCDlls() {
        return [
            'msvcp140.dll',      // Core: required by Pillow
            'vcruntime140.dll',  // Core: C runtime
            'vcruntime140_1.dll' // x64-only
        ];
    }

    /**
     * ★ Copy VC++ runtime DLLs to Python engine directory
     * @param {Object} context - VS Code extension context
     * @param {string} installDir - Python engine install directory
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

        // All available DLLs
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
                // If already exists, skip
                if (fs.existsSync(dstPath)) {
                    alreadyExists.push(dll);
                    continue;
                }

                // Copy if source exists
                if (fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, dstPath);
                    copied.push(dll);
                } else {
                    // x86 doesn't have vcruntime140_1.dll, not considered missing
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
     * ★ Check whether VC++ runtime DLLs exist
     * @param {string} installDir - Python engine install directory
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
            // x86 doesn't have vcruntime140_1.dll
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
     * Quick check whether dependencies exist
     * ★ Key: distinguish required vs optional dependencies
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
                // ★ Key: disable popup to prevent popup when Pillow is missing DLLs
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

            // ★ Key: as long as required deps are complete, treat hasAll=true
            return {
                hasAll: missingRequired.length === 0,
                missing: missingRequired,  // Only return missing required deps
                missingOptional,  // Missing optional deps
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
     * Check whether Python interpreter is available (simplified, no version range check)
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
     * ★ L1 perfection check: interpreter exists + dependencies complete + VC++ DLLs exist => perfect
     * @returns {Object} - { perfect: boolean, pythonPath: string|null, missing: string[] }
     */
    async checkL1Perfect(context) {
        const path = require('path');
        const fs = require('fs');

        // ★ Helper: record imperfect status
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

        // 1. Check whether interpreter exists
        if (!fs.existsSync(pythonPath)) {
            markImperfect('no_interpreter');
            return { perfect: false, pythonPath: null, missing: [], reason: 'no_interpreter' };
        }

        // 2. Check whether interpreter is usable
        if (!await this.isAvailable(pythonPath)) {
            markImperfect('interpreter_invalid');
            return { perfect: false, pythonPath, missing: [], reason: 'interpreter_invalid' };
        }

        // 3. ★ Check and auto-copy VC++ runtime DLLs (Windows only)
        // ★ Key: missing DLLs do not block startup; only attempt to copy and record
        let missingDlls = [];
        if (process.platform === 'win32' && context.extensionPath) {
            const dllCheck = this._checkVCRuntimeDlls(installDir);
            if (!dllCheck.ok) {
                // Try auto-copy DLLs
                const copyResult = this._copyVCRuntimeDlls(context, installDir);
                if (copyResult.copied.length > 0) {
                    const global = require('./global');
                    global.logMessage(q('qvenv.vcppDllCopy', copyResult.copied.join(', ')), 'INFO');
                }
                // Recheck, but do not block
                const recheckDll = this._checkVCRuntimeDlls(installDir);
                if (!recheckDll.ok) {
                    missingDlls = recheckDll.missing;
                    const global = require('./global');
                    global.logMessage(q('qvenv.vcppDllMissing', missingDlls.join(', ')), 'WARN');
                    // ★ Do not return; continue checking dependencies
                }
            }
        }

        // 4. Check whether dependencies are complete
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

        // ★ Record optional dependency status (Pillow silent failure does not block)
        const missingOptional = depsResult.missingOptional || [];
        if (missingOptional.length > 0) {
            const global = require('./global');
            global.logMessage(q('qvenv.optionalDepsMissing', missingOptional.join(', ')), 'INFO');
        }

        // Perfect! Clear imperfect cache
        this.clearL1ImperfectCache();
        this.pythonPath = pythonPath;
        return {
            perfect: true,
            pythonPath,
            missing: [],
            missingOptional: missingOptional,
            missingDlls,  // ★ Record but do not block
            reason: 'ok'
        };
    }

    /**
     * ★ Python Slimmer - Aggressive Version
     * Strategy: do not touch python38.zip; delete all unnecessary files
     * Expected savings: ~20MB+
     */
    async _slimPython(installDir, pythonBin) {
        const global = require('./global');
        const os = require('os');

        if (os.platform() !== 'win32') return;

        let totalSaved = 0;

        // ★ Step 1: delete unneeded .pyd files (C extension modules)
        const unneededPyd = [
            '_sqlite3.pyd',      // SQLite database (~1MB)
            '_tkinter.pyd',      // GUI
            '_testcapi.pyd',     // tests
            '_testbuffer.pyd',   // tests
            '_testconsole.pyd',  // tests
            '_testimportmultiple.pyd', // tests
            '_testmultiphase.pyd', // tests
            'winsound.pyd',      // Windows sound (we use miniaudio)
            '_msi.pyd',          // MSI installer
            '_distutils_findvs.pyd', // VS finder
            '_lzma.pyd',         // LZMA compression
            '_bz2.pyd',          // BZ2 compression
            '_decimal.pyd',      // high-precision decimal
            'pyexpat.pyd',       // XML parser
            '_elementtree.pyd',  // XML parser
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

        // ★ Step 2: delete unneeded large files and DLLs
        const unneededFiles = [
            'python.cat',        // signature catalog (~500KB)
            'LICENSE.txt',       // license
            'NEWS.txt',          // news
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

        // ★ Step 3: delete unneeded directories
        const unneededDirs = [
            'Scripts',           // pip scripts directory (~432KB)
            'Lib',               // extracted libraries (if any)
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

        // ★ Step 4: deep clean site-packages
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
     * ★ Deep clean site-packages
     * Delete pip/setuptools/wheel + pywin32 junk + docs/tests
     */
    _deepCleanSitePackages(siteDir) {
        let saved = 0;

        // ★ Delete pip/setuptools/wheel related (not needed after install)
        const pipRelated = [
            'pip', '_pip', 'pip-*',
            'setuptools', 'pkg_resources', '_distutils_hack',
            'wheel', 'distutils-precedence.pth',
        ];

        // ★ Delete unneeded pywin32 components
        const pywin32Junk = [
            'pythonwin',         // GUI editor (~9.3MB)
            'PyWin32.chm',       // help file (~2.6MB)
            'isapi',             // IIS extension (~177KB)
            'adodbapi',          // ADO database (~162KB)
            'win32comext',       // COM extensions (~2.8MB), consider keeping after testing
        ];

        const toDelete = [...pipRelated, ...pywin32Junk];

        try {
            const items = fs.readdirSync(siteDir, { withFileTypes: true });

            for (const item of items) {
                const p = path.join(siteDir, item.name);
                const name = item.name.toLowerCase();

                // Delete specified directories/files
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

                // Delete .dist-info and .egg-info directories
                if (item.isDirectory() && (name.endsWith('.dist-info') || name.endsWith('.egg-info'))) {
                    saved += this._getDirSize(p);
                    this._rmDir(p);
                    continue;
                }

                // Recursively clean subdirectories
                if (item.isDirectory()) {
                    saved += this._cleanPackageDir(p);
                }
            }
        } catch { }

        return saved;
    }

    /**
     * Clean a single package directory (deep clean version)
     */
    _cleanPackageDir(dir) {
        let saved = 0;

        // ★ Directory names to delete
        const junkDirs = [
            '__pycache__',
            'tests', 'test', 'testing',
            'docs', 'doc', 'documentation',
            'examples', 'example', 'samples',
            'benchmarks', 'benchmark',
            '.git', '.github', '.svn',
        ];

        // ★ File names/extensions to delete
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

                // Delete junk directories
                if (item.isDirectory() && junkDirs.includes(nameLower)) {
                    saved += this._getDirSize(p);
                    this._rmDir(p);
                    continue;
                }

                // Delete junk files
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

                // Recursively clean subdirectories
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
     * ★ Full Python auto-install workflow
     * Includes download, extract, pip install, pywin32 config, slimming
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
            // ★ Win7 fix: Shell.Application.NameSpace() only works with .zip extension
            const zipPath = path.join(context.globalStorageUri.fsPath, "python_3.8.10.zip");
            const binName = platform === "win32" ? "python.exe" : "bin/python3";
            const installPath = path.join(installDir, binName);

            if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });

            // Platform detection
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

            // Download function
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

            // Cascading download
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
                        throw new Error(q('qvenv.allSourcesFailed', e.message));
                    }
                }
            }

            // Extract
            if (platform === 'win32') {
                // ★ Win7 兼容解压: 三级回退策略
                // 1. .NET 4.5 ZipFile (最可靠，适用于 Win7 SP1 + .NET 4.5+)
                // 2. Shell.Application COM (适用于所有 Windows，但路径必须用反斜杠且扩展名必须是 .zip)
                // 3. tar (仅 Win10+)
                const zipPathWin = zipPath.replace(/\//g, '\\\\');
                const installDirWin = installDir.replace(/\//g, '\\\\');

                // Method 1: .NET ZipFile (PowerShell 2.0 + .NET 4.5+)
                const dotnetScript = `
                    Add-Type -AssemblyName System.IO.Compression.FileSystem;
                    [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPathWin}', '${installDirWin}');
                `;

                // Method 2: Shell.Application COM (Win7 兼容，需要反斜杠路径)
                const comScript = `
                    $shell = New-Object -ComObject Shell.Application;
                    $zip = $shell.NameSpace('${zipPathWin}');
                    $dest = $shell.NameSpace('${installDirWin}');
                    if ($zip -eq $null) { throw 'Cannot open zip file' };
                    if ($dest -eq $null) { throw 'Cannot open dest folder' };
                    $dest.CopyHere($zip.Items(), 16);
                `;

                let extractSuccess = false;
                let lastError = '';

                // Try .NET ZipFile first
                try {
                    cp.execSync(`powershell -NoProfile -Command "${dotnetScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
                        { windowsHide: true, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
                    extractSuccess = true;
                } catch (e1) {
                    lastError = `.NET=${e1.message}`;
                    // Try Shell.Application COM
                    try {
                        cp.execSync(`powershell -NoProfile -Command "${comScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
                            { windowsHide: true, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
                        extractSuccess = true;
                    } catch (e2) {
                        lastError += `, COM=${e2.message}`;
                        // Try tar (Win10+ only)
                        try {
                            cp.execSync(`tar -xf "${zipPath}" -C "${installDir}"`, { windowsHide: true });
                            extractSuccess = true;
                        } catch (e3) {
                            lastError += `, tar=${e3.message}`;
                        }
                    }
                }

                if (!extractSuccess) {
                    throw new Error(`Extract failed: ${lastError}`);
                }

                // Fix ._pth
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
                return { success: false, error: q('qvenv.extractVerifyFailed') };
            }

            this.pythonPath = installPath;
            const sitePackagesDir = path.join(installDir, 'site-packages');
            if (!fs.existsSync(sitePackagesDir)) fs.mkdirSync(sitePackagesDir, { recursive: true });

            // Install pip (Windows embed)
            if (platform === 'win32') {
                global.logMessage(q('qvenv.installPip'), 'INFO');
                const getPipPath = path.join(installDir, 'get-pip.py');
                await new Promise((resolve, reject) => {
                    const downloadGetPip = (url, redirectCount = 0) => {
                        if (redirectCount > 5) return reject(new Error(q('qvenv.tooManyRedirects')));
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

                cp.execSync(`"${installPath}" "${getPipPath}" --index-url https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com`, {
                    windowsHide: true,
                    timeout: 120000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    // ★ 绕过代理，避免 ProxyError
                    env: { ...process.env, PYTHONNOUSERSITE: '1', NO_PROXY: '*', http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' }
                });
                try { fs.unlinkSync(getPipPath); } catch { }
            }

            // Install dependencies
            const lockedDeps = this._getLockedDeps();
            global.logMessage(q('qvenv.installDeps', lockedDeps.join(', ')), 'INFO');
            const pipCmd = `"${installPath}" -m pip install ${lockedDeps.join(' ')} --upgrade --force-reinstall --quiet --target="${sitePackagesDir}" --index-url https://mirrors.aliyun.com/pypi/simple/`;
            cp.execSync(pipCmd, {
                windowsHide: true,
                timeout: 300000,
                // ★ 绕过代理，避免 ProxyError
                env: { ...process.env, PYTHONNOUSERSITE: '1', NO_PROXY: '*', http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' }
            });

            // ★ Smartest invocation timing: after deps install, before pywin32 config
            // Reason: packages are complete but not yet used; deletion is safest
            global.logMessage(q('qvenv.startSlim'), 'INFO');
            await this._slimPython(installDir, installPath);

            // pywin32 configuration
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

                // ★ Copy VC++ runtime DLLs (Pillow dependency)
                if (context.extensionPath) {
                    const copyResult = this._copyVCRuntimeDlls(context, installDir);
                    if (copyResult.copied.length > 0) {
                        global.logMessage(q('qvenv.copyVcDll', copyResult.copied.join(', ')), 'INFO');
                    }
                }
            }

            // Save state
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
// ★ Export (Python-related only)
// ============================================================================

module.exports = {
    PythonEngineDownloader
};



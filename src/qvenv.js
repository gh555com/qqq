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
// ★ Cross-process Install Marker (atomic, prevents multi-window race)
// ============================================================================

/**
 * Try to acquire install marker atomically (no waiting, instant return)
 * Uses OS-level O_EXCL to guarantee only one process wins
 * @param {string} markerPath - Path to marker file
 * @param {number} staleMs - Marker expires after this (default 5 min)
 * @returns {{acquired: boolean, release: Function}}
 */
function tryAcquireMarker(markerPath, staleMs = 300000) {
    // Ensure directory exists
    const dir = path.dirname(markerPath);
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
    }

    // Clean stale marker
    try {
        const st = fs.statSync(markerPath);
        if (Date.now() - st.mtimeMs > staleMs) {
            fs.unlinkSync(markerPath);
        }
    } catch { /* doesn't exist, good */ }

    // Atomic exclusive create
    try {
        const fd = fs.openSync(markerPath, "wx");
        fs.writeFileSync(fd, `${process.pid}\n${Date.now()}`, "utf8");
        fs.closeSync(fd);
        return {
            acquired: true,
            release: () => { try { fs.unlinkSync(markerPath); } catch { } }
        };
    } catch (e) {
        if (e.code === "EEXIST") {
            return { acquired: false, release: () => {} };
        }
        // Other errors - proceed anyway
        return { acquired: true, release: () => {} };
    }
}

/**
 * Check if install is in progress (marker exists and not stale)
 * @param {string} markerPath - Path to marker file
 * @param {number} staleMs - Marker expires after this
 * @returns {boolean}
 */
function isMarkerActive(markerPath, staleMs = 300000) {
    try {
        const st = fs.statSync(markerPath);
        return Date.now() - st.mtimeMs < staleMs;
    } catch {
        return false;
    }
}

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
            // ★ Read attempt count (3-chance system)
            let attemptCount = context.globalState.get('pythonInstallAttemptCount', 0);
            return { installTimestamp: ts || 0, attemptCount: attemptCount || 0 };
        } catch (e) {
            console.error('[PythonCheck] _readState error:', e.message);
        }
        return { installTimestamp: 0, attemptCount: 0 };
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
            // ★ Persist attempt count (3-chance system)
            if (state.attemptCount !== undefined) {
                context.globalState.update('pythonInstallAttemptCount', state.attemptCount);
            }
        } catch (e) {
            console.error('[PythonCheck] _saveState error:', e.message);
        }
    }

    /**
     * ★ Maximum independent attempts before cooldown
     */
    static get MAX_ATTEMPTS() { return 3; }

    /**
     * Check whether within 72-hour cooldown
     * ★ 3-chance system: only enters cooldown after MAX_ATTEMPTS independent tries
     * ★ When cooldown expires, attempt counter auto-resets (new 3 chances)
     */
    _isInCooldown(context) {
        const COOLDOWN_MS = 259200000; // 72 hours
        const state = this._readState(context);
        const now = Date.now();

        // ★ Haven't used all 3 chances yet → not in cooldown
        if (state.attemptCount < PythonEngineDownloader.MAX_ATTEMPTS) {
            return false;
        }

        // ★ All 3 chances used, check if 72h has passed
        const inCooldown = (now - state.installTimestamp) < COOLDOWN_MS;
        if (!inCooldown && state.attemptCount >= PythonEngineDownloader.MAX_ATTEMPTS) {
            // ★ Cooldown expired → reset counter, grant new 3 chances
            this._saveState(context, { installTimestamp: 0, attemptCount: 0 });
        }
        return inCooldown;
    }

    /**
     * Check remaining cooldown time
     */
    _getCooldownStatus(context) {
        const COOLDOWN_MS = 259200000; // 72 hours
        const state = this._readState(context);
        const now = Date.now();
        const maxAttempts = PythonEngineDownloader.MAX_ATTEMPTS;
        const remainingAttempts = Math.max(0, maxAttempts - state.attemptCount);

        // ★ Still have remaining chances → not in cooldown
        if (state.attemptCount < maxAttempts) {
            return {
                inCooldown: false,
                remainingHours: 0,
                remainingMinutes: 0,
                remainingMs: 0,
                attemptCount: state.attemptCount,
                maxAttempts,
                remainingAttempts
            };
        }

        // ★ All chances exhausted, calculate cooldown remaining
        const elapsed = now - state.installTimestamp;
        const remainingMs = Math.max(0, COOLDOWN_MS - elapsed);

        // ★ Cooldown expired → reset and grant new chances
        if (remainingMs === 0) {
            this._saveState(context, { installTimestamp: 0, attemptCount: 0 });
            return {
                inCooldown: false,
                remainingHours: 0,
                remainingMinutes: 0,
                remainingMs: 0,
                attemptCount: 0,
                maxAttempts,
                remainingAttempts: maxAttempts
            };
        }

        return {
            inCooldown: true,
            remainingHours: Math.floor(remainingMs / 3600000),
            remainingMinutes: Math.floor((remainingMs % 3600000) / 60000),
            remainingMs,
            attemptCount: state.attemptCount,
            maxAttempts,
            remainingAttempts: 0
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
     * ★ Version lock: pywin32==311, Pillow==10.4.0, miniaudio==1.61, cffi==1.16.0, pycparser==2.22, pynput==1.7.7
     */
    _getLockedDeps() {
        const baseDeps = [
            'miniaudio==1.61',
            'Pillow==10.4.0',
            'cffi==1.16.0',
            'pycparser==2.22',
            'psutil==5.9.8'   // ★ Hotkey hwnd validation
        ];
        // ★ pynput: Windows/macOS only. Linux 的 pynput 依赖 evdev 需要 clang 编译，
        //   大多数 Linux 环境没有 clang，会导致整条 pip 命令失败。
        //   kp.py 已优雅处理 _HAS_PYNPUT=False，热键非关键功能。
        if (process.platform === 'win32') {
            return [...baseDeps, 'pynput==1.7.7', 'pywin32==311'];
        } else if (process.platform === 'darwin') {
            return [...baseDeps, 'pynput==1.7.7'];
        }
        return baseDeps; // Linux: 跳过 pynput
    }

    /**
     * Get dependency check list (without versions)
     * ★ All 4 deps are REQUIRED: miniaudio, Pillow, pynput, pywin32(Windows)
     * ★ Missing ANY one = delete python_engine and reinstall from scratch
     */
    _getDepsForCheck() {
        // ★ Linux 不装 pynput (依赖 evdev 需要 clang 编译)，检查时也不能要求
        const baseDeps = process.platform === 'linux'
            ? ['miniaudio', 'Pillow', 'psutil']
            : ['miniaudio', 'Pillow', 'pynput', 'psutil'];
        return process.platform === 'win32'
            ? [...baseDeps, 'pywin32']
            : baseDeps;
    }

    /**
     * ★ Get required dependencies - ALL are required now
     * Missing any = imperfect = delete and reinstall
     */
    _getRequiredDeps() {
        const baseDeps = process.platform === 'linux'
            ? ['miniaudio', 'Pillow', 'psutil']
            : ['miniaudio', 'Pillow', 'pynput', 'psutil'];
        return process.platform === 'win32'
            ? [...baseDeps, 'pywin32']
            : baseDeps;
    }

    /**
     * ★ Get optional dependencies - none now, all are required
     */
    _getOptionalDeps() {
        return [];
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
     * ★ Also checks if installation is in progress to prevent using intermediate state
     * @returns {Object} - { perfect: boolean, pythonPath: string|null, missing: string[], reason: string }
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

        // ★ CRITICAL: Check if another window is installing
        // Prevents checking intermediate state (half-installed deps)
        const markerPath = path.join(context.globalStorageUri.fsPath, "python_installing.marker");
        if (isMarkerActive(markerPath, 300000)) {
            markImperfect('install_in_progress');
            return {
                perfect: false,
                pythonPath: null,
                missing: [],
                reason: 'install_in_progress',
                installInProgress: true  // Flag for caller to schedule retry
            };
        }

        // ★ FIX: Actively clean stale marker (process crashed without releasing)
        // If marker exists but is stale (>5min), the installer process is dead — clean it
        try {
            if (fs.existsSync(markerPath)) {
                fs.unlinkSync(markerPath);
                try {
                    const global = require('./global');
                    global.logMessage("[PythonCheck] Cleaned stale install marker (installer process likely crashed)", "WARN");
                } catch { }
            }
        } catch { }

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
     * ★ Multi-window safe: uses atomic marker to prevent concurrent installs
     */
    /**
     * ★ Nuke python_engine directory completely (for self-healing retry)
     * Retries with delay if files are locked (e.g., python.exe still running from killed pip)
     */
    _nukeInstallDir(installDir) {
        for (let i = 0; i < 3; i++) {
            try {
                if (fs.existsSync(installDir)) {
                    if (fs.rmSync) fs.rmSync(installDir, { recursive: true, force: true });
                    else this._rmDir(installDir);
                }
                if (!fs.existsSync(installDir)) break; // success
            } catch { }
            // Files might be locked — wait and retry
            if (i < 2) {
                const { spawnSync } = require('child_process');
                spawnSync(process.platform === 'win32' ? 'timeout' : 'sleep',
                    process.platform === 'win32' ? ['/t', '2', '/nobreak'] : ['2'],
                    { windowsHide: true, stdio: 'ignore' });
            }
        }
        // Also clean stale zip/tar.gz if present
        const zipGlobs = ['python_3.8.10.zip', 'python_3.10.11.tar.gz'];
        for (const zf of zipGlobs) {
            const zp = path.join(path.dirname(installDir), zf);
            try { if (fs.existsSync(zp)) fs.unlinkSync(zp); } catch { }
        }
    }

    /**
     * ★ Validate extraction result: critical files must exist
     * @returns {{ ok: boolean, missing: string[] }}
     */
    _validateExtraction(installDir, platform) {
        const criticalFiles = platform === 'win32'
            ? ['python.exe', 'python38.dll', 'python38._pth']
            : ['bin/python3'];

        const missing = [];
        for (const f of criticalFiles) {
            if (!fs.existsSync(path.join(installDir, f))) {
                missing.push(f);
            }
        }
        return { ok: missing.length === 0, missing };
    }

    /**
     * ★ Self-healing auto-install with infinite retry on download success
     *
     * Architecture ("用一万年"):
     * - Only DOWNLOAD FAILURES count toward giving up
     * - 3 consecutive download failures → give up this lifecycle
     * - Any successful download resets the failure counter → infinite retries
     * - Each retry: nuke old folder → download → validate → extract → deps
     * - Only a FULLY SUCCESSFUL install counts as one "attempt" for the cooldown system
     * - Max 30 total attempts as absolute safety cap (prevent infinite loop on weird edge cases)
     */
    async autoInstall(context) {
        const global = require('./global');

        // ★ Atomic marker to prevent multi-window concurrent installs
        const markerPath = path.join(context.globalStorageUri.fsPath, "python_installing.marker");
        const marker = tryAcquireMarker(markerPath, 300000);

        if (!marker.acquired) {
            global.logMessage("[PythonInstall] Another window is installing, skip this window", "INFO");
            return { success: false, error: 'install_in_progress', skipped: true };
        }

        let lastError = '';
        let consecutiveDownloadFailures = 0;  // ★ Only download failures count
        const MAX_DOWNLOAD_FAILURES = 3;       // ★ 3 consecutive download fails → give up
        const MAX_TOTAL_ATTEMPTS = 30;         // ★ Absolute safety cap
        let totalAttempts = 0;

        try {
            const os = require('os');
            const https = require('https');
            const cp = require('child_process');

            const platform = os.platform();
            const arch = os.arch();
            const installDir = path.join(context.globalStorageUri.fsPath, "python_engine");
            const binName = platform === "win32" ? "python.exe" : "bin/python3";
            const installPath = path.join(installDir, binName);

            // Platform detection
            // ★ Windows: python.org embed (3.8.10 available)
            // ★ Linux/macOS: python-build-standalone (20230507 release only has 3.10.11+, no 3.8.x)
            let officialUrl, mirrorUrl, cdnUrl;
            const releaseDate = '20230507';
            const pyVersionWin = '3.8.10';   // ★ Windows embed from python.org
            const pyVersionUnix = '3.10.11'; // ★ Linux/macOS from python-build-standalone
            // ★ 自有 CDN 终极兜底 (per-platform pre-built packages)
            const CDN_URLS = {
                win_x64:       'https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/GI5BAPXG6E63A.zip',
                linux_x64:     'https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/PELAJFKB5RCS4.gz',
                darwin_x64:    'https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/H5AZEMOY65W7U.gz',
                darwin_arm64:  'https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/2IHWSCEBOP3KG.gz',
            };
            const zipPath = path.join(context.globalStorageUri.fsPath, platform === 'win32' ? `python_${pyVersionWin}.zip` : `python_${pyVersionUnix}.tar.gz`);

            if (platform === 'win32') {
                if (arch === 'x64' || arch === 'arm64') {
                    officialUrl = `https://www.python.org/ftp/python/${pyVersionWin}/python-${pyVersionWin}-embed-amd64.zip`;
                    mirrorUrl = `https://registry.npmmirror.com/-/binary/python/${pyVersionWin}/python-${pyVersionWin}-embed-amd64.zip`;
                } else {
                    officialUrl = `https://www.python.org/ftp/python/${pyVersionWin}/python-${pyVersionWin}-embed-win32.zip`;
                    mirrorUrl = `https://registry.npmmirror.com/-/binary/python/${pyVersionWin}/python-${pyVersionWin}-embed-win32.zip`;
                }
                cdnUrl = CDN_URLS.win_x64;
            } else if (platform === 'darwin') {
                const archSuffix = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
                officialUrl = `https://github.com/indygreg/python-build-standalone/releases/download/${releaseDate}/cpython-${pyVersionUnix}+${releaseDate}-${archSuffix}-install_only.tar.gz`;
                mirrorUrl = `https://ghproxy.net/https://github.com/indygreg/python-build-standalone/releases/download/${releaseDate}/cpython-${pyVersionUnix}+${releaseDate}-${archSuffix}-install_only.tar.gz`;
                cdnUrl = arch === 'arm64'
                    ? CDN_URLS.darwin_arm64
                    : CDN_URLS.darwin_x64;
            } else {
                const archSuffix = arch === 'arm64' ? 'aarch64' : (arch === 'arm' ? 'armv7' : 'x86_64');
                const gnuSuffix = arch === 'arm' ? 'gnueabihf' : 'gnu';
                officialUrl = `https://github.com/indygreg/python-build-standalone/releases/download/${releaseDate}/cpython-${pyVersionUnix}+${releaseDate}-${archSuffix}-unknown-linux-${gnuSuffix}-install_only.tar.gz`;
                mirrorUrl = officialUrl.replace('https://github.com/', 'https://ghproxy.net/https://github.com/');
                cdnUrl = CDN_URLS.linux_x64;
            }

            global.logMessage(q('qvenv.platformArch', platform, arch, officialUrl), "INFO");

            // ★ Download function — returns downloaded file size for validation
            const http = require('http');
            const downloadFile = (url, targetPath, timeoutMs = 30000) => {
                return new Promise((resolve, reject) => {
                    const doReq = (targetUrl, redirects = 0) => {
                        if (redirects > 5) return reject(new Error("Too many redirects"));
                        const urlObj = new URL(targetUrl);
                        // ★ 根据协议选择 http/https 模块 (CDN 可能重定向到 HTTP)
                        const transport = urlObj.protocol === 'http:' ? http : https;
                        const req = transport.get({
                            hostname: urlObj.hostname,
                            port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
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
                            const expectedSize = parseInt(res.headers['content-length'], 10) || 0;
                            const file = fs.createWriteStream(targetPath);
                            res.pipe(file);
                            file.on('finish', () => { file.close(); resolve({ expectedSize }); });
                            file.on('error', (e) => { fs.unlink(targetPath, () => { }); reject(e); });
                        });
                        req.on('error', (e) => reject(new Error(`Network: ${e.code || e.message || 'unknown'}`)));
                        req.on('timeout', () => { req.destroy(); reject(new Error("Timeout")); });
                    };
                    doReq(url);
                });
            };

            // Cascading download URLs: ① official → ② mirror → ③ CDN (gh555.com ultimate fallback)
            const downloadUrls = platform === 'win32'
                ? [{ url: mirrorUrl, timeout: 30000, name: '淘宝NPM' }, { url: officialUrl, timeout: 30000, name: '官方' }, { url: cdnUrl, timeout: 60000, name: 'CDN', isCdn: true }]
                : [{ url: officialUrl, timeout: 15000, name: '官方' }, { url: mirrorUrl, timeout: 60000, name: 'ghproxy' }, { url: cdnUrl, timeout: 60000, name: 'CDN', isCdn: true }];
            let downloadedFromCdn = false; // ★ Track if CDN was used (Windows CDN = complete env)

            // Python embed amd64 ~7.3MB, win32 ~6.5MB, standalone tar.gz ~20MB+; anything under 5MB is corrupt
            const MIN_ZIP_SIZE = 5 * 1024 * 1024;

            // ============================================================
            // ★★★ Self-healing retry loop: infinite on download success ★★★
            // ============================================================
            while (consecutiveDownloadFailures < MAX_DOWNLOAD_FAILURES && totalAttempts < MAX_TOTAL_ATTEMPTS) {
                totalAttempts++;
                try {
                    global.logMessage(`[PythonInstall] === Round ${totalAttempts} (download fails: ${consecutiveDownloadFailures}/${MAX_DOWNLOAD_FAILURES}) ===`, "INFO");

                    // ★ Step 0: Nuke any previous bad install (clean slate)
                    if (fs.existsSync(installDir)) {
                        global.logMessage(`[PythonInstall] Nuking old python_engine for clean retry`, "INFO");
                        this._nukeInstallDir(installDir);
                    }
                    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch { }
                    fs.mkdirSync(installDir, { recursive: true });

                    // ★ Step 1: Download with cascading fallback + validation
                    let downloaded = false;
                    for (const { url, timeout, name, isCdn } of downloadUrls) {
                        try {
                            global.logMessage(q('qvenv.trySource', name), "INFO");
                            const result = await downloadFile(url, zipPath, timeout);
                            global.logMessage(q('qvenv.sourceSuccess', name), "INFO");

                            let actualSize = 0;
                            try { actualSize = fs.statSync(zipPath).size; } catch { }

                            if (actualSize < MIN_ZIP_SIZE) {
                                global.logMessage(`[PythonInstall] ⚠ Zip too small: ${(actualSize / 1024 / 1024).toFixed(1)}MB < 5MB, source=${name}`, "WARN");
                                try { fs.unlinkSync(zipPath); } catch { }
                                continue;
                            }

                            if (result.expectedSize > 0 && actualSize < result.expectedSize * 0.95) {
                                global.logMessage(`[PythonInstall] ⚠ Download truncated: got ${(actualSize / 1024 / 1024).toFixed(1)}MB, expected ${(result.expectedSize / 1024 / 1024).toFixed(1)}MB`, "WARN");
                                try { fs.unlinkSync(zipPath); } catch { }
                                continue;
                            }

                            global.logMessage(`[PythonInstall] ✓ Zip validated: ${(actualSize / 1024 / 1024).toFixed(1)}MB (source: ${name})`, "INFO");
                            downloaded = true;
                            if (isCdn) downloadedFromCdn = true;
                            break;
                        } catch (e) {
                            global.logMessage(q('qvenv.sourceFailed', name, e.message), "WARN");
                        }
                    }

                    if (!downloaded) {
                        // ★ DOWNLOAD FAILED — increment consecutive counter
                        consecutiveDownloadFailures++;
                        lastError = `All download sources failed (${consecutiveDownloadFailures}/${MAX_DOWNLOAD_FAILURES})`;
                        global.logMessage(`[PythonInstall] ⚠ ${lastError}`, "WARN");
                        // Brief delay before retry to avoid hammering servers
                        await new Promise(r => setTimeout(r, 3000 * consecutiveDownloadFailures));
                        continue;
                    }

                    // ★ DOWNLOAD SUCCEEDED — reset consecutive failure counter!
                    consecutiveDownloadFailures = 0;

                    // ★ Step 2: Extract
                    if (platform === 'win32') {
                        await global.extractZip(zipPath, installDir);
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
                        // ★ Linux/macOS: 确保 Python 二进制有执行权限
                        try {
                            const binDir = path.join(installDir, 'bin');
                            if (fs.existsSync(binDir)) {
                                for (const f of fs.readdirSync(binDir)) {
                                    try { fs.chmodSync(path.join(binDir, f), 0o755); } catch { }
                                }
                            }
                        } catch { }
                    }
                    try { fs.unlinkSync(zipPath); } catch { }

                    // ★ Step 3: Validate extraction
                    const extractionCheck = this._validateExtraction(installDir, platform);
                    if (!extractionCheck.ok) {
                        lastError = `Extraction incomplete, missing: ${extractionCheck.missing.join(', ')}`;
                        global.logMessage(`[PythonInstall] ⚠ ${lastError} — will re-download`, "WARN");
                        continue; // download was OK but extract failed → retry (download counter still 0)
                    }

                    // ★ Step 4: Verify interpreter
                    if (!await this.isAvailable(installPath)) {
                        lastError = 'Interpreter failed to execute';
                        global.logMessage(`[PythonInstall] ⚠ ${lastError} — will re-download`, "WARN");
                        continue;
                    }

                    global.logMessage(`[PythonInstall] ✓ Extraction + interpreter OK`, "INFO");
                    this.pythonPath = installPath;
                    // ★ site-packages 路径: Windows embed 用根目录，Linux/macOS standalone 用 lib/pythonX.Y/site-packages
                    let sitePackagesDir;
                    if (platform === 'win32') {
                        sitePackagesDir = path.join(installDir, 'site-packages');
                    } else {
                        // ★ Linux/macOS indygreg standalone: Python 的 sys.path 指向 lib/python3.10/site-packages
                        //   如果用 --target=根/site-packages，pip 装进去了但 import 找不到 → 死循环
                        const libDir = path.join(installDir, 'lib');
                        try {
                            const pyDirs = fs.readdirSync(libDir).filter(d => d.startsWith('python'));
                            sitePackagesDir = pyDirs.length > 0
                                ? path.join(libDir, pyDirs[0], 'site-packages')
                                : path.join(installDir, 'site-packages'); // fallback
                        } catch {
                            sitePackagesDir = path.join(installDir, 'site-packages');
                        }
                    }
                    if (!fs.existsSync(sitePackagesDir)) fs.mkdirSync(sitePackagesDir, { recursive: true });

                    // ★ CDN 兜底优化: Windows CDN 包已含完整 site-packages，跳过 pip + deps
                    if (downloadedFromCdn && platform === 'win32' && fs.existsSync(path.join(sitePackagesDir, '_miniaudio.pyd'))) {
                        global.logMessage(`[PythonInstall] ★ CDN complete package detected, skipping pip + deps install`, "INFO");
                    } else {

                    // ★ Step 5: Install pip (Windows embed)
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
                            timeout: 121000,
                            stdio: ['pipe', 'pipe', 'pipe'],
                            env: { ...process.env, PYTHONNOUSERSITE: '1', NO_PROXY: '*', http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' }
                        });
                        try { fs.unlinkSync(getPipPath); } catch { }
                    }

                    // ★ Step 6: Install dependencies
                    const lockedDeps = this._getLockedDeps();
                    global.logMessage(q('qvenv.installDeps', lockedDeps.join(', ')), 'INFO');
                    // ★ Linux/macOS: 不用 --target (standalone Python 默认 site-packages 已在 sys.path 里)
                    //   Windows embed: 必须用 --target (embed 版没有标准 site-packages 路径)
                    const pipCmd = platform === 'win32'
                        ? `"${installPath}" -m pip install ${lockedDeps.join(' ')} --upgrade --force-reinstall --quiet --target="${sitePackagesDir}" --index-url https://mirrors.aliyun.com/pypi/simple/`
                        : `"${installPath}" -m pip install ${lockedDeps.join(' ')} --upgrade --force-reinstall --quiet --index-url https://mirrors.aliyun.com/pypi/simple/`;
                    cp.execSync(pipCmd, {
                        windowsHide: true,
                        timeout: 300000,
                        env: { ...process.env, PYTHONNOUSERSITE: '1', NO_PROXY: '*', http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' }
                    });

                    // ★ Step 7: Slim + pywin32 config + VC++ DLLs
                    global.logMessage(q('qvenv.startSlim'), 'INFO');
                    await this._slimPython(installDir, installPath);

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

                        if (context.extensionPath) {
                            const copyResult = this._copyVCRuntimeDlls(context, installDir);
                            if (copyResult.copied.length > 0) {
                                global.logMessage(q('qvenv.copyVcDll', copyResult.copied.join(', ')), 'INFO');
                            }
                        }
                    }

                    } // ★ end of else (non-CDN-complete path)

                    // ★ Step 8: Final deps check — the ultimate gate
                    const finalCheck = await this.checkDeps(installPath);
                    if (!finalCheck.hasAll) {
                        lastError = `Deps check failed: missing ${finalCheck.missing.join(', ')}`;
                        global.logMessage(`[PythonInstall] ⚠ ${lastError} — will nuke and retry`, "WARN");
                        continue; // download was OK → doesn't count as download failure → retry
                    }

                    // ★★★ SUCCESS — only now count as a valid attempt ★★★
                    const currentState = this._readState(context);
                    const newAttemptCount = (currentState.attemptCount || 0) + 1;
                    const maxAttempts = PythonEngineDownloader.MAX_ATTEMPTS;

                    if (newAttemptCount >= maxAttempts) {
                        this._saveState(context, { installTimestamp: Date.now(), attemptCount: newAttemptCount });
                    } else {
                        this._saveState(context, { installTimestamp: currentState.installTimestamp, attemptCount: newAttemptCount });
                    }
                    this.clearL1ImperfectCache();

                    global.logMessage(`[PythonInstall] ✓ Install complete after ${totalAttempts} round(s)`, "INFO");
                    return { success: true, path: installPath, fromScratch: true };

                } catch (e) {
                    lastError = e.message;
                    global.logMessage(`[PythonInstall] Round ${totalAttempts} threw: ${e.message}`, "WARN");
                    this._nukeInstallDir(installDir);
                    // Download succeeded but post-download step threw → NOT a download failure → retry
                }
            }

            // ★ Loop ended: either consecutive download failures or safety cap
            const currentState = this._readState(context);
            const newAttemptCount = (currentState.attemptCount || 0) + 1;
            const maxAttempts = PythonEngineDownloader.MAX_ATTEMPTS;

            if (newAttemptCount >= maxAttempts) {
                this._saveState(context, { installTimestamp: Date.now(), attemptCount: newAttemptCount });
                global.logMessage(`[PythonInstall] All ${maxAttempts} chances used, 72h cooldown`, "WARN");
            } else {
                this._saveState(context, { installTimestamp: currentState.installTimestamp, attemptCount: newAttemptCount });
                global.logMessage(`[PythonInstall] ${newAttemptCount}/${maxAttempts} used, ${maxAttempts - newAttemptCount} left`, "WARN");
            }

            const reason = consecutiveDownloadFailures >= MAX_DOWNLOAD_FAILURES
                ? `${MAX_DOWNLOAD_FAILURES} consecutive download failures`
                : `safety cap (${MAX_TOTAL_ATTEMPTS} rounds)`;
            global.logMessage(`[PythonInstall] Giving up: ${reason}. Last error: ${lastError}`, 'ERROR');
            return { success: false, error: lastError };
        } finally {
            marker.release();
        }
    }
}

// ============================================================================
// ★ Export (Python-related only)
// ============================================================================

module.exports = {
    PythonEngineDownloader
};



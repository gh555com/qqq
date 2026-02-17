# Windows 7 Compatibility Journey

This document records the painful journey we went through to make qqq extension fully compatible with Windows 7.

---

## Table of Contents

1. [Rust Binary Compilation](#1-rust-binary-compilation)
2. [VC++ Runtime DLLs](#2-vc-runtime-dlls)
3. [ZIP Extraction Hanging](#3-zip-extraction-hanging)
4. [Chrome Validation Hanging](#4-chrome-validation-hanging)
5. [Chromium Version Selection](#5-chromium-version-selection)
6. [Python Version Selection](#6-python-version-selection)
7. [yt-dlp Legacy Fork](#7-yt-dlp-legacy-fork)
8. [Summary of Changes](#8-summary-of-changes)

---

## 1. Rust Binary Compilation

### The Problem

Our Rust engine (`q_engine.exe`) used standard library features that internally call `WaitOnAddress` API, which is **only available on Windows 8+**.

```
Error: The procedure entry point WaitOnAddress could not be located
in the dynamic link library KERNEL32.dll
```

### Root Cause

Rust's `std::sync` primitives (Mutex, Condvar, etc.) use `WaitOnAddress` for efficient thread synchronization since Rust 1.49+.

### Failed Attempts

1. **Static CRT linking** (`target-feature=+crt-static`) - Did not help
2. **Older Rust versions** (1.48) - Too many compatibility issues
3. **Custom synchronization primitives** - Too complex

### The Solution

Use Rust's **official Win7 target triples**:

```yaml
# .github/workflows/qrelease.yml
- target: x86_64-win7-windows-msvc  # Win7 compatible x64
- target: i686-win7-windows-msvc    # Win7 compatible x86
```

These targets require `nightly` toolchain + `build-std`:

```yaml
- name: Build (Windows - Win7 Compatible)
  run: |
    rustup default nightly
    rustup component add rust-src
    cargo build --release -Z build-std --target ${{ matrix.target }}
```

### Verification

Used `dumpbin` to verify no Win10+ APIs are imported:

```bash
dumpbin /imports q_engine.exe | grep -i "WaitOnAddress\|WakeByAddress"
# Should return empty
```

---

## 2. VC++ Runtime DLLs

### The Problem

Windows 7 systems often lack the Visual C++ 2015-2022 Redistributable, which is required by:

1. **Rust engine** (`q_engine.exe`) - compiled with MSVC
2. **Python engine** - Pillow and other native extensions require VC++ runtime

Without these DLLs, users see errors like:

```
The program can't start because VCRUNTIME140.dll is missing
The program can't start because MSVCP140.dll is missing
```

### The Solution

Bundle VC++ runtime DLLs with the extension:

```
assets/runtimes/
├── x64/
│   ├── concrt140.dll
│   ├── msvcp140.dll
│   ├── msvcp140_1.dll
│   ├── msvcp140_2.dll
│   ├── vccorlib140.dll
│   ├── vcruntime140.dll
│   └── vcruntime140_1.dll    ← x64 only
└── x86/
    ├── concrt140.dll
    ├── msvcp140.dll
    ├── msvcp140_1.dll
    ├── msvcp140_2.dll
    ├── vccorlib140.dll
    └── vcruntime140.dll
```

### Implementation

**For Rust Engine** (`global.js`):

```javascript
const arch = process.arch === "x64" ? "x64" : "x86";
const runtimesDir = path.join(assetsDir, "runtimes", arch);
const dlls = fs.readdirSync(runtimesDir).filter(f => f.endsWith(".dll"));
for (const dll of dlls) {
    fs.copyFileSync(path.join(runtimesDir, dll), path.join(assetsDir, dll));
}
```

**For Python Engine** (`qvenv.js`):

```javascript
_getRequiredVCDlls() {
    return [
        'msvcp140.dll',      // Core: required by Pillow
        'vcruntime140.dll',  // Core: C runtime
        'vcruntime140_1.dll' // x64-only
    ];
}

_copyVCRuntimeDlls(context, installDir) {
    const arch = process.arch === 'x64' ? 'x64' : 'x86';
    const runtimesDir = path.join(context.extensionPath, 'assets', 'runtimes', arch);
    // Copy all DLLs to Python install directory
    for (const dll of allDlls) {
        fs.copyFileSync(path.join(runtimesDir, dll), path.join(installDir, dll));
    }
}
```

### Required vs Optional DLLs

| DLL | Required | Notes |
|-----|----------|-------|
| `vcruntime140.dll` | ✅ | Core C runtime |
| `msvcp140.dll` | ✅ | C++ standard library |
| `vcruntime140_1.dll` | ✅ (x64) | x64 only, doesn't exist on x86 |
| `msvcp140_1.dll` | ❌ | Optional |
| `msvcp140_2.dll` | ❌ | Optional |
| `concrt140.dll` | ❌ | Concurrency runtime |
| `vccorlib140.dll` | ❌ | WinRT support |

---

## 3. ZIP Extraction Hanging

### The Problem

Chrome and Python downloads would hang at "Extracting..." on Windows 7.

```
qqq: Downloading chrome109...: Extracting...
# Hangs forever, never completes
```

The files were actually extracted, but the process never returned.

### Root Cause

Windows 7 ships with **PowerShell 2.0**, which has severe limitations:

1. `.NET ZipFile` requires .NET 4.5+ (not default on Win7)
2. PowerShell COM object calls (`Shell.Application`) hang on PS 2.0
3. `tar` command doesn't exist on Win7

### The Solution

Use **VBScript** to call `Shell.Application` directly, bypassing PowerShell entirely:

```javascript
// global.js - extractZip()
const vbsScript = `
Set objShell = CreateObject("Shell.Application")
Set zipFile = objShell.NameSpace("${zipPathWin}")
Set destDir = objShell.NameSpace("${destFolderWin}")
destDir.CopyHere zipFile.Items, 16
WScript.Quit 0
`;

// Execute via cscript (works on all Windows versions)
cp.exec(`cscript //nologo "${vbsPath}"`, ...);
```

### Fallback Strategy (4-level)

```
1. VBScript Shell.Application  ← Win7 stable, no PowerShell dependency
2. .NET ZipFile (PowerShell)   ← Win10+ with .NET 4.5+
3. tar command                 ← Win10+ only
4. Fail with detailed error
```

---

## 4. Chrome Validation Hanging

### The Problem

`_validateChromiumSilently()` used PowerShell to read exe version info:

```powershell
$vi = (Get-Item 'chrome.exe').VersionInfo
```

This would **hang indefinitely** on Windows 7 PowerShell 2.0.

### The Solution

Add a **file-based fallback validation** when PowerShell fails:

```javascript
_validateChromiumByFiles(exePath) {
    // 1. chrome.exe must be > 1MB (exclude shortcuts/stubs)
    if (fs.statSync(exePath).size < 1 * 1024 * 1024) {
        return { valid: false, reason: 'exe_too_small' };
    }

    // 2. Must have resources.pak or icudtl.dat (Chrome essential files)
    const hasResources = fs.existsSync(path.join(exeDir, 'resources.pak'));
    const hasIcu = fs.existsSync(path.join(exeDir, 'icudtl.dat'));
    if (!hasResources && !hasIcu) {
        return { valid: false, reason: 'missing_key_files' };
    }

    // 3. Directory size > 150MB (complete Chrome is ~300MB)
    if (totalSize < 150 * 1024 * 1024) {
        return { valid: false, reason: 'dir_too_small' };
    }

    return { valid: true };
}
```

### Validation Strategy

```
Windows:
├─ Try PowerShell VersionInfo (8s timeout)
│   ├─ Success → Parse Chromium family info
│   └─ Fail/Timeout → Use file-based validation
│       ├─ exe > 1MB ✓
│       ├─ resources.pak exists ✓
│       └─ dir > 150MB ✓
│           └─ All pass → valid: true

Linux/Mac:
└─ Execute --version directly
```

---

## 5. Chromium Version Selection

### The Problem

Initially we used **Chromium 83**, but discovered:

- Chrome 109 is the **last version supporting Windows 7**
- Chrome 110+ requires Windows 10+
- Using 109 provides better compatibility and features

### Dual-Version Strategy

We now use different Chrome versions based on OS:

| OS | Chrome Version | Source Type | Reason |
|----|----------------|-------------|--------|
| Win7/8/8.1 | 109.0.5414.120 | Chromium Snapshots | Last Win7 support |
| Win10+ | 133.0.6943.141 | Chrome for Testing | Latest stable |
| macOS | 133.0.6943.141 | Chrome for Testing | Latest stable |
| Linux | 133.0.6943.141 | Chrome for Testing | Latest stable |

### Version Configuration

```javascript
// qvideo.js - _getChromeDownloadInfo()
const isLegacyWindows = platform === 'win32' && parseFloat(os.release()) < 10;

if (isLegacyWindows) {
    // Win7/8: Chromium 109 Snapshots
    const version = '109.0.5414.120';
    const revision = '1069666';
    sources: [
        'npmmirror/chromium-browser-snapshots',
        'huawei/chromium-browser-snapshots',
        'google/chromium-browser-snapshots'
    ];
} else {
    // Win10+ / Mac / Linux: Chrome for Testing 133
    const version = '133.0.6943.141';
    sources: [
        'npmmirror/chrome-for-testing',  // ★ Has mirror!
        'google/chrome-for-testing-public'
    ];
}
```

### Download Sources

**Win7/8 (Chromium Snapshots - 3 sources):**

| Priority | Source | URL Pattern |
|----------|--------|-------------|
| 1 | npmmirror | `cdn.npmmirror.com/binaries/chromium-browser-snapshots/...` |
| 2 | Huawei | `mirrors.huaweicloud.com/chromium-browser-snapshots/...` |
| 3 | Google | `storage.googleapis.com/chromium-browser-snapshots/...` |

**Win10+ / Mac / Linux (Chrome for Testing - 2 sources):**

| Priority | Source | URL Pattern |
|----------|--------|-------------|
| 1 | npmmirror | `registry.npmmirror.com/-/binary/chrome-for-testing/...` |
| 2 | Google | `storage.googleapis.com/chrome-for-testing-public/...` |

### Folder Structure Differences

| Type | Platform | Folder Name |
|------|----------|-------------|
| Snapshots | Win | `chrome-win` |
| Chrome for Testing | Win64 | `chrome-win64` |
| Chrome for Testing | Win32 | `chrome-win32` |
| Chrome for Testing | Mac ARM | `chrome-mac-arm64` |
| Chrome for Testing | Mac x64 | `chrome-mac-x64` |
| Chrome for Testing | Linux | `chrome-linux64` |

---

## 6. Python Version Selection

### The Problem

Python 3.9+ dropped support for Windows 7. We need a Python version that:

1. Supports Windows 7
2. Has working pip and can install packages
3. Is embeddable (small footprint)

### The Solution

Use **Python 3.8.10** - the last version supporting Windows 7:

```javascript
// qvenv.js
const pyVersion = '3.8.10';

if (platform === 'win32') {
    if (arch === 'x64') {
        url = `https://www.python.org/ftp/python/${pyVersion}/python-${pyVersion}-embed-amd64.zip`;
    } else {
        url = `https://www.python.org/ftp/python/${pyVersion}/python-${pyVersion}-embed-win32.zip`;
    }
}
```

### Download Sources (2-level fallback)

```javascript
officialUrl = `https://www.python.org/ftp/python/3.8.10/python-3.8.10-embed-amd64.zip`;
mirrorUrl = `https://registry.npmmirror.com/-/binary/python/3.8.10/python-3.8.10-embed-amd64.zip`;
```

### Python + VC++ Runtime Integration

After extracting Python, we automatically copy VC++ runtime DLLs:

```
1. Download python-3.8.10-embed-amd64.zip
2. Extract to globalStorage/python/
3. Copy VC++ DLLs from assets/runtimes/x64/
4. Install pip (get-pip.py)
5. Install packages (Pillow, etc.)
```

---

## 7. yt-dlp Legacy Fork

### The Problem

The official `yt-dlp` binary requires Windows 10+ due to modern API dependencies. Windows 7/8 users would see:

```
The procedure entry point ... could not be located in KERNEL32.dll
```

### The Solution

Use **nicolaasjan's legacy fork** which maintains Win7 compatibility:

```javascript
// dow.js - autoInstall()
const LEGACY_BASE = 'https://github.com/nicolaasjan/yt-dlp/releases/latest/download';
const OFFICIAL_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

// Auto-detect old OS
let useLegacyFork = false;
if (platform === 'win32') {
    const winVer = parseFloat(os.release());
    if (winVer < 10) {
        useLegacyFork = true;  // Win7/8/8.1
    }
} else if (platform === 'darwin') {
    const darwinVer = parseFloat(os.release());
    if (darwinVer < 19) {  // macOS < 10.15
        useLegacyFork = true;
    }
}

// Different binaries for different OS
if (useLegacyFork) {
    url = `${LEGACY_BASE}/yt-dlp_win7.exe`;  // Special Win7 build
} else {
    url = `${OFFICIAL_BASE}/yt-dlp.exe`;     // Official build
}
```

### Download Sources (3-level fallback)

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | gh-proxy.com | Fastest in China |
| 2 | GitHub | Official/Fork direct |
| 3 | ghproxy.net | Backup mirror |

```javascript
const downloadUrls = [
    { url: 'https://gh-proxy.com/https://github.com/...', name: 'gh-proxy.com' },
    { url: 'https://github.com/...', name: 'GitHub' },
    { url: 'https://ghproxy.net/https://github.com/...', name: 'ghproxy.net' },
];
```

### Platform Support Matrix

| OS | Binary | Fork |
|----|--------|------|
| Windows 10+ | `yt-dlp.exe` | Official |
| Windows 7/8/8.1 | `yt-dlp_win7.exe` | nicolaasjan |
| macOS 10.15+ | `yt-dlp_macos` | Official |
| macOS < 10.15 | `yt-dlp_macos` | nicolaasjan |
| Linux | `yt-dlp` | Official |

---

## 8. Summary of Changes

### Files Modified

| File | Changes |
|------|---------|
| `.github/workflows/qrelease.yml` | Win7 Rust targets |
| `src/global.js` | VBScript extraction, VC++ DLL copy, `require('os')` |
| `src/qvideo.js` | File-based validation, Chrome 109 |
| `src/qvenv.js` | Python 3.8.10, VC++ DLL copy |
| `src/dow.js` | yt-dlp legacy fork detection, 3-level fallback |
| `assets/runtimes/` | Bundled VC++ 2015-2022 DLLs |

### Key Takeaways

1. **PowerShell 2.0 is extremely limited** - Avoid it when possible
2. **VBScript is more reliable** on legacy Windows
3. **Rust Win7 targets exist** but require nightly + build-std
4. **Different platforms have different snapshot revisions**
5. **Always have fallback strategies** for critical operations
6. **Bundle VC++ runtime DLLs** - Don't assume they're installed
7. **Use Python 3.8.10** - Last version supporting Win7
8. **Use Chromium 109** - Last version supporting Win7
9. **Use nicolaasjan fork for yt-dlp** - Maintains Win7/old macOS support

### Testing Checklist

- [ ] Win7 x64: Rust engine loads (with VC++ DLLs)
- [ ] Win7 x64: Chrome 109 downloads and extracts
- [ ] Win7 x64: Python 3.8.10 downloads and extracts
- [ ] Win7 x64: Python packages install (Pillow, etc.)
- [ ] Win7 x64: Chrome validation passes (file-based fallback)
- [ ] Win7 x86: Same as above
- [ ] Win10+: No regression
- [ ] Mac/Linux: No regression

---

## References

- [Chrome Win7 Support End](https://support.google.com/chrome/thread/185534985)
- [Rust Win7 Targets](https://doc.rust-lang.org/rustc/platform-support.html)
- [Chromium Snapshots](https://github.com/nicedpy/nicedpy)

---

*Last updated: February 2026*

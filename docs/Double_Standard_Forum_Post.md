# Microsoft Bundled Executables: What They Actually Do (Forum Version)

---

## TL;DR

Microsoft questioned my **100% open-source clipboard utility** while their own extensions with **590M+ downloads** do far more invasive things:

| My Extension | Microsoft's Extensions |
|--------------|------------------------|
| Reads clipboard | **Downloads binaries from internet** |
| Saves screenshots locally | **Executes code on remote machines** |
| Copies files to local folder | **Runs closed-source native binaries** |
| No network access | **Collects telemetry by default** |

---

## What Microsoft's Extensions ACTUALLY Do

### 1. Python Extension (205M installs) - Microsoft
**Invasive behaviors:**
- ⚠️ **Auto-downloads closed-source binary** (Pylance) without explicit consent
- ⚠️ **Executes proprietary native code** that users CANNOT audit
- ⚠️ **Collects telemetry** by default
- ⚠️ Pylance license explicitly **prohibits reverse engineering**

**My q_engine.exe:** 100% open source, zero network calls, zero telemetry

---

### 2. Python Debugger (111M installs) - Microsoft
**Invasive behaviors:**
- ⚠️ **Downloads platform-specific binaries** (debugpy) from Microsoft servers
- ⚠️ **Injects into running Python processes** for debugging
- ⚠️ Can **attach to any running process** on your system
- ⚠️ Has **full access to your application's memory and variables**

**My q_engine.exe:** Only reads clipboard, cannot attach to any process

---

### 3. C/C++ Extension (95M installs) - Microsoft
**Invasive behaviors:**
- ⚠️ Bundles **clang-format.exe** - executes native binary
- ⚠️ Runs **IntelliSense engine** - a complex native binary analyzing all your code
- ⚠️ **Parses every source file** in your project
- ⚠️ Downloads **6+ platform-specific binary packages**
- ⚠️ Collects **usage telemetry** by default

**My q_engine.exe:** Single binary, single purpose (clipboard), no code analysis

---

### 4. Remote - SSH (32M installs) - Microsoft
**Invasive behaviors:**
- ⚠️ **Downloads VS Code Server binary** to remote machines automatically
- ⚠️ **Executes code on remote systems** without manual intervention
- ⚠️ Maintains **persistent connections** to remote machines
- ⚠️ Can **read, write, and execute** anything on the remote system
- ⚠️ Transfers files between local and remote systems

**My q_engine.exe:** ONLY runs locally, ZERO network access, cannot connect to any remote system

---

### 5. C# Extension (39M installs) - Microsoft
**Invasive behaviors:**
- ⚠️ Runs **OmniSharp server** - a full .NET runtime
- ⚠️ Includes **Roslyn compiler** - can compile and potentially execute C# code
- ⚠️ **Analyzes entire codebase** continuously
- ⚠️ Downloads **platform-specific binaries** on first use
- ⚠️ Has access to **compile your source code**

**My q_engine.exe:** Cannot compile anything, cannot analyze code, just clipboard operations

---

### 6. Go Extension (18M installs) - Google
**Invasive behaviors:**
- ⚠️ **Downloads gopls, dlv** (debugger), and other tools from internet
- ⚠️ **Executes downloaded binaries** automatically
- ⚠️ Debugger can **attach to running processes**
- ⚠️ Has **full access to Go runtime and memory**

**My q_engine.exe:** No downloads, no debugger capabilities, no process attachment

---

### 7. CodeLLDB (10M installs) - Third Party
**Invasive behaviors:**
- ⚠️ Bundles **complete LLDB debugger** (lldb-server)
- ⚠️ Can **attach to ANY native process**
- ⚠️ Has **full memory read/write access** to debugged processes
- ⚠️ Can **execute arbitrary code** in debugged context
- ⚠️ Supports **remote debugging** over network

**My q_engine.exe:** Cannot debug anything, cannot attach to processes, no remote capability

---

## Side-by-Side Comparison

| Capability | q_engine.exe | MS Python | MS C/C++ | MS Remote-SSH | MS C# |
|------------|--------------|-----------|----------|---------------|-------|
| Open Source | ✅ 100% | ❌ Pylance closed | ❌ Partial | ❌ Partial | ❌ Partial |
| Downloads binaries | ❌ Never | ⚠️ Yes | ⚠️ Yes | ⚠️ Yes | ⚠️ Yes |
| Network access | ❌ None | ⚠️ Telemetry | ⚠️ Telemetry | ⚠️ SSH | ⚠️ Telemetry |
| Remote execution | ❌ No | ❌ No | ❌ No | ⚠️ **YES** | ❌ No |
| Process attachment | ❌ No | ⚠️ debugpy | ⚠️ gdb/lldb | ❌ No | ⚠️ debugger |
| Code compilation | ❌ No | ❌ No | ❌ No | ❌ No | ⚠️ **Roslyn** |
| Memory access | ❌ Clipboard only | ⚠️ Debug mode | ⚠️ Debug mode | ⚠️ Full | ⚠️ Debug mode |
| Telemetry | ❌ None | ⚠️ Default ON | ⚠️ Default ON | ⚠️ Default ON | ⚠️ Default ON |

---

## The Question

**My q_engine.exe does exactly ONE thing:** Read clipboard and save files locally.

- No network access
- No remote execution
- No process attachment
- No code compilation
- No telemetry
- 100% open source: https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs

**Yet Microsoft's extensions can:**
- Download arbitrary binaries from the internet
- Execute code on remote machines
- Attach to running processes
- Compile and potentially execute code
- Collect telemetry by default
- Run closed-source native binaries

**And MY extension gets locked and questioned?**

---

## Source Code (First 20 Lines)

```rust
// Rust port of the given Python "dumb saver" clipboard daemon.
// - 极简模式：只负责读取系统剪切板并保存到指定目录
// - 移除所有指纹计算、去重逻辑
// - 移除 HTML 解析逻辑（由 Node.js 侧处理）
// - 仅处理：纯文本、文件复制、原生图片保存
//
// actions: ping / extract_icon / clipboard_peek /
//          get_clipboard_files / get_html / exit /
//          clipboard(paste) / folder_info
```

That's it. That's the entire scope. A "dumb saver" for clipboard content.

---

**Full timeline of this case:** https://github.com/gh555com/qqq/blob/qq/docs/rep_34d03ee3.md

**Case reference:** rep:34d03ee3

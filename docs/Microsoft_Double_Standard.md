# Microsoft's Double Standard on Bundled Executables

## Overview

This document exposes a clear **double standard** in Microsoft's VS Marketplace review process. Microsoft's own extensions bundle native executables with **billions of combined installs**, yet my open-source clipboard utility (`q_engine.exe`) with **100% transparent source code** is being questioned and my extension locked.

---

## The Evidence: Microsoft's Own Extensions with Bundled Executables

### Sorted by Download Count (Data from VS Marketplace, February 2026)

| Rank | Extension | Publisher | Downloads | Bundled Executables / Native Binaries |
|------|-----------|-----------|-----------|---------------------------------------|
| **1** | [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) | **Microsoft** | **205,743,249** | Automatically installs **Pylance** (closed-source native binary) + **debugpy** |
| **2** | [Python Debugger](https://marketplace.visualstudio.com/items?itemName=ms-python.debugpy) | **Microsoft** | **111,100,410** | Platform-specific **debugpy binaries** for win32/linux/darwin |
| **3** | [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) | **Microsoft** | **95,238,809** | **clang-format.exe**, **IntelliSense engine**, and multiple other executables |
| **4** | [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) | **Microsoft** | **56,003,816** | Interacts with **cmake.exe**, includes built-in CMake language server |
| **5** | [C/C++ Extension Pack](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools-extension-pack) | **Microsoft** | **51,476,285** | Contains all binaries from the C/C++ extension above |
| **6** | [C#](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) | **Microsoft** | **38,950,157** | **OmniSharp/Roslyn** language server (native binary) |
| **7** | [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) | **Microsoft** | **32,516,180** | Downloads and runs **VS Code Server executable** on remote machines |
| **8** | [Go](https://marketplace.visualstudio.com/items?itemName=golang.go) | Google | **18,035,996** | Downloads **gopls.exe**, **dlv.exe** (debugger) and other tools |
| **9** | [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) | Vadim Chugunov | **9,979,271** | Complete **LLDB debugger** executable (lldb-server) |
| **10** | [HashiCorp Terraform](https://marketplace.visualstudio.com/items?itemName=hashicorp.terraform) | HashiCorp | **6,040,468** | **terraform-ls** language server executable |
| **11** | [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) | Rust Team | **5,819,566** | **rust-analyzer.exe** language server |
| **12** | [clangd](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd) | LLVM | **2,483,923** | Downloads **clangd.exe** executable |

**Total downloads of Microsoft's own extensions with bundled executables: ~590 million**

---

## Detailed Analysis of Microsoft's Own Bundled Executables

### 1. Python Extension (205M downloads)

**What it bundles:**
- Automatically installs **Pylance** - a **closed-source** native binary language server
- Automatically installs **debugpy** - platform-specific debug binaries

**Key quote from [Python Debugger docs](https://marketplace.visualstudio.com/items?itemName=ms-python.debugpy):**
> *"The Python Debugger extension provides a more streamlined approach: it delivers **platform-specific builds**, ensuring you only receive the components relevant to your specific operating system."*

**Double Standard:**
- Pylance is **closed-source** - users cannot audit the code
- My q_engine.exe is **100% open source** at https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs

---

### 2. C/C++ Extension (95M downloads)

**What it bundles:**
- `clang-format.exe` - Code formatter executable
- IntelliSense engine - Native binary for code analysis
- Multiple platform-specific binaries for different architectures

**Evidence:**
The extension provides [platform-specific VSIX packages](https://github.com/microsoft/vscode-cpptools/releases) with native binaries for:
- win32-x64
- win32-arm64
- linux-x64
- linux-arm64
- darwin-x64
- darwin-arm64

**Double Standard:**
- Microsoft bundles multiple executables across 6+ platforms
- My extension has ONE executable (q_engine.exe) with full source code

---

### 3. Remote - SSH Extension (32M downloads)

**What it does:**
- Downloads and installs the **VS Code Server** executable on remote machines
- Runs this executable automatically when you connect via SSH

**From [Remote SSH docs](https://code.visualstudio.com/docs/remote/ssh):**
> *"The Remote - SSH extension installs a **VS Code Server** on the remote machine, which runs independently of any existing VS Code installation."*

**Double Standard:**
- Microsoft's extension automatically downloads and **executes binaries on remote machines**
- My extension runs ONE local executable that only handles clipboard operations

---

### 4. C# Extension (39M downloads)

**What it bundles:**
- **OmniSharp** - A full .NET language server (native binary)
- **Roslyn** - Compiler services (native binary)

**Double Standard:**
- These are complex executables that can compile and execute code
- My q_engine.exe is a simple clipboard utility that only:
  - Reads text from clipboard
  - Copies files
  - Saves screenshots as PNG
  - Reads HTML content

---

## The Comparison

| Aspect | Microsoft's Extensions | My Extension (qqq) |
|--------|------------------------|-------------------|
| **Source Code** | Many binaries are **closed-source** (e.g., Pylance) | **100% open source** |
| **Functionality** | Code execution, compilation, remote access | Simple clipboard operations |
| **Network Access** | Some extensions communicate with Microsoft servers | **No network access** |
| **Data Collection** | Telemetry enabled by default | **No data collection** |
| **Review Status** | Approved and featured | **Locked and questioned** |

---

## What q_engine.exe Actually Does

From the [source code](https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs):

```rust
// -*- coding: utf-8 -*-
// Rust port of the given Python "dumb saver" clipboard daemon.
// - 极简模式：只负责读取系统剪切板并保存到指定目录（dumb saver）
// - 移除所有指纹计算、去重逻辑
// - 移除 HTML 解析逻辑（由 Node.js 侧处理）
// - 仅处理：纯文本、文件复制、原生图片保存
```

**Supported operations:**
1. `ping` - Health check
2. `extract_icon` - Get file icon
3. `clipboard_peek` - Read clipboard content
4. `get_clipboard_files` - Get file list from clipboard
5. `get_html` - Read HTML content from clipboard
6. `clipboard` (paste) - Paste files to target directory
7. `folder_info` - Get folder statistics

**What it does NOT do:**
- ❌ No network access
- ❌ No code execution/compilation
- ❌ No data collection
- ❌ No remote connections
- ❌ No system modifications

---

## The Questions Microsoft Needs to Answer

1. **Why is a closed-source binary (Pylance) with 200M+ installs acceptable, but my open-source clipboard utility is not?**

2. **Why can Microsoft's Remote - SSH execute binaries on remote machines, but my local-only clipboard utility is questioned?**

3. **Why are Microsoft's platform-specific debugpy binaries approved, but my single q_engine.exe needs "clarification"?**

4. **Has the VS Marketplace Support team even clicked the source code link I provided 6 days before they claimed they "could not find any clarification"?**

---

## Conclusion

This is not about security. This is not about user protection.

If it were, Microsoft would have to remove their own Python Debugger, C/C++ extension, Remote - SSH, and many others.

**This is a double standard:**
- Microsoft's own executables: ✅ Approved
- Third-party executables (even 100% open source): ❓ Questioned and locked

The evidence speaks for itself.

---

## Evidence Links

| Resource | URL |
|----------|-----|
| q_engine.exe source code | https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs |
| Full email timeline | https://github.com/gh555com/qqq/blob/qq/docs/rep_34d03ee3.md |
| Python extension | https://marketplace.visualstudio.com/items?itemName=ms-python.python |
| Python Debugger | https://marketplace.visualstudio.com/items?itemName=ms-python.debugpy |
| C/C++ extension | https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools |
| Remote - SSH | https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh |
| C# extension | https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp |

---

*Document created: February 27, 2026*
*Case reference: rep:34d03ee3*

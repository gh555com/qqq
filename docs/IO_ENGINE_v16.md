







# IO Engine v16 Architecture （下方有中文版）

## Overview

**Core change in v16 architecture: Users no longer need to select an IO engine; the system automatically collaborates.**

| Engine | Responsibility | Lifecycle | Memory |
|--------|----------------|-----------|--------|
| **Rust daemon** | IO operations (clipboard†, files, paste) | per-window | ~7 MB |
| **Python Broker** | Audio playback, clipboard monitoring | System-wide singleton | ~50 MB |
| **Shell daemon** | Clipboard (Linux/macOS); Fallback (Windows) | per-window | ~70 MB |

> † Rust handles clipboard natively on **Windows only**. On Linux/macOS, clipboard is handled by Shell (xclip/pngpaste).

**Extreme scenario with 15 windows**: v16 uses only **~155 MB**, compared to ~855 MB in the old architecture, saving **82%**.

---

## Process Identification Specification

### Process Hierarchy Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    PROCESS HIERARCHY                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  VS Code / Cursor / Windsurf (Host Process)                  │
│      │                                                       │
│      ├── Extension Host Process                              │
│      │       │                                               │
│      │       ├── q_engine.exe [per-window, ~7MB]             │
│      │       │       ↓ stdio (JSON-RPC)                      │
│      │       │                                               │
│      │       └── [fallback] powershell.exe / bash            │
│      │               ↓ stdio (JSON-RPC)                      │
│      │                                                       │
│      └── (IPC) ──────────────────────────────────────────┐   │
│                                                          │   │
│                                                          ↓   │
│              python.exe kp.py --broker [global, ~50MB]       │
│                      ↑                                       │
│                      │ Named Pipe / Unix Socket              │
│                      │                                       │
│              (Shared by all windows)                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 1. Rust Daemon (Primary IO Engine)

| Attribute | Value |
|-----------|-------|
| **Process Name** | `q_engine.exe` (Windows) / `q_engine` (macOS/Linux) |
| **File Location** | `{extensionPath}/assets/q_engine.exe` |
| **Startup Arguments** | `--daemon` |
| **Environment Variable** | `Q_PARENT_PID={Parent PID}` |
| **Lifecycle** | per-window, auto-exits when VS Code window closes |
| **Memory Footprint** | ~7 MB |
| **Number of Processes** | 1 per window |

```bash
# Identification Method
# Windows
tasklist | findstr q_engine

# macOS/Linux
ps aux | grep q_engine
```

### 2. Python Broker (Global Audio Engine)

| Attribute | Value |
|-----------|-------|
| **Process Name** | `python.exe` / `python3` |
| **Python Path** | `{globalStorage}/python_engine/python.exe` (Built-in only, system Python disabled) |
| **Script File** | `{extensionPath}/dist/kp.py` or `src/kp.py` |
| **Startup Arguments** | `--broker` |
| **Lifecycle** | System-wide singleton, auto-exits after 80s TTL without heartbeat |
| **Memory Footprint** | ~50 MB |
| **Number of Processes** | **1** globally |

**IPC Communication Paths**:

| Platform | IPC Type | Path Format |
|----------|----------|-------------|
| Windows | Named Pipe | `\\.\pipe\vix_audio_broker_{RID}` (e.g., `vix_audio_broker_1001`) |
| macOS/Linux | Unix Socket | `/tmp/vix_audio_broker_{uid}.sock` |

**Config File Directory**:

| Platform | Directory Path |
|----------|----------------|
| Windows | `%LOCALAPPDATA%\vix_audio_broker\` |
| macOS/Linux | `~/.cache/vix_audio_broker/` |

**Config Files**:
- `endpoint.json` - IPC endpoint info (pipe/socket path, protocol version)
- `token.txt` - Authentication token (Base64 encoded)

```bash
# Identification Method
# Windows
wmic process where "commandline like '%kp.py%'" get processid,commandline

# macOS/Linux
ps aux | grep "kp.py.*--broker"
```

### 3. Shell Daemon (Clipboard Engine on Unix / Fallback on Windows)

**Platform behavior:**
- **Windows**: Only starts when Rust fails (fallback). Rust handles clipboard natively via Win32 API.
- **Linux/macOS**: **Always starts alongside Rust** (complementary). Rust handles media/audio; Shell handles clipboard via xclip/pngpaste/osascript.

> ⚠️ Since v16, Rust daemon is compiled with Win7-specific targets. On Windows, **all versions (Win7+) use Rust** for clipboard; no Shell needed.

| Platform | Process Name | Startup Command |
|----------|--------------|-----------------|
| Windows | `powershell.exe` / `pwsh.exe` | `-STA -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -Command {script}` |
| macOS/Linux | `bash` | `bash -c {script}` |

| Attribute | Value |
|-----------|-------|
| **Lifecycle** | per-window |
| **Memory Footprint** | ~70 MB (PowerShell) / ~20 MB (Bash) |
| **Number of Processes** | Windows: 0 (normal) / 1 (fallback); Linux/macOS: **1 per window** (always) |

```bash
# Identification Method
# Windows
wmic process where "name='powershell.exe'" get processid,commandline | findstr /i "qqq\|vix"

# macOS/Linux
ps aux | grep "bash.*qqq"
```

### Common Troubleshooting Commands

```bash
# === Windows ===
tasklist | findstr /i "q_engine python powershell"
wmic process where "name='q_engine.exe'" get processid,commandline
dir \\.\pipe\ | findstr vix_audio_broker

# Force terminate (use with caution)
taskkill /f /im q_engine.exe

# === macOS / Linux ===
ps aux | grep -E "q_engine|kp.py|vix"
ls -la /tmp/*vix_audio_broker*

# Force terminate (use with caution)
pkill -f q_engine
pkill -f "kp.py.*--broker"
```

---

## Architecture Comparison

### v16 Architecture: Broker Singleton + Division of Labor

```
┌─────────────────────────────────────────────────────────────┐
│                   v16 ARCHITECTURE                           │
│           (Broker Singleton + Rust Division + Real-time Broadcast)               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Different IDEs: VS Code, Cursor, Windsurf, Trae... Assume 15 windows are open             │
│  ┌──────┐  ┌──────┐   ┌──────┐                              │
│  │ Rust │  │ Rust │   │ Rust │    ← Per-window independent Rust          │
│  │(7MB) │  │(7MB) │   │(7MB) │      Handles IO operations             │
│  └──┬───┘  └──┬───┘   └──┬───┘                              │
│     │         │          │                                   │
│     │    IPC (Named Pipe / Unix Socket)                      │
│     │         │          │                                   │
│     └─────────┼──────────┘                                   │
│               ↓                                              │
│     ┌─────────────────────┐                                  │
│     │   Python Broker     │  ← System-wide unique, shared by all windows        │
│     │      (~50 MB)       │                                  │
│     │  • Audio playback         │                                  │
│     │  • Clipboard monitoring       │                                  │
│     │  • Status broadcast ────────┼──→ Real-time push to all windows            │
│     └─────────────────────┘                                  │
│                                                              │
│  Advantages: Real-time status sync, 82% memory savings, zero configuration                     │
└─────────────────────────────────────────────────────────────┘
```

### Old Architecture: Per-window Independent Daemons

```
┌─────────────────────────────────────────────────────────────┐
│                    OLD ARCHITECTURE                          │
│              (Per-window independent daemons, no communication)                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  VS Code Window 1          VS Code Window 2                  │
│  ┌────────────────┐        ┌────────────────┐               │
│  │ Python daemon  │        │ Python daemon  │    ...×15     │
│  │   (~50 MB)     │        │   (~50 MB)     │               │
│  │ Rust daemon    │        │ Rust daemon    │               │
│  │   (~7 MB)      │        │   (~7 MB)      │               │
│  └────────────────┘        └────────────────┘               │
│                                                              │
│  Problems: Status out of sync, memory explosion, users need to manually select engine               │
└─────────────────────────────────────────────────────────────┘
```

> 📖 Further Reading: [IO_ENGINE.md](https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE.md)

---

## Performance Comparison

### Memory Footprint

| Scenario | Old Architecture | v16 Architecture | Savings |
|----------|------------------|------------------|---------|
| 1 window | ~57 MB | ~57 MB | 0% |
| 5 windows | ~285 MB | ~85 MB | **70%** |
| **15 windows** | **~855 MB** | **~155 MB** | **82%** |
| 20 windows | ~1140 MB | ~190 MB | **83%** |

**Formulas**:
- Old Architecture: `N × 57MB`
- v16: `N × 7MB + 50MB`

### Other Metrics

| Metric | Old Architecture | v16 Architecture |
|--------|------------------|------------------|
| Startup Time | ~2-3s per window | ~50ms after first window |
| Status Sync | ~1.5s polling | <10ms broadcast |
| Idle CPU | Continuous polling | **Zero polling** |

---

## Stability & Platform Support

### Fault Isolation

| Scenario | Old Architecture | v16 Architecture |
|----------|------------------|------------------|
| Python crash | All window functions fail | Only audio unavailable |
| Rust crash | Window IO fails | Same |
| Process leak | N possible leaks | Only 1, auto-recycled via TTL |

### Cross-platform

| Platform | v16 Strategy |
|----------|--------------|
| Windows 10+ | ✅ Rust daemon + Named Pipe IPC |
| Windows 7/8 | ✅ Rust daemon (Win7 target compile) + Named Pipe IPC |
| macOS/Linux | ✅ Rust daemon + Unix Socket IPC |
| ARM64 | ✅ Rust cross-platform compile |

> Win7 compatibility achieved via `x86_64-win7-windows-msvc` / `i686-win7-windows-msvc` target compilation; no Shell fallback needed.

---

## Known Issues

### Old Architecture Issues (Resolved)

| Severity | Problem | v16 Solution |
|----------|---------|--------------|
| 🔴 Critical | Linear memory growth (~855MB for 15 windows) | Broker singleton, reduced to ~155MB |
| 🔴 Critical | Multi-window status out of sync | IPC broadcast, <10ms real-time sync |
| 🟠 High | Users need to manually select IO engine | Automatic collaboration, zero configuration |
| 🟠 High | Continuous polling consumes CPU when idle | Event-driven, zero polling |
| 🟡 Medium | Python startup takes 2-3s per window | Direct connection ~50ms after first |
| 🟡 Medium | No cross-IDE collaboration | Broker unified management |
| 🟢 Low | Hot reload leaves zombie processes | Auto-recycled via 80s TTL |

### v16 Current Issues

| Severity | Problem | Mitigation |
|----------|---------|------------|
| 🟡 Medium | Named Pipe may be blocked by security software | Prompt user to add to whitelist |
| 🟢 Low | First connection needs to wait for Broker startup | 6-second delayed startup |

> ✅ **Resolved**: `detached: true` causes pywin32 Named Pipe to hang → On Windows, use `python.exe` + `windowsHide: true` + **do not use detached** (consistent with Rust daemon)

> ✅ **Design Decision**: Rust daemon per-window is intentional to ensure window isolation and independent file processing capabilities.

---

## Summary

| Dimension | Old Architecture | v16 Architecture | Improvement |
|-----------|------------------|------------------|-------------|
| Memory (15 windows) | ~855 MB | ~155 MB | **-82%** |
| CPU (idle) | Continuous polling | Zero polling | **-100%** |
| Status Sync | ~750ms | <10ms | **-99%** |
| User Configuration | Manual selection | Zero configuration | **Automated** |
| Cross-IDE Collaboration | Not supported | Fully supported | **New capability** |

**v16 is an architectural upgrade, evolving from "going it alone" to "division of labor and collaboration".**




 (end)






//===================================================================================



# IO Engine v16 Architecture

## 概述

**v16 架构的核心变化：用户不再需要选择 IO 引擎，系统自动协作。**

| 引擎 | 职责 | 生命周期 | 内存 |
|------|------|----------|------|
| **Rust daemon** | IO 操作（剪贴板†、文件、粘贴） | per-window | ~7 MB |
| **Python Broker** | 音频播放、剪贴板监听 | 全操作系统唯一单例 | ~50 MB |
| **Shell daemon** | 剪贴板（Linux/macOS）；兜底（Windows） | per-window | ~70 MB |

> † Rust 仅在 **Windows** 上原生处理剪贴板。Linux/macOS 的剪贴板由 Shell（xclip/pngpaste）负责。

**15 窗口极端场景**：v16 仅占 **~155 MB**，对比老架构 ~855 MB，节省 **82%**。

---

## 进程标识规范

### 进程关系图

```
┌─────────────────────────────────────────────────────────────┐
│                    PROCESS HIERARCHY                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  VS Code / Cursor / Windsurf (Host Process)                  │
│      │                                                       │
│      ├── Extension Host Process                              │
│      │       │                                               │
│      │       ├── q_engine.exe [per-window, ~7MB]             │
│      │       │       ↓ stdio (JSON-RPC)                      │
│      │       │                                               │
│      │       └── [fallback] powershell.exe / bash            │
│      │               ↓ stdio (JSON-RPC)                      │
│      │                                                       │
│      └── (IPC) ──────────────────────────────────────────┐   │
│                                                          │   │
│                                                          ↓   │
│              python.exe kp.py --broker [global, ~50MB]       │
│                      ↑                                       │
│                      │ Named Pipe / Unix Socket              │
│                      │                                       │
│              (所有窗口共享此单例进程)                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 1. Rust Daemon（主 IO 引擎）

| 属性 | 值 |
|------|-----|
| **进程名** | `q_engine.exe` (Windows) / `q_engine` (macOS/Linux) |
| **文件位置** | `{extensionPath}/assets/q_engine.exe` |
| **启动参数** | `--daemon` |
| **环境变量** | `Q_PARENT_PID={父进程PID}` |
| **生命周期** | per-window，随 VS Code 窗口关闭自动退出 |
| **内存占用** | ~7 MB |
| **进程数量** | 每窗口 1 个 |

```bash
# 识别方法
# Windows
tasklist | findstr q_engine

# macOS/Linux
ps aux | grep q_engine
```

### 2. Python Broker（全局音频引擎）

| 属性 | 值 |
|------|-----|
| **进程名** | `python.exe` / `python3` |
| **Python 路径** | `{globalStorage}/python_engine/python.exe` (仅内置，禁用系统 Python) |
| **脚本文件** | `{extensionPath}/dist/kp.py` 或 `src/kp.py` |
| **启动参数** | `--broker` |
| **生命周期** | 全局单例，TTL 80s 无心跳自动退出 |
| **内存占用** | ~50 MB |
| **进程数量** | 全局 **1** 个 |

**IPC 通信路径**：

| 平台 | IPC 类型 | 路径格式 |
|------|----------|----------|
| Windows | Named Pipe | `\\.\pipe\vix_audio_broker_{RID}` (如 `vix_audio_broker_1001`) |
| macOS/Linux | Unix Socket | `/tmp/vix_audio_broker_{uid}.sock` |

**配置文件目录**：

| 平台 | 目录路径 |
|------|----------|
| Windows | `%LOCALAPPDATA%\vix_audio_broker\` |
| macOS/Linux | `~/.cache/vix_audio_broker/` |

**配置文件**：
- `endpoint.json` - IPC 端点信息（pipe/socket 路径、协议版本）
- `token.txt` - 认证令牌（Base64 编码）

```bash
# 识别方法
# Windows
wmic process where "commandline like '%kp.py%'" get processid,commandline

# macOS/Linux
ps aux | grep "kp.py.*--broker"
```

### 3. Shell Daemon（Unix 剪贴板引擎 / Windows 兜底引擎）

**平台策略：**
- **Windows**：仅在 Rust 失败时启动（兜底）。Rust 通过 Win32 API 原生处理剪贴板。
- **Linux/macOS**：**始终与 Rust 同时启动**（互补关系）。Rust 负责媒体/音频，Shell 通过 xclip/pngpaste/osascript 负责剪贴板。

> ⚠️ 自 v16 起，Rust daemon 已使用 Win7 专用目标编译。Windows 上 **所有版本（Win7+）均由 Rust 处理剪贴板**，无需 Shell。

| 平台 | 进程名 | 启动命令 |
|------|--------|----------|
| Windows | `powershell.exe` / `pwsh.exe` | `-STA -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -Command {script}` |
| macOS/Linux | `bash` | `bash -c {script}` |

| 属性 | 值 |
|------|-----|
| **生命周期** | per-window |
| **内存占用** | ~70 MB (PowerShell) / ~20 MB (Bash) |
| **进程数量** | Windows: 0（正常）/ 1（兜底）；Linux/macOS: **每窗口 1 个**（始终启动） |

```bash
# 识别方法
# Windows
wmic process where "name='powershell.exe'" get processid,commandline | findstr /i "qqq\|vix"

# macOS/Linux
ps aux | grep "bash.*qqq"
```

### 常用排查命令

```bash
# === Windows ===
tasklist | findstr /i "q_engine python powershell"
wmic process where "name='q_engine.exe'" get processid,commandline
dir \\.\pipe\ | findstr vix_audio_broker

# 强制结束 (谨慎)
taskkill /f /im q_engine.exe

# === macOS / Linux ===
ps aux | grep -E "q_engine|kp.py|vix"
ls -la /tmp/*vix_audio_broker*

# 强制结束 (谨慎)
pkill -f q_engine
pkill -f "kp.py.*--broker"
```

---

## 架构对比

### v16 架构：Broker 单例 + 分工协作

```
┌─────────────────────────────────────────────────────────────┐
│                   v16 ARCHITECTURE                           │
│           (Broker 单例 + Rust 分工 + 实时广播)               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 不同 ide：VS Code、 Cursor、 Windsurf、 Trae ... 假设开了共 15 窗口             │
│  ┌──────┐  ┌──────┐   ┌──────┐                              │
│  │ Rust │  │ Rust │   │ Rust │    ← 每窗口独立 Rust          │
│  │(7MB) │  │(7MB) │   │(7MB) │      处理 IO 操作             │
│  └──┬───┘  └──┬───┘   └──┬───┘                              │
│     │         │          │                                   │
│     │    IPC (Named Pipe / Unix Socket)                      │
│     │         │          │                                   │
│     └─────────┼──────────┘                                   │
│               ↓                                              │
│     ┌─────────────────────┐                                  │
│     │   Python Broker     │  ← 全局唯一，所有窗口共享        │
│     │      (~50 MB)       │                                  │
│     │  • 音频播放         │                                  │
│     │  • 剪贴板监听       │                                  │
│     │  • 状态广播 ────────┼──→ 实时推送到所有窗口            │
│     └─────────────────────┘                                  │
│                                                              │
│  优势：状态实时同步、内存节省82%、零配置                     │
└─────────────────────────────────────────────────────────────┘
```

### 老架构：每窗口独立 daemon

```
┌─────────────────────────────────────────────────────────────┐
│                    OLD ARCHITECTURE                          │
│              (每窗口独立 daemon，互不通信)                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  VS Code Window 1          VS Code Window 2                  │
│  ┌────────────────┐        ┌────────────────┐               │
│  │ Python daemon  │        │ Python daemon  │    ...×15     │
│  │   (~50 MB)     │        │   (~50 MB)     │               │
│  │ Rust daemon    │        │ Rust daemon    │               │
│  │   (~7 MB)      │        │   (~7 MB)      │               │
│  └────────────────┘        └────────────────┘               │
│                                                              │
│  问题：状态不同步、内存爆炸、用户需手动选择引擎               │
└─────────────────────────────────────────────────────────────┘
```

> 📖 延伸阅读：[IO_ENGINE.md](https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE.md)

---

## 性能对比

### 内存占用

| 场景 | 老架构 | v16 架构 | 节省 |
|------|--------|----------|------|
| 1 窗口 | ~57 MB | ~57 MB | 0% |
| 5 窗口 | ~285 MB | ~85 MB | **70%** |
| **15 窗口** | **~855 MB** | **~155 MB** | **82%** |
| 20 窗口 | ~1140 MB | ~190 MB | **83%** |

**公式**：
- 老架构：`N × 57MB`
- v16：`N × 7MB + 50MB`

### 其他指标

| 指标 | 老架构 | v16 架构 |
|------|--------|----------|
| 启动时间 | 每窗口 ~2-3s | 首窗口后 ~50ms |
| 状态同步 | 轮询 ~1.5s | 广播 <10ms |
| 空闲 CPU | 持续轮询 | **零轮询** |

---

## 稳定性与平台支持

### 故障隔离

| 场景 | 老架构 | v16 架构 |
|------|--------|----------|
| Python 崩溃 | 窗口功能全失效 | 仅音频不可用 |
| Rust 崩溃 | 窗口 IO 失效 | 相同 |
| 进程泄漏 | N 个可能泄漏 | 仅 1 个，TTL 自动回收 |

### 跨平台

| 平台 | v16 策略 |
|------|----------|
| Windows 10+ | ✅ Rust daemon + Named Pipe IPC |
| Windows 7/8 | ✅ Rust daemon (Win7 目标编译) + Named Pipe IPC |
| macOS/Linux | ✅ Rust daemon + Unix Socket IPC |
| ARM64 | ✅ Rust 跨平台编译 |

> Win7 兼容通过 `x86_64-win7-windows-msvc` / `i686-win7-windows-msvc` 目标编译实现，无需 Shell fallback。

---

## 已知问题

### 老架构问题（已解决）

| 严重程度 | 问题 | v16 解决方案 |
|----------|------|--------------|
| 🔴 致命 | 内存线性增长（15窗口 ~855MB） | Broker 单例，降至 ~155MB |
| 🔴 致命 | 多窗口状态不同步 | IPC 广播，<10ms 实时同步 |
| 🟠 严重 | 用户需手动选择 IO 引擎 | 自动协作，零配置 |
| 🟠 严重 | 空闲时持续轮询占用 CPU | 事件驱动，零轮询 |
| 🟡 中等 | 每窗口启动 Python 需 2-3s | 首次后直连 ~50ms |
| 🟡 中等 | 跨 IDE 无法协作 | Broker 统一管理 |
| 🟢 轻微 | 热重载残留僵尸进程 | TTL 80s 自动回收 |

### v16 当前问题

| 严重程度 | 问题 | 缓解措施 |
|----------|------|----------|
| 🟡 中等 | Named Pipe 可能被安全软件拦截 | 提示用户添加白名单 |
| 🟢 轻微 | 首次连接需等待 Broker 启动 | 6 秒延迟启动 |

> ✅ **已解决**：`detached: true` 会导致 pywin32 Named Pipe 挂起 → Windows 上使用 `python.exe` + `windowsHide: true` + **不使用 detached**（与 Rust daemon 保持一致）

> ✅ **设计决策**：Rust daemon per-window 是有意为之，确保窗口隔离性和独立文件处理能力。

---

## 总结

| 维度 | 老架构 | v16 架构 | 改进 |
|------|--------|----------|------|
| 内存 (15窗口) | ~855 MB | ~155 MB | **-82%** |
| CPU (空闲) | 持续轮询 | 零轮询 | **-100%** |
| 状态同步 | ~750ms | <10ms | **-99%** |
| 用户配置 | 手动选择 | 零配置 | **自动化** |
| 跨 IDE 协作 | 不支持 | 完全支持 | **新能力** |

**v16 是架构级升级，从"单打独斗"进化为"分工协作"。**


 (end)






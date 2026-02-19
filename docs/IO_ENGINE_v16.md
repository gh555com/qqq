# IO Engine v16 Architecture

## 概述

**v16 架构的核心变化：用户不再需要选择 IO 引擎，系统自动协作。**

| 引擎 | 职责 | 生命周期 | 内存 |
|------|------|----------|------|
| **Rust daemon** | IO 操作（剪贴板、文件、粘贴） | per-window | ~7 MB |
| **Python Broker** | 音频播放、剪贴板监听 | 全操作系统唯一单例 | ~50 MB |
| **Shell fallback** | 兜底（仅 Rust 异常时） | per-window | ~70 MB |

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
| **Python 路径** | `{globalStorage}/python_engine/python.exe` (内置) 或系统 python |
| **脚本文件** | `{extensionPath}/dist/kp.py` 或 `src/kp.py` |
| **启动参数** | `--broker` |
| **生命周期** | 全局单例，TTL 80s 无心跳自动退出 |
| **内存占用** | ~50 MB |
| **进程数量** | 全局 **1** 个 |

**IPC 通信路径**：

| 平台 | IPC 类型 | 路径格式 |
|------|----------|----------|
| Windows | Named Pipe | `\\.\pipe\vix_audio_broker_{USERDOMAIN}_{USERNAME}_{SESSIONNAME}` |
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

### 3. Shell Daemon（兜底引擎）

仅在 Rust daemon 启动异常时自动启用（如二进制损坏、被杀毒软件拦截等极端情况）。

> ⚠️ 自 v16 起，Rust daemon 已使用 Win7 专用目标编译，正常情况下 **所有 Windows 版本（Win7+）均使用 Rust**，无需 Shell fallback。

| 平台 | 进程名 | 启动命令 |
|------|--------|----------|
| Windows | `powershell.exe` / `pwsh.exe` | `-STA -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -Command {script}` |
| macOS/Linux | `bash` | `bash -c {script}` |

| 属性 | 值 |
|------|-----|
| **生命周期** | per-window |
| **内存占用** | ~70 MB (PowerShell) / ~20 MB (Bash) |
| **进程数量** | 0 (正常) / 每窗口 1 个 (fallback) |

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

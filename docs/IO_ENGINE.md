








## IO Engine Multi-Dimensional Quantitative Scoring （下方有中文版）

### Overview

This project includes three different IO processing engines, each with its own strengths and trade-offs. This document provides **quantitative scores across 13 dimensions** (1–10 points, where 10 is best) to help clarify the best-fit scenarios for each engine.

Especially for the **Rust engine**: the **official gh555.com release** must be **version 16.0.0 or later** to support the Rust engine.


| Engine                | Label | Implementation                       | Positioning              |
| :-------------------- | :--- | :----------------------------------- | :----------------------- |
| **Python Engine**     | P    | `kp.py` + ctypes/pywin32             | Best value-for-money     |
| **Rust Engine**       | R    | Compiled binary `.exe`               | Peak performance         |
| **Node Shell Daemon** | N(D) | Long-running PowerShell/Bash process | Zero-dependency fallback |

---

## 1. Overall Score Summary

| Dimension                         | Python |  Rust  | Node Shell | Weight | Notes                               |
| :-------------------------------- | :----: | :----: | :--------: | :----: | :---------------------------------- |
| 1. Cold Start Speed               |    6   |    9   |      5     |   ★★☆  | First-launch overhead               |
| 2. Hot Response Latency           |    8   |   10   |      7     |   ★★★  | Single-call cost in daemon mode     |
| 3. Memory Footprint               |    5   |   10   |      4     |   ★★☆  | Resident memory usage               |
| 4. CPU Efficiency                 |    7   |   10   |      5     |   ★★☆  | CPU usage under intensive workloads |
| 5. Clipboard – Transparent Images | **10** | **10** |      3     |   ★★★  | DIBv5 / alpha channel handling      |
| 6. Clipboard – File Drop          |    9   |    9   |      8     |   ★★☆  | Reading CF_HDROP file lists         |
| 7. Clipboard – HTML               |    9   |    8   |      7     |   ★★☆  | HTML Format parsing                 |
| 8. Bulk File Copy                 |    8   | **10** |      5     |   ★★☆  | Recursive copy of many small files  |
| 9. System Compatibility           |    8   |    7   |   **10**   |   ★★★  | Runs without extra dependencies     |
| 10. Stability                     |    8   |    9   |      9     |   ★★★  | Crash rate over long runtimes       |
| 11. Dev & Maintenance Cost        | **10** |    5   |      7     |   ★☆☆  | Readability, iteration speed        |
| 12. Cross-Platform Capability     |    7   |    8   |    **8**   |   ★☆☆  | Win/macOS/Linux coverage            |
| 13. File Icon Extraction          |    9   |    9   |    **9**   |   ★★☆  | Multi-platform native APIs          |

### Weighted Total Scores

| Engine         | Raw Total | Weighted Total | Recommended Scenarios                                     |
| :------------- | :-------: | :------------: | :-------------------------------------------------------- |
| **Python**     |    104    |    **98.2**    | Transparent-image clipboard, everyday advanced operations |
| **Rust**       |    114    |   **104.8**    | Extreme performance, huge-scale bulk file operations      |
| **Node Shell** |     87    |    **89.8**    | Zero-dependency fallback, simple text/files               |

> Weighting formula: ★★★ = 1.2x, ★★☆ = 1.0x, ★☆☆ = 0.8x

---

## 2. Detailed Analysis by Dimension

### 1. Cold Start Speed

| Engine     | Score | Typical Time | Bottleneck                        |
| :--------- | :---: | :----------: | :-------------------------------- |
| Python     |   6   |  800–1500ms  | Interpreter init + module imports |
| Rust       |   9   |   50–150ms   | Near-zero overhead                |
| Node Shell |   5   |  1000–2000ms | PowerShell CLR load time          |

**Conclusion:** Rust has the fastest cold start; Python/Shell are limited by runtime initialization.

---

### 2. Hot Response Latency

In daemon mode, the process stays resident; a single RPC call typically costs:

| Engine     | Score | Typical Latency | Notes                               |
| :--------- | :---: | :-------------: | :---------------------------------- |
| Python     |   8   |      5–20ms     | JSON-RPC over stdio                 |
| Rust       |   10  |      1–5ms      | Minimal overhead                    |
| Node Shell |   7   |     10–50ms     | PowerShell command parsing overhead |

**Conclusion:** Rust responds fastest, Python next; Shell is slower due to cmdlet parsing.

---

### 3. Memory Footprint

| Engine     | Score | Resident Memory | Notes                            |
| :--------- | :---: | :-------------: | :------------------------------- |
| Python     |   5   |     25–50MB     | Interpreter + dependencies       |
| Rust       |   10  |      2–8MB      | Statically compiled, minimal     |
| Node Shell |   4   |     40–100MB    | PowerShell CLR overhead is heavy |

**Conclusion:** Rust is the most memory-efficient—ideal for low-spec devices or always-on listeners.

---

### 4. CPU Efficiency

CPU usage during bulk file operations:

| Engine     | Score | CPU Usage | Notes                                  |
| :--------- | :---: | :-------: | :------------------------------------- |
| Python     |   7   |   15–30%  | GIL limits; multithreading constrained |
| Rust       |   10  |   5–15%   | Rayon parallelism; zero GC             |
| Node Shell |   5   |   20–40%  | Cmdlets often serial; low efficiency   |

**Conclusion:** Rust has the best CPU efficiency. Python is acceptable but constrained by the GIL.

---

### 5. Clipboard – Transparent Image Handling (DIBv5 Alpha)

**This is the key dimension when choosing an engine!**

| Engine     |  Score | Capability       | Issues                                       |
| :--------- | :----: | :--------------- | :------------------------------------------- |
| Python     | **10** | Perfect fidelity | Reads CF_DIBV5 via ctypes + decodes with PIL |
| Rust       | **10** | Perfect fidelity | Direct Win32 API calls                       |
| Node Shell |    3   | Alpha lost       | Known GDI+ issue → background turns black    |

**Technical Reasons:**

* When Chrome/Edge copies images with an alpha channel, it places them into the clipboard as `CF_DIBV5`
* PowerShell’s `[Clipboard]::GetImage()` relies on GDI+ under the hood
* GDI+ has a **premultiplied-alpha handling bug** with DIBv5, causing transparent backgrounds to appear black
* Python/Rust can read the raw memory block directly, bypassing GDI+ entirely

**Conclusion:** For transparent images, you must use Python or Rust.

---

### 6. Clipboard – File Drop List (CF_HDROP)

| Engine     | Score | Capability   | Notes                            |
| :--------- | :---: | :----------- | :------------------------------- |
| Python     |   9   | Full support | Two paths: pywin32 / ctypes      |
| Rust       |   9   | Full support | Win32 API                        |
| Node Shell |   8   | Full support | `[Clipboard]::GetFileDropList()` |

**Conclusion:** All three can read file lists correctly; differences are minor.

---

### 7. Clipboard – HTML Content (HTML Format)

| Engine     | Score | Capability    | Notes                              |
| :--------- | :---: | :------------ | :--------------------------------- |
| Python     |   9   | Full support  | Reads CF_HTML raw bytes directly   |
| Rust       |   8   | Full support  | Requires careful encoding handling |
| Node Shell |   7   | Basic support | Stream conversions sometimes fail  |

**Conclusion:** Python is the most stable for HTML Format handling.

---

### 8. Bulk File Copy (Large-Scale)

Copying 10,000+ small files (e.g., `node_modules`):

| Engine     |  Score | Performance    | Implementation                      |
| :--------- | :----: | :------------- | :---------------------------------- |
| Python     |    8   | Fast           | `concurrent.futures` multithreading |
| Rust       | **10** | Extremely fast | Rayon data parallelism              |
| Node Shell |    5   | Slow           | `Copy-Item` is often serial         |

**Conclusion:** Rust has a clear advantage for large-scale file operations.

---

### 9. System Compatibility

| Engine     |  Score | Dependencies                | Notes                             |
| :--------- | :----: | :-------------------------- | :-------------------------------- |
| Python     |    8   | Requires Python runtime     | Most developers already have it   |
| Rust       |    7   | Needs distributing binaries | Per-platform builds required      |
| Node Shell | **10** | No extra dependencies       | PowerShell is built-in on Windows |

**Conclusion:** Node Shell has the best out-of-the-box compatibility.

---

### 10. Stability

| Engine     | Score |   Crash Rate  | Notes                         |
| :--------- | :---: | :-----------: | :---------------------------- |
| Python     |   8   |      Low      | Occasional GIL deadlock risks |
| Rust       |   9   | Extremely low | Memory-safe; no GC pauses     |
| Node Shell |   9   | Extremely low | Mature and stable             |

**Conclusion:** All three are fairly stable; Rust has a slight edge.

---

### 11. Development & Maintenance Cost

| Engine     |  Score |  Code Size  | Iteration Speed                   |
| :--------- | :----: | :---------: | :-------------------------------- |
| Python     | **10** |  ~800 lines | Very high—edit and run            |
| Rust       |    5   | ~1500 lines | Lower—compile time, strict typing |
| Node Shell |    7   |  ~300 lines | Medium—PowerShell syntax quirks   |

**Conclusion:** Python offers the highest dev velocity; Rust has the highest barrier.

---

### 12. Cross-Platform Capability

| Engine     | Score | Windows | macOS | Linux |
| :--------- | :---: | :-----: | :---: | :---: |
| Python     |   7   |   ★★★   |  ★★☆  |  ★★☆  |
| Rust       |   8   |   ★★★   |  ★★★  |  ★★★  |
| Node Shell |   6   |   ★★★   |  ★☆☆  |  ★☆☆  |

**Conclusion:** Rust is best for cross-platform. Node Shell is significantly weaker outside Windows.

---

### 13. File Icon Extraction (System Level)

| Engine     | Score | Implementation | Stability |
| :--------- | :---: | :------------- | :-------- |
| Python     |   9   | Win32 API via ctypes | High |
| Rust       |   9   | Direct Win32 API | High |
| Node Shell |   9   | Multi-platform Native | Very High |

**Technical Details:**
- **Python/Rust**: Use `SHGetFileInfo` (Windows) to retrieve exact system icons.
- **Node Shell**: Implements a **multi-tier cross-platform strategy**:
    1. **Tier 1 (Windows)**: C# injection for high-quality 32x32 icons, with native PowerShell `ExtractAssociatedIcon` as fallback.
    2. **Tier 2 (macOS)**: Zero-dependency native support using `osascript` to call `NSWorkspace`.
    3. **Tier 3 (Linux)**: Native support via `python3-gi` (Gio/GdkPixbuf) for best integration with system icon themes.
- **Reliability**: As long as the Node Shell Daemon starts (guaranteed by built-in `bash` or `powershell`), icons can be extracted on any system.

---

## 3. Scenario Recommendation Matrix

| Scenario                                    | Recommended Engine | Why                                     |
| :------------------------------------------ | :----------------: | :-------------------------------------- |
| Daily screenshot paste (transparent images) |     **Python**     | Perfect DIBv5 handling + fast iteration |
| Huge directory copy (`node_modules`)        |      **Rust**      | Parallel IO + best CPU efficiency       |
| System file icon display (Gutter)           |   **Node Shell**   | Multi-tier fallback ensures visibility  |
| Simple text/file paste                      |   **Node Shell**   | Zero dependencies + good enough speed   |
| Low-spec device / always-on listener        |      **Rust**      | Lowest memory footprint                 |
| Rapid prototyping / debugging               |     **Python**     | Edit-and-run; no compilation            |
| Offline environment / no Python installed   |   **Node Shell**   | System built-in; no install required    |

---


 (end)













//===================================================================================




















# IO 引擎多维度量化打分

## 概要

本项目包含三种 IO 处理引擎，各有优劣。本文档从 **13 个维度** 进行量化打分（1-10 分，10 分最优），帮助理解各引擎的适用场景。

特别对于 **Rust 引擎**：**gh555.com 官方版**的版本号要**大于等于 16.0.0** 才支持 Rust 引擎。


| 引擎 | 标志 | 实现方式 | 定位 |
|:-----|:-----|:---------|:-----|
| **Python Engine** | P | `kp.py` + ctypes/pywin32 | 最高性价比 |
| **Rust Engine** | R | 编译二进制 `.exe` | 极致性能 |
| **Node Shell Daemon** | N(D) | PowerShell/Bash 长驻进程 | 0依赖兜底 |

---

## 1. Overall Score Summary

| 维度 | Python | Rust | Node Shell | 权重 | 说明 |
|:-----|:------:|:----:|:----------:|:----:|:-----|
| 1. 冷启动速度 | 6 | 9 | 5 | ★★☆ | 首次启动耗时 |
| 2. 热响应延迟 | 8 | 10 | 7 | ★★★ | Daemon 模式下单次调用耗时 |
| 3. 内存占用 | 5 | 10 | 4 | ★★☆ | 常驻内存消耗 |
| 4. CPU 效率 | 7 | 10 | 5 | ★★☆ | 密集操作时 CPU 占用 |
| 5. 剪贴板-透明图 | **10** | **10** | 3 | ★★★ | DIBv5/Alpha 通道处理 |
| 6. 剪贴板-文件 | 9 | 9 | 8 | ★★☆ | CF_HDROP 文件列表读取 |
| 7. 剪贴板-HTML | 9 | 8 | 7 | ★★☆ | HTML Format 解析 |
| 8. 文件批量复制 | 8 | **10** | 5 | ★★☆ | 大量小文件递归复制 |
| 9. 系统兼容性 | 8 | 7 | **10** | ★★★ | 无需额外依赖即可运行 |
| 10. 稳定性 | 8 | 9 | 9 | ★★★ | 长期运行崩溃率 |
| 11. 开发维护成本 | **10** | 5 | 7 | ★☆☆ | 代码可读性、迭代效率 |
| 12. 跨平台能力 | 7 | 8 | **8** | ★☆☆ | Win/Mac/Linux 支持程度 |
| 13. 文件原始图标提取 | 9 | 9 | **9** | ★★☆ | 多平台原生 API 支持 |

### Weighted Total Scores

| 引擎 | 原始总分 | 加权总分 | 推荐场景 |
|:-----|:--------:|:--------:|:---------|
| **Python** | 104 | **98.2** | 透明图剪贴板、日常高级操作 |
| **Rust** | 114 | **104.8** | 极致性能、超大文件批量操作 |
| **Node Shell** | 87 | **89.8** | 零依赖兜底、简单文本/文件 |

> 加权公式：★★★=1.2x, ★★☆=1.0x, ★☆☆=0.8x

---

## 2. Detailed Analysis by Dimension

### 1. Cold Start Speed

| 引擎 | 得分 | 典型耗时 | 瓶颈 |
|:-----|:----:|:--------:|:-----|
| Python | 6 | 800-1500ms | 解释器初始化 + 模块导入 |
| Rust | 9 | 50-150ms | 几乎无开销 |
| Node Shell | 5 | 1000-2000ms | PowerShell CLR 加载 |

**Conclusion:** Rust 冷启动最快，Python/Shell 受限于运行时初始化。

---

### 2. Hot Response Latency

Daemon 模式下，进程已驻留，单次 RPC 调用耗时：

| 引擎 | 得分 | 典型延迟 | 说明 |
|:-----|:----:|:--------:|:-----|
| Python | 8 | 5-20ms | JSON-RPC over stdio |
| Rust | 10 | 1-5ms | 极低开销 |
| Node Shell | 7 | 10-50ms | PowerShell 命令解析开销 |

**Conclusion:** Rust 响应最快，Python 次之，Shell 因 cmdlet 解析较慢。

---

### 3. Memory Footprint

| 引擎 | 得分 | 常驻内存 | 说明 |
|:-----|:----:|:--------:|:-----|
| Python | 5 | 25-50MB | 解释器 + 依赖库 |
| Rust | 10 | 2-8MB | 静态编译，极简 |
| Node Shell | 4 | 40-100MB | PowerShell CLR 开销大 |

**Conclusion:** Rust 内存最省，适合低配设备或常驻监听场景。

---

### 4. CPU Efficiency

批量文件操作时 CPU 占用率：

| 引擎 | 得分 | CPU 占用 | 说明 |
|:-----|:----:|:--------:|:-----|
| Python | 7 | 15-30% | GIL 限制，多线程受限 |
| Rust | 10 | 5-15% | Rayon 并行，零 GC |
| Node Shell | 5 | 20-40% | cmdlet 串行，效率低 |

**Conclusion:** Rust CPU 效率最高，Python 受 GIL 限制但可接受。

---

### 5. Clipboard – Transparent Image Handling (DIBv5 Alpha)

**这是选择引擎的关键维度！**

| 引擎 | 得分 | 能力 | 问题 |
|:-----|:----:|:-----|:-----|
| Python | **10** | 完美还原 | ctypes 直读 CF_DIBV5 + PIL 解码 |
| Rust | **10** | 完美还原 | Win32 API 直接调用 |
| Node Shell | 3 | Alpha 丢失 | GDI+ 的已知缺陷，背景变黑 |

**Technical Reasons:**
* Chrome/Edge 复制带透明通道的图片时，放入 `CF_DIBV5` 格式
* PowerShell 的 `[Clipboard]::GetImage()` 底层依赖 GDI+
* GDI+ 处理 DIBv5 时存在 **预乘 Alpha 错误**，导致透明背景变黑
* Python/Rust 可以直接读取原始内存块，绕过 GDI+ 缺陷

**Conclusion:** 处理透明图必须使用 Python 或 Rust.

---

### 6. Clipboard – File Drop List (CF_HDROP)

| 引擎 | 得分 | 能力 | 说明 |
|:-----|:----:|:-----|:-----|
| Python | 9 | 完整支持 | pywin32/ctypes 双路径 |
| Rust | 9 | 完整支持 | Win32 API |
| Node Shell | 8 | 完整支持 | `[Clipboard]::GetFileDropList()` |

**Conclusion:** 三者都能正确读取文件列表，差异不大。

---

### 7. Clipboard – HTML Content (HTML Format)

| 引擎 | 得分 | 能力 | 说明 |
|:-----|:----:|:-----|:-----|
| Python | 9 | 完整支持 | 直接读取 CF_HTML 原始字节 |
| Rust | 8 | 完整支持 | 需处理编码 |
| Node Shell | 7 | 基本支持 | Stream 转换有时出问题 |

**Conclusion:** Python 对 HTML Format 的处理最稳定。

---

### 8. Bulk File Copy (Large-Scale)

复制 10,000+ 小文件（如 node_modules）：

| 引擎 | 得分 | 性能 | 实现 |
|:-----|:----:|:-----|:-----|
| Python | 8 | 较快 | `concurrent.futures` 多线程 |
| Rust | **10** | 极快 | Rayon 数据并行 |
| Node Shell | 5 | 较慢 | `Copy-Item` 串行 |

**Conclusion:** Rust 在大规模文件操作时优势明显。

---

### 9. System Compatibility

| 引擎 | 得分 | 依赖 | 说明 |
|:-----|:----:|:-----|:-----|
| Python | 8 | 需 Python 环境 | 大多数开发者已有 |
| Rust | 7 | 需分发二进制 | 不同平台需不同编译 |
| Node Shell | **10** | 无额外依赖 | PowerShell 系统内置 |

**Conclusion:** Node Shell 兼容性最好，开箱即用。

---

### 10. Stability

| 引擎 | 得分 | 崩溃率 | 说明 |
|:-----|:----:|:------:|:-----|
| Python | 8 | 低 | 偶有 GIL 死锁风险 |
| Rust | 9 | 极低 | 内存安全，无 GC 暂停 |
| Node Shell | 9 | 极低 | 成熟稳定 |

**Conclusion:** 三者都比较稳定，Rust 略占优。

---

### 11. Development & Maintenance Cost

| 引擎 | 得分 | 代码量 | 迭代效率 |
|:-----|:----:|:------:|:---------|
| Python | **10** | ~800行 | 极高，改完即用 |
| Rust | 5 | ~1500行 | 低，编译慢，类型严格 |
| Node Shell | 7 | ~300行 | 中等，PS 语法怪异 |

**Conclusion:** Python 开发效率最高，Rust 门槛最高。

---

### 12. Cross-Platform Capability

| 引擎 | 得分 | Windows | macOS | Linux |
|:-----|:----:|:-------:|:-----:|:-----:|
| Python | 7 | ★★★ | ★★☆ | ★★☆ |
| Rust | 8 | ★★★ | ★★★ | ★★★ |
| Node Shell | 6 | ★★★ | ★☆☆ | ★☆☆ |

**Conclusion:** Rust 跨平台最佳，Node Shell 在非 Windows 上功能受限。

---

### 13. 文件原始图标提取 (系统级)

| 引擎 | 得分 | 实现方式 | 稳定性 |
|:-----|:----:|:---------|:-------|
| Python | 9 | ctypes 调用 Win32 API | 高 |
| Rust | 9 | 直接调用 Win32 API | 高 |
| Node Shell | 9 | 多平台原生支持 | 极高 |

**技术细节：**
- **Python/Rust**: 使用 `SHGetFileInfo` (Windows) 获取系统注册的精确图标。
- **Node Shell**: 实现了**多层级跨平台策略**：
    1. **第一层 (Windows)**: 通过 C# 注入获取 32x32 高质量图标，并以原生 PowerShell `ExtractAssociatedIcon` 方案作为兜底。
    2. **第二层 (macOS)**: 增加 `extract_icon` 指令，利用 `osascript` 提取图标。对于 macOS 用户，这是完全零依赖的原生支持。
    3. **第三层 (Linux)**: 增加基于 `python3` 的图标提取逻辑。对于 Linux 用户，只要安装了标准的 `python3-gi` 即可获得最佳效果。
- **可靠性**: 无论用户在什么系统上运行，只要 Node Shell Daemon 能够启动（这几乎是 100% 保证的，因为只需要系统自带的 `bash` 或 `powershell`），我们就能够提取并显示对应的文件图标。

---

## 3. Scenario Recommendation Matrix

| 使用场景 | 推荐引擎 | 原因 |
|:---------|:--------:|:-----|
| 日常截图粘贴（透明图） | **Python** | DIBv5 完美处理，开发快 |
| 超大目录复制（node_modules） | **Rust** | 并行 IO，CPU 效率最高 |
| 系统文件图标显示 (Gutter) | **Node Shell** | 多层回退机制确保零依赖下的可见性 |
| 简单文本/文件粘贴 | **Node Shell** | 零依赖，响应够用 |
| 低配设备/常驻监听 | **Rust** | 内存占用最低 |
| 快速原型开发/调试 | **Python** | 改完即用，无需编译 |
| 离线环境/无 Python | **Node Shell** | 系统内置，无需安装 |

---


 (end)













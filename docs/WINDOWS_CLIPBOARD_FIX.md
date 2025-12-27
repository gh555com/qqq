# Node.js 剪贴板乱码修复分析报告

## 1. 问题背景
在 Windows 平台上，当剪贴板中包含非 ASCII 字符（如俄文、中文等 UTF-8 编码内容）时，使用 Node.js 的 `child_process` 调用 PowerShell 或其他命令行工具获取剪贴板内容，经常会出现“乱码”现象（Mojibake）。

具体表现为：
- 原始文本：`спортсменке` (俄文)
- 乱码结果：`褋锌芯褉褌褋屑械薪泻械` (看似毫无关联的生僻汉字)

## 2. 根源分析 (Root Cause)

经过详细排查，乱码产生的根本原因在于 **进程间通信 (IPC) 的标准输出 (stdout) 编码转换机制**。

### 错误的数据流向（修复前）：
1. **Clipboard (内存)**: 存放着正确的 UTF-8 字节序列 (例如 `D1 81` 代表 `с`)。
2. **PowerShell (控制台)**: 读取剪贴板内容。
3. **Stdout (管道)**: PowerShell 尝试将内容打印到标准输出。
   - **关键故障点**: Windows 控制台默认使用系统代码页（如 GBK/CP936 或 CP1251）。PowerShell 可能会自作聪明地将 UTF-8 字节流错误地“解释”为当前代码页的字符，或者在输出到管道时进行二次转码。
   - 比如 `D1 81` 被错误地当成 GBK 编码解析，对应汉字 `褋`。
4. **Node.js (接收端)**: 从 stdout 管道读取数据。此时接收到的已经是被错误转码后的字节流（即 `褋` 的 UTF-8 编码 `E8 A4 8B`），而非原始的 `D1 81`。
5. **结果**: Node.js 无论如何解码，拿到的都是已经是乱码的数据。

## 3. 解决方案 (Current Fix)

我们实施了一种 **"内存直达文件" (Memory-to-File)** 的策略，彻底绕过了标准输出 (stdout) 和控制台代码页的干扰。

### 正确的数据流向（修复后）：
1. **Node.js**: 生成一段包含 C# 代码的 PowerShell 脚本。
2. **PowerShell**: 编译并运行这段 C# 代码 (利用 P/Invoke 技术)。
3. **C# (In-Process)**:
   - 调用 Windows API `OpenClipboard` 和 `GetClipboardData`。
   - 获取 `HTML Format` 的内存句柄。
   - 使用 `GlobalLock` 锁定内存，直接读取 **原始二进制字节 (Raw Bytes)**。
   - **关键操作**: 直接调用 `System.IO.File.WriteAllBytes` 将这些原始字节原封不动地写入临时文件。**不进行任何字符串转换，不经过任何控制台输出。**
4. **Node.js**:
   - 读取该临时文件 (`fs.readFileSync`)，获得与剪贴板内存中完全一致的 `Buffer`。
   - 使用 `TextDecoder('utf-8')` 对 Buffer 进行严格解码。

## 4. 为什么完全不需要 Python？

此方案利用了 PowerShell 强大的 .NET 集成能力（`Add-Type`），直接在 PowerShell 进程内执行编译后的 C# 代码来操作 Windows 底层 API。

- **无需 Python**: 所有的 API 调用（User32.dll, Kernel32.dll）都通过 C# 完成。
- **无需外部依赖**: 只需要 Windows 自带的 PowerShell。
- **纯粹的二进制流**: 整个链路中没有“文本”传输，只有“字节”传输，因此彻底杜绝了字符集编码（Charset Encoding）带来的乱码风险。

## 5. 总结
现在的流程是 **Node.js -> PowerShell (C#) -> 原始字节文件 -> Node.js**。
乱码之所以解决，是因为我们**切断了所有可能发生自动转码的中间环节（主要是 stdout）**，确保了 Node.js 拿到的字节与剪贴板内存里的字节 **100% 比特级一致**。

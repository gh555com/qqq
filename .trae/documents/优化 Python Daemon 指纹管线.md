# 优化管线：消除 Python 侧的重复指纹计算

我们现在的管线中，`qqq.js` 已经能够接收并利用指纹缓存了，这很好。
但是，**在 `kp.py` 内部存在重复计算**。上一轮为了快速生效，我在 `handle_clipboard` 的**最后**增加了一步“补充指纹”，这导致：
1.  底层函数（如 `copy_files_parallel`）为了去重已经算了一次指纹。
2.  顶层函数在返回前，又对着生成的文件算了一次指纹。

**这确实是浪费。**

同时回答你的问题：
*   **能不能删除 py 的指纹生成？** 不能。因为 Python 需要指纹来做“秒传/去重”（判断目标文件夹里是否已经有该文件）。它是生产者，必须由它产生指纹。
*   **qqq 最开始拿不到指纹？** 是的，在 Python 模式下，qqq 发起请求时没有指纹。但这没关系，qqq 会先显示 `PENDING` 状态。等 Python 处理完返回结果（带指纹）后，qqq 收到指纹并存入缓存，紧接着的预览渲染就能直接使用缓存，不会卡顿。

## 实施计划

我将深入重构 `kp.py` 的内部函数，让指纹数据“一次生成，层层透传”，彻底消除重复计算。

### 1. 修改 `kp.py` 核心函数返回值
让这些函数不仅返回路径，还返回计算过程中得到的指纹。

*   **`save_media_from_src`**:
    *   旧：返回 `Optional[Path]`
    *   新：返回 `Tuple[Optional[Path], Optional[str]]` (路径, 指纹)
    
*   **`copy_files_parallel`**:
    *   旧：返回 `List[str]` (路径列表)
    *   新：返回 `Tuple[List[str], Dict[str, str]]` (路径列表, {路径: 指纹} 字典)

### 2. 更新平台处理逻辑
更新 Windows/macOS/Linux 的处理函数，适配新的返回值结构，收集指纹。

*   **`handle_windows_pywin32` / `ctypes`**:
    *   在处理 `CF_HDROP` (文件复制) 时，收集 `copy_files_parallel` 返回的指纹。
    *   在处理 `CF_DIB` (内存截图) 时，计算并保留指纹。
    *   在处理 `HTML` 时，收集 `save_media_from_src` 返回的指纹。

*   **`handle_macos` / `handle_linux`**:
    *   同样在保存图片/HTML资源时，记录指纹。

### 3. 清理冗余代码
*   **删除** 上一轮在 `handle_clipboard` 末尾添加的 `try...catch` 补救式指纹计算代码。
*   直接将收集到的指纹放入返回的 JSON 中 (`res["fingerprint"]` 或 `res["fingerprints"]`)。

### 预期效果
*   **Python 侧**：文件 IO 和哈希计算量减半（只在去重/保存时算一次）。
*   **Node 侧**：零 IO，零计算（直接吃 Python 喂过来的指纹）。
*   **整体管线**：用户粘贴 -> Py 算指纹&存文件 -> Py 返回指纹 -> Node 存缓存 -> Node 渲染预览(命中缓存)。**全链路只有一次哈希计算。**
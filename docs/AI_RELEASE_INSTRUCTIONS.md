# 🤖 AI 发布指令系统 (v2.0)

## 📋 指令速查
| 指令 | 版本递增 | 核心动作 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **发布q3** | `patch` | 直接 Push 到 `qq` 分支 | 快速备份、小 bug 修复 |
| **发布q1** | `minor` | 创建 `release/v*` 分支并提 PR | 重要更新、需人工审查 |
| **发布q2** | `minor` | 直接 Push 到 `qq` 分支并触发 CI | 正式发布、功能上线 |

---

## ⚙️ 核心技术架构

### 1. 代码捆绑 (Bundling)
- **工具**：使用 `esbuild` 将 `src/` 源码混淆压缩并打包至 `dist/qqq.js`。
- **优势**：减少安装体积，提升启动速度，隐藏底层实现。

### 2. 多平台分包 (Platform-specific Packaging)
- **统一引擎**：在打包阶段，系统自动将 `assets/` 下的平台专用二进制（如 `q_win_x64.exe`）重命名为统一的 `q_engine[.exe]`。
- **FFmpeg 嵌入**：打包时自动从 `node_modules` 捞取对应平台的 FFmpeg 二进制并嵌入 VSIX。
- **平台覆盖**：支持 `win32-x64/arm64`, `linux-x64`, `darwin-x64/arm64`。

### 3. 环境肃清 (Ghost Process Purgatory)
- **启动协议**：插件启动时通过 `global.js` 自动清理残留的 Python (kp.py) 和 Rust (q_engine) 进程。
- **确定性**：确保新版本加载时环境绝对纯净。

---

## 📊 发布流程 (CI/CD)

1. **本地执行**：AI 执行 `node git_help.js q1/q2/q3`。
2. **云端触发**：代码推送到 `qq` 分支后，GitHub Actions 自动接管。
3. **自动化构建**：
   - 执行 `npm run bundle` 进行代码混淆。
   - 分别为 5 个平台执行 `vsce package`。
   - 自动生成 GitHub Release 并同步推送到 **VS Code Marketplace**。

---

## 🛠️ 本地维护常用命令
- `npm run bundle`: 手动执行 esbuild 编译。
- `node git_help.js package`: 在本地生成 5 个平台的 vsix 离线包。
- `node git_help.js publish`: 直接从本地触发多平台商店发布（需权限）。

# qqq IDE 终极热更架构

## 架构总览

```
壳层（编译一次，冻结）
  E:\s\wol\py\qqq-ide-src\
  └── src/qqq/           ← 新增壳层适配代码
      ├── loader/        ← gaea-loader（扫描 f/m/、读 gaea.json、注入 DI）
      ├── menu/          ← 远程菜单覆盖层（fetch JSON → MenuRegistry 运行时注入）
      ├── layout/        ← Workbench layout 定制（AuxBar 锁 + titlebar 适配）
      └── hot/           ← 远程 settings/theme/about 推送通道

载荷层（2 秒 bundle、远程可推送）
  E:\s\wol\py\qqq-modules\         ← 新建：gaea 模块开发根
  ├── core/                        ← qqq 核心能力（文件/下载/音频/视频/剪贴板...）
  │   ├── src/
  │   ├── dist/bundle.js           ← esbuild 单文件产物
  │   └── gaea.json                ← 标准清单
  ├── ai/                          ← qqq AI（聊天/记忆/agent/工具链...）
  │   ├── src/
  │   ├── dist/{bundle.js,chat.html}
  │   └── gaea.json
  └── [future-module]/             ← 将来任何新模块

运行时目录（用户机器上）
  VSCode-win32-x64/
  └── f/                           ← QDIR portable root
      ├── a/                       ← user-data
      ├── e/                       ← legacy extensions（兼容 VS Code 扩展）
      └── m/                       ← gaea modules（热更目录）
          ├── core/{bundle.js, gaea.json}
          └── ai/{bundle.js, chat.html, gaea.json}

冻结层（不再动）
  E:\s\wol\py\q3\                  ← 独立 marketplace 扩展，保持不变
```

## 核心组件

### 1. gaea.json 标准（所有模块统一清单）

```json
{
  "id": "qqq-ai",
  "version": "1.0.0",
  "name": "qqq AI",
  "entry": "dist/bundle.js",
  "capabilities": {
    "services": ["QqqAiService"],
    "commands": ["qqq-ai.ask", "qqq-ai.clear"],
    "views": {
      "auxiliarybar": { "id": "qqqAiPanel", "html": "dist/chat.html" }
    },
    "menus": {
      "commandPalette": ["qqq-ai.ask"]
    }
  },
  "permissions": ["network", "filesystem", "clipboard"],
  "hot": {
    "endpoint": "https://gh555.com/gaea/d/qqq-ai",
    "strategy": "etag"
  }
}
```

### 2. gaea-loader（壳层，src/qqq/loader/）

职责：
- Workbench 启动后扫描 `f/m/*/gaea.json`
- 用 `require()` 或 dynamic import 加载 `entry` bundle
- 调用模块导出的 `activate(ctx)` 并传入完整 DI 上下文
- DI 上下文不是 Extension API 子集，而是 Workbench 全服务暴露：
  - IViewDescriptorService、IMenuService、ICommandService
  - IFileService、IConfigurationService、INotificationService
  - 等等一切 Workbench 内部服务
- 处理模块间依赖声明（gaea.json.dependencies）

关键代码位置：`qqq-ide-src/src/vs/workbench/browser/workbench.ts`（在 startup 尾部调 loader）

### 3. 远程菜单热更（壳层，src/qqq/menu/）

VS Code custom titlebar 下菜单已是纯 HTML DOM。不需要 Webview iframe。

方案：
- 壳层启动后 fetch `gh555.com/qqq/menu.json`（ETag 缓存）
- 解析 JSON → 调用 `MenuRegistry.appendMenuItems()` 运行时注入
- 可增/删/改/重排菜单项
- 可完全隐藏原生 File/Edit/... 菜单（设 when clause 全 false）
- 远程 JSON 改变 → 用户下次启动自动生效

代价：~200 行 TypeScript，1 次编译后永久热更。

### 4. 关于"完全换菜单 UI 风格"

如果某天要换成 Notion/Ribbon/Tab 风格：
- 改壳层的 `src/vs/workbench/browser/parts/titlebar/menubarControl.ts`
- 替换渲染逻辑（不用 Webview iframe，直接改 DOM 渲染器）
- 编译 1 次，delta 推送给所有用户
- 之后菜单内容仍然走远程 JSON 热更

代价评估：~1 天壳层改动 + 1 次编译。不建议用 iframe 替换（focus/keyboard/performance 问题太多）。

## 开发流程

### 日常（90% 时间，0 编译）

```
1. 改 qqq-modules/ai/src/...
2. qide.py 点 [Bundle ai] → esbuild 2 秒出 dist/bundle.js
3. cp dist/* → VSCode-win32-x64/f/m/ai/（qide.py 自动做）
4. Ctrl+Shift+P → Developer: Reload Window → 2 秒见效
   或：关掉 qqq.exe 重开（gaea-loader 重新加载 f/m/ai/bundle.js）
```

### 发版（10% 时间）

```
1. 确认功能 OK
2. 上传 dist/bundle.js 到 gh555.com CDN
3. 用户下次启动 → gaea-loader 检测 ETag 变化 → 自动拉新 bundle → 热更生效
```

### 壳层改动（极少，每季度 0-1 次）

```
1. 改 qqq-ide-src/src/qqq/... 或 src/vs/...
2. qide.py 点 [出 portable 包]（11 分钟）
3. delta 推送给用户
```

## 实施任务

### Task 1：创建 qqq-modules 目录 + gaea.json 标准（1 天）

- 新建 `E:\s\wol\py\qqq-modules\`
- 新建 `core/` 和 `ai/` 子目录
- 从 q3 提取 qqq-ai 的核心能力到 `qqq-modules/ai/src/`
- 定义 `gaea-manifest.schema.json`（所有模块遵循）
- 为 core 和 ai 各写 `gaea.json`
- 配 esbuild.config.js（每个模块独立 bundle）

### Task 2：实现 gaea-loader（壳层，2-3 天）

- 在 `qqq-ide-src/src/qqq/loader/` 编写 loader
- loader 扫描 `f/m/*/gaea.json`
- 动态 require 模块 entry
- 暴露 Workbench DI 全服务给模块
- 处理模块 activate/deactivate 生命周期
- 将 loader 注入到 workbench.ts 启动序列
- 编译 + 验证模块加载正常

### Task 3：实现远程菜单热更（壳层，1 天）

- 在 `qqq-ide-src/src/qqq/menu/` 编写远程菜单覆盖层
- fetch `gh555.com/qqq/menu.json` + ETag 缓存
- 运行时 MenuRegistry 注入/覆盖
- 编译 + 验证菜单热更生效

### Task 4：实现远程 settings/about 热更（壳层，1 天）

- 远程 settings overlay（fetch JSON → override 本地 defaults）
- About 对话框改为加载远程 HTML
- 编译 + 验证

### Task 5：迁移 qqq-ai 到 gaea 模块（2-3 天）

- 从 q3/ai 提取 AI 核心逻辑到 `qqq-modules/ai/src/`
- 改写 activate() 接口：接收 DI ctx 而非 vscode.ExtensionContext
- AuxBar 面板注册改为通过 gaea.json capabilities 声明
- chat.html 保持独立（Webview ETag 热更）
- bundle + 放到 f/m/ai/ + 验证

### Task 6：迁移 qqq-core 到 gaea 模块（2-3 天）

- 从 q3 提取核心能力（文件管理/下载/音频/视频/剪贴板...）
- 改写 activate() 接口
- commands/views 通过 gaea.json 声明
- bundle + 放到 f/m/core/ + 验证

### Task 7：qide.py 适配新流程（0.5 天）

- 新增按钮组：Bundle core / Bundle ai / Sync to f/m/
- 修复 yarn watch EBADF（给 subprocess 传 stdin=DEVNULL）
- 修复 dev 模式 qqqAiViewAux 未注册问题
- 新增"远程推送 bundle"按钮（上传到 gh555.com CDN）

### Task 8：冻结壳层 + 出最终 portable 包（0.5 天）

- 完成所有壳层改动后出一次 portable 包
- 验证 gaea-loader 正确加载 f/m/ 下所有模块
- 验证远程菜单/settings/about 热更
- 此后壳层进入冻结状态

## 总工期：10-14 天

## 关键收益

| 维度 | 现在 | 新架构后 |
|---|---|---|
| 改 AI 逻辑 | 编译 11 分钟 | 2 秒 bundle + reload |
| 推送给用户 | 重新发 portable zip | CDN 上传，用户自动拉取 |
| 新增模块 | 改源码 + 编译 | 新建文件夹 + gaea.json，0 编译 |
| 菜单热更 | 不可能 | 改 JSON 即生效 |
| Settings 热更 | 不可能 | 改 JSON 即生效 |
| 壳层编译频率 | 每次改都要 | 每季度 0-1 次 |

## 风险与应对

1. **gaea-loader 安全性**：模块可访问全 DI = 无沙盒。应对：只加载签名校验通过的 bundle（gaea.json 内置 sha256）
2. **模块间冲突**：两个模块注册同一 command/view。应对：loader 做 id 前缀隔离
3. **VS Code 上游升级**：壳层冻结后不跟进上游。应对：本就是设计意图（冻结 = 不升级）

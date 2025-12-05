<!-- File: .qoder/repowiki/zh/content/API 参考/API 参考.md -->
# API 参考

<cite>
**本文档中引用的文件**
- [package.json](file://package.json)
- [extension.js](file://extension.js)
- [src/qqq.js](file://src/qqq.js)
- [src/q1.js](file://src/q1.js)
- [src/q2.js](file://src/q2.js)
- [src/kp.py](file://src/kp.py)
- [src/ConfigManager.js](file://src/ConfigManager.js)
- [src/q2.html](file://src/q2.html)
</cite>

## 目录
1. [简介](#简介)
2. [VSCode 命令](#vscode-命令)
3. [扩展点](#扩展点)
4. [核心模块接口](#核心模块接口)
5. [Webview 消息通信](#webview-消息通信)
6. [错误码与事件](#错误码与事件)

## 简介
本文档详细记录了 `qqq` VSCode 扩展的 API 接口，涵盖 `package.json` 中声明的所有命令与扩展点。文档化了 `q1.js`、`kp.py`、`q2.js` 和 `ConfigManager.js` 等核心模块的公共接口、调用方式及数据格式，为二次开发提供坚实基础。

## VSCode 命令
`qqq` 扩展在 `package.json` 的 `contributes.commands` 字段中声明了以下命令，这些命令可通过 VSCode 命令面板或快捷键触发。

### qqq.q1
- **Command ID**: `qqq.q1`
- **标题**: `q1`
- **快捷键绑定**:
  - `Ctrl+V` (Windows/Linux)
  - `Cmd+V` (macOS)
- **触发条件 (when clause)**: `editorTextFocus && !editorReadonly`
- **功能**: 执行剪贴板粘贴逻辑。该命令会调用 `kp.py` 脚本读取剪贴板内容，根据内容类型（文本、图片、文件等）执行相应操作，并将结果插入到当前编辑器光标位置。

**Section sources**
- [package.json](file://package.json#L27-L29)
- [src/q1.js](file://src/q1.js#L261-L262)

### qqq.toggleBlockMode
- **Command ID**: `qqq.toggleBlockMode`
- **标题**: `切换块模式`
- **快捷键绑定**: 无
- **触发条件 (when clause)**: 无
- **功能**: 切换图片渲染的“块模式”。在块模式下，图片装饰的边距会调整，以实现不同的视觉效果。

**Section sources**
- [package.json](file://package.json#L29-L31)
- [src/q1.js](file://src/q1.js#L262-L263)

### qqq.q2
- **Command ID**: `qqq.q2`
- **标题**: `q2`
- **快捷键绑定**: `F2`
- **触发条件 (when clause)**: `editorTextFocus && !editorReadonly`
- **功能**: 打开“新建文件”对话框（Webview 面板），用于在指定目录下创建新文件或文件夹。

**Section sources**
- [package.json](file://package.json#L31-L33)
- [src/q2.js](file://src/q2.js#L1417-L1422)

### qqq.saveAsDialog
- **Command ID**: `qqq.saveAsDialog`
- **标题**: `qqq: 新建文件...`
- **快捷键绑定**: 无
- **触发条件 (when clause)**: 无
- **功能**: 与 `qqq.q2` 命令功能相同，是打开“新建文件”对话框的另一个入口。

**Section sources**
- [package.json](file://package.json#L33-L35)
- [src/q2.js](file://src/q2.js#L1417-L1422)

## 扩展点
`qqq` 扩展通过 `package.json` 中的 `contributes` 字段定义了以下扩展点。

### 配置 (Configuration)
扩展定义了一个名为 `QQQ 扩展设置` 的配置区域，包含以下可配置项：
- **qqq.showHistoryRecycleBin**
  - **类型**: `boolean`
  - **默认值**: `true`
  - **描述**: 是否在文件导航中显示历史回收站。

**Section sources**
- [package.json](file://package.json#L15-L22)

### 快捷键 (Keybindings)
扩展定义了以下快捷键绑定：
- `qqq.q1` 命令绑定到 `Ctrl+V` 和 `Cmd+V`。
- `qqq.q2` 命令绑定到 `F2`。

**Section sources**
- [package.json](file://package.json#L35-L44)

## 核心模块接口
本节文档化了各核心 JavaScript 模块暴露的公共接口。

### q1.js 模块
`src/q1.js` 模块负责处理剪贴板粘贴和图片渲染。

#### executeClipboardCommand()
- **功能**: 执行剪贴板粘贴命令的入口函数。它会调用 `runPythonScript` 函数来启动 `kp.py` 脚本。
- **参数**: 无
- **返回值**: 无

#### handleResult(result)
- **功能**: 处理从 `kp.py` 脚本返回的结果，并根据结果类型执行相应操作（如插入文本、渲染图片等）。
- **参数**:
  - `result` (Object): 从 `kp.py` 返回的 JSON 对象，包含 `type` 字段（如 `text`, `image`, `file` 等）。
- **返回值**: 无

#### renderImages(editor)
- **功能**: 异步渲染编辑器中的图片。它会查找文本中 `[路径]` 格式的标记，并将其渲染为内联图片。
- **参数**:
  - `editor` (vscode.TextEditor): 要渲染的文本编辑器实例。
- **返回值**: 无

#### toggleBlockMode()
- **功能**: 切换全局的块模式状态，并触发当前编辑器的图片重新渲染。
- **参数**: 无
- **返回值**: 无

**Section sources**
- [src/q1.js](file://src/q1.js#L100-L260)

### kp.py 模块
`src/kp.py` 模块是 Python 脚本，负责与系统剪贴板交互。

#### 主要功能
- **读取剪贴板**: 支持 Windows、macOS 和 Linux 平台。
- **处理内容类型**:
  - **文件路径**: 复制文件到固定目录 `D:/view/p`。
  - **文本**: 直接返回文本内容。
  - **图片**: 保存为 PNG 格式，文件名使用时间戳。
- **文件命名**: 使用 `get_timestamp_filename()` 函数生成包含日期、星期、毫秒、随机字符和时间的唯一文件名。

**Section sources**
- [src/kp.py](file://src/kp.py#L1-L532)

### q2.js 模块
`src/q2.js` 模块负责管理 Webview 面板和文件导航功能。

#### showSaveAsDialog(context)
- **功能**: 创建并显示“新建文件”Webview 面板。
- **参数**:
  - `context` (vscode.ExtensionContext): 扩展上下文。
- **返回值**: 无

#### updateResourceExplorer()
- **功能**: 更新 Webview 中的文件列表，显示当前路径下的目录和文件。
- **参数**: 无
- **返回值**: 无

#### getDirectoryContents(dirPath)
- **功能**: 获取指定目录下的所有子目录和文件信息。
- **参数**:
  - `dirPath` (string): 目录的完整路径。
- **返回值**: Object - 包含 `dirs` 和 `files` 数组的对象，每个条目包含名称、路径、类型和修改时间。

**Section sources**
- [src/q2.js](file://src/q2.js#L1240-L1422)

### ConfigManager.js 模块
`src/ConfigManager.js` 模块提供了一个通用的 INI 配置文件管理器。

#### 构造函数 (sectionName, configPath)
- **功能**: 创建一个配置管理器实例。
- **参数**:
  - `sectionName` (string): 配置区域名称（如 `"qqq"`）。
  - `configPath` (string, 可选): 配置文件路径，默认为 `E:\r\pz.ini`。
- **返回值**: ConfigManager 实例

#### readSection()
- **功能**: 读取配置文件中指定区域的所有键值对。
- **参数**: 无
- **返回值**: Object - 配置键值对对象。

#### writeSection(data)
- **功能**: 将键值对对象写入配置文件的指定区域，会覆盖该区域的所有现有配置。
- **参数**:
  - `data` (Object): 要写入的键值对对象。
- **返回值**: 无

#### get(key, defaultValue)
- **功能**: 读取单个配置项的值。
- **参数**:
  - `key` (string): 配置项的键名。
  - `defaultValue` (*, 可选): 如果键不存在时返回的默认值。
- **返回值**: * - 配置项的值。

#### set(key, value)
- **功能**: 设置单个配置项的值。
- **参数**:
  - `key` (string): 配置项的键名。
  - `value` (*): 要设置的值。
- **返回值**: 无

#### update(updates)
- **功能**: 批量更新配置项，将新值合并到现有配置中，而非完全替换。
- **参数**:
  - `updates` (Object): 要更新的键值对对象。
- **返回值**: 无

**Section sources**
- [src/ConfigManager.js](file://src/ConfigManager.js#L13-L197)

## Webview 消息通信
`q2.js` 模块通过 `vscode.postMessage` 与 Webview (`q2.html`) 进行双向通信。Webview 通过 `window.addEventListener('message', ...)` 监听消息。

### 支持的消息类型 (从 Node.js 到 Webview)
- **update**
  - **功能**: 更新 Webview 的文件列表和当前路径。
  - **数据格式**:
    ```json
    {
      "command": "update",
      "currentPath": "D:\\view\\p",
      "fileListHtml": "<div>...</div>",
      "items": [
        {"name": "file1.txt", "path": "D:\\view\\p\\file1.txt", "type": "file", "mtime": "2023-10-01T12:00:00.000Z"},
        {"name": "folder1", "path": "D:\\view\\p\\folder1", "type": "dir", "mtime": "2023-10-01T12:00:00.000Z"}
      ]
    }
    ```
- **updateSize**
  - **功能**: 更新单个文件或文件夹的大小显示。
  - **数据格式**:
    ```json
    {
      "command": "updateSize",
      "path": "D:\\view\\p\\file1.txt",
      "type": "file",
      "sizeDisplay": " 12 m"
    }
    ```
- **clearFilenameInput**
  - **功能**: 清空文件名输入框。
  - **数据格式**: `{ "command": "clearFilenameInput" }`
- **startRename**
  - **功能**: 在指定文件/文件夹上启动重命名操作。
  - **数据格式**:
    ```json
    {
      "command": "startRename",
      "path": "D:\\view\\p\\file1.txt",
      "name": "file1.txt",
      "type": "file"
    }
    ```
- **refreshSizes**
  - **功能**: 通知 Webview 重新请求所有可见项的大小信息。
  - **数据格式**: `{ "command": "refreshSizes" }`

### 支持的消息类型 (从 Webview 到 Node.js)
- **save**
  - **功能**: 保存新文件。
  - **数据格式**:
    ```json
    {
      "command": "save",
      "filename": "newfile.txt",
      "isPinned": false,
      "openInCurrentGroup": true
    }
    ```
- **navigate**
  - **功能**: 导航到指定路径。
  - **数据格式**: `{ "command": "navigate", "path": "D:\\view\\p" }`
- **requestSize**
  - **功能**: 请求获取文件或文件夹的大小。
  - **数据格式**:
    ```json
    {
      "command": "requestSize",
      "path": "D:\\view\\p\\file1.txt",
      "type": "file"
    }
    ```
- **renameItem**
  - **功能**: 重命名文件或文件夹。
  - **数据格式**:
    ```json
    {
      "command": "renameItem",
      "oldPath": "D:\\view\\p\\oldname.txt",
      "newName": "newname.txt",
      "itemType": "file"
    }
    ```
- **deleteToRecycleBin**
  - **功能**: 将文件或文件夹移至回收站。
  - **数据格式**:
    ```json
    {
      "command": "deleteToRecycleBin",
      "path": "D:\\view\\p\\todelete.txt",
      "type": "file"
    }
    ```
- **setSizeMode**
  - **功能**: 设置文件大小显示模式。
  - **数据格式**: `{ "command": "setSizeMode", "mode": "m" }` (模式: `none`, `m`, `k`, `b`)
- **saveSidebarWidth**
  - **功能**: 保存侧边栏宽度。
  - **数据格式**: `{ "command": "saveSidebarWidth", "width": 150 }`

**Section sources**
- [src/q2.js](file://src/q2.js#L543-L1139)
- [src/q2.html](file://src/q2.html#L280-L877)

## 错误码与事件
### 错误码
- **JSON解析失败**: 当 `kp.py` 返回的 JSON 无法被解析时，会记录此错误。
- **执行失败**: 当 `kp.py` 脚本以非零退出码结束时，会记录此错误。
- **脚本不存在**: 当 `kp.py` 文件不存在时，会记录此错误。
- **读取/保存配置文件失败**: 当配置文件读写操作发生错误时，会记录此错误。

### 事件监听机制
- **vscode.window.onDidChangeActiveTextEditor**: 当活动编辑器改变时，触发图片渲染。
- **vscode.workspace.onDidChangeTextDocument**: 当文档内容改变时，触发防抖图片渲染。
- **vscode.window.onDidChangeVisibleTextEditors**: 当可见编辑器列表改变时，批量渲染所有可见编辑器的图片。
- **Webview 消息事件**: 通过 `window.addEventListener('message', ...)` 监听来自 Node.js 的消息。

**Section sources**
- [extension.js](file://extension.js#L614-L697)
- [src/q1.js](file://src/q1.js#L360-L385)
- [src/q2.js](file://src/q2.js#L1417-L1422)
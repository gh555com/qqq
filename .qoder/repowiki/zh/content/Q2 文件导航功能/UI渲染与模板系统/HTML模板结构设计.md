# HTML模板结构设计

<cite>
**本文档引用文件**  
- [q2.html](file://src/q2.html)
- [q2界面完全修复报告.md](file://q2界面完全修复报告.md)
</cite>

## 目录
1. [DOCTYPE声明与安全策略](#doctype声明与安全策略)  
2. [响应式布局结构](#响应式布局结构)  
3. [核心CSS类定位机制](#核心css类定位机制)  
4. [语义化DOM结构](#语义化dom结构)  
5. [JavaScript绑定关系](#javascript绑定关系)

## DOCTYPE声明与安全策略

`q2.html`模板以标准的HTML5文档类型声明开始，确保在VS Code WebView环境中正确渲染。文档头部包含关键的元信息配置：

- **字符编码**：通过`<meta charset="UTF-8">`指定UTF-8编码，支持中文及特殊字符显示。
- **视口配置**：`<meta name="viewport" content="width=device-width, initial-scale=1.0">`确保页面在不同设备上自适应缩放。
- **内容安全策略（CSP）**：通过`Content-Security-Policy`严格限制资源加载，仅允许内联脚本和样式（`'unsafe-inline'`）以及VS Code WebView资源（`vscode-webview-resource:`），有效防止XSS攻击。

**Section sources**  
- [q2.html](file://src/q2.html#L1-L15)

## 响应式布局结构

HTML整体采用Flexbox布局实现响应式分层结构，由`<body>`的`flex-direction: column`定义垂直堆叠，形成三大功能区域：

1. **顶部导航区**：包含侧边栏（`.sidebar`），通过`position: fixed`固定于左侧，实现独立滚动。
2. **中部文件列表滚动区**：主内容区（`.main-content`）使用`position: absolute`避开侧边栏，其内部的`.file-list-container`具备独立垂直滚动能力。
3. **底部操作区**：页脚（`.footer`）通过`position: fixed`固定于底部，包含文件名输入框和操作按钮。

该布局通过`flex: 1`和`overflow`属性的协同，确保中部区域占据剩余空间并实现内容滚动，而顶部和底部保持固定。

**Section sources**  
- [q2.html](file://src/q2.html#L16-L25)

## 核心CSS类定位机制

模板中的核心CSS类通过`position`属性实现精确的定位与尺寸控制：

- **`.container`**：作为Flex容器，使用`position: relative`为内部绝对定位元素提供参考。
- **`.sidebar`**：采用`position: fixed`，通过`left: 0`, `top: 0`, `bottom: 60px`和`width: {{SIDEBAR_WIDTH}}px`实现固定宽度和高度，`z-index: 20`确保其位于内容之上。
- **`.main-content`**：使用`position: absolute`，通过`left: {{SIDEBAR_WIDTH}}px`动态调整其起始位置以避开侧边栏，`right: 0`使其宽度自适应。
- **`.footer`**：`position: fixed`配合`bottom: 0`, `left: 0`, `right: 0`实现全宽底部固定，`z-index: 10`确保其位于内容之上但低于侧边栏。

`position: fixed`与`position: absolute`的协同使用，实现了侧边栏、主内容区和页脚的分层固定，同时保证了布局的灵活性和响应性。

**Section sources**  
- [q2.html](file://src/q2.html#L30-L100)

## 语义化DOM结构

根据`q2界面完全修复报告.md`的修复过程，模板的DOM结构经过精心组织，确保与原版extension.js完全一致：

- **侧边栏驱动器列表**：位于`.sidebar`内，通过`{{DRIVES_HTML}}`占位符注入动态生成的盘符按钮（`.nav-item`），每个按钮绑定`onclick="navigateTo('C:')" `事件。
- **最近目录区**：位于`.recent-section`，通过`{{RECENT_DIRS_HTML}}`占位符注入，每个`.recent-item`包含一个删除按钮（`.delete-button`）和路径文本，支持点击导航和删除。
- **回收站**：位于`.recycle-bin-section`，通过`{{RECYCLE_BIN_HTML}}`占位符注入，显示历史删除的目录。
- **文件列表容器**：`.file-list-container`（id="fileList"）是动态文件项的容器，其内部结构包含`.sz-area`（大小显示区）、`.file-select-area`（选择区）和`.folder-name-area`（文件夹名区），使用emoji图标`📁`和`📄`。

**Section sources**  
- [q2.html](file://src/q2.html#L101-L200)
- [q2界面完全修复报告.md](file://q2界面完全修复报告.md#L0-L194)

## JavaScript绑定关系

模板通过`id`属性与JavaScript逻辑建立强绑定关系，实现交互功能：

- **`sidebarResizer`**：`div`元素的`id="sidebarResizer"`用于绑定拖拽事件，实现侧边栏宽度调整。
- **`fileList`**：`div`元素的`id="fileList"`作为文件列表的根容器，JavaScript通过此ID动态插入文件项，并监听点击事件以处理选中和取消选中逻辑。
- **`filenameInput`**：`input`元素的`id="filenameInput"`绑定键盘事件（`onkeydown="handleFilenameInputKeyDown(event)"`），处理回车键保存文件。
- **`mainContent`**：`div`元素的`id="mainContent"`用于在DOM加载完成后聚焦文件名输入框。

此外，`{{INLINE_SCRIPT}}`占位符被`q2.js`中的完整JavaScript代码替换，注入了`selectItem`、`startRename`、`refreshSizeDisplay`等核心函数，实现了文件选中、重命名、右键菜单等全部交互逻辑。

**Section sources**  
- [q2.html](file://src/q2.html#L201-L300)
- [q2界面完全修复报告.md](file://q2界面完全修复报告.md#L0-L194)
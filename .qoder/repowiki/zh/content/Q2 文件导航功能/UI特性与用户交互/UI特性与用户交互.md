# UI特性与用户交互

<cite>
**本文档引用文件**  
- [q2.js](file://src\q2.js)
- [q2.html](file://src\q2.html)
- [extension.js](file://extension.js)
- [q2占位符空格问题修复.md](file://q2占位符空格问题修复.md)
</cite>

## 目录
1. [可拖动侧边栏实现机制](#可拖动侧边栏实现机制)
2. [文件大小显示模式切换](#文件大小显示模式切换)
3. [sz-area区域右对齐格式化算法](#sz-area区域右对齐格式化算法)
4. [占位符空格问题与UI错位修复](#占位符空格问题与ui错位修复)
5. [pinButton长驻按钮状态与通信机制](#pinbutton长驻按钮状态与通信机制)

## 可拖动侧边栏实现机制

侧边栏的拖动功能通过`sidebar-resizer`元素实现，该元素作为侧边栏与主内容区之间的可拖动分割线。系统通过监听鼠标事件实现拖动状态管理与宽度同步。

在`q2.js`中，通过`mousedown`事件启动拖动状态，记录初始鼠标位置和侧边栏宽度，并为`document`绑定`mousemove`和`mouseup`事件。`mousemove`事件持续计算新的侧边栏宽度，并实时更新`.sidebar`、`.sidebar-resizer`和`.main-content`的`style.left`或`style.width`属性，实现视觉上的动态调整。当`mouseup`或`mouseleave`事件触发时，清除拖动状态，移除样式限制，并通过`vscode.postMessage`向VSCode发送`saveSidebarWidth`命令，将最终宽度持久化保存。

**Section sources**
- [q2.js](file://src\q2.js#L1030-L1040)

## 文件大小显示模式切换

文件大小显示模式（`none`/`m`/`k`/`b`）的切换通过`setSizeMode()`函数实现。该函数在`q2.js`中定义，接收一个模式参数（`mode`），通过`vscode.postMessage`向VSCode扩展发送`setSizeMode`命令。

VSCode扩展接收到此命令后，会更新全局的`sizeMode`变量，并调用`saveConfig()`函数将新设置写入配置文件`pz.ini`中的`[qqq]`节。配置更新后，会触发`refreshSizeDisplay()`函数的调用。`refreshSizeDisplay()`会遍历文件列表中的所有`.file-item`，对于每个包含`.sz-area`的项目，先将其文本内容临时设置为加载指示符（`•`），然后再次向VSCode发送`requestSize`命令，请求重新计算并返回该文件/文件夹的大小显示字符串，从而完成整个界面的刷新。

**Section sources**
- [q2.js](file://src\q2.js#L1030-L1033)
- [q2.js](file://src\q2.js#L688-L689)

## sz-area区域右对齐格式化算法

`sz-area`区域的右对齐效果是通过在文本前填充不同数量的空格来实现的，其核心算法位于`getFileSizeDisplayAsync`函数中。

该算法首先根据当前的`sizeMode`和文件大小，调用`formatFileSize`函数计算出带单位的大小字符串。随后，根据单位（`m`、`k`、`b`）决定需要填充的空格数：
- `m`单位：不填充空格（`spacesToFill = 0`），使数值紧贴左侧。
- `k`单位：填充3个空格（`spacesToFill = 3`），使数值居中。
- `b`单位：填充6个空格（`spacesToFill = 6`），使数值靠右。

最终的显示字符串通过`" ".repeat(spacesToFill) + displaySize + " " + displayUnit`拼接而成。这种基于空格填充的“错位显示逻辑”在不同单位下产生视觉上的对齐差异，实现了模拟右对齐的效果。

**Section sources**
- [q2.js](file://src\q2.js#L109-L161)

## 占位符空格问题与UI错位修复

`q2占位符空格问题修复.md`文档揭示了一个导致UI完全失效的关键问题：HTML模板`q2.html`中的`{{INLINE_SCRIPT}}`占位符被错误地写成了`{ { INLINE_SCRIPT } }`（内部含有空格）。

由于`q2.js`中的`getWebviewContent`函数使用正则表达式`/\{\{INLINE_SCRIPT\}\}/g`进行替换，该正则表达式无法匹配带有空格的占位符。这导致`generateWebviewScript`函数生成的完整JavaScript代码未能注入到最终的HTML中。其后果是，所有在内联脚本中定义的函数（如`updateResourceExplorer`、`hideAllContextMenus`、`setSizeMode`等）均未定义，从而引发大量`ReferenceError`，导致文件列表无法显示、交互功能完全失效。

修复方案是将`q2.html`文件第873行的`{ { INLINE_SCRIPT } }`修改为`{{INLINE_SCRIPT}}`，确保占位符格式与替换逻辑完全一致，从而恢复了所有前端功能。

**Section sources**
- [q2占位符空格问题修复.md](file://q2占位符空格问题修复.md)
- [q2.js](file://src\q2.js#L543-L1125)
- [q2.html](file://src\q2.html#L873)

## pinButton长驻按钮状态与通信机制

`pinButton`长驻按钮的状态切换通过`togglePin()`函数实现。该函数首先获取按钮的`.pin-box`元素，检查其是否包含`pinned` CSS类来判断当前状态。切换时，通过`classList.add()`或`classList.remove()`修改`pinned`类，并相应地更新复选框`span`的文本内容（`\u2713`为勾选符号，`\u25a1`为空方框）。

状态变更后，`togglePin()`会通过`vscode.postMessage`向VSCode扩展发送一个包含`togglePin`命令和新状态（`isPinned`）的消息。VSCode扩展接收到消息后，会更新其内部的`isPinned`状态，并可能将其持久化到配置文件中。这种基于`postMessage`的通信机制实现了Webview前端与VSCode后端之间的双向数据同步，确保了用户界面状态与应用逻辑的一致性。

**Section sources**
- [q2.js](file://src\q2.js#L747-L749)
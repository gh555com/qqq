# 文件列表UI结构与样式

<cite>
**本文档引用的文件**   
- [q2.html](file://src/q2.html)
- [q2.js](file://src/q2.js)
- [extension.js](file://extension.js)
</cite>

## 目录
1. [文件列表容器布局](#文件列表容器布局)
2. [文件条目结构与Flex布局](#文件条目结构与flex布局)
3. [图标与选中状态实现](#图标与选中状态实现)
4. [CSS变量与响应式设计](#css变量与响应式设计)

## 文件列表容器布局

`.file-list-container` 容器采用 Flex 布局中的 `flex: 1` 属性，使其在主内容区中占据剩余全部垂直空间。该容器具备独立的垂直滚动特性（`overflow-y: auto`），允许用户在不干扰页面其他组件的情况下浏览文件列表。容器底部预留 60px 的 `margin-bottom` 空间，以避免内容被固定在底部的操作区遮挡。其与页面其他组件的布局关系为：位于地址栏下方，上方为固定定位的最近保存目录区，下方为固定在视口底部的 `footer` 操作区，整体形成一个可滚动的中间内容面板。

**Section sources**
- [q2.html](file://src/q2.html#L275-L305)

## 文件条目结构与Flex布局

`.file-item` 条目采用 `display: flex` 的弹性布局，内部包含四个主要区域：
- `.sz-area`（大小显示区）：通过 `width: var(--sz-area-width)` 设置固定宽度，使用等宽字体（`monospace`）和斜体显示文件大小，`flex-shrink: 0` 防止其在空间不足时被压缩。
- `.file-select-area`（选择区域）：包含图标和点击选择功能，`flex-shrink: 0` 确保其尺寸固定，`padding` 提供足够的点击热区。
- `.folder-name-area`（文件夹名区）：使用 `flex: 1` 占据剩余空间，`white-space: nowrap` 和 `text-overflow: ellipsis` 实现文本溢出隐藏，`cursor: pointer` 表明可点击。
- `.file-name-area`（文件名区）：同样使用 `flex: 1` 占据剩余空间，布局与文件夹名区一致，用于显示文件名。

这些区域通过 `align-items: center` 垂直居中对齐，确保图标和文本在行内整齐排列。

**Section sources**
- [q2.html](file://src/q2.html#L308-L378)

## 图标与选中状态实现

文件和文件夹的图标（📁/📄）通过 HTML 内联的 Unicode 字符实现，包裹在 `.file-icon` 元素中。该元素的 `font-size` 被设置为 16px，确保图标清晰可见。选中状态的视觉反馈通过为 `.file-item` 添加 `selected` CSS 类来实现。当条目被选中时，其所有子区域（`.sz-area`、`.file-select-area`、`.folder-name-area`、`.file-name-area`）的背景色统一变为 `#ff6b00`（橙色），文字颜色变为白色。同时，`:hover` 状态下的背景色也被覆盖为选中色，确保悬停时视觉效果一致。

**Section sources**
- [q2.html](file://src/q2.html#L387-L400)
- [q2.js](file://src/q2.js#L1373-L1404)

## CSS变量与响应式设计

UI 的可配置性通过 CSS 自定义属性（CSS 变量）实现：
- `--sz-area-width`：定义 `.sz-area` 的宽度，当前值为 96px，约等于 12 个等宽字符的宽度。
- `--icon-area-width`：定义图标区域的宽度，当前值为 24px。

这些变量在 `:root` 中定义，便于全局统一调整。响应式设计主要体现在 `overflow-x: auto` 上，当文件名过长导致内容超出容器宽度时，会自动出现水平滚动条，确保内容完整可见。滚动条样式经过定制，使用 `scrollbar-width: thin` 和 `scrollbar-color` 定义了细型滚动条及其轨道与滑块的颜色，并通过 `::-webkit-scrollbar` 系列伪元素进一步美化 WebKit 浏览器的滚动条外观，使其更符合整体 UI 风格。

**Section sources**
- [q2.html](file://src/q2.html#L15-L25)
- [q2.html](file://src/q2.html#L275-L305)
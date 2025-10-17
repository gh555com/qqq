# 右键菜单HTML结构设计

<cite>
**本文档引用的文件**
- [q2.html](file://src/q2.html)
- [q2.js](file://src/q2.js)
- [extension.js](file://extension.js)
</cite>

## 目录
1. [简介](#简介)
2. [右键菜单容器设计](#右键菜单容器设计)
3. [CSS样式与定位机制](#css样式与定位机制)
4. [显示控制逻辑](#显示控制逻辑)
5. [data-action属性关联](#data-action属性关联)
6. [菜单项布局与交互](#菜单项布局与交互)

## 简介
本文档详细说明q2.html中itemContextMenu和emptyContextMenu两个浮窗的HTML结构设计。这两个右键菜单组件为用户提供上下文操作功能，分别针对文件项目和空白区域提供不同的操作选项。通过分析其HTML结构、CSS样式、显示控制逻辑以及与data-action属性的关联，全面阐述其设计原理和实现机制。

## 右键菜单容器设计
q2.html中定义了两个独立的右键菜单容器：`itemContextMenu`和`emptyContextMenu`，分别对应项目右键菜单和空白处右键菜单。

`itemContextMenu`容器（class="context-menu"）包含五个菜单项，分别对应重命名、打开、删除、kode和刷新大小操作。每个菜单项使用`data-action`属性定义其操作语义，并通过内联onclick事件绑定JavaScript行为。

`emptyContextMenu`容器（class="context-menu-empty"）包含四个菜单项，用于设置文件大小显示模式（none、m、k、b）。每个菜单项使用`data-mode`属性定义其模式值，并通过内联onclick事件调用`setSizeMode`函数。

这两个容器均位于HTML文档的末尾，在主内容区域之后，确保它们在DOM层次结构中处于顶层，便于通过固定定位显示在页面任意位置。

**Section sources**
- [q2.html](file://src/q2.html#L641-L675)

## CSS样式与定位机制
右键菜单采用固定定位策略，确保菜单能够显示在鼠标点击位置，不受页面滚动影响。

`context-menu`和`context-menu-empty`两个类均设置`position: fixed`，使其相对于视口定位。`z-index: 9999`确保菜单始终显示在其他元素之上，避免被其他UI组件遮挡。`display: none`初始状态下隐藏菜单，通过JavaScript控制其显示与隐藏。

菜单容器使用`flex-direction: column`布局，使菜单项垂直排列。`min-width`属性确保菜单具有最小宽度，`padding: 4px 0`提供内部间距。`box-shadow`属性添加阴影效果，增强菜单的层次感和视觉吸引力。

菜单项采用flex布局，`justify-content: space-between`使菜单项文本和快捷键提示分居两侧。`align-items: center`确保内容垂直居中。`padding: 6px 12px`提供适当的内边距，`cursor: pointer`显示手型光标，提示用户可点击。

**Section sources**
- [q2.html](file://src/q2.html#L499-L564)

## 显示控制逻辑
右键菜单的显示控制逻辑通过JavaScript事件监听器实现，主要在q2.js和extension.js中定义。

`fileList`元素监听`contextmenu`事件，当用户右键点击时触发。事件处理函数首先调用`hideAllContextMenus()`隐藏所有右键菜单，然后通过`e.target.closest('.file-item')`判断点击位置是否在文件项目上。

如果点击的是文件项目，则获取项目数据（路径、名称、类型），调用`selectItem()`将其设为选中状态，并将`itemContextMenu`的`left`和`top`样式属性设置为`e.clientX`和`e.clientY`的值，即鼠标点击坐标。最后将`display`属性设置为`flex`，显示项目右键菜单。

如果点击的是空白区域，则将`emptyContextMenu`定位到鼠标位置并显示。这种逻辑确保了根据上下文显示适当的菜单，提供精准的操作选项。

`hideAllContextMenus()`函数通过设置两个菜单容器的`display`属性为`none`来隐藏所有右键菜单，该函数在点击文档其他区域时被调用，实现菜单的自动关闭。

**Section sources**
- [q2.js](file://src/q2.js#L987-L1058)
- [extension.js](file://extension.js#L2322-L2411)

## data-action属性关联
`data-action`属性在右键菜单中扮演关键角色，它定义了用户操作的语义，并作为JavaScript行为的触发器。

在`itemContextMenu`中，每个菜单项的`data-action`属性值（如"rename"、"open"、"delete"等）直接对应具体的操作类型。当用户点击菜单项时，事件监听器通过`e.currentTarget.dataset.action`获取该值，并将其传递给`handleContextMenuAction()`函数。

`handleContextMenuAction()`函数根据接收到的action值，使用switch语句调用相应的操作函数，如`performEditAction()`、`performOpenAction()`等。这种设计实现了操作语义与具体实现的解耦，使得添加新操作只需定义新的data-action值和对应的处理函数。

此外，`data-shortcut`属性定义了键盘快捷键，与data-action配合使用，允许用户通过键盘快速执行操作，提升用户体验和操作效率。

**Section sources**
- [q2.html](file://src/q2.html#L641-L675)
- [q2.js](file://src/q2.js#L987-L1058)

## 菜单项布局与交互
菜单项采用flex布局实现，`display: flex`使菜单项内容水平排列，`justify-content: space-between`将主文本和快捷键提示分置两端，`align-items: center`确保内容垂直居中。

悬停效果通过CSS伪类`:hover`实现，`context-menu-item:hover`和`context-menu-empty-item:hover`设置`background-color: #e3f2fd`，为用户提供视觉反馈，明确指示可点击区域。

`context-menu-shortcut`类用于样式化快捷键提示，`color: #777`使其颜色较浅，`font-size: 12px`使其字体较小，`margin-left: 20px`提供适当的间距，整体设计简洁明了，不干扰主要操作文本。

`emptyContextMenu`中的`selected`类通过`font-weight: bold`和`background-color: #bbdefb`突出显示当前选中的大小模式，提供清晰的状态指示，帮助用户了解当前设置。

**Section sources**
- [q2.html](file://src/q2.html#L499-L564)
# ConfigManager 使用指南

## 简介

`ConfigManager.js` 是一个通用的 INI 配置文件管理类，支持多个程序共享同一配置文件。

## 核心特性

1. **多程序共享**：多个程序可以共用 `E:\r\pz.ini`，通过不同的 section 区分
2. **格式保留**：写入时保留其他 section 的内容和注释
3. **简单易用**：提供 `get()`, `set()`, `update()` 等便捷方法
4. **安全可靠**：自动创建文件和目录，错误处理完善

## 基本用法

### 1. 引入模块

```javascript
const ConfigManager = require('./ConfigManager');
```

### 2. 创建实例

```javascript
// 使用默认路径 E:\r\pz.ini
const config = new ConfigManager('qqq');

// 或指定自定义路径
const config = new ConfigManager('my_app', 'D:\\config\\app.ini');
```

### 3. 读取配置

#### 3.1 读取整个 section
```javascript
const allConfig = config.readSection();
// 返回: { recent_dirs: 'C:\\path1,C:\\path2', line_spacing: '-2', ... }
```

#### 3.2 读取单个配置项
```javascript
const value = config.get('sidebar_width', '100');  // 第二个参数是默认值
```

#### 3.3 读取数组类型配置
```javascript
const recentDirsStr = config.get('recent_dirs', '');
const recentDirs = recentDirsStr ? recentDirsStr.split(',') : [];
```

### 4. 写入配置

#### 4.1 写入单个配置项
```javascript
config.set('sidebar_width', '150');
```

#### 4.2 批量写入整个 section
```javascript
config.writeSection({
    recent_dirs: 'E:\\path1,E:\\path2',
    line_spacing: '-2',
    sidebar_width: '100',
    is_pinned: 'false'
});
```

#### 4.3 批量更新（合并现有配置）
```javascript
config.update({
    sidebar_width: '200',  // 只更新这一个，其他保持不变
    size_mode: 'k'
});
```

#### 4.4 写入数组类型配置
```javascript
const dirs = ['E:\\project1', 'E:\\project2', 'E:\\project3'];
config.set('recent_dirs', dirs.join(','));
```

## 完整示例：集成到 q2.js

### 原有代码（使用内联读写）

```javascript
function getConfig() {
    const config = { recentDirs: [], lineSpacing: -2, ... };

    const content = fs.readFileSync(CONFIG_PATH, "utf8");
    const qqqSection = content.match(/\[qqq\]([\s\S]*?)(\[|$)/);

    if (qqqSection) {
        const recentMatch = qqqSection[1].match(/recent_dirs=(.*)/);
        if (recentMatch) {
            config.recentDirs = recentMatch[1].split(",");
        }
        // ... 更多字段
    }

    return config;
}
```

### 改造后代码（使用 ConfigManager）

```javascript
const ConfigManager = require('./ConfigManager');

// 创建全局配置管理器实例
const configManager = new ConfigManager('qqq', CONFIG_PATH);

function getConfig() {
    const defaults = {
        recentDirs: [],
        lineSpacing: -2,
        sidebarWidth: 100,
        recycleBin: [],
        isPinned: false,
        sizeMode: "none",
    };

    // 读取所有配置
    const raw = configManager.readSection();

    // 解析配置
    const config = {
        recentDirs: raw.recent_dirs ? raw.recent_dirs.split(',').filter(Boolean) : defaults.recentDirs,
        lineSpacing: raw.line_spacing ? parseInt(raw.line_spacing) : defaults.lineSpacing,
        sidebarWidth: raw.sidebar_width ? parseInt(raw.sidebar_width) : defaults.sidebarWidth,
        recycleBin: raw.recycle_bin ? raw.recycle_bin.split(',').filter(Boolean) : defaults.recycleBin,
        isPinned: raw.is_pinned === 'true',
        sizeMode: raw.size_mode || defaults.sizeMode,
    };

    return config;
}

function saveConfig(recentDirs, lineSpacing, sidebarWidth, recycleBin, isPinned, sizeMode) {
    configManager.writeSection({
        recent_dirs: recentDirs.join(','),
        line_spacing: String(lineSpacing),
        sidebar_width: String(sidebarWidth),
        recycle_bin: recycleBin.join(','),
        is_pinned: String(isPinned),
        size_mode: sizeMode,
    });
}
```

## 配置文件格式

### E:\r\pz.ini 示例

```ini
[qqq]
recent_dirs=E:\s\wol\py\q3,C:\Users\q\Desktop
line_spacing=-2
sidebar_width=150
recycle_bin=E:\old_project1,E:\old_project2
is_pinned=false
size_mode=k

[video_converter]
output_dir=E:\videos\output
quality=high
format=mp4

[image_processor]
resize_width=1920
resize_height=1080
compression=80
```

### 格式规范

1. **Section 名称**：`[section_name]`
2. **键值对**：`key=value`（等号两边不要空格）
3. **数组值**：使用逗号分隔，不加空格 `path1,path2,path3`
4. **注释**：使用 `#` 或 `;` 开头
5. **空行**：用于分隔不同 section，提高可读性

## 多程序共享示例

### 程序 A：VSCode 扩展（qqq）

```javascript
const ConfigManager = require('./ConfigManager');
const qqqConfig = new ConfigManager('qqq', 'E:\\r\\pz.ini');

qqqConfig.update({
    recent_dirs: 'E:\\project1,E:\\project2',
    sidebar_width: '150'
});
```

### 程序 B：视频转换器

```javascript
const ConfigManager = require('./ConfigManager');
const videoConfig = new ConfigManager('video_converter', 'E:\\r\\pz.ini');

videoConfig.update({
    output_dir: 'E:\\videos\\output',
    quality: 'high',
    format: 'mp4'
});
```

### 程序 C：图片处理器

```javascript
const ConfigManager = require('./ConfigManager');
const imageConfig = new ConfigManager('image_processor', 'E:\\r\\pz.ini');

imageConfig.update({
    resize_width: '1920',
    resize_height: '1080',
    compression: '80'
});
```

### 结果：所有配置共存于同一文件

```ini
[qqq]
recent_dirs=E:\project1,E:\project2
sidebar_width=150

[video_converter]
format=mp4
output_dir=E:\videos\output
quality=high

[image_processor]
compression=80
resize_height=1080
resize_width=1920
```

## 注意事项

### 1. 值类型转换

ConfigManager 存储的都是字符串，需要手动转换：

```javascript
// ❌ 错误：直接使用
const width = config.get('sidebar_width');  // "150" (字符串)

// ✅ 正确：转换类型
const width = parseInt(config.get('sidebar_width', '100'));  // 150 (数字)
```

### 2. 数组处理

```javascript
// 读取数组
const dirsStr = config.get('recent_dirs', '');
const dirs = dirsStr ? dirsStr.split(',') : [];

// 写入数组
const dirs = ['path1', 'path2'];
config.set('recent_dirs', dirs.join(','));
```

### 3. 布尔值处理

```javascript
// 读取布尔值
const isPinned = config.get('is_pinned', 'false') === 'true';

// 写入布尔值
config.set('is_pinned', isPinned ? 'true' : 'false');
```

### 4. 路径验证

建议在读取路径后验证存在性：

```javascript
const dirs = dirsStr.split(',')
    .filter(dir => dir && fs.existsSync(dir));  // 过滤不存在的路径
```

## 错误处理

ConfigManager 内部已经处理了常见错误：

```javascript
try {
    config.set('key', 'value');
} catch (error) {
    console.error('保存配置失败:', error.message);
    // ConfigManager 会在内部记录错误，无需额外处理
}
```

## API 参考

### 构造函数

```javascript
new ConfigManager(sectionName, configPath = 'E:\\r\\pz.ini')
```

### 方法

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `readSection()` | 无 | `Object` | 读取整个 section |
| `writeSection(data)` | `Object` | 无 | 写入整个 section |
| `get(key, defaultValue)` | `string, any` | `any` | 读取单个配置 |
| `set(key, value)` | `string, any` | 无 | 写入单个配置 |
| `update(updates)` | `Object` | 无 | 批量更新配置 |

## 常见问题

### Q1: 如何确保配置文件不被其他程序损坏？

A: ConfigManager 在写入时会保留其他 section 的完整内容，只修改指定的 section。

### Q2: 如何处理并发写入？

A: 目前 ConfigManager 是同步操作，如果需要文件锁，可以使用 `proper-lockfile` 库：

```javascript
const lockfile = require('proper-lockfile');

async writeWithLock(data) {
    const release = await lockfile.lock(this.configPath);
    try {
        this.writeSection(data);
    } finally {
        await release();
    }
}
```

### Q3: 如何迁移现有配置？

A: ConfigManager 可以直接读取现有 INI 文件，无需迁移。

---

**创建时间**: 2025-10-15
**版本**: 1.0
**作者**: AI Assistant

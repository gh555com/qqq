const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// 尝试加载 MessagePack 进行更高效的序列化
let msgpack;
try {
    msgpack = require('msgpack-lite');
} catch (error) {
    console.log('ClipboardHistoryManager: msgpack-lite 未安装，使用 JSON 序列化');
}

class ClipboardHistoryManager {
    constructor(context) {
        this.context = context;
        this.history = [];
        this.maxHistoryItems = 100; // 最大历史记录数
        this.clipboardWatcher = null;
        this.lastClipboardContent = '';
        this.isWatching = false;
        this.historyFilePath = null;
        this.isSaving = false;
        this.saveQueue = false;
        this.lastSaveTime = 0;
        this.saveThrottleInterval = 1000; // 保存节流间隔（毫秒）
        this.autoCleanupDays = 30; // 自动清理30天前的记录
        this.memoryCacheEnabled = true; // 启用内存缓存
        this.batchSaveEnabled = true; // 启用批处理保存
        this.batchSaveThreshold = 5; // 批处理阈值
        this.batchSaveTimer = null;
        this.pendingChanges = 0; // 待保存的变更数
        this.optimizationLevel = 'extreme'; // 优化级别：basic, advanced, extreme
        this.compressionEnabled = true; // 启用压缩

        // 性能统计
        this.perfStats = {
            saveTime: 0,
            loadTime: 0,
            addTime: 0,
            operations: 0
        };

        // 初始化存储路径
        this.initializeStorage();
        // 初始化历史记录（异步）
        this.initializeHistory();
        // 启动自动清理
        this.startAutoCleanup();
        // 启动性能监控
        this.startPerformanceMonitoring();
    }

    /**
     * 初始化历史记录
     */
    async initializeHistory() {
        try {
            await this.loadHistory();
            // 清理过期数据
            this.cleanupExpiredItems();
        } catch (error) {
            console.error('ClipboardHistoryManager: 初始化历史记录失败:', error);
        }
    }

    /**
     * 启动自动清理
     */
    startAutoCleanup() {
        // 每天运行一次自动清理
        setInterval(() => {
            this.cleanupExpiredItems();
        }, 24 * 60 * 60 * 1000);
    }

    /**
     * 启动性能监控
     */
    startPerformanceMonitoring() {
        // 每小时输出一次性能统计
        setInterval(() => {
            if (this.perfStats.operations > 0) {
                console.log('ClipboardHistoryManager: 性能统计:', {
                    avgSaveTime: (this.perfStats.saveTime / this.perfStats.operations).toFixed(2) + 'ms',
                    avgLoadTime: (this.perfStats.loadTime / this.perfStats.operations).toFixed(2) + 'ms',
                    avgAddTime: (this.perfStats.addTime / this.perfStats.operations).toFixed(2) + 'ms',
                    totalOperations: this.perfStats.operations
                });
            }
        }, 60 * 60 * 1000);
    }

    /**
     * 清理过期的历史记录
     */
    cleanupExpiredItems() {
        const now = Date.now();
        const cutoffTime = now - (this.autoCleanupDays * 24 * 60 * 60 * 1000);

        const originalLength = this.history.length;
        this.history = this.history.filter(item => item.timestamp >= cutoffTime);

        if (this.history.length < originalLength) {
            console.log(`ClipboardHistoryManager: 清理了 ${originalLength - this.history.length} 条过期记录`);
            this.saveHistory();
        }
    }

    /**
     * 初始化存储路径
     */
    initializeStorage() {
        try {
            // 使用 globalStorageUri 作为存储位置
            const storagePath = this.context.globalStorageUri.fsPath;
            const clipboardDir = path.join(storagePath, 'clipboard-history');

            // 确保目录存在
            if (!fs.existsSync(clipboardDir)) {
                fs.mkdirSync(clipboardDir, { recursive: true });
            }

            // 根据优化级别选择存储格式
            const fileExtension = msgpack ? 'bin' : 'json';
            this.historyFilePath = path.join(clipboardDir, `history.${fileExtension}`);

            // 初始化内存缓存
            this.memoryCache = {
                history: [],
                lastUpdated: 0,
                size: 0,
                maxSize: 25 * 1024 * 1024, // 5MB 内存缓存限制
                expiryTime: 25 * 60 * 1000, // 5分钟缓存过期时间
                hitCount: 0,
                missCount: 0
            };

            console.log('ClipboardHistoryManager: 存储路径初始化完成:', this.historyFilePath);
            console.log('ClipboardHistoryManager: 优化级别:', this.optimizationLevel);
            console.log('ClipboardHistoryManager: 序列化方式:', msgpack ? 'MessagePack' : 'JSON');
        } catch (error) {
            console.error('ClipboardHistoryManager: 初始化存储路径失败:', error);
            // 降级到内存存储
            this.historyFilePath = null;
        }
    }

    /**
     * 预热内存缓存
     */
    warmupCache() {
        if (this.memoryCacheEnabled) {
            // 计算当前数据大小
            const currentSize = this.calculateMemorySize(this.history);

            // 检查是否超过内存缓存限制
            if (currentSize > this.memoryCache.maxSize) {
                console.warn(`ClipboardHistoryManager: 数据大小 (${(currentSize / 1024 / 1024).toFixed(2)}MB) 超过内存缓存限制 (${(this.memoryCache.maxSize / 1024 / 1024).toFixed(2)}MB)，减少缓存数据`);

                // 按时间戳排序，只保留最新的一部分数据
                const sortedHistory = [...this.history].sort((a, b) => b.timestamp - a.timestamp);
                let trimmedHistory = [];
                let trimmedSize = 0;

                // 逐步添加数据，直到接近内存限制
                for (const item of sortedHistory) {
                    const itemSize = this.calculateMemorySize([item]);
                    if (trimmedSize + itemSize < this.memoryCache.maxSize * 0.9) { // 预留10%空间
                        trimmedHistory.push(item);
                        trimmedSize += itemSize;
                    } else {
                        break;
                    }
                }

                this.memoryCache.history = trimmedHistory;
                this.memoryCache.size = trimmedSize;
                console.log(`ClipboardHistoryManager: 内存缓存已裁剪，保留 ${trimmedHistory.length} 项，大小: ${(trimmedSize / 1024).toFixed(2)}KB`);
            } else {
                // 正常缓存所有数据
                this.memoryCache.history = [...this.history];
                this.memoryCache.size = currentSize;
            }

            this.memoryCache.lastUpdated = Date.now();
            console.log(`ClipboardHistoryManager: 内存缓存预热完成，大小: ${(this.memoryCache.size / 1024).toFixed(2)}KB`);
        }
    }

    /**
     * 计算内存大小
     */
    calculateMemorySize(obj) {
        try {
            if (msgpack) {
                return msgpack.encode(obj).length;
            } else {
                return JSON.stringify(obj).length;
            }
        } catch (error) {
            return 0;
        }
    }

    /**
     * 开始监听剪切板变化
     */
    startWatching() {
        if (this.isWatching) return;

        this.isWatching = true;
        this.lastClipboardContent = '';

        // 定期检查剪切板内容
        this.clipboardWatcher = setInterval(async () => {
            try {
                const currentContent = await vscode.env.clipboard.readText();

                // 只有当内容发生变化且非空时才记录
                if (currentContent && currentContent !== this.lastClipboardContent) {
                    await this.addToHistory(currentContent);
                    this.lastClipboardContent = currentContent;

                    // 通知侧边栏更新
                    this.notifySidebarUpdate();
                }
            } catch (error) {
                // 静默处理错误，避免影响主流程
                console.debug('剪切板读取失败:', error.message);
            }
        }, 1000); // 每秒检查一次

        console.log('剪切板监听已启动');
    }

    /**
     * 停止监听剪切板变化
     */
    stopWatching() {
        if (this.clipboardWatcher) {
            clearInterval(this.clipboardWatcher);
            this.clipboardWatcher = null;
        }
        this.isWatching = false;
        console.log('剪切板监听已停止');
    }

    /**
     * 添加内容到历史记录
     */
    async addToHistory(content) {
        const startTime = performance.now();

        try {
            if (!content || typeof content !== 'string' || content.trim() === '') return;

            // 限制内容长度，避免存储过大的内容
            const maxContentLength = 100000; // 100KB
            if (content.length > maxContentLength) {
                content = content.substring(0, maxContentLength);
                console.warn('ClipboardHistoryManager: 内容过长，已截断');
            }

            // 检查是否与上次内容相同
            if (content === this.lastClipboardContent) return;

            // 使用哈希表进行高效去重
            let existingIndex = -1;
            const contentHash = this.generateContentHash(content);

            // 快速查找重复内容
            for (let i = 0; i < this.history.length; i++) {
                const itemHash = this.history[i].hash || this.generateContentHash(this.history[i].content);
                if (itemHash === contentHash) {
                    existingIndex = i;
                    break;
                }
            }

            if (existingIndex !== -1) {
                // 如果已存在，移到最前面并更新时间戳
                const [existingItem] = this.history.splice(existingIndex, 1);
                existingItem.timestamp = Date.now();
                existingItem.hash = contentHash; // 确保哈希值存在
                this.history.unshift(existingItem);
            } else {
                // 创建历史项
                const historyItem = {
                    id: this.generateId(),
                    content: content,
                    timestamp: Date.now(),
                    type: 'text',
                    preview: this.getContentPreview(content),
                    contentLength: content.length,
                    hash: contentHash
                };

                // 添加新项目到开头
                this.history.unshift(historyItem);

                // 限制历史记录数量
                if (this.history.length > this.maxHistoryItems) {
                    this.history = this.history.slice(0, this.maxHistoryItems);
                }
            }

            // 更新上次剪切板内容
            this.lastClipboardContent = content;

            // 更新内存缓存
            if (this.memoryCacheEnabled) {
                this.warmupCache();
            }

            // 更新ID映射表
            this.updateIdMap();

            // 保存到持久化存储
            await this.saveHistory();

            const addTime = performance.now() - startTime;
            this.perfStats.addTime += addTime;
            this.perfStats.operations++;

            if (addTime > 100) {
                console.log(`ClipboardHistoryManager: 添加历史记录耗时较长: ${addTime.toFixed(2)}ms`);
            }
        } catch (error) {
            console.error('ClipboardHistoryManager: 添加历史记录失败:', error);
        }
    }

    /**
     * 生成内容哈希值，用于快速去重
     */
    generateContentHash(content) {
        return crypto.createHash('md5').update(content).digest('hex');
    }

    /**
     * 生成唯一ID
     */
    generateId() {
        return crypto.randomUUID();
    }



    /**
     * 获取内容预览
     */
    getContentPreview(content, maxLength = 100) {
        if (!content) return '';

        let preview = content.trim();

        // 移除多余空白字符
        preview = preview.replace(/\s+/g, ' ');

        // 截取预览
        if (preview.length > maxLength) {
            preview = preview.substring(0, maxLength) + '...';
        }

        return preview;
    }



    /**
     * 获取格式化的时间显示
     */
    getFormattedTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diffInSeconds = Math.floor((now - date) / 1000);

        if (diffInSeconds < 60) {
            return '刚刚';
        } else if (diffInSeconds < 3600) {
            return `${Math.floor(diffInSeconds / 60)}分钟前`;
        } else if (diffInSeconds < 86400) {
            return `${Math.floor(diffInSeconds / 3600)}小时前`;
        } else {
            return date.toLocaleDateString('zh-CN');
        }
    }

    /**
     * 获取历史记录
     */
    getHistory(limit = null) {
        const startTime = performance.now();

        let result;

        // 检查内存缓存是否过期
        const now = Date.now();
        const isCacheExpired = now - this.memoryCache.lastUpdated > this.memoryCache.expiryTime;

        // 使用内存缓存
        if (this.memoryCacheEnabled && this.memoryCache.history.length > 0 && !isCacheExpired) {
            // 缓存命中
            this.memoryCache.hitCount++;

            if (limit) {
                result = this.memoryCache.history.slice(0, limit);
            } else {
                result = [...this.memoryCache.history]; // 返回副本
            }
        } else {
            // 缓存未命中或过期
            this.memoryCache.missCount++;

            if (isCacheExpired) {
                console.log('ClipboardHistoryManager: 内存缓存已过期，使用原始数据');
            }

            if (limit) {
                result = this.history.slice(0, limit);
            } else {
                result = [...this.history]; // 返回副本
            }

            // 如果缓存过期，重新预热缓存
            if (isCacheExpired && this.memoryCacheEnabled) {
                this.warmupCache();
            }
        }

        const getTime = performance.now() - startTime;
        if (getTime > 10) {
            console.log(`ClipboardHistoryManager: 获取历史记录耗时: ${getTime.toFixed(2)}ms`);
        }

        // 每100次操作打印一次缓存统计
        if ((this.memoryCache.hitCount + this.memoryCache.missCount) % 100 === 0) {
            const total = this.memoryCache.hitCount + this.memoryCache.missCount;
            const hitRate = total > 0 ? (this.memoryCache.hitCount / total * 100).toFixed(1) : '0.0';
            console.log(`ClipboardHistoryManager: 内存缓存统计 - 命中: ${this.memoryCache.hitCount}, 未命中: ${this.memoryCache.missCount}, 命中率: ${hitRate}%`);
        }

        return result;
    }

    /**
     * 根据ID获取特定历史项
     */
    getItemById(id) {
        const startTime = performance.now();

        // 构建ID到索引的映射（如果不存在）
        if (!this.idMap) {
            this.buildIdMap();
        }

        let item;
        if (this.idMap[id] !== undefined) {
            item = this.history[this.idMap[id]];
        } else {
            // 回退到线性查找
            item = this.history.find(item => item.id === id);
        }

        const getTime = performance.now() - startTime;
        if (getTime > 5) {
            console.log(`ClipboardHistoryManager: 获取历史项耗时: ${getTime.toFixed(2)}ms`);
        }

        return item;
    }

    /**
     * 构建ID映射表
     */
    buildIdMap() {
        this.idMap = {};
        for (let i = 0; i < this.history.length; i++) {
            this.idMap[this.history[i].id] = i;
        }
        console.log(`ClipboardHistoryManager: ID映射表构建完成，条目数: ${Object.keys(this.idMap).length}`);
    }

    /**
     * 更新ID映射表
     */
    updateIdMap() {
        this.buildIdMap();
    }

    /**
     * 删除历史项
     */
    async removeItem(id) {
        const startTime = performance.now();

        try {
            let index;
            if (this.idMap && this.idMap[id] !== undefined) {
                index = this.idMap[id];
            } else {
                index = this.history.findIndex(item => item.id === id);
            }

            if (index !== -1) {
                this.history.splice(index, 1);

                // 更新内存缓存
                if (this.memoryCacheEnabled) {
                    this.warmupCache();
                }

                // 更新ID映射表
                this.updateIdMap();

                await this.saveHistory();
                this.notifySidebarUpdate();

                const removeTime = performance.now() - startTime;
                this.perfStats.operations++;

                if (removeTime > 10) {
                    console.log(`ClipboardHistoryManager: 删除历史项耗时: ${removeTime.toFixed(2)}ms`);
                }

                return true;
            }
            return false;
        } catch (error) {
            console.error('ClipboardHistoryManager: 删除历史项失败:', error);
            return false;
        }
    }

    /**
     * 清空所有历史记录
     */
    async clearHistory() {
        const startTime = performance.now();

        console.log('ClipboardHistoryManager: 开始物理清空所有历史记录');
        this.history = [];
        this.lastClipboardContent = '';

        // 清空内存缓存
        if (this.memoryCacheEnabled) {
            this.memoryCache = {
                history: [],
                lastUpdated: 0,
                size: 0
            };
        }

        // 清空ID映射表
        this.idMap = {};

        try {
            if (this.historyFilePath && fs.existsSync(this.historyFilePath)) {
                // 彻底删除文件
                await fs.promises.unlink(this.historyFilePath);
                console.log('ClipboardHistoryManager: 历史记录文件已删除');
            }
        } catch (error) {
            console.error('ClipboardHistoryManager: 删除历史记录文件失败:', error);
        }

        this.notifySidebarUpdate();

        const clearTime = performance.now() - startTime;
        this.perfStats.operations++;

        console.log(`ClipboardHistoryManager: 物理清空完成，耗时: ${clearTime.toFixed(2)}ms`);
    }

    /**
     * 保存历史记录到文件系统
     */
    async saveHistory() {
        // 批处理保存逻辑
        if (this.batchSaveEnabled && this.pendingChanges < this.batchSaveThreshold) {
            this.pendingChanges++;
            if (this.batchSaveTimer) {
                clearTimeout(this.batchSaveTimer);
            }
            this.batchSaveTimer = setTimeout(() => {
                this.forceSave();
            }, this.saveThrottleInterval);
            return;
        }

        await this.forceSave();
    }

    /**
     * 强制保存历史记录
     */
    async forceSave() {
        const startTime = performance.now();

        // 处理并发写入
        if (this.isSaving) {
            this.saveQueue = true;
            return;
        }

        this.isSaving = true;
        this.saveQueue = false;
        this.pendingChanges = 0;
        this.lastSaveTime = Date.now();

        if (this.batchSaveTimer) {
            clearTimeout(this.batchSaveTimer);
            this.batchSaveTimer = null;
        }

        try {
            if (!this.historyFilePath) {
                console.warn('ClipboardHistoryManager: 存储路径未初始化，仅保存在内存中');
                return;
            }

            // 准备要保存的数据
            const dataToSave = {
                history: this.history,
                version: '1.0',
                lastUpdated: this.lastSaveTime,
                metadata: {
                    itemCount: this.history.length,
                    autoCleanupDays: this.autoCleanupDays,
                    maxHistoryItems: this.maxHistoryItems,
                    optimizationLevel: this.optimizationLevel
                }
            };

            let serializedData;
            let fileOptions = { flag: 'w' };

            // 使用更高效的序列化方式
            if (msgpack) {
                try {
                    serializedData = msgpack.encode(dataToSave);
                    fileOptions.encoding = null; // 二进制模式
                } catch (error) {
                    console.warn('ClipboardHistoryManager: MessagePack 序列化失败，回退到 JSON');
                    serializedData = JSON.stringify(dataToSave);
                    fileOptions.encoding = 'utf8';
                }
            } else {
                serializedData = JSON.stringify(dataToSave);
                fileOptions.encoding = 'utf8';
            }

            // 写入文件
            await fs.promises.writeFile(
                this.historyFilePath,
                serializedData,
                fileOptions
            );

            const saveTime = performance.now() - startTime;
            this.perfStats.saveTime += saveTime;
            this.perfStats.operations++;

            console.log(`ClipboardHistoryManager: 成功保存历史记录，当前长度: ${this.history.length}, 耗时: ${saveTime.toFixed(2)}ms`);
        } catch (error) {
            console.error('ClipboardHistoryManager: 保存剪切板历史失败:', error);
        } finally {
            this.isSaving = false;

            // 处理队列中的保存请求
            if (this.saveQueue) {
                setTimeout(() => this.forceSave(), 100);
            }
        }
    }

    /**
     * 从文件系统加载历史记录
     */
    async loadHistory() {
        const startTime = performance.now();

        try {
            if (!this.historyFilePath || !fs.existsSync(this.historyFilePath)) {
                console.log('ClipboardHistoryManager: 历史记录文件不存在，初始化空历史');
                this.history = [];
                return;
            }

            // 读取文件（使用异步读取，避免阻塞事件循环）
            const fileReadStart = performance.now();
            const data = await fs.promises.readFile(this.historyFilePath);
            const fileReadTime = performance.now() - fileReadStart;
            if (fileReadTime > 100) {
                console.log(`ClipboardHistoryManager: 文件读取耗时: ${fileReadTime.toFixed(2)}ms`);
            }

            // 反序列化数据
            const deserializeStart = performance.now();
            let parsedData;

            // 快速判断文件类型并选择反序列化方式
            const fileExtension = path.extname(this.historyFilePath).toLowerCase();
            if (fileExtension === '.bin' && msgpack) {
                try {
                    parsedData = msgpack.decode(data);
                } catch (error) {
                    console.warn('ClipboardHistoryManager: MessagePack 反序列化失败，尝试 JSON');
                    try {
                        parsedData = JSON.parse(data.toString('utf8'));
                    } catch (jsonError) {
                        throw new Error('无法解析历史记录文件');
                    }
                }
            } else {
                // 直接使用 JSON 反序列化
                parsedData = JSON.parse(data.toString('utf8'));
            }

            const deserializeTime = performance.now() - deserializeStart;
            if (deserializeTime > 100) {
                console.log(`ClipboardHistoryManager: 反序列化耗时: ${deserializeTime.toFixed(2)}ms`);
            }

            // 验证数据格式
            if (parsedData && Array.isArray(parsedData.history)) {
                const processStart = performance.now();

                // 批量处理历史记录
                this.history = parsedData.history.map(item => {
                    // 确保所有必需字段存在
                    return {
                        id: item.id || this.generateId(),
                        content: item.content || '',
                        timestamp: item.timestamp || Date.now(),
                        type: 'text', // 强制设置为文本类型
                        preview: item.preview || this.getContentPreview(item.content || ''),
                        contentLength: item.contentLength || (item.content ? item.content.length : 0),
                        hash: item.hash || (item.content ? this.generateContentHash(item.content) : '')
                    };
                });

                // 按时间戳排序（最新的在前面）
                this.history.sort((a, b) => b.timestamp - a.timestamp);

                // 限制历史记录数量
                if (this.history.length > this.maxHistoryItems) {
                    this.history = this.history.slice(0, this.maxHistoryItems);
                }

                const processTime = performance.now() - processStart;
                if (processTime > 100) {
                    console.log(`ClipboardHistoryManager: 数据处理耗时: ${processTime.toFixed(2)}ms`);
                }

                // 更新内存缓存
                if (this.memoryCacheEnabled) {
                    this.warmupCache();
                }

                // 构建ID映射表
                this.buildIdMap();

                const loadTime = performance.now() - startTime;
                this.perfStats.loadTime += loadTime;
                this.perfStats.operations++;

                console.log(`ClipboardHistoryManager: 成功加载历史记录，共 ${this.history.length} 项，耗时: ${loadTime.toFixed(2)}ms`);
            } else {
                console.warn('ClipboardHistoryManager: 历史记录文件格式不正确，初始化空历史');
                this.history = [];
            }
        } catch (error) {
            console.error('ClipboardHistoryManager: 加载剪切板历史失败:', error);
            this.history = [];
        }
    }

    /**
     * 通知侧边栏更新
     */
    notifySidebarUpdate() {
        // 通过事件或全局变量通知侧边栏刷新
        if (global && global.clipboardHistoryUpdated) {
            global.clipboardHistoryUpdated();
        }
    }

    /**
     * 将内容复制到剪切板
     */
    async copyToClipboard(content) {
        try {
            await vscode.env.clipboard.writeText(content);
            return true;
        } catch (error) {
            console.error('复制到剪切板失败:', error);
            return false;
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            totalCount: this.history.length,
            lastUpdated: this.history.length > 0 ? this.history[0].timestamp : null
        };
    }

    /**
     * 销毁管理器
     */
    async dispose() {
        this.stopWatching();
        await this.saveHistory();
    }
}

module.exports = ClipboardHistoryManager;
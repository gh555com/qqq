const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ClipboardHistoryManager {
    constructor(context) {
        this.context = context;
        this.history = [];
        this.maxHistoryItems = 100; // 最大历史记录数
        this.clipboardWatcher = null;
        this.lastClipboardContent = '';
        this.isWatching = false;

        // 确定存储路径：使用 globalStorageUri 避免 GlobalState 警告
        // 确保 globalStorageUri 存在（VS Code 可能会返回 undefined，虽然现在的版本通常都有）
        if (this.context.globalStorageUri) {
            this.storageDir = this.context.globalStorageUri.fsPath;
            this.storageFile = path.join(this.storageDir, 'clipboard-history.json');
        } else {
            // 回退方案：使用 globalStoragePath (已弃用但可能需要作为兼容) 或其他路径
            // 这里为了安全，如果真的没有 globalStorageUri，我们可能只能回退到 globalState 或者临时目录
            // 但通常扩展激活时会有这个 URI
            this.storageDir = path.join(this.context.extensionPath, 'storage'); // 不推荐，但作为最后手段
            this.storageFile = path.join(this.storageDir, 'clipboard-history.json');
        }

        // 初始化
        this.memoryCache = {
            history: [],
            lastUpdated: 0,
            size: 0,
            maxSize: 25 * 1024 * 1024,     // 25MB 内存限制
            expiryTime: 25 * 60 * 1000,    // 25分钟过期
            hitCount: 0,
            missCount: 0
        };

        this.pendingChanges = 0;
        this.batchSaveThreshold = 5;
        this.saveThrottleInterval = 1000;
        this.isSaving = false;
        this.saveQueue = false;
        this.autoCleanupDays = 30;

        this.perfStats = {
            saveTime: 0,
            loadTime: 0,
            addTime: 0,
            operations: 0
        };
        this._isDisposed = false;

        // 异步初始化，不阻塞构造函数
        this.initPromise = this.init();
    }

    async init() {
        // 1. 初始化存储 (关键路径)
        await this.initStorage();

        // 2. 启动自动清理 (次要路径)
        this.startAutoCleanup();

        // 3. 延迟清理旧数据 (低优先级)
        setTimeout(() => this.cleanupLegacyStorage(), 5000);
    }

    /**
     * 生成内容哈希 (MD5)
     */
    generateContentHash(content) {
        return crypto.createHash('md5').update(content).digest('hex');
    }

    /**
     * 构建ID映射表
     */
    buildIdMap() {
        this.idMap = {};
        for (let i = 0; i < this.history.length; i++) {
            this.idMap[this.history[i].id] = i;
        }
    }

    /**
     * 根据ID获取特定历史项 (优化版)
     */
    getItemById(id) {
        if (this.idMap && this.idMap[id] !== undefined) {
            this.memoryCache.hitCount++;
            return this.history[this.idMap[id]];
        }
        // 回退查找
        const item = this.history.find(item => item.id === id);
        if (item) this.memoryCache.missCount++;
        return item;
    }

    async cleanupLegacyStorage() {
        try {
            // 清理可能导致 "large extension state" 警告的旧 GlobalState 数据
            const legacyKey = 'qqq_clipboard_history';
            // 检查是否存在（虽然 get 返回 undefined 表示不存在，但为了保险起见，我们显式清理）
            // 注意：VS Code 的 globalState.get 默认值机制，这里我们不传默认值
            const legacyData = this.context.globalState.get(legacyKey);

            if (legacyData !== undefined) {
                console.log('ClipboardHistoryManager: 检测到旧的 GlobalState 数据，正在清理...');
                // 更新为 undefined 以删除键
                await this.context.globalState.update(legacyKey, undefined);
                console.log('ClipboardHistoryManager: 旧的 GlobalState 数据已清除');
            }
        } catch (error) {
            console.error('ClipboardHistoryManager: 清理旧数据失败:', error);
        }
    }

    async initStorage() {
        try {
            // 尝试创建目录，如果已存在会抛错 (EEXIST)，忽略即可
            // 使用 mkdir 而不是 access+mkdir 以减少系统调用
            await fs.promises.mkdir(this.storageDir, { recursive: true });
        } catch (error) {
            // 忽略目录已存在错误
            if (error.code !== 'EEXIST') {
                console.error('存储目录创建失败:', error);
            }
        }
        await this.loadHistory();
    }

    /**
     * 开始监听剪切板变化
     */
    startWatching() {
        if (this._isDisposed) return;
        if (this.isWatching) return;

        this.isWatching = true;
        this.lastClipboardContent = '';

        // 使用 setInterval 轮询剪切板变化
        // 相比 VS Code 的 clipboard API 事件，轮询更可靠且能捕获外部变化
        if (this.watchInterval) clearInterval(this.watchInterval);

        this.watchInterval = setInterval(async () => {
            if (this._isDisposed) {
                if (this.watchInterval) clearInterval(this.watchInterval);
                return;
            }
            await this.checkClipboard();
        }, 1000); // 1秒检查一次

        console.log('ClipboardHistoryManager: 剪切板监听已启动');
    }

    /**
     * 检查剪切板内容
     */
    async checkClipboard() {
        try {
            const currentContent = await vscode.env.clipboard.readText();

            // 只有当内容发生变化且非空时才记录
            if (currentContent && currentContent !== this.lastClipboardContent) {
                this.addToHistory(currentContent);
                this.lastClipboardContent = currentContent;

                // 通知侧边栏更新
                this.notifySidebarUpdate();
            }
        } catch (error) {
            // 静默处理错误，避免影响主流程
            console.debug('剪切板读取失败:', error.message);
        }
    }

    /**
     * 停止监听剪切板变化
     */
    stopWatching() {
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
            this.watchInterval = null;
        }
        this.isWatching = false;
        console.log('ClipboardHistoryManager: 剪切板监听已停止');
    }

    /**
     * 启动自动清理
     */
    startAutoCleanup() {
        // 每天执行一次
        this.cleanupTimer = setInterval(() => {
            if (this._isDisposed) {
                if (this.cleanupTimer) clearInterval(this.cleanupTimer);
                return;
            }
            this.cleanupExpiredItems();
        }, 24 * 60 * 60 * 1000);

        // 启动时也检查一次
        setTimeout(() => {
            if (!this._isDisposed) this.cleanupExpiredItems();
        }, 5000);
    }

    /**
     * 清理过期项目
     */
    cleanupExpiredItems() {
        try {
            const cutoffTime = Date.now() - (this.autoCleanupDays * 24 * 60 * 60 * 1000);
            const initialLength = this.history.length;

            this.history = this.history.filter(item => item.timestamp >= cutoffTime);

            if (this.history.length < initialLength) {
                console.log(`自动清理: 移除了 ${initialLength - this.history.length} 个过期项目`);
                this.buildIdMap();
                this.saveHistory();
            }
        } catch (error) {
            console.error('自动清理失败:', error);
        }
    }

    /**
     * 添加内容到历史记录 (优化版)
     */
    addToHistory(content) {
        if (!content || typeof content !== 'string') return;

        const startTime = performance.now();

        // 计算哈希用于去重
        const contentHash = this.generateContentHash(content);

        // O(n) -> O(1) 优化去重逻辑 (这里仍然需要遍历，但可以用哈希比对加速字符串比较)
        // 如果有 contentMap 会更快，但为了节省内存暂时只用哈希
        // 实际上我们可以维护一个 Set<Hash> 来快速判断是否存在，但这会增加复杂性
        // 对于 100 条记录，线性查找足够快，关键是比较大字符串时哈希更快

        let existingIndex = -1;
        // 优化查找
        for (let i = 0; i < this.history.length; i++) {
            // 简单的长度检查预筛选
            if (this.history[i].content.length === content.length) {
                // 这里可以缓存 history item 的 hash，进一步加速
                if (this.history[i].content === content) {
                    existingIndex = i;
                    break;
                }
            }
        }

        if (existingIndex !== -1) {
            // 移动到最前
            const [existingItem] = this.history.splice(existingIndex, 1);
            existingItem.timestamp = Date.now();
            this.history.unshift(existingItem);
        } else {
            // 新建
            const historyItem = {
                id: this.generateId(),
                content: content,
                timestamp: Date.now(),
                type: 'text', // 强制回归纯文本，不再进行复杂的类型检测
                preview: this.getContentPreview(content)
            };

            this.history.unshift(historyItem);

            // 限制数量
            if (this.history.length > this.maxHistoryItems) {
                this.history = this.history.slice(0, this.maxHistoryItems);
            }
        }

        // 重建索引
        this.buildIdMap();

        // 性能统计
        this.perfStats.addTime += (performance.now() - startTime);
        this.perfStats.operations++;

        // 保存 (带节流)
        this.saveHistory();
    }

    /**
     * 保存历史记录 (带节流和并发控制)
     */
    async saveHistory() {
        if (this._isDisposed) return;
        // 批处理逻辑
        if (this.pendingChanges < this.batchSaveThreshold) {
            this.pendingChanges++;
            if (this.saveTimer) clearTimeout(this.saveTimer);
            this.saveTimer = setTimeout(() => {
                if (!this._isDisposed) this.forceSave();
            }, this.saveThrottleInterval);
            return;
        }
        await this.forceSave();
    }

    /**
     * 强制保存
     */
    async forceSave() {
        // 并发控制
        if (this.isSaving) {
            this.saveQueue = true;
            return;
        }

        this.isSaving = true;
        this.pendingChanges = 0;
        if (this.saveTimer) clearTimeout(this.saveTimer);

        const startTime = performance.now();

        try {
            if (!fs.existsSync(this.storageDir)) {
                await fs.promises.mkdir(this.storageDir, { recursive: true });
            }

            // 使用 Buffer 写入，略微优于字符串，但主要瓶颈在 I/O
            // 如果未来有 msgpack，这里替换为 msgpack.encode
            const data = JSON.stringify(this.history);
            await fs.promises.writeFile(this.storageFile, data, 'utf8');

            this.perfStats.saveTime += (performance.now() - startTime);

        } catch (error) {
            console.error('保存剪切板历史失败:', error);
        } finally {
            this.isSaving = false;
            if (this.saveQueue && !this._isDisposed) {
                this.saveQueue = false;
                setTimeout(() => {
                    if (!this._isDisposed) this.forceSave();
                }, 100);
            }
        }
    }

    /**
     * 检测内容类型
     */
    detectContentType(content) {
        // 检查是否为URL
        if (this.isValidUrl(content)) {
            return 'url';
        }

        // 检查是否为文件路径
        if (this.isFilePath(content)) {
            return 'file';
        }

        // 检查是否为邮箱
        if (this.isEmail(content)) {
            return 'email';
        }

        // 检查是否为代码片段
        if (this.isCodeSnippet(content)) {
            return 'code';
        }

        // 默认为文本
        return 'text';
    }

    /**
     * 验证URL
     */
    isValidUrl(string) {
        try {
            const url = new URL(string);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    /**
     * 检查是否为文件路径
     */
    isFilePath(content) {
        // 简单的文件路径检测
        return content.includes('\\') || content.includes('/') ||
            content.match(/^[A-Za-z]:\\/); // Windows驱动器路径
    }

    /**
     * 检查是否为邮箱
     */
    isEmail(content) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(content.trim());
    }

    /**
     * 检查是否为代码片段
     */
    isCodeSnippet(content) {
        // 检查常见的代码特征
        const codeIndicators = [
            /function\s+\w+/,
            /\w+\s*\([^)]*\)\s*{/,
            /if\s*\([^)]*\)/,
            /for\s*\([^)]*\)/,
            /while\s*\([^)]*\)/,
            /console\.log/,
            /import\s+.+from/,
            /export\s+(default\s+)?(function|class|const|let|var)/,
            /class\s+\w+/,
            /const\s+\w+\s*=/
        ];

        return codeIndicators.some(regex => regex.test(content));
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
        if (limit) {
            return this.history.slice(0, limit);
        }
        return [...this.history]; // 返回副本
    }

    /**
     * 删除历史项
     */
    removeItem(id) {
        const index = this.history.findIndex(item => item.id === id);
        if (index !== -1) {
            this.history.splice(index, 1);
            this.saveHistory();
            this.notifySidebarUpdate();
            return true;
        }
        return false;
    }

    /**
     * 清空所有历史记录
     */
    async clearHistory() {
        console.log('ClipboardHistoryManager: 开始物理清空所有历史记录');
        this.history = [];
        this.lastClipboardContent = '';

        try {
            if (fs.existsSync(this.storageFile)) {
                await fs.promises.unlink(this.storageFile);
            }
        } catch (error) {
            console.error('清空历史文件失败:', error);
        }

        this.notifySidebarUpdate();
        console.log('ClipboardHistoryManager: 物理清空完成');
    }

    /**
     * 从文件加载历史记录
     * 使用异步读取以避免阻塞
     */
    async loadHistory() {
        const startTime = performance.now();
        try {
            const data = await fs.promises.readFile(this.storageFile, 'utf8');
            if (data) {
                // 将 JSON.parse 放在 try 块中，但不包含在 readFile 的 await 中
                const savedHistory = JSON.parse(data);
                this.history = Array.isArray(savedHistory) ? savedHistory : [];

                // 确保所有历史记录项的类型都是 'text'
                // 使用普通的 for 循环通常比 forEach 快一点点，且无闭包开销
                for (let i = 0; i < this.history.length; i++) {
                    this.history[i].type = 'text';
                }
            }
        } catch (error) {
            // 文件不存在是正常情况，初始化为空数组
            if (error.code === 'ENOENT') {
                this.history = [];
            } else {
                console.error('加载剪切板历史失败:', error);
                this.history = [];
            }
        } finally {
            // 无论成功失败，都记录耗时并构建索引
            const duration = performance.now() - startTime;
            this.perfStats.loadTime += duration;

            // 立即构建索引，加速后续查找
            this.buildIdMap();

            console.log(`ClipboardHistoryManager: 历史记录加载完成 | 条目数: ${this.history.length} | 耗时: ${duration.toFixed(2)}ms`);
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
        const typeCounts = {};
        this.history.forEach(item => {
            typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
        });

        return {
            totalCount: this.history.length,
            typeCounts: typeCounts,
            lastUpdated: this.history.length > 0 ? this.history[0].timestamp : null
        };
    }

    /**
     * 销毁管理器
     */
    dispose() {
        this._isDisposed = true;
        this.stopWatching();

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        // 尝试同步保存一次，确保数据不丢失（但不要太久）
        try {
            if (this.history.length > 0 && fs.existsSync(this.storageDir)) {
                fs.writeFileSync(this.storageFile, JSON.stringify(this.history), 'utf8');
            }
        } catch (e) {
            console.error('Dispose save failed:', e);
        }
    }
}

class SidebarWebViewProvider {
    constructor(context, globalModule) {
        this.context = context;
        this.global = globalModule;
        this._view = null;
        this.updateInterval = null;
        this.scrollPosition = null;
        this._isDisposed = false;

        // 确保可以访问 extensionContext
        if (!this.global.extensionContext && typeof extensionContext !== 'undefined') {
            this.global.extensionContext = extensionContext;
        }
    }

    resolveWebviewView(webviewView, context, token) {
        if (this._isDisposed) return;
        this._view = webviewView;

        const extensionUri = vscode.Uri.file(this.context.extensionPath);

        webviewView.webview.options = {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
            contentSecurityPolicy: `default-src 'none'; script-src 'unsafe-inline' vscode-webview-resource:; style-src 'unsafe-inline' vscode-webview-resource:; img-src vscode-webview-resource: data:; font-src vscode-webview-resource:; media-src vscode-webview-resource:;`
        };

        // 设置面板图标
        const iconPath = path.join(this.context.extensionPath, "assets", "q.gif");
        if (fs.existsSync(iconPath)) {
            webviewView.webview.iconPath = vscode.Uri.file(iconPath);
        }

        this.updateContent();

        // 定期更新数据
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        this.updateInterval = setInterval(() => {
            if (this._isDisposed) {
                if (this.updateInterval) clearInterval(this.updateInterval);
                return;
            }
            this.updateContent();
        }, 5000);

        // 处理来自 webview 的消息
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (this._isDisposed) return;
            // 过滤掉 updateData 消息，这是前端误发的
            if (message.command === 'updateData') return;
            // 过滤掉无效的 playAudio 消息
            if (message.command === 'playAudio' && !message.audioUrl && !message.base64) return;

            // console.log('收到 Webview 消息:', message.command, message.itemId); // 减少日志噪音
            switch (message.command) {
                case "executeCommand":
                    if (message.cmd) {
                        vscode.commands.executeCommand(message.cmd);
                    }
                    break;
                case "openSettings":
                    vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
                    break;
                case "refresh":
                    if (message.scrollPosition) {
                        this.scrollPosition = message.scrollPosition;
                    }
                    this.updateContent();
                    break;
                case "copyToClipboard":
                    if (this.global.clipboardHistoryManager && message.itemId) {
                        const item = this.global.clipboardHistoryManager.getItemById(message.itemId);
                        if (item) {
                            await this.global.clipboardHistoryManager.copyToClipboard(item.content);
                            vscode.window.showInformationMessage('已复制到剪切板');
                        }
                    }
                    break;
                case "deleteHistoryItem":
                    if (!this.global.clipboardHistoryManager) {
                        console.error('致命错误: clipboardHistoryManager 未初始化');
                        vscode.window.showErrorMessage('内部错误: 剪切板管理器未就绪');
                        break;
                    }
                    if (message.itemId) {
                        console.log('Webview 请求删除项目 ID:', message.itemId);
                        const success = this.global.clipboardHistoryManager.removeItem(message.itemId);
                        if (success) {
                            this.updateContent();
                            vscode.window.setStatusBarMessage('已删除该条历史', 3000);
                        } else {
                            console.warn('删除失败，可能是 ID 不匹配，强制刷新视图');
                            this.updateContent();
                        }
                    }
                    break;
                case "openUrl":
                    if (message.url) {
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    break;
                case "openFile":
                    if (message.path) {
                        vscode.workspace.openTextDocument(message.path).then(doc => {
                            vscode.window.showTextDocument(doc);
                        }, err => {
                            vscode.window.showErrorMessage('无法打开文件: ' + err.message);
                        });
                    }
                    break;
                case "insertText":
                    if (message.text) {
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            editor.edit(editBuilder => {
                                editBuilder.insert(editor.selection.active, message.text);
                            });
                        } else {
                            // 如果没有活动编辑器，则回退到复制
                            vscode.env.clipboard.writeText(message.text);
                            vscode.window.showInformationMessage('没有活动的编辑器，内容已复制到剪切板');
                        }
                    }
                    break;
                case "clearAllHistory":
                    if (!this.global.clipboardHistoryManager) {
                        console.error('致命错误: clipboardHistoryManager 未初始化');
                        vscode.window.showErrorMessage('内部错误: 剪切板管理器未就绪');
                        break;
                    }

                    // 在后台调用 VS Code 原生确认框，不会被拦截
                    const answer = await vscode.window.showWarningMessage(
                        '确定要清空所有的剪切板历史记录吗？此操作不可撤销。',
                        { modal: true },
                        '确定清空'
                    );

                    if (answer === '确定清空') {
                        console.log('Webview 请求清空所有历史');
                        await this.global.clipboardHistoryManager.clearHistory();
                        this.updateContent();
                        vscode.window.showInformationMessage('剪切板数据库已物理清空');
                    }
                    break;
            }
        });

        // 清理定时器
        webviewView.onDidDispose(() => {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
                this.updateInterval = null;
            }
        });
    }

    updateContent() {
        if (this._isDisposed || !this._view || !this._view.webview) return;

        try {
            // 获取剪切板历史数据
            let clipboardHistory = [];
            if (this.global.clipboardHistoryManager) {
                clipboardHistory = this.global.clipboardHistoryManager.getHistory(30).map(item => ({
                    ...item,
                    time: this.getFormattedTime(item.timestamp),
                    preview: item.preview ? (item.preview.length > 200 ? item.preview.substring(0, 200) + '...' : item.preview) : ''
                }));
            }

            // 使用全局统计快照替代同步文件扫描，避免阻塞主线程
            let cacheStats = { totalSize: 0 };
            if (this.global && this.global.getCacheStatsSnapshot) {
                cacheStats = this.global.getCacheStatsSnapshot();
            } else {
                // 回退方案：如果全局不可用且这是第一次运行，执行一次轻量检查
                // 注意：由于 calculateActualCacheSize 是同步的，我们尽量避免在这里调用它
                cacheStats = { totalSize: 0 };
            }

            let totalSeconds = 0, h = 0, m = 0;

            // 使用 globalState 获取统计数据（保持原有逻辑）
            if (this.context && this.context.globalState) {
                const base = this.context.globalState.get("qqq_stats_total_seconds", 0) || 0;
                const lastFlush = this.context.globalState.get("qqq_stats_last_flush");
                if (lastFlush) {
                    totalSeconds = base + ((Date.now() - lastFlush) / 1000);
                } else {
                    totalSeconds = base;
                }
                h = Math.floor(totalSeconds / 3600);
                m = Math.floor((totalSeconds % 3600) / 60);
                this._view.title = `${h}h ${m}m`;
            }

            const cacheMB = cacheStats.totalSize / (1024 * 1024);
            let hitRate = 0;
            if (this.global && this.global.getPersistentCacheStatsSnapshot) {
                const pstats = this.global.getPersistentCacheStatsSnapshot();
                const denom = pstats.hitTotal + pstats.missTotal;
                hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;
            }

            const activeEngine = this.getActiveEngineInfo();
            // 转义引擎详情和名称
            activeEngine.name = this.escapeHtml(activeEngine.name);
            activeEngine.details = this.escapeHtml(activeEngine.details);

            const soundUri = this._view.webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "assets", "q.mp3")));

            // 如果已经有 HTML，则通过安全的 postMessage 接口更新数据
            if (this._view.webview.html && this._view.webview.html.length > 100) {
                this.postMessage({
                    command: 'updateData',
                    stats: { h, m, cacheMB, hitRate, engineInfo: activeEngine },
                    history: clipboardHistory
                });
            } else {
                this._view.webview.html = this.getWebviewContent(h, m, cacheMB, hitRate, activeEngine, clipboardHistory, this.scrollPosition, soundUri.toString());
            }
        } catch (error) {
            console.error('更新内容失败:', error);
        }
    }

    dispose() {
        this._isDisposed = true;
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        this._view = null;
    }

    async postMessage(message) {
        if (this._isDisposed || !this._view || !this._view.webview) return;

        try {
            // 确保消息对象是纯粹的 POJO，防止 toJSON 序列化错误
            const safeMessage = JSON.parse(JSON.stringify(message));
            await this._view.webview.postMessage(safeMessage);
        } catch (e) {
            // 记录到日志，不再引发 IDE 级联错误
            if (this.global && this.global.logMessage) {
                this.global.logMessage(`Sidebar postMessage failed: ${e.message}`, "WARN");
            }
        }
    }

    calculateActualCacheSize() {
        try {
            // 获取缓存目录路径
            const cacheDirName = "qqq_cache";
            const cacheDir = path.join(this.context.globalStorageUri.fsPath, cacheDirName);

            // 检查目录是否存在
            if (!fs.existsSync(cacheDir)) {
                return { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };
            }

            // 递归计算目录大小
            let totalSize = 0;
            let fileCount = 0;

            function calculateDirSize(dirPath) {
                try {
                    const items = fs.readdirSync(dirPath);
                    for (const item of items) {
                        const itemPath = path.join(dirPath, item);
                        const stats = fs.statSync(itemPath);

                        if (stats.isDirectory()) {
                            calculateDirSize(itemPath);
                        } else {
                            totalSize += stats.size;
                            fileCount++;
                        }
                    }
                } catch (error) {
                    // 静默处理错误
                }
            }

            calculateDirSize(cacheDir);

            return {
                totalSize: totalSize,
                fileCount: fileCount,
                hitCount: 0,
                missCount: 0
            };

        } catch (error) {
            return { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };
        }
    }

    getActiveEngineInfo() {
        try {
            // 直接使用全局函数获取引擎信息
            if (this.global.getActiveEngineCode && this.global.getActiveEngineName) {
                const code = this.global.getActiveEngineCode(
                    this.global.pythonBridge,
                    this.global.rustBridge,
                    this.global.shellBridge
                );

                const name = this.global.getActiveEngineName(
                    this.global.pythonBridge,
                    this.global.rustBridge,
                    this.global.shellBridge
                );

                let details;
                switch (code) {
                    case 'P':
                        details = 'Python 引擎';
                        break;
                    case 'R':
                        details = 'Rust 引擎';
                        break;
                    default:
                        // 对于 Node 引擎，需要额外判断模式
                        if (this.global.shellBridge?.isAvailable?.()) {
                            details = 'Shell daemon 模式';
                        } else {
                            details = 'Spawn 模式';
                        }
                }

                return {
                    code: code,
                    name: name.includes('Node') ? 'Node' : name,
                    details: details
                };
            }
        } catch (error) {
            // 静默处理错误
        }

        return {
            code: 'N',
            name: '未知',
            details: '无法确定当前引擎'
        };
    }



    /**
     * 获取格式化时间显示
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
     * HTML转义
     */
    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    getWebviewContent(hours, minutes, cacheMB, hitRate, engineInfo, clipboardHistory = [], scrollPosition = null, audioUri = '') {
        const historyHtml = clipboardHistory.length > 0
            ? clipboardHistory.map(item => {
                // 强制回归纯文本
                let typeIcon = '📄';
                let typeClass = 'type-text';

                return `
                <div class="history-item ${typeClass}" data-id="${this.escapeHtml(item.id)}">
                    <div class="item-header">
                        <span class="item-type" title="text">${typeIcon}</span>
                        <span class="item-time">${item.time}</span>
                    </div>
                    <div class="item-preview">${this.escapeHtml(item.preview)}</div>
                    <div class="item-actions">
                        <button class="action-mini-btn" onclick="handleCopy(this)">📋 复制</button>
                        <button class="action-mini-btn" onclick="handleDelete(this)">🗑️ 删除</button>
                    </div>
                </div>`;
            }).join('')
            : '<div style="text-align:center;padding:20px;opacity:0.5;">暂无记录</div>';

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <style>
        :root {
            --base03: #002b36; --base02: #073642; --base01: #586e75; --base00: #657b83;
            --base0: #839496; --base1: #93a1a1; --base2: #eee8d5; --base3: #fdf6e3;
            --yellow: #b58900; --orange: #cb4b16; --red: #dc322f; --magenta: #d33682;
            --violet: #6c71c4; --blue: #268bd2; --cyan: #2aa198; --green: #859900;
            --primary-color: var(--yellow); --secondary-color: var(--orange);
            --background-color: var(--base3); --card-bg: var(--base2);
            --text-primary: var(--base00); --text-secondary: var(--base01);
            --border-color: var(--base1); --shadow-color: rgba(0, 0, 0, 0.1);
        }

        /* 强力破解 Windows 高对比度模式，强制保留自定义配色 */
        html {
            forced-color-adjust: none !important;
            -ms-high-contrast-adjust: none !important;
        }

        ::-webkit-scrollbar { display: none !important; }

        * {
            scrollbar-width: none !important;
            -ms-overflow-style: none !important;
            box-sizing: border-box;
            forced-color-adjust: none !important;
            -ms-high-contrast-adjust: none !important;
            overflow-x: hidden !important;
        }

        html, body {
            margin: 0; padding: 0; height: 100vh; width: 100%; overflow: hidden;
            font-family: var(--vscode-font-family, sans-serif);
            background: var(--background-color) !important;
            color: var(--text-primary) !important;
        }

        /* 音乐播放器样式 */
        .music-player {
            background: var(--base02);
            color: var(--base3);
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 0.9em;
        }
        .music-info { display: flex; align-items: center; gap: 8px; }
        .music-btns { display: flex; gap: 10px; }
        .music-btn { cursor: pointer; opacity: 0.8; transition: 0.2s; }
        .music-btn:hover { opacity: 1; transform: scale(1.1); }
        .music-playing { color: var(--green); font-weight: bold; }

        .main-wrapper {
            height: 100vh; width: 100%; position: relative; overflow: hidden;
            background: var(--background-color) !important;
        }

        .main-content {
            height: 100%; overflow-y: scroll; padding: 12px; overflow-x: hidden !important;
        }

        .section-title {
            font-size: 1.1em; font-weight: 700; margin: 20px 0 12px 0;
            padding-bottom: 5px; border-bottom: 2px solid var(--primary-color) !important;
            color: var(--primary-color) !important; text-transform: uppercase;
        }

        /* Captain Style */
        .captain-grid { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 20px; }
        .cmd-btn {
            background: var(--card-bg) !important; border: 1px solid var(--border-color) !important;
            border-radius: 4px; padding: 12px; cursor: pointer;
            display: flex; align-items: center; gap: 10px;
            transition: all 0.2s ease; position: relative; overflow: hidden;
            color: var(--text-primary) !important; text-decoration: none;
        }
        .cmd-btn:hover { border-color: var(--primary-color) !important; background: white !important; transform: translateX(2px); }
        .cmd-btn::before { content: ''; position: absolute; left: 0; top: 0; height: 100%; width: 4px; background: var(--primary-color) !important; opacity: 0.6; }

        /* Dial Style */
        .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
        .stat-card { background: linear-gradient(135deg, var(--primary-color), var(--secondary-color)) !important; padding: 10px; border-radius: 6px; color: white !important; box-shadow: 0 2px 4px var(--shadow-color); }
        .stat-card.engine-card { grid-column: span 2; background: var(--base02) !important; }
        .stat-title { font-size: 0.8em; opacity: 0.9; }
        .stat-value { font-size: 1.1em; font-weight: 700; }

        /* Passed by Style */
        .history-container { position: relative; border: 1px solid var(--border-color); border-radius: 4px; background: var(--card-bg); margin-bottom: 10px; }
        .history-list { max-height: 800px; overflow-y: scroll; padding: 8px; overflow-x: hidden !important; }
        .history-item { background: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; margin-bottom: 8px; cursor: pointer; transition: 0.2s; position: relative; }
        .history-item:hover { border-color: var(--primary-color); box-shadow: 0 2px 4px var(--shadow-color); }

        .item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .item-type { font-size: 1.2em; margin-right: 5px; }
        .item-time { font-size: 0.7em; color: var(--text-secondary); }
        .item-preview { font-size: 0.85em; white-space: pre-wrap; word-break: break-all; max-height: 50px; overflow: hidden; }
        .item-actions { display: flex; gap: 6px; margin-top: 5px; }

        /* Type specific styles */
        .type-text .item-preview { color: var(--text-primary); }

        .action-mini-btn {
            padding: 2px 8px; font-size: 0.75em; border: 1px solid var(--border-color);
            border-radius: 3px; background: var(--base3); cursor: pointer; color: var(--text-primary);
        }
        .action-mini-btn:hover { background: var(--primary-color); color: white; }

        /* Custom Scrollbars */
        .scrollbar-outer { position: absolute; right: 0; top: 0; width: 6px; height: 100%; z-index: 1000; pointer-events: none; }
        .scrollbar-outer-thumb { position: absolute; right: 1px; width: 4px; background: #000 !important; border-radius: 3px; opacity: 0.4; cursor: pointer; pointer-events: auto; forced-color-adjust: none !important; }
        .scrollbar-outer-thumb:hover { opacity: 0.7; width: 6px; right: 0; }

        .scrollbar-inner { position: absolute; right: 0; top: 0; width: 6px; height: 100%; z-index: 10; pointer-events: none; }
        .scrollbar-inner-thumb { position: absolute; right: 1px; width: 4px; background: var(--red) !important; border-radius: 3px; opacity: 0.4; cursor: pointer; pointer-events: auto; forced-color-adjust: none !important; }
        .scrollbar-inner-thumb:hover { opacity: 0.7; width: 6px; right: 0; }

        .footer { text-align: center; padding: 20px; font-size: 0.8em; opacity: 0.6; }
    </style>
</head>
<body data-audio-uri="${this.escapeHtml(audioUri)}" data-initial-scroll-top="${scrollPosition ? (scrollPosition.scrollTop || 0) : 0}">
    <div class="main-wrapper">
        <div class="main-content" id="mainContent">
            <!-- 音乐播放器 -->
            <div class="music-player">
                <div class="music-info">
                    <span>🎵</span>
                    <span id="musicStatus">Ready to Savor</span>
                </div>
                <div class="music-btns">
                    <span class="music-btn" onclick="executeCommand('qqq.savorMoments')" title="播放">▶️</span>
                    <span class="music-btn" onclick="stopMusic()" title="停止">⏹️</span>
                </div>
            </div>

            <div class="section-title">Captain</div>
            <div class="captain-grid">
                <div class="cmd-btn" onclick="executeCommand('qqq.savorMoments')"><span>✨</span> <span>savor moments for yourself</span></div>
                <div class="cmd-btn" onclick="executeCommand('qqq.q1')"><span>📋</span> <span>Paste everything ("Ctrl+V" or "F2")</span></div>
                <div class="cmd-btn" onclick="executeCommand('qqq.q2')"><span>🌍</span> <span>Roam everywhere ("Tab" or "F6")</span></div>
                <div class="cmd-btn" onclick="executeCommand('qqq.downloadVideosFromUrl')"><span>🎥</span> <span>insert Videos From Url</span></div>
                <div class="cmd-btn" onclick="executeCommand('qqq.cleanUp')"><span>🧹</span> <span>clean up</span></div>
                <div class="cmd-btn" onclick="executeCommand('qqq.exportDoc')"><span>📄</span> <span>exportDoc</span></div>
                <div class="cmd-btn" onclick="executeCommand('qqq.pure')"><span>💎</span> <span>Pure</span></div>
                <div class="cmd-btn" onclick="executeCommand('qqq.exportZip')"><span>📦</span> <span>exportZip</span></div>
                <div class="cmd-btn" onclick="executeCommand('qqq.allSettings')"><span>⚙️</span> <span>allSettings</span></div>
            </div>

            <div class="section-title">Passed by</div>
            <div class="history-container" id="historyContainer">
                <div class="history-list" id="historyList">${historyHtml}</div>
                <div class="scrollbar-inner" id="innerScrollbar"><div class="scrollbar-inner-thumb" id="innerThumb"></div></div>
            </div>
            <div style="display: flex; gap: 8px; margin-bottom: 20px;">
                <button class="action-mini-btn" style="flex: 1;" onclick="refreshData()">🔄 刷新</button>
                <button class="action-mini-btn" style="flex: 1;" onclick="clearAllHistory()">🗑️ 清空</button>
            </div>

            <div class="section-title">Dial</div>
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-title">⏱️ 陪伴时间</div><div class="stat-value">${hours}h ${minutes}m</div></div>
                <div class="stat-card"><div class="stat-title">💾 缓存量</div><div class="stat-value">${cacheMB.toFixed(1)}MB</div></div>
                <div class="stat-card"><div class="stat-title">🎯 命中率</div><div class="stat-value">${hitRate.toFixed(1)}%</div></div>
                <div class="stat-card"><div class="stat-title">⚡ 引擎</div><div class="stat-value">${engineInfo.name}</div></div>
                <div class="stat-card engine-card"><div class="stat-title">ℹ️ 引擎详情</div><div class="stat-value" style="font-size: 0.85em;">${engineInfo.details}</div></div>
            </div>

            <div class="footer">的梦gaea  GH HEALTH</div>
        </div>
        <div class="scrollbar-outer" id="outerScrollbar"><div class="scrollbar-outer-thumb" id="outerThumb"></div></div>
    </div>

    <script>
        // --- 1. 核心变量和函数定义 ---
        let vscode;
        try {
            vscode = acquireVsCodeApi();
        } catch (e) {
            console.error("acquireVsCodeApi failed:", e);
        }

        // 消息传递函数
        function postMessage(msg) {
            if (vscode) {
                vscode.postMessage(msg);
            }
        }

        // 核心功能函数
        function executeCommand(cmd) {
            if (!cmd) return;
            postMessage({ command: 'executeCommand', cmd: cmd });
            if (cmd !== 'qqq.savorMoments') {
                playNotificationSound(1);
            }
        }

        function copyToClipboard(id) {
            if (!id) return;
            postMessage({ command: 'copyToClipboard', itemId: id });
            playNotificationSound(3);
        }

        function deleteHistoryItem(id) {
            if (!id) return;
            if (confirm('确定要删除这条记录吗？')) {
                postMessage({ command: 'deleteHistoryItem', itemId: id });
            }
        }

        function clearAllHistory() {
            if (confirm('确定要清空所有历史记录吗？此操作不可撤销。')) {
                postMessage({ command: 'clearAllHistory' });
            }
        }

        function refreshData() {
            const list = document.getElementById('historyList');
            const scrollPos = list ? { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight } : null;
            postMessage({ command: 'refresh', scrollPosition: scrollPos });
        }

        function escapeHtml(t) {
            return t ? t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') : '';
        }

        // --- 2. 媒体处理 ---
        let currentAudio = null;
        function stopMusic() {
            if (currentAudio) {
                currentAudio.pause();
                currentAudio.currentTime = 0;
                currentAudio = null;
                const status = document.getElementById('musicStatus');
                if (status) {
                    status.innerText = 'Stopped';
                    status.classList.remove('music-playing');
                }
            }
        }

        function playAudio(url, times = 1) {
            try {
                if (!url) return;
                stopMusic();
                let source = url;
                if (typeof url === 'string' && !url.startsWith('http') && !url.startsWith('vscode-webview-resource') && !url.startsWith('data:')) {
                    source = 'data:audio/mp3;base64,' + url;
                }

                const audio = new Audio(source);
                currentAudio = audio;
                audio.volume = 0.5;

                const status = document.getElementById('musicStatus');
                if (status) {
                    status.innerText = 'Savoring...';
                    status.classList.add('music-playing');
                }

                if (times === 0) {
                    audio.loop = true;
                } else {
                    let playCount = 1;
                    audio.addEventListener('ended', () => {
                        if (playCount < times) {
                            playCount++;
                            audio.currentTime = 0;
                            audio.play().catch(e => console.log('Audio loop failed:', e));
                        } else {
                            if (status) {
                                status.innerText = 'Finished';
                                status.classList.remove('music-playing');
                            }
                        }
                    });
                }
                audio.play().catch(e => {
                    console.log('Audio blocked:', e);
                    if (status) status.innerText = 'Playback Blocked';
                });
            } catch (e) {
                console.log('Audio error:', e);
            }
        }

        function playNotificationSound(times) {
            const audioUrl = document.body.dataset.audioUri;
            if (audioUrl && audioUrl !== '') {
                playAudio(audioUrl, times);
            }
        }

        // --- 3. 滚动条逻辑 ---
        function setupScrollbars() {
            // 外部滚动条
            const mainContent = document.getElementById('mainContent');
            const outerScrollbar = document.getElementById('outerScrollbar');
            const outerThumb = document.getElementById('outerThumb');

            // 内部滚动条
            const historyList = document.getElementById('historyList');
            const innerScrollbar = document.getElementById('innerScrollbar');
            const innerThumb = document.getElementById('innerThumb');

            function updateScrollbar(container, scrollbar, thumb) {
                if (!container || !thumb) return;

                const ch = container.clientHeight;
                const sh = container.scrollHeight;
                const st = container.scrollTop;

                if (sh > ch) {
                    scrollbar.style.display = 'block';
                    const th = Math.max(20, (ch / sh) * ch);
                    thumb.style.height = th + 'px';
                    thumb.style.top = (st / (sh - ch)) * (ch - th) + 'px';
                } else {
                    scrollbar.style.display = 'none';
                }
            }

            // 外部滚动条事件
            if (mainContent && outerThumb) {
                mainContent.addEventListener('scroll', () => {
                    updateScrollbar(mainContent, outerScrollbar, outerThumb);
                });
            }

            // 内部滚动条事件
            if (historyList && innerThumb) {
                historyList.addEventListener('scroll', () => {
                    updateScrollbar(historyList, innerScrollbar, innerThumb);
                });
            }

            // 初始化滚动条
            updateScrollbar(mainContent, outerScrollbar, outerThumb);
            updateScrollbar(historyList, innerScrollbar, innerThumb);

            // 窗口大小变化时更新
            window.addEventListener('resize', () => {
                updateScrollbar(mainContent, outerScrollbar, outerThumb);
                updateScrollbar(historyList, innerScrollbar, innerThumb);
            });
        }

        // --- 4. 消息处理 ---
        window.addEventListener('message', e => {
            try {
                const m = e.data;
                if (!m || typeof m !== 'object') {
                    return;
                }

                if (m.command === 'updateData') {
                    // 更新统计数据
                    const grid = document.querySelector('.stats-grid');
                    if (grid) {
                        const stats = m.stats || {};
                        const engineInfo = stats.engineInfo || { name: '未知', details: '未知' };
                        grid.innerHTML =
                            '<div class="stat-card"><div class="stat-title">⏱️ 陪伴时间</div><div class="stat-value">' + (stats.h || 0) + 'h ' + (stats.m || 0) + 'm</div></div>' +
                            '<div class="stat-card"><div class="stat-title">💾 缓存量</div><div class="stat-value">' + (stats.cacheMB ? stats.cacheMB.toFixed(1) : '0.0') + 'MB</div></div>' +
                            '<div class="stat-card"><div class="stat-title">🎯 命中率</div><div class="stat-value">' + (stats.hitRate ? stats.hitRate.toFixed(1) : '0.0') + '%</div></div>' +
                            '<div class="stat-card"><div class="stat-title">⚡ 引擎</div><div class="stat-value">' + (engineInfo.name || '未知') + '</div></div>' +
                            '<div class="stat-card engine-card"><div class="stat-title">ℹ️ 引擎详情</div><div class="stat-value" style="font-size: 0.85em;">' + (engineInfo.details || '未知') + '</div></div>';
                    }

                    // 更新历史记录
                    const list = document.getElementById('historyList');
                    if (list) {
                        if (m.history && Array.isArray(m.history) && m.history.length > 0) {
                            list.innerHTML = m.history.map(item => {
                                const id = escapeHtml(item.id || '');
                                // 强制回归纯文本图标和样式
                                let typeIcon = '📄';
                                let typeClass = 'type-text';

                                return '<div class="history-item ' + typeClass + '" data-id="' + id + '">' +
                                    '<div class="item-header">' +
                                        '<span class="item-type" title="text">' + typeIcon + '</span>' +
                                        '<div class="item-time">' + (item.time || '未知时间') + '</div>' +
                                    '</div>' +
                                    '<div class="item-preview">' + escapeHtml(item.preview || '') + '</div>' +
                                    '<div class="item-actions">' +
                                        '<button class="action-mini-btn" onclick="handleCopy(this)">📋 复制</button>' +
                                        '<button class="action-mini-btn" onclick="handleDelete(this)">🗑️ 删除</button>' +
                                    '</div>' +
                                '</div>';
                            }).join('');
                        } else {
                            list.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.5;">暂无记录</div>';
                        }
                    }

                    // 更新滚动条
                    setupScrollbars();
                } else if (m.command === 'playAudio') {
                    playAudio(m.audioUrl || m.base64, m.times || 1);
                }
            } catch (error) {
                console.error('Message handling error:', error);
            }
        });

        // --- 5. 初始化 ---
        (function() {
            try {
                // 恢复滚动位置
                const initialScrollTop = parseInt(document.body.dataset.initialScrollTop || '0');
                if (initialScrollTop > 0 && document.getElementById('historyList')) {
                    document.getElementById('historyList').scrollTop = initialScrollTop;
                }

                // 设置滚动条
                setupScrollbars();

                // 显示初始化完成信息
                console.log('Sidebar initialized successfully');
            } catch (error) {
                console.error('Initialization error:', error);
            }
        })();

        // --- 6. 辅助函数 ---
        function handleCopy(btn) {
            const item = btn.closest('.history-item');
            if (item && item.dataset.id) {
                copyToClipboard(item.dataset.id);
            }
        }

        function handleDelete(btn) {
            const item = btn.closest('.history-item');
            if (item && item.dataset.id) {
                deleteHistoryItem(item.dataset.id);
            }
        }
    </script>
</body>
</html>`;
    }

    getErrorContent(errorMessage) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: var(--vscode-font-family, Arial, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            background-color: var(--vscode-sideBar-background, #1e1e1e);
            color: var(--vscode-sideBar-foreground, #ffffff);
            padding: 20px;
        }
        .error {
            color: var(--vscode-errorForeground, #f48771);
            background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
            border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
            padding: 15px;
            border-radius: 4px;
            margin: 10px 0;
        }
        .btn {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
            border: none;
            padding: 8px 16px;
            border-radius: 2px;
            cursor: pointer;
            margin: 5px;
        }
        .btn:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }
    </style>
</head>
<body>
    <h3>❌ 状态面板加载失败</h3>
    <div class="error">
        <strong>错误信息:</strong> ${errorMessage}
    </div>
    <button class="btn" onclick="location.reload()">🔄 重新加载</button>

    <script>
        // 彻底禁用 ServiceWorker
        if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
            try {
                Object.defineProperty(navigator, 'serviceWorker', {
                    value: {
                        register: function() { return Promise.resolve({ unregister: () => Promise.resolve() }); },
                        getRegistration: function() { return Promise.resolve(null); },
                        getRegistrations: function() { return Promise.resolve([]); },
                        ready: Promise.resolve({
                            active: null,
                            waiting: null,
                            installing: null,
                            addEventListener: function() {},
                            removeEventListener: function() {},
                            postMessage: function() {}
                        })
                    },
                    writable: false,
                    configurable: false
                });
            } catch (e) {
                // 静默处理
            }
        }

        // 安全获取 VS Code API
        let vscode;
        try {
            vscode = acquireVsCodeApi();
        } catch (e) {
            console.error('Failed to acquire VS Code API:', e);
        }
    </script>
</body>
</html>`;
    }
}

module.exports = SidebarWebViewProvider;
module.exports.ClipboardHistoryManager = ClipboardHistoryManager;

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ClipboardHistoryManager {
    constructor(context, pythonBridge, shellBridge) {
        this.context = context;
        this.pythonBridge = pythonBridge;
        this.shellBridge = shellBridge;
        this.history = [];
        this.maxHistoryItems = 100;
        this.clipboardWatcher = null;
        this.lastClipboardFingerprint = ''; // 使用指纹替代完整内容
        this.isWatching = false;
        this.isInternalCopy = false; // 标志位：是否由扩展内部触发的复制

        // 快照存储目录
        this.snapshotDir = path.join(context.globalStorageUri.fsPath, 'clipboard_snapshots');
        if (!fs.existsSync(this.snapshotDir)) {
            fs.mkdirSync(this.snapshotDir, { recursive: true });
        }

        this.currentEngine = 'node';
        this.detectEngine();
        this.loadHistory();
    }

    /**
     * 检测当前可用的 IO 引擎
     */
    detectEngine() {
        if (this.pythonBridge && this.pythonBridge.isAvailable()) {
            this.currentEngine = 'python';
            console.log('[ClipboardHistory] 使用 Python 引擎 - 完整快照模式');
        } else {
            this.currentEngine = 'node';
            console.log('[ClipboardHistory] 使用 Node 引擎 - 仅文本模式');
        }
    }

    /**
     * 开始监听剪切板变化
     */
    startWatching() {
        if (this.isWatching) return;

        this.isWatching = true;
        this.lastClipboardInfo = { type: 'none', content: '' };

        // 重新检测引擎
        this.detectEngine();

        console.log(`[ClipboardHistory] 剪切板监听已启动 - 引擎: ${this.currentEngine}`);

        // 定期检查剪切板内容
        this.clipboardWatcher = setInterval(async () => {
            try {
                await this.checkAndCaptureClipboard();
            } catch (error) {
                console.debug('[ClipboardHistory] 剪切板读取失败:', error.message);
            }
        }, 1000); // 每秒检查一次
    }

    async checkAndCaptureClipboard() {
        if (this.isInternalCopy) {
            console.log('[ClipboardHistory] 跳过内部触发的复制检测');
            return;
        }

        this.detectEngine();

        let clipboardInfo = null;
        let currentFingerprint = '';

        if (this.currentEngine === 'python') {
            // 先偷看一眼，不保存，防止无限复制
            const peek = await this.pythonBridge.call('wq', {}, 2000);
            if (!peek || peek.error) return;

            // 构造一个唯一指纹
            currentFingerprint = `py_${peek.hasFile}_${peek.hasImage}_${peek.hasHtml}_${peek.hasText}`;

            // 如果是文本，加个文本预览做指纹
            if (peek.hasText && !peek.hasFile && !peek.hasImage) {
                const text = await vscode.env.clipboard.readText();
                currentFingerprint += `_${text.slice(0, 100)}_${text.length}`;
            }

            if (currentFingerprint === this.lastClipboardFingerprint) return;

            // 指纹变了，真正捕获快照
            console.log('[ClipboardHistory] 检测到剪切板变化，开始捕获快照...');
            clipboardInfo = await this.capturePythonSnapshot();
        } else {
            const text = await vscode.env.clipboard.readText();
            if (!text || !text.trim()) return;
            currentFingerprint = `node_${text.slice(0, 100)}_${text.length}`;

            if (currentFingerprint === this.lastClipboardFingerprint) return;
            clipboardInfo = await this.captureNodeText();
        }

        if (clipboardInfo) {
            await this.addToHistory(clipboardInfo);
            this.lastClipboardFingerprint = currentFingerprint;
            this.notifySidebarUpdate();
        }
    }

    /**
     * Python 引擎：捕获完整快照（图片、文件、HTML、文本）
     */
    async capturePythonSnapshot() {
        try {
            // 调用 Python 的 clipboard 接口，直接保存到快照目录
            const result = await this.pythonBridge.call('clipboard', {
                target_dir: this.snapshotDir
            }, 10000);

            if (!result || result.error) {
                console.debug('[ClipboardHistory] Python 快照失败:', result?.error);
                return null;
            }

            // 根据 Python 返回的类型构建剪切板信息
            if (result.type === 'text' && result.text) {
                return {
                    type: this.detectContentType(result.text),
                    content: result.text,
                    snapshot: { type: 'text', text: result.text }
                };
            } else if (result.type === 'image' && result.path) {
                return {
                    type: 'image',
                    content: '🖼️ 截图快照',
                    snapshot: { type: 'image', path: result.path }
                };
            } else if (result.type === 'file_folder') {
                const allFiles = [...(result.folders || []), ...(result.files || [])];
                return {
                    type: 'file',
                    content: allFiles,
                    snapshot: { type: 'file', files: allFiles }
                };
            } else {
                return null;
            }
        } catch (error) {
            console.debug('[ClipboardHistory] Python 快照异常:', error.message);
            return null;
        }
    }

    /**
     * Node 引擎：仅捕获文本
     */
    async captureNodeText() {
        try {
            const text = await vscode.env.clipboard.readText();
            if (text && text.trim()) {
                return {
                    type: this.detectContentType(text),
                    content: text,
                    snapshot: { type: 'text', text: text }
                };
            }
            return null;
        } catch (error) {
            console.debug('[ClipboardHistory] Node 文本读取失败:', error.message);
            return null;
        }
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
    async addToHistory(clipboardInfo) {
        if (!clipboardInfo || !clipboardInfo.content) return;

        // 创建历史项
        const historyItem = {
            id: this.generateId(),
            content: clipboardInfo.content,
            timestamp: Date.now(),
            type: clipboardInfo.type,
            preview: this.getContentPreview(clipboardInfo),
            engine: this.currentEngine, // 标记使用的引擎
            snapshot: clipboardInfo.snapshot || null // 快照数据
        };

        // 检查是否已存在相同内容（去重）
        const existingIndex = this.history.findIndex(item =>
            JSON.stringify(item.content) === JSON.stringify(clipboardInfo.content) &&
            item.type === clipboardInfo.type
        );
        if (existingIndex !== -1) {
            // 如果已存在，移到最前面并更新时间戳和快照
            const [existingItem] = this.history.splice(existingIndex, 1);
            existingItem.timestamp = Date.now();
            existingItem.snapshot = clipboardInfo.snapshot || existingItem.snapshot;
            this.history.unshift(existingItem);
        } else {
            // 添加新项目到开头
            this.history.unshift(historyItem);

            // 限制历史记录数量
            if (this.history.length > this.maxHistoryItems) {
                // 清理超出的历史项的快照文件
                const removed = this.history.slice(this.maxHistoryItems);
                for (const item of removed) {
                    this.cleanupSnapshot(item);
                }
                this.history = this.history.slice(0, this.maxHistoryItems);
            }
        }

        // 保存到持久化存储
        this.saveHistory();
    }

    /**
     * 清理快照文件
     */
    cleanupSnapshot(item) {
        if (!item.snapshot) return;

        try {
            if (item.snapshot.type === 'image' && item.snapshot.path) {
                if (fs.existsSync(item.snapshot.path)) {
                    fs.unlinkSync(item.snapshot.path);
                }
            } else if (item.snapshot.type === 'file' && item.snapshot.files) {
                // 删除复制的文件（小心操作）
                for (const filePath of item.snapshot.files) {
                    if (filePath.startsWith(this.snapshotDir) && fs.existsSync(filePath)) {
                        try {
                            const stat = fs.statSync(filePath);
                            if (stat.isDirectory()) {
                                fs.rmSync(filePath, { recursive: true, force: true });
                            } else {
                                fs.unlinkSync(filePath);
                            }
                        } catch (e) {
                            console.debug('[ClipboardHistory] 清理快照失败:', e.message);
                        }
                    }
                }
            }
        } catch (error) {
            console.debug('[ClipboardHistory] 清理快照异常:', error.message);
        }
    }

    /**
     * 生成唯一ID
     */
    generateId() {
        return crypto.randomUUID();
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
     * 获取内容预览
     */
    getContentPreview(clipboardInfo, maxLength = 100) {
        if (!clipboardInfo || !clipboardInfo.content) return '';

        const { type, content } = clipboardInfo;

        switch (type) {
            case 'file':
                if (Array.isArray(content) && content.length > 0) {
                    if (content.length === 1) {
                        // 单个文件显示文件名
                        return path.basename(content[0]);
                    } else {
                        // 多个文件显示数量
                        return `📁 ${content.length}个文件`;
                    }
                }
                return '📁 文件';

            case 'image':
                return '🖼️ 图片';

            case 'html':
                return '🌐 HTML内容';

            default:
                // 文本类型预览
                let preview = typeof content === 'string' ? content.trim() : String(content);

                // 移除多余空白字符
                preview = preview.replace(/\s+/g, ' ');

                // 截取预览
                if (preview.length > maxLength) {
                    preview = preview.substring(0, maxLength) + '...';
                }

                return preview;
        }
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
     * 根据ID获取特定历史项
     */
    getItemById(id) {
        return this.history.find(item => item.id === id);
    }

    /**
     * 删除历史项
     */
    removeItem(id) {
        const index = this.history.findIndex(item => item.id === id);
        if (index !== -1) {
            const [removedItem] = this.history.splice(index, 1);
            // 清理快照文件
            this.cleanupSnapshot(removedItem);
            this.saveHistory();
            this.notifySidebarUpdate();
            return true;
        }
        return false;
    }

    /**
     * 清空所有历史记录
     */
    clearHistory() {
        // 清理所有快照文件
        for (const item of this.history) {
            this.cleanupSnapshot(item);
        }
        this.history = [];
        this.saveHistory();
        this.notifySidebarUpdate();
    }

    /**
     * 保存历史记录到全局状态
     */
    saveHistory() {
        try {
            this.context.globalState.update('qqq_clipboard_history', this.history);
        } catch (error) {
            console.error('保存剪切板历史失败:', error);
        }
    }

    /**
     * 从全局状态加载历史记录
     */
    loadHistory() {
        try {
            const savedHistory = this.context.globalState.get('qqq_clipboard_history', []);
            this.history = Array.isArray(savedHistory) ? savedHistory : [];
        } catch (error) {
            console.error('加载剪切板历史失败:', error);
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
     * 将历史项恢复到剪切板（核心功能）
     */
    async restoreToClipboard(item) {
        if (!item) return false;

        try {
            // 如果有快照数据，优先使用快照
            if (item.snapshot) {
                return await this.restoreFromSnapshot(item.snapshot);
            } else {
                // 没有快照，只能复制文本内容
                return await this.copyTextToClipboard(item.content);
            }
        } catch (error) {
            console.error('[ClipboardHistory] 恢复到剪切板失败:', error);
            return false;
        }
    }

    async restoreFromSnapshot(snapshot) {
        this.isInternalCopy = true;
        try {
            if (snapshot.type === 'text') {
                return await this.copyTextToClipboard(snapshot.text);
            } else if (snapshot.type === 'image' && snapshot.path) {
                if (this.pythonBridge && this.pythonBridge.isAvailable()) {
                    const res = await this.pythonBridge.call('set_clipboard', {
                        type: 'image',
                        path: snapshot.path
                    });
                    return !!res.success;
                }
            } else if (snapshot.type === 'file' && snapshot.files) {
                if (this.pythonBridge && this.pythonBridge.isAvailable()) {
                    const res = await this.pythonBridge.call('set_clipboard', {
                        type: 'files',
                        files: snapshot.files
                    });
                    return !!res.success;
                }
            }
            return false;
        } finally {
            // 延迟重置标志位，确保检测循环能跳过这次变化
            setTimeout(() => { this.isInternalCopy = false; }, 2000);
        }
    }

    /**
     * 复制纯文本到剪切板
     */
    async copyTextToClipboard(content) {
        try {
            if (Array.isArray(content)) {
                await vscode.env.clipboard.writeText(content.join('\n'));
            } else if (typeof content === 'string') {
                await vscode.env.clipboard.writeText(content);
            } else {
                await vscode.env.clipboard.writeText(String(content));
            }
            return true;
        } catch (error) {
            console.error('[ClipboardHistory] 复制文本失败:', error);
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
        this.stopWatching();
        this.saveHistory();
    }
}

module.exports = ClipboardHistoryManager;
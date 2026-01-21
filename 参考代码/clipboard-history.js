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

        // 初始化历史记录
        this.loadHistory();
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
                    this.addToHistory(currentContent);
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
    addToHistory(content) {
        if (!content || typeof content !== 'string') return;

        // 创建历史项
        const historyItem = {
            id: this.generateId(),
            content: content,
            timestamp: Date.now(),
            type: this.detectContentType(content),
            preview: this.getContentPreview(content)
        };

        // 检查是否已存在相同内容（去重）
        const existingIndex = this.history.findIndex(item => item.content === content);
        if (existingIndex !== -1) {
            // 如果已存在，移到最前面并更新时间戳
            const [existingItem] = this.history.splice(existingIndex, 1);
            existingItem.timestamp = Date.now();
            this.history.unshift(existingItem);
        } else {
            // 添加新项目到开头
            this.history.unshift(historyItem);

            // 限制历史记录数量
            if (this.history.length > this.maxHistoryItems) {
                this.history = this.history.slice(0, this.maxHistoryItems);
            }
        }

        // 保存到持久化存储
        this.saveHistory();
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
    clearHistory() {
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
        this.stopWatching();
        this.saveHistory();
    }
}

module.exports = ClipboardHistoryManager;
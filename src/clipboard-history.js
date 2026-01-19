const vscode = require('vscode');
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
            type: 'text',
            preview: this.getContentPreview(content)
        };

        // 检查是否已存在相同内容（去重）
        const existingIndex = this.history.findIndex(item => item.content === content);
        if (existingIndex !== -1) {
            // 如果已存在，移到最前面并更新时间戳和类型
            const [existingItem] = this.history.splice(existingIndex, 1);
            existingItem.timestamp = Date.now();
            existingItem.type = 'text'; // 确保类型为文本
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
    async clearHistory() {
        console.log('ClipboardHistoryManager: 开始物理清空所有历史记录');
        this.history = [];
        this.lastClipboardContent = '';

        // 彻底从 globalState 中移除该键值，而不仅仅是设为空数组
        await this.context.globalState.update('qqq_clipboard_history', undefined);
        await this.context.globalState.update('qqq_clipboard_history', []);

        this.notifySidebarUpdate();
        console.log('ClipboardHistoryManager: 物理清空完成');
    }

    /**
     * 保存历史记录到全局状态
     */
    async saveHistory() {
        try {
            // 强制使用 await 确保写入成功
            await this.context.globalState.update('qqq_clipboard_history', this.history);
            console.log('ClipboardHistoryManager: 成功保存历史记录，当前长度:', this.history.length);
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

            // 确保所有历史记录项的类型都是 'text'
            this.history.forEach(item => {
                item.type = 'text';
            });
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
        return {
            totalCount: this.history.length,
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
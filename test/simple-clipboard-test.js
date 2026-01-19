// 独立的剪切板历史功能测试（无需VS Code环境）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class SimpleClipboardHistoryManager {
    constructor() {
        this.history = [];
        this.maxHistoryItems = 100;
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
     * 获取统计信息
     */
    getStats() {
        return {
            totalCount: this.history.length,
            lastUpdated: this.history.length > 0 ? this.history[0].timestamp : null
        };
    }
}

// 测试函数
async function runTest() {
    console.log('🚀 开始测试剪切板历史功能...');

    // 创建管理器实例
    const manager = new SimpleClipboardHistoryManager();

    // 测试添加历史记录
    console.log('\n📝 测试添加历史记录...');
    manager.addToHistory('测试文本内容');
    manager.addToHistory('https://www.example.com');
    manager.addToHistory('user@example.com');
    manager.addToHistory('function test() { return "hello"; }');
    manager.addToHistory('C:\\Users\\test\\file.txt');
    manager.addToHistory('这是一段比较长的文本内容，用来测试预览功能是否正常工作，看看会不会被正确截断显示');

    // 测试获取历史记录
    console.log('\n📋 测试获取历史记录...');
    const history = manager.getHistory();
    console.log(`历史记录数量: ${history.length}`);

    history.forEach((item, index) => {
        console.log(`${index + 1}. [${item.type}] ${item.preview} (${manager.getFormattedTime(item.timestamp)})`);
    });

    // 测试统计信息
    console.log('\n📊 测试统计信息...');
    const stats = manager.getStats();
    console.log(`总计: ${stats.totalCount} 项`);
    console.log('最后更新时间:', stats.lastUpdated);

    // 测试重复内容去重
    console.log('\n🔄 测试重复内容去重...');
    const originalLength = manager.getHistory().length;
    manager.addToHistory('测试文本内容'); // 重复添加
    const newLength = manager.getHistory().length;
    console.log(`添加重复内容前: ${originalLength} 项`);
    console.log(`添加重复内容后: ${newLength} 项`);
    console.log(`去重效果: ${originalLength === newLength ? '✅ 成功' : '❌ 失败'}`);

    console.log('\n✅ 所有测试完成！');
}

// 运行测试
runTest().catch(console.error);
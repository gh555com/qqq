const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

class StatusViewItem extends vscode.TreeItem {
    constructor(label, collapsibleState = vscode.TreeItemCollapsibleState.None,
        description = '', tooltip = '', iconPath = null, command = null) {
        super(label, collapsibleState);
        this.description = description;
        this.tooltip = tooltip;
        this.iconPath = iconPath;
        if (command) {
            this.command = command;
        }
    }
}

class StatusViewProvider {
    constructor(context, globalModule) {
        this.context = context;
        this.global = globalModule;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;

        // 定期更新数据
        this.updateInterval = setInterval(() => {
            this.refresh();
        }, 5000); // 每5秒更新一次

        context.subscriptions.push({
            dispose: () => {
                if (this.updateInterval) {
                    clearInterval(this.updateInterval);
                    this.updateInterval = null;
                }
            }
        });
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        // 根节点，返回主要状态项
        if (!element) {
            return Promise.resolve(this.getRootItems());
        }

        // 子节点展开逻辑（如果需要的话）
        return Promise.resolve([]);
    }

    getRootItems() {
        const items = [];

        try {
            // 获取缓存统计信息
            const cacheStats = this.global._cacheStatsGetter ? this.global._cacheStatsGetter() :
                { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };

            // 获取使用时间
            const totalSeconds = this.global.getTotalSecondsIncludingSession ?
                this.global.getTotalSecondsIncludingSession() : 0;
            const { h, m } = this.global.formatCompactTime ?
                this.global.formatCompactTime(totalSeconds) : { h: 0, m: 0 };

            // 计算缓存命中率
            const pstats = this.global.getPersistentCacheStatsSnapshot ?
                this.global.getPersistentCacheStatsSnapshot() :
                { hitTotal: 0, missTotal: 0 };
            const denom = pstats.hitTotal + pstats.missTotal;
            const hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;

            // 获取当前引擎信息
            const activeEngine = this.getActiveEngineInfo();

            // 创建状态项
            items.push(new StatusViewItem(
                `⏱️ 使用时间: ${h}h ${m}m`,
                vscode.TreeItemCollapsibleState.None,
                '',
                '累计使用时长',
                new vscode.ThemeIcon('clock')
            ));

            items.push(new StatusViewItem(
                `💾 磁盘缓存: ${(cacheStats.totalSize / (1024 * 1024)).toFixed(1)} MB`,
                vscode.TreeItemCollapsibleState.None,
                `${cacheStats.fileCount} 个文件`,
                '已缓存的数据量',
                new vscode.ThemeIcon('database')
            ));

            items.push(new StatusViewItem(
                `🎯 缓存命中率: ${hitRate.toFixed(1)}%`,
                vscode.TreeItemCollapsibleState.None,
                `${pstats.hitTotal} 命中 / ${pstats.missTotal} 未命中`,
                '缓存效率指标',
                new vscode.ThemeIcon('target')
            ));

            items.push(new StatusViewItem(
                `⚡ 当前引擎: ${activeEngine.name}`,
                vscode.TreeItemCollapsibleState.None,
                activeEngine.details,
                '当前运行的 IO 引擎',
                this.getEngineIcon(activeEngine.code)
            ));

            // 添加分隔线（使用特殊字符）
            items.push(new StatusViewItem('― ― ― ― ―', vscode.TreeItemCollapsibleState.None, '', '分隔线', null));

            items.push(new StatusViewItem(
                '⚙️ 打开所有设置',
                vscode.TreeItemCollapsibleState.None,
                '',
                '打开 qqq 扩展的所有设置',
                new vscode.ThemeIcon('settings'),
                {
                    command: 'qqq.allSettings',
                    title: '打开设置'
                }
            ));

            items.push(new StatusViewItem(
                '🔄 刷新数据',
                vscode.TreeItemCollapsibleState.None,
                '',
                '手动刷新状态数据',
                new vscode.ThemeIcon('refresh'),
                {
                    command: 'qqq.refreshStatusView',
                    title: '刷新状态'
                }
            ));

        } catch (error) {
            console.error('获取状态信息失败:', error);
            items.push(new StatusViewItem(
                '❌ 获取状态失败',
                vscode.TreeItemCollapsibleState.None,
                error.message,
                '点击刷新重试',
                new vscode.ThemeIcon('error'),
                {
                    command: 'qqq.refreshStatusView',
                    title: '刷新状态'
                }
            ));
        }

        return items;
    }

    getActiveEngineInfo() {
        try {
            if (this.global.getActiveEngineState) {
                const state = this.global.getActiveEngineState(
                    this.global.pythonBridge,
                    this.global.rustBridge,
                    this.global.shellBridge
                );

                let name, details;
                switch (state.code) {
                    case 'P':
                        name = 'Python';
                        details = 'Python 引擎';
                        break;
                    case 'R':
                        name = 'Rust';
                        details = 'Rust 引擎';
                        break;
                    default:
                        name = 'Node';
                        details = state.nodeMode === 'D' ? 'Shell daemon 模式' : 'Spawn 模式';
                }

                return {
                    code: state.code,
                    name: name,
                    details: details
                };
            }
        } catch (error) {
            console.error('获取引擎信息失败:', error);
        }

        return {
            code: 'N',
            name: '未知',
            details: '无法确定当前引擎'
        };
    }

    getEngineIcon(engineCode) {
        switch (engineCode) {
            case 'P':
                return new vscode.ThemeIcon('snake'); // Python
            case 'R':
                return new vscode.ThemeIcon('gear');  // Rust
            default:
                return new vscode.ThemeIcon('server'); // Node
        }
    }

    dispose() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}

module.exports = StatusViewProvider;
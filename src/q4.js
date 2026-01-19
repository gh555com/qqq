const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class SidebarWebViewProvider {
    constructor(context, globalModule) {
        this.context = context;
        this.global = globalModule;
        this._view = null;
        this._isInitialized = false;

        // 确保可以访问 extensionContext
        if (!this.global.extensionContext && typeof extensionContext !== 'undefined') {
            this.global.extensionContext = extensionContext;
        }
    }

    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;
        this._isInitialized = false; // 每次重新 resolve 时标记为未初始化，强制刷新 HTML

        const extensionUri = vscode.Uri.file(this.context.extensionPath);

        webviewView.webview.options = {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
            contentSecurityPolicy: `default-src 'none'; script-src 'unsafe-inline' vscode-webview-resource:; style-src 'unsafe-inline' vscode-webview-resource:; img-src vscode-webview-resource: data:; font-src vscode-webview-resource:;`
        };

        // 设置面板图标
        const iconPath = path.join(this.context.extensionPath, "assets", "q.gif");
        if (fs.existsSync(iconPath)) {
            webviewView.webview.iconPath = vscode.Uri.file(iconPath);
        }

        this.updateContent();

        // 订阅剪切板历史更新事件
        if (this.global) {
            this.global.clipboardHistoryUpdated = () => {
                this.updateContent();
            };
        }

        // 处理来自 webview 的消息
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "openSettings":
                    vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
                    break;
                case "refresh":
                    this.updateContent();
                    break;
                case "copyToClipboard":
                    // 恢复历史项到剪切板
                    if (this.global.clipboardHistoryManager && message.itemId) {
                        const item = this.global.clipboardHistoryManager.getItemById(message.itemId);
                        if (item) {
                            const success = await this.global.clipboardHistoryManager.restoreToClipboard(item);
                            if (success) {
                                vscode.window.showInformationMessage('✅ 已恢复到剪切板');
                            } else {
                                vscode.window.showWarningMessage('⚠️ 恢复失败，请检查快照文件是否存在');
                            }
                        }
                    }
                    break;
                case "deleteHistoryItem":
                    // 删除历史项
                    if (this.global.clipboardHistoryManager && message.itemId) {
                        const success = this.global.clipboardHistoryManager.removeItem(message.itemId);
                        if (success) {
                            this.updateContent(); // 刷新显示
                            vscode.window.showInformationMessage('已删除历史记录');
                        }
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
        if (!this._view) return;

        try {
            // 获取剪切板历史数据
            let clipboardHistory = [];
            if (this.global.clipboardHistoryManager) {
                clipboardHistory = this.global.clipboardHistoryManager.getHistory(20);
            }

            const cacheStats = this.calculateActualCacheSize();
            let h = 0, m = 0;
            if (this.context && this.context.globalState) {
                const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
                const KEY_LAST_FLUSH_TIME = "qqq_stats_last_flush";
                const base = this.context.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
                const lastFlush = this.context.globalState.get(KEY_LAST_FLUSH_TIME);

                let totalSeconds = base;
                if (lastFlush) {
                    const diff = (Date.now() - lastFlush) / 1000;
                    totalSeconds = base + (diff > 0 ? diff : 0);
                }
                h = Math.floor(totalSeconds / 3600);
                m = Math.floor((totalSeconds % 3600) / 60);

                if (this._view) this._view.title = `${h}h ${m}m`;
            }

            const cacheMB = cacheStats.totalSize / (1024 * 1024);
            let hitRate = 0;
            if (this.global && this.global.getPersistentCacheStatsSnapshot) {
                const pstats = this.global.getPersistentCacheStatsSnapshot();
                const denom = pstats.hitTotal + pstats.missTotal;
                hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;
            }

            const activeEngine = this.getActiveEngineInfo();

            // 发送数据更新消息
            const updateData = {
                hours: h,
                minutes: m,
                cacheMB: cacheMB.toFixed(1),
                hitRate: hitRate.toFixed(1),
                engineName: activeEngine.name,
                engineDetails: activeEngine.details,
                history: clipboardHistory.map(item => ({
                    id: item.id,
                    type: item.type,
                    typeName: this.getTypeDisplayName(item.type),
                    time: this.getFormattedTime(item.timestamp),
                    preview: item.preview,
                    engine: item.engine
                }))
            };

            if (this._isInitialized) {
                this._view.webview.postMessage({
                    command: 'updateData',
                    data: updateData
                });
            } else {
                this._view.webview.html = this.getWebviewContent(h, m, cacheMB, hitRate, activeEngine, clipboardHistory);
                this._isInitialized = true;
            }
        } catch (error) {
            console.error('Update content error:', error);
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
     * 获取内容类型显示名称
     */
    getTypeDisplayName(type) {
        const typeMap = {
            'text': '文本',
            'url': '链接',
            'file': '文件',
            'email': '邮箱',
            'code': '代码',
            'image': '图片',
            'html': 'HTML'
        };
        return typeMap[type] || '未知';
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

    getWebviewContent(hours, minutes, cacheMB, hitRate, engineInfo, clipboardHistory = []) {
        // 构建初始剪切板历史HTML
        const renderItem = (item) => {
            const engineBadge = item.engine === 'python'
                ? '<span style="background: rgba(38, 139, 210, 0.3); color: var(--blue); padding: 2px 6px; border-radius: 10px; font-size: 0.7em; margin-left: 6px;">★ 快照</span>'
                : '<span style="background: rgba(147, 93, 245, 0.2); color: var(--violet); padding: 2px 6px; border-radius: 10px; font-size: 0.7em; margin-left: 6px;">☆ 文本</span>';

            return '<div class="history-item" data-id="' + item.id + '">' +
                '<div class="item-header">' +
                '<span class="item-type type-' + item.type + '">' + this.getTypeDisplayName(item.type) + '</span>' +
                '<span class="item-time">' + this.getFormattedTime(item.timestamp) + '</span>' +
                '</div>' +
                '<div class="item-preview">' + this.escapeHtml(item.preview) + engineBadge + '</div>' +
                '<div class="item-actions">' +
                '<button class="action-btn copy-btn" data-id="' + item.id + '" onclick="copyToClipboard(this.getAttribute(\'data-id\'))"> 📋 恢复</button>' +
                '<button class="action-btn delete-btn" data-id="' + item.id + '" onclick="deleteHistoryItem(this.getAttribute(\'data-id\'))"> 🗑️ 删除</button>' +
                '</div>' +
                '</div>';
        };

        const historyHtml = clipboardHistory.length > 0
            ? clipboardHistory.map(renderItem).join('')
            : '<div class="empty-history"><div class="empty-history-icon">📭</div><div>暂无剪切板历史记录</div></div>';

        return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>qqq 状态面板</title>
    <style>
        /* Solarized Light 配色方案 */
        :root {
            --base03: #002b36; --base02: #073642; --base01: #586e75; --base00: #657b83;
            --base0: #839496; --base1: #93a1a1; --base2: #eee8d5; --base3: #fdf6e3;
            --yellow: #b58900; --orange: #cb4b16; --red: #dc322f; --magenta: #d33682;
            --violet: #6c71c4; --blue: #268bd2; --cyan: #2aa198; --green: #859900;
            --primary-color: var(--blue); --secondary-color: var(--green);
            --background-color: var(--base3); --card-bg: var(--base2);
            --text-primary: var(--base00); --text-secondary: var(--base01);
            --border-color: var(--base1); --shadow-color: rgba(0, 0, 0, 0.1);
        }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 15px; font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); background: var(--background-color); color: var(--text-primary); }
        .stats-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 15px; }
        .stat-card { background: linear-gradient(135deg, var(--primary-color), var(--secondary-color)); padding: 12px; border-radius: 8px; color: white; }
        .stat-card.cache { background: linear-gradient(135deg, var(--violet), var(--blue)); }
        .stat-title { font-size: 0.85em; opacity: 0.9; }
        .stat-value { font-size: 1.4em; font-weight: 600; margin: 4px 0; }
        .stat-desc { font-size: 0.75em; opacity: 0.8; }
        .engine-info { background: var(--card-bg); padding: 10px; border-radius: 6px; border: 1px solid var(--border-color); margin-bottom: 15px; text-align: center; }
        .engine-name { font-size: 1.1em; color: var(--primary-color); font-weight: 600; }
        .clipboard-section { margin-top: 20px; border-top: 1px solid var(--border-color); padding-top: 15px; }
        .clipboard-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .history-list { display: flex; flex-direction: column; gap: 10px; max-height: 500px; overflow-y: auto; padding-right: 4px; }
        .history-item { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px; transition: all 0.2s; position: relative; }
        .history-item:hover { border-color: var(--primary-color); transform: translateX(2px); }
        .item-header { display: flex; justify-content: space-between; font-size: 0.75em; margin-bottom: 6px; }
        .item-type { padding: 2px 6px; border-radius: 10px; font-weight: 500; }
        .type-text { background: rgba(38, 139, 210, 0.2); color: var(--blue); }
        .type-image { background: rgba(42, 161, 152, 0.2); color: var(--cyan); }
        .type-file { background: rgba(220, 50, 47, 0.2); color: var(--red); }
        .item-preview { font-size: 0.9em; line-height: 1.4; word-break: break-all; max-height: 60px; overflow: hidden; }
        .item-actions { display: flex; gap: 8px; margin-top: 8px; opacity: 0; transition: opacity 0.2s; }
        .history-item:hover .item-actions { opacity: 1; }
        .action-btn { padding: 4px 8px; font-size: 0.75em; border: none; border-radius: 4px; cursor: pointer; color: white; }
        .copy-btn { background: var(--blue); }
        .delete-btn { background: var(--red); }
        .btn { width: 100%; padding: 8px; margin-top: 8px; border: none; border-radius: 4px; cursor: pointer; font-weight: 500; }
        .btn-primary { background: var(--primary-color); color: white; }
        .empty-history { text-align: center; padding: 20px; color: var(--text-secondary); font-style: italic; }
    </style>
</head>
<body>
    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-title">⏱️ 使用时间</div>
            <div class="stat-value">${hours}h ${minutes}m</div>
        </div>
        <div class="stat-card cache">
            <div class="stat-title">💾 磁盘缓存</div>
            <div class="stat-value">${cacheMB.toFixed(1)}MB</div>
        </div>
        <div class="stat-card">
            <div class="stat-title">🎯 命中率 / 引擎</div>
            <div class="stat-value">${hitRate.toFixed(1)}% | ${engineInfo.name}</div>
        </div>
    </div>

    <div class="engine-info">
        <div class="engine-name">${engineInfo.details}</div>
    </div>

    <div class="clipboard-section">
        <div class="clipboard-header">
            <strong>📋 剪切板历史</strong>
            <span class="clipboard-stats" style="font-size: 0.8em; opacity: 0.8;">${clipboardHistory.length} 个项目</span>
        </div>
        <div class="history-list" id="historyList">
            ${historyHtml}
        </div>
    </div>

    <button class="btn btn-primary" onclick="openSettings()">⚙️ 扩展设置</button>
    <button class="btn" style="background: var(--base2); color: var(--text-primary); border: 1px solid var(--border-color);" onclick="refreshData()">🔄 刷新数据</button>

    <script>
        const vscode = acquireVsCodeApi();

        function openSettings() { vscode.postMessage({ command: 'openSettings' }); }
        function refreshData() { vscode.postMessage({ command: 'refresh' }); }
        function copyToClipboard(id) { vscode.postMessage({ command: 'copyToClipboard', itemId: id }); }
        function deleteHistoryItem(id) {
            if(confirm('确定删除?')) vscode.postMessage({ command: 'deleteHistoryItem', itemId: id });
        }

        function escapeHtml(text) {
            if (!text) return '';
            return text.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateData') {
                const data = message.data;
                const cards = document.querySelectorAll('.stat-card .stat-value');
                cards[0].innerText = data.hours + 'h ' + data.minutes + 'm';
                cards[1].innerText = data.cacheMB + 'MB';
                cards[2].innerText = data.hitRate + '% | ' + data.engineName;
                document.querySelector('.engine-name').innerText = data.engineDetails;
                document.querySelector('.clipboard-stats').innerText = data.history.length + ' 个项目';

                const list = document.getElementById('historyList');
                const oldScroll = list.scrollTop;

                let html = '';
                data.history.forEach(item => {
                    const badge = item.engine === 'python' ? '★ 快照' : '☆ 文本';
                    const badgeStyle = item.engine === 'python' ? 'background: rgba(38, 139, 210, 0.3); color: var(--blue);' : 'background: rgba(147, 93, 245, 0.2); color: var(--violet);';
                    const engineBadge = '<span style="padding: 2px 6px; border-radius: 10px; font-size: 0.7em; margin-left: 6px; ' + badgeStyle + '">' + badge + '</span>';

                    html += '<div class="history-item" data-id="' + item.id + '">' +
                        '<div class="item-header">' +
                            '<span class="item-type type-' + item.type + '">' + item.typeName + '</span>' +
                            '<span class="item-time">' + item.time + '</span>' +
                        '</div>' +
                        '<div class="item-preview">' + escapeHtml(item.preview) + engineBadge + '</div>' +
                        '<div class="item-actions">' +
                            '<button class="action-btn copy-btn" data-id="' + item.id + '" onclick="copyToClipboard(this.getAttribute(\'data-id\'))"> 📋 恢复</button>' +
                            '<button class="action-btn delete-btn" data-id="' + item.id + '" onclick="deleteHistoryItem(this.getAttribute(\'data-id\'))"> 🗑️ 删除</button>' +
                        '</div>' +
                    '</div>';
                });

                if (html) {
                    list.innerHTML = html;
                    list.scrollTop = oldScroll;
                }
            }
        });

        setInterval(refreshData, 5000);
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

    dispose() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}

module.exports = SidebarWebViewProvider;
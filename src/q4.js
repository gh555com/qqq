const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class SidebarWebViewProvider {
    constructor(context, globalModule) {
        this.context = context;
        this.global = globalModule;
        this._view = null;
        this.updateInterval = null;

        // 确保可以访问 extensionContext
        if (!this.global.extensionContext && typeof extensionContext !== 'undefined') {
            this.global.extensionContext = extensionContext;
        }
    }

    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;

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

        // 定期更新数据
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        this.updateInterval = setInterval(() => {
            this.updateContent();
        }, 5000);

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
                    // 复制历史项到剪切板
                    if (this.global.clipboardHistoryManager && message.itemId) {
                        const item = this.global.clipboardHistoryManager.getItemById(message.itemId);
                        if (item) {
                            await this.global.clipboardHistoryManager.copyToClipboard(item.content);
                            vscode.window.showInformationMessage('已复制到剪切板');
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
                clipboardHistory = this.global.clipboardHistoryManager.getHistory(20); // 显示最近20条
            }

            // 直接使用降级方案计算实际缓存大小（根据日志分析，这是最常用的路径）
            const cacheStats = this.calculateActualCacheSize();

            // 使用最可靠的方式获取使用时间（根据日志分析，总是回退到context.globalState）
            let totalSeconds = 0;
            let h = 0, m = 0;

            if (this.context && this.context.globalState) {
                const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
                const KEY_LAST_FLUSH_TIME = "qqq_stats_last_flush";

                const base = this.context.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
                const lastFlush = this.context.globalState.get(KEY_LAST_FLUSH_TIME);

                if (lastFlush) {
                    const diff = (Date.now() - lastFlush) / 1000;
                    totalSeconds = base + (diff > 0 ? diff : 0);
                } else {
                    totalSeconds = base;
                }

                h = Math.floor(totalSeconds / 3600);
                m = Math.floor((totalSeconds % 3600) / 60);
            }

            const cacheMB = cacheStats.totalSize / (1024 * 1024);

            // 优先使用全局的缓存命中率函数（根据日志分析，这是唯一能命中的全局函数）
            let hitRate = 0;
            if (this.global && this.global.getPersistentCacheStatsSnapshot) {
                const pstats = this.global.getPersistentCacheStatsSnapshot();
                const denom = pstats.hitTotal + pstats.missTotal;
                hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;
            } else if (this.context && this.context.globalState) {
                const KEY_CACHE_HIT_TOTAL = "qqq_stats_cache_hit_total";
                const KEY_CACHE_MISS_TOTAL = "qqq_stats_cache_miss_total";

                const hitTotal = this.context.globalState.get(KEY_CACHE_HIT_TOTAL, 0) || 0;
                const missTotal = this.context.globalState.get(KEY_CACHE_MISS_TOTAL, 0) || 0;
                const denom = hitTotal + missTotal;
                hitRate = denom > 0 ? (hitTotal / denom) * 100 : 0;
            }

            const activeEngine = this.getActiveEngineInfo();

            this._view.webview.html = this.getWebviewContent(h, m, cacheMB, hitRate, activeEngine, clipboardHistory);
        } catch (error) {
            this._view.webview.html = this.getErrorContent(error.message);
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
            'code': '代码'
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
        // 构建剪切板历史HTML
        let historyHtml = '';
        if (clipboardHistory.length > 0) {
            historyHtml = clipboardHistory.map(item => `
                <div class="history-item" data-id="${item.id}">
                    <div class="item-header">
                        <span class="item-type type-${item.type}">
                            ${this.getTypeDisplayName(item.type)}
                        </span>
                        <span class="item-time">${this.getFormattedTime(item.timestamp)}</span>
                    </div>
                    <div class="item-preview">${this.escapeHtml(item.preview)}</div>
                    <div class="item-actions">
                        <button class="action-btn copy-btn" onclick="copyToClipboard('${item.id}')">📋 复制</button>
                        <button class="action-btn delete-btn" onclick="deleteHistoryItem('${item.id}')">🗑️ 删除</button>
                    </div>
                </div>
            `).join('');
        } else {
            historyHtml = `
                <div class="empty-history">
                    <div class="empty-history-icon">📭</div>
                    <div>暂无剪切板历史记录</div>
                    <div style="font-size: 0.8em; margin-top: 5px;">复制内容到剪切板即可开始记录</div>
                </div>
            `;
        }

        return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>qqq 状态面板</title>
    <style>
        /* 自定义主题颜色 - 适配侧边栏 */
        :root {
            --primary-color: #4a90e2;
            --secondary-color: #50c878;
            --accent-color: #ff6b6b;
            --background-color: var(--vscode-sideBar-background, #1e1e1e);
            --card-bg: var(--vscode-sideBarSectionHeader-background, #2d2d30);
            --text-primary: var(--vscode-sideBar-foreground, #ffffff);
            --text-secondary: var(--vscode-descriptionForeground, #cccccc);
            --border-color: var(--vscode-sideBarSectionHeader-border, #3c3c3c);
            --shadow-color: rgba(0, 0, 0, 0.3);
        }

        body {
            margin: 0;
            padding: 15px;
            font-family: var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            background: var(--background-color);
            color: var(--text-primary);
            min-height: 100vh;
        }

        .container {
            max-width: 100%;
        }

        .header {
            text-align: center;
            margin-bottom: 20px;
            padding: 15px;
            background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
            border-radius: 8px;
            box-shadow: 0 2px 8px var(--shadow-color);
        }

        .header h1 {
            margin: 0;
            font-size: 1.4em;
            font-weight: 500;
            letter-spacing: 0.5px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 15px;
            margin-bottom: 20px;
        }

        .stat-card {
            background: var(--card-bg);
            padding: 15px;
            border-radius: 6px;
            border: 1px solid var(--border-color);
            box-shadow: 0 1px 4px var(--shadow-color);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 3px 10px var(--shadow-color);
        }

        .stat-card.python { border-left: 3px solid #3776ab; }
        .stat-card.rust { border-left: 3px solid #dea584; }
        .stat-card.node { border-left: 3px solid #68a063; }
        .stat-card.cache { border-left: 3px solid var(--secondary-color); }

        .stat-title {
            font-size: 0.9em;
            color: var(--text-secondary);
            margin-bottom: 8px;
            font-weight: 500;
        }

        .stat-value {
            font-size: 1.6em;
            font-weight: 600;
            margin: 8px 0;
            background: linear-gradient(45deg, var(--primary-color), var(--secondary-color));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .stat-desc {
            font-size: 0.8em;
            color: var(--text-secondary);
        }

        .engine-info {
            background: var(--card-bg);
            padding: 12px;
            border-radius: 6px;
            border: 1px solid var(--border-color);
            margin-bottom: 20px;
            text-align: center;
        }

        .engine-label {
            font-size: 0.9em;
            color: var(--text-primary);
            margin-bottom: 6px;
            font-weight: 500;
        }

        .engine-name {
            font-size: 1.2em;
            color: var(--primary-color);
            font-weight: 600;
        }

        .actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .btn {
            padding: 10px 15px;
            border: none;
            border-radius: 4px;
            font-size: 0.9em;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 6px;
            justify-content: center;
        }

        .btn-primary {
            background: var(--primary-color);
            color: white;
        }

        .btn-primary:hover {
            background: #357abd;
            transform: translateY(-1px);
            box-shadow: 0 2px 6px rgba(74, 144, 226, 0.4);
        }

        .btn-secondary {
            background: var(--card-bg);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
        }

        .btn-secondary:hover {
            background: var(--border-color);
            transform: translateY(-1px);
        }

        .footer {
            text-align: center;
            margin-top: 20px;
            padding: 15px;
            color: var(--text-secondary);
            font-size: 0.8em;
        }

        /* 剪切板历史样式 */
        .clipboard-section {
            margin-top: 25px;
            padding-top: 20px;
            border-top: 1px solid var(--border-color);
        }

        .clipboard-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }

        .clipboard-title {
            font-size: 1.1em;
            font-weight: 600;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .clipboard-stats {
            font-size: 0.85em;
            color: var(--text-secondary);
        }

        .history-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            max-height: 400px;
            overflow-y: auto;
        }

        .history-item {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 12px;
            transition: all 0.2s ease;
            cursor: pointer;
            position: relative;
        }

        .history-item:hover {
            transform: translateX(4px);
            border-color: var(--primary-color);
            box-shadow: 0 2px 8px rgba(74, 144, 226, 0.2);
        }

        .item-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .item-type {
            font-size: 0.75em;
            padding: 3px 8px;
            border-radius: 12px;
            font-weight: 500;
        }

        .type-text { background: #4a90e220; color: #4a90e2; }
        .type-url { background: #50c87820; color: #50c878; }
        .type-file { background: #ff6b6b20; color: #ff6b6b; }
        .type-email { background: #9b59b620; color: #9b59b6; }
        .type-code { background: #f39c1220; color: #f39c12; }

        .item-time {
            font-size: 0.75em;
            color: var(--text-secondary);
        }

        .item-preview {
            font-size: 0.9em;
            color: var(--text-primary);
            line-height: 1.4;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 80px;
            overflow: hidden;
            position: relative;
        }

        .item-actions {
            display: flex;
            gap: 8px;
            margin-top: 10px;
            opacity: 0;
            transition: opacity 0.2s ease;
        }

        .history-item:hover .item-actions {
            opacity: 1;
        }

        .action-btn {
            padding: 4px 8px;
            font-size: 0.75em;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .copy-btn {
            background: var(--primary-color);
            color: white;
        }

        .copy-btn:hover {
            background: #357abd;
            transform: translateY(-1px);
        }

        .delete-btn {
            background: #ff4757;
            color: white;
        }

        .delete-btn:hover {
            background: #ff2e42;
            transform: translateY(-1px);
        }

        .empty-history {
            text-align: center;
            padding: 30px 20px;
            color: var(--text-secondary);
            font-style: italic;
        }

        .empty-history-icon {
            font-size: 2em;
            margin-bottom: 10px;
            opacity: 0.5;
        }

        /* 动画效果 */
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .stat-card {
            animation: fadeIn 0.3s ease-out;
        }

        .stat-card:nth-child(1) { animation-delay: 0.1s; }
        .stat-card:nth-child(2) { animation-delay: 0.2s; }
        .stat-card:nth-child(3) { animation-delay: 0.3s; }
        .stat-card:nth-child(4) { animation-delay: 0.4s; }

        .history-item {
            animation: fadeIn 0.3s ease-out;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 qqq 状态</h1>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-title">⏱️ 使用时间</div>
                <div class="stat-value">${hours}<span style="font-size: 0.7em;">h</span> ${minutes}<span style="font-size: 0.7em;">m</span></div>
                <div class="stat-desc">累计使用时长</div>
            </div>

            <div class="stat-card cache">
                <div class="stat-title">💾 磁盘缓存</div>
                <div class="stat-value">${cacheMB.toFixed(1)}<span style="font-size: 0.7em;">MB</span></div>
                <div class="stat-desc">已缓存的数据量</div>
            </div>

            <div class="stat-card">
                <div class="stat-title">🎯 缓存命中率</div>
                <div class="stat-value">${hitRate.toFixed(1)}<span style="font-size: 0.7em;">%</span></div>
                <div class="stat-desc">缓存效率指标</div>
            </div>

            <div class="stat-card ${engineInfo.name.includes('Python') ? 'python' : engineInfo.name.includes('Rust') ? 'rust' : 'node'}">
                <div class="stat-title">⚡ IO 引擎</div>
                <div class="stat-value" style="font-size: 1.2em;">${engineInfo.name}</div>
                <div class="stat-desc">当前运行引擎</div>
            </div>
        </div>

        <div class="engine-info">
            <div class="engine-label">引擎详情</div>
            <div class="engine-name">${engineInfo.details}</div>
        </div>

        <!-- 剪切板历史部分 -->
        <div class="clipboard-section">
            <div class="clipboard-header">
                <div class="clipboard-title">
                    📋 剪切板历史
                </div>
                <div class="clipboard-stats">
                    ${clipboardHistory.length} 个项目
                </div>
            </div>

            <div class="history-list" id="historyList">
                ${historyHtml}
            </div>
        </div>

        <div class="actions">
            <button class="btn btn-primary" onclick="openSettings()">
                ⚙️ 打开设置
            </button>
            <button class="btn btn-secondary" onclick="refreshData()">
                🔄 刷新数据
            </button>
        </div>

        <div class="footer">
            <p>qqq 扩展 - 状态监控</p>
            <p>每5秒自动更新</p>
        </div>
    </div>

    <script>
        // 彻底禁用 ServiceWorker 以防止所有相关错误
        if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
            try {
                // 完全重写 ServiceWorker 对象
                Object.defineProperty(navigator, 'serviceWorker', {
                    value: {
                        register: function() {
                            console.warn('ServiceWorker registration disabled in WebView');
                            return Promise.resolve({ unregister: () => Promise.resolve() });
                        },
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
                // 静默处理可能的权限错误
            }
        }

        // 安全获取 VS Code API
        let vscode;
        try {
            vscode = acquireVsCodeApi();
        } catch (e) {
            console.error('Failed to acquire VS Code API:', e);
        }

        function openSettings() {
            if (vscode) {
                vscode.postMessage({ command: 'openSettings' });
            }
        }

        function refreshData() {
            if (vscode) {
                vscode.postMessage({ command: 'refresh' });
            }
        }

        // 剪切板历史操作函数
        function copyToClipboard(itemId) {
            if (vscode) {
                vscode.postMessage({
                    command: 'copyToClipboard',
                    itemId: itemId
                });
            }
        }

        function deleteHistoryItem(itemId) {
            if (confirm('确定要删除这条历史记录吗？')) {
                if (vscode) {
                    vscode.postMessage({
                        command: 'deleteHistoryItem',
                        itemId: itemId
                    });
                }
            }
        }

        // 自动刷新数据
        if (typeof setInterval !== 'undefined') {
            setInterval(refreshData, 5000);
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

    dispose() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }
}

module.exports = SidebarWebViewProvider;
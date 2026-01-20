const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class SidebarWebViewProvider {
    constructor(context, globalModule) {
        this.context = context;
        this.global = globalModule;
        this._view = null;
        this.updateInterval = null;
        this.scrollPosition = null;

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
            this.updateContent();
        }, 5000);

        // 处理来自 webview 的消息
        webviewView.webview.onDidReceiveMessage(async (message) => {
            console.log('收到 Webview 消息:', message.command, message.itemId || message.commandId);
            switch (message.command) {
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
                case "executeCommand":
                    if (message.commandId) {
                        console.log('Webview 请求执行命令:', message.commandId);
                        try {
                            await vscode.commands.executeCommand(message.commandId);
                        } catch (error) {
                            console.error('执行命令失败:', error);
                            vscode.window.showErrorMessage(`执行命令失败: ${error.message}`);
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
            let totalSeconds = 0, h = 0, m = 0;

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

            // 物理读取音频（仅在第一次或刷新时需要，但为了逻辑简单，每次都计算 Base64 开销极小）
            let audioBase64 = '';
            try {
                const soundPath = path.join(this.context.extensionPath, "assets", "q.mp3");
                if (fs.existsSync(soundPath)) {
                    audioBase64 = fs.readFileSync(soundPath).toString('base64');
                }
            } catch (e) { }

            // 核心逻辑：如果 HTML 已经加载过，则发送消息更新数据，而不是重载整个页面
            if (this._view.webview.html && this._view.webview.html.length > 100) {
                this._view.webview.postMessage({
                    command: 'updateData',
                    stats: { h, m, cacheMB, hitRate, engineInfo: activeEngine },
                    history: clipboardHistory.map(item => ({
                        id: item.id,
                        time: this.getFormattedTime(item.timestamp),
                        preview: item.preview
                    }))
                });
            } else {
                // 仅在第一次渲染时设置 HTML
                this._view.webview.html = this.getWebviewContent(h, m, cacheMB, hitRate, activeEngine, clipboardHistory, this.scrollPosition, audioBase64);
            }
        } catch (error) {
            console.error('更新内容失败:', error);
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

    getWebviewContent(hours, minutes, cacheMB, hitRate, engineInfo, clipboardHistory = [], scrollPosition = null, audioBase64 = '') {
        // 构建剪切板历史HTML

        let historyHtml = '';
        if (clipboardHistory.length > 0) {
            historyHtml = clipboardHistory.map(item => `
                <div class="history-item" data-id="${item.id}">
                    <div class="item-header">
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
        /* Solarized Light 配色方案 */
        :root {
            --base03: #002b36;
            --base02: #073642;
            --base01: #586e75;
            --base00: #657b83;
            --base0: #839496;
            --base1: #93a1a1;
            --base2: #eee8d5;
            --base3: #fdf6e3;
            --yellow: #b58900;
            --orange: #cb4b16;
            --red: #dc322f;
            --magenta: #d33682;
            --violet: #6c71c4;
            --blue: #268bd2;
            --cyan: #2aa198;
            --green: #859900;

            --primary-color: var(--blue);
            --secondary-color: var(--green);
            --accent-color: var(--red);
            --background-color: var(--base3);
            --card-bg: var(--base2);
            --text-primary: var(--base00);
            --text-secondary: var(--base01);
            --border-color: var(--base1);
            --shadow-color: rgba(0, 0, 0, 0.1);
        }

        * {
            box-sizing: border-box;
            forced-color-adjust: none;
            -ms-high-contrast-adjust: none;
        }

        body {
            margin: 0;
            padding: 15px;
            font-family: var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            background: var(--background-color);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-y: auto;
            /* 隐藏所有浏览器的默认滚动条 */
            scrollbar-width: none;
            position: relative;
        }

        body::-webkit-scrollbar {
            display: none;
        }

        .container {
            max-width: 100%;
        }



        .stats-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 15px;
            margin-bottom: 20px;
        }

        .stat-card {
            background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 2px 8px var(--shadow-color);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 3px 10px var(--shadow-color);
        }

        .stat-card.python { border-left: 3px solid var(--blue); }
        .stat-card.rust { border-left: 3px solid var(--base01); }
        .stat-card.node { border-left: 3px solid var(--green); }
        .stat-card.cache { border-left: 3px solid var(--secondary-color); }

        .stat-title {
            font-size: 0.9em;
            color: white;
            margin-bottom: 8px;
            font-weight: 500;
        }

        .stat-value {
            font-size: 1.6em;
            font-weight: 600;
            margin: 8px 0;
            color: white;
        }

        .stat-desc {
            font-size: 0.8em;
            color: rgba(255, 255, 255, 0.85);
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

        .btn-danger {
            background: var(--red);
            color: white;
        }

        .btn-danger:hover {
            background: #b32421;
            transform: translateY(-1px);
            box-shadow: 0 2px 6px rgba(220, 50, 47, 0.4);
        }

        .footer {
            text-align: center;
            margin-top: 20px;
            padding: 15px;
            color: var(--text-secondary);
            font-size: 0.8em;
        }

        /* 区块标题样式 */
        .section-title {
            font-size: 1.1em;
            font-weight: 600;
            color: var(--primary-color);
            margin-bottom: 15px;
            padding-bottom: 5px;
            border-bottom: 1px solid var(--border-color);
        }

        /* Captain 区块样式 */
        .captain-section {
            margin-bottom: 25px;
        }

        .captain-buttons {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .captain-btn {
            padding: 12px 15px;
            border: none;
            border-radius: 6px;
            font-size: 0.9em;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: left;
            background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
            color: white;
            box-shadow: 0 2px 6px var(--shadow-color);
        }

        .captain-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 3px 8px rgba(74, 144, 226, 0.4);
            opacity: 0.95;
        }

        /* 区块间距样式 */
        .passed-by-section {
            margin-bottom: 25px;
            padding-top: 20px;
            border-top: 1px solid var(--border-color);
        }

        .dial-section {
            margin-bottom: 25px;
            padding-top: 20px;
            border-top: 1px solid var(--border-color);
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

        /* 隐藏默认滚动条，实现自定义滚动 */
        .history-container {
            position: relative;
            max-height: 400px;
            overflow: hidden;
        }

        .history-list {
            max-height: 400px;
            overflow-y: scroll;
            /* 隐藏所有浏览器的滚动条 */
            scrollbar-width: none;
        }

        .history-list::-webkit-scrollbar {
            display: none;
        }

        /* 自定义滚动块 */
        .custom-scrollbar {
            position: absolute;
            right: 0;
            top: 0;
            width: 3px; /* 很窄的滚动块 */
            height: 100%;
            background: transparent;
            display: none;
            z-index: 10;
        }

        .custom-scrollbar-thumb {
            position: absolute;
            right: 0;
            width: 100%;
            background-color: rgba(189, 26, 26, 0.7); /* 半透明暗红色 */
            border-radius: 1.5px; /* 圆角，与宽度匹配 */
            cursor: pointer;
            transition: background-color 0.2s ease;
        }

        .custom-scrollbar-thumb:hover {
            background-color: rgba(189, 26, 26, 0.9); /* 鼠标悬停时不透明度增加 */
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
            background: #2076c0;
            transform: translateY(-1px);
        }

        .delete-btn {
            background: var(--red);
            color: white;
        }

        .delete-btn:hover {
            background: #b32421;
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
        <!-- Captain 区块 - 命令按钮区 -->
        <div class="captain-section">
            <h2 class="section-title">Captain</h2>
            <div class="captain-buttons">
                <button class="captain-btn" onclick="executeCommand('qqq.savorMoments')">savor moments for yourself</button>
                <button class="captain-btn" onclick="executeCommand('editor.action.clipboardPasteAction')">Paste everything ("Ctrl+V" or "F2")</button>
                <button class="captain-btn" onclick="executeCommand('editor.action.toggleTabFocusMode')">Roam everywhere ("Tab" or "F6")</button>
                <button class="captain-btn" onclick="executeCommand('qqq.downloadVideosFromUrl')">insert Videos From Url</button>
                <button class="captain-btn" onclick="executeCommand('qqq.cleanup')">clean up</button>
                <button class="captain-btn" onclick="executeCommand('qqq.exportDoc')">exportDoc</button>
                <button class="captain-btn" onclick="executeCommand('qqq.pure')">Pure</button>
                <button class="captain-btn" onclick="executeCommand('qqq.exportZip')">exportZip</button>
                <button class="captain-btn" onclick="executeCommand('qqq.allSettings')">allSettings</button>
            </div>
        </div>

        <!-- Passed by 区块 - 剪切板历史 -->
        <div class="passed-by-section">
            <h2 class="section-title">Passed by</h2>
            <div class="clipboard-header">
                <div class="clipboard-stats">
                    ${clipboardHistory.length} 个项目
                </div>
            </div>

            <div class="history-container" id="historyContainer">
                <div class="history-list" id="historyList">
                    ${historyHtml}
                </div>
                <div class="custom-scrollbar" id="customScrollbar">
                    <div class="custom-scrollbar-thumb" id="customScrollbarThumb"></div>
                </div>
            </div>
        </div>

        <!-- Dial 区块 - 统计卡片 -->
        <div class="dial-section">
            <h2 class="section-title">Dial</h2>
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

        // 保存滚动位置
        function saveScrollPosition() {
            const historyList = document.getElementById('historyList');
            if (historyList) {
                return {
                    scrollTop: historyList.scrollTop,
                    scrollHeight: historyList.scrollHeight,
                    clientHeight: historyList.clientHeight,
                    timestamp: Date.now()
                };
            }
            return null;
        }

        // 恢复滚动位置
        function restoreScrollPosition(scrollPos) {
            if (!scrollPos) return;

            const historyList = document.getElementById('historyList');
            if (historyList) {
                // 使用多种策略确保滚动位置恢复
                const restore = () => {
                    // 方法1: 直接设置滚动位置
                    historyList.scrollTop = scrollPos.scrollTop;

                    // 方法2: 如果直接设置失败，尝试按比例设置
                    if (historyList.scrollTop !== scrollPos.scrollTop && scrollPos.scrollHeight > 0) {
                        const scrollRatio = scrollPos.scrollTop / scrollPos.scrollHeight;
                        const newScrollTop = scrollRatio * historyList.scrollHeight;
                        historyList.scrollTop = newScrollTop;
                    }
                };

                // 立即尝试恢复
                restore();

                // 在下一个事件循环再次尝试（等待DOM完全渲染）
                setTimeout(restore, 10);

                // 再次延迟确保完全恢复
                setTimeout(restore, 100);
            }
        }

        // 刷新数据时保存和恢复滚动位置
        function refreshData() {
            if (vscode) {
                const scrollPos = saveScrollPosition();
                // 将滚动位置信息发送给扩展
                vscode.postMessage({
                    command: 'refresh',
                    scrollPosition: scrollPos
                });
            }
        }

        // 播放音效公共函数
        function playNotificationSound(times) {
            try {
                if ('${audioBase64}') {
                    const audio = new Audio('data:audio/mp3;base64,${audioBase64}');
                    audio.volume = 0.5;

                    if (times === 0) {
                        // 无限循环模式
                        audio.loop = true;
                    } else {
                        // 指定次数模式
                        let playCount = 1;
                        audio.addEventListener('ended', () => {
                            if (playCount < times) {
                                playCount++;
                                audio.currentTime = 0;
                                audio.play();
                            }
                        });
                    }

                    audio.play().catch(err => console.log('播放音效被浏览器拦截:', err));
                }
            } catch (error) {
                console.log('播放音效失败:', error);
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

            // 调用公共音效函数：目前设置为播放 3 次
            // 如果想无限循环，请传 0
            playNotificationSound(3);
        }

        function deleteHistoryItem(itemId) {
            // 移除被拦截的 confirm，直接发消息给后台处理
            if (vscode) {
                vscode.postMessage({
                    command: 'deleteHistoryItem',
                    itemId: itemId
                });
            }
        }

        function clearAllHistory() {
            // 移除被拦截的 confirm，直接发消息给后台处理
            if (vscode) {
                vscode.postMessage({
                    command: 'clearAllHistory'
                });
            }
        }

        // 自动刷新数据
        if (typeof setInterval !== 'undefined') {
            setInterval(refreshData, 5000);
        }

        // 页面加载完成后恢复滚动位置
        const initialScrollPos = ${JSON.stringify(scrollPosition)};
        if (initialScrollPos) {
            restoreScrollPosition(initialScrollPos);
        }

        // 自定义滚动条实现
        const historyList = document.getElementById('historyList');

        // 禁用默认右键菜单
        window.addEventListener('contextmenu', e => e.preventDefault());

        const historyContainer = document.getElementById('historyContainer');
        const customScrollbar = document.getElementById('customScrollbar');
        const customScrollbarThumb = document.getElementById('customScrollbarThumb');

        // 更新滚动条显示和位置
        function updateCustomScrollbar() {
            if (!historyList || !customScrollbar || !customScrollbarThumb) return;

            const containerHeight = historyContainer.clientHeight;
            const contentHeight = historyList.scrollHeight;
            const scrollTop = historyList.scrollTop;

            if (contentHeight > containerHeight) {
                customScrollbar.style.display = 'block';

                // 计算滚动块高度和位置
                const thumbHeight = Math.max(20, (containerHeight / contentHeight) * containerHeight);
                const thumbTop = (scrollTop / (contentHeight - containerHeight)) * (containerHeight - thumbHeight);

                customScrollbarThumb.style.height = thumbHeight + 'px';
                customScrollbarThumb.style.top = thumbTop + 'px';
            } else {
                customScrollbar.style.display = 'none';
            }
        }

        // 滚动条点击事件 - 修复点击定位
        customScrollbar.addEventListener('click', (e) => {
            if (!historyList || !historyContainer) return;

            const scrollbarRect = customScrollbar.getBoundingClientRect();
            const clickY = e.clientY - scrollbarRect.top;
            const containerHeight = historyContainer.clientHeight;
            const contentHeight = historyList.scrollHeight;

            // 计算新的滚动位置
            const newScrollTop = (clickY / containerHeight) * (contentHeight - containerHeight);

            // 设置新的滚动位置
            historyList.scrollTop = newScrollTop;
            updateCustomScrollbar();
        });

        // 滚动块拖动事件
        let isDragging = false;
        let startY = 0;
        let startScrollTop = 0;

        customScrollbarThumb.addEventListener('mousedown', (e) => {
            isDragging = true;
            startY = e.clientY;
            startScrollTop = historyList.scrollTop;

            // 内联处理鼠标移动和释放事件
            const handleMouseMove = (e) => {
                if (!isDragging) return;

                const deltaY = e.clientY - startY;
                const containerHeight = historyContainer.clientHeight;
                const contentHeight = historyList.scrollHeight;
                const thumbHeight = customScrollbarThumb.offsetHeight;

                const scrollDelta = (deltaY / (containerHeight - thumbHeight)) * (contentHeight - containerHeight);
                historyList.scrollTop = startScrollTop + scrollDelta;
                updateCustomScrollbar();
            };

            const handleMouseUp = () => {
                isDragging = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            e.preventDefault();
        });

        // 列表滚动事件
        historyList.addEventListener('scroll', updateCustomScrollbar);

        // 窗口大小变化时更新滚动条
        window.addEventListener('resize', updateCustomScrollbar);

        // 处理来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateData') {
                // 更新统计数据
                document.querySelector('.stats-grid').innerHTML = \`
                    <div class="stat-card">
                        <div class="stat-title">⏱️ 使用时间</div>
                        <div class="stat-value">\${message.stats.h}<span style="font-size: 0.7em;">h</span> \${message.stats.m}<span style="font-size: 0.7em;">m</span></div>
                        <div class="stat-desc">累计使用时长</div>
                    </div>
                    <div class="stat-card cache">
                        <div class="stat-title">💾 磁盘缓存</div>
                        <div class="stat-value">\${message.stats.cacheMB.toFixed(1)}<span style="font-size: 0.7em;">MB</span></div>
                        <div class="stat-desc">已缓存的数据量</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">🎯 缓存命中率</div>
                        <div class="stat-value">\${message.stats.hitRate.toFixed(1)}<span style="font-size: 0.7em;">%</span></div>
                        <div class="stat-desc">缓存效率指标</div>
                    </div>
                    <div class="stat-card \${message.stats.engineInfo.name.includes('Python') ? 'python' : message.stats.engineInfo.name.includes('Rust') ? 'rust' : 'node'}">
                        <div class="stat-title">⚡ IO 引擎</div>
                        <div class="stat-value" style="font-size: 1.2em;">\${message.stats.engineInfo.name}</div>
                        <div class="stat-desc">当前运行引擎</div>
                    </div>
                \`;
                document.querySelector('.engine-name').innerText = message.stats.engineInfo.details;

                // 更新剪切板列表 (保持滚动位置)
                const list = document.getElementById('historyList');
                const statsText = document.querySelector('.clipboard-stats');
                statsText.innerText = \`\${message.history.length} 个项目\`;

                if (message.history.length > 0) {
                    list.innerHTML = message.history.map(item => \`
                        <div class="history-item" data-id="\${item.id}">
                            <div class="item-header">
                                <span class="item-time">\${item.time}</span>
                            </div>
                            <div class="item-preview">\${escapeHtml(item.preview)}</div>
                            <div class="item-actions">
                                <button class="action-btn copy-btn" onclick="copyToClipboard('\${item.id}')">📋 复制</button>
                                <button class="action-btn delete-btn" onclick="deleteHistoryItem('\${item.id}')">🗑️ 删除</button>
                            </div>
                        </div>
                    \`).join('');
                } else {
                    list.innerHTML = \`
                        <div class="empty-history">
                            <div class="empty-history-icon">📭</div>
                            <div>暂无剪切板历史记录</div>
                        </div>
                    \`;
                }
                updateCustomScrollbar();
            }
        });

        // 执行命令函数
        function executeCommand(commandId) {
            if (vscode) {
                vscode.postMessage({ command: 'executeCommand', commandId: commandId });
            }
        }

        // 辅助转义函数
        function escapeHtml(text) {
            if (!text) return '';
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        }

        // 初始更新滚动条
        updateCustomScrollbar();
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



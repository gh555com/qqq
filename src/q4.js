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
            console.log('收到 Webview 消息:', message.command, message.itemId);
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
        if (!this._view || !this._view.webview) return;

        try {
            // 获取剪切板历史数据
            let clipboardHistory = [];
            if (this.global.clipboardHistoryManager) {
                clipboardHistory = this.global.clipboardHistoryManager.getHistory(30).map(item => ({
                    ...item,
                    preview: item.preview ? (item.preview.length > 200 ? item.preview.substring(0, 200) + '...' : item.preview) : ''
                }));
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
            // 转义引擎详情和名称
            activeEngine.name = this.escapeHtml(activeEngine.name);
            activeEngine.details = this.escapeHtml(activeEngine.details);

            const soundUri = this._view.webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "assets", "q.mp3")));

            // 如果已经有 HTML，则通过 postMessage 更新数据，避免重新加载导致脚本崩溃
            if (this._view.webview.html && this._view.webview.html.length > 100) {
                this._view.webview.postMessage({
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

    postMessage(message) {
        if (this._view && this._view.webview) {
            this._view.webview.postMessage(message);
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
            ? clipboardHistory.map(item => `
                <div class="history-item" data-id="${item.id}">
                    <div class="item-time">${item.time}</div>
                    <div class="item-preview">${this.escapeHtml(item.preview)}</div>
                    <div class="item-actions">
                        <button class="action-mini-btn" onclick="copyToClipboard('${item.id}')">📋 复制</button>
                        <button class="action-mini-btn" onclick="deleteHistoryItem('${item.id}')">🗑️ 删除</button>
                    </div>
                </div>`).join('')
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
        .history-item { background: white; border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; margin-bottom: 8px; cursor: pointer; transition: 0.2s; }
        .history-item:hover { border-color: var(--primary-color); box-shadow: 0 2px 4px var(--shadow-color); }
        .item-time { font-size: 0.7em; color: var(--text-secondary); }
        .item-preview { font-size: 0.85em; white-space: pre-wrap; word-break: break-all; max-height: 50px; overflow: hidden; }
        .item-actions { display: flex; gap: 6px; margin-top: 5px; }

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
<body>
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
        // 稳定性保障：尝试获取 VS Code API，如果失败则静默
        let vscode;
        try {
            vscode = acquireVsCodeApi();
        } catch (e) {
            console.error("acquireVsCodeApi failed:", e);
        }

        function postMessage(msg) {
            if (vscode) {
                vscode.postMessage(msg);
            } else {
                console.error("VS Code API not available");
            }
        }

        function executeCommand(cmd) {
            postMessage({ command: 'executeCommand', cmd: cmd });
            if (cmd !== 'qqq.savorMoments') {
                playNotificationSound(1);
            }
        }
        function copyToClipboard(id) { postMessage({ command: 'copyToClipboard', itemId: id }); playNotificationSound(3); }
        function deleteHistoryItem(id) { postMessage({ command: 'deleteHistoryItem', itemId: id }); }
        function clearAllHistory() { postMessage({ command: 'clearAllHistory' }); }

        function refreshData() {
            const list = document.getElementById('historyList');
            const scrollPos = list ? { scrollTop: list.scrollTop, scrollHeight: list.scrollHeight } : null;
            postMessage({ command: 'refresh', scrollPosition: scrollPos });
        }

        let currentAudio = null;

        function stopMusic() {
            if (currentAudio) {
                currentAudio.pause();
                currentAudio.currentTime = 0;
                currentAudio = null;
                document.getElementById('musicStatus').innerText = 'Stopped';
                document.getElementById('musicStatus').classList.remove('music-playing');
            }
        }

        function playNotificationSound(times) {
            const audioUrl = ${JSON.stringify(audioUri || null).replace(/</g, '\\u003c')};
            if (audioUrl && audioUrl !== 'undefined' && audioUrl !== 'null') {
                playAudio(audioUrl, times);
            }
        }

        function playAudio(url, times = 1) {
            try {
                if (url) {
                    stopMusic();
                    // 处理可能的 base64 (由 qqq.js 传过来)
                    let source = url;
                    if (typeof url === 'string' && !url.startsWith('http') && !url.startsWith('vscode-webview-resource') && !url.startsWith('data:')) {
                        source = 'data:audio/mp3;base64,' + url;
                    }

                    const audio = new Audio(source);
                    currentAudio = audio;
                    audio.volume = 0.5;

                    document.getElementById('musicStatus').innerText = 'Savoring...';
                    document.getElementById('musicStatus').classList.add('music-playing');

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
                                document.getElementById('musicStatus').innerText = 'Finished';
                                document.getElementById('musicStatus').classList.remove('music-playing');
                            }
                        });
                    }
                    audio.play().catch(e => {
                        console.log('Audio blocked:', e);
                        document.getElementById('musicStatus').innerText = 'Playback Blocked';
                    });
                }
            } catch (e) {
                console.log('Audio error:', e);
            }
        }

        function escapeHtml(t) { return t?t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'):''; }

        // Message Handling
        window.addEventListener('message', e => {
            const m = e.data;
            if (m.command === 'updateData') {
                // Update Dial
                document.querySelector('.stats-grid').innerHTML =
                    '<div class="stat-card"><div class="stat-title">⏱️ 陪伴时间</div><div class="stat-value">' + m.stats.h + 'h ' + m.stats.m + 'm</div></div>' +
                    '<div class="stat-card"><div class="stat-title">💾 缓存量</div><div class="stat-value">' + m.stats.cacheMB.toFixed(1) + 'MB</div></div>' +
                    '<div class="stat-card"><div class="stat-title">🎯 命中率</div><div class="stat-value">' + m.stats.hitRate.toFixed(1) + '%</div></div>' +
                    '<div class="stat-card"><div class="stat-title">⚡ 引擎</div><div class="stat-value">' + m.stats.engineInfo.name + '</div></div>' +
                    '<div class="stat-card engine-card"><div class="stat-title">ℹ️ 引擎详情</div><div class="stat-value" style="font-size: 0.85em;">' + m.stats.engineInfo.details + '</div></div>';

                // Update History
                const list = document.getElementById('historyList');
                if (m.history && m.history.length > 0) {
                    list.innerHTML = m.history.map(item =>
                        '<div class="history-item" data-id="' + item.id + '">' +
                            '<div class="item-time">' + item.time + '</div>' +
                            '<div class="item-preview">' + escapeHtml(item.preview) + '</div>' +
                            '<div class="item-actions">' +
                                '<button class="action-mini-btn" onclick="copyToClipboard(\'' + item.id + '\')">📋 复制</button>' +
                                '<button class="action-mini-btn" onclick="deleteHistoryItem(\'' + item.id + '\')">🗑️ 删除</button>' +
                            '</div>' +
                        '</div>'
                    ).join('');
                } else {
                    list.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.5;">暂无记录</div>';
                }
                updateAllScrollbars();
            } else if (m.command === 'playAudio') {
                playAudio(m.audioUrl || m.base64, m.times || 1);
            }
        });

        // Scrollbar Logic
        function setupScrollbar(containerId, scrollbarId, thumbId) {
            const container = document.getElementById(containerId);
            const scrollbar = document.getElementById(scrollbarId);
            const thumb = document.getElementById(thumbId);
            if (!container || !thumb) return () => {};

            function update() {
                const ch = container.clientHeight, sh = container.scrollHeight, st = container.scrollTop;
                if (sh > ch) {
                    scrollbar.style.display = 'block';
                    const th = Math.max(20, (ch / sh) * ch);
                    thumb.style.height = th + 'px';
                    thumb.style.top = (st / (sh - ch)) * (ch - th) + 'px';
                } else { scrollbar.style.display = 'none'; }
            }

            container.addEventListener('scroll', update);

            let isDragging = false, startY, startST;
            thumb.onmousedown = e => {
                isDragging = true; startY = e.clientY; startST = container.scrollTop;
                document.onmousemove = e => {
                    if (!isDragging) return;
                    const dy = e.clientY - startY;
                    const ch = container.clientHeight, sh = container.scrollHeight, th = thumb.offsetHeight;
                    container.scrollTop = startST + (dy / (ch - th)) * (sh - ch);
                    update();
                };
                document.onmouseup = () => { isDragging = false; document.onmousemove = null; };
                e.preventDefault();
            };

            scrollbar.onclick = e => {
                if (e.target === thumb) return;
                const rect = scrollbar.getBoundingClientRect();
                const clickY = e.clientY - rect.top;
                const ch = container.clientHeight, sh = container.scrollHeight;
                container.scrollTop = (clickY / ch) * sh - ch / 2;
                update();
            };

            return update;
        }

        const updateOuter = setupScrollbar('mainContent', 'outerScrollbar', 'outerThumb');
        const updateInner = setupScrollbar('historyList', 'innerScrollbar', 'innerThumb');

        function updateAllScrollbars() { updateOuter(); updateInner(); }
        window.onresize = updateAllScrollbars;

        // Init
        const initialPos = ${JSON.stringify(scrollPosition || null).replace(/</g, '\\u003c')};
        if (initialPos && document.getElementById('historyList')) {
            document.getElementById('historyList').scrollTop = initialPos.scrollTop;
        }

        updateAllScrollbars();
        // 移除重复的 setInterval，由 extension 主动 push 数据
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



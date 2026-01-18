const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

class WebviewStatusPanel {
    constructor(context, globalModule) {
        this.context = context;
        this.global = globalModule;
        this.panel = null;
        this.panelAlive = false;

        // 定期更新数据
        this.updateInterval = setInterval(() => {
            this.updateContent();
        }, 5000); // 每5秒更新一次

        context.subscriptions.push({
            dispose: () => {
                if (this.updateInterval) {
                    clearInterval(this.updateInterval);
                    this.updateInterval = null;
                }
                if (this.panel && this.panelAlive) {
                    this.panel.dispose();
                }
            }
        });
    }

    show() {
        if (this.panel && this.panelAlive) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            "qqqStatusWebView",
            "qqq 状态面板",
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                enableFindWidget: true
            }
        );

        this.panelAlive = true;

        // 设置面板图标
        const iconPath = path.join(this.context.extensionPath, "assets", "q.gif");
        if (fs.existsSync(iconPath)) {
            this.panel.iconPath = vscode.Uri.file(iconPath);
        }

        this.panel.onDidDispose(() => {
            this.panelAlive = false;
            this.panel = null;
        });

        // 处理面板消息
        this.panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "openSettings":
                    vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gh555.qqq");
                    break;
                case "refresh":
                    this.updateContent();
                    break;
                case "close":
                    if (this.panel && this.panelAlive) {
                        this.panel.dispose();
                    }
                    break;
            }
        });

        // 初始化内容
        this.updateContent();
    }

    async updateContent() {
        if (!this.panel || !this.panelAlive) return;

        try {
            // 获取当前状态数据
            const cacheStats = this.global._cacheStatsGetter ? this.global._cacheStatsGetter() : { totalSize: 0 };
            const totalSeconds = this.global.getTotalSecondsIncludingSession ?
                this.global.getTotalSecondsIncludingSession() : 0;
            const { h, m } = this.global.formatCompactTime ?
                this.global.formatCompactTime(totalSeconds) : { h: 0, m: 0 };
            const cacheMB = cacheStats.totalSize / (1024 * 1024);

            const pstats = this.global.getPersistentCacheStatsSnapshot ?
                this.global.getPersistentCacheStatsSnapshot() :
                { hitTotal: 0, missTotal: 0 };
            const denom = pstats.hitTotal + pstats.missTotal;
            const hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;

            const activeEngine = this.getActiveEngineInfo();

            this.panel.webview.html = this.getWebviewContent(h, m, cacheMB, hitRate, activeEngine);
        } catch (error) {
            console.error('更新状态面板内容失败:', error);
            this.panel.webview.html = this.getErrorContent(error.message);
        }
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

    getWebviewContent(hours, minutes, cacheMB, hitRate, engineInfo) {
        return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>qqq 状态面板</title>
    <style>
        /* 自定义主题颜色 */
        :root {
            --primary-color: #4a90e2;
            --secondary-color: #50c878;
            --accent-color: #ff6b6b;
            --background-color: #1e1e1e;
            --card-bg: #2d2d30;
            --text-primary: #ffffff;
            --text-secondary: #cccccc;
            --border-color: #3c3c3c;
            --shadow-color: rgba(0, 0, 0, 0.3);
        }

        body {
            margin: 0;
            padding: 20px;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: var(--background-color);
            color: var(--text-primary);
            min-height: 100vh;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
            padding: 20px;
            background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
            border-radius: 12px;
            box-shadow: 0 4px 15px var(--shadow-color);
        }

        .header h1 {
            margin: 0;
            font-size: 2.2em;
            font-weight: 300;
            letter-spacing: 1px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: var(--card-bg);
            padding: 25px;
            border-radius: 10px;
            border: 1px solid var(--border-color);
            box-shadow: 0 2px 10px var(--shadow-color);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            cursor: pointer;
        }

        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 6px 20px var(--shadow-color);
        }

        .stat-card.python { border-left: 4px solid #3776ab; }
        .stat-card.rust { border-left: 4px solid #dea584; }
        .stat-card.node { border-left: 4px solid #68a063; }
        .stat-card.cache { border-left: 4px solid var(--secondary-color); }

        .stat-title {
            font-size: 1.1em;
            color: var(--text-secondary);
            margin-bottom: 10px;
            font-weight: 500;
        }

        .stat-value {
            font-size: 2.5em;
            font-weight: 700;
            margin: 10px 0;
            background: linear-gradient(45deg, var(--primary-color), var(--secondary-color));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .stat-desc {
            font-size: 0.9em;
            color: var(--text-secondary);
        }

        .engine-info {
            background: var(--card-bg);
            padding: 20px;
            border-radius: 10px;
            border: 1px solid var(--border-color);
            margin-bottom: 30px;
            text-align: center;
        }

        .engine-label {
            font-size: 1.2em;
            color: var(--text-primary);
            margin-bottom: 10px;
            font-weight: 600;
        }

        .engine-name {
            font-size: 1.8em;
            color: var(--primary-color);
            font-weight: 700;
        }

        .actions {
            display: flex;
            justify-content: center;
            gap: 15px;
            flex-wrap: wrap;
            margin-top: 30px;
        }

        .btn {
            padding: 12px 25px;
            border: none;
            border-radius: 6px;
            font-size: 1em;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .btn-primary {
            background: var(--primary-color);
            color: white;
        }

        .btn-primary:hover {
            background: #357abd;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(74, 144, 226, 0.4);
        }

        .btn-secondary {
            background: var(--card-bg);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
        }

        .btn-secondary:hover {
            background: var(--border-color);
            transform: translateY(-2px);
        }

        .footer {
            text-align: center;
            margin-top: 40px;
            padding: 20px;
            color: var(--text-secondary);
            font-size: 0.9em;
        }

        /* 动画效果 */
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .stat-card {
            animation: fadeIn 0.5s ease-out;
        }

        .stat-card:nth-child(1) { animation-delay: 0.1s; }
        .stat-card:nth-child(2) { animation-delay: 0.2s; }
        .stat-card:nth-child(3) { animation-delay: 0.3s; }
        .stat-card:nth-child(4) { animation-delay: 0.4s; }

        /* 响应式设计 */
        @media (max-width: 768px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }

            .actions {
                flex-direction: column;
            }

            .btn {
                width: 100%;
                justify-content: center;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 qqq 状态面板</h1>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-title">⏱️ 使用时间</div>
                <div class="stat-value">${hours}<span style="font-size: 0.6em;">h</span> ${minutes}<span style="font-size: 0.6em;">m</span></div>
                <div class="stat-desc">累计使用时长</div>
            </div>

            <div class="stat-card cache">
                <div class="stat-title">💾 磁盘缓存</div>
                <div class="stat-value">${cacheMB.toFixed(1)}<span style="font-size: 0.6em;">MB</span></div>
                <div class="stat-desc">已缓存的数据量</div>
            </div>

            <div class="stat-card">
                <div class="stat-title">🎯 缓存命中率</div>
                <div class="stat-value">${hitRate.toFixed(1)}<span style="font-size: 0.6em;">%</span></div>
                <div class="stat-desc">缓存效率指标</div>
            </div>

            <div class="stat-card ${engineInfo.name.includes('Python') ? 'python' : engineInfo.name.includes('Rust') ? 'rust' : 'node'}">
                <div class="stat-title">⚡ IO 引擎</div>
                <div class="stat-value" style="font-size: 1.8em;">${engineInfo.name}</div>
                <div class="stat-desc">当前运行引擎</div>
            </div>
        </div>

        <div class="engine-info">
            <div class="engine-label">当前引擎详情</div>
            <div class="engine-name">${engineInfo.details}</div>
        </div>

        <div class="actions">
            <button class="btn btn-primary" onclick="openSettings()">
                ⚙️ 打开所有设置
            </button>
            <button class="btn btn-secondary" onclick="refreshData()">
                🔄 刷新数据
            </button>
            <button class="btn btn-secondary" onclick="closePanel()">
                ❌ 关闭面板
            </button>
        </div>

        <div class="footer">
            <p>qqq 扩展 - 实时状态监控</p>
            <p>数据每5秒自动更新</p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function openSettings() {
            vscode.postMessage({ command: 'openSettings' });
        }

        function refreshData() {
            vscode.postMessage({ command: 'refresh' });
        }

        function closePanel() {
            vscode.postMessage({ command: 'close' });
        }

        // 自动刷新数据
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
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
        }
        .error {
            color: var(--vscode-errorForeground);
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 15px;
            border-radius: 4px;
            margin: 10px 0;
        }
        .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 2px;
            cursor: pointer;
            margin: 5px;
        }
        .btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <h2>❌ 状态面板加载失败</h2>
    <div class="error">
        <strong>错误信息:</strong> ${errorMessage}
    </div>
    <button class="btn" onclick="location.reload()">🔄 重新加载</button>
    <button class="btn" onclick="vscode.postMessage({command: 'close'})">❌ 关闭</button>

    <script>
        const vscode = acquireVsCodeApi();
    </script>
</body>
</html>`;
    }

    dispose() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        if (this.panel && this.panelAlive) {
            this.panel.dispose();
            this.panelAlive = false;
            this.panel = null;
        }
    }
}

module.exports = WebviewStatusPanel;
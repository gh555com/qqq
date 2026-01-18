const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

class SidebarWebViewProvider {
    constructor(context, globalModule) {
        this.context = context;
        this.global = globalModule;
        this._view = null;
        this.updateInterval = null;
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
            // 使用现有状态栏的统一数据获取方式（唯一真理源）
            const cacheStats = this.global._cacheStatsGetter ? this.global._cacheStatsGetter() :
                { totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 };

            // 直接调用 global.js 中的现有函数（如果可用）
            let totalSeconds = 0;
            let h = 0, m = 0;
            let hitRate = 0;

            // 尝试使用 global.js 导出的函数
            if (typeof this.global.getTotalSecondsIncludingSession === 'function') {
                totalSeconds = this.global.getTotalSecondsIncludingSession();
                const timeResult = typeof this.global.formatCompactTime === 'function' ?
                    this.global.formatCompactTime(totalSeconds) :
                    { h: Math.floor(totalSeconds / 3600), m: Math.floor((totalSeconds % 3600) / 60) };
                h = timeResult.h;
                m = timeResult.m;
            } else {
                // 回退到手动计算
                if (this.global.extensionContext) {
                    const context = this.global.extensionContext;
                    const KEY_TOTAL_DURATION = "qqq_stats_total_duration";
                    const KEY_LAST_FLUSH_TIME = "qqq_stats_last_flush";

                    const base = context.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
                    const lastFlush = context.globalState.get(KEY_LAST_FLUSH_TIME);

                    if (lastFlush) {
                        const diff = (Date.now() - lastFlush) / 1000;
                        totalSeconds = base + (diff > 0 ? diff : 0);
                    } else {
                        totalSeconds = base;
                    }

                    h = Math.floor(totalSeconds / 3600);
                    m = Math.floor((totalSeconds % 3600) / 60);
                }
            }

            const cacheMB = cacheStats.totalSize / (1024 * 1024);

            // 获取缓存命中率
            if (typeof this.global.getPersistentCacheStatsSnapshot === 'function') {
                const pstats = this.global.getPersistentCacheStatsSnapshot();
                const denom = pstats.hitTotal + pstats.missTotal;
                hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;
            } else {
                // 回退到手动获取
                if (this.global.extensionContext) {
                    const context = this.global.extensionContext;
                    const KEY_CACHE_HIT_TOTAL = "qqq_cache_hit_total";
                    const KEY_CACHE_MISS_TOTAL = "qqq_cache_miss_total";

                    const hitTotal = context.globalState.get(KEY_CACHE_HIT_TOTAL, 0) || 0;
                    const missTotal = context.globalState.get(KEY_CACHE_MISS_TOTAL, 0) || 0;
                    const denom = hitTotal + missTotal;
                    hitRate = denom > 0 ? (hitTotal / denom) * 100 : 0;
                }
            }

            const activeEngine = this.getActiveEngineInfo();

            this._view.webview.html = this.getWebviewContent(h, m, cacheMB, hitRate, activeEngine);
        } catch (error) {
            console.error('更新侧边栏内容失败:', error);
            this._view.webview.html = this.getErrorContent(error.message);
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
        const vscode = acquireVsCodeApi();

        function openSettings() {
            vscode.postMessage({ command: 'openSettings' });
        }

        function refreshData() {
            vscode.postMessage({ command: 'refresh' });
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
    }
}

module.exports = SidebarWebViewProvider;
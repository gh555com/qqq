const vscode = require('vscode');
const { ChatPanelProvider } = require('./chat/panel');
const { setAuthTokenRef } = require('./tools');

// 全局日志产出频道
let outputChannel;

function log(msg) {
    const ts = new Date().toLocaleTimeString();
    outputChannel.appendLine(`[${ts}] ${msg}`);
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('qqqAI');
    context.subscriptions.push(outputChannel);
    log('qqq-ai: activating');

    // 注册 Chat WebView Provider (双轨：activitybar + auxiliarybar)
    const chatProvider = new ChatPanelProvider(context, log);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('qqq-ai.chatPanel', chatProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );
    // qqq: AuxBar 镜像同一个 provider（铁律：AuxBar 只挂 qqq AI）
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('qqq-ai.chatPanelAux', chatProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );
    // qqq: 启动后强制 reveal AuxBar 上的 qqq AI（首次启动空 storage 场景）
    setTimeout(() => {
        vscode.commands.executeCommand('workbench.view.extension.qqqAiViewAux').then(() => {}, () => {});
    }, 500);
    // S-2: deactivate 时刷新 lifetime 指标
    context.subscriptions.push({ dispose: () => chatProvider.flushLifetime && chatProvider.flushLifetime() });
    // B-2: deactivate 时 flush planner 未落盘的 plan
    context.subscriptions.push({ dispose: () => chatProvider.flushPlanner && chatProvider.flushPlanner() });

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('qqq-ai.ask', () => {
            vscode.commands.executeCommand('qqq-ai.chatPanel.focus');
        }),
        vscode.commands.registerCommand('qqq-ai.clear', () => {
            chatProvider.clearConversation();
        }),
        vscode.commands.registerCommand('qqq-ai.setToken', async () => {
            const token = await vscode.window.showInputBox({
                prompt: '粘贴你的 gh555 access_token',
                password: true,
                ignoreFocusOut: true
            });
            if (token) {
                await context.globalState.update('qqq-ai.authToken', token);
                setAuthTokenRef(token);
                vscode.window.showInformationMessage('qqq AI: Token 已保存');
            }
        }),
        vscode.commands.registerCommand('qqq-ai.switchPlan', async () => {
            const pick = await vscode.window.showQuickPick(
                [
                    { label: '⚡ Flash (free)', description: 'deepseek-v4-flash — 快速、适合日常', value: 'free' },
                    { label: '🧠 Pro (expert)', description: 'deepseek-v4-pro — 更强推理、消耗 ge', value: 'expert' }
                ],
                { placeHolder: '选择 AI 模型' }
            );
            if (pick) {
                vscode.window.showInformationMessage(`qqq AI: 模型已自动由服务端控制（免费时段自动 Pro+Max）`);
            }
        }),
        vscode.commands.registerCommand('qqq-ai.planAbort', () => {
            chatProvider.abortPlan();
        }),
        vscode.commands.registerCommand('qqq-ai.planExecute', () => {
            chatProvider.executePlan();
        })
    );

    log('qqq-ai: activated');
}

function deactivate() {
    log('qqq-ai: deactivated');
}

module.exports = { activate, deactivate, getLog: () => log };

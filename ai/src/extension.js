const vscode = require('vscode');
const { ChatPanelProvider } = require('./chat/panel');

// 全局日志输出频道
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

    // 注册 Chat WebView Provider
    const chatProvider = new ChatPanelProvider(context, log);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('qqq-ai.chatPanel', chatProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

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
                chatProvider.agent.setPlan(pick.value);
                vscode.window.showInformationMessage(`qqq AI: 已切换到 ${pick.label}`);
            }
        })
    );

    log('qqq-ai: activated');
}

function deactivate() {
    log('qqq-ai: deactivated');
}

module.exports = { activate, deactivate, getLog: () => log };

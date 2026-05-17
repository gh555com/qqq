const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { Agent } = require('../agent');
const { setPanelRef } = require('../tools');

class ChatPanelProvider {
    constructor(context, logFn) {
        this.context = context;
        this.agent = new Agent(context, logFn);
        this._view = null;
        setPanelRef(this);

        // 连接 agent 回调 → webview UI
        this.agent.onRageChange((rage) => {
            this._postMessage({ type: 'rage', value: rage });
        });
        this.agent.onHpChange((percent, tokens) => {
            this._postMessage({ type: 'hp', percent, tokens });
        });
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'chat'))]
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        // 处理来自 WebView 的消息
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            this._handleWebviewMessage(msg);
        });
    }

    async _handleUserMessage(text) {
        if (!text.trim()) return;

        // 通知 WebView 开始生成
        this._postMessage({ type: 'start' });

        await this.agent.sendMessage(text, {
            onToken: (token) => {
                this._postMessage({ type: 'token', content: token });
            },
            onToolCall: (call) => {
                this._postMessage({
                    type: 'tool',
                    name: call.function.name,
                    args: call.function.arguments
                });
            },
            onDone: (content) => {
                this._postMessage({ type: 'done', content });
            },
            onError: (err) => {
                this._postMessage({ type: 'error', message: err });
            },
            _requestConfirm: (message, actions) => this.requestConfirm(message, actions)
        });
    }

    clearConversation() {
        this.agent.clearConversation();
        this._postMessage({ type: 'cleared' });
    }

    /**
     * 在聊天面板内显示确认块，等待用户点击
     */
    requestConfirm(message, actions = ['Apply', 'Reject']) {
        return new Promise((resolve) => {
            const id = Date.now().toString(36);
            this._pendingConfirms = this._pendingConfirms || {};
            this._pendingConfirms[id] = resolve;
            this._postMessage({ type: 'confirm', id, message, actions });
        });
    }

    _handleWebviewMessage(msg) {
        if (msg.type === 'send') {
            this._handleUserMessage(msg.text);
        } else if (msg.type === 'abort') {
            this.agent.abort();
        } else if (msg.type === 'clear') {
            this.clearConversation();
        } else if (msg.type === 'confirmResponse') {
            const resolve = this._pendingConfirms?.[msg.id];
            if (resolve) {
                resolve(msg.action);
                delete this._pendingConfirms[msg.id];
            }
        }
    }

    _postMessage(msg) {
        if (this._view) {
            this._view.webview.postMessage(msg);
        }
    }

    _getHtml(webview) {
        const htmlPath = path.join(this.context.extensionPath, 'src', 'chat', 'chat.html');
        try {
            return fs.readFileSync(htmlPath, 'utf8');
        } catch {
            return `<!DOCTYPE html><html><body><p>Error: chat.html not found</p></body></html>`;
        }
    }
}

module.exports = { ChatPanelProvider };

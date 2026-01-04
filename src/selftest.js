const vscode = require("vscode");
const global = require("./global");

function _genAnchorToken() {
    const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let token = "";
    for (let i = 0; i < 6; i++) token += letters[Math.floor(Math.random() * letters.length)];
    return token;
}

function verifyAnchorTokenShape(n = 100) {
    const re = /^[A-Za-z]{6}$/;
    for (let i = 0; i < n; i++) {
        const t = _genAnchorToken();
        if (!re.test(t)) return false;
    }
    return true;
}

async function run() {
    const ok = verifyAnchorTokenShape(200);
    global.logMessage(`SelfTest: anchor token shape ${ok ? "OK" : "FAIL"} `, ok ? "INFO" : "ERROR");
    return ok;
}

module.exports = { run, verifyAnchorTokenShape };

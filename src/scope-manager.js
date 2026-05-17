/**
 * scope-manager.js — qqq Vision (视野) Scope Manager
 *
 * 原子模型：加入工作区 = AI 可见，移除工作区 = AI 不可见。
 * 没有中间态（没有 "在工作区但 AI 看不到" 的状态）。
 *
 * 未来：视窗面板可加"临时屏蔽"功能，当前只有加入/移除。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/** @type {vscode.Disposable|null} */
let _watcher = null;

// ============================================================================
//  Initialization
// ============================================================================

function init() {
    // Watch workspace folder changes (for future event hooks)
    _watcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        // placeholder for future event broadcasting
    });
}

function dispose() {
    if (_watcher) {
        _watcher.dispose();
        _watcher = null;
    }
}

// ============================================================================
//  Public API
// ============================================================================

/**
 * Get all workspace folders (all are AI-visible by definition).
 * @returns {Array<{path: string, name: string}>}
 */
function getAllFolders() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];
    return folders.map(f => ({
        path: f.uri.fsPath,
        name: f.name
    }));
}

/**
 * Get all folder paths (= AI-visible folders, since all workspace folders are visible).
 * @returns {string[]}
 */
function getVisibleFolders() {
    return getAllFolders().map(f => f.path);
}

/**
 * Add a folder to the workspace (= AI can see it).
 * @param {string} folderPath - absolute path
 * @returns {boolean} true if added
 */
function addFolder(folderPath) {
    const norm = _normPath(folderPath);
    const existing = vscode.workspace.workspaceFolders || [];

    // Already in workspace?
    if (existing.some(f => _normPath(f.uri.fsPath) === norm)) {
        return true;
    }

    // No containment allowed
    for (const f of existing) {
        const ep = _normPath(f.uri.fsPath);
        if (norm.startsWith(ep + path.sep) || ep.startsWith(norm + path.sep)) {
            vscode.window.showWarningMessage(
                `Cannot add: "${path.basename(folderPath)}" overlaps with "${f.name}".`
            );
            return false;
        }
    }

    return vscode.workspace.updateWorkspaceFolders(
        existing.length, 0,
        { uri: vscode.Uri.file(folderPath), name: path.basename(folderPath) }
    );
}

/**
 * Remove a folder from workspace (= AI can no longer see it).
 * Caller should check for dirty files BEFORE calling this.
 * @param {string} folderPath
 * @returns {boolean}
 */
function removeFolder(folderPath) {
    const norm = _normPath(folderPath);
    const folders = vscode.workspace.workspaceFolders || [];
    const idx = folders.findIndex(f => _normPath(f.uri.fsPath) === norm);
    if (idx < 0) return false;
    return vscode.workspace.updateWorkspaceFolders(idx, 1);
}

/**
 * Check if a folder has unsaved (dirty) files.
 * @param {string} folderPath
 * @returns {string[]} list of dirty file paths
 */
function getDirtyFiles(folderPath) {
    const norm = _normPath(folderPath);
    const dirty = [];
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.isDirty && !doc.isUntitled) {
            const docNorm = _normPath(doc.uri.fsPath);
            if (docNorm.startsWith(norm + path.sep) || docNorm === norm) {
                dirty.push(doc.uri.fsPath);
            }
        }
    }
    return dirty;
}

// ============================================================================
//  Internal
// ============================================================================

function _normPath(p) {
    if (!p) return '';
    const n = path.normalize(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
}

// ============================================================================
//  Exports
// ============================================================================

module.exports = {
    init,
    dispose,
    getAllFolders,
    getVisibleFolders,
    addFolder,
    removeFolder,
    getDirtyFiles,
};

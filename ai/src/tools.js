const vscode = require('vscode');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================
// 工具定义（OpenAI function calling format）
// ============================================================

const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_patch_proposal',
            description: 'Propose a file edit (search and replace). User must approve before applying.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    original: { type: 'string', description: 'Exact text to find' },
                    replacement: { type: 'string', description: 'Text to replace with' },
                    description: { type: 'string', description: 'Brief description of the change' }
                },
                required: ['path', 'original', 'replacement']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_text',
            description: 'Search for text across workspace files using ripgrep',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search pattern (regex supported)' },
                    path: { type: 'string', description: 'Directory to search in (optional)' },
                    max_results: { type: 'number', description: 'Max results to return (default 20)' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_files',
            description: 'List files in a directory',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to directory' },
                    recursive: { type: 'boolean', description: 'List recursively (default false)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_open_files',
            description: 'Get list of currently open files in the editor',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_diagnostics',
            description: 'Get current errors and warnings from LSP',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path (optional, all files if omitted)' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_vision_context',
            description: 'Get the current qqq Vision scope: which project folders AI can see, and their top-level structure',
            parameters: { type: 'object', properties: {} }
        }
    }
];

// ============================================================
// 工具执行
// ============================================================

const fs = require('fs');

let _panelRef = null;
function setPanelRef(panel) { _panelRef = panel; }

async function executeTool(name, args) {
    switch (name) {
        case 'read_file':
            return executeReadFile(args);
        case 'write_patch_proposal':
            return executeWritePatchProposal(args);
        case 'search_text':
            return executeSearchText(args);
        case 'list_files':
            return executeListFiles(args);
        case 'get_open_files':
            return executeGetOpenFiles();
        case 'get_diagnostics':
            return executeGetDiagnostics(args);
        case 'get_vision_context':
            return executeGetVisionContext();
        case 'web_search':
            return executeWebSearch(args);
        default:
            return `Unknown tool: ${name}`;
    }
}

function executeReadFile({ path: filePath }) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        if (lines.length > 500) {
            return `File has ${lines.length} lines. Showing first 500:\n` + lines.slice(0, 500).join('\n');
        }
        return content;
    } catch (err) {
        return `Error reading file: ${err.message}`;
    }
}

async function executeWritePatchProposal({ path: filePath, original, replacement, description }) {
    // 在聊天面板内显示确认块
    let action = 'Apply';
    if (_panelRef && _panelRef.requestConfirm) {
        action = await _panelRef.requestConfirm(
            `编辑 ${path.basename(filePath)}: ${description || 'Apply change?'}`,
            ['Apply', 'Reject']
        );
    }

    if (action !== 'Apply') {
        return 'User rejected the change.';
    }

    try {
        let content = fs.readFileSync(filePath, 'utf8');
        if (!content.includes(original)) {
            return 'Error: original text not found in file.';
        }
        content = content.replace(original, replacement);
        fs.writeFileSync(filePath, content, 'utf8');
        return 'Change applied successfully.';
    } catch (err) {
        return `Error applying change: ${err.message}`;
    }
}

function executeSearchText({ query, path: searchPath, max_results = 20 }) {
    // Determine search directories
    let searchDirs = [];

    if (searchPath) {
        searchDirs = [searchPath];
    } else {
        // Default: search all visible vision folders
        const qqqExt = vscode.extensions.getExtension('gh555.qqq');
        if (qqqExt && qqqExt.isActive && qqqExt.exports && qqqExt.exports.getScopeAPI) {
            searchDirs = qqqExt.exports.getScopeAPI().getVisibleFolders();
        }
        if (searchDirs.length === 0) {
            const folders = vscode.workspace.workspaceFolders;
            searchDirs = folders ? folders.map(f => f.uri.fsPath) : ['.'];
        }
    }

    const allMatches = [];
    const isWin = process.platform === 'win32';
    // For PowerShell Select-String, escape single quotes
    const psQuery = query.replace(/'/g, "''");
    // Explicit shell path to avoid ENOENT on cmd.exe
    const shellOpt = isWin ? { shell: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' } : {};

    for (const dir of searchDirs) {
        try {
            let result;
            try {
                // Try rg first (supports regex natively)
                result = execSync(
                    `rg --no-heading -n -m ${max_results} -e "${query.replace(/"/g, '\\"')}" .`,
                    { cwd: dir, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000, ...shellOpt }
                );
            } catch (rgErr) {
                if (rgErr.status === 1) { continue; } // rg: no matches
                // rg not available, fallback with regex support
                if (isWin) {
                    // PowerShell Select-String supports regex — spawn powershell directly
                    result = execSync(
                        `Get-ChildItem -Path '${dir.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern '${psQuery}' -List | Select-Object -First ${max_results} | ForEach-Object { $_.Path + ':' + $_.LineNumber + ':' + $_.Line.TrimStart() }`,
                        { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000, shell: 'powershell.exe' }
                    );
                } else {
                    result = execSync(
                        `grep -rn "${query.replace(/"/g, '\\"')}" . | head -${max_results}`,
                        { cwd: dir, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15000 }
                    );
                }
            }
            const lines = result.split('\n').filter(Boolean).slice(0, max_results);
            for (const line of lines) {
                // Normalize to absolute path
                const absLine = line.startsWith('.') ? path.join(dir, line.slice(2)) : line;
                allMatches.push(absLine);
            }
        } catch (err) {
            if (err.status !== 1) {
                allMatches.push(`[search error in ${dir}: ${err.message?.slice(0, 80)}]`);
            }
        }
        if (allMatches.length >= max_results) break;
    }

    return allMatches.slice(0, max_results).join('\n') || 'No matches found.';
}

function executeListFiles({ path: dirPath, recursive = false }) {
    try {
        if (recursive) {
            const entries = [];
            const walk = (dir, prefix = '') => {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
                    const rel = prefix ? `${prefix}/${item.name}` : item.name;
                    entries.push(rel + (item.isDirectory() ? '/' : ''));
                    if (item.isDirectory() && entries.length < 200) {
                        walk(path.join(dir, item.name), rel);
                    }
                }
            };
            walk(dirPath);
            return entries.join('\n');
        } else {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            return items.map(i => i.name + (i.isDirectory() ? '/' : '')).join('\n');
        }
    } catch (err) {
        return `Error listing files: ${err.message}`;
    }
}

function executeGetOpenFiles() {
    const tabs = vscode.window.tabGroups.all
        .flatMap(g => g.tabs)
        .map(t => t.input)
        .filter(i => i && i.uri)
        .map(i => i.uri.fsPath);
    return tabs.length > 0 ? tabs.join('\n') : 'No files open.';
}

function executeGetDiagnostics({ path: filePath }) {
    let diagnostics;
    if (filePath) {
        const uri = vscode.Uri.file(filePath);
        diagnostics = vscode.languages.getDiagnostics(uri);
        return formatDiagnostics(filePath, diagnostics);
    }

    // 所有文件
    const all = vscode.languages.getDiagnostics();
    const results = [];
    for (const [uri, diags] of all) {
        if (diags.length === 0) continue;
        results.push(formatDiagnostics(uri.fsPath, diags));
    }
    return results.join('\n\n') || 'No diagnostics.';
}

function formatDiagnostics(filePath, diagnostics) {
    if (!diagnostics.length) return `${filePath}: no issues`;
    const lines = diagnostics.map(d => {
        const sev = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
        return `  L${d.range.start.line + 1}: [${sev}] ${d.message}`;
    });
    return `${filePath}:\n${lines.join('\n')}`;
}

function executeGetVisionContext() {
    // Get workspace folders (atomic model: all workspace folders = AI visible)
    const qqqExt = vscode.extensions.getExtension('gh555.qqq');
    let folders = [];

    if (qqqExt && qqqExt.isActive && qqqExt.exports && qqqExt.exports.getScopeAPI) {
        folders = qqqExt.exports.getScopeAPI().getAllFolders();
    } else {
        const wf = vscode.workspace.workspaceFolders;
        if (!wf) return 'No workspace folders open.';
        folders = wf.map(f => ({ path: f.uri.fsPath, name: f.name }));
    }

    if (folders.length === 0) return 'No workspace folders open.';

    const lines = ['=== qqq Vision ==='];
    for (const f of folders) {
        lines.push(`\u{1F4C1} ${f.name} (${f.path})`);
        try {
            const items = fs.readdirSync(f.path, { withFileTypes: true });
            const top = items
                .filter(i => !i.name.startsWith('.') && i.name !== 'node_modules')
                .slice(0, 30)
                .map(i => `  ${i.isDirectory() ? '\u{1F4C1}' : '  '} ${i.name}`);
            lines.push(...top);
        } catch (_) {}
    }

    // Read recent Roam history if available
    try {
        const histPath = require('path').join(require('os').homedir(), '.qqq', 'roam', 'history.json');
        if (fs.existsSync(histPath)) {
            const hist = JSON.parse(fs.readFileSync(histPath, 'utf-8'));
            if (hist.lastDir) {
                lines.push('');
                lines.push(`Recent directory: ${hist.lastDir}`);
            }
        }
    } catch (_) {}

    return lines.join('\n');
}

async function executeRunCommandRequest({ command, cwd, reason }) {
    const action = await vscode.window.showWarningMessage(
        `qqq AI wants to run: ${command}${reason ? `\nReason: ${reason}` : ''}`,
        'Run', 'Reject'
    );

    if (action !== 'Run') {
        return 'User rejected the command.';
    }

    const workDir = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
    try {
        const output = execSync(command, {
            cwd: workDir,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 30000
        });
        return output || '(command completed with no output)';
    } catch (err) {
        return `Command failed (exit ${err.status}): ${err.stderr || err.message}`;
    }
}

// ============================================================
// 导出
// ============================================================

/**
 * 联网搜索 — 通过 gaea 服务端代理（避免客户端直连外网）
 */
async function executeWebSearch({ query }) {
    try {
        // TODO: 接入 gaea /api/v3/ai/search 端点
        // 现阶段用 DeepSeek enable_search 或直接返回提示
        return `[Web search not yet connected. Query was: "${query}". Please answer based on your training knowledge.]`;
    } catch (err) {
        return `[Web search error: ${err.message}]`;
    }
}

function getTools() {
    return TOOL_DEFINITIONS;
}

module.exports = { getTools, executeTool, setPanelRef };

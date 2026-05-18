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
            description: 'Read file contents. For large files (>500 lines), use start_line/end_line to paginate.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    start_line: { type: 'number', description: 'Start line number (1-based, default 1)' },
                    end_line: { type: 'number', description: 'End line number (inclusive, default start+500)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Edit a file with one or more search-and-replace operations. All edits are applied atomically (all succeed or none applied). Supports whitespace-tolerant matching as fallback. No confirmation needed — changes are applied directly with full undo support (Ctrl+Z).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    edits: {
                        type: 'array',
                        description: 'Array of edit operations, applied in order',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Exact text to find (unique substring in the file)' },
                                replace: { type: 'string', description: 'Text to replace with' },
                                replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false, first only)' }
                            },
                            required: ['find', 'replace']
                        }
                    }
                },
                required: ['path', 'edits']
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
    },
    {
        type: 'function',
        function: {
            name: 'analyze_image',
            description: 'Analyze an image using vision AI. Returns text description and OCR of the image content.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the image file (if analyzing a file)' },
                    base64: { type: 'string', description: 'Base64-encoded image data (if provided inline by user paste)' },
                    prompt: { type: 'string', description: 'What to focus on when analyzing the image' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_file',
            description: 'Create a new file with the given content. Fails if the file already exists.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path for the new file' },
                    content: { type: 'string', description: 'File content to write' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command in the workspace. Returns stdout+stderr. Timeout 30s.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to execute' },
                    cwd: { type: 'string', description: 'Working directory (optional)' }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description: 'Delete a file. Fails if file does not exist.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file to delete' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Search for files by name glob pattern (e.g. *.js, config/*.json). Returns matching file paths.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern to match filenames' },
                    path: { type: 'string', description: 'Directory to search in (optional)' },
                    max_results: { type: 'number', description: 'Max results (default 50)' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'lsp_definitions',
            description: 'Go to definition of a symbol at a specific file position. Returns the definition location(s).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute file path' },
                    line: { type: 'number', description: 'Line number (1-based)' },
                    character: { type: 'number', description: 'Column number (1-based)' }
                },
                required: ['path', 'line', 'character']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'lsp_references',
            description: 'Find all references to a symbol at a specific file position.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute file path' },
                    line: { type: 'number', description: 'Line number (1-based)' },
                    character: { type: 'number', description: 'Column number (1-based)' }
                },
                required: ['path', 'line', 'character']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'lsp_symbols',
            description: 'Get all symbols (functions, classes, variables) in a document.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute file path' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fetch_webpage',
            description: 'Fetch and extract text content from a URL.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to fetch' }
                },
                required: ['url']
            }
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
        case 'edit_file':
            return executeEditFile(args);
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
        case 'analyze_image':
            return executeAnalyzeImage(args);
        case 'create_file':
            return executeCreateFile(args);
        case 'run_command':
            return executeRunCommand(args);
        case 'delete_file':
            return executeDeleteFile(args);
        case 'find_files':
            return executeFindFiles(args);
        case 'lsp_definitions':
            return executeLspDefinitions(args);
        case 'lsp_references':
            return executeLspReferences(args);
        case 'lsp_symbols':
            return executeLspSymbols(args);
        case 'fetch_webpage':
            return executeFetchWebpage(args);
        case 'web_search':
            return executeWebSearch(args);
        default:
            return `Unknown tool: ${name}`;
    }
}

function executeReadFile({ path: filePath, start_line, end_line }) {
    try {
        let content = fs.readFileSync(filePath, 'utf8');
        // CRLF→LF 归一化：确保 LLM 始终看到统一换行符，消灭 search/replace 匹配歧义的源头
        content = content.replace(/\r\n/g, '\n');
        const lines = content.split('\n');
        const total = lines.length;
        const start = Math.max(0, (start_line || 1) - 1);
        const end = end_line ? Math.min(total, end_line) : Math.min(total, start + 500);
        const slice = lines.slice(start, end).join('\n');
        if (total <= 500 && !start_line) return content;
        return `File has ${total} lines. Showing L${start + 1}-${end}:\n${slice}`;
    } catch (err) {
        return `Error reading file: ${err.message}`;
    }
}

// ════════════════════════════════════════════════════════════
// edit_file — 精准文件编辑引擎（三级降级匹配 + 原子性 + VS Code 撤销）
// ════════════════════════════════════════════════════════════

/**
 * 空白归一化：将所有连续空白（空格/tab/\r）压缩为单个空格，去除行尾空白
 * 用于容错匹配：LLM 经常在缩进上出错（多一个空格、tab vs space）
 */
function _normalizeWhitespace(text) {
    return text.replace(/[^\S\n]+/g, ' ').replace(/ +$/gm, '').replace(/^ +/gm, m => ' '.repeat(m.length > 0 ? 1 : 0));
}

/**
 * 三级降级匹配策略：
 * L1: 精确匹配（完全一致）
 * L2: 空白容错匹配（归一化后比较）
 * L3: 行级匹配（逐行匹配，容忍缩进差异）
 *
 * 返回 { start, end, matchLevel } 或 null
 */
function _findMatch(content, find) {
    // L1: 精确匹配
    const idx1 = content.indexOf(find);
    if (idx1 !== -1) {
        return { start: idx1, end: idx1 + find.length, matchLevel: 1 };
    }

    // L1b: CRLF 归一化重试 — 处理 LLM 用 LF 但文件用 CRLF 的罕见情况
    // 原理：LLM 可能从记忆重建 find 文本（默认 LF），但 Windows 文件存 CRLF
    // 归一化后 indexOf 匹配，再通过扫描将归一化偏移映射回原始偏移
    if (content.includes('\r\n')) {
        const normContent = content.replace(/\r\n/g, '\n');
        const normFind = find.replace(/\r\n/g, '\n');
        if (normContent !== content || normFind !== find) {
            const idx1b = normContent.indexOf(normFind);
            if (idx1b !== -1) {
                // 归一化偏移 → 原始偏移映射
                let origPos = 0;
                for (let np = 0; np < idx1b; np++, origPos++) {
                    if (content[origPos] === '\r' && content[origPos + 1] === '\n') origPos++;
                }
                const origStart = origPos;
                for (let np = idx1b; np < idx1b + normFind.length; np++, origPos++) {
                    if (content[origPos] === '\r' && content[origPos + 1] === '\n') origPos++;
                }
                return { start: origStart, end: origPos, matchLevel: 1 };
            }
        }
    }

    // L2: 空白归一化匹配
    const normFind = _normalizeWhitespace(find);
    const normContent = _normalizeWhitespace(content);
    const idx2 = normContent.indexOf(normFind);
    if (idx2 !== -1) {
        // 反查原文位置：通过行号定位
        const normBefore = normContent.slice(0, idx2);
        const normAfter = normContent.slice(0, idx2 + normFind.length);
        const startLine = (normBefore.match(/\n/g) || []).length;
        const endLine = (normAfter.match(/\n/g) || []).length;
        const lines = content.split('\n');
        const originalStart = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
        const originalEnd = lines.slice(0, endLine + 1).join('\n').length;
        return { start: originalStart, end: originalEnd, matchLevel: 2 };
    }

    // L3: 行级匹配（逐行 trim 后匹配，容忍缩进差异）
    const findLines = find.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (findLines.length >= 2) {
        const contentLines = content.split('\n');
        for (let i = 0; i <= contentLines.length - findLines.length; i++) {
            let match = true;
            for (let j = 0; j < findLines.length; j++) {
                if (contentLines[i + j].trim() !== findLines[j]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                const startOffset = contentLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
                const endOffset = contentLines.slice(0, i + findLines.length).join('\n').length;
                return { start: startOffset, end: endOffset, matchLevel: 3 };
            }
        }
    }

    return null;
}

/**
 * 执行 edit_file：
 * - 多 edits 原子执行（先全部匹配，再一次性应用）
 * - 三级降级匹配
 * - VS Code WorkspaceEdit 支持原生撤销
 * - 无确认弹窗（自主执行）
 */
async function executeEditFile({ path: filePath, edits }) {
    if (!edits || edits.length === 0) return 'Error: no edits provided.';

    try {
        let content = fs.readFileSync(filePath, 'utf8');
        const results = [];
        let totalApplied = 0;

        // ─── Phase 1: 先全部匹配，确保原子性 ───
        const matchPlan = [];
        for (let i = 0; i < edits.length; i++) {
            const edit = edits[i];
            const m = _findMatch(content, edit.find);
            if (!m) {
                // 匹配失败 → 报错并给出上下文
                const preview = _getSimilarContext(content, edit.find);
                return `Error: edit #${i + 1} match failed — text not found in ${path.basename(filePath)}.${preview}`;
            }
            matchPlan.push({ edit, match: m, index: i });
        }

        // ─── Phase 2: 按顺序应用所有编辑 ───
        for (let pi = 0; pi < matchPlan.length; pi++) {
            const { edit, match } = matchPlan[pi];
            if (edit.replace_all) {
                const count = content.split(edit.find).length - 1;
                content = content.split(edit.find).join(edit.replace);
                results.push(`#${pi + 1}: all (${count}x, L${match.matchLevel})`);
                totalApplied += count;
            } else {
                const m = _findMatch(content, edit.find);
                if (m) {
                    content = content.slice(0, m.start) + edit.replace + content.slice(m.end);
                    results.push(`L${m.matchLevel}`);
                    totalApplied++;
                } else {
                    results.push('skip(moved)');
                }
            }
        }

        // ─── Phase 3: 写入文件 ───
        fs.writeFileSync(filePath, content, 'utf8');

        // 尝试通过 VS Code API 刷新编辑器（如果文件已打开）
        try {
            const uri = vscode.Uri.file(filePath);
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
            if (doc) {
                await vscode.commands.executeCommand('workbench.action.files.revert', uri);
            }
        } catch (_) { /* 编辑器刷新失败不影响实际写入 */ }

        const matchInfo = results.some(r => r.includes('L2') || r.includes('L3'))
            ? ` (whitespace-tolerant match used)` : '';
        let resultMsg = `✓ ${totalApplied} edit(s) applied to ${path.basename(filePath)}${matchInfo}`;

        // ─── Phase 4: 自我纠错—自动附带诊断信息（零额外工具调用） ───
        const diagResult = await _getDelayedDiagnostics(filePath);
        if (diagResult) {
            resultMsg += `\n\n⚠ Diagnostics after edit:\n${diagResult}`;
        }

        return resultMsg;
    } catch (err) {
        return `Error editing file: ${err.message}`;
    }
}

/**
 * 匹配失败时，给出最相似的上下文提示（帮助 LLM 自纠）
 */
function _getSimilarContext(content, find) {
    // 取 find 的第一行作为线索
    const firstLine = find.split('\n')[0].trim();
    if (firstLine.length < 5) return '';
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(firstLine) || lines[i].trim() === firstLine) {
            const ctx = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4)).join('\n');
            return `\nNearest match at line ${i + 1}:\n${ctx}`;
        }
    }
    return '';
}

/**
 * 自我纠错：编辑后延迟读取诊断信息
 * 等待语言服务器重新分析（~800ms），然后读取 errors
 * 只返回 Error 级别（忽略 Warning/Info/Hint）
 * 只对可编译文件类型触发（.js/.ts/.jsx/.tsx/.go/.py/.rs/.java/.c/.cpp/.cs）
 */
const _DIAGNOSABLE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.go', '.py', '.rs', '.java', '.c', '.cpp', '.cs', '.vue', '.svelte']);

async function _getDelayedDiagnostics(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!_DIAGNOSABLE_EXTS.has(ext)) return null;

    // 等待语言服务器重新分析
    await new Promise(r => setTimeout(r, 800));

    try {
        const uri = vscode.Uri.file(filePath);
        const diags = vscode.languages.getDiagnostics(uri);
        // 只取 Error 级别（severity === 0）
        const errors = diags.filter(d => d.severity === 0);
        if (errors.length === 0) return null;

        const lines = errors.slice(0, 10).map(d =>
            `  L${d.range.start.line + 1}: ${d.message}`
        );
        const suffix = errors.length > 10 ? `\n  ... and ${errors.length - 10} more errors` : '';
        return lines.join('\n') + suffix;
    } catch (_) {
        return null;
    }
}

// A-2: search_text 优化 — 目录读取缓存 + .gitignore 支持
const _DIR_CACHE = new Map();           // dir -> { entries, ts }
const _GITIGNORE_CACHE = new Map();     // root -> { patterns: Set<string>, ts }
const _DIR_CACHE_TTL = 5000;            // 5s TTL—避免脱数据
const _GITIGNORE_CACHE_TTL = 30000;     // 30s TTL

function _readdirCached(dir) {
    const now = Date.now();
    const cached = _DIR_CACHE.get(dir);
    if (cached && (now - cached.ts) < _DIR_CACHE_TTL) return cached.entries;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
    _DIR_CACHE.set(dir, { entries, ts: now });
    // 限流：超过 500 项时清除最早项
    if (_DIR_CACHE.size > 500) {
        const oldest = _DIR_CACHE.keys().next().value;
        _DIR_CACHE.delete(oldest);
    }
    return entries;
}

function _loadGitignore(root) {
    const now = Date.now();
    const cached = _GITIGNORE_CACHE.get(root);
    if (cached && (now - cached.ts) < _GITIGNORE_CACHE_TTL) return cached.patterns;
    const patterns = { dirs: new Set(), exts: new Set() };
    try {
        const gi = path.join(root, '.gitignore');
        if (fs.existsSync(gi)) {
            const content = fs.readFileSync(gi, 'utf8');
            for (const raw of content.split('\n')) {
                const line = raw.trim();
                if (!line || line.startsWith('#') || line.startsWith('!')) continue;
                // 简单解析：名字/、名字、*.ext 三种格式
                if (line.startsWith('*.')) {
                    patterns.exts.add(line.slice(1).toLowerCase()); // .ext
                } else {
                    // 剥去头尾斜杠
                    const name = line.replace(/^\/+|\/+$/g, '');
                    // 只处理不含中间斜杠且不含通配符的纯名字
                    if (name && !name.includes('/') && !name.includes('*') && !name.includes('?')) {
                        patterns.dirs.add(name);
                    }
                }
            }
        }
    } catch (_) {}
    _GITIGNORE_CACHE.set(root, { patterns, ts: now });
    return patterns;
}

function executeSearchText({ query, path: searchPath, max_results = 30 }) {
    // Pure Node.js recursive regex search — no external tools dependency
    let searchDirs = [];
    if (searchPath) {
        searchDirs = [searchPath];
    } else {
        const qqqExt = vscode.extensions.getExtension('gh555.qqq');
        if (qqqExt && qqqExt.isActive && qqqExt.exports && qqqExt.exports.getScopeAPI) {
            searchDirs = qqqExt.exports.getScopeAPI().getVisibleFolders();
        }
        if (searchDirs.length === 0) {
            const folders = vscode.workspace.workspaceFolders;
            searchDirs = folders ? folders.map(f => f.uri.fsPath) : [];
        }
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target']);
    const SKIP_EXTS = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.gif', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.xz', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.vsix', '.lock']);
    const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
    let regex;
    try {
        regex = new RegExp(query, 'i');
    } catch (_) {
        // If regex is invalid, escape and try literal
        regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const matches = [];
    function walk(dir, depth, gitignore) {
        if (depth > 10 || matches.length >= max_results) return;
        const entries = _readdirCached(dir);
        if (!entries) return;
        for (const entry of entries) {
            if (matches.length >= max_results) return;
            if (entry.name.startsWith('.') && entry.isDirectory()) continue;
            if (SKIP_DIRS.has(entry.name) && entry.isDirectory()) continue;
            if (gitignore && entry.isDirectory() && gitignore.dirs.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1, gitignore);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (SKIP_EXTS.has(ext)) continue;
                if (gitignore && gitignore.exts.has(ext)) continue;
                try {
                    const stat = fs.statSync(full);
                    if (stat.size > MAX_FILE_SIZE) continue;
                    const content = fs.readFileSync(full, 'utf8');
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length && matches.length < max_results; i++) {
                        if (regex.test(lines[i])) {
                            matches.push(`${full}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
                        }
                    }
                } catch (_) {}
            }
        }
    }

    for (const dir of searchDirs) {
        const gitignore = _loadGitignore(dir);
        walk(dir, 0, gitignore);
        if (matches.length >= max_results) break;
    }

    return matches.length > 0 ? matches.join('\n') : 'No matches found.';
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
        return 'Doer rejected the command.';
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

// 非图片扩展名黑名单
const NON_IMAGE_EXTS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.wav', '.mp3', '.flac', '.aac', '.ogg', '.pdf', '.doc', '.docx', '.zip', '.rar', '.7z', '.tar', '.gz']);

/**
 * 视觉识别 — 通过 gaea 服务端 DashScope Qwen VL
 * 含自动重试（429/502/503）+ 文件类型过滤
 */
async function executeAnalyzeImage({ path: imgPath, base64: imgBase64, prompt }) {
    try {
        // Task 5: 文件扩展名过滤
        if (imgPath) {
            const ext = path.extname(imgPath).toLowerCase();
            if (NON_IMAGE_EXTS.has(ext)) {
                return `[跳过: ${path.basename(imgPath)} 不是图片文件]`;
            }
        }

        let imageData = imgBase64;
        if (!imageData && imgPath) {
            const buf = fs.readFileSync(imgPath);
            // 文件太大(>10MB)跳过
            if (buf.length > 10 * 1024 * 1024) {
                return `[跳过: 文件过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB)]`;
            }
            imageData = buf.toString('base64');
        }
        if (!imageData) {
            return '[Error: No image provided. Provide either path or base64.]';
        }

        // 获取 auth token
        let token = _authTokenRef;
        if (!token) {
            const qqqExt = vscode.extensions.getExtension('gh555.qqq-ai');
            if (qqqExt && qqqExt.isActive && qqqExt.exports && qqqExt.exports.getAuthToken) {
                token = await qqqExt.exports.getAuthToken();
            }
        }
        if (!token) {
            return '[Error: Not authenticated. Please set your qqq token first.]';
        }

        const body = { image: imageData };
        if (prompt) body.prompt = prompt;

        // 带重试的请求（429/502/503 自动退避）
        const visionResult = await _visionRequestWithRetry(token, body, 3);
        return visionResult; // {description, ge_cost}
    } catch (err) {
        return `[图片识别失败: ${err.message}]`;
    }
}

/** Vision API 请求 + 自动重试，返回 {description, ge_cost} */
async function _visionRequestWithRetry(token, body, maxRetries) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const resp = await fetch('https://gh555.com/api/v3/ai/vision', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });

        if (resp.ok) {
            const result = await resp.json();
            return {
                description: result.description || '[Vision returned empty description]',
                ge_cost: result.ge_cost || 0
            };
        }

        // 可重试的状态码
        if ((resp.status === 429 || resp.status === 502 || resp.status === 503) && attempt < maxRetries) {
            let waitMs = 3000;
            if (resp.status === 429) {
                try {
                    const errBody = await resp.json();
                    waitMs = (errBody.retry_after || 3) * 1000;
                } catch (_) {}
            }
            await new Promise(r => setTimeout(r, waitMs));
            continue;
        }

        // 不可重试或重试耗尽
        if (resp.status === 413) return { description: '[跳过: 文件体积超出视觉模型限制]', ge_cost: 0 };
        if (resp.status === 429) return { description: '[图片识别繁忙，请稍后重试]', ge_cost: 0 };
        if (resp.status >= 500) return { description: '[图片识别服务暂时不可用，已跳过]', ge_cost: 0 };
        const text = await resp.text().catch(() => '');
        return { description: `[Vision error ${resp.status}: ${text.slice(0, 100)}]`, ge_cost: 0 };
    }
    return { description: '[图片识别失败: 重试耗尽]', ge_cost: 0 };
}

let _authTokenRef = null;
function setAuthTokenRef(token) { _authTokenRef = token; }

/**
 * 联网搜索 — 通过 gaea 服务端代理（避免客户端直连外网）
 */
async function executeWebSearch({ query }) {
    try {
        return `[Web search not yet connected. Query was: "${query}". Please answer based on your training knowledge.]`;
    } catch (err) {
        return `[Web search error: ${err.message}]`;
    }
}

/**
 * 创建新文件（已存在则失败）
 */
function executeCreateFile({ path: filePath, content }) {
    try {
        if (fs.existsSync(filePath)) {
            return `Error: file already exists: ${filePath}. Use write_patch_proposal to edit existing files.`;
        }
        // 确保目录存在
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
        return `File created: ${filePath} (${content.length} chars)`;
    } catch (err) {
        return `Error creating file: ${err.message}`;
    }
}

/**
 * 运行终端命令（30s 超时）
 */
function executeRunCommand({ command, cwd }) {
    try {
        const workDir = cwd || (vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath) || process.cwd();
        const isWin = process.platform === 'win32';
        const shellOpt = isWin ? { shell: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' } : {};
        const output = execSync(command, {
            cwd: workDir,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 30000,
            ...shellOpt
        });
        return output.length > 5000 ? output.slice(0, 5000) + '\n... (truncated)' : output;
    } catch (err) {
        // execSync 报错时 stdout/stderr 在 err 上
        const out = (err.stdout || '') + (err.stderr || '');
        return `Command failed (exit ${err.status || 'unknown'}):\n${out.slice(0, 3000)}`;
    }
}

function getTools(includeVision = true) {
    if (!includeVision) return TOOL_DEFINITIONS.filter(t => t.function.name !== 'analyze_image');
    return TOOL_DEFINITIONS;
}

/**
 * 删除文件
 */
function executeDeleteFile({ path: filePath }) {
    try {
        if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`;
        fs.unlinkSync(filePath);
        return `Deleted: ${filePath}`;
    } catch (err) {
        return `Error deleting file: ${err.message}`;
    }
}

/**
 * 按文件名 glob 搜索
 */
function executeFindFiles({ pattern, path: searchPath, max_results = 50 }) {
    const searchDirs = [];
    if (searchPath) {
        searchDirs.push(searchPath);
    } else {
        const qqqExt = vscode.extensions.getExtension('gh555.qqq');
        if (qqqExt && qqqExt.isActive && qqqExt.exports && qqqExt.exports.getScopeAPI) {
            searchDirs.push(...qqqExt.exports.getScopeAPI().getVisibleFolders());
        }
        if (searchDirs.length === 0) {
            const folders = vscode.workspace.workspaceFolders;
            if (folders) searchDirs.push(...folders.map(f => f.uri.fsPath));
        }
    }
    const isWin = process.platform === 'win32';
    const shellOpt = isWin ? { shell: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' } : {};
    const allFiles = [];
    for (const dir of searchDirs) {
        try {
            // 用 find (unix) 或 dir (win) + rg --files --glob
            let result;
            try {
                result = execSync(
                    `rg --files --glob "${pattern}" .`,
                    { cwd: dir, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000, ...shellOpt }
                );
            } catch (rgErr) {
                if (rgErr.status === 1) continue;
                continue;
            }
            const files = result.trim().split('\n').filter(Boolean).slice(0, max_results);
            allFiles.push(...files.map(f => path.resolve(dir, f)));
        } catch (_) {}
    }
    return allFiles.length > 0 ? allFiles.slice(0, max_results).join('\n') : 'No files found.';
}

/**
 * LSP: Go to definition
 */
async function executeLspDefinitions({ path: filePath, line, character }) {
    try {
        const uri = vscode.Uri.file(filePath);
        const pos = new vscode.Position(line - 1, character - 1);
        const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, pos);
        if (!locations || locations.length === 0) return 'No definition found.';
        return locations.map(loc => {
            const l = loc.targetUri || loc.uri;
            const r = loc.targetRange || loc.range;
            return `${l.fsPath}:${r.start.line + 1}:${r.start.character + 1}`;
        }).join('\n');
    } catch (err) {
        return `LSP error: ${err.message}`;
    }
}

/**
 * LSP: Find references
 */
async function executeLspReferences({ path: filePath, line, character }) {
    try {
        const uri = vscode.Uri.file(filePath);
        const pos = new vscode.Position(line - 1, character - 1);
        const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, pos);
        if (!locations || locations.length === 0) return 'No references found.';
        return locations.slice(0, 30).map(loc => {
            return `${loc.uri.fsPath}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
        }).join('\n');
    } catch (err) {
        return `LSP error: ${err.message}`;
    }
}

/**
 * LSP: Document symbols
 */
async function executeLspSymbols({ path: filePath }) {
    try {
        const uri = vscode.Uri.file(filePath);
        const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
        if (!symbols || symbols.length === 0) return 'No symbols found.';
        const flatten = (syms, indent = 0) => {
            let out = [];
            for (const s of syms) {
                const kind = vscode.SymbolKind[s.kind] || s.kind;
                out.push(`${'  '.repeat(indent)}${kind} ${s.name} L${s.range.start.line + 1}-${s.range.end.line + 1}`);
                if (s.children) out.push(...flatten(s.children, indent + 1));
            }
            return out;
        };
        return flatten(symbols).join('\n');
    } catch (err) {
        return `LSP error: ${err.message}`;
    }
}

/**
 * 抓取网页文本内容
 */
async function executeFetchWebpage({ url }) {
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'qqq-ai/1.0' },
            signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) return `HTTP ${resp.status}: ${resp.statusText}`;
        const html = await resp.text();
        // 粗略提取文本：移除 script/style 标签，取 textContent
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return text.length > 8000 ? text.slice(0, 8000) + '\n... (truncated)' : text;
    } catch (err) {
        return `Fetch error: ${err.message}`;
    }
}

module.exports = { getTools, executeTool, setPanelRef, setAuthTokenRef };

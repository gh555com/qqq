// File: src/q2.js
// ★★★ 文件管理器：Webview 界面 + 使用 qqq.js 四级回退 + 防惊群尺寸调度/缓存 ★★★
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const trash = require("trash");

// ==================== 从 qqq.js 导入核心接口 ====================
const qqq = require("./qqq");

// ==================== 完整性校验（与 q1 对齐，可选） ====================
const CORE_INTEGRITY_HASH =
    "dc10f424bef818e80eea0a5175bbb6cca07cbee34c8510c7b64069ef1661c88e";
const WATERMARK_PATH = path.join(__dirname, "..", "assets", "q2.gif");
let isCoreIntegrityValid = false;

function verifySystemIntegrity() {
    try {
        if (!fs.existsSync(WATERMARK_PATH)) return false;
        const buf = fs.readFileSync(WATERMARK_PATH);
        const hash = crypto.createHash("sha256").update(buf).digest("hex");
        return hash === CORE_INTEGRITY_HASH;
    } catch {
        return false;
    }
}

// ==================== 配置常量 ====================
const SIZE_CONFIG_KEY = "size_mode";
const KBM_OVERLAP_KEY = "kbm_overlap";

// 并发与缓存
const MAX_CONCURRENT_TASKS = 6;
const SIZE_CACHE_MAX_AGE_MS = 10 * 1000; // 10s：你可以按需调大/调小
const SIZE_CACHE_MAX_ENTRIES = 400;

const UNSUPPORTED_CODE_EXTENSIONS = new Set([
    ".exe",
    ".dll",
    ".bin",
    ".dat",
    ".iso",
    ".zip",
    ".rar",
    ".7z",
    ".tar",
    ".gz",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".webp",
    ".ico",
    ".mp3",
    ".wav",
    ".flac",
    ".mp4",
    ".avi",
    ".mkv",
    ".mov",
    ".wmv",
    ".pdf",
]);

// ==================== 全局变量 ====================
let activePanel = null;
let activePanelAlive = false; // 我们自己维护 disposed 状态，别依赖 panel.disposed（VS Code 没这个字段）
const usePanelReveal = 1;

let sizeMode = "none";
let kbmOverlap = 2;
let globalContext = null;

// ==================== 防惊群调度器（去重 + 限并发） ====================
class TaskScheduler {
    constructor(maxConcurrency = 6) {
        this.maxConcurrency = maxConcurrency;
        this.runningCount = 0;
        this.queue = [];
        this.pendingPromises = new Map();
    }

    async schedule(taskKey, taskGenerator) {
        if (this.pendingPromises.has(taskKey)) {
            return this.pendingPromises.get(taskKey);
        }

        const promise = new Promise((resolve, reject) => {
            const run = async () => {
                this.runningCount++;
                try {
                    const result = await taskGenerator();
                    resolve(result);
                } catch (e) {
                    reject(e);
                } finally {
                    this.runningCount--;
                    this.pendingPromises.delete(taskKey);
                    this._next();
                }
            };
            this.queue.push(run);
        });

        this.pendingPromises.set(taskKey, promise);
        this._next();
        return promise;
    }

    _next() {
        if (this.runningCount >= this.maxConcurrency || this.queue.length === 0) return;
        const task = this.queue.shift();
        task();
    }
}
const globalScheduler = new TaskScheduler(MAX_CONCURRENT_TASKS);

// ==================== 缓存（folder/file size）====================
const folderSizeCache = new Map(); // folderPath -> { size, ts }
const fileSizeCache = new Map(); // filePath -> { size, mtimeMs, ts }

function _pruneCacheIfNeeded(mapObj) {
    if (mapObj.size <= SIZE_CACHE_MAX_ENTRIES) return;
    // 粗暴删最老的
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, v] of mapObj.entries()) {
        const ts = v?.ts ?? 0;
        if (ts < oldestTs) {
            oldestTs = ts;
            oldestKey = k;
        }
    }
    if (oldestKey != null) mapObj.delete(oldestKey);
}

// ==================== 辅助函数 ====================
function escapeHtmlAttribute(str) {
    if (typeof str !== "string") str = String(str);
    return str
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeJsStringLiteral(str) {
    if (typeof str !== "string") str = String(str);
    return str
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

// ==================== 文件夹大小获取（使用 qqq.js 四级回退 + 缓存 + 调度）====================
async function getFolderSize(folderPath) {
    const now = Date.now();
    const cached = folderSizeCache.get(folderPath);
    if (cached && now - cached.ts < SIZE_CACHE_MAX_AGE_MS) return cached.size;

    const taskKey = `folderSize:${folderPath}`;
    return globalScheduler.schedule(taskKey, async () => {
        // 二次检查（并发下可能已有其它任务写入）
        const again = folderSizeCache.get(folderPath);
        const now2 = Date.now();
        if (again && now2 - again.ts < SIZE_CACHE_MAX_AGE_MS) return again.size;

        try {
            const result = await qqq.getFolderInfo(folderPath);
            if (result && result.success) {
                const sz = Number(result.total_size) || 0;
                folderSizeCache.set(folderPath, { size: sz, ts: Date.now() });
                _pruneCacheIfNeeded(folderSizeCache);
                return sz;
            }
            if (result && result.error) throw new Error(result.error);
            throw new Error("未知错误");
        } catch (error) {
            qqq.logMessage(`获取文件夹大小失败: ${folderPath} - ${error.message}`, "ERROR");
            throw error;
        }
    });
}

function getFileSizeSync(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return stats.size;
    } catch {
        return 0;
    }
}

// ==================== 尺寸格式化 ====================
function formatFileSize(bytes, mode) {
    if (mode === "none") return { text: "", show: false };

    let unit = "b";
    let value = bytes;

    if (bytes >= 1024 * 1024) {
        unit = "m";
        value = Math.round(bytes / (1024 * 1024));
    } else if (bytes >= 1024) {
        unit = "k";
        value = Math.round(bytes / 1024);
    }

    if (mode === "k" && bytes < 1024) return { text: "", show: false };
    if (mode === "m" && bytes < 1024 * 1024) return { text: "", show: false };

    const segWidth = 5;
    const ovRaw = parseInt(kbmOverlap, 10);
    const overlapChars = Math.max(0, Math.min(segWidth - 1, isNaN(ovRaw) ? 0 : ovRaw));

    const totalWidth = segWidth * 3;
    const chars = new Array(totalWidth).fill(" ");
    const valueStr = String(value) + unit;
    const padded = valueStr.padStart(segWidth, " ");

    function place(startIndex) {
        let start = startIndex;
        if (start < 0) start = 0;
        if (start >= totalWidth) return;
        for (let i = 0; i < segWidth && start + i < totalWidth; i++) {
            chars[start + i] = padded[i];
        }
    }

    const startM = 0;
    const startK = segWidth - overlapChars;
    const startB = segWidth * 2 - overlapChars * 2;

    if (unit === "m") place(startM);
    else if (unit === "k") place(startK);
    else place(startB);

    return { text: chars.join(""), show: true };
}

function getFileSizeDisplayAsync(itemPath, mode) {
    return globalScheduler.schedule(`sizeDisplay:${mode}:${itemPath}`, async () => {
        if (mode === "none") return "";

        // 文件：用 mtime + TTL 缓存
        // 文件夹：用 TTL 缓存（上面 getFolderSize）
        try {
            const stats = await fs.promises.stat(itemPath);

            const handleSize = (sizeInBytes) => {
                const formatted = formatFileSize(sizeInBytes, mode);
                return formatted.show ? formatted.text : "";
            };

            if (stats.isFile()) {
                const now = Date.now();
                const cached = fileSizeCache.get(itemPath);
                if (cached && cached.mtimeMs === stats.mtimeMs && now - cached.ts < SIZE_CACHE_MAX_AGE_MS) {
                    return handleSize(cached.size);
                }
                const sz = Number(stats.size) || 0;
                fileSizeCache.set(itemPath, { size: sz, mtimeMs: stats.mtimeMs, ts: Date.now() });
                _pruneCacheIfNeeded(fileSizeCache);
                return handleSize(sz);
            } else {
                const folderSz = await getFolderSize(itemPath);
                return handleSize(folderSz);
            }
        } catch (err) {
            qqq.logMessage(`计算大小失败: ${itemPath} - ${err.message}`, "ERROR");
            return " ...err ";
        }
    });
}

// ==================== 配置读写 ====================
function getConfig() {
    const defaultConfig = {
        recentDirs: [],
        lineSpacing: -2,
        sidebarWidth: 100,
        sidebarRatio: 0.2,
        recycleBin: [],
        isPinned: false,
        sizeMode: "none",
        kbmOverlap: 2,
    };

    if (!globalContext) return defaultConfig;

    const config = globalContext.globalState.get("qqq_config", defaultConfig);

    if (!config.recentDirs) config.recentDirs = [];
    if (typeof config.lineSpacing !== "number") config.lineSpacing = -2;
    if (typeof config.sidebarWidth !== "number") config.sidebarWidth = 100;
    if (typeof config.sidebarRatio !== "number") config.sidebarRatio = 0.2;
    if (!config.recycleBin) config.recycleBin = [];
    if (typeof config.isPinned !== "boolean") config.isPinned = false;
    if (!config.sizeMode) config.sizeMode = "none";
    if (typeof config.kbmOverlap !== "number") config.kbmOverlap = 2;

    sizeMode = config.sizeMode;
    kbmOverlap = config.kbmOverlap;
    return config;
}

function saveConfig(
    recentDirs,
    lineSpacing,
    sidebarWidth,
    sidebarRatio,
    recycleBin,
    isPinned,
    newSizeMode,
    newKbmOverlap
) {
    if (!globalContext) return;

    const nextSizeMode = newSizeMode || sizeMode || "none";
    const nextOverlap = Number.isInteger(newKbmOverlap) ? newKbmOverlap : kbmOverlap;

    const newConfig = {
        recentDirs,
        lineSpacing,
        sidebarWidth,
        sidebarRatio,
        recycleBin,
        isPinned,
        sizeMode: nextSizeMode,
        kbmOverlap: nextOverlap,
    };

    globalContext.globalState.update("qqq_config", newConfig);
    sizeMode = nextSizeMode;
    kbmOverlap = nextOverlap;
}

// ==================== 目录管理 ====================
function removeFromRecycleBin(directory) {
    const config = getConfig();
    let updated = false;
    const newRecycleBin = config.recycleBin.filter((dir) => {
        if (dir === directory) {
            updated = true;
            return false;
        }
        return true;
    });
    if (updated) {
        saveConfig(
            config.recentDirs,
            config.lineSpacing,
            config.sidebarWidth,
            config.sidebarRatio,
            newRecycleBin,
            config.isPinned,
            config.sizeMode,
            config.kbmOverlap
        );
    }
}

function addToRecycleBin(directory) {
    const config = getConfig();
    if (!directory || !fs.existsSync(directory) || typeof directory !== "string") return;
    const newRecycleBin = config.recycleBin.filter((dir) => dir !== directory);
    newRecycleBin.unshift(directory);
    saveConfig(
        config.recentDirs,
        config.lineSpacing,
        config.sidebarWidth,
        config.sidebarRatio,
        newRecycleBin.slice(0, 60),
        config.isPinned,
        config.sizeMode,
        config.kbmOverlap
    );
}

function saveRecentDirectory(directory) {
    const config = getConfig();
    if (!directory || !fs.existsSync(directory)) return;
    removeFromRecycleBin(directory);
    let recentDirs = config.recentDirs.filter((dir) => dir && dir !== directory);
    if (recentDirs.length >= 10) addToRecycleBin(recentDirs.pop());
    recentDirs.unshift(directory);
    saveConfig(
        recentDirs.slice(0, 10),
        config.lineSpacing,
        config.sidebarWidth,
        config.sidebarRatio,
        config.recycleBin,
        config.isPinned,
        config.sizeMode,
        config.kbmOverlap
    );
}

function removeAndRecycleRecentDirectory(directory) {
    const config = getConfig();
    let updated = false;
    const newRecentDirs = config.recentDirs.filter((dir) => {
        if (dir === directory) {
            updated = true;
            return false;
        }
        return true;
    });
    if (updated) {
        addToRecycleBin(directory);
        saveConfig(
            newRecentDirs,
            config.lineSpacing,
            config.sidebarWidth,
            config.sidebarRatio,
            config.recycleBin,
            config.isPinned,
            config.sizeMode,
            config.kbmOverlap
        );
    }
    return updated;
}

function getDrives() {
    const drives = [];
    if (process.platform === "win32") {
        try {
            const child = require("child_process").spawnSync("wmic", ["logicaldisk", "get", "caption"], {
                encoding: "utf8",
            });
            const lines = child.stdout.split("\n");
            for (const line of lines) {
                const driveMatch = line.match(/([A-Z]:)/);
                if (driveMatch) drives.push(driveMatch[1]);
            }
        } catch (error) {
            qqq.logMessage("获取驱动器列表失败: " + error.message, "ERROR");
            drives.push("C:");
        }
    } else {
        drives.push("/");
    }
    return drives;
}

function getDirectoryContents(dirPath) {
    const contents = { dirs: [], files: [] };
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            try {
                const stat = fs.statSync(entryPath);
                const item = {
                    name: entry.name,
                    path: entryPath,
                    isDir: entry.isDirectory(),
                    mtime: stat.mtime.toISOString(),
                };
                if (item.isDir) contents.dirs.push(item);
                else contents.files.push(item);
            } catch { }
        }
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        contents.dirs.sort((a, b) => collator.compare(a.name, b.name));
        contents.files.sort((a, b) => collator.compare(a.name, b.name));
    } catch (error) {
        qqq.logMessage(`读取目录内容失败: ${dirPath}`, "ERROR");
    }
    return contents;
}

// ==================== Webview 脚本生成 ====================
function generateWebviewScript(currentSizeMode, currentPath, sidebarRatio) {
    const escapedCurrentPath = escapeJsStringLiteral(currentPath);
    const escapedSizeMode = escapeJsStringLiteral(currentSizeMode);
    const escapedSidebarRatio = sidebarRatio.toFixed(4);

    return `
        const vscode = acquireVsCodeApi();
        const sizeMode = '${escapedSizeMode}';
        let currentPath = '${escapedCurrentPath}';
        let sidebarRatio = ${escapedSidebarRatio};
        let resizeObserver = null;
        const MIN_RESPONSIVE_WIDTH = 240;
        const MIN_TAG_WIDTH = 170;
        const ROW_HEIGHT = 22;
        const PIN_HIDE_WIDTH = 360;
        let baseRecentHeight = 0;
        let pathTooltipEl = null;
        let pathTooltipVisible = false;

        function ensurePathTooltip() {
            if (pathTooltipEl) return;
            pathTooltipEl = document.createElement('div');
            pathTooltipEl.id = 'pathTooltip';
            pathTooltipEl.className = 'path-tooltip';
            pathTooltipEl.style.display = 'none';
            document.body.appendChild(pathTooltipEl);
        }

        function hidePathTooltip() {
            if (pathTooltipEl) pathTooltipEl.style.display = 'none';
            pathTooltipVisible = false;
        }

        function showPathTooltip(text, clientX, clientY) {
            if (!text) { hidePathTooltip(); return; }
            ensurePathTooltip();
            pathTooltipEl.textContent = text;
            const margin = 8;
            let left = clientX + margin;
            let top = clientY + margin;
            pathTooltipEl.style.left = left + 'px';
            pathTooltipEl.style.top = top + 'px';
            pathTooltipEl.style.display = 'block';
            pathTooltipVisible = true;

            const rect = pathTooltipEl.getBoundingClientRect();
            const vw = window.innerWidth || document.documentElement.clientWidth;
            const vh = window.innerHeight || document.documentElement.clientHeight;

            if (rect.right > vw - 4) {
                left = Math.max(4, vw - rect.width - 4);
                pathTooltipEl.style.left = left + 'px';
            }
            if (rect.bottom > vh - 4) {
                top = Math.max(4, vh - rect.height - 4);
                pathTooltipEl.style.top = top + 'px';
            }
        }

        function isEllipsisActive(element) {
            if (!element) return false;
            return element.scrollWidth > element.clientWidth + 1;
        }

        // 关键修复：不要用 querySelector attribute 拼接路径（很容易被特殊字符搞炸）
        function findItemElementByPath(p, type) {
            const all = document.querySelectorAll('.file-item');
            for (const el of all) {
                if (el && el.dataset && el.dataset.path === p) {
                    if (!type) return el;
                    if ((el.dataset.type || '') === type) return el;
                }
            }
            return null;
        }

        function handleSidebarTooltipHover(e) {
            const target = e.target.closest('.nav-item, .recycle-item');
            if (!target || !isEllipsisActive(target)) {
                if (pathTooltipVisible) hidePathTooltip();
                return;
            }
            let text = (target.textContent || '').trim();
            if (text) showPathTooltip(text, e.clientX, e.clientY);
        }

        function handleKyTooltipHover(e) {
            const ky = document.getElementById('kyContent');
            if (!ky || ky.clientWidth >= 200) {
                if (pathTooltipVisible) hidePathTooltip();
                return;
            }
            let text = '';
            const recentItem = e.target.closest('.recent-item');
            if (recentItem) {
                const span = recentItem.querySelector('span:not(.delete-button)');
                text = (span && span.textContent) ? span.textContent : (recentItem.textContent || '');
            } else {
                const fileItem = e.target.closest('.file-item');
                if (fileItem) text = fileItem.getAttribute('data-path') || '';
                else {
                    if (pathTooltipVisible) hidePathTooltip();
                    return;
                }
            }
            text = (text || '').trim();
            if (text) showPathTooltip(text, e.clientX, e.clientY);
        }

        function calculateAndAdjustScroll() {
            const recentSection = document.querySelector('.recent-section');
            const kyContent = document.getElementById('kyContent');
            const addressBar = document.querySelector('.address-bar');
            if (!recentSection || !addressBar || !kyContent) return;

            const footerHeight = 60;
            const editorHeight = window.innerHeight - footerHeight;

            if (!baseRecentHeight && recentSection.style.display !== 'none') {
                baseRecentHeight = recentSection.offsetHeight || recentSection.scrollHeight || 0;
            }
            const addressHeight = addressBar.offsetHeight || 0;
            const needHeight = (baseRecentHeight || recentSection.offsetHeight || 0) + addressHeight + 100;

            recentSection.style.display = (editorHeight < needHeight) ? 'none' : '';
            const needScroll = kyContent.scrollHeight > kyContent.clientHeight + 1;
            kyContent.style.overflowY = needScroll ? 'auto' : 'hidden';
        }

        function checkAndApplyResponsive() {
            const container = document.querySelector('.container');
            if (!container) return;

            const currentWidth = container.clientWidth;
            const footer = document.querySelector('.footer');
            const pinContainer = document.getElementById('pinButton');
            const saveButton = footer.querySelector('.save-button');
            const createFolderBtn = footer.querySelector('.cancel-button');

            if (pinContainer) pinContainer.style.display = (currentWidth < PIN_HIDE_WIDTH) ? 'none' : 'block';

            if (currentWidth < MIN_RESPONSIVE_WIDTH) {
                if (saveButton) saveButton.style.display = 'none';
                if (createFolderBtn) createFolderBtn.style.display = 'block';
                footer.classList.add('responsive-narrow');
            } else {
                if (saveButton) saveButton.style.display = 'block';
                if (createFolderBtn) createFolderBtn.style.display = 'block';
                footer.classList.remove('responsive-narrow');
            }

            if (currentWidth < MIN_TAG_WIDTH) {
                if (createFolderBtn) createFolderBtn.style.display = 'none';
                footer.classList.add('responsive-extreme');
            } else {
                footer.classList.remove('responsive-extreme');
            }
            setTimeout(calculateAndAdjustScroll, 50);
        }

        document.addEventListener('DOMContentLoaded', () => {
            const filenameInput = document.getElementById('filenameInput');
            filenameInput.focus();
            updateResourceExplorer();
            adjustSidebarByRatio();
            ensurePathTooltip();

            const sidebarEl = document.querySelector('.sidebar');
            if (sidebarEl) {
                sidebarEl.addEventListener('mousemove', handleSidebarTooltipHover);
                sidebarEl.addEventListener('mouseleave', hidePathTooltip);
            }
            const kyEl = document.getElementById('kyContent');
            if (kyEl) {
                kyEl.addEventListener('mousemove', handleKyTooltipHover);
                kyEl.addEventListener('mouseleave', hidePathTooltip);
            }
            document.addEventListener('scroll', hidePathTooltip, true);

            window.addEventListener('resize', () => {
                adjustSidebarByRatio();
                checkAndApplyResponsive();
            });

            const container = document.querySelector('.container');
            if (container && 'ResizeObserver' in window) {
                resizeObserver = new ResizeObserver(() => {
                    adjustSidebarByRatio();
                    checkAndApplyResponsive();
                });
                resizeObserver.observe(container);
            }

            document.getElementById('fileList').addEventListener('click', (event) => {
                const fileItem = event.target.closest('.file-item');
                if (!fileItem) {
                    const prevSelected = document.querySelector('.file-item.selected');
                    if (prevSelected) {
                        const renameInput = prevSelected.querySelector('.rename-input');
                        if (renameInput) cancelRename(prevSelected);
                        prevSelected.classList.remove('selected');
                    }
                    selectedItem = null;
                    return;
                }

                const type = fileItem.dataset.type;
                const isSzArea = event.target.classList.contains('sz-area');
                const isSelectArea = event.target.closest('.file-select-area');
                const isFolderNameArea = event.target.closest('.folder-name-area');

                if (type === 'folder') {
                    if (isSelectArea && !isFolderNameArea) {
                        selectFileItem(fileItem, true);
                        currentFocusType = 'fileList';
                        return;
                    }
                    if (isFolderNameArea) {
                        vscode.postMessage({ command: 'navigate', path: fileItem.dataset.path });
                        currentFocusType = 'fileList';
                        return;
                    }
                    selectFileItem(fileItem, true);
                    currentFocusType = 'fileList';
                    return;
                }

                selectFileItem(fileItem, type === 'file');
                if (isSzArea) {
                    const szArea = event.target;
                    szArea.textContent = '    \\u2022    ';
                    vscode.postMessage({ command: 'requestSize', path: fileItem.dataset.path, type: type });
                }
                currentFocusType = 'fileList';
            });
            checkAndApplyResponsive();
        });

        function adjustSidebarByRatio() {
            const container = document.querySelector('.container');
            const sidebar = document.querySelector('.sidebar');
            const resizer = document.getElementById('sidebarResizer');
            const kyContent = document.querySelector('.ky-content');
            if (!container || !sidebar || !resizer || !kyContent) return;

            const totalWidth = container.clientWidth;
            let newWidth = Math.max(50, Math.min(500, totalWidth * sidebarRatio));

            sidebar.style.width = newWidth + 'px';
            resizer.style.left = newWidth + 'px';
            kyContent.style.left = newWidth + 'px';
        }

        function navigateTo(path) { vscode.postMessage({ command: 'navigate', path: path }); }
        function navigateIntoFolder(path) { vscode.postMessage({ command: 'navigate', path: path }); }

        let currentFocusType = 'filenameInput';
        document.addEventListener('focusin', (event) => { updateFocusType(event.target); });
        document.addEventListener('focusout', (event) => {
            if (['filenameInput', 'addressInput'].includes(event.target.id) || event.target.classList.contains('rename-input')) {
                setTimeout(() => {
                    const activeElement = document.activeElement;
                    if (!['filenameInput', 'addressInput'].includes(activeElement.id) && !activeElement.classList.contains('rename-input')) {
                        updateFocusType(activeElement);
                    }
                }, 0);
            }
        });

        document.addEventListener('click', (event) => {
            hideAllContextMenus();
            if (!['filenameInput', 'addressInput'].includes(event.target.id) && !event.target.classList.contains('rename-input') && currentFocusType === 'input') {
                updateFocusType(event.target);
            }
        });

        function updateFocusType(element) {
            if (['filenameInput', 'addressInput'].includes(element.id) || element.classList.contains('rename-input')) currentFocusType = 'input';
            else if (element.classList.contains('file-list-container') || element.closest('.file-list-container')) currentFocusType = 'fileList';
            else if (element.classList.contains('sidebar') || element.closest('.sidebar')) currentFocusType = 'sidebar';
            else if (element.classList.contains('recent-section') || element.closest('.recent-section')) currentFocusType = 'recentSection';
            else currentFocusType = 'other';
        }

        function handleFilenameInputKeyDown(event) { if (event.key === 'Enter') saveFile(); }

        function saveFile() {
            const filename = document.getElementById('filenameInput').value.trim();
            if (filename) {
                const isPinned = document.querySelector('#pinButton .pin-box').classList.contains('pinned');
                vscode.postMessage({ command: 'save', filename: filename, isPinned: isPinned, openInCurrentGroup: !isPinned });
                if (isPinned) {
                    document.getElementById('filenameInput').value = '';
                    document.getElementById('filenameInput').focus();
                }
            } else {
                alert('请输入文件名');
            }
        }

        function togglePin() {
            const pinBox = document.querySelector('#pinButton .pin-box');
            const pinCheckbox = document.querySelector('#pinButton .pin-checkbox');
            const newPinState = !pinBox.classList.contains('pinned');

            if (newPinState) {
                pinBox.classList.add('pinned');
                pinCheckbox.textContent = '\\u2713';
            } else {
                pinBox.classList.remove('pinned');
                pinCheckbox.textContent = '\\u25a1';
            }
            vscode.postMessage({ command: 'togglePin', isPinned: newPinState });
        }

        function removeFromRecent(path) { vscode.postMessage({ command: 'removeFromRecent', path: path }); }
        function cancel() { vscode.postMessage({ command: 'cancel' }); }

        function refreshSizeDisplay() {
            const items = document.querySelectorAll('.file-item');
            items.forEach(item => {
                const szArea = item.querySelector('.sz-area');
                if (item.dataset.type === 'file' && szArea) {
                    szArea.textContent = sizeMode !== 'none' ? '    \\u2022    ' : '';
                    vscode.postMessage({ command: 'requestSize', path: item.dataset.path, type: item.dataset.type });
                }
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'update') {
                document.getElementById('addressInput').value = message.currentPath;
                document.getElementById('fileList').innerHTML = message.fileListHtml;
                requestFileSizeUpdates(message.items);
                setTimeout(() => { calculateAndAdjustScroll(); checkAndApplyResponsive(); }, 100);
            }
            else if (message.command === 'updateSize') {
                const item = findItemElementByPath(message.path, message.type);
                if (item) {
                    const szArea = item.querySelector('.sz-area');
                    if (szArea) szArea.textContent = message.sizeDisplay;
                }
            }
            else if (message.command === 'clearFilenameInput') {
                document.getElementById('filenameInput').value = '';
                document.getElementById('filenameInput').focus();
            }
            else if (message.command === 'startRename') startRename(message.path, message.name, message.type);
            else if (message.command === 'refreshSizes') refreshSizeDisplay();
            else if (message.command === 'restoreDeletedItem') {
                const itemElement = findItemElementByPath(message.path);
                if (itemElement) { itemElement.style.opacity = ''; itemElement.style.pointerEvents = ''; }
            }
            else if (message.command === 'updateSidebarRatio') {
                sidebarRatio = message.ratio;
                adjustSidebarByRatio();
            }
            else if (message.command === 'focusInput') {
                const filenameInput = document.getElementById('filenameInput');
                if (filenameInput) { filenameInput.focus(); filenameInput.select(); }
            }
        });

        function requestFileSizeUpdates(items) {
            if (sizeMode === 'none') return;
            items.forEach(item => {
                if (item.name === '..' || item.type !== 'file') return;
                const itemElement = findItemElementByPath(item.path, item.type);
                if (itemElement) {
                    const szArea = itemElement.querySelector('.sz-area');
                    if (szArea) szArea.textContent = '    \\u2022    ';
                }
                vscode.postMessage({ command: 'requestSize', path: item.path, type: item.type, name: item.name });
            });
        }

        let selectedItem = null;
        function isPinned() { return !!document.querySelector('#pinButton .pin-box.pinned'); }

        function selectFileItem(fileItem, requestSize) {
            if (!fileItem) return;
            const type = fileItem.dataset.type;
            const p = fileItem.dataset.path;
            const name = fileItem.dataset.name;

            const prevSelected = document.querySelector('.file-item.selected');
            if (prevSelected && prevSelected !== fileItem) {
                if (prevSelected.querySelector('.rename-input')) cancelRename(prevSelected);
                prevSelected.classList.remove('selected');
            }

            fileItem.classList.add('selected');
            selectedItem = { type, path: p, name };
            currentFocusType = 'fileList';

            if (sizeMode !== 'none' && requestSize) {
                const szArea = fileItem.querySelector('.sz-area');
                if (szArea) szArea.textContent = '    \\u2022    ';
                vscode.postMessage({ command: 'requestSize', path: p, type: type });
            }
        }

        let renameBlurHandler = null;
        function startRename(itemPath, itemName, itemType) {
            const itemElement = findItemElementByPath(itemPath);
            if (!itemElement) return;

            const prevSelected = document.querySelector('.file-item.selected');
            if (prevSelected && prevSelected !== itemElement) {
                if (prevSelected.querySelector('.rename-input')) cancelRename(prevSelected);
                prevSelected.classList.remove('selected');
            }
            itemElement.classList.add('selected');
            selectedItem = { type: itemType, path: itemPath, name: itemName };

            const nameArea = itemElement.querySelector(\`.\${itemType === 'file' ? 'file' : 'folder'}-name-area\`);
            if (!nameArea || nameArea.querySelector('.rename-input')) return;

            const originalContent = nameArea.innerHTML;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'rename-input';
            input.value = itemName;
            Object.assign(input.style, { width: '100%', padding: '0', border: '1px solid #ff6b00', boxSizing: 'border-box', fontSize: 'inherit', fontFamily: 'inherit', lineHeight: 'inherit', backgroundColor: '#ff6b00', color: 'white' });

            nameArea.innerHTML = '';
            nameArea.appendChild(input);
            input.focus();

            const dotIndex = itemName.lastIndexOf('.');
            if (dotIndex > 0) input.setSelectionRange(0, dotIndex);
            else input.select();

            currentFocusType = 'input';
            renameBlurHandler = () => cancelRename(itemElement, originalContent);

            const handleKeyDown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault(); e.stopPropagation();
                    commitRename(itemElement, itemPath, itemType, input.value.trim());
                } else if (e.key === 'Escape') {
                    e.preventDefault(); e.stopPropagation();
                    cancelRename(itemElement, originalContent);
                }
            };
            input.addEventListener('keydown', handleKeyDown);
            input.addEventListener('blur', renameBlurHandler);
            itemElement.dataset.originalContent = originalContent;
        }

        function commitRename(itemElement, oldPath, itemType, newName) {
            const input = itemElement.querySelector('.rename-input');
            if (!input) return;
            input.removeEventListener('blur', renameBlurHandler);
            renameBlurHandler = null;
            currentFocusType = 'fileList';
            const oldName = itemElement.dataset.name;
            if (newName && newName !== oldName) {
                vscode.postMessage({ command: 'renameItem', oldPath: oldPath, newName: newName, itemType: itemType });
            } else {
                cancelRename(itemElement, itemElement.dataset.originalContent);
            }
        }

        function cancelRename(itemElement, originalContent) {
            const input = itemElement.querySelector('.rename-input');
            if (!input) return;
            input.removeEventListener('blur', renameBlurHandler);
            renameBlurHandler = null;
            currentFocusType = 'fileList';
            const itemType = itemElement.dataset.type;
            const nameArea = itemElement.querySelector(\`.\${itemType === 'file' ? 'file' : 'folder'}-name-area\`);
            if (nameArea) nameArea.innerHTML = originalContent || \`<span class="file-name">\${itemElement.dataset.name}</span>\`;
        }

        function performEditAction(itemToEdit) { if(itemToEdit) startRename(itemToEdit.path, itemToEdit.name, itemToEdit.type); }
        function performOpenAction(itemToOpen) { if(itemToOpen) vscode.postMessage({ command: 'openWithDefault', path: itemToOpen.path, type: itemToOpen.type }); }

        function performDeleteAction(itemToDelete) {
            if (!itemToDelete) return;
            const itemElement = findItemElementByPath(itemToDelete.path);
            if (itemElement) { itemElement.style.opacity = '0.5'; itemElement.style.pointerEvents = 'none'; }
            vscode.postMessage({ command: 'quickDeleteToRecycleBin', path: itemToDelete.path, type: itemToDelete.type });
            selectedItem = null;
        }

        function performCodeAction(itemToCode) {
            if (!itemToCode) return;
            if (itemToCode.type === 'file') {
                const pinned = isPinned();
                vscode.postMessage({ command: 'editFile', path: itemToCode.path, isPinned: pinned, openInCurrentGroup: !pinned });
            } else {
                vscode.postMessage({ command: 'openFolderInNewWindow', path: itemToCode.path });
            }
        }

        function performSizeAction(itemToRefresh) {
            if (!itemToRefresh) return;
            const item = findItemElementByPath(itemToRefresh.path);
            if (item) {
                const szArea = item.querySelector('.sz-area');
                if (szArea) szArea.textContent = '    \\u2022    ';
            }
            vscode.postMessage({ command: 'refreshSize', path: itemToRefresh.path, type: itemToRefresh.type });
        }

        function handleContextMenuAction(action) {
            const contextMenu = document.getElementById('itemContextMenu');
            const itemForAction = { path: contextMenu.dataset.path, name: contextMenu.dataset.name, type: contextMenu.dataset.type };
            hideAllContextMenus();
            if (!itemForAction || !itemForAction.path) return;
            switch(action) {
                case 'rename': performEditAction(itemForAction); break;
                case 'open': performOpenAction(itemForAction); break;
                case 'delete': performDeleteAction(itemForAction); break;
                case 'code': performCodeAction(itemForAction); break;
                case 'size': performSizeAction(itemForAction); break;
            }
        }

        function hideAllContextMenus() {
            document.getElementById('itemContextMenu').style.display = 'none';
            document.getElementById('emptyContextMenu').style.display = 'none';
        }

        document.getElementById('itemContextMenu').querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                handleContextMenuAction(e.currentTarget.dataset.action);
            });
        });

        document.getElementById('fileList').addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            hideAllContextMenus();
            const itemElement = e.target.closest('.file-item');
            const itemContextMenu = document.getElementById('itemContextMenu');
            const emptyContextMenu = document.getElementById('emptyContextMenu');

            if (itemElement) {
                selectFileItem(itemElement, false);
                const itemPath = itemElement.dataset.path;
                const itemType = itemElement.dataset.type;

                if (itemType === 'folder') {
                    const szArea = itemElement.querySelector('.sz-area');
                    if (szArea) szArea.textContent = '    \\u2022    ';
                    vscode.postMessage({ command: 'requestSize', path: itemPath, type: itemType });
                }

                itemContextMenu.dataset.path = itemPath;
                itemContextMenu.dataset.name = itemElement.dataset.name;
                itemContextMenu.dataset.type = itemType;
                itemContextMenu.style.left = e.clientX + 'px';
                itemContextMenu.style.top = e.clientY + 'px';
                itemContextMenu.style.display = 'flex';
            } else {
                emptyContextMenu.style.left = e.clientX + 'px';
                emptyContextMenu.style.top = e.clientY + 'px';
                emptyContextMenu.style.display = 'flex';
            }
        });

        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('#fileList')) { e.preventDefault(); e.stopPropagation(); }
        });

        function setSizeMode(mode) {
            hideAllContextMenus();
            vscode.postMessage({ command: 'setSizeMode', mode: mode });
        }

        document.addEventListener('keydown', event => {
            if (currentFocusType === 'input' || !selectedItem) return;
            const key = event.key.toLowerCase();
            if (event.ctrlKey && (key === 'a' || key === 'c' || key === 'x')) { event.preventDefault(); event.stopPropagation(); return; }

            if (key === 'q') { event.preventDefault(); event.stopPropagation(); performEditAction(selectedItem); }
            else if (key === 'w') { event.preventDefault(); event.stopPropagation(); performOpenAction(selectedItem); }
            else if (key === 's') { event.preventDefault(); event.stopPropagation(); performDeleteAction(selectedItem); }
            else if (key === 'e') { event.preventDefault(); event.stopPropagation(); performCodeAction(selectedItem); }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Backspace' && currentFocusType !== 'input') {
                event.preventDefault();
                vscode.postMessage({ command: 'navigateUp' });
            }
        });

        const sidebarResizer = document.getElementById('sidebarResizer');
        const sidebar = document.querySelector('.sidebar');
        const kyContent = document.querySelector('.ky-content');
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        if (sidebarResizer && sidebar && kyContent) {
            sidebarResizer.addEventListener('mousedown', (e) => {
                isResizing = true; startX = e.clientX; startWidth = sidebar.offsetWidth;
                sidebarResizer.classList.add('active'); document.body.style.userSelect = 'none';
            });
            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const container = document.querySelector('.container');
                const totalWidth = container ? container.clientWidth : window.innerWidth;
                const newWidth = Math.max(50, Math.min(500, totalWidth * Math.max(0.05, Math.min(0.5, (startWidth + e.clientX - startX) / totalWidth))));
                sidebar.style.width = newWidth + 'px';
                sidebarResizer.style.left = newWidth + 'px';
                kyContent.style.left = newWidth + 'px';
            });
            document.addEventListener('mouseup', () => {
                if (!isResizing) return;
                isResizing = false;
                sidebarResizer.classList.remove('active');
                document.body.style.userSelect = '';
                const container = document.querySelector('.container');
                const totalWidth = container ? container.clientWidth : window.innerWidth;
                vscode.postMessage({ command: 'saveSidebarRatio', ratio: (parseInt(sidebar.style.width) || 100) / totalWidth });
            });
            document.addEventListener('mouseleave', () => {
                if (isResizing) { isResizing = false; sidebarResizer.classList.remove('active'); document.body.style.userSelect = ''; }
            });
        }

        function createFolder() {
            const folderName = document.getElementById('filenameInput').value.trim();
            if (folderName) vscode.postMessage({ command: 'createFolder', folderName: folderName });
            else alert('请输入文件夹名');
        }

        function updateResourceExplorer() {}
    `;
}

function getWebviewContent(currentPath) {
    const config = getConfig();
    const drives = getDrives();

    const safeRecentDirs = config.recentDirs.filter((dir) => dir && fs.existsSync(dir));
    const safeRecycleBin = config.recycleBin.filter(
        (dir) => dir && typeof dir === "string" && fs.existsSync(dir)
    );
    const showRecycleBin =
        vscode.workspace.getConfiguration("qqq").get("showHistoryRecycleBin", true) &&
        safeRecycleBin.length > 0;

    let htmlTemplate = "";
    try {
        htmlTemplate = fs.readFileSync(path.join(__dirname, "q2.html"), "utf8");
    } catch (error) {
        qqq.logMessage(`无法读取 q2.html 模板文件: ${error.message}`, "ERROR");
        return `<h1>错误: 无法加载 q2.html 模板</h1><p>${escapeHtmlAttribute(error.message)}</p>`;
    }

    const drivesHtml = drives
        .map(
            (drive) =>
                `<button class="nav-item" onclick="navigateTo('${escapeJsStringLiteral(
                    drive
                )}')">${escapeHtmlAttribute(drive)}</button>`
        )
        .join("");

    const recycleBinHtml = showRecycleBin
        ? `
        <div class="divider"></div>
        <div class="recycle-bin-section">
            ${safeRecycleBin
            .map(
                (dir) =>
                    `<div class="recycle-item" onclick="navigateTo('${escapeJsStringLiteral(
                        dir
                    )}')">${escapeHtmlAttribute(dir)}</div>`
            )
            .join("")}
        </div>`
        : "";

    const recentDirsHtml = safeRecentDirs
        .reverse()
        .map(
            (dir) => `
        <div class="recent-item" onclick="navigateTo('${escapeJsStringLiteral(dir)}')">
            <span class="delete-button" onclick="event.stopPropagation(); removeFromRecent('${escapeJsStringLiteral(
                dir
            )}')">×</span>
            <span>${escapeHtmlAttribute(dir)}</span>
        </div>`
        )
        .join("");

    const inlineScript = generateWebviewScript(config.sizeMode, currentPath, config.sidebarRatio);

    let finalHtml = htmlTemplate
        .replace("{{SIDEBAR_WIDTH}}", config.sidebarWidth)
        .replace("{{LINE_SPACING}}", config.lineSpacing)
        .replace("{{DRIVES_HTML}}", drivesHtml)
        .replace("{{RECYCLE_BIN_HTML}}", recycleBinHtml)
        .replace("{{RECENT_DIRS_HTML}}", recentDirsHtml)
        .replace("{{CURRENT_PATH}}", escapeHtmlAttribute(currentPath))
        .replace("{{PIN_CLASS}}", config.isPinned ? "pinned" : "")
        .replace("{{PIN_CHECKBOX}}", config.isPinned ? "✓" : "□")
        .replace("{{SIZE_MODE_NONE_CLASS}}", config.sizeMode === "none" ? "selected" : "")
        .replace("{{SIZE_MODE_M_CLASS}}", config.sizeMode === "m" ? "selected" : "")
        .replace("{{SIZE_MODE_K_CLASS}}", config.sizeMode === "k" ? "selected" : "")
        .replace("{{SIZE_MODE_B_CLASS}}", config.sizeMode === "b" ? "selected" : "")
        .replace("{{INLINE_SCRIPT}}", inlineScript.replace(/<\/script>/gi, "<\\/script>"));

    return finalHtml;
}

// ==================== 主逻辑 ====================
function showSaveAsDialog() {
    if (!isCoreIntegrityValid) {
        vscode.window.showErrorMessage("Integrity check failed.");
        return;
    }

    if (activePanel && activePanelAlive) {
        if (usePanelReveal === 1) activePanel.reveal(vscode.ViewColumn.Active);
        setTimeout(() => {
            try {
                if (activePanel && activePanelAlive) activePanel.webview.postMessage({ command: "focusInput" });
            } catch { }
        }, 100);
        return;
    }

    const config = getConfig();
    let currentPath =
        config.recentDirs.length > 0 ? config.recentDirs[0] : process.env.USERPROFILE || "C:\\";
    try {
        if (!fs.existsSync(currentPath)) currentPath = process.env.USERPROFILE || "C:\\";
        else if (!fs.statSync(currentPath).isDirectory()) currentPath = path.dirname(currentPath);
    } catch {
        currentPath = process.env.USERPROFILE || "C:\\";
    }

    const panel = vscode.window.createWebviewPanel(
        "q2",
        "qqq new 新建",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    activePanel = panel;
    activePanelAlive = true;

    const iconPath = path.join(__dirname, "..", "assets", "icon.png");
    if (fs.existsSync(iconPath)) panel.iconPath = vscode.Uri.file(iconPath);

    panel.onDidDispose(() => {
        activePanelAlive = false;
        activePanel = null;
    });

    function updateResourceExplorer() {
        try {
            if (!panel || !activePanelAlive) return;

            const directoryContents = getDirectoryContents(currentPath);
            const items = [];
            let fileListHtml = "";

            if (currentPath.length > 3 && path.dirname(currentPath) !== currentPath) {
                const parentPath = path.dirname(currentPath);
                items.push({ path: parentPath, name: "..", type: "folder" });
                fileListHtml += `<div class="file-item folder" data-path="${escapeHtmlAttribute(
                    parentPath
                )}" data-name=".." data-type="folder"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">📁</span></div><div class="folder-name-area"><span class="file-name">..</span></div></div>`;
            }

            directoryContents.dirs.forEach((dir) => {
                items.push({ path: dir.path, name: dir.name, type: "folder" });
                fileListHtml += `<div class="file-item folder" data-path="${escapeHtmlAttribute(
                    dir.path
                )}" data-name="${escapeHtmlAttribute(
                    dir.name
                )}" data-type="folder"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">📁</span></div><div class="folder-name-area"><span class="file-name">${escapeHtmlAttribute(
                    dir.name
                )}</span></div></div>`;
            });

            directoryContents.files.forEach((file) => {
                items.push({ path: file.path, name: file.name, type: "file" });
                fileListHtml += `<div class="file-item file" data-path="${escapeHtmlAttribute(
                    file.path
                )}" data-name="${escapeHtmlAttribute(
                    file.name
                )}" data-type="file"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">🗎</span></div><div class="file-name-area"><span class="file-name">${escapeHtmlAttribute(
                    file.name
                )}</span></div></div>`;
            });

            panel.webview.postMessage({
                command: "update",
                currentPath,
                fileListHtml,
                items,
            });
        } catch (error) {
            qqq.logMessage(`更新资源展示区失败: ${error}`, "ERROR");
        }
    }

    function refreshWebview() {
        if (!panel || !activePanelAlive) return;
        try {
            panel.webview.html = getWebviewContent(currentPath);
            setTimeout(() => {
                if (!panel || !activePanelAlive) return;
                updateResourceExplorer();
                try {
                    panel.webview.postMessage({ command: "focusInput" });
                } catch { }
            }, 100);
        } catch (e) {
            qqq.logMessage("Refresh Webview failed: " + e.message, "ERROR");
        }
    }

    function getShowOptions(openInCurrentGroup) {
        const baseOptions = { preserveFocus: false };
        if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) {
            return openInCurrentGroup
                ? baseOptions
                : Object.assign({}, baseOptions, { viewColumn: vscode.ViewColumn.Beside });
        }
        const allGroups = vscode.window.tabGroups.all || [];
        if (openInCurrentGroup || !allGroups.length)
            return Object.assign({}, baseOptions, { viewColumn: vscode.ViewColumn.One });

        const sorted = allGroups
            .filter((g) => typeof g.viewColumn === "number")
            .sort((a, b) => a.viewColumn - b.viewColumn);
        return Object.assign({}, baseOptions, {
            viewColumn: sorted.length > 0 ? sorted[0].viewColumn : vscode.ViewColumn.One,
        });
    }

    panel.webview.onDidReceiveMessage(async (message) => {
        if (!panel || !activePanelAlive) return;

        const currentConfig = getConfig();

        switch (message.command) {
            case "removeFromRecent":
                if (removeAndRecycleRecentDirectory(message.path)) refreshWebview();
                break;

            case "setSizeMode":
                saveConfig(
                    currentConfig.recentDirs,
                    currentConfig.lineSpacing,
                    currentConfig.sidebarWidth,
                    currentConfig.sidebarRatio,
                    currentConfig.recycleBin,
                    currentConfig.isPinned,
                    message.mode,
                    currentConfig.kbmOverlap
                );
                refreshWebview();
                break;

            case "requestSize":
            case "refreshSize":
                if (currentConfig.sizeMode === "none") break;
                try {
                    const display = await getFileSizeDisplayAsync(message.path, currentConfig.sizeMode);
                    if (panel && activePanelAlive) {
                        panel.webview.postMessage({
                            command: "updateSize",
                            path: message.path,
                            type: message.type,
                            sizeDisplay: display,
                        });
                    }
                } catch { }
                break;

            case "renameItem":
                try {
                    const { oldPath, newName } = message;
                    const newPath = path.join(path.dirname(oldPath), newName);
                    if (fs.existsSync(newPath)) {
                        vscode.window.showErrorMessage(`重命名失败：目标位置已存在同名项。`);
                        refreshWebview();
                    } else {
                        fs.renameSync(oldPath, newPath);
                        saveRecentDirectory(path.dirname(oldPath));
                        setTimeout(() => {
                            if (panel && activePanelAlive) refreshWebview();
                        }, 100);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("重命名失败: " + error.message);
                    refreshWebview();
                }
                break;

            case "navigate":
                try {
                    let newPath = message.path;
                    if (process.platform === "win32" && /^[A-Z]:$/i.test(newPath)) newPath += "\\";
                    if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
                        currentPath = newPath;
                        refreshWebview();
                    } else {
                        vscode.window.showErrorMessage("无效的目录路径: " + newPath);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("导航失败: " + error.message);
                }
                break;

            case "navigateUp": {
                const parentDir = path.dirname(currentPath);
                if (parentDir !== currentPath) {
                    currentPath = parentDir;
                    refreshWebview();
                }
                break;
            }

            case "saveSidebarRatio":
                saveConfig(
                    currentConfig.recentDirs,
                    currentConfig.lineSpacing,
                    currentConfig.sidebarWidth,
                    message.ratio,
                    currentConfig.recycleBin,
                    currentConfig.isPinned,
                    currentConfig.sizeMode,
                    currentConfig.kbmOverlap
                );
                if (panel && activePanelAlive)
                    panel.webview.postMessage({ command: "updateSidebarRatio", ratio: message.ratio });
                break;

            case "togglePin":
                saveConfig(
                    currentConfig.recentDirs,
                    currentConfig.lineSpacing,
                    currentConfig.sidebarWidth,
                    currentConfig.sidebarRatio,
                    currentConfig.recycleBin,
                    message.isPinned,
                    currentConfig.sizeMode,
                    currentConfig.kbmOverlap
                );
                break;

            case "save": {
                const { filename, isPinned, openInCurrentGroup } = message;
                const fullFilePath = path.join(currentPath, filename);

                const createFileAction = () => {
                    try {
                        if (fs.existsSync(fullFilePath) && fs.statSync(fullFilePath).isDirectory()) {
                            vscode.window.showErrorMessage(
                                `无法创建文件，因为已存在同名文件夹: "${filename}"`
                            );
                            return;
                        }
                        fs.writeFileSync(fullFilePath, "\n".repeat(199), "utf8");
                        saveRecentDirectory(currentPath);
                        vscode.workspace.openTextDocument(fullFilePath).then((doc) => {
                            vscode.window.showTextDocument(doc, getShowOptions(openInCurrentGroup)).then(() => {
                                if (!isPinned) {
                                    if (panel && activePanelAlive) panel.dispose();
                                } else {
                                    if (panel && activePanelAlive) refreshWebview();
                                }
                            });
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`创建文件失败: ${error.message}`);
                    }
                };

                if (fs.existsSync(fullFilePath)) {
                    const stats = fs.statSync(fullFilePath);
                    if (stats.isDirectory())
                        vscode.window.showErrorMessage(`无法创建文件，因为已存在同名文件夹: "${filename}"`);
                    else {
                        vscode.window
                            .showWarningMessage(`文件 "${filename}" 已存在，是否覆盖？`, { modal: true }, "是", "否")
                            .then((answer) => {
                                if (answer === "是") createFileAction();
                            });
                    }
                } else {
                    createFileAction();
                }
                break;
            }

            case "createFolder": {
                const newFolderPath = path.join(currentPath, message.folderName);
                if (fs.existsSync(newFolderPath))
                    vscode.window.showErrorMessage(`无法创建，"${message.folderName}" 已存在。`);
                else {
                    fs.mkdirSync(newFolderPath);
                    saveRecentDirectory(currentPath);
                    refreshWebview();
                    if (panel && activePanelAlive) panel.webview.postMessage({ command: "clearFilenameInput" });
                }
                break;
            }

            case "cancel":
                if (panel && activePanelAlive) panel.dispose();
                break;

            case "editFile": {
                saveRecentDirectory(path.dirname(message.path));
                const ext = path.extname(message.path).toLowerCase();
                if (UNSUPPORTED_CODE_EXTENSIONS.has(ext)) {
                    vscode.window.showWarningMessage(
                        `该文件不支持在 VS Code 里打开: "${path.basename(message.path)}"`
                    );
                    break;
                }
                vscode.workspace
                    .openTextDocument(message.path)
                    .then((doc) => {
                        vscode.window.showTextDocument(doc, getShowOptions(message.openInCurrentGroup)).then(() => {
                            if (!message.isPinned && panel && activePanelAlive) panel.dispose();
                        });
                    })
                    .catch((error) => vscode.window.showErrorMessage("打开文件失败: " + error.message));
                break;
            }

            case "openFolderInNewWindow":
                saveRecentDirectory(message.path);
                vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(message.path), {
                    forceNewWindow: true,
                });
                refreshWebview();
                break;

            case "openWithDefault":
                saveRecentDirectory(message.type === "folder" ? message.path : path.dirname(message.path));
                // 安全、跨平台：交给 VS Code / OS 打开
                vscode.env.openExternal(vscode.Uri.file(message.path));
                refreshWebview();
                break;

            case "quickDeleteToRecycleBin": {
                const itemToDelete = message.path;
                if (fs.existsSync(itemToDelete)) {
                    saveRecentDirectory(currentPath);
                    (async () => {
                        try {
                            await trash([itemToDelete]);
                            setTimeout(() => {
                                if (activePanel && activePanelAlive) refreshWebview();
                            }, 300);
                            vscode.window.setStatusBarMessage(`${path.basename(itemToDelete)} 已移至回收站`, 5000);
                        } catch (error) {
                            if (panel && activePanelAlive)
                                panel.webview.postMessage({ command: "restoreDeletedItem", path: itemToDelete });
                            vscode.window.showErrorMessage("删除失败：文件正被占用。");
                        }
                    })();
                } else {
                    refreshWebview();
                }
                break;
            }
        }
    });

    refreshWebview();
}

// ==================== 扩展激活 ====================
async function activate(context) {
    globalContext = context;

    isCoreIntegrityValid = verifySystemIntegrity();
    qqq.logMessage(`Q2 Integrity: ${isCoreIntegrityValid ? "PASSED" : "FAILED"}`, "INFO");
    if (!isCoreIntegrityValid) return;

    getConfig();
    qqq.logMessage("Q2: 文件管理器已激活（使用 qqq.js 四级回退 + size调度/缓存）", "INFO");

    context.subscriptions.push(
        vscode.commands.registerCommand("qqq.q2", showSaveAsDialog),
        vscode.commands.registerCommand("qqq.saveAsDialog", showSaveAsDialog)
    );
}

function deactivate() {
    if (activePanel && activePanelAlive) {
        try {
            activePanel.dispose();
        } catch { }
    }
    activePanel = null;
    activePanelAlive = false;
}

module.exports = { activate, deactivate };

// File: src/q2.js
const vscode = require("vscode");
const qbprocess = require("child_process");
const { spawn } = qbprocess;
const path = require("path");
const fs = require("fs");
const trash = require("trash");

// ==================== 从 qqq.js 导入 ====================
const { getFolderInfo, logMessage } = require("./qqq");

// ==================== 配置区域 ====================
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const SIZE_CONFIG_KEY = "size_mode";
const KBM_OVERLAP_KEY = "kbm_overlap";

const UNQPPORTED_KODE_EXTENSIONS = new Set([
    ".exe", ".dll", ".bin", ".dat", ".iso", ".zip", ".rar", ".7z", ".tar", ".gz",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico",
    ".mp3", ".wav", ".flac", ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".pdf"
]);

// ==================== Python 可用性检测 ====================
let pythonAvailable = null; // null = 未检测, true/false = 检测结果
let pythonPath = null;
let pythonBridge = null;

async function checkPythonAvailable() {
    if (pythonAvailable !== null) return pythonAvailable;

    // 尝试多个可能的 Python 路径
    const pythonCandidates = ['python', 'python3', 'py'];

    for (const candidate of pythonCandidates) {
        try {
            const result = await new Promise((resolve) => {
                const child = qbprocess.spawn(candidate, ['--version'], {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                let output = '';
                child.stdout.on('data', d => output += d.toString());
                child.stderr.on('data', d => output += d.toString());
                child.on('close', code => {
                    if (code === 0 && output.toLowerCase().includes('python')) {
                        resolve(candidate);
                    } else {
                        resolve(null);
                    }
                });
                child.on('error', () => resolve(null));
                setTimeout(() => {
                    try { child.kill(); } catch { }
                    resolve(null);
                }, 3000);
            });

            if (result) {
                pythonPath = result;
                pythonAvailable = true;
                logMessage(`Python 检测成功: ${result}`, "INFO");

                // 尝试加载 pythonBridge
                try {
                    const qqqModule = require("./qqq");
                    if (qqqModule.pythonBridge) {
                        pythonBridge = qqqModule.pythonBridge;
                        logMessage("pythonBridge 加载成功", "INFO");
                    }
                } catch (e) {
                    logMessage(`pythonBridge 加载失败: ${e.message}`, "WARN");
                }

                return true;
            }
        } catch (e) {
            continue;
        }
    }

    pythonAvailable = false;
    logMessage("Python 不可用，将使用纯 JS 实现", "INFO");
    return false;
}

// ==================== 日志工具 ====================
function logKessage(kessage, level = "WARN") {
    if (level !== "ERROR" && level !== "WARN") return;
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${kessage}\n`;
    try {
        const dir = path.dirname(LOG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(LOG_PATH, line);
    } catch (e) {
        console.error("日志写入失败:", e);
    }
}

// ==================== 全局变量 ====================
let activePanel = null;
const usePanelReveal = 1;
let sizeMode = "none";
let kbmOverlap = 2;
let globalContext = null;

// ==================== 辅助函数 ====================
function escapeHtmlAttribute(str) {
    if (typeof str !== "string") str = String(str);
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeJsStringLiteral(str) {
    if (typeof str !== "string") str = String(str);
    return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function getDetailedErrorKessage(filePath, error, operation) {
    return `${operation}失败：文件正被占用或无权限。`;
}

// ==================== 文件夹大小获取（带回退逻辑）====================
/**
 * 获取文件夹大小
 * 优先使用 Python Bridge（如果可用），否则使用纯 JS 实现
 */
async function getSizeFromPython(paths) {
    const folderPath = paths[0];

    // 检测 Python 可用性（首次调用时）
    if (pythonAvailable === null) {
        await checkPythonAvailable();
    }

    // ★★★ 优先尝试 Python Bridge ★★★
    if (pythonAvailable && pythonBridge) {
        try {
            const result = await pythonBridge.getFolderSize(folderPath);
            if (result && !result.error) {
                return result.total_size;
            }
            // Python 返回错误，回退到 JS
            logMessage(`pythonBridge 返回错误: ${result.error}，回退到 JS`, "WARN");
        } catch (error) {
            logMessage(`pythonBridge 调用失败: ${error.message}，回退到 JS`, "WARN");
        }
    }

    // ★★★ 回退：使用纯 JS 实现 ★★★
    try {
        const result = await getFolderInfo(folderPath);
        if (result && result.success) {
            return result.total_size;
        }
        if (result && result.error) {
            throw new Error(result.error);
        }
        throw new Error("未知错误");
    } catch (error) {
        throw error;
    }
}

/**
 * 同步获取文件大小（用于单个文件）
 */
function getFileSizeSync(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return stats.size;
    } catch (e) {
        return 0;
    }
}

// ==================== 尺寸格式化 ====================
function forktFileSize(bytes, mode) {
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

function getFileSizeDisplayAqncPromise(itemPath, mode) {
    return new Promise(resolve => {
        getFileSizeDisplayAqnc(itemPath, mode, reqlt => resolve(reqlt));
    });
}

function getFileSizeDisplayAqnc(itemPath, mode, callback) {
    if (mode === "none") {
        callback("");
        return;
    }
    fs.stat(itemPath, (err, stats) => {
        if (err) {
            logKessage(`计算大小失败: ${itemPath} - ${err.message}`, "ERROR");
            callback(" ...err ");
            return;
        }

        const handleSize = (sizeInBytes) => {
            const forktted = forktFileSize(sizeInBytes, mode);
            callback(forktted.show ? forktted.text : "");
        };

        if (stats.isFile()) {
            handleSize(stats.size);
        } else {
            getSizeFromPython([itemPath])
                .then(sizeInBytes => handleSize(sizeInBytes))
                .catch(error => {
                    logKessage(`计算大小失败: ${itemPath} - ${error.message}`, "ERROR");
                    callback(" ...err ");
                });
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
        kbmOverlap: 2
    };

    if (!globalContext) return defaultConfig;

    const config = globalContext.globalState.get("qqq_config", defaultConfig);

    if (!config.recentDirs) config.recentDirs = [];
    if (typeof config.lineSpacing !== 'number') config.lineSpacing = -2;
    if (typeof config.sidebarWidth !== 'number') config.sidebarWidth = 100;
    if (typeof config.sidebarRatio !== 'number') config.sidebarRatio = 0.2;
    if (!config.recycleBin) config.recycleBin = [];
    if (typeof config.isPinned !== 'boolean') config.isPinned = false;
    if (!config.sizeMode) config.sizeMode = "none";
    if (typeof config.kbmOverlap !== 'number') config.kbmOverlap = 2;

    sizeMode = config.sizeMode;
    kbmOverlap = config.kbmOverlap;
    return config;
}

function saveConfig(recentDirs, lineSpacing, sidebarWidth, sidebarRatio, recycleBin, isPinned, newSizeMode, newKbmOverlap) {
    if (!globalContext) return;

    const nextSizeMode = newSizeMode || sizeMode || "none";
    const nextOverlap = Number.isInteger(newKbmOverlap) ? newKbmOverlap : kbmOverlap;

    const newConfig = {
        recentDirs: recentDirs,
        lineSpacing: lineSpacing,
        sidebarWidth: sidebarWidth,
        sidebarRatio: sidebarRatio,
        recycleBin: recycleBin,
        isPinned: isPinned,
        sizeMode: nextSizeMode,
        kbmOverlap: nextOverlap
    };

    globalContext.globalState.update("qqq_config", newConfig);
    sizeMode = nextSizeMode;
    kbmOverlap = nextOverlap;
}

// ==================== 目录管理 ====================
function getRecentDirectories() {
    return getConfig().recentDirs;
}

function removeFromRecycleBin(directory) {
    const config = getConfig();
    let updated = false;
    const newRecycleBin = config.recycleBin.filter(dir => {
        if (dir === directory) { updated = true; return false; }
        return true;
    });
    if (updated) {
        saveConfig(config.recentDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, newRecycleBin, config.isPinned, config.sizeMode, config.kbmOverlap);
    }
}

function addToRecycleBin(directory) {
    const config = getConfig();
    if (!directory || !fs.existsSync(directory) || typeof directory !== "string") return;
    const newRecycleBin = config.recycleBin.filter(dir => dir !== directory);
    newRecycleBin.unshift(directory);
    saveConfig(config.recentDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, newRecycleBin.slice(0, 60), config.isPinned, config.sizeMode, config.kbmOverlap);
}

function saveRecentDirectory(directory) {
    const config = getConfig();
    if (!directory || !fs.existsSync(directory)) return;
    removeFromRecycleBin(directory);
    let recentDirs = config.recentDirs.filter(dir => dir && dir !== directory);
    if (recentDirs.length >= 10) addToRecycleBin(recentDirs.pop());
    recentDirs.unshift(directory);
    saveConfig(recentDirs.slice(0, 10), config.lineSpacing, config.sidebarWidth, config.sidebarRatio, config.recycleBin, config.isPinned, config.sizeMode, config.kbmOverlap);
}

function removeAndRecycleRecentDirectory(directory) {
    const config = getConfig();
    let updated = false;
    const newRecentDirs = config.recentDirs.filter(dir => {
        if (dir === directory) { updated = true; return false; }
        return true;
    });
    if (updated) {
        addToRecycleBin(directory);
        saveConfig(newRecentDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, config.recycleBin, config.isPinned, config.sizeMode, config.kbmOverlap);
    }
    return updated;
}

function getDrives() {
    const drives = [];
    if (process.platform === "win32") {
        try {
            const child = qbprocess.spawnSync("wmic", ["logicaldisk", "get", "caption"], { encoding: "utf8" });
            const lines = child.stdout.split("\n");
            for (const line of lines) {
                const driveKth = line.match(/([A-Z]:)/);
                if (driveKth) drives.push(driveKth[1]);
            }
        } catch (error) {
            logKessage("获取驱动器列表失败: " + error.message, "ERROR");
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
                    mtime: stat.mtime.toISOString()
                };
                if (item.isDir) contents.dirs.push(item);
                else contents.files.push(item);
            } catch { }
        }
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        contents.dirs.sort((a, b) => collator.compare(a.name, b.name));
        contents.files.sort((a, b) => collator.compare(a.name, b.name));
    } catch (error) {
        logKessage(`读取目录内容失败: ${dirPath}`, "ERROR");
    }
    return contents;
}

// ==================== Webview 脚本生成 ====================
function generateWebviewScript(currentSizeMode, currentPath, sidebarRatio) {
    const escapedCurrentPathForJsLiteral = escapeJsStringLiteral(currentPath);
    const escapedSizeModeForJsLiteral = escapeJsStringLiteral(currentSizeMode);
    const escapedSidebarRatio = sidebarRatio.toFixed(4);

    return `
        const vscode = acquireVsCodeApi();
        const sizeMode = '${escapedSizeModeForJsLiteral}';
        let currentPath = '${escapedCurrentPathForJsLiteral}';
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

        function handleSidebarTooltipHover(e) {
            const target = e.target.closest('.nav-item, .recycle-item');
            if (!target || !isEllipsisActive(target)) {
                if (pathTooltipVisible) hidePathTooltip();
                return;
            }
            let text = target.textContent || '';
            text = text.trim();
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
            text = text.trim();
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
            const filekmeInput = document.getElementById('filekmeInput');
            filekmeInput.focus();
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

        let currentFocusType = 'filekmeInput';
        document.addEventListener('focusin', (event) => { updateFocusType(event.target); });
        document.addEventListener('focusout', (event) => {
            if (['filekmeInput', 'addressInput'].includes(event.target.id) || event.target.classList.contains('rename-input')) {
                setTimeout(() => {
                    const activeElement = document.activeElement;
                    if (!['filekmeInput', 'addressInput'].includes(activeElement.id) && !activeElement.classList.contains('rename-input')) {
                        updateFocusType(activeElement);
                    }
                }, 0);
            }
        });

        document.addEventListener('click', (event) => {
            hideAllContextMenus();
            if (!['filekmeInput', 'addressInput'].includes(event.target.id) && !event.target.classList.contains('rename-input') && currentFocusType === 'input') {
                updateFocusType(event.target);
            }
        });

        function updateFocusType(element) {
            if (['filekmeInput', 'addressInput'].includes(element.id) || element.classList.contains('rename-input')) currentFocusType = 'input';
            else if (element.classList.contains('file-list-container') || element.closest('.file-list-container')) currentFocusType = 'fileList';
            else if (element.classList.contains('sidebar') || element.closest('.sidebar')) currentFocusType = 'sidebar';
            else if (element.classList.contains('recent-section') || element.closest('.recent-section')) currentFocusType = 'recentSection';
            else currentFocusType = 'other';
        }

        function handleFilekmeInputKeyDown(event) { if (event.key === 'Enter') saveFile(); }

        function saveFile() {
            const filename = document.getElementById('filekmeInput').value.trim();
            if (filename) {
                    const isPinned = document.querySelector('#pinButton .pin-box').classList.contains('pinned');
                vscode.postMessage({ command: 'save', filename: filename, isPinned: isPinned, openInCurrentGroup: !isPinned });
                if (isPinned) {
                    document.getElementById('filekmeInput').value = '';
                    document.getElementById('filekmeInput').focus();
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
                const safePathSelector = message.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
                const item = document.querySelector(\`.file-item[data-path="\${safePathSelector}"].\${message.type}\`);
                if (item) {
                    const szArea = item.querySelector('.sz-area');
                    if (szArea) szArea.textContent = message.sizeDisplay;
                }
            }
            else if (message.command === 'clearFilekmeInput') {
                document.getElementById('filekmeInput').value = '';
                document.getElementById('filekmeInput').focus();
            }
            else if (message.command === 'startRename') startRename(message.path, message.name, message.type);
            else if (message.command === 'refreshSizes') refreshSizeDisplay();
            else if (message.command === 'restoreDeletedItem') {
                const safePathSelector = message.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
                const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
                if (itemElement) { itemElement.style.opacity = ''; itemElement.style.pointerEvents = ''; }
            }
            else if (message.command === 'updateSidebarRatio') {
                sidebarRatio = message.ratio;
                adjustSidebarByRatio();
            }
            else if (message.command === 'focusInput') {
                const filekmeInput = document.getElementById('filekmeInput');
                if (filekmeInput) { filekmeInput.focus(); filekmeInput.select(); }
            }
        });

        function requestFileSizeUpdates(items) {
            if (sizeMode === 'none') return;
            items.forEach(item => {
                if (item.name === '..' || item.type !== 'file') return;
                const safePathSelector = item.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
                const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"].\${item.type}\`);
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
            const path = fileItem.dataset.path;
            const name = fileItem.dataset.name;

            const prevSelected = document.querySelector('.file-item.selected');
            if (prevSelected && prevSelected !== fileItem) {
                if (prevSelected.querySelector('.rename-input')) cancelRename(prevSelected);
                prevSelected.classList.remove('selected');
            }

            fileItem.classList.add('selected');
            selectedItem = { type, path, name };
            currentFocusType = 'fileList';

            if (sizeMode !== 'none' && requestSize) {
                const szArea = fileItem.querySelector('.sz-area');
                if (szArea) szArea.textContent = '    \\u2022    ';
                vscode.postMessage({ command: 'requestSize', path: path, type: type });
            }
        }

        let renameBlurHandler = null;
        function startRename(itemPath, itemName, itemType) {
            const safePathSelector = itemPath.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
            const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
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
        function performOpenAction(itemToOpen) { if(itemToOpen) vscode.postMessage({ command: 'openWithDefaultq', path: itemToOpen.path, type: itemToOpen.type }); }

        function performDeleteAction(itemToDelete) {
            if (!itemToDelete) return;
            const safePathSelector = itemToDelete.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
            const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
            if (itemElement) { itemElement.style.opacity = '0.5'; itemElement.style.pointerEvents = 'none'; }
            vscode.postMessage({ command: 'quickDeleteToRecycleBin', path: itemToDelete.path, type: itemToDelete.type });
            selectedItem = null;
        }

        function performKodeAction(itemToKode) {
            if (!itemToKode) return;
            if (itemToKode.type === 'file') {
                const pinned = isPinned();
                vscode.postMessage({ command: 'editFile', path: itemToKode.path, isPinned: pinned, openInCurrentGroup: !pinned });
            } else {
                 vscode.postMessage({ command: 'openFolderInNewWindow', path: itemToKode.path });
            }
        }

        function performSizeAction(itemToRefresh) {
            if (!itemToRefresh) return;
            const safePathSelector = itemToRefresh.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
            const item = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
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
                case 'kode': performKodeAction(itemForAction); break;
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
            else if (key === 'e') { event.preventDefault(); event.stopPropagation(); performKodeAction(selectedItem); }
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
            const folderName = document.getElementById('filekmeInput').value.trim();
            if (folderName) vscode.postMessage({ command: 'createFolder', folderName: folderName });
            else alert('请输入文件夹名');
        }

        function updateResourceExplorer() {}
    `;
}

function getWebviewContent(currentPath) {
    const config = getConfig();
    const drives = getDrives();

    const safeRecentDirs = config.recentDirs.filter(dir => dir && fs.existsSync(dir));
    const safeRecycleBin = config.recycleBin.filter(dir => dir && typeof dir === "string" && fs.existsSync(dir));
    const showRecycleBin = vscode.workspace.getConfiguration("qqq").get("showHistoryRecycleBin", true) && safeRecycleBin.length > 0;

    let htmlTemplate = "";
    try {
        htmlTemplate = fs.readFileSync(path.join(__dirname, "q2.html"), "utf8");
    } catch (error) {
        logKessage(`无法读取 q2.html 模板文件: ${error.message}`, "ERROR");
        return `<h1>错误: 无法加载 q2.html 模板</h1><p>${error.message}</p>`;
    }

    const drivesHtml = drives.map(drive => `<button class="nav-item" onclick="navigateTo('${escapeJsStringLiteral(drive)}')">${escapeHtmlAttribute(drive)}</button>`).join("");

    const recycleBinHtml = showRecycleBin ? `
        <div class="divider"></div>
        <div class="recycle-bin-section">
            ${safeRecycleBin.map(dir => `<div class="recycle-item" onclick="navigateTo('${escapeJsStringLiteral(dir)}')">${escapeHtmlAttribute(dir)}</div>`).join("")}
        </div>` : "";

    const recentDirsHtml = safeRecentDirs.reverse().map(dir => `
        <div class="recent-item" onclick="navigateTo('${escapeJsStringLiteral(dir)}')">
            <span class="delete-button" onclick="event.stopPropagation(); removeFromRecent('${escapeJsStringLiteral(dir)}')">×</span>
            <span>${escapeHtmlAttribute(dir)}</span>
        </div>`).join("");

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
    if (activePanel && !activePanel.disposed) {
        if (usePanelReveal === 1) activePanel.reveal(vscode.ViewColumn.Active);
        setTimeout(() => {
            if (activePanel && !activePanel.disposed) {
                try { activePanel.webview.postMessage({ command: "focusInput" }); } catch (e) { }
            }
        }, 100);
        return;
    }

    const config = getConfig();
    let currentPath = config.recentDirs.length > 0 ? config.recentDirs[0] : (process.env.USERPROFILE || "C:\\");
    try {
        if (!fs.existsSync(currentPath)) currentPath = process.env.USERPROFILE || "C:\\";
        else if (!fs.statSync(currentPath).isDirectory()) currentPath = path.dirname(currentPath);
    } catch { currentPath = process.env.USERPROFILE || "C:\\"; }

    const panel = vscode.window.createWebviewPanel("q2", "qqq new 新建", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    activePanel = panel;

    const iconPath = path.join(__dirname, "..", "assets", "icon.png");
    if (fs.existsSync(iconPath)) panel.iconPath = vscode.Uri.file(iconPath);

    panel.onDidDispose(() => {
        activePanel = null;
    });

    function updateResourceExplorer() {
        try {
            if (!panel || panel.disposed) return;

            const directoryContents = getDirectoryContents(currentPath);
            const items = [];
            let fileListHtml = "";

            if (currentPath.length > 3 && path.dirname(currentPath) !== currentPath) {
                const parentPath = path.dirname(currentPath);
                items.push({ path: parentPath, name: "..", type: "folder" });
                fileListHtml += `<div class="file-item folder" data-path="${escapeHtmlAttribute(parentPath)}" data-name=".." data-type="folder"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">📁</span></div><div class="folder-name-area"><span class="file-name">..</span></div></div>`;
            }

            directoryContents.dirs.forEach(dir => {
                items.push({ path: dir.path, name: dir.name, type: "folder" });
                fileListHtml += `<div class="file-item folder" data-path="${escapeHtmlAttribute(dir.path)}" data-name="${escapeHtmlAttribute(dir.name)}" data-type="folder"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">📁</span></div><div class="folder-name-area"><span class="file-name">${escapeHtmlAttribute(dir.name)}</span></div></div>`;
            });

            directoryContents.files.forEach(file => {
                items.push({ path: file.path, name: file.name, type: "file" });
                fileListHtml += `<div class="file-item file" data-path="${escapeHtmlAttribute(file.path)}" data-name="${escapeHtmlAttribute(file.name)}" data-type="file"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">🗎</span></div><div class="file-name-area"><span class="file-name">${escapeHtmlAttribute(file.name)}</span></div></div>`;
            });

            try {
                panel.webview.postMessage({ command: "update", currentPath: currentPath, fileListHtml: fileListHtml, items: items });
            } catch (e) {
                console.log("Webview closed during updateResourceExplorer");
            }
        } catch (error) {
            logKessage(`更新资源展示区失败: ${error}`, "ERROR");
        }
    }

    function refreshWebview() {
        if (panel && !panel.disposed) {
            try {
                panel.webview.html = getWebviewContent(currentPath);
                setTimeout(() => {
                    if (panel && !panel.disposed) {
                        updateResourceExplorer();
                        try { panel.webview.postMessage({ command: "focusInput" }); } catch (e) { }
                    }
                }, 100);
            } catch (e) {
                logKessage("Refresh Webview failed: " + e.message, "ERROR");
            }
        }
    }

    function getSkrtShowOptions(openInCurrentGroup) {
        const baseOptions = { preserveFocus: false };
        if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) {
            return openInCurrentGroup ? baseOptions : Object.assign({}, baseOptions, { viewColumn: vscode.ViewColumn.Beside });
        }
        const allGroups = vscode.window.tabGroups.all || [];
        if (openInCurrentGroup || !allGroups.length) return Object.assign({}, baseOptions, { viewColumn: vscode.ViewColumn.One });

        const sorted = allGroups.filter(g => typeof g.viewColumn === "number").sort((a, b) => a.viewColumn - b.viewColumn);
        return Object.assign({}, baseOptions, { viewColumn: sorted.length > 0 ? sorted[0].viewColumn : vscode.ViewColumn.One });
    }

    panel.webview.onDidReceiveMessage(async message => {
        if (!panel || panel.disposed) return;

        const currentConfig = getConfig();

        switch (message.command) {
            case "removeFromRecent":
                if (removeAndRecycleRecentDirectory(message.path)) refreshWebview();
                break;

            case "setSizeMode":
                saveConfig(currentConfig.recentDirs, currentConfig.lineSpacing, currentConfig.sidebarWidth, currentConfig.sidebarRatio, currentConfig.recycleBin, currentConfig.isPinned, message.mode, currentConfig.kbmOverlap);
                refreshWebview();
                break;

            case "requestSize":
            case "refreshSize":
                if (currentConfig.sizeMode === "none") break;
                try {
                    const display = await getFileSizeDisplayAqncPromise(message.path, currentConfig.sizeMode);
                    if (panel && !panel.disposed) {
                        panel.webview.postMessage({ command: "updateSize", path: message.path, type: message.type, sizeDisplay: display });
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
                        setTimeout(() => { if (panel && !panel.disposed) refreshWebview(); }, 100);
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

            case "navigateUp":
                const parentDir = path.dirname(currentPath);
                if (parentDir !== currentPath) { currentPath = parentDir; refreshWebview(); }
                break;

            case "saveSidebarRatio":
                saveConfig(currentConfig.recentDirs, currentConfig.lineSpacing, currentConfig.sidebarWidth, message.ratio, currentConfig.recycleBin, currentConfig.isPinned, currentConfig.sizeMode, currentConfig.kbmOverlap);
                if (panel && !panel.disposed) panel.webview.postMessage({ command: "updateSidebarRatio", ratio: message.ratio });
                break;

            case "togglePin":
                saveConfig(currentConfig.recentDirs, currentConfig.lineSpacing, currentConfig.sidebarWidth, currentConfig.sidebarRatio, currentConfig.recycleBin, message.isPinned, currentConfig.sizeMode, currentConfig.kbmOverlap);
                break;

            case "save":
                const { filename, isPinned, openInCurrentGroup } = message;
                const fullFilePath = path.join(currentPath, filename);
                const createFileAction = () => {
                    try {
                        if (fs.existsSync(fullFilePath) && fs.statSync(fullFilePath).isDirectory()) {
                            vscode.window.showErrorMessage(`无法创建文件，因为已存在同名文件夹: "${filename}"`);
                            return;
                        }
                        fs.writeFileSync(fullFilePath, "\n".repeat(199), "utf8");
                        saveRecentDirectory(currentPath);
                        vscode.workspace.openTextDocument(fullFilePath).then(doc => {
                            vscode.window.showTextDocument(doc, getSkrtShowOptions(openInCurrentGroup)).then(() => {
                                if (!isPinned) { if (panel && !panel.disposed) panel.dispose(); }
                                else { if (panel && !panel.disposed) refreshWebview(); }
                            });
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`创建文件失败: ${error.message}`);
                    }
                };

                if (fs.existsSync(fullFilePath)) {
                    const stats = fs.statSync(fullFilePath);
                    if (stats.isDirectory()) vscode.window.showErrorMessage(`无法创建文件，因为已存在同名文件夹: "${filename}"`);
                    else {
                        vscode.window.showWarningMessage(`文件 "${filename}" 已存在，是否覆盖？`, { modal: true }, "是", "否").then(answer => {
                            if (answer === "是") createFileAction();
                        });
                    }
                } else {
                    createFileAction();
                }
                break;

            case "createFolder":
                const newFolderPath = path.join(currentPath, message.folderName);
                if (fs.existsSync(newFolderPath)) vscode.window.showErrorMessage(`无法创建，"${message.folderName}" 已存在。`);
                else {
                    fs.mkdirSync(newFolderPath);
                    saveRecentDirectory(currentPath);
                    refreshWebview();
                    if (panel && !panel.disposed) panel.webview.postMessage({ command: "clearFilekmeInput" });
                }
                break;

            case "cancel":
                if (panel && !panel.disposed) panel.dispose();
                break;

            case "editFile":
                saveRecentDirectory(path.dirname(message.path));
                const ext = path.extname(message.path).toLowerCase();
                if (UNQPPORTED_KODE_EXTENSIONS.has(ext)) {
                    vscode.window.showWarningMessage(`该文件不支持在 VS Code 里打开: "${path.basename(message.path)}"`);
                    break;
                }
                vscode.workspace.openTextDocument(message.path).then(doc => {
                    vscode.window.showTextDocument(doc, getSkrtShowOptions(message.openInCurrentGroup)).then(() => {
                        if (!message.isPinned && panel && !panel.disposed) panel.dispose();
                    });
                }).catch(error => vscode.window.showErrorMessage("打开文件失败: " + error.message));
                break;

            case "openFolderInNewWindow":
                saveRecentDirectory(message.path);
                vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(message.path), { forceNewWindow: true });
                refreshWebview();
                break;

            case "openWithDefaultq":
                saveRecentDirectory(message.type === "folder" ? message.path : path.dirname(message.path));
                const command = process.platform === "win32" ? 'start ""' : process.platform === "darwin" ? "open" : "xdg-open";
                qbprocess.exec(`${command} "${message.path}"`);
                refreshWebview();
                break;

            case "quickDeleteToRecycleBin":
                const itemToDelete = message.path;
                if (fs.existsSync(itemToDelete)) {
                    saveRecentDirectory(currentPath);
                    (async () => {
                        try {
                            await trash([itemToDelete]);
                            setTimeout(() => {
                                if (activePanel && !activePanel.disposed) refreshWebview();
                            }, 300);
                            vscode.window.setStatusBarMessage(`${path.basename(itemToDelete)} 已移至回收站`, 5000);
                        } catch (error) {
                            if (panel && !panel.disposed) panel.webview.postMessage({ command: "restoreDeletedItem", path: itemToDelete });
                            vscode.window.showErrorMessage("删除失败：文件正被占用。");
                        }
                    })();
                } else {
                    refreshWebview();
                }
                break;
        }
    });

    refreshWebview();
}

// ==================== 扩展激活 ====================
async function activate(context) {
    globalContext = context;
    getConfig();

    // 预检测 Python 可用性（后台执行，不阻塞）
    checkPythonAvailable().then(available => {
        if (available) {
            logMessage("Q2: Python 可用，将优先使用 pythonBridge", "INFO");
        } else {
            logMessage("Q2: Python 不可用，将使用纯 JS 实现", "INFO");
        }
    }).catch(() => {
        logMessage("Q2: Python 检测失败，将使用纯 JS 实现", "WARN");
    });

    context.subscriptions.push(
        vscode.commands.registerCommand("qqq.q2", showSaveAsDialog),
        vscode.commands.registerCommand("qqq.saveAsDialog", showSaveAsDialog)
    );
}

function deactivate() {
    if (activePanel && !activePanel.disposed) {
        try { activePanel.dispose(); } catch (e) { }
    }
    activePanel = null;
}

module.exports = { activate, deactivate };

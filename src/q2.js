// File: src/q2.js
// ★★★ 文件管理器：Webview 界面 + 使用 geq().js 四级回退 + 防惊群尺寸调度/缓存 ★★★
// 适配：匹配最新 qqq IO 引擎路径逻辑（跨平台 normalize + 绝对路径保留 + canonical 去重）
// 说明：本文件内置 normalize/resolve/canonical，若 geq().js 导出同名函数会自动优先使用 qqq 的实现

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const h = require("./h");

// ★★★ 粘贴功能核心模块：从 global.js 导入事务管理、任务计数、剪贴板快照等 ★★★
const { TransactionManager, TaskCounter, TaskMessage, wq, savePasteStats } = require("./global");

// ==================== 从 geq().js 导入核心接口 ====================
// 延迟加载 qqq 以避免循环依赖
let qqq = null;
function geq() {
  if (!qqq) {
    try {
      qqq = require("./qqq");
    } catch (e) {
      global.logMessage(`Failed to lazy-load qqq in q2: ${e.message}`, "ERROR");
    }
  }
  return qqq;
}
const global = require("./global");


// ==================== 配置常量 ====================

// 并发控制
const MAX_CONCURRENT_TASKS = 6;

const UNSUPPORTED_CODE_EXTENSIONS = global.NON_TEXT_EXTS;

// ==================== 全局变量 ====================
let activePanel = null;
let activePanelAlive = false;
let currentWatcher = null; // 用于监听当前目录变化
const usePanelReveal = 1;


let globalContext = null;

// 全局刷新函数引用（由 showSaveAsDialog 设置）
let globalRefreshWebview = null;

let cachedInMemoryConfig = null; // 增加内存缓存，防止 globalState 防抖导致的读取延迟/冲突
let lastResourceExplorerPath = ""; // 记录上一次更新资源展示区时的路径，用于清除尺寸缓存

// ==================== IO / Path：匹配最新引擎逻辑（关键） ====================

function _stripDocJunk(s) {
  return geq()._stripDocJunk(s);
}

function _getSystemDriveRoot() {
  return geq()._getSystemDriveRoot();
}

function normalizeNavPath(rawPath) {
  return geq().normalizeNavPath(rawPath);
}

function resolveNavPath(rawPath, baseDir) {
  return geq().resolveNavPath(rawPath, baseDir);
}

function canonicalizeExistingPath(p) {
  return geq().canonicalizeExistingPath(p);
}

function cacheKeyForPath(p) {
  return geq().cacheKeyForPath(p);
}

let activeAbortController = new AbortController();

const globalScheduler = new global.TaskScheduler(MAX_CONCURRENT_TASKS);

// ==================== s 请求：获取文件/文件夹 size ====================
// 用于点击 sz 区时强制获取 size（文件夹需要递归计算）
async function getSizeForSRequest(itemPath, isFolder) {
  const canon = canonicalizeExistingPath(itemPath);

  if (!isFolder) {
    // 文件：直接获取 size
    try {
      const stats = await fs.promises.stat(canon);
      return Number(stats.size) || 0;
    } catch {
      return 0;
    }
  }

  // 文件夹：通过 qqq 底座高效获取递归总大小
  try {
    const result = await geq().getFolderInfo(canon);
    if (result && result.success) {
      return Number(result.total_size) || 0;
    }
    return 0;
  } catch (error) {
    global.logMessage(`s请求获取文件夹大小失败: ${canon} - ${error.message}`, "ERROR");
    return 0;
  }
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

// ==================== 文件大小格式化 ====================
function getFileSizeSync(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

// ==================== 尺寸格式化 ====================
function formatFileSize(bytes) {
  // 只显示字节数，添加千位分隔符
  const formatted = bytes.toLocaleString();
  return formatted;
}

function formatDateTime(date) {
  // 格式化日期时间：YYYY-MM-DD HH:mm（完整年份）
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";  // 无效日期
  const year = d.getFullYear();  // 完整 4 位年份
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function getFileDisplayAsync(itemPath, displayMode, signal = null) {
  const canon = canonicalizeExistingPath(itemPath);
  const key = cacheKeyForPath(canon);

  return globalScheduler.schedule(`sizeDisplay:${key}`, async () => {
    if (signal && signal.aborted) return "";

    try {
      // 检查 signal
      if (signal && signal.aborted) return "";
      const stats = await fs.promises.stat(canon);
      if (signal && signal.aborted) return "";

      // 根据显示模式返回不同的内容，末尾加一个空格作为简易留白
      if (displayMode === "nothing") {
        return "";
      } else if (displayMode === "size") {
        // size 模式：只显示文件大小，文件夹不参与
        if (stats.isFile()) {
          const sz = Number(stats.size) || 0;
          return formatFileSize(sz) + " ";
        } else {
          // 文件夹不显示尺寸
          return "";
        }
      } else if (displayMode === "ctime") {
        return formatDateTime(stats.birthtime) + " ";
      } else if (displayMode === "mtime") {
        return formatDateTime(stats.mtime) + " ";
      }

      return "";
    } catch (err) {
      global.logMessage(`获取文件信息失败: ${canon} - ${err.message}`, "ERROR");
      return " ...err ";
    }
  });
}

// 保持向后兼容的别名
function getFileSizeDisplayAsync(itemPath, signal = null) {
  const config = getConfig();
  return getFileDisplayAsync(itemPath, config.szDisplayMode, signal);
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
    szDisplayMode: "nothing",
    sortBy: "name",
  };

  if (!globalContext) return defaultConfig;

  // 优先使用内存缓存，确保读取到的是最新的（即便还在 1s 的写入防抖期内）
  if (cachedInMemoryConfig) {
    return cachedInMemoryConfig;
  }

  // ★ 终极最优解：容错性配置加载，防止 globalState 返回非预期值
  const storedConfig = globalContext.globalState.get("qqq_config") || {};
  const config = { ...defaultConfig, ...storedConfig };

  // 确保数组字段存在
  if (!Array.isArray(config.recentDirs)) config.recentDirs = [];
  if (!Array.isArray(config.recycleBin)) config.recycleBin = [];
  if (typeof config.lineSpacing !== "number") config.lineSpacing = -2;
  if (typeof config.sidebarWidth !== "number") config.sidebarWidth = 100;
  if (typeof config.sidebarRatio !== "number") config.sidebarRatio = 0.2;
  if (typeof config.isPinned !== "boolean") config.isPinned = false;

  // 读取全局设置（从 VS Code 配置中读取）
  try {
    const globalConfig = vscode.workspace.getConfiguration("qqq");
    const szDisplayMode = globalConfig.get("szDisplayMode", "nothing");
    const sortBy = globalConfig.get("sortBy", "name");
    const autoWatchChanges = globalConfig.get("autoWatchChanges", false);

    // 验证并设置有效值
    const validDisplayModes = ["nothing", "size", "ctime", "mtime"];
    const validSortBy = ["name", "size", "ctime", "mtime"];

    config.szDisplayMode = validDisplayModes.includes(szDisplayMode) ? szDisplayMode : "nothing";
    config.sortBy = validSortBy.includes(sortBy) ? sortBy : "name";
    config.autoWatchChanges = autoWatchChanges === true;
  } catch (e) {
    // 如果读取失败，使用默认值
    config.szDisplayMode = "nothing";
    config.sortBy = "name";
    config.autoWatchChanges = false;
  }

  cachedInMemoryConfig = config;
  return config;
}

let saveConfigTimer = null;

function saveConfig(
  recentDirs,
  lineSpacing,
  sidebarWidth,
  sidebarRatio,
  recycleBin,
  isPinned
) {
  if (!globalContext) return;

  const newConfig = {
    recentDirs,
    lineSpacing,
    sidebarWidth,
    sidebarRatio,
    recycleBin,
    isPinned,
  };

  // ★ 关键修复：保留全局设置字段（szDisplayMode, sortBy, autoWatchChanges）
  // 这些字段由 VS Code 配置管理，不应被覆盖
  if (cachedInMemoryConfig) {
    newConfig.szDisplayMode = cachedInMemoryConfig.szDisplayMode;
    newConfig.sortBy = cachedInMemoryConfig.sortBy;
    newConfig.autoWatchChanges = cachedInMemoryConfig.autoWatchChanges;
  }

  // 立即更新内存状态，确保后续读取（如 refreshWebview）拿到的是正确的
  cachedInMemoryConfig = newConfig;

  // 性能优化：防抖处理。频繁切换目录时，不要同步更新 globalState
  if (saveConfigTimer) clearTimeout(saveConfigTimer);
  saveConfigTimer = setTimeout(() => {
    try {
      // 保存时排除全局设置字段（它们由 VS Code 配置管理）
      const configToSave = {
        recentDirs: newConfig.recentDirs,
        lineSpacing: newConfig.lineSpacing,
        sidebarWidth: newConfig.sidebarWidth,
        sidebarRatio: newConfig.sidebarRatio,
        recycleBin: newConfig.recycleBin,
        isPinned: newConfig.isPinned,
      };
      globalContext.globalState.update("qqq_config", configToSave);
      saveConfigTimer = null;
    } catch (e) { }
  }, 1000);
}

// ==================== 目录管理 ====================
function removeFromRecycleBin(directory) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(directory);
  let updated = false;

  const newRecycleBin = (config.recycleBin || []).filter((dir) => {
    const c = canonicalizeExistingPath(dir);
    if (c && canon && cacheKeyForPath(c) === cacheKeyForPath(canon)) {
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
      config.isPinned
    );
  }
}

function addToRecycleBin(directory) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(directory);
  if (!canon || !fs.existsSync(canon) || typeof canon !== "string") return;

  const key = cacheKeyForPath(canon);
  const newRecycleBin = (config.recycleBin || []).filter((dir) => cacheKeyForPath(dir) !== key);
  newRecycleBin.unshift(canon);

  saveConfig(
    config.recentDirs,
    config.lineSpacing,
    config.sidebarWidth,
    config.sidebarRatio,
    newRecycleBin.slice(0, 60),
    config.isPinned
  );
}

function saveRecentDirectory(directory) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(directory);
  if (!canon || !fs.existsSync(canon)) return;

  removeFromRecycleBin(canon);

  const key = cacheKeyForPath(canon);
  let recentDirs = (config.recentDirs || []).filter((dir) => dir && cacheKeyForPath(dir) !== key);

  if (recentDirs.length >= 10) addToRecycleBin(recentDirs.pop());
  recentDirs.unshift(canon);

  saveConfig(
    recentDirs.slice(0, 10),
    config.lineSpacing,
    config.sidebarWidth,
    config.sidebarRatio,
    config.recycleBin,
    config.isPinned
  );
}

function removeAndRecycleRecentDirectory(directory) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(directory);
  const key = cacheKeyForPath(canon);

  let updated = false;
  const newRecentDirs = (config.recentDirs || []).filter((dir) => {
    if (cacheKeyForPath(dir) === key) {
      updated = true;
      return false;
    }
    return true;
  });

  if (updated) {
    addToRecycleBin(canon);
    saveConfig(
      newRecentDirs,
      config.lineSpacing,
      config.sidebarWidth,
      config.sidebarRatio,
      config.recycleBin,
      config.isPinned
    );
  }
  return updated;
}

let cachedDrives = null;
let lastDrivesQueryTime = 0;

function getDrives() {
  const now = Date.now();
  // 缓存 5 分钟，盘符不会频繁变动
  if (cachedDrives && (now - lastDrivesQueryTime < 300000)) {
    return cachedDrives;
  }

  const drives = [];
  if (process.platform === "win32") {
    // 性能优化：直接使用 fs.existsSync 穷举 A-Z。
    // 这比 spawn powershell 快 100 倍且不阻塞 Extension Host 主线程。
    for (let i = 65; i <= 90; i++) {
      try {
        const drive = String.fromCharCode(i) + ":\\";
        if (fs.existsSync(drive)) {
          drives.push(drive);
        }
      } catch (e) { }
    }
    if (drives.length === 0) drives.push("C:\\");
  } else {
    drives.push("/");
  }

  cachedDrives = drives;
  lastDrivesQueryTime = now;
  return drives;
}

async function getDirectoryContents(dirPath, sortBy = "name", szDisplayMode = "nothing") {
  const contents = { dirs: [], files: [] };
  const canonDir = canonicalizeExistingPath(dirPath);

  // 判断是否需要预获取 stats 信息
  const needStats = sortBy !== "name" || szDisplayMode !== "nothing";

  try {
    // 异步性能优化：改用 VS Code 原生异步接口，不阻塞 Extension Host，且完美支持跨平台/远程路径
    const uri = vscode.Uri.file(canonDir);
    const entries = await vscode.workspace.fs.readDirectory(uri);

    for (const [name, type] of entries) {
      const isDir = type === vscode.FileType.Directory;
      const isFile = type === vscode.FileType.File;

      if (!isDir && !isFile) continue;

      const itemPath = path.join(canonDir, name);
      const item = {
        name: name,
        path: itemPath,
        isDir: isDir
      };

      // 预获取 stats 用于排序和 sz-area 显示
      if (needStats) {
        try {
          const stats = fs.statSync(itemPath);
          item.size = stats.size;
          item.ctime = stats.birthtime;
          item.mtime = stats.mtime;
        } catch (e) {
          item.size = 0;
          item.ctime = new Date(0);
          item.mtime = new Date(0);
        }
      }

      if (isDir) contents.dirs.push(item);
      else contents.files.push(item);
    }

    // 根据 sortBy 参数进行排序
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

    if (sortBy === "name") {
      // name: 文件夹在上，按名称排序
      contents.dirs.sort((a, b) => collator.compare(a.name, b.name));
      contents.files.sort((a, b) => collator.compare(a.name, b.name));
    } else if (sortBy === "size") {
      // size: 文件夹在上（按名称排序），文件在下（按大小倒序，大的在上）
      contents.dirs.sort((a, b) => collator.compare(a.name, b.name));
      contents.files.sort((a, b) => (b.size || 0) - (a.size || 0));
    } else if (sortBy === "ctime") {
      // ctime: 文件夹在上（按时间倒序，新的在上），文件在下（按时间倒序）
      contents.dirs.sort((a, b) => new Date(b.ctime || 0) - new Date(a.ctime || 0));
      contents.files.sort((a, b) => new Date(b.ctime || 0) - new Date(a.ctime || 0));
    } else if (sortBy === "mtime") {
      // mtime: 文件夹在上（按时间倒序，新的在上），文件在下（按时间倒序）
      contents.dirs.sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
      contents.files.sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
    }
  } catch (error) {
    global.logMessage(`读取目录内容失败: ${canonDir} - ${error.message}`, "ERROR");
  }

  return contents;
}

// ==================== Webview 脚本生成 ====================
function generateWebviewScript(currentPath, sidebarRatio) {
  const escapedCurrentPath = escapeJsStringLiteral(currentPath);
  const escapedSidebarRatio = Number(sidebarRatio || 0.2).toFixed(4);

  return `
const vscode = acquireVsCodeApi();

let currentPath = '${escapedCurrentPath}';
let sidebarRatio = ${escapedSidebarRatio};

let sessionSizeCache = new Map(); // path -> sizeDisplay ( sticky session cache )
let currentSizeMode = 'nothing'; // 当前 sz 区显示模式

let resizeObserver = null;
const MIN_RESPONSIVE_WIDTH = 240;
const MIN_TAG_WIDTH = 170;
const PIN_HIDE_WIDTH = 360;
let baseRecentHeight = 0;

let pathTooltipEl = null;
let pathTooltipVisible = false;

function ensurePathTooltip(){
  if (pathTooltipEl) return;
  pathTooltipEl = document.createElement('div');
  pathTooltipEl.id = 'pathTooltip';
  pathTooltipEl.className = 'path-tooltip';
  pathTooltipEl.style.display = 'none';
  document.body.appendChild(pathTooltipEl);
}

function hidePathTooltip(){
  if (pathTooltipEl) pathTooltipEl.style.display = 'none';
  pathTooltipVisible = false;
}

function showPathTooltip(text, clientX, clientY){
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

function isEllipsisActive(element){
  if (!element) return false;
  return element.scrollWidth > element.clientWidth + 1;
}

// 关键修复：不要用 querySelector attribute 拼接路径（特殊字符会炸）
function findItemElementByPath(p, type){
  const all = document.querySelectorAll('.file-item');
  for (const el of all) {
    if (el && el.dataset && el.dataset.path === p) {
      if (!type) return el;
      if ((el.dataset.type || '') === type) return el;
    }
  }
  return null;
}

function handleSidebarTooltipHover(e){
  const target = e.target.closest('.nav-item, .recycle-item');
  if (!target || !isEllipsisActive(target)) {
    if (pathTooltipVisible) hidePathTooltip();
    return;
  }
  const text = (target.textContent || '').trim();
  if (text) showPathTooltip(text, e.clientX, e.clientY);
}

function handleKyTooltipHover(e){
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

function calculateAndAdjustScroll(){
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

function checkAndApplyResponsive(){
  const container = document.querySelector('.container');
  if (!container) return;

  const currentWidth = container.clientWidth;
  const footer = document.querySelector('.footer');
  const pinContainer = document.getElementById('pinButton');
  const saveButton = footer ? footer.querySelector('.save-button') : null;
  const createFolderBtn = footer ? footer.querySelector('.cancel-button') : null;

  if (pinContainer) pinContainer.style.display = (currentWidth < PIN_HIDE_WIDTH) ? 'none' : 'block';

  if (currentWidth < MIN_RESPONSIVE_WIDTH) {
    if (saveButton) saveButton.style.display = 'none';
    if (createFolderBtn) createFolderBtn.style.display = 'block';
    if (footer) footer.classList.add('responsive-narrow');
  } else {
    if (saveButton) saveButton.style.display = 'block';
    if (createFolderBtn) createFolderBtn.style.display = 'block';
    if (footer) footer.classList.remove('responsive-narrow');
  }

  if (currentWidth < MIN_TAG_WIDTH) {
    if (createFolderBtn) createFolderBtn.style.display = 'none';
    if (footer) footer.classList.add('responsive-extreme');
  } else {
    if (footer) footer.classList.remove('responsive-extreme');
  }

  setTimeout(calculateAndAdjustScroll, 50);
}

function adjustSidebarByRatio(){
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

function hideAllContextMenus(){
  const a = document.getElementById('itemContextMenu');
  const b = document.getElementById('emptyContextMenu');
  if (a) a.style.display = 'none';
  if (b) b.style.display = 'none';
}

function navigateTo(p){ vscode.postMessage({ command: 'navigate', path: p }); }
function navigateIntoFolder(p){ vscode.postMessage({ command: 'navigate', path: p }); }

function updateAddressDisplay(p) {
  const display = document.getElementById('addressDisplay');
  if (!display) return;
  if (!p) { display.innerHTML = ''; return; }
  const parts = p.split(/([\\\\\/])/);
  display.innerHTML = parts.map(part => {
    if (part === '\\\\' || part === '/') {
      return '<span class="path-sep">' + part + '</span>';
    }
    return '<span>' + part + '</span>';
  }).join('');
}

function removeFromRecent(p){ vscode.postMessage({ command: 'removeFromRecent', path: p }); }
function cancel(){ vscode.postMessage({ command: 'cancel' }); }

function togglePin(){
  const pinBox = document.querySelector('#pinButton .pin-box');
  const pinCheckbox = document.querySelector('#pinButton .pin-checkbox');
  if (!pinBox || !pinCheckbox) return;

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

function isPinned(){
  return !!document.querySelector('#pinButton .pin-box.pinned');
}

function saveFile(){
  const filenameInput = document.getElementById('filenameInput');
  if (!filenameInput) return;
  const filename = (filenameInput.value || '').trim();
  if (!filename) { alert('请键入文件名'); return; }

  const pinned = isPinned();
  vscode.postMessage({ command: 'save', filename, isPinned: pinned, openInCurrentGroup: !pinned });

  if (pinned) {
    filenameInput.value = '';
    filenameInput.focus();
  }
}

function createFolder(){
  const filenameInput = document.getElementById('filenameInput');
  if (!filenameInput) return;
  const folderName = (filenameInput.value || '').trim();
  if (!folderName) { alert('请键入文件夹名'); return; }
  vscode.postMessage({ command: 'createFolder', folderName });
}



// ===== 选择/重命名 =====
let selectedItem = null;
let selectedItems = []; // 存储多选项目
let lastSelectedItem = null; // 跟踪上一次选择的项目，用于Shift连续选择
let currentFocusType = 'filenameInput';

function updateFocusType(element){
  if (!element) { currentFocusType = 'other'; return; }
  if (['filenameInput', 'addressInput'].includes(element.id) || element.classList.contains('rename-input')) currentFocusType = 'input';
  else if (element.classList.contains('file-list-container') || element.closest('.file-list-container')) currentFocusType = 'fileList';
  else if (element.classList.contains('sidebar') || element.closest('.sidebar')) currentFocusType = 'sidebar';
  else if (element.classList.contains('recent-section') || element.closest('.recent-section')) currentFocusType = 'recentSection';
  else currentFocusType = 'other';
}

function selectFileItem(fileItem, requestSize, shiftPressed = false){
  if (!fileItem) return;

  // 关键：选择项目时，如果当前焦点在输入框，则强制失去焦点，以便热键生效
  if (isInputFocused()) {
    document.activeElement.blur();
  }

  const type = fileItem.dataset.type;
  const p = fileItem.dataset.path;
  const name = fileItem.dataset.name;

  if (!shiftPressed) {
    // 非Shift键点击：清除之前的选择
    const prevSelectedItems = document.querySelectorAll('.file-item.selected');
    prevSelectedItems.forEach(item => {
      if (item.querySelector('.rename-input')) cancelRename(item);
      item.classList.remove('selected');
    });
    selectedItems = [];
    fileItem.classList.add('selected');
    selectedItem = { type, path: p, name };
    selectedItems.push(selectedItem);
    lastSelectedItem = fileItem; // 更新上一次选择的项目
  } else {
    // Shift键点击：连续选择从lastSelectedItem到当前项
    if (lastSelectedItem) {
      // 获取所有文件项
      const allFileItems = Array.from(document.querySelectorAll('.file-item'));

      // 找到起点和终点的索引
      const startIndex = allFileItems.indexOf(lastSelectedItem);
      const endIndex = allFileItems.indexOf(fileItem);

      if (startIndex !== -1 && endIndex !== -1) {
        // 清除之前的选择
        const prevSelectedItems = document.querySelectorAll('.file-item.selected');
        prevSelectedItems.forEach(item => {
          if (item.querySelector('.rename-input')) cancelRename(item);
          item.classList.remove('selected');
        });
        selectedItems = [];

        // 确定选择范围
        const start = Math.min(startIndex, endIndex);
        const end = Math.max(startIndex, endIndex);

        // 选中范围内的所有项目
        for (let i = start; i <= end; i++) {
          const item = allFileItems[i];
          if (item) {
            item.classList.add('selected');
            const itemType = item.dataset.type;
            const itemPath = item.dataset.path;
            const itemName = item.dataset.name;
            selectedItems.push({ type: itemType, path: itemPath, name: itemName });
          }
        }

        // 更新最后选中的项目
        selectedItem = { type, path: p, name };
      }
    } else {
      // 如果没有上一次选择的项目，就只选择当前项目
      fileItem.classList.add('selected');
      selectedItem = { type, path: p, name };
      selectedItems = [selectedItem];
      lastSelectedItem = fileItem;
    }
  }

  currentFocusType = 'fileList';

  // 选中文件时，始终例外请求尺寸显示 (force: true)
  if (type === 'file' && requestSize) {
    if (sessionSizeCache.has(p)) {
      const szArea = fileItem.querySelector('.sz-area');
      if (szArea) szArea.textContent = sessionSizeCache.get(p);
      return;
    }
    const szArea = fileItem.querySelector('.sz-area');
    if (szArea) szArea.textContent = '    \\u2022    ';
    vscode.postMessage({ command: 'requestSize', path: p, type });
  }
}

let renameBlurHandler = null;

function startRename(itemPath, itemName, itemType){
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

  Object.assign(input.style, {
    width: '100%',
    padding: '0',
    border: '1px solid #ff6b00',
    boxSizing: 'border-box',
    fontSize: 'inherit',
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    backgroundColor: '#ff6b00',
    color: 'white'
  });

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

function commitRename(itemElement, oldPath, itemType, newName){
  const input = itemElement.querySelector('.rename-input');
  if (!input) return;
  input.removeEventListener('blur', renameBlurHandler);
  renameBlurHandler = null;
  currentFocusType = 'fileList';
  const oldName = itemElement.dataset.name;

  if (newName && newName !== oldName) {
    vscode.postMessage({ command: 'renameItem', oldPath, newName, itemType });
  } else {
    cancelRename(itemElement, itemElement.dataset.originalContent);
  }
}

function cancelRename(itemElement, originalContent){
  const input = itemElement.querySelector('.rename-input');
  if (!input) return;
  input.removeEventListener('blur', renameBlurHandler);
  renameBlurHandler = null;
  currentFocusType = 'fileList';

  const itemType = itemElement.dataset.type;
  const nameArea = itemElement.querySelector(\`.\${itemType === 'file' ? 'file' : 'folder'}-name-area\`);
  if (nameArea) {
    nameArea.innerHTML = originalContent || \`<span class="file-name">\${itemElement.dataset.name}</span>\`;
  }
}

// ===== 操作 =====
function performEditAction(item){
  if (item) {
    if (item.name === '..') return; // 严禁重命名上级目录
    startRename(item.path, item.name, item.type);
  }
}
function performOpenAction(item){ if (item) vscode.postMessage({ command: 'openWithDefault', path: item.path, type: item.type }); }
function performDeleteAction(item){
  if (!item) return;
  if (item.name === '..') return; // 严禁删除上级目录
  const el = findItemElementByPath(item.path);
  if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
  vscode.postMessage({ command: 'quickDeleteToRecycleBin', path: item.path, type: item.type });
  selectedItem = null;
}
function performCodeAction(item){
  if (!item) return;
  if (item.type === 'file') {
    const pinned = isPinned();
    vscode.postMessage({ command: 'editFile', path: item.path, isPinned: pinned, openInCurrentGroup: !pinned });
  } else {
    vscode.postMessage({ command: 'openFolderInNewWindow', path: item.path });
  }
}
function performCopyAction(item){
  if (!item) return;
  // 准许单选上级目录进行复制操作，这被认为是用户的明确意图
  vscode.postMessage({ command: 'copy', paths: [item.path] });
}
function performPasteAction(){
  vscode.postMessage({ command: 'paste', destDir: currentPath });
}

// ===== 右键菜单 =====
function handleContextMenuAction(action){
  const menu = document.getElementById('itemContextMenu');
  if (!menu) return;
  hideAllContextMenus();

  if (selectedItems.length > 1) {
    // 多选情况
    if (action === 'delete') {
      // 过滤掉上级目录，严禁删除
      const targets = selectedItems.filter(item => item.name !== '..');
      if (targets.length === 0) return;

      targets.forEach(item => {
        const el = findItemElementByPath(item.path);
        if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
      });
      vscode.postMessage({ command: 'quickDeleteMultipleToRecycleBin', items: targets });
      selectedItem = null;
      selectedItems = [];
    } else if (action === 'open') {
      // 多选情况：只打开第一个选中的项目
      const firstItem = selectedItems.find(item => item.name !== '..');
      if (firstItem) {
        performOpenAction(firstItem);
      }
    }
  } else {
    // 单选情况
    const item = { path: menu.dataset.path, name: menu.dataset.name, type: menu.dataset.type };
    if (!item.path) return;
    if (item.name === '..') {
        // 对于上级目录，只允许 q (code) 和 w (open) 操作，屏蔽删除、重命名
        if (['rename', 'delete'].includes(action)) return;
    }

    switch(action){
      case 'rename': performEditAction(item); break;
      case 'open': performOpenAction(item); break;
      case 'delete': performDeleteAction(item); break;
      case 'code': performCodeAction(item); break;
    }
  }
}

function refreshSizeDisplay(){
  // 已废弃：后端已预填充 sz-area，不需要 Webview 端主动请求
}

function requestFileSizeUpdates(items){
  // 已废弃：后端已预填充 sz-area，不需要 Webview 端主动请求
}

// ====== message ======
window.addEventListener('message', event => {
  const message = event.data;
  if (!message) return;

  if (message.command === 'update') {
      const newSizeMode = message.sizeMode || 'nothing';
      const isModeChanged = newSizeMode !== currentSizeMode;
      const isNewDir = (message.currentPath || '') !== currentPath;

      // 模式切换或目录切换时，清除缓存
      if (isNewDir || isModeChanged) {
        sessionSizeCache.clear();
      }

      // 更新当前模式
      currentSizeMode = newSizeMode;
      currentPath = message.currentPath || '';

      const addr = document.getElementById('addressInput');
      if (addr) {
        addr.value = message.currentPath || '';
        updateAddressDisplay(addr.value);
      }

      const list = document.getElementById('fileList');
      if (list) {
        // 重新渲染列表（后端已预填充 sz-area 内容）
        list.innerHTML = message.fileListHtml || '';

        // 从缓存恢复 sz-area 显示（优先使用缓存值，可能是 s 请求结果）
        const items = list.querySelectorAll('.file-item');
        items.forEach(item => {
          const p = item.dataset.path;
          if (sessionSizeCache.has(p)) {
            const cachedVal = sessionSizeCache.get(p);
            const szArea = item.querySelector('.sz-area');
            if (szArea) {
              szArea.textContent = cachedVal;
            }
          }
        });
      }

      // 注：后端已预填充 sz-area，不需要再主动请求
      // requestFileSizeUpdates 只在 s 请求时使用

      setTimeout(() => { calculateAndAdjustScroll(); checkAndApplyResponsive(); }, 100);
    } else if (message.command === 'updateSizeBatch') {
      (message.results || []).forEach(res => {
        // 只有确实拿到了尺寸字符串才缓存（避免缓存空的或错误提示）
        if (res.sizeDisplay && !res.sizeDisplay.includes('err')) {
          sessionSizeCache.set(res.path, res.sizeDisplay);
        }

        const el = findItemElementByPath(res.path, res.type);
        if (el) {
          const sz = el.querySelector('.sz-area');
          if (sz) {
            sz.textContent = res.sizeDisplay || '';
          }
        }
      });
  } else if (message.command === 'clearFilenameInput') {
    const f = document.getElementById('filenameInput');
    if (f) { f.value = ''; f.focus(); }
  } else if (message.command === 'startRename') {
    startRename(message.path, message.name, message.type);
  } else if (message.command === 'refreshSizes') {
    refreshSizeDisplay();
  } else if (message.command === 'restoreDeletedItem') {
    const el = findItemElementByPath(message.path);
    if (el) { el.style.opacity = ''; el.style.pointerEvents = ''; }
  } else if (message.command === 'updateSidebarRatio') {
    sidebarRatio = message.ratio;
    adjustSidebarByRatio();
  } else if (message.command === 'focusInput') {
    const f = document.getElementById('filenameInput');
    if (f) { f.focus(); f.select(); }
  }
});

// ====== DOM ======
document.addEventListener('focusin', (e) => updateFocusType(e.target));
document.addEventListener('click', (e) => {
  hideAllContextMenus();
  if (!['filenameInput', 'addressInput'].includes((e.target && e.target.id) || '') && !(e.target && e.target.classList && e.target.classList.contains('rename-input'))) {
    updateFocusType(e.target);
  }
});

function isInputFocused() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || active.isContentEditable || active.classList.contains('rename-input');
}

document.addEventListener('keydown', (e) => {
  if (isInputFocused()) return;

  if (e.key === 'Backspace') {
    e.preventDefault();
    vscode.postMessage({ command: 'navigateUp' });
  }
});

document.addEventListener('keydown', (e) => {
  if (isInputFocused()) return;
  const key = (e.key || '').toLowerCase();

  // Ctrl+C / Ctrl+V / Ctrl+A 处理
  if (e.ctrlKey || e.metaKey) {
    if (key === 'c') {
      e.preventDefault(); e.stopPropagation();
      if (selectedItems.length > 1) {
        // 多选复制：自动过滤掉上级目录，防止在全选等操作中意外包含父文件夹
        const paths = selectedItems
          .filter(item => item.name !== '..')
          .map(item => item.path);

        if (paths.length > 0) {
          vscode.postMessage({ command: 'copy', paths: paths });
        }
      } else if (selectedItem) {
        // 单选复制：准许包含上级目录（用户手动选中的意图）
        performCopyAction(selectedItem);
      }
      return;
    }
    if (key === 'v') {
      e.preventDefault(); e.stopPropagation();
      performPasteAction();
      return;
    }
    if (key === 'a') {
      e.preventDefault(); e.stopPropagation();
      // 全选所有文件项（排除 ".." 上级目录项）
      const prevSelectedItems = document.querySelectorAll('.file-item.selected');
      prevSelectedItems.forEach(item => {
        if (item.querySelector('.rename-input')) cancelRename(item);
        item.classList.remove('selected');
      });
      selectedItems = [];

      const allFileItems = document.querySelectorAll('.file-item');
      let lastEl = null;
      allFileItems.forEach(item => {
        if (item.dataset.name === '..') return; // Ctrl+A 时排除上级目录
        item.classList.add('selected');
        const itemType = item.dataset.type;
        const itemPath = item.dataset.path;
        const itemName = item.dataset.name;
        const selObj = { type: itemType, path: itemPath, name: itemName };
        selectedItems.push(selObj);
        lastEl = item;
      });

      if (selectedItems.length > 0) {
        selectedItem = selectedItems[selectedItems.length - 1];
        lastSelectedItem = lastEl;
      }
      currentFocusType = 'fileList';
      return;
    }
    // 允许其他 Ctrl 组合键透传
    return;
  }

  // ★ 空格键：s 请求（获取选中项或全部项的尺寸信息）
  if (key === ' ' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();

    let itemsToRequest = [];

    if (selectedItems.length > 0) {
      // 有选中项目：对选中的项目触发 sRequest
      itemsToRequest = selectedItems
        .filter(item => item.name !== '..')
        .map(item => ({ path: item.path, type: item.type }));
    } else {
      // 没有选中项目：对当前目录所有项目触发 sRequest
      const allFileItems = document.querySelectorAll('.file-item');
      allFileItems.forEach(item => {
        if (item.dataset.name === '..') return;
        itemsToRequest.push({ path: item.dataset.path, type: item.dataset.type });
      });
    }

    if (itemsToRequest.length > 0) {
      // 显示加载状态
      itemsToRequest.forEach(item => {
        const el = findItemElementByPath(item.path);
        if (el) {
          const szArea = el.querySelector('.sz-area');
          if (szArea) szArea.textContent = '    \u2022    ';
        }
      });
      vscode.postMessage({ command: 'sRequest', items: itemsToRequest });
    }
    return;
  }

  if (!selectedItem) return;

  if (key === 'q') {
    e.preventDefault(); e.stopPropagation();
    performCodeAction(selectedItem);
  } else if (key === 'w') {
    e.preventDefault(); e.stopPropagation();
    performOpenAction(selectedItem);
  } else if (key === 'd') {
    e.preventDefault(); e.stopPropagation();
    if (selectedItems.length > 1) {
      // 多选删除：过滤掉上级目录
      const targets = selectedItems.filter(item => item.name !== '..');
      if (targets.length > 0) {
        targets.forEach(item => {
          const el = findItemElementByPath(item.path);
          if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
        });
        vscode.postMessage({ command: 'quickDeleteMultipleToRecycleBin', items: targets });
        selectedItem = null;
        selectedItems = [];
      }
    } else if (selectedItem && selectedItem.name !== '..') {
      // 单选删除：排除上级目录
      performDeleteAction(selectedItem);
    }
  } else if (key === 'e') {
    e.preventDefault(); e.stopPropagation();
    if (selectedItem && selectedItem.name !== '..') {
        performEditAction(selectedItem);
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  ensurePathTooltip();

  const filenameInput = document.getElementById('filenameInput');
  if (filenameInput) {
    filenameInput.focus();
    filenameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveFile();
    });
  }

  const addressInput = document.getElementById('addressInput');
  if (addressInput) {
    addressInput.addEventListener('input', (e) => updateAddressDisplay(e.target.value));
    addressInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const p = (addressInput.value || '').trim();
        if (p) vscode.postMessage({ command: 'navigate', path: p });
      }
    });
  }

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

  // 点击选择/进入
  const fileList = document.getElementById('fileList');
  if (fileList) {
    fileList.addEventListener('click', (event) => {
      const fileItem = event.target.closest('.file-item');
      if (!fileItem) {
        const prevSelectedItems = document.querySelectorAll('.file-item.selected');
        prevSelectedItems.forEach(item => {
          const renameInput = item.querySelector('.rename-input');
          if (renameInput) cancelRename(item);
          item.classList.remove('selected');
        });
        selectedItem = null;
        selectedItems = [];
        lastSelectedItem = null;
        return;
      }

      const type = fileItem.dataset.type;
      const isSzArea = event.target.classList.contains('sz-area');
      const itemPath = fileItem.dataset.path;
      const itemName = fileItem.dataset.name;

      // 排除上级目录
      if (itemName === '..') {
        if (type === 'folder' && !isSzArea) {
          vscode.postMessage({ command: 'navigate', path: itemPath });
        }
        return;
      }

      if (type === 'folder') {
        if (isSzArea) {
          // 点击文件夹的 sz 区：只选中
          selectFileItem(fileItem, false, event.shiftKey);
          currentFocusType = 'fileList';
          return;
        }
        // 非 sz-area 区域：直接进入文件夹
        vscode.postMessage({ command: 'navigate', path: itemPath });
        currentFocusType = 'fileList';
        return;
      }

      // 文件点击：统一只选中
      selectFileItem(fileItem, false, event.shiftKey);
      currentFocusType = 'fileList';
    });

    // 右键：item / empty
    fileList.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      hideAllContextMenus();

      const itemElement = e.target.closest('.file-item');
      const itemMenu = document.getElementById('itemContextMenu');
      const emptyMenu = document.getElementById('emptyContextMenu');

      if (itemElement && itemMenu) {
        // 如果已经有选中的项目，并且点击的是其中一个，保持所有选中状态
        if (selectedItems.length === 0) {
          selectFileItem(itemElement, false);
        }

        itemMenu.dataset.path = itemElement.dataset.path;
        itemMenu.dataset.name = itemElement.dataset.name;
        itemMenu.dataset.type = itemElement.dataset.type;

        itemMenu.style.left = e.clientX + 'px';
        itemMenu.style.top = e.clientY + 'px';
        itemMenu.style.display = 'flex';
      } else if (emptyMenu) {
        emptyMenu.style.left = e.clientX + 'px';
        emptyMenu.style.top = e.clientY + 'px';
        emptyMenu.style.display = 'flex';
      }
    });
  }

  // item menu click
  const itemMenu = document.getElementById('itemContextMenu');
  if (itemMenu) {
    itemMenu.querySelectorAll('.context-menu-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        handleContextMenuAction(e.currentTarget.dataset.action);
      });
    });
  }

  // empty menu: 若模板里有 data-mode / data-action，这里自动接管
  const emptyMenu = document.getElementById('emptyContextMenu');
  if (emptyMenu) {
    emptyMenu.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const mode = e.currentTarget.dataset.mode;
        if (mode) setSizeMode(mode);
      });
    });
    emptyMenu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const act = e.currentTarget.dataset.action;
        if (act === 'createFolder') createFolder();
        else if (act === 'saveFile') saveFile();
      });
    });
  }

  // sidebar 拖动
  const sidebarResizer = document.getElementById('sidebarResizer');
  const sidebar = document.querySelector('.sidebar');
  const kyContent = document.querySelector('.ky-content');
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  if (sidebarResizer && sidebar && kyContent) {
    sidebarResizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      sidebarResizer.classList.add('active');
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const container = document.querySelector('.container');
      const totalWidth = container ? container.clientWidth : window.innerWidth;
      const ratio = Math.max(0.05, Math.min(0.5, (startWidth + e.clientX - startX) / totalWidth));
      const newWidth = Math.max(50, Math.min(500, totalWidth * ratio));
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
      const ratio = (parseInt(sidebar.style.width) || 100) / totalWidth;
      vscode.postMessage({ command: 'saveSidebarRatio', ratio });
    });

    document.addEventListener('mouseleave', () => {
      if (!isResizing) return;
      isResizing = false;
      sidebarResizer.classList.remove('active');
      document.body.style.userSelect = '';
    });
  }

  // 最终：首次渲染后调一轮布局
  adjustSidebarByRatio();
  checkAndApplyResponsive();
  updateAddressDisplay(currentPath);

  // 注意：真正的列表刷新由 extension 侧 postMessage(update) 完成
});

// ====== 导出给模板内联 onclick ======
window.navigateTo = navigateTo;
window.navigateIntoFolder = navigateIntoFolder;
window.removeFromRecent = removeFromRecent;
window.cancel = cancel;
window.saveFile = saveFile;
window.createFolder = createFolder;
window.togglePin = togglePin;
`;
}

function getWebviewContent(currentPath) {
  const config = getConfig();
  const drives = getDrives();

  const safeRecentDirs = (config.recentDirs || []).filter((dir) => dir && fs.existsSync(dir));
  const safeRecycleBin = (config.recycleBin || []).filter(
    (dir) => dir && typeof dir === "string" && fs.existsSync(dir)
  );
  const showRecycleBin =
    vscode.workspace.getConfiguration("qqq").get("showHistoryRecycleBin", true) &&
    safeRecycleBin.length > 0;

  let htmlTemplate = "";
  try {
    htmlTemplate = require("./q2.html");
  } catch (error) {
    geq().logMessage(`无法读取 q2.html 模板文件: ${error.message}`, "ERROR");
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

  const inlineScript = generateWebviewScript(currentPath, config.sidebarRatio);

  let finalHtml = htmlTemplate
    .replace("{{SIDEBAR_WIDTH}}", config.sidebarWidth)
    .replace("{{LINE_SPACING}}", config.lineSpacing)
    .replace("{{DRIVES_HTML}}", drivesHtml)
    .replace("{{RECYCLE_BIN_HTML}}", recycleBinHtml)
    .replace("{{RECENT_DIRS_HTML}}", recentDirsHtml)
    .replace("{{CURRENT_PATH}}", escapeHtmlAttribute(currentPath))
    .replace("{{PIN_CLASS}}", config.isPinned ? "pinned" : "")
    .replace("{{PIN_CHECKBOX}}", config.isPinned ? "✓" : "□")
    .replace("{{INLINE_SCRIPT}}", inlineScript.replace(/<\/script>/gi, "<\\/script>"));

  return finalHtml;
}

// ==================== Q2 粘贴功能（完全移植自 Q1） ====================
// ★★★ 基于事务、多任务、指纹去重、同名自动重命名、完美取消回滚、完备UI ★★★

/**
 * 执行 Q2 漫游器的粘贴操作
 * @param {string} targetDir - 目标目录
 * @param {Function} refreshCallback - 刷新 Webview 的回调函数
 */
async function performQ2Paste(targetDir, refreshCallback) {
  // ★ 使用目标目录生成任务标题（等价于 q1 的方式）
  const taskNum = await TaskCounter.increment(targetDir);
  const iconNum = await TaskCounter.incrementIcon();
  const transId = TransactionManager.createTransactionId();
  const taskTitle = TaskCounter.formatTitle(targetDir, transId, iconNum);

  // ★ 获取剪贴板快照
  const snapshot = await wq();

  // ★ 如果剪贴板是白名单类型（纯文本），不处理
  if (snapshot.type === 'whitelist') {
    global.showInformationMessage('qqq: 剪贴板中是纯文本，无法粘贴到文件管理器');
    return;
  }

  // ★ 确定任务类型和预计大小
  let taskType = 'local_file';
  let intentTotalSize = 0;
  if (snapshot.subType === 'html_rich' || snapshot.subType === 'html_text') {
    taskType = 'html';
  } else if (snapshot.subType === 'video_url') {
    taskType = 'video';
  } else if (snapshot.subType === 'file' || snapshot.subType === 'image') {
    taskType = 'local_file';
    intentTotalSize = snapshot.totalSize || 0;
  }

  // ★ 保存事务（用于回滚）
  await TransactionManager.saveTransaction({
    id: transId,
    targetDir: targetDir,
    tempFiles: [],
    landedFiles: [],
    landedFolders: [],
    startTime: Date.now(),
    taskType: taskType,
    intentTotalSize: intentTotalSize,
    existingFiles: await global.getDirectorySnapshot(targetDir)
  });

  const taskStartTime = Date.now();

  // ★ 使用 VS Code 进度条 + 取消按钮
  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: taskTitle,
    cancellable: true
  }, async (progress, token) => {
    const isCancelled = () => token.isCancellationRequested;

    try {
      // ★ 调用 h.autoDetectAndPaste 执行实际粘贴，传入进度回调
      let result = await h.autoDetectAndPaste(
        targetDir,
        async (p, msg) => {
          progress.report({ increment: p, message: msg });
        },
        token,
        transId,
        snapshot,  // 传入快照，避免重复检测
        null,
        () => token.isCancellationRequested,
        true  // autoRename = true，同名文件自动重命名
      );

      // ★ 用户取消处理
      if (isCancelled()) {
        const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
        if (trans) await TransactionManager.rollback(trans);

        TaskMessage.showSimpleToast(`${taskTitle} 已取消并回滚`, 15000, 'cancel');

        // 刷新 Webview
        if (refreshCallback) setTimeout(refreshCallback, 300);
        return;
      }

      // ★ 处理结果
      if (result) {
        await TransactionManager.removeTransaction(transId);

        // ★ 统计并显示完成消息
        const elapsedMs = Date.now() - taskStartTime;
        let detail = '';
        let totalSizeForStats = 0;

        if (result.type === 'html_blocks' || result.type === 'skeleton') {
          // HTML 粘贴
          const mediaBlocks = result.blocks?.filter(b => b.type === 'media' && b.status === 'ok') || [];
          const mediaCount = mediaBlocks.length;
          const totalSize = mediaBlocks.reduce((sum, block) => sum + (block.size || 0), 0);
          totalSizeForStats = totalSize;

          let sizeStr = '';
          if (totalSize > 0) {
            if (totalSize < 1024) sizeStr = `${totalSize}b`;
            else if (totalSize < 1048576) sizeStr = `${(totalSize / 1024).toFixed(1)}k`;
            else sizeStr = `${(totalSize / 1048576).toFixed(1)}m`;
          }
          detail = `共落盘${mediaCount}个文件${sizeStr ? ` ${sizeStr}` : ''}`;

          if (result.baseUrl) {
            const urlSnippet = result.baseUrl.length > 33 ? result.baseUrl.substring(0, 33) + '...' : result.baseUrl;
            detail += `，从 ${urlSnippet}`;
          }
        } else if (result.type === 'file_folder' || result.type === 'file') {
          // 文件/文件夹粘贴
          const totalCount = (result.files?.length || 0) + (result.folders?.length || 0);
          const skippedCount = result.skippedCount || 0;
          detail = `文件/文件夹已复制 ${totalCount}`;
          if (skippedCount > 0) {
            detail += ` (跳过 ${skippedCount}个无法访问)`;
          }

          // 获取总大小
          if (result.totalSize) {
            totalSizeForStats = result.totalSize;
          } else if (snapshot && snapshot.totalSize) {
            totalSizeForStats = snapshot.totalSize;
          } else if (result.files) {
            for (const f of result.files) {
              try { totalSizeForStats += fs.statSync(f).size; } catch { }
            }
          }
        } else if (result.type === 'image') {
          // 图片粘贴
          detail = `图片已保存`;
          if (result.path) {
            try { totalSizeForStats = fs.statSync(result.path).size; } catch { }
          }
        }

        // ★ 显示完成消息
        if (detail) {
          const msg = TaskMessage.done(taskTitle, detail, elapsedMs, taskNum);
          TaskMessage.showSimpleToast(msg, 15000, 'success');
        }

        // ★ 统计上报
        if (taskType === 'video') {
          global.saveVideoStats(totalSizeForStats);
        } else {
          savePasteStats(totalSizeForStats);
        }

        // 刷新 Webview
        if (refreshCallback) setTimeout(refreshCallback, 300);
      } else {
        // 结果为空，回滚
        const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
        if (trans) await TransactionManager.rollback(trans);

        TaskMessage.showSimpleToast(`${taskTitle} 未检测到可粘贴内容`, 10000, 'info');

        if (refreshCallback) setTimeout(refreshCallback, 300);
      }
    } catch (e) {
      console.error('[Q2 Paste Error]', e);
      const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
      if (trans) await TransactionManager.rollback(trans);

      TaskMessage.showSimpleToast(`${taskTitle} 发生异常，已回滚`, 15000, 'cancel');

      if (refreshCallback) setTimeout(refreshCallback, 300);
    }
  });
}

// ==================== 主逻辑 ====================
function showSaveAsDialog() {
  if (!global.isValid()) {
    global.showErrorMessage("Integrity check failed.");
    return;
  }

  if (activePanel && activePanelAlive) {
    if (usePanelReveal === 1) activePanel.reveal(vscode.ViewColumn.Active);
    setTimeout(() => {
      try {
        if (activePanel && activePanelAlive)
          activePanel.webview.postMessage({ command: "focusInput" });
      } catch { }
    }, 100);
    return;
  }

  const config = getConfig();

  // 起始目录：优先 recentDirs[0]，否则按平台默认
  let currentPath = "";
  if (config.recentDirs && config.recentDirs.length > 0) {
    currentPath = canonicalizeExistingPath(config.recentDirs[0]);
  } else {
    if (process.platform === "win32")
      currentPath = canonicalizeExistingPath(process.env.USERPROFILE || _getSystemDriveRoot());
    else currentPath = canonicalizeExistingPath(os.homedir() || "/");
  }

  try {
    if (!currentPath || !fs.existsSync(currentPath)) {
      currentPath =
        process.platform === "win32"
          ? canonicalizeExistingPath(process.env.USERPROFILE || _getSystemDriveRoot())
          : canonicalizeExistingPath(os.homedir() || "/");
    } else if (!fs.statSync(currentPath).isDirectory()) {
      currentPath = canonicalizeExistingPath(path.dirname(currentPath));
    }
  } catch {
    currentPath =
      process.platform === "win32"
        ? canonicalizeExistingPath(process.env.USERPROFILE || _getSystemDriveRoot())
        : canonicalizeExistingPath(os.homedir() || "/");
  }

  const extensionUri = globalContext.extensionUri;

  const panel = vscode.window.createWebviewPanel(
    "q2",
    "qqq new 新建",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],
      contentSecurityPolicy: `default-src 'none'; script-src 'unsafe-inline' vscode-webview-resource:; style-src 'unsafe-inline' vscode-webview-resource:; img-src vscode-webview-resource: data:; font-src vscode-webview-resource:;`
    }
  );
  activePanel = panel;
  activePanelAlive = true;

  const iconPath = path.join(globalContext.extensionPath, "assets", "icon.png");
  if (fs.existsSync(iconPath)) panel.iconPath = vscode.Uri.file(iconPath);

  panel.onDidDispose(() => {
    activePanelAlive = false;
    activePanel = null;
    if (currentWatcher) {
      currentWatcher.dispose();
      currentWatcher = null;
    }
  });

  async function updateResourceExplorer() {
    try {
      if (!panel || !activePanelAlive) return;

      // 记录当前目录，用于检测目录切换
      if (currentPath !== lastResourceExplorerPath) {
        lastResourceExplorerPath = currentPath;
      }

      // 切换目录时，取消之前的待处理尺寸请求
      activeAbortController.abort();
      activeAbortController = new AbortController();
      const currentSignal = activeAbortController.signal;

      // 清理旧的文件监视器
      if (currentWatcher) {
        currentWatcher.dispose();
        currentWatcher = null;
      }

      const config = getConfig();
      const szDisplayMode = config.szDisplayMode;
      const directoryContents = await getDirectoryContents(currentPath, config.sortBy, szDisplayMode);
      const items = [];
      let fileListHtml = "";

      // 辅助函数：根据 szDisplayMode 生成 sz-area 内容
      function getSzContent(item, isFolder) {
        if (szDisplayMode === "nothing") return "";
        if (szDisplayMode === "size") {
          // size 模式：只显示文件大小，文件夹不参与
          if (isFolder) return "";
          return formatFileSize(item.size || 0) + " ";
        } else if (szDisplayMode === "ctime") {
          return formatDateTime(item.ctime) + " ";
        } else if (szDisplayMode === "mtime") {
          return formatDateTime(item.mtime) + " ";
        }
        return "";
      }

      // 允许返回上级：root 不显示 ..
      const canonCur = canonicalizeExistingPath(currentPath);
      const parent = canonicalizeExistingPath(path.dirname(canonCur));
      const root = (() => {
        try {
          // 使用 vscode.Uri 辅助解析根路径，增强跨平台兼容性
          return vscode.Uri.file(canonCur).fsPath === vscode.Uri.file(path.parse(canonCur).root).fsPath ? canonCur : path.parse(canonCur).root;
        } catch {
          return "";
        }
      })();

      const canGoUp = canonCur && parent && canonCur !== parent && canonCur !== root;

      if (canGoUp) {
        const parentPath = parent;
        items.push({ path: parentPath, name: "..", type: "folder" });
        fileListHtml += `<div class="file-item folder" data-path="${escapeHtmlAttribute(
          parentPath
        )}" data-name=".." data-type="folder"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">📁</span></div><div class="folder-name-area"><span class="file-name">..</span></div></div>`;
      }

      directoryContents.dirs.forEach((dir) => {
        const szContent = getSzContent(dir, true);
        items.push({ path: dir.path, name: dir.name, type: "folder" });
        fileListHtml += `<div class="file-item folder" data-path="${escapeHtmlAttribute(
          dir.path
        )}" data-name="${escapeHtmlAttribute(dir.name)}" data-type="folder"><div class="file-select-area"><div class="sz-area">${escapeHtmlAttribute(szContent)}</div><span class="file-icon">📁</span></div><div class="folder-name-area"><span class="file-name">${escapeHtmlAttribute(
          dir.name
        )}</span></div></div>`;
      });

      directoryContents.files.forEach((file) => {
        const szContent = getSzContent(file, false);
        items.push({ path: file.path, name: file.name, type: "file" });
        fileListHtml += `<div class="file-item file" data-path="${escapeHtmlAttribute(
          file.path
        )}" data-name="${escapeHtmlAttribute(file.name)}" data-type="file"><div class="file-select-area"><div class="sz-area">${escapeHtmlAttribute(szContent)}</div><span class="file-icon">🗈</span></div><div class="file-name-area"><span class="file-name">${escapeHtmlAttribute(
          file.name
        )}</span></div></div>`;
      });

      panel.webview.postMessage({
        command: "update",
        currentPath,
        fileListHtml,
        items,
        sizeMode: config.szDisplayMode,
      });

      // ★ 智能文件监视器：只在用户开启 autoWatchChanges 时启用
      if (config.autoWatchChanges) {
        setupFileWatcher(currentPath);
      }
    } catch (error) {
      geq().logMessage(`更新资源展示区失败: ${error}`, "ERROR");
    }
  }

  // 文件监视器设置（智能防抖，避免重复触发）
  let watcherDebounceTimer = null;
  let lastWatcherTriggerTime = 0;
  const WATCHER_DEBOUNCE_MS = 500; // 防抖时间
  const WATCHER_COOLDOWN_MS = 1000; // 冷却时间，避免短时间内多次触发

  function setupFileWatcher(watchPath) {
    // 清理旧的监视器
    if (currentWatcher) {
      currentWatcher.dispose();
      currentWatcher = null;
    }

    try {
      // 智能防抖刷新函数
      const smartRefresh = () => {
        const now = Date.now();

        // 冷却期内不触发
        if (now - lastWatcherTriggerTime < WATCHER_COOLDOWN_MS) {
          return;
        }

        // 清除之前的定时器
        if (watcherDebounceTimer) {
          clearTimeout(watcherDebounceTimer);
        }

        // 设置新的防抖定时器
        watcherDebounceTimer = setTimeout(() => {
          watcherDebounceTimer = null;
          lastWatcherTriggerTime = Date.now();

          // 确保面板仍然活跃
          if (activePanel && activePanelAlive && globalRefreshWebview) {
            globalRefreshWebview();
          }
        }, WATCHER_DEBOUNCE_MS);
      };

      // 使用 VS Code 的 FileSystemWatcher
      const watchPattern = new vscode.RelativePattern(watchPath, "*");
      currentWatcher = vscode.workspace.createFileSystemWatcher(watchPattern);
      currentWatcher.onDidCreate(smartRefresh);
      currentWatcher.onDidChange(smartRefresh);
      currentWatcher.onDidDelete(smartRefresh);

    } catch (e) {
      global.logMessage(`[Q2] 启动文件监视失败: ${e.message}`, "WARN");
    }
  }

  async function refreshWebview() {
    if (!panel || !activePanelAlive) return;
    try {
      // 性能优化：如果 Webview 已经加载过内容，不要全量重刷 HTML
      // 只有在 HTML 为空时才进行初始化。切换目录通过 update 消息处理。
      if (!panel.webview.html || panel.webview.html === "") {
        panel.webview.html = getWebviewContent(currentPath);
        // 首次加载需要给一点时间
        setTimeout(async () => {
          if (!panel || !activePanelAlive) return;
          await updateResourceExplorer();
          try {
            panel.webview.postMessage({ command: "focusInput" });
          } catch { }
        }, 300);
      } else {
        // 已经是激活状态，直接异步更新内容，实现"秒开"响应
        await updateResourceExplorer();
      }
    } catch (e) {
      geq().logMessage("Refresh Webview failed: " + e.message, "ERROR");
    }
  }

  // 注册全局刷新函数
  globalRefreshWebview = refreshWebview;

  function getShowOptions(openInCurrentGroup) {
    const options = { preserveFocus: false, preview: false };
    if (!activePanel) {
      options.viewColumn = vscode.ViewColumn.One;
      return options;
    }

    const currentCol = activePanel.viewColumn || vscode.ViewColumn.One;

    if (openInCurrentGroup) {
      // !isPinned case: 实现“一换一”，在 q2 所在的分组打开
      options.viewColumn = currentCol;
      return options;
    }

    // isPinned case: 智能寻找紧邻的分组（左右方向）
    if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) {
      options.viewColumn = vscode.ViewColumn.Beside;
      return options;
    }

    const allGroups = vscode.window.tabGroups.all || [];
    const columns = allGroups
      .map((g) => g.viewColumn)
      .filter((c) => typeof c === "number" && c > 0)
      .sort((a, b) => a - b);

    const idx = columns.indexOf(currentCol);
    if (idx !== -1) {
      if (idx < columns.length - 1) {
        // 1. 优先使用紧邻右侧的分组
        options.viewColumn = columns[idx + 1];
      } else if (idx > 0) {
        // 2. 如果已是右侧极限，则使用左侧邻居
        options.viewColumn = columns[idx - 1];
      } else {
        // 3. 只有一个分组，则在侧边新建
        options.viewColumn = vscode.ViewColumn.Beside;
      }
    } else {
      options.viewColumn = vscode.ViewColumn.Beside;
    }

    return options;
  }

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!panel || !activePanelAlive) return;

    const currentConfig = getConfig();

    switch (message.command) {
      case "removeFromRecent":
        if (removeAndRecycleRecentDirectory(message.path)) refreshWebview();
        break;

      // s 请求：点击 sz 区强制获取 size（包括文件夹递归大小）
      case "sRequest": {
        (async () => {
          const items = message.items || [];
          if (items.length === 0) return;

          const results = await Promise.all(items.map(async (item) => {
            const isFolder = item.type === 'folder';
            const size = await getSizeForSRequest(item.path, isFolder);
            return {
              path: canonicalizeExistingPath(item.path),
              type: item.type,
              sizeDisplay: formatFileSize(size) + " "
            };
          }));

          if (panel && activePanelAlive) {
            panel.webview.postMessage({
              command: "updateSizeBatch",
              results: results
            });
          }
        })();
        break;
      }

      case "renameItem":
        try {
          const { oldPath, newName } = message;
          const oldCanon = canonicalizeExistingPath(oldPath);
          const newPath = canonicalizeExistingPath(path.join(path.dirname(oldCanon), newName));

          if (fs.existsSync(newPath)) {
            global.showErrorMessage(`重命名失败：目标位置已存在同名项。`);
            refreshWebview();
          } else {
            fs.renameSync(oldCanon, newPath);
            saveRecentDirectory(path.dirname(oldCanon));
            setTimeout(() => {
              if (panel && activePanelAlive) refreshWebview();
            }, 100);
          }
        } catch (error) {
          global.showErrorMessage("重命名失败: " + error.message);
          refreshWebview();
        }
        break;

      case "navigate":
        try {
          const resolved = resolveNavPath(message.path, currentPath);

          // Windows：若用户点了 drives 的 "C:"，resolve 后可能仍是 "C:"；这里强制成根
          let newPath = resolved;
          if (process.platform === "win32" && /^[A-Z]:$/i.test(newPath)) newPath = newPath.toUpperCase() + "\\";

          newPath = canonicalizeExistingPath(newPath);

          if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
            currentPath = newPath;
            refreshWebview();
          } else {
            global.showErrorMessage("无效的目录路径: " + newPath);
          }
        } catch (error) {
          global.showErrorMessage("导航失败: " + error.message);
        }
        break;

      case "navigateUp": {
        const parentDir = canonicalizeExistingPath(path.dirname(currentPath));
        if (parentDir && parentDir !== currentPath) {
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
          currentConfig.isPinned
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
          message.isPinned
        );
        break;

      case "save": {
        const { filename, isPinned, openInCurrentGroup } = message;
        const fullFilePath = canonicalizeExistingPath(path.join(currentPath, filename));

        const createFileAction = () => {
          try {
            if (fs.existsSync(fullFilePath) && fs.statSync(fullFilePath).isDirectory()) {
              global.showErrorMessage(`无法创建文件，因为已存在同名文件夹: "${filename}"`);
              return;
            }
            fs.writeFileSync(fullFilePath, "\n".repeat(199), "utf8");
            saveRecentDirectory(currentPath);

            // 联动 Q4 统计：累加新建文件数
            try {
              const q4 = vscode.extensions.getExtension('gh555.qqq')?.exports;
              if (q4 && typeof q4.recordRoamUsage === 'function') {
                q4.recordRoamUsage({ filesCreated: 1 });
              }
            } catch (e) { }

            if (!fs.existsSync(fullFilePath)) {
              global.logMessage(`[Q2] 创建后打开失败：文件未找到 ${fullFilePath}`, "WARN");
              return;
            }
            vscode.workspace.openTextDocument(fullFilePath).then((doc) => {
              global.showTextDocument(doc, getShowOptions(openInCurrentGroup)).then(() => {
                if (!isPinned) {
                  if (panel && activePanelAlive) panel.dispose();
                } else {
                  if (panel && activePanelAlive) refreshWebview();
                }
              });
            }, (err) => {
              global.logMessage(`[Q2] openTextDocument 失败: ${err.message}`, "ERROR");
            });
          } catch (error) {
            global.showErrorMessage(`创建文件失败: ${error.message}`);
          }
        };

        if (fs.existsSync(fullFilePath)) {
          const stats = fs.statSync(fullFilePath);
          if (stats.isDirectory()) {
            global.showErrorMessage(`无法创建文件，因为已存在同名文件夹: "${filename}"`);
          } else {
            global
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
        const newFolderPath = canonicalizeExistingPath(path.join(currentPath, message.folderName));
        if (fs.existsSync(newFolderPath)) {
          global.showErrorMessage(`无法创建，"${message.folderName}" 已存在。`);
        } else {
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
        const p = canonicalizeExistingPath(message.path);
        const ext = path.extname(p).toLowerCase();

        if (UNSUPPORTED_CODE_EXTENSIONS.has(ext)) {
          vscode.window.showWarningMessage(`该文件不支持在 VS Code 里打开: "${path.basename(p)}"`);
          break;
        }

        if (!fs.existsSync(p)) {
          vscode.window.showWarningMessage(`文件已不存在: ${path.basename(p)}`);
          refreshWebview();
          break;
        }

        vscode.workspace
          .openTextDocument(p)
          .then((doc) => {
            vscode.window.showTextDocument(doc, getShowOptions(message.openInCurrentGroup)).then(() => {
              if (!message.isPinned && panel && activePanelAlive) panel.dispose();
            });
          })
          .catch((error) => {
            global.logMessage(`[Q2] 打开文件失败: ${error.message}`, "ERROR");
          });
        break;
      }

      case "openFolderInNewWindow": {
        const p = canonicalizeExistingPath(message.path);
        saveRecentDirectory(p);
        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(p), {
          forceNewWindow: true,
        });
        refreshWebview();
        break;
      }

      case "openWithDefault": {
        const p = canonicalizeExistingPath(message.path);
        saveRecentDirectory(message.type === "folder" ? p : path.dirname(p));
        try {
          global.openExternal(vscode.Uri.file(p));
        } catch (error) {
          global.showErrorMessage(`打开文件失败: ${error.message}`);
        }
        break;
      }

      case "quickDeleteToRecycleBin": {
        const itemToDelete = canonicalizeExistingPath(message.path);
        // 安全保护：绝对禁止删除上级目录
        if (path.basename(itemToDelete) === '..' || message.name === '..') {
          global.showErrorMessage("非法操作：禁止删除上级目录。");
          refreshWebview();
          break;
        }
        if (fs.existsSync(itemToDelete)) {
          saveRecentDirectory(currentPath);
          (async () => {
            try {
              const uri = vscode.Uri.file(itemToDelete);
              await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
              global.setStatusBarMessage(`${path.basename(itemToDelete)} 已移至回收站`, 5000);
            } catch (error) {
              global.showErrorMessage(`删除失败: ${error.message}`);
            } finally {
              // 无论成功失败，都刷新列表并恢复状态
              if (activePanel && activePanelAlive) refreshWebview();
            }
          })();
        } else {
          refreshWebview();
        }
        break;
      }

      case "quickDeleteMultipleToRecycleBin": {
        const itemsToDelete = (message.items || []).filter(item => item.name !== '..'); // 插件侧二次过滤，确保安全
        if (itemsToDelete.length > 0) {
          saveRecentDirectory(currentPath);
          (async () => {
            let deletedCount = 0;
            let errorCount = 0;

            for (const item of itemsToDelete) {
              const itemPath = canonicalizeExistingPath(item.path);
              if (fs.existsSync(itemPath)) {
                try {
                  const uri = vscode.Uri.file(itemPath);
                  await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
                  deletedCount++;
                } catch (error) {
                  errorCount++;
                  global.logMessage(`删除项失败: ${itemPath} - ${error.message}`, "WARN");
                }
              }
            }

            if (deletedCount > 0) {
              global.setStatusBarMessage(`已将 ${deletedCount} 个项目移至回收站${errorCount > 0 ? `，${errorCount} 个处理失败` : ""}`, 5000);
            } else if (errorCount > 0) {
              global.showErrorMessage(`${errorCount} 个项目删除失败。`);
            }

            // 无论删除过程中发生什么错误，最后都必须强制刷新列表以恢复界面（变灰项会消失或恢复）
            if (activePanel && activePanelAlive) refreshWebview();
          })();
        } else {
          refreshWebview();
        }
        break;
      }

      case "copy":
        if (message.paths && message.paths.length > 0) {
          // 插件侧安全过滤：只过滤掉字面意义上的 ".." 相对路径，允许已解析的绝对路径
          const safePaths = message.paths.filter(p => p !== '..' && !p.endsWith(path.sep + '..'));
          if (safePaths.length > 0) {
            await h.copyFilesToClipboard(safePaths);
          }
        }
        break;

      case "paste":
        // ★★★ Q2 粘贴功能：完全移植自 Q1，基于事务、带进度条、可取消 ★★★
        await performQ2Paste(message.destDir, refreshWebview);
        break;
    }
  });

  refreshWebview();
}

// ==================== 扩展激活 ====================
async function activate(context) {
  if (!context) {
    global.logMessage("q2.activate: context is undefined!", "ERROR");
    return;
  }
  globalContext = context;
  const extensionPath = context.extensionUri?.fsPath || context.extensionPath;
  if (!extensionPath) {
    global.logMessage("q2.activate: extensionPath is undefined!", "ERROR");
    return;
  }

  LARGE_WATERMARK_PATH = path.join(extensionPath, "assets", "al.png");
  SMALL_WATERMARK_PATH = path.join(extensionPath, "assets", "as.png");

  // 异步校验完整性，不阻塞激活
  global.verifySystemIntegrityAsync(context).then(valid => {
    geq().logMessage(`Q2 Integrity: ${valid ? "PASSED" : "FAILED"}`, "INFO");
  });

  getConfig();
  geq().logMessage("Q2: 文件管理器已激活（使用 geq().js 四级回退 + size调度/缓存 + 最新 IO 路径逻辑）", "INFO");

  // ★ 关键：监听配置变化，当用户在设置中修改时立即刷新
  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("qqq.szDisplayMode") ||
      event.affectsConfiguration("qqq.sortBy") ||
      event.affectsConfiguration("qqq.autoWatchChanges")) {
      // 清除配置缓存，强制重新读取
      cachedInMemoryConfig = null;
      geq().logMessage("Q2: 配置已更改，正在刷新...", "INFO");
      // 如果面板正在显示，刷新它
      if (activePanel && activePanelAlive && globalRefreshWebview) {
        globalRefreshWebview();
      }
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("qqq.q2", global.withReady(showSaveAsDialog)),
    vscode.commands.registerCommand("qqq.saveAsDialog", global.withReady(showSaveAsDialog)),
    configChangeDisposable
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
  globalRefreshWebview = null;
}

module.exports = { activate, deactivate };

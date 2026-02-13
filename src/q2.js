// File: src/q2.js
// ★★★ 文件管理器：Webview 界面 + 使用 geq().js 四级回退 + 防惊群尺寸调度/缓存 ★★★
// 适配：匹配最新 qqq IO 引擎路径逻辑（跨平台 normalize + 绝对路径保留 + canonical 去重）
// 说明：本文件内置 normalize/resolve/canonical，若 geq().js 导出同名函数会自动优先使用 qqq 的实现

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const cp = require("child_process");
const h = require("./h");
const { q, onLanguageChange } = require("./i18n");

// ★★★ 粘贴功能核心模块：从 global.js 导入事务管理、任务计数、剪贴板快照等 ★★★
const { TransactionManager, TaskCounter, TaskMessage, wq, savePasteStats, cancelScans } = require("./global");

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
let sRequestVersion = 0; // sRequest 版本号，用于取消过期请求
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

/**
 * 取消所有引擎的扫描操作（Node + Python + Rust）
 */
function cancelAllScans() {
  // Node 引擎：立即生效
  try { geq().cancelScansJS(); } catch { }
  // Python/Rust daemon：发送取消命令
  cancelScans();
}

/**
 * 打开管理员权限终端（CMD 或 PowerShell）
 * @param {string} targetPath - 目标目录路径
 * @param {string} termType - 'cmd' 或 'powershell'
 */
function openAdminTerminal(targetPath, termType) {
  try {
    const absPath = path.resolve(targetPath);
    const platform = process.platform;

    if (platform === 'win32') {
      // Windows: 使用 ShellExecuteW 以 runas 方式打开管理员终端
      if (termType === 'cmd') {
        // 管理员 CMD
        const command = `/k "cd /d "${absPath}""`;
        cp.spawn('powershell', [
          '-NoProfile', '-Command',
          `Start-Process cmd.exe -ArgumentList '${command}' -Verb RunAs`
        ], { windowsHide: true, detached: true }).unref();
      } else {
        // 管理员 PowerShell
        const command = `-NoExit -Command cd '${absPath.replace(/'/g, "''")}'`;
        cp.spawn('powershell', [
          '-NoProfile', '-Command',
          `Start-Process powershell.exe -ArgumentList '${command}' -Verb RunAs`
        ], { windowsHide: true, detached: true }).unref();
      }
    } else if (platform === 'darwin') {
      // macOS: 使用 osascript 打开带 sudo 的终端
      const escapedPath = absPath.replace(/"/g, '\\"');
      const script = `
        tell application "Terminal"
          activate
          do script "cd '${escapedPath}' && sudo -s"
        end tell
      `;
      cp.spawn('osascript', ['-e', script], { detached: true }).unref();
    } else {
      // Linux: 尝试常见的终端模拟器
      const escapedPath = absPath.replace(/'/g, "'\"'\"'");
      const sudoCmd = `cd '${escapedPath}' && sudo -s`;

      // 尝试常见的 Linux 终端
      const terminals = [
        { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', sudoCmd + '; exec bash'] },
        { cmd: 'konsole', args: ['-e', 'bash', '-c', sudoCmd + '; exec bash'] },
        { cmd: 'xfce4-terminal', args: ['-e', `bash -c "${sudoCmd}; exec bash"`] },
        { cmd: 'xterm', args: ['-e', `bash -c "${sudoCmd}; exec bash"`] },
        { cmd: 'tilix', args: ['-e', `bash -c "${sudoCmd}; exec bash"`] },
        { cmd: 'alacritty', args: ['-e', 'bash', '-c', sudoCmd + '; exec bash'] },
        { cmd: 'kitty', args: ['bash', '-c', sudoCmd + '; exec bash'] }
      ];

      // 依次尝试打开终端
      (async () => {
        for (const term of terminals) {
          try {
            const exists = await new Promise((resolve) => {
              const child = cp.spawn('which', [term.cmd], { stdio: 'ignore' });
              child.on('close', (code) => resolve(code === 0));
              child.on('error', () => resolve(false));
              setTimeout(() => { try { child.kill(); } catch { } resolve(false); }, 1000);
            });
            if (exists) {
              cp.spawn(term.cmd, term.args, { detached: true, stdio: 'ignore' }).unref();
              geq().logMessage(`Opened admin terminal using ${term.cmd}`, "INFO");
              return;
            }
          } catch { }
        }
        global.showAutoCloseNotification('error', 'No supported terminal emulator found');
      })();
    }

    geq().logMessage(`Opening admin ${termType} at: ${absPath}`, "INFO");
  } catch (e) {
    geq().logMessage(`Failed to open admin terminal: ${e.message}`, "ERROR");
    global.showAutoCloseNotification('error', `Failed to open admin terminal: ${e.message}`);
  }
}

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

  // 文件夹：使用极限优化版 getPathSize（只获取大小，不统计后缀名）
  try {
    const result = await geq().getPathSize(canon);
    if (result && result.success) {
      return Number(result.total_size) || 0;
    }
    return 0;
  } catch (error) {
    global.logMessage(q('q2.log.getFolderSizeError', canon, error.message), "ERROR");
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
const SZ_GB_THRESHOLD = 1000000000; // 1GB
const SZ_GB_COLOR = 'rgb(248, 48, 0)';

// 返回格式化结果：{ text, gbPart, restPart }
function formatFileSizeEx(bytes) {
  const formatted = bytes.toLocaleString();

  // 检查是否超过 1GB
  if (bytes >= SZ_GB_THRESHOLD) {
    const parts = formatted.split(',');
    if (parts.length >= 4) {
      // GB 部分是前 (parts.length - 3) 个部分
      // 例如: "14,111,222,999" -> GB部分是 "14"
      const gbParts = parts.slice(0, parts.length - 3);
      const restParts = parts.slice(parts.length - 3);
      return {
        text: formatted,
        gbPart: gbParts.join(','),
        restPart: ',' + restParts.join(',')
      };
    }
  }
  return { text: formatted, gbPart: '', restPart: '' };
}

function formatFileSize(bytes) {
  // 简单版本，只返回文本
  return bytes.toLocaleString();
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
  return `${year}.${month}.${day} ${hour}:${minute}`;
}

// ★ 9秒自动关闭弹窗 → 已提取到 global.showAutoCloseNotification（唯一真理源）

// ==================== 命令历史管理 ====================
async function addCommandToHistory(key, value) {
  if (!key || !value || !globalContext || !globalContext.globalState) return;
  const fullKey = `q2_${key}_history`;
  let history = globalContext.globalState.get(fullKey, []);
  const existingIndex = history.indexOf(value);
  if (existingIndex > -1) {
    history.splice(existingIndex, 1);
  }
  history.unshift(value);
  const trimmedHistory = history.slice(0, 5);
  await globalContext.globalState.update(fullKey, trimmedHistory);
}

async function getCommandHistory(key) {
  if (!key || !globalContext || !globalContext.globalState) return [];
  const fullKey = `q2_${key}_history`;
  return globalContext.globalState.get(fullKey, []);
}

// ==================== 配置读写 ====================
function getConfig() {
  const defaultConfig = {
    pinnedDirs: [],
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

  // 迁移旧数据：recentDirs → pinnedDirs
  if (Array.isArray(storedConfig.recentDirs) && !Array.isArray(storedConfig.pinnedDirs)) {
    config.pinnedDirs = storedConfig.recentDirs.slice(0, 6);
  }
  delete config.recentDirs;

  // 确保数组字段存在
  if (!Array.isArray(config.pinnedDirs)) config.pinnedDirs = [];
  if (!Array.isArray(config.recycleBin)) config.recycleBin = [];
  // 迁移旧 recycleBin 格式（字符串 → 对象）
  config.recycleBin = config.recycleBin.map(item => {
    if (typeof item === 'string') return { path: item, type: 'dir' };
    if (item && typeof item.path === 'string') return item;
    return null;
  }).filter(Boolean);
  if (typeof config.lineSpacing !== "number") config.lineSpacing = -2;
  if (typeof config.sidebarWidth !== "number") config.sidebarWidth = 100;
  if (typeof config.sidebarRatio !== "number") config.sidebarRatio = 0.2;
  if (typeof config.isPinned !== "boolean") config.isPinned = false;

  // 读取全局设置（通过 ConfigGate 读取）
  try {
    const szDisplayMode = global.getConfig("szDisplayMode") || "nothing";
    const sortBy = global.getConfig("sortBy") || "name";
    const autoWatchChanges = global.getConfig("autoWatchChanges") || false;

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
  pinnedDirs,
  lineSpacing,
  sidebarWidth,
  sidebarRatio,
  recycleBin,
  isPinned
) {
  if (!globalContext) return;

  const newConfig = {
    pinnedDirs,
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
        pinnedDirs: newConfig.pinnedDirs,
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

// ==================== 上次访问目录存储 ====================
// 立即保存，确保即使崩溃也能恢复到最后访问的目录
const LAST_VISITED_DIR_KEY = "qqq_last_visited_dir";

function getLastVisitedDir() {
  if (!globalContext) return null;
  try {
    return globalContext.globalState.get(LAST_VISITED_DIR_KEY) || null;
  } catch { return null; }
}

function saveLastVisitedDir(dirPath) {
  if (!globalContext || !dirPath) return;
  try {
    globalContext.globalState.update(LAST_VISITED_DIR_KEY, dirPath);
  } catch { }
}

// ==================== 精细 SCM 存储 ====================
// 独立存储，与配置分离，避免影响其他配置项
const FINE_SCM_KEY = "qqq_fine_scm";

function getFineSCM(folderPath) {
  if (!globalContext || !folderPath) return { szMode: null, sortBy: null };
  try {
    const allFineSCM = globalContext.globalState.get(FINE_SCM_KEY) || {};
    const key = cacheKeyForPath(folderPath);
    const scm = allFineSCM[key];
    if (scm) {
      return {
        szMode: scm.szMode || null,
        sortBy: scm.sortBy || null
      };
    }
  } catch (e) {
    geq().logMessage(q('q2.log.readScmError', e.message), "WARN");
  }
  return { szMode: null, sortBy: null };
}

function setFineSCMValue(folderPath, szMode, sortBy) {
  if (!globalContext || !folderPath) return;
  try {
    const allFineSCM = globalContext.globalState.get(FINE_SCM_KEY) || {};
    const key = cacheKeyForPath(folderPath);

    // 如果两个都是 null，删除该条目
    if (szMode === null && sortBy === null) {
      delete allFineSCM[key];
    } else {
      allFineSCM[key] = { szMode, sortBy };
    }

    globalContext.globalState.update(FINE_SCM_KEY, allFineSCM);
  } catch (e) {
    geq().logMessage(q('q2.log.saveScmError', e.message), "WARN");
  }
}

// ==================== 历史记录管理（新版） ====================
// recycleBin: [{path, type:'dir'|'file'}] 最多60条，新条目在上方
// pinnedDirs: [string] 最多6条，新条目在下方（仅目录）

function _recycleBinKey(p) {
  return cacheKeyForPath(canonicalizeExistingPath(p) || p);
}

/** 从 recycleBin 中移除指定路径 */
function removeFromRecycleBin(targetPath) {
  const config = getConfig();
  const key = _recycleBinKey(targetPath);
  const newBin = (config.recycleBin || []).filter(item => _recycleBinKey(item.path) !== key);
  if (newBin.length !== (config.recycleBin || []).length) {
    saveConfig(config.pinnedDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, newBin, config.isPinned);
  }
}

/** 向 recycleBin 顶部插入一条记录（去重，且跳过已 pin 的目录） */
function _insertToRecycleBinTop(bin, itemPath, itemType, pinnedDirs) {
  const canon = canonicalizeExistingPath(itemPath);
  if (!canon) return bin;
  // 如果是目录且已在 pinnedDirs 中，不插入
  if (itemType === 'dir' && Array.isArray(pinnedDirs)) {
    const key = cacheKeyForPath(canon);
    if (pinnedDirs.some(d => cacheKeyForPath(d) === key)) return bin;
  }
  const key = cacheKeyForPath(canon);
  const filtered = bin.filter(item => _recycleBinKey(item.path) !== key);
  filtered.unshift({ path: canon, type: itemType });
  return filtered.slice(0, 60);
}

/** 记录目录历史（仅向 recycleBin 添加目录，已 pin 的跳过） */
function recordDirHistory(dirPath) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(dirPath);
  if (!canon || !fs.existsSync(canon)) return;
  // 已在 pinnedDirs 中，不重复进入回收站
  const key = cacheKeyForPath(canon);
  if ((config.pinnedDirs || []).some(d => cacheKeyForPath(d) === key)) return;
  const newBin = _insertToRecycleBinTop(config.recycleBin || [], canon, 'dir', config.pinnedDirs);
  saveConfig(config.pinnedDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, newBin, config.isPinned);
}

/** 记录文件历史（向 recycleBin 添加目录+文件对，目录在上文件在下） */
function recordFileHistory(filePath) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(filePath);
  if (!canon) return;
  const dirCanon = canonicalizeExistingPath(path.dirname(canon));
  if (!dirCanon) return;
  // 先移除两者的旧记录
  const dirKey = cacheKeyForPath(dirCanon);
  const fileKey = cacheKeyForPath(canon);
  let bin = (config.recycleBin || []).filter(item => {
    const k = _recycleBinKey(item.path);
    return k !== dirKey && k !== fileKey;
  });
  // 插入顺序：目录在上，文件在下——但已 pin 的目录不插入
  const pinnedKeys = new Set((config.pinnedDirs || []).map(d => cacheKeyForPath(d)));
  const toInsert = [];
  if (!pinnedKeys.has(dirKey)) {
    toInsert.push({ path: dirCanon, type: 'dir' });
  }
  toInsert.push({ path: canon, type: 'file' });
  bin.unshift(...toInsert);
  bin = bin.slice(0, 60);
  saveConfig(config.pinnedDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, bin, config.isPinned);
}

/** 图钉目录：从 recycleBin 移至 pinnedDirs 底部（最多6条，溢出时自动解除最老的） */
function pinDirectory(dirPath) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(dirPath);
  if (!canon || !fs.existsSync(canon)) return;
  const key = cacheKeyForPath(canon);
  // 从 pinnedDirs 去重
  let pinned = (config.pinnedDirs || []).filter(d => cacheKeyForPath(d) !== key);
  // 从 recycleBin 移除该目录
  let bin = (config.recycleBin || []).filter(item => _recycleBinKey(item.path) !== key);
  // 加到 pinnedDirs 底部
  pinned.push(canon);
  // 如果超出6条，把最老的（第一条）放回 recycleBin 顶部
  while (pinned.length > 6) {
    const removed = pinned.shift();
    const removedCanon = canonicalizeExistingPath(removed);
    if (removedCanon && fs.existsSync(removedCanon)) {
      bin = _insertToRecycleBinTop(bin, removedCanon, 'dir');
    }
  }
  saveConfig(pinned, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, bin, config.isPinned);
}

/** 解除图钉：从 pinnedDirs 移至 recycleBin 顶部 */
function unpinDirectory(dirPath) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(dirPath);
  if (!canon) return;
  const key = cacheKeyForPath(canon);
  const pinned = (config.pinnedDirs || []).filter(d => cacheKeyForPath(d) !== key);
  let bin = config.recycleBin || [];
  if (fs.existsSync(canon)) {
    bin = _insertToRecycleBinTop(bin, canon, 'dir');
  }
  saveConfig(pinned, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, bin, config.isPinned);
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
    global.logMessage(q('q2.log.readDirError', canonDir, error.message), "ERROR");
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

let sessionSizeCache = new Map(); // path -> { text, gbPart, restPart }
let currentSizeMode = 'nothing'; // 当前 sz 区显示模式

let resizeObserver = null;
const MIN_RESPONSIVE_WIDTH = 240;
const MIN_TAG_WIDTH = 170;
const PIN_HIDE_WIDTH = 360;
let baseRecentHeight = 0;

let pathTooltipEl = null;
let pathTooltipVisible = false;

// ====== 回收站懒加载 ======
let recycleBinLoading = false;
const RECYCLE_BATCH_SIZE = 20;

// ====== 逐字撤销/重做系统 ======
// 为所有编辑框提供逐字级别的 Ctrl+Z / Ctrl+Y 功能
const inputUndoStacks = new WeakMap(); // input -> { history: [], index: -1, lastValue: '', isProgrammatic: false }

function getInputUndoState(input) {
  if (!inputUndoStacks.has(input)) {
    inputUndoStacks.set(input, {
      history: [input.value || ''],
      index: 0,
      lastValue: input.value || '',
      isProgrammatic: false
    });
  }
  return inputUndoStacks.get(input);
}

function initInputUndoRedo(input) {
  if (!input || input._undoRedoInitialized) return;
  input._undoRedoInitialized = true;

  const state = getInputUndoState(input);

  // 监听键入变化，记录每次改变
  input.addEventListener('input', () => {
    const st = getInputUndoState(input);

    // 如果是程序触发的撤销/重做，不记录历史
    if (st.isProgrammatic) {
      st.isProgrammatic = false;
      return;
    }

    const currentValue = input.value;

    // 如果当前不在历史末尾，截断后面的历史
    if (st.index < st.history.length - 1) {
      st.history = st.history.slice(0, st.index + 1);
    }

    // 只有当值真正变化时才记录
    if (currentValue !== st.lastValue) {
      st.history.push(currentValue);
      st.index = st.history.length - 1;
      st.lastValue = currentValue;
    }
  });

  // 拦截 Ctrl+Z 和 Ctrl+Y
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.stopPropagation();
      const st = getInputUndoState(input);
      if (st.index > 0) {
        st.index--;
        st.isProgrammatic = true;
        input.value = st.history[st.index];
        st.lastValue = input.value;
        // 触发 input 事件以便其他监听器能响应
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      e.stopPropagation();
      const st = getInputUndoState(input);
      if (st.index < st.history.length - 1) {
        st.index++;
        st.isProgrammatic = true;
        input.value = st.history[st.index];
        st.lastValue = input.value;
        // 触发 input 事件
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
  });
}

function resetInputUndoState(input, initialValue) {
  if (!input) return;
  const val = initialValue !== undefined ? initialValue : (input.value || '');
  inputUndoStacks.set(input, {
    history: [val],
    index: 0,
    lastValue: val,
    isProgrammatic: false
  });
}

// ====== 盘符剩余空间更新机制 ======
// 规则：
// - 只在 webview 可见时轮询（6秒间隔）
// - 合批请求：一次请求返回所有盘符的完整答卷
// - 最终答卷比较：只有不同于上次答卷时才更新 UI
// - 空间 < 1% 或 < 2GB 时显示红色警告（并显示小数位）
const DISK_FREE_INTERVAL_MS = 6000;
const DISK_FREE_WARNING_PERCENT = 0.01; // 1%
const DISK_FREE_WARNING_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const DISK_FREE_WARNING_COLOR = 'rgb(248, 48, 0)';
let diskFreeTimer = null;
let lastDiskFreeSnapshot = ''; // 上次答卷的 JSON 序列化，用于比较
let diskFreeInFlight = false;

// ====== 精细 SCM 系统 ======
// 当前文件夹的精细 SCM 设置（从后端传来）
let currentFineSCM = { szMode: null, sortBy: null };

// ====== 命令历史下拉框 ======
function hideAllDropdowns() {
    const dropdowns = document.querySelectorAll('.history-dropdown');
    dropdowns.forEach(d => d.style.display = 'none');
}

function showHistoryDropdown(inputEl, dropdownEl, history) {
    hideAllDropdowns();
    // ★ 加固：只有当键入框持有焦点时才弹出下拉框
    if (document.activeElement !== inputEl) return;
    if (!history || history.length === 0) return;
    dropdownEl.innerHTML = '';
    history.forEach(itemText => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'history-dropdown-item';
        itemDiv.textContent = itemText;
        itemDiv.setAttribute('data-tooltip', itemText);
        itemDiv.onclick = () => {
            inputEl.value = itemText;
            hideAllDropdowns();
            inputEl.focus();
            // ★ For file filter, trigger input event to apply filter
            if (inputEl.id === 'fileFilterInput') {
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        dropdownEl.appendChild(itemDiv);
    });
    dropdownEl.style.display = 'block';
}


function updateFineSCMButtons() {
  // 更新左侧 szMode 按钮
  const szModeGroup = document.getElementById('szModeGroup');
  if (szModeGroup) {
    szModeGroup.querySelectorAll('.scm-btn').forEach(btn => {
      const mode = btn.dataset.mode;
      if (currentFineSCM.szMode === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  // 更新右侧 sortBy 按钮
  const sortByGroup = document.getElementById('sortByGroup');
  if (sortByGroup) {
    sortByGroup.querySelectorAll('.scm-btn').forEach(btn => {
      const sort = btn.dataset.sort;
      if (currentFineSCM.sortBy === sort) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
}

function handleSzModeClick(mode) {
  // 如果已经选中，再次点击 = 取消
  const newMode = (currentFineSCM.szMode === mode) ? null : mode;
  currentFineSCM.szMode = newMode;
  updateFineSCMButtons();
  // 发送给后端保存并刷新
  vscode.postMessage({
    command: 'setFineSCM',
    path: currentPath,
    szMode: newMode,
    sortBy: currentFineSCM.sortBy
  });
}

function handleSortByClick(sort) {
  // 如果已经选中，再次点击 = 取消
  const newSort = (currentFineSCM.sortBy === sort) ? null : sort;
  currentFineSCM.sortBy = newSort;
  updateFineSCMButtons();
  // 发送给后端保存并刷新
  vscode.postMessage({
    command: 'setFineSCM',
    path: currentPath,
    szMode: currentFineSCM.szMode,
    sortBy: newSort
  });
}

function handleOpenFolderClick() {
  // 在默认资源管理器中打开当前文件夹
  vscode.postMessage({
    command: 'openWithDefault',
    path: currentPath,
    type: 'folder'
  });
}

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
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;

  // 先以单行测量实际宽度
  pathTooltipEl.style.whiteSpace = 'nowrap';
  pathTooltipEl.style.maxWidth = '';
  pathTooltipEl.style.left = '0px';
  pathTooltipEl.style.top = '0px';
  pathTooltipEl.style.display = 'block';
  pathTooltipVisible = true;

  const naturalWidth = pathTooltipEl.offsetWidth;

  // 判断单行能否放得下：左对齐或右对齐任一方式不超出视口
  const leftAlignOk = (clientX + margin + naturalWidth) <= vw - 4;
  const rightAlignOk = (clientX - margin - naturalWidth) >= 4;

  if (leftAlignOk || rightAlignOk) {
    // 单行显示
    pathTooltipEl.style.whiteSpace = 'nowrap';
    pathTooltipEl.style.maxWidth = '';
    let left = leftAlignOk ? (clientX + margin) : (clientX - margin - naturalWidth);
    let top = clientY + margin;
    pathTooltipEl.style.left = left + 'px';
    pathTooltipEl.style.top = top + 'px';
    // 垂直越界保护
    const rect = pathTooltipEl.getBoundingClientRect();
    if (rect.bottom > vh - 4) {
      pathTooltipEl.style.top = Math.max(4, vh - rect.height - 4) + 'px';
    }
  } else {
    // 两边都放不下，允许换行
    pathTooltipEl.style.whiteSpace = 'pre-wrap';
    pathTooltipEl.style.maxWidth = (vw - 8) + 'px';
    let left = 4;
    let top = clientY + margin;
    pathTooltipEl.style.left = left + 'px';
    pathTooltipEl.style.top = top + 'px';
    const rect = pathTooltipEl.getBoundingClientRect();
    if (rect.bottom > vh - 4) {
      pathTooltipEl.style.top = Math.max(4, vh - rect.height - 4) + 'px';
    }
  }
}

function isEllipsisActive(el){
  if (!el) return false;
  // 方法1: 标准 scrollWidth 检查（对大多数 block/flex-child 有效）
  if (el.scrollWidth > el.clientWidth + 1) return true;
  // 方法2: Range 测量兜底（对 button 等 scrollWidth 不可靠的元素有效）
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const contentW = range.getBoundingClientRect().width;
    const cs = getComputedStyle(el);
    const availW = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (contentW > availW + 1) return true;
  } catch(_) {}
  return false;
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

// ====== 统一 pathTooltip hover 处理（覆盖全部4个区域） ======
// 区域1: 盘符区 .nav-item  区域2: 回收站区 .recycle-item
// 区域3: 历史区 .recent-item  区域4: 资源列表区 .file-item
function handlePathTooltipHover(e){
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;

  // ---- 区域1: 盘符区 (.nav-item button) ----
  const navItem = t.closest('.nav-item');
  if (navItem) {
    if (isEllipsisActive(navItem)) {
      showPathTooltip(navItem.textContent.trim(), e.clientX, e.clientY);
    } else if (pathTooltipVisible) { hidePathTooltip(); }
    return;
  }

  // ---- 区域2: 回收站区 (.recycle-item) ----
  const recycleItem = t.closest('.recycle-item');
  if (recycleItem) {
    // 文件行：无条件弹出完整路径（显示的只是文件名，完整路径始终有意义）
    if (recycleItem.classList.contains('recycle-file')) {
      const tip = recycleItem.getAttribute('data-fullpath') || '';
      if (tip) { showPathTooltip(tip, e.clientX, e.clientY); }
      else if (pathTooltipVisible) { hidePathTooltip(); }
      return;
    }
    // 目录行：仅截断时弹出
    const textEl = recycleItem.querySelector('.recycle-text');
    const checkEl = textEl || recycleItem;
    if (isEllipsisActive(checkEl)) {
      const tip = recycleItem.getAttribute('data-fullpath') || (textEl ? textEl.textContent : recycleItem.textContent || '').trim();
      showPathTooltip(tip, e.clientX, e.clientY);
    } else if (pathTooltipVisible) { hidePathTooltip(); }
    return;
  }

  // ---- 区域3: 历史区 (.recent-item) ----
  const recentItem = t.closest('.recent-item');
  if (recentItem) {
    const span = recentItem.querySelector('span:not(.delete-button)');
    const checkEl = span || recentItem;
    if (isEllipsisActive(checkEl)) {
      showPathTooltip(span ? span.textContent.trim() : recentItem.textContent.trim(), e.clientX, e.clientY);
    } else if (pathTooltipVisible) { hidePathTooltip(); }
    return;
  }

  // ---- 区域4: 资源列表区 (.file-item) ----
  const fileItem = t.closest('.file-item');
  if (fileItem) {
    const nameArea = fileItem.querySelector('.folder-name-area, .file-name-area');
    if (nameArea && isEllipsisActive(nameArea)) {
      showPathTooltip(fileItem.getAttribute('data-path') || fileItem.getAttribute('data-name') || '', e.clientX, e.clientY);
    } else if (pathTooltipVisible) { hidePathTooltip(); }
    return;
  }

  // 不在任何目标元素上
  if (pathTooltipVisible) hidePathTooltip();
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
  const kyContent = document.querySelector('.ky-content');
  if (!container) return;

  const pageW = container.clientWidth;
  const footer = document.querySelector('.footer');
  const pinContainer = document.getElementById('pinButton');
  const saveButton = footer ? footer.querySelector('.save-button') : null;
  const createFolderBtn = footer ? footer.querySelector('.cancel-button') : null;

  // footer: 按页面宽度计算
  if (pinContainer) pinContainer.style.display = (pageW < PIN_HIDE_WIDTH) ? 'none' : 'block';

  if (pageW < MIN_RESPONSIVE_WIDTH) {
    if (saveButton) saveButton.style.display = 'none';
    if (createFolderBtn) createFolderBtn.style.display = 'block';
    if (footer) footer.classList.add('responsive-narrow');
  } else {
    if (saveButton) saveButton.style.display = 'block';
    if (createFolderBtn) createFolderBtn.style.display = 'block';
    if (footer) footer.classList.remove('responsive-narrow');
  }

  if (pageW < MIN_TAG_WIDTH) {
    if (createFolderBtn) createFolderBtn.style.display = 'none';
    if (footer) footer.classList.add('responsive-extreme');
  } else {
    if (footer) footer.classList.remove('responsive-extreme');
  }

  // 地址栏一排：按右侧面板宽度计算
  if (kyContent) {
    const rw = kyContent.clientWidth;
    const sortByGroup = document.getElementById('sortByGroup');
    const szModeGroup = document.getElementById('szModeGroup');
    const filterWrapper = document.querySelector('.filter-input-wrapper');

    if (sortByGroup) sortByGroup.style.display = (rw < 340) ? 'none' : '';
    if (filterWrapper) filterWrapper.style.display = (rw < 340) ? 'none' : '';
    if (szModeGroup) szModeGroup.style.display = (rw < 200) ? 'none' : '';
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

function unpinDir(p){ vscode.postMessage({ command: 'unpinDirectory', path: p }); }
function pinDir(p){ vscode.postMessage({ command: 'pinDirectory', path: p }); }
function onRecycleFileClick(p){ vscode.postMessage({ command: 'recycleFileClick', path: p }); }
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
  if (['filenameInput', 'addressInput', 'fileFilterInput'].includes(element.id) || element.classList.contains('rename-input')) currentFocusType = 'input';
  else if (element.classList.contains('file-list-container') || element.closest('.file-list-container')) currentFocusType = 'fileList';
  else if (element.classList.contains('sidebar') || element.closest('.sidebar')) currentFocusType = 'sidebar';
  else if (element.classList.contains('recent-section') || element.closest('.recent-section')) currentFocusType = 'recentSection';
  else currentFocusType = 'other';
}

function selectFileItem(fileItem, requestSize, shiftPressed = false){
  if (!fileItem) return;

  // 关键：选择项目时，如果当前焦点在键入框，则强制失去焦点，以便热键生效
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
      if (szArea) {
        const cached = sessionSizeCache.get(p);
        if (cached.gbPart) {
          szArea.innerHTML = '<span style="color:rgb(248,48,0)">' + cached.gbPart + '</span>' + cached.restPart + ' ';
        } else {
          szArea.textContent = cached.text;
        }
      }
      return;
    }
    const szArea = fileItem.querySelector('.sz-area');
    if (szArea) szArea.textContent = '    \\u2022    ';
    vscode.postMessage({ command: 'requestSize', path: p, type });
  }
}

let renameBlurHandler = null;
let renameMouseHandler = null;
let renameContextMenuHandler = null;
let renameWheelHandler = null;
let renameMiddleClickHandler = null;

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

  // ★ 初始化逐字撤销/重做功能
  initInputUndoRedo(input);
  resetInputUndoState(input, itemName);

  const dotIndex = itemName.lastIndexOf('.');
  if (dotIndex > 0) input.setSelectionRange(0, dotIndex);
  else input.select();

  currentFocusType = 'input';

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      commitRename(itemElement, itemPath, itemType, input.value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      cancelRename(itemElement, originalContent);
    }
  };

  // ★ 点击处理：编辑框内点击移动光标，编辑框外点击等于保存
  renameMouseHandler = (e) => {
    if (e.button !== 0) return; // 只处理左键
    if (input.contains(e.target) || e.target === input) {
      // 点击编辑框内：不做任何处理，让光标自然移动
      return;
    }
    // 点击编辑框外：等于按回车保存
    e.preventDefault();
    e.stopPropagation();
    commitRename(itemElement, itemPath, itemType, input.value.trim());
  };

  // ★ 屏蔽编辑过程中的右键菜单
  renameContextMenuHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // ★ 屏蔽编辑过程中的滚轮事件
  renameWheelHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // ★ 屏蔽编辑过程中的中键点击
  renameMiddleClickHandler = (e) => {
    if (e.button === 1) { // 中键
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // 注册事件监听（使用 capture 确保优先拦截）
  document.addEventListener('mousedown', renameMouseHandler, true);
  document.addEventListener('contextmenu', renameContextMenuHandler, true);
  document.addEventListener('wheel', renameWheelHandler, { capture: true, passive: false });
  document.addEventListener('auxclick', renameMiddleClickHandler, true);

  input.addEventListener('keydown', handleKeyDown);
  itemElement.dataset.originalContent = originalContent;
}

function commitRename(itemElement, oldPath, itemType, newName){
  const input = itemElement.querySelector('.rename-input');
  if (!input) return;
  cleanupRenameHandlers();
  currentFocusType = 'fileList';
  const oldName = itemElement.dataset.name;

  if (newName && newName !== oldName) {
    vscode.postMessage({ command: 'renameItem', oldPath, newName, itemType });
  } else {
    cancelRename(itemElement, itemElement.dataset.originalContent);
  }
}

function cleanupRenameHandlers() {
  if (renameMouseHandler) {
    document.removeEventListener('mousedown', renameMouseHandler, true);
    renameMouseHandler = null;
  }
  if (renameContextMenuHandler) {
    document.removeEventListener('contextmenu', renameContextMenuHandler, true);
    renameContextMenuHandler = null;
  }
  if (renameWheelHandler) {
    document.removeEventListener('wheel', renameWheelHandler, { capture: true, passive: false });
    renameWheelHandler = null;
  }
  if (renameMiddleClickHandler) {
    document.removeEventListener('auxclick', renameMiddleClickHandler, true);
    renameMiddleClickHandler = null;
  }
  renameBlurHandler = null;
}

function cancelRename(itemElement, originalContent){
  const input = itemElement.querySelector('.rename-input');
  if (!input) return;
  cleanupRenameHandlers();
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
    } else if (action === 'rename') {
      // 多选时禁止重命名
      vscode.postMessage({ command: 'showAutoCloseMessage', type: 'warning', message: 'qqq: 请单选再做重命名' });
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

    if (message.command === 'historyData') {
        if (message.key === 'fileFilter') {
            const input = document.getElementById('fileFilterInput');
            const dropdown = document.getElementById('fileFilterHistoryDropdown');
            if (input && dropdown) {
                showHistoryDropdown(input, dropdown, message.history);
            }
        } else if (message.key === 'address') {
            const input = document.getElementById('addressInput');
            const dropdown = document.getElementById('addressHistoryDropdown');
            if (input && dropdown) {
                showHistoryDropdown(input, dropdown, message.history);
            }
        }
        return;
    }

    // ★ 地址栏导航成功后：保存历史并失去焦点
    if (message.command === 'navigateSuccess') {
        const addr = document.getElementById('addressInput');
        if (message.path) {
            vscode.postMessage({ command: 'saveHistory', key: 'address', value: message.path });
        }
        if (addr) {
            addr.blur();
        }
        hideAllDropdowns();
        return;
    }

  if (message.command === 'update') {
      const newSizeMode = message.sizeMode || 'nothing';
      const isModeChanged = newSizeMode !== currentSizeMode;
      const isNewDir = (message.currentPath || '') !== currentPath;

      // 模式切换或目录切换时，清除缓存
      if (isNewDir || isModeChanged) {
        sessionSizeCache.clear();
      }

      // ★ 切换目录时清空筛选框
      if (isNewDir) {
        const fileFilterInput = document.getElementById('fileFilterInput');
        if (fileFilterInput) {
          fileFilterInput.value = '';
          // 重置文件列表显示（不触发 input 事件，避免弹出下拉列表）
          const fileItems = document.querySelectorAll('.file-item');
          fileItems.forEach(item => {
            item.style.display = '';
          });
        }
        hideAllDropdowns();
      }

      // 更新当前模式
      currentSizeMode = newSizeMode;
      currentPath = message.currentPath || '';

      // ★ 更新精细 SCM 状态
      currentFineSCM = {
        szMode: message.fineSCM?.szMode || null,
        sortBy: message.fineSCM?.sortBy || null
      };
      updateFineSCMButtons();

      const addr = document.getElementById('addressInput');
      if (addr) {
        addr.value = message.currentPath || '';
        updateAddressDisplay(addr.value);
        // 更新 tooltip 为当前地址
        addr.setAttribute('data-tooltip', addr.value || '');
      }

      const list = document.getElementById('fileList');
      if (list) {
        // ★ 同目录刷新（SCM 切换等）：保存当前选中状态
        const lastSelPath = lastSelectedItem ? lastSelectedItem.dataset?.path : null;

        // 重新渲染列表（后端已预填充 sz-area 内容）
        list.innerHTML = message.fileListHtml || '';

        // 从缓存恢复 sz-area 显示（优先使用缓存值，可能是 s 请求结果）
        const allItems = list.querySelectorAll('.file-item');
        allItems.forEach(item => {
          const p = item.dataset.path;
          if (sessionSizeCache.has(p)) {
            const cached = sessionSizeCache.get(p);
            const szArea = item.querySelector('.sz-area');
            if (szArea) {
              if (cached.gbPart) {
                szArea.innerHTML = '<span style="color:rgb(248,48,0)">' + cached.gbPart + '</span>' + cached.restPart + ' ';
              } else {
                szArea.textContent = cached.text;
              }
            }
          }
        });

        // ★ 恢复选中状态：同目录刷新时保持单选/多选红色高亮
        if (!isNewDir && selectedItems.length > 0) {
          const selectedPaths = new Set(selectedItems.map(s => s.path));
          let newLastSelected = null;
          let restoredCount = 0;
          allItems.forEach(item => {
            if (selectedPaths.has(item.dataset.path)) {
              item.classList.add('selected');
              restoredCount++;
              if (item.dataset.path === lastSelPath) newLastSelected = item;
            }
          });
          if (restoredCount > 0) {
            lastSelectedItem = newLastSelected || lastSelectedItem;
          } else {
            selectedItems = [];
            selectedItem = null;
            lastSelectedItem = null;
          }
        }

        // ★ 切换目录时清空选中状态
        if (isNewDir) {
          selectedItems = [];
          selectedItem = null;
          lastSelectedItem = null;
        }
      }

      // 注：后端已预填充 sz-area，不需要再主动请求
      // requestFileSizeUpdates 只在 s 请求时使用

      setTimeout(() => { calculateAndAdjustScroll(); checkAndApplyResponsive(); }, 100);
    } else if (message.command === 'updateSizeBatch') {
      (message.results || []).forEach(res => {
        // 只有确实拿到了尺寸字符串才缓存（避免缓存空的或错误提示）
        if (res.sizeDisplay && !res.sizeDisplay.includes('err')) {
          sessionSizeCache.set(res.path, {
            text: res.sizeDisplay,
            gbPart: res.gbPart || '',
            restPart: res.restPart || ''
          });
        }

        const el = findItemElementByPath(res.path, res.type);
        if (el) {
          const sz = el.querySelector('.sz-area');
          if (sz) {
            // 如果有 GB 部分，用 innerHTML 显示红色
            if (res.gbPart) {
              sz.innerHTML = '<span style="color:rgb(248,48,0)">' + res.gbPart + '</span>' + res.restPart + ' ';
            } else {
              sz.textContent = res.sizeDisplay || '';
            }
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
  } else if (message.command === 'updateSidebar') {
      // 动态更新 sidebar 区域
      const recycleSec = document.querySelector('.sidebar .recycle-bin-section');
      const divider = document.querySelector('.sidebar .divider');
      if (message.recycleBinHtml) {
        // 有内容：替换或插入
        const temp = document.createElement('div');
        temp.innerHTML = message.recycleBinHtml;
        const newDivider = temp.querySelector('.divider');
        const newSection = temp.querySelector('.recycle-bin-section');
        if (recycleSec && divider) {
          divider.replaceWith(newDivider || document.createElement('div'));
          recycleSec.replaceWith(newSection || document.createElement('div'));
        } else if (newDivider && newSection) {
          const sidebar = document.querySelector('.sidebar');
          if (sidebar) { sidebar.appendChild(newDivider); sidebar.appendChild(newSection); }
        }
      } else {
        // 没内容：移除
        if (recycleSec) recycleSec.remove();
        if (divider) divider.remove();
      }
      // 更新图钉历史区
      const recentList = document.querySelector('.recent-list');
      if (recentList) recentList.innerHTML = message.pinnedDirsHtml || '';
  } else if (message.command === 'updateSidebarRatio') {
    sidebarRatio = message.ratio;
    adjustSidebarByRatio();
  } else if (message.command === 'focusInput') {
    const f = document.getElementById('filenameInput');
    if (f) { f.focus(); f.select(); }
  } else if (message.command === 'diskFreeResult') {
    // 合批答卷返回：{ data: { 'C': {free, total}, 'D': {free, total}, ... } }
    diskFreeInFlight = false;
    const data = message.data;
    if (data && typeof data === 'object') {
      // 答卷比较：JSON 序列化后比较
      const snapshot = JSON.stringify(data);
      if (snapshot !== lastDiskFreeSnapshot) {
        lastDiskFreeSnapshot = snapshot;
        // 批量更新所有盘符显示
        for (const drive in data) {
          const info = data[drive];
          updateDriveDisplay(drive, info.free, info.total);
        }
      }
    }
    // 完成后安排下一轮
    scheduleDiskFreeUpdate();
  } else if (message.command === 'appendRecycleBin') {
    // 回收站懒加载：追加新条目
    const section = document.querySelector('.recycle-bin-section');
    if (section && message.itemsHtml) {
      section.insertAdjacentHTML('beforeend', message.itemsHtml);
      section.dataset.loaded = message.loaded;
      section.dataset.total = message.total;
      recycleBinLoading = false;
    }
  }
});

// ====== 回收站滚动懒加载 ======
function initRecycleBinLazyLoad() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  sidebar.addEventListener('scroll', () => {
    if (recycleBinLoading) return;

    const section = document.querySelector('.recycle-bin-section');
    if (!section) return;

    const total = parseInt(section.dataset.total || '0', 10);
    const loaded = parseInt(section.dataset.loaded || '0', 10);

    // 已加载完毕
    if (loaded >= total) return;

    // 检查是否滚动到底部附近（距离底部 100px 内）
    if (sidebar.scrollTop + sidebar.clientHeight > sidebar.scrollHeight - 100) {
      recycleBinLoading = true;
      vscode.postMessage({
        command: 'requestRecycleBin',
        offset: loaded,
        limit: RECYCLE_BATCH_SIZE
      });
    }
  });
}

// ====== DOM ======
document.addEventListener('focusin', (e) => updateFocusType(e.target));
document.addEventListener('click', (e) => {
  hideAllContextMenus();
  if (!['filenameInput', 'addressInput', 'fileFilterInput'].includes((e.target && e.target.id) || '') && !(e.target && e.target.classList && e.target.classList.contains('rename-input'))) {
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
    if (selectedItems.length > 1) {
      // 多选时禁止重命名
      vscode.postMessage({ command: 'showAutoCloseMessage', type: 'warning', message: 'qqq: 请单选再做重命名' });
      return;
    }
    if (selectedItem && selectedItem.name !== '..') {
        performEditAction(selectedItem);
    }
  } else if (e.key === 'Delete' && e.shiftKey) {
    // Shift+Delete: 永久删除，无确认提示
    e.preventDefault(); e.stopPropagation();
    if (selectedItems.length > 1) {
      // 多选永久删除
      const targets = selectedItems.filter(item => item.name !== '..');
      if (targets.length > 0) {
        targets.forEach(item => {
          const el = findItemElementByPath(item.path);
          if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
        });
        vscode.postMessage({ command: 'quickPermanentDeleteMultiple', items: targets });
        selectedItem = null;
        selectedItems = [];
      }
    } else if (selectedItem && selectedItem.name !== '..') {
      // 单选永久删除
      const el = findItemElementByPath(selectedItem.path);
      if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
      vscode.postMessage({ command: 'quickPermanentDelete', path: selectedItem.path, type: selectedItem.type });
      selectedItem = null;
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  ensurePathTooltip();
  initRecycleBinLazyLoad(); // 初始化回收站懒加载

  // ★ 禁用系统默认右键菜单
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  }, false);

  // ★ 全局自定义 tooltip 系统
  const globalTooltip = document.getElementById('globalTooltip');
  if (globalTooltip) {
    let currentTooltipTarget = null;

    // 为所有带有 data-tooltip 的元素添加 tooltip 事件
    document.addEventListener('mouseenter', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const target = e.target.closest('[data-tooltip]');
      if (target) {
        currentTooltipTarget = target;
        const text = target.getAttribute('data-tooltip');
        if (text) {
          // 先以单行测量，防止提前换行
          globalTooltip.style.whiteSpace = 'nowrap';
          globalTooltip.style.maxWidth = '';
          globalTooltip.textContent = text;
          globalTooltip.style.display = 'block';
        }
      }
    }, true);

    document.addEventListener('mousemove', (e) => {
      if (globalTooltip.style.display === 'block' && currentTooltipTarget) {
        const pageWidth = window.innerWidth;
        const leftPadding = 10; // 左边界留白
        const rightPadding = 0; // 右边界不留白，可以延伸到滚动条区域

        // 先以 nowrap 测量自然宽度
        globalTooltip.style.whiteSpace = 'nowrap';
        globalTooltip.style.maxWidth = '';
        const naturalWidth = globalTooltip.offsetWidth;

        // 判断元素位置类别，决定 tooltip 对齐方式
        const isLeftScmButton = currentTooltipTarget.classList.contains('scm-btn') &&
                                currentTooltipTarget.closest('#szModeGroup');
        const isOpenButton = currentTooltipTarget.classList.contains('open-btn');
        const isRightSideButton = currentTooltipTarget.classList.contains('save-button') ||
                                  currentTooltipTarget.classList.contains('cancel-button') ||
                                  (currentTooltipTarget.classList.contains('scm-btn') &&
                                   currentTooltipTarget.closest('#sortByGroup'));

        // 垂直位置
        if (currentTooltipTarget.classList.contains('save-button') ||
            currentTooltipTarget.classList.contains('cancel-button')) {
          globalTooltip.style.top = (e.clientY - 44) + 'px';
        } else {
          globalTooltip.style.top = (e.clientY + 22) + 'px';
        }

        // 计算初始位置
        let leftPos;
        if (isLeftScmButton || isOpenButton) {
          leftPos = e.clientX - 11;
        } else if (isRightSideButton) {
          leftPos = e.clientX - naturalWidth + 11;
        } else {
          // 默认/地址框：居中
          leftPos = e.clientX - naturalWidth / 2;
        }

        // 检查边界
        const overflowLeft = leftPos < leftPadding;
        const overflowRight = leftPos + naturalWidth > pageWidth - rightPadding;

        // 只有左右两边都被截断时才自动换行
        if (overflowLeft && overflowRight) {
          const availableWidth = pageWidth - leftPadding - rightPadding;
          if (availableWidth > 50) {
            globalTooltip.style.whiteSpace = 'pre-wrap';
            globalTooltip.style.maxWidth = availableWidth + 'px';
            leftPos = leftPadding;
          }
        } else if (overflowLeft) {
          // 只有左边超出，向右躲避，保持单行
          leftPos = leftPadding;
        } else if (overflowRight) {
          // 只有右边超出，向左躲避，保持单行
          leftPos = pageWidth - naturalWidth - rightPadding;
        }

        // 重新获取宽度（可能已经换行）
        const tooltipWidth = globalTooltip.offsetWidth;

        // 最终边界保护
        if (leftPos + tooltipWidth > pageWidth - rightPadding) {
          leftPos = pageWidth - tooltipWidth - rightPadding;
        }
        if (leftPos < leftPadding) {
          leftPos = leftPadding;
        }

        globalTooltip.style.left = leftPos + 'px';
      }
    }, true);

    document.addEventListener('mouseleave', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const target = e.target.closest('[data-tooltip]');
      if (target) {
        currentTooltipTarget = null;
        globalTooltip.style.display = 'none';
      }
    }, true);
  }

  const filenameInput = document.getElementById('filenameInput');
  if (filenameInput) {
    filenameInput.focus();
    // ★ 初始化逐字撤销/重做功能
    initInputUndoRedo(filenameInput);
    filenameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveFile();
    });
  }

  // ★ 地址栏逻辑（带历史下拉框）
  const addressInput = document.getElementById('addressInput');
  const addressHistoryDropdown = document.getElementById('addressHistoryDropdown');
  if (addressInput && addressHistoryDropdown) {
    initInputUndoRedo(addressInput);
    addressInput.addEventListener('input', (e) => {
      updateAddressDisplay(e.target.value);
      // 动态更新 tooltip 为当前地址
      addressInput.setAttribute('data-tooltip', e.target.value || '');
      // 有键入先隐藏下拉框，然后判断是否为空
      hideAllDropdowns();
      if (addressInput.value === '') {
        vscode.postMessage({ command: 'getHistory', key: 'address' });
      }
    });
    // 初始设置 tooltip
    addressInput.setAttribute('data-tooltip', addressInput.value || '');

    addressInput.addEventListener('focus', () => {
      if (addressInput.value === '') {
        vscode.postMessage({ command: 'getHistory', key: 'address' });
      }
    });

    addressInput.addEventListener('blur', (e) => {
      const relatedTarget = e.relatedTarget;
      const isDropdownElement = relatedTarget && addressHistoryDropdown.contains(relatedTarget);
      if (!isDropdownElement) {
        hideAllDropdowns();
      }
    });

    addressHistoryDropdown.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    addressInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const p = addressInput.value.trim();
        if (p) {
          vscode.postMessage({ command: 'navigate', path: p });
          // ★ 不在这里保存历史，等待后端 navigateSuccess 消息
        }
        hideAllDropdowns();
      } else if (e.key === 'Escape') {
        hideAllDropdowns();
      } else if (e.key === ' ') {
        // 空格键隐藏下拉框（空格不算无文本，所以隐藏）
        hideAllDropdowns();
      }
    });

    // 点击下拉框 item
    addressHistoryDropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.history-dropdown-item');
      if (item) {
        addressInput.value = item.textContent;
        hideAllDropdowns();
        addressInput.focus();
        const p = addressInput.value.trim();
        if (p) vscode.postMessage({ command: 'navigate', path: p });
      }
    });
  }

    // ★ 新增：文件筛选键入框逻辑（改进版）
    const fileFilterInput = document.getElementById('fileFilterInput');
    const fileFilterDropdown = document.getElementById('fileFilterHistoryDropdown');
    if (fileFilterInput && fileFilterDropdown) {
        initInputUndoRedo(fileFilterInput);

        fileFilterInput.addEventListener('input', () => {
            // 有键入先隐藏下拉框
            hideAllDropdowns();

            // 如果为空，请求历史
            if (fileFilterInput.value === '') {
                vscode.postMessage({ command: 'getHistory', key: 'fileFilter' });
            }

            // 执行筛选
            const filterText = fileFilterInput.value.trim().toLowerCase();
            const keywords = filterText.split(/\\s+/).filter(Boolean);
            const fileItems = document.querySelectorAll('.file-item');

            fileItems.forEach(item => {
                const itemName = (item.dataset.name || '').toLowerCase();
                const isMatch = keywords.every(kw => itemName.includes(kw));
                item.style.display = isMatch ? '' : 'none';
            });
        });

        fileFilterInput.addEventListener('focus', () => {
            if (fileFilterInput.value === '') {
                vscode.postMessage({ command: 'getHistory', key: 'fileFilter' });
            }
        });

        // 确保点击时获得焦点（用 mousedown 更早触发）
        fileFilterInput.addEventListener('mousedown', (e) => {
            // 延迟一下确保焦点转移
            setTimeout(() => fileFilterInput.focus(), 0);
        });

        // blur 时立即隐藏下拉框
        fileFilterInput.addEventListener('blur', (e) => {
            // 检查 relatedTarget 是否是下拉框内的元素
            const relatedTarget = e.relatedTarget;
            const isDropdownElement = relatedTarget && fileFilterDropdown.contains(relatedTarget);
            if (!isDropdownElement) {
                hideAllDropdowns();
            }
        });

        // 点击下拉框时阻止冒泡，防止触发 blur
        fileFilterDropdown.addEventListener('mousedown', (e) => {
            e.preventDefault();
        });

        fileFilterInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const value = fileFilterInput.value.trim();
                if (value) {
                    vscode.postMessage({ command: 'saveHistory', key: 'fileFilter', value: value });
                }
                hideAllDropdowns();
                fileFilterInput.blur(); // ★ 回车保存后失去焦点
            } else if (e.key === 'Escape') {
                hideAllDropdowns();
            }
        });

        // 点击下拉框 item
        fileFilterDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.history-dropdown-item');
            if (item) {
                fileFilterInput.value = item.textContent;
                hideAllDropdowns();
                fileFilterInput.focus();
                // 触发 input 事件执行筛选
                fileFilterInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }

  // ★ 精细 SCM 按钮事件监听
  const szModeGroup = document.getElementById('szModeGroup');
  if (szModeGroup) {
    szModeGroup.querySelectorAll('.scm-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleSzModeClick(btn.dataset.mode);
      });
    });
  }

  const sortByGroup = document.getElementById('sortByGroup');
  if (sortByGroup) {
    sortByGroup.querySelectorAll('.scm-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleSortByClick(btn.dataset.sort);
      });
    });
  }

  const openFolderBtn = document.getElementById('openFolderBtn');
  if (openFolderBtn) {
    openFolderBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleOpenFolderClick();
    });
  }

  const sidebarEl = document.querySelector('.sidebar');
  if (sidebarEl) {
    sidebarEl.addEventListener('mousemove', handlePathTooltipHover);
    sidebarEl.addEventListener('mouseleave', hidePathTooltip);
  }

  const kyEl = document.getElementById('kyContent');
  if (kyEl) {
    kyEl.addEventListener('mousemove', handlePathTooltipHover);
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
      // ★ 正在重命名时，点击 rename-input 内部不做任何处理，让光标自然移动
      if (event.target.classList && event.target.classList.contains('rename-input')) return;
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
      checkAndApplyResponsive();
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

// ====== 盘符剩余空间更新机制函数 ======

/**
 * 更新盘符显示文本
 * @param {string} drive - 盘符字母，如 'C', 'D'
 * @param {number} freeBytes - 剩余字节数
 * @param {number} totalBytes - 总字节数
 */
function updateDriveDisplay(drive, freeBytes, totalBytes) {
  const el = document.getElementById('drive-' + drive.toLowerCase() + '-text');
  if (!el) return;
  const freeGB = freeBytes / (1024 * 1024 * 1024);

  // 检查是否需要红色警告: 空间 < 1% 或 < 2GB
  const isLow = (totalBytes > 0 && freeBytes / totalBytes < DISK_FREE_WARNING_PERCENT) ||
                (freeBytes < DISK_FREE_WARNING_BYTES);

  // 正常显示整数，红色时才显示小数位
  const gbText = isLow ? freeGB.toFixed(2) : Math.floor(freeGB).toString();
  el.textContent = drive.toUpperCase() + ':\\  ' + gbText;
  el.style.color = isLow ? DISK_FREE_WARNING_COLOR : '';
}

/**
 * 检测 webview 是否可见
 */
function isDiskFreePollingAllowed() {
  // 只在页面可见时轮询
  return document.visibilityState === 'visible';
}

/**
 * 请求所有盘符剩余空间（合批）
 */
function requestDiskFree() {
  if (diskFreeInFlight) return;
  diskFreeInFlight = true;
  vscode.postMessage({ command: 'getDiskFree' });
}

/**
 * 安排下一轮 C 盘剩余空间更新
 */
function scheduleDiskFreeUpdate() {
  if (diskFreeTimer) {
    clearTimeout(diskFreeTimer);
    diskFreeTimer = null;
  }
  if (!isDiskFreePollingAllowed()) return;
  diskFreeTimer = setTimeout(() => {
    if (isDiskFreePollingAllowed()) {
      requestDiskFree();
    } else {
      scheduleDiskFreeUpdate(); // 稍后重试
    }
  }, DISK_FREE_INTERVAL_MS);
}

/**
 * 停止 C 盘剩余空间轮询
 */
function stopDiskFreePolling() {
  if (diskFreeTimer) {
    clearTimeout(diskFreeTimer);
    diskFreeTimer = null;
  }
}

// 监听可见性变化
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // 变为可见，立即请求一次并启动轮询
    requestDiskFree();
  } else {
    // 隐藏时停止轮询
    stopDiskFreePolling();
  }
});

// 初始化：立即请求一次
if (isDiskFreePollingAllowed()) {
  requestDiskFree();
}

// ====== 导出给模板内联 onclick ======
window.navigateTo = navigateTo;
window.navigateIntoFolder = navigateIntoFolder;
window.unpinDir = unpinDir;
window.pinDir = pinDir;
window.onRecycleFileClick = onRecycleFileClick;
window.cancel = cancel;
window.saveFile = saveFile;
window.createFolder = createFolder;
window.togglePin = togglePin;

// ====== 自定义滚动条（与 q4 外层滚动条完全一致）======
function setupCustomScrollbar() {
  const container = document.getElementById('fileList');
  const scrollbar = document.getElementById('customScrollbar');
  const thumb = document.getElementById('customScrollbarThumb');
  if (!container || !scrollbar || !thumb) return;

  function getThumbHeight() {
    const ch = container.clientHeight, sh = container.scrollHeight;
    return Math.max(20, (ch / sh) * scrollbar.clientHeight);
  }

  function update() {
    const ch = container.clientHeight, sh = container.scrollHeight, st = container.scrollTop;
    const barH = scrollbar.clientHeight;
    if (sh > ch) {
      scrollbar.style.display = 'block';
      const th = getThumbHeight();
      thumb.style.height = th + 'px';
      thumb.style.top = (st / (sh - ch)) * (barH - th) + 'px';
    } else {
      scrollbar.style.display = 'none';
    }
  }

  container.addEventListener('scroll', update);

  // 拖动滚动块
  let isDragging = false, startY, startST;
  thumb.onmousedown = function(e) {
    isDragging = true;
    startY = e.clientY;
    startST = container.scrollTop;
    document.onmousemove = function(e) {
      if (!isDragging) return;
      const dy = e.clientY - startY;
      const barH = scrollbar.clientHeight;
      const th = thumb.offsetHeight;
      const sh = container.scrollHeight, ch = container.clientHeight;
      container.scrollTop = startST + (dy / (barH - th)) * (sh - ch);
    };
    document.onmouseup = function() {
      isDragging = false;
      document.onmousemove = null;
    };
    e.preventDefault();
    e.stopPropagation();
  };

  // 点击轨道背景：左键翻页 / Shift+左键或右键闪现
  scrollbar.style.pointerEvents = 'auto';

  function jumpToClick(e) {
    e.preventDefault();
    const rect = scrollbar.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const th = thumb.offsetHeight;
    const sh = container.scrollHeight, ch = container.clientHeight;
    const barH = scrollbar.clientHeight;
    const ratio = (clickY - th / 2) / (barH - th);
    container.scrollTop = Math.max(0, Math.min(1, ratio)) * (sh - ch);
  }

  scrollbar.addEventListener('mousedown', function(e) {
    if (e.target === thumb) return;
    e.preventDefault();

    if (e.shiftKey || e.button === 2) {
      // Shift+左键 或 右键：闪现到点击位置
      jumpToClick(e);
    } else if (e.button === 0) {
      // 普通左键：翻页
      const rect = scrollbar.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const thumbTop = parseFloat(thumb.style.top) || 0;
      const th = thumb.offsetHeight;
      const sh = container.scrollHeight, ch = container.clientHeight;
      if (clickY < thumbTop) {
        container.scrollTop = Math.max(0, container.scrollTop - ch);
      } else if (clickY > thumbTop + th) {
        container.scrollTop = Math.min(sh - ch, container.scrollTop + ch);
      }
    }
  });

  // 屏蔽滚动条区域的右键菜单
  scrollbar.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    e.stopPropagation();
  });

  // 初始更新
  update();
  window.addEventListener('resize', update);
  const observer = new MutationObserver(update);
  observer.observe(container, { childList: true, subtree: true });

  // JS hover：仅光标真正移动时才切换 hover，滚动时光标不动则零触发，消除残影
  let hoveredItem = null;
  container.addEventListener('mousemove', function(e) {
    const item = e.target.closest('.file-item');
    if (item === hoveredItem) return;
    if (hoveredItem) hoveredItem.classList.remove('js-hover');
    hoveredItem = item;
    if (hoveredItem) hoveredItem.classList.add('js-hover');
  });
  container.addEventListener('mouseleave', function() {
    if (hoveredItem) hoveredItem.classList.remove('js-hover');
    hoveredItem = null;
  });

  // 兑底：交互停止后，浏览器空闲时刷新一次，清除一切残影
  let idleHandle = null;
  function scheduleIdleRepaint() {
    if (idleHandle) return;
    idleHandle = requestIdleCallback(function() {
      idleHandle = null;
      container.style.willChange = 'transform';
      requestAnimationFrame(function() { container.style.willChange = ''; });
    });
  }
  container.addEventListener('scroll', scheduleIdleRepaint);
  container.addEventListener('mousemove', scheduleIdleRepaint);

  // 按 1 滚到顶部，按 2 滚到底部（编辑状态下不监听）
  document.addEventListener('keydown', function(e) {
    if (isInputFocused()) return;
    if (e.key === '1') {
      e.preventDefault();
      container.scrollTop = 0;
    } else if (e.key === '2') {
      e.preventDefault();
      container.scrollTop = container.scrollHeight;
    }
  }, true);
}

setTimeout(setupCustomScrollbar, 100);

// 按 z 打开管理员 CMD，按 x 打开管理员 PowerShell（编辑状态下不监听）
document.addEventListener('keydown', function(e) {
  if (isInputFocused()) return;
  const key = (e.key || '').toLowerCase();
  if (key === 'z') {
    e.preventDefault();
    vscode.postMessage({ command: 'openAdminCmd', path: currentPath });
  } else if (key === 'x') {
    e.preventDefault();
    vscode.postMessage({ command: 'openAdminPowershell', path: currentPath });
  }
}, true);
`;
}

// ==================== sidebar HTML 生成（共用） ====================
const RECYCLE_BIN_BATCH_SIZE = 20; // 每批加载条数

function generateSidebarHtml(config, recycleBinLimit = RECYCLE_BIN_BATCH_SIZE) {
  const safePinnedDirs = (config.pinnedDirs || []).filter((dir) => dir && fs.existsSync(dir));
  const pinnedKeySet = new Set(safePinnedDirs.map(d => cacheKeyForPath(d)));
  const safeRecycleBin = (config.recycleBin || []).filter(
    (item) => item && item.path && typeof item.path === "string" && fs.existsSync(item.path)
      && !(item.type === 'dir' && pinnedKeySet.has(cacheKeyForPath(item.path)))
  );
  const totalRecycleBin = safeRecycleBin.length;
  const displayedRecycleBin = safeRecycleBin.slice(0, recycleBinLimit);
  const showRecycleBin = displayedRecycleBin.length > 0;

  const recycleBinHtml = showRecycleBin
    ? `
<div class="divider"></div>
<div class="recycle-bin-section" data-total="${totalRecycleBin}" data-loaded="${displayedRecycleBin.length}">
  ${displayedRecycleBin
      .map((item) => {
        const escaped = escapeJsStringLiteral(item.path);
        const fullDisplay = escapeHtmlAttribute(item.path);
        if (item.type === 'file') {
          const fileName = escapeHtmlAttribute(path.basename(item.path));
          return `<div class="recycle-item recycle-file" onclick="onRecycleFileClick('${escaped}')" data-fullpath="${fullDisplay}"><span class="recycle-text">${fileName}</span></div>`;
        } else {
          return `<div class="recycle-item recycle-dir" onclick="navigateTo('${escaped}')" data-fullpath="${fullDisplay}"><span class="recycle-text">${fullDisplay}</span><span class="pin-icon" onclick="event.stopPropagation(); pinDir('${escaped}')">\ud83d\udccc</span></div>`;
        }
      })
      .join("")}
</div>`
    : "";

  const pinnedDirsHtml = safePinnedDirs
    .map(
      (dir) => `
<div class="recent-item" onclick="navigateTo('${escapeJsStringLiteral(dir)}')">
  <span class="delete-button" onclick="event.stopPropagation(); unpinDir('${escapeJsStringLiteral(
        dir
      )}')">\u00d7</span>
  <span>${escapeHtmlAttribute(dir)}</span>
</div>`
    )
    .join("");

  return { recycleBinHtml, pinnedDirsHtml };
}

// 生成回收站单条项目 HTML
function generateRecycleBinItemHtml(item) {
  const escaped = escapeJsStringLiteral(item.path);
  const fullDisplay = escapeHtmlAttribute(item.path);
  if (item.type === 'file') {
    const fileName = escapeHtmlAttribute(path.basename(item.path));
    return `<div class="recycle-item recycle-file" onclick="onRecycleFileClick('${escaped}')" data-fullpath="${fullDisplay}"><span class="recycle-text">${fileName}</span></div>`;
  } else {
    return `<div class="recycle-item recycle-dir" onclick="navigateTo('${escaped}')" data-fullpath="${fullDisplay}"><span class="recycle-text">${fullDisplay}</span><span class="pin-icon" onclick="event.stopPropagation(); pinDir('${escaped}')">\ud83d\udccc</span></div>`;
  }
}

// 获取指定范围的回收站项目
function getRecycleBinItems(offset, limit) {
  const config = getConfig();
  const safePinnedDirs = (config.pinnedDirs || []).filter((dir) => dir && fs.existsSync(dir));
  const pinnedKeySet = new Set(safePinnedDirs.map(d => cacheKeyForPath(d)));
  const safeRecycleBin = (config.recycleBin || []).filter(
    (item) => item && item.path && typeof item.path === "string" && fs.existsSync(item.path)
      && !(item.type === 'dir' && pinnedKeySet.has(cacheKeyForPath(item.path)))
  );
  const total = safeRecycleBin.length;
  const items = safeRecycleBin.slice(offset, offset + limit);
  const itemsHtml = items.map(generateRecycleBinItemHtml).join('');
  return { itemsHtml, total, loaded: offset + items.length };
}

function getWebviewContent(currentPath) {
  const config = getConfig();
  const drives = getDrives();

  const { recycleBinHtml, pinnedDirsHtml } = generateSidebarHtml(config);

  let htmlTemplate = "";
  try {
    htmlTemplate = require("./q2.html");
  } catch (error) {
    geq().logMessage(q('q2.log.templateReadError', error.message), "ERROR");
    return `<h1>错误: 无法加载 q2.html 模板</h1><p>${escapeHtmlAttribute(error.message)}</p>`;
  }

  const drivesHtml = drives
    .map((drive) => {
      const driveUpper = drive.toUpperCase();
      const driveLetter = driveUpper.replace(/[^A-Z]/g, '') || 'X';
      return '<button class="nav-item" id="drive-' + driveLetter.toLowerCase() + '-btn" onclick="navigateTo(\'' + escapeJsStringLiteral(drive) + '\')"><span id="drive-' + driveLetter.toLowerCase() + '-text">' + escapeHtmlAttribute(drive) + '</span></button>';
    })
    .join("");

  const inlineScript = generateWebviewScript(currentPath, config.sidebarRatio);

  let finalHtml = htmlTemplate
    .replace("{{SIDEBAR_WIDTH}}", config.sidebarWidth)
    .replace("{{LINE_SPACING}}", config.lineSpacing)
    .replace("{{DRIVES_HTML}}", drivesHtml)
    .replace("{{RECYCLE_BIN_HTML}}", recycleBinHtml)
    .replace("{{RECENT_DIRS_HTML}}", pinnedDirsHtml)
    .replace("{{CURRENT_PATH}}", escapeHtmlAttribute(currentPath))
    .replace("{{PIN_CLASS}}", config.isPinned ? "pinned" : "")
    .replace("{{PIN_CHECKBOX}}", config.isPinned ? "✓" : "□")
    .replace("{{INLINE_SCRIPT}}", inlineScript.replace(/<\/script>/gi, "<\\/script>"))
    // ★ i18n 占位符替换
    .replace("{{I18N_PIN}}", q('q2.ui.pin'))
    .replace("{{I18N_NEW_FILE}}", q('q2.ui.newFile'))
    .replace("{{I18N_NEW_FOLDER}}", q('q2.ui.newFolder'))
    .replace("{{I18N_OPEN_FOLDER}}", q('q2.ui.openFolder'))
    .replace("{{I18N_SZ_SIZE}}", q('q2.ui.szSize'))
    .replace("{{I18N_SZ_CTIME}}", q('q2.ui.szCtime'))
    .replace("{{I18N_SZ_MTIME}}", q('q2.ui.szMtime'))
    .replace("{{I18N_SORT_SIZE}}", q('q2.ui.sortSize'))
    .replace("{{I18N_SORT_CTIME}}", q('q2.ui.sortCtime'))
    .replace("{{I18N_SORT_MTIME}}", q('q2.ui.sortMtime'));

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
    global.showAutoCloseNotification('info', q('q2.paste.plainTextOnly'))
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

        // ★ 粘贴成功，记录目标目录到历史
        recordDirHistory(targetDir);

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
    global.showAutoCloseNotification('error', q('q2.error.integrityFailed'));
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

  // 起始目录优先级：
  // 1. 上次访问的目录（恢复会话）
  // 2. pinnedDirs 第一项
  // 3. recycleBin 中的第一个目录
  // 4. 平台默认目录
  let currentPath = "";
  const lastVisited = getLastVisitedDir();
  if (lastVisited) {
    const canon = canonicalizeExistingPath(lastVisited);
    if (canon && fs.existsSync(canon)) currentPath = canon;
  }
  if (!currentPath && config.pinnedDirs && config.pinnedDirs.length > 0) {
    currentPath = canonicalizeExistingPath(config.pinnedDirs[0]);
  }
  if (!currentPath) {
    const firstDir = (config.recycleBin || []).find(item => item.type === 'dir');
    if (firstDir) currentPath = canonicalizeExistingPath(firstDir.path);
  }
  if (!currentPath) {
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
    "的梦gaea",
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
    sRequestVersion++; // 使所有正在进行的 sRequest 失效
    cancelAllScans(); // 取消所有引擎的耗时扫描
    if (currentWatcher) {
      currentWatcher.dispose();
      currentWatcher = null;
    }
  });

  // ★ 监听语言切换，实时刷新 Webview
  const langChangeDisposable = onLanguageChange(() => {
    if (panel && activePanelAlive) {
      console.log('[Q2] Language changed, refreshing webview...');
      panel.webview.html = getWebviewContent(currentPath);
      setTimeout(() => {
        if (panel && activePanelAlive) {
          updateResourceExplorer();
        }
      }, 100);
    }
  });
  // 面板关闭时取消订阅
  panel.onDidDispose(() => langChangeDisposable.dispose());

  async function updateResourceExplorer() {
    try {
      if (!panel || !activePanelAlive) return;

      // 记录当前目录，用于检测目录切换
      if (currentPath !== lastResourceExplorerPath) {
        lastResourceExplorerPath = currentPath;
        // ★ 立即保存最后访问的目录（即使崩溃也能恢复）
        saveLastVisitedDir(currentPath);
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

      // ★ 精细 SCM 优先级高于全局设置
      const fineSCM = getFineSCM(currentPath);
      const szDisplayMode = fineSCM.szMode || config.szDisplayMode;
      const sortBy = fineSCM.sortBy || config.sortBy;

      const directoryContents = await getDirectoryContents(currentPath, sortBy, szDisplayMode);
      const items = [];
      let fileListHtml = "";

      // 辅助函数：根据 szDisplayMode 生成 sz-area 内容
      function getSzContent(item, isFolder) {
        if (szDisplayMode === "nothing") return "";
        if (szDisplayMode === "size") {
          // size 模式：只显示文件大小，文件夹不参与
          if (isFolder) return "";
          const bytes = item.size || 0;
          const sizeInfo = formatFileSizeEx(bytes);
          // 如果有 GB 部分，返回带红色的 HTML
          if (sizeInfo.gbPart) {
            return '<span style="color:' + SZ_GB_COLOR + '">' + sizeInfo.gbPart + '</span>' + sizeInfo.restPart + ' ';
          }
          return sizeInfo.text + " ";
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
        )}" data-name="${escapeHtmlAttribute(dir.name)}" data-type="folder"><div class="file-select-area"><div class="sz-area">${szContent}</div><span class="file-icon">📁</span></div><div class="folder-name-area"><span class="file-name">${escapeHtmlAttribute(
          dir.name
        )}</span></div></div>`;
      });

      directoryContents.files.forEach((file) => {
        const szContent = getSzContent(file, false);
        items.push({ path: file.path, name: file.name, type: "file" });
        fileListHtml += `<div class="file-item file" data-path="${escapeHtmlAttribute(
          file.path
        )}" data-name="${escapeHtmlAttribute(file.name)}" data-type="file"><div class="file-select-area"><div class="sz-area">${szContent}</div><span class="file-icon">🗈</span></div><div class="file-name-area"><span class="file-name">${escapeHtmlAttribute(
          file.name
        )}</span></div></div>`;
      });

      panel.webview.postMessage({
        command: "update",
        currentPath,
        fileListHtml,
        items,
        sizeMode: szDisplayMode,
        fineSCM: fineSCM,
      });

      // ★ 同步更新 sidebar（历史回收站 + 图钉历史区）
      const sidebarData = generateSidebarHtml(config);
      panel.webview.postMessage({
        command: "updateSidebar",
        recycleBinHtml: sidebarData.recycleBinHtml,
        pinnedDirsHtml: sidebarData.pinnedDirsHtml,
      });

      // ★ 智能文件监视器：只在用户开启 autoWatchChanges 时启用
      if (config.autoWatchChanges) {
        setupFileWatcher(currentPath);
      }
    } catch (error) {
      geq().logMessage(q('q2.log.updatePreviewError', error), "ERROR");
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
      global.logMessage(q('q2.log.watchStartError', e.message), "WARN");
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
      case "getHistory":
        if (message.key) {
          const history = await getCommandHistory(message.key);
          panel.webview.postMessage({ command: 'historyData', key: message.key, history: history });
        }
        break;
      case "saveHistory":
        if (message.key && message.value) {
          await addCommandToHistory(message.key, message.value);
        }
        break;
      case "unpinDirectory":
        if (message.path) {
          unpinDirectory(message.path);
          refreshWebview();
        }
        break;
      case "pinDirectory":
        if (message.path) {
          pinDirectory(message.path);
          refreshWebview();
        }
        break;
      case "recycleFileClick": {
        // 点击回收站文件：重新置顶 dir+file，然后编辑该文件
        const clickedFile = canonicalizeExistingPath(message.path);
        if (clickedFile && fs.existsSync(clickedFile)) {
          recordFileHistory(clickedFile);
          // 打开编辑
          const ext = path.extname(clickedFile).toLowerCase();
          if (UNSUPPORTED_CODE_EXTENSIONS.has(ext)) {
            try { global.openExternal(vscode.Uri.file(clickedFile)); } catch { }
          } else {
            vscode.workspace.openTextDocument(clickedFile).then((doc) => {
              global.showTextDocument(doc, getShowOptions(false));
            });
          }
        }
        refreshWebview();
        break;
      }

      // 回收站懒加载：请求更多条目
      case "requestRecycleBin": {
        const offset = message.offset || 0;
        const limit = message.limit || RECYCLE_BIN_BATCH_SIZE;
        const result = getRecycleBinItems(offset, limit);
        if (panel && activePanelAlive) {
          panel.webview.postMessage({
            command: 'appendRecycleBin',
            itemsHtml: result.itemsHtml,
            total: result.total,
            loaded: result.loaded
          });
        }
        break;
      }

      // 盘符剩余空间请求（合批）
      case "getDiskFree": {
        (async () => {
          try {
            const result = {}; // { 'C': {free, total}, 'D': {free, total}, ... }
            const drives = getDrives();
            for (const drive of drives) {
              const driveLetter = drive.toUpperCase().replace(/[^A-Z]/g, '') || 'X';
              const res = await geq().getDiskFree(driveLetter + ':');
              if (res && res.success) {
                result[driveLetter] = { free: res.free, total: res.total };
              }
            }
            if (panel && activePanelAlive) {
              panel.webview.postMessage({
                command: "diskFreeResult",
                data: result // 一次性返回所有盘符的完整答卷
              });
            }
          } catch (e) {
            geq().logMessage(q('q2.log.diskFreeError', e.message), "WARN");
          }
        })();
        break;
      }

      // s 请求：点击 sz 区强制获取 size（包括文件夹递归大小）
      // 优化：边算边渲染 + 版本号取消机制
      case "sRequest": {
        const thisVersion = ++sRequestVersion; // 递增版本号，使之前的请求失效
        cancelAllScans(); // ★ 取消正在进行的底层扫描
        (async () => {
          const items = message.items || [];
          if (items.length === 0) return;

          // 边算边渲染：每个完成后立即发送，不阻塞其他项
          const promises = items.map(async (item) => {
            // 版本号检查：如果已过期，直接跳过
            if (sRequestVersion !== thisVersion) return;

            const isFolder = item.type === 'folder';
            const size = await getSizeForSRequest(item.path, isFolder);

            // 再次检查版本号：计算完成后可能已经切换目录了
            if (sRequestVersion !== thisVersion) return;
            if (!panel || !activePanelAlive) return;

            // 单个结果立即发送渲染
            const sizeInfo = formatFileSizeEx(size);
            panel.webview.postMessage({
              command: "updateSizeBatch",
              results: [{
                path: canonicalizeExistingPath(item.path),
                type: item.type,
                sizeDisplay: sizeInfo.text + " ",
                gbPart: sizeInfo.gbPart,
                restPart: sizeInfo.restPart
              }]
            });
          });

          // 并发执行，但不等待全部完成
          await Promise.allSettled(promises);
        })();
        break;
      }

      case "renameItem":
        try {
          const { oldPath, newName } = message;
          const oldCanon = canonicalizeExistingPath(oldPath);
          const newPath = canonicalizeExistingPath(path.join(path.dirname(oldCanon), newName));

          if (fs.existsSync(newPath)) {
            global.showAutoCloseNotification('error', q('q2.error.renameFailed'));
            refreshWebview();
          } else {
            fs.renameSync(oldCanon, newPath);
            recordDirHistory(path.dirname(oldCanon));
            setTimeout(() => {
              if (panel && activePanelAlive) refreshWebview();
            }, 100);
          }
        } catch (error) {
          global.showAutoCloseNotification('error', q('q2.error.renameError', error.message));
          refreshWebview();
        }
        break;

      case "navigate":
        try {
          sRequestVersion++; // 切换目录时使正在进行的 sRequest 失效
          cancelAllScans(); // 取消所有引擎的耗时扫描
          const resolved = resolveNavPath(message.path, currentPath);

          // Windows：若用户点了 drives 的 "C:"，resolve 后可能仍是 "C:"；这里强制成根
          let newPath = resolved;
          if (process.platform === "win32" && /^[A-Z]:$/i.test(newPath)) newPath = newPath.toUpperCase() + "\\";

          newPath = canonicalizeExistingPath(newPath);

          if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
            currentPath = newPath;
            refreshWebview();
            // ★ 导航成功后发送成功消息，前端可以据此保存历史并 blur
            if (panel && activePanelAlive) {
              panel.webview.postMessage({ command: 'navigateSuccess', path: message.path });
            }
          } else {
            global.showAutoCloseNotification('error', q('q2.error.invalidPath', newPath));
          }
        } catch (error) {
          global.showAutoCloseNotification('error', q('q2.error.navError', error.message));
        }
        break;

      case "navigateUp": {
        sRequestVersion++; // 切换目录时使正在进行的 sRequest 失效
        cancelAllScans(); // 取消所有引擎的耗时扫描
        const parentDir = canonicalizeExistingPath(path.dirname(currentPath));
        if (parentDir && parentDir !== currentPath) {
          currentPath = parentDir;
          refreshWebview();
        }
        break;
      }

      case "saveSidebarRatio":
        saveConfig(
          currentConfig.pinnedDirs,
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
          currentConfig.pinnedDirs,
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
              global.showAutoCloseNotification('error', q('q2.error.createFileFolderExists', filename));
              return;
            }
            fs.writeFileSync(fullFilePath, "\n".repeat(199), "utf8");
            recordDirHistory(currentPath);

            // 联动 Q4 统计：累加新建文件数
            try {
              const q4 = vscode.extensions.getExtension('gh555.qqq')?.exports;
              if (q4 && typeof q4.recordRoamUsage === 'function') {
                q4.recordRoamUsage({ filesCreated: 1 });
              }
            } catch (e) { }

            if (!fs.existsSync(fullFilePath)) {
              global.logMessage(q('q2.log.createOpenError', fullFilePath), "WARN");
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
              global.logMessage(q('q2.log.openDocError', err.message), "ERROR");
            });
          } catch (error) {
            global.showAutoCloseNotification('error', q('q2.error.createFileError', error.message));
          }
        };

        if (fs.existsSync(fullFilePath)) {
          const stats = fs.statSync(fullFilePath);
          if (stats.isDirectory()) {
            global.showAutoCloseNotification('error', q('q2.error.createFileFolderExists', filename));
          } else {
            global
              .showWarningMessage(q('q2.confirm.overwriteFile', filename), { modal: true }, q('q2.confirm.yes'), q('q2.confirm.no'))
              .then((answer) => {
                if (answer === q('q2.confirm.yes')) createFileAction();
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
          global.showAutoCloseNotification('error', q('q2.error.folderExists', message.folderName));
        } else {
          fs.mkdirSync(newFolderPath);
          recordDirHistory(currentPath);
          refreshWebview();
          if (panel && activePanelAlive) panel.webview.postMessage({ command: "clearFilenameInput" });
        }
        break;
      }

      case "cancel":
        if (panel && activePanelAlive) panel.dispose();
        break;

      case "editFile": {
        recordFileHistory(message.path);
        // ★ 立即更新 sidebar（可能不会走 refreshWebview）
        if (panel && activePanelAlive) {
          const sbData = generateSidebarHtml(getConfig());
          panel.webview.postMessage({ command: "updateSidebar", recycleBinHtml: sbData.recycleBinHtml, pinnedDirsHtml: sbData.pinnedDirsHtml });
        }
        const p = canonicalizeExistingPath(message.path);
        const ext = path.extname(p).toLowerCase();

        if (UNSUPPORTED_CODE_EXTENSIONS.has(ext)) {
          global.showAutoCloseNotification('warning', q('q2.error.unsupportedFile', path.basename(p)));
          break;
        }

        if (!fs.existsSync(p)) {
          global.showAutoCloseNotification('warning', q('q2.error.fileNotExists', path.basename(p)));
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
            global.logMessage(q('q2.log.openFileError', error.message), "ERROR");
          });
        break;
      }

      case "openFolderInNewWindow": {
        const p = canonicalizeExistingPath(message.path);
        recordDirHistory(p);
        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(p), {
          forceNewWindow: true,
        });
        refreshWebview();
        break;
      }

      case "openWithDefault": {
        const p = canonicalizeExistingPath(message.path);
        recordDirHistory(message.type === "folder" ? p : path.dirname(p));
        // ★ 立即更新 sidebar
        if (panel && activePanelAlive) {
          const sbData = generateSidebarHtml(getConfig());
          panel.webview.postMessage({ command: "updateSidebar", recycleBinHtml: sbData.recycleBinHtml, pinnedDirsHtml: sbData.pinnedDirsHtml });
        }
        try {
          global.openExternal(vscode.Uri.file(p));
        } catch (error) {
          global.showAutoCloseNotification('error', q('q2.error.openFileError', error.message));
        }
        break;
      }

      case "quickDeleteToRecycleBin": {
        const itemToDelete = canonicalizeExistingPath(message.path);
        // 安全保护：绝对禁止删除上级目录
        if (path.basename(itemToDelete) === '..' || message.name === '..') {
          global.showAutoCloseNotification('error', q('q2.error.deleteParentForbidden'));
          refreshWebview();
          break;
        }
        if (fs.existsSync(itemToDelete)) {
          recordDirHistory(currentPath);
          (async () => {
            try {
              const uri = vscode.Uri.file(itemToDelete);
              await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
              global.showAutoCloseNotification('info', q('q2.ui.movedToRecycleBin', path.basename(itemToDelete)));
            } catch (error) {
              global.showAutoCloseNotification('error', q('q2.ui.deleteFailed', error.message));
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
          recordDirHistory(currentPath);
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
                  global.logMessage(q('q2.ui.deleteItemFailed', itemPath, error.message), "WARN");
                }
              }
            }

            if (deletedCount > 0) {
              if (errorCount > 0) {
                global.showAutoCloseNotification('info', q('q2.ui.multiDeletePartial', deletedCount, errorCount));
              } else {
                global.showAutoCloseNotification('info', q('q2.ui.multiDeleteSuccess', deletedCount));
              }
            } else if (errorCount > 0) {
              global.showAutoCloseNotification('error', q('q2.ui.multiDeleteFailed', errorCount));
            }

            // 无论删除过程中发生什么错误，最后都必须强制刷新列表以恢复界面（变灰项会消失或恢复）
            if (activePanel && activePanelAlive) refreshWebview();
          })();
        } else {
          refreshWebview();
        }
        break;
      }

      case "quickPermanentDelete": {
        // Shift+Delete 永久删除单个项目
        const itemToDelete = canonicalizeExistingPath(message.path);
        if (path.basename(itemToDelete) === '..' || message.name === '..') {
          global.showAutoCloseNotification('error', q('q2.error.deleteParentForbidden'));
          refreshWebview();
          break;
        }
        if (fs.existsSync(itemToDelete)) {
          recordDirHistory(currentPath);
          (async () => {
            try {
              const uri = vscode.Uri.file(itemToDelete);
              await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
              global.showAutoCloseNotification('info', q('q2.ui.permanentDeleted', path.basename(itemToDelete)));
            } catch (error) {
              global.showAutoCloseNotification('error', q('q2.ui.permanentDeleteFailed', error.message));
            } finally {
              if (activePanel && activePanelAlive) refreshWebview();
            }
          })();
        } else {
          refreshWebview();
        }
        break;
      }

      case "quickPermanentDeleteMultiple": {
        // Shift+Delete 永久删除多个项目
        const itemsToDelete = (message.items || []).filter(item => item.name !== '..');
        if (itemsToDelete.length > 0) {
          recordDirHistory(currentPath);
          (async () => {
            let deletedCount = 0;
            let errorCount = 0;

            for (const item of itemsToDelete) {
              const itemPath = canonicalizeExistingPath(item.path);
              if (fs.existsSync(itemPath)) {
                try {
                  const uri = vscode.Uri.file(itemPath);
                  await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
                  deletedCount++;
                } catch (error) {
                  errorCount++;
                  global.logMessage(q('q2.ui.permanentDeleteItemFailed', itemPath, error.message), "WARN");
                }
              }
            }

            if (deletedCount > 0 && errorCount === 0) {
              global.showAutoCloseNotification('info', q('q2.ui.multiPermanentDeleteSuccess', deletedCount));
            } else if (deletedCount > 0 && errorCount > 0) {
              global.showAutoCloseNotification('warning', q('q2.ui.multiPermanentDeletePartial', deletedCount, errorCount));
            } else if (errorCount > 0) {
              global.showAutoCloseNotification('error', q('q2.ui.multiPermanentDeleteFailed', errorCount));
            }

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

      case "setFineSCM": {
        // ★ 保存精细 SCM 并立即刷新
        const folderPath = message.path;
        const szMode = message.szMode;
        const sortByValue = message.sortBy;
        setFineSCMValue(folderPath, szMode, sortByValue);
        // 立即刷新界面
        if (activePanel && activePanelAlive) refreshWebview();
        break;
      }

      case "showAutoCloseMessage": {
        // ★ 9秒自动关闭的弹窗
        const msgType = message.type || 'info';
        const msgText = message.message || '';
        global.showAutoCloseNotification(msgType, msgText);
        break;
      }

      // ★★★ 管理员终端：z 键打开 CMD，x 键打开 PowerShell ★★★
      case "openAdminCmd": {
        const targetPath = canonicalizeExistingPath(message.path || currentPath);
        openAdminTerminal(targetPath, 'cmd');
        break;
      }

      case "openAdminPowershell": {
        const targetPath = canonicalizeExistingPath(message.path || currentPath);
        openAdminTerminal(targetPath, 'powershell');
        break;
      }
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

  // ★ 调试 i18n
  console.log(`[Q2] i18n test: q('q2.ui.pin') = "${q('q2.ui.pin')}"`);

  LARGE_WATERMARK_PATH = path.join(extensionPath, "assets", "al.png");
  SMALL_WATERMARK_PATH = path.join(extensionPath, "assets", "as.png");

  // 异步校验完整性，不阻塞激活
  global.verifySystemIntegrityAsync(context).then(valid => {
    geq().logMessage(`Q2 Integrity: ${valid ? "PASSED" : "FAILED"}`, "INFO");
  });

  getConfig();
  geq().logMessage(q('q2.log.activated'), "INFO");

  // ★ 终极修复：通过 ConfigGate 回调机制获取配置更新通知（解决竞态问题）
  // 之前直接监听 onDidChangeConfiguration 会导致在 sessionOverrides 更新前就读取配置
  global.ConfigManager.onConfigUpdated((changedKeys, event) => {
    // 只关心 q2 相关的配置
    const q2Keys = ["szDisplayMode", "sortBy", "autoWatchChanges"];
    if (!changedKeys.some(k => q2Keys.includes(k))) return;

    // 清除配置缓存，强制重新读取
    cachedInMemoryConfig = null;
    geq().logMessage(q('q2.log.configRefresh'), "INFO");
    // 如果面板正在显示，刷新它
    if (activePanel && activePanelAlive && globalRefreshWebview) {
      globalRefreshWebview();
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("qqq.q2", global.withReady(showSaveAsDialog)),
    vscode.commands.registerCommand("qqq.saveAsDialog", global.withReady(showSaveAsDialog))
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

// File: src/q2.js
// ★★★ 文件管理器：Webview 界面 + 使用 geq().js 四级回退 + 防惊群尺寸调度/缓存 ★★★
// 适配：匹配最新 qqq IO 引擎路径逻辑（跨平台 normalize + 绝对路径保留 + canonical 去重）
// 说明：本文件内置 normalize/resolve/canonical，若 geq().js 导出同名函数会自动优先使用 qqq 的实现

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
// const trash = require("trash"); // trash 7.x is ESM only, use dynamic import instead

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

// ==================== 完整性校验（与 q1 对齐，可选） ====================
const LARGE_WATERMARK_HASH = "dd931dba64fd02a5fd683dd83692bc04311e4bc8ce5df5b44d64491fa1536cc7";
const SMALL_WATERMARK_HASH = "7e2d52d43e5383b8638026552dc4b01e84012643415916ffe745d047541c3c67";
let LARGE_WATERMARK_PATH = "";
let SMALL_WATERMARK_PATH = "";
let isCoreIntegrityValid = false;

function verifySystemIntegrity() {
  try {
    // 校验大水印
    if (!fs.existsSync(LARGE_WATERMARK_PATH)) return false;
    const largeBuf = fs.readFileSync(LARGE_WATERMARK_PATH);
    const largeHash = crypto.createHash("sha256").update(largeBuf).digest("hex");
    if (largeHash !== LARGE_WATERMARK_HASH) return false;

    // 校验小水印
    if (!fs.existsSync(SMALL_WATERMARK_PATH)) return false;
    const smallBuf = fs.readFileSync(SMALL_WATERMARK_PATH);
    const smallHash = crypto.createHash("sha256").update(smallBuf).digest("hex");
    return smallHash === SMALL_WATERMARK_HASH;
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

// ==================== IO / Path：匹配最新引擎逻辑（关键） ====================

function _stripDocJunk(s) {
  if (s == null) return "";
  return String(s).trim().replace(/\r/g, "").replace(/\n/g, "");
}

function _getSystemDriveRoot() {
  // Windows 根路径补全用：优先 SystemDrive，其次 USERPROFILE 盘符，否则 C:
  const sd = process.env.SystemDrive;
  if (sd && /^[A-Za-z]:$/.test(sd)) return sd.toUpperCase() + "\\";
  const up = process.env.USERPROFILE;
  if (up && /^[A-Za-z]:[\\/]/.test(up)) return up.slice(0, 2).toUpperCase() + "\\";
  return "C:\\";
}

/**
 * normalizeNavPath：用于“导航/打开/展示”的路径清洗
 * - 非 Windows：/ 开头保持绝对路径；~ 支持展开
 * - Windows：
 *   - 盘符/UNC 保持绝对
 *   - "C:" / "C:/" / "C:\" 归一到 "C:\"
 *   - "\foo" 或 "/foo" 视为当前系统盘根路径下的 "\foo"
 *   - 其他相对路径：只做 normalize（resolve 由 resolveNavPath 负责）
 */
function normalizeNavPath(rawPath) {
  // 如果 qqq.js 新增了同名函数，优先使用（向后兼容你“最新 IO 引擎”）
  const _qqq = geq();
  if (_qqq && typeof _qqq.normalizeNavPath === "function") {
    try {
      return _qqq.normalizeNavPath(rawPath);
    } catch {
      /* fallthrough */
    }
  }

  let clean = _stripDocJunk(rawPath);
  if (!clean) return "";

  // ~ 展开（mac/linux 常用；windows 也允许）
  if (clean === "~") clean = os.homedir();
  else if (clean.startsWith("~/") || clean.startsWith("~\\")) {
    clean = path.join(os.homedir(), clean.slice(2));
  }

  const isWin = process.platform === "win32";
  if (!isWin) return path.normalize(clean);

  // Windows：盘符根（"C:" 或 "C:/" 或 "C:\"）
  if (/^[A-Za-z]:$/.test(clean)) return clean.toUpperCase() + "\\";
  if (/^[A-Za-z]:[\\/]*$/.test(clean)) return clean[0].toUpperCase() + ":\\";

  // UNC：\\server\share 或 //server/share
  if (clean.startsWith("\\\\") || clean.startsWith("//")) return path.normalize(clean);

  // 盘符绝对：C:\a\b 或 C:/a/b
  if (/^[A-Za-z]:[\\/]/.test(clean)) {
    const normalized = path.normalize(clean);
    return normalized.replace(/^[a-z]:/, (m) => m.toUpperCase());
  }

  // 形如 \foo 或 /foo：视为系统盘根路径下的绝对路径（更符合文件管理器直觉）
  if (clean.startsWith("\\") || clean.startsWith("/")) {
    const sysRoot = _getSystemDriveRoot();
    const rest = clean.replace(/^[\\/]+/, "");
    return path.normalize(path.join(sysRoot, rest));
  }

  // 其他：相对路径（后续由 resolveNavPath 结合 base 解析）
  return path.normalize(clean);
}

/**
 * resolveNavPath：把用户键入的 path 解析成最终要访问的绝对目录
 * - 若 normalize 后已是绝对（含 UNC/盘符根），直接返回
 * - 否则按 baseDir 进行 resolve
 */
function resolveNavPath(rawPath, baseDir) {
  // 如果 qqq.js 新增了同名函数，优先使用
  const _qqq = geq();
  if (_qqq && typeof _qqq.resolveNavPath === "function") {
    try {
      return _qqq.resolveNavPath(rawPath, baseDir);
    } catch {
      /* fallthrough */
    }
  }

  const clean = normalizeNavPath(rawPath);
  if (!clean) return "";

  if (path.isAbsolute(clean)) return clean;

  const base = baseDir && typeof baseDir === "string" ? baseDir : process.cwd();
  return path.resolve(base, clean);
}

/**
 * canonicalizeExistingPath：对“存在于磁盘上的路径”做统一键（避免重复/缓存穿透）
 * - realpath（尽量）
 * - normalize
 * - 去尾分隔符（保留 root）
 * - Windows 盘符大写
 */
function canonicalizeExistingPath(p) {
  // 如果 qqq.js 新增了同名函数，优先使用（保证 q2/q1/其它模块 canonical 一致）
  const _qqq = geq();
  if (_qqq && typeof _qqq.canonicalizeExistingPath === "function") {
    try {
      return _qqq.canonicalizeExistingPath(p);
    } catch {
      /* fallthrough */
    }
  }

  if (!p) return "";
  let out = String(p);

  try {
    if (fs.existsSync(out)) {
      if (fs.realpathSync && fs.realpathSync.native) out = fs.realpathSync.native(out);
      else out = fs.realpathSync(out);
    }
  } catch {
    /* ignore */
  }

  out = path.normalize(out);

  if (process.platform === "win32") {
    out = out.replace(/^[a-z]:/, (m) => m.toUpperCase());
  }

  try {
    const root = path.parse(out).root;
    if (out.length > root.length) out = out.replace(/[\\/]+$/, "");
  } catch {
    /* ignore */
  }

  return out;
}

function cacheKeyForPath(p) {
  // 如果 qqq.js 导出了 cacheKeyForPath，优先用（保持统一 cacheKey 口径）
  const _qqq = geq();
  if (_qqq && typeof _qqq.cacheKeyForPath === "function") {
    try {
      return _qqq.cacheKeyForPath(p);
    } catch {
      /* fallthrough */
    }
  }

  const canon = canonicalizeExistingPath(p);
  return process.platform === "win32" ? canon.toLowerCase() : canon;
}

// ==================== 防惊群调度器（去重 + 限并发） ====================
class TaskScheduler {
  constructor(maxConcurrency = 6) {
    this.maxConcurrency = Math.max(1, maxConcurrency | 0);
    this.runningCount = 0;
    this.queue = [];
    this.pendingPromises = new Map();
  }

  async schedule(taskKey, taskGenerator) {
    if (this.pendingPromises.has(taskKey)) return this.pendingPromises.get(taskKey);

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
      this._next();
    });

    this.pendingPromises.set(taskKey, promise);
    return promise;
  }

  _next() {
    while (this.runningCount < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      task();
    }
  }
}

const globalScheduler = new TaskScheduler(MAX_CONCURRENT_TASKS);

// ==================== 缓存（folder/file size）====================
const folderSizeCache = new Map(); // key(folderPath) -> { size, ts }
const fileSizeCache = new Map(); // key(filePath)   -> { size, mtimeMs, ts }

function _pruneCacheIfNeeded(mapObj) {
  if (mapObj.size <= SIZE_CACHE_MAX_ENTRIES) return;
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

// ==================== 文件夹大小获取（使用 geq().js 四级回退 + 缓存 + 调度）====================
async function getFolderSize(folderPath) {
  const canon = canonicalizeExistingPath(folderPath);
  const key = cacheKeyForPath(canon);

  const now = Date.now();
  const cached = folderSizeCache.get(key);
  if (cached && now - cached.ts < SIZE_CACHE_MAX_AGE_MS) return cached.size;

  const taskKey = `folderSize:${key}`;
  return globalScheduler.schedule(taskKey, async () => {
    // 二次检查（并发下可能已有其它任务写入）
    const again = folderSizeCache.get(key);
    const now2 = Date.now();
    if (again && now2 - again.ts < SIZE_CACHE_MAX_AGE_MS) return again.size;

    try {
      const result = await geq().getFolderInfo(canon);
      if (result && result.success) {
        const sz = Number(result.total_size) || 0;
        folderSizeCache.set(key, { size: sz, ts: Date.now() });
        _pruneCacheIfNeeded(folderSizeCache);
        return sz;
      }
      if (result && result.error) throw new Error(result.error);
      throw new Error("unknown_error");
    } catch (error) {
      geq().logMessage(`获取文件夹大小失败: ${canon} - ${error.message}`, "ERROR");
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

  // 三段叠印：xxxxx xxxxx xxxxx（m/k/b 三段）
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
  const canon = canonicalizeExistingPath(itemPath);
  const key = cacheKeyForPath(canon);

  return globalScheduler.schedule(`sizeDisplay:${mode}:${key}`, async () => {
    if (mode === "none") return "";

    try {
      const stats = await fs.promises.stat(canon);

      const handleSize = (sizeInBytes) => {
        const formatted = formatFileSize(sizeInBytes, mode);
        return formatted.show ? formatted.text : "";
      };

      if (stats.isFile()) {
        const now = Date.now();
        const cached = fileSizeCache.get(key);
        if (
          cached &&
          cached.mtimeMs === stats.mtimeMs &&
          now - cached.ts < SIZE_CACHE_MAX_AGE_MS
        ) {
          return handleSize(cached.size);
        }
        const sz = Number(stats.size) || 0;
        fileSizeCache.set(key, { size: sz, mtimeMs: stats.mtimeMs, ts: Date.now() });
        _pruneCacheIfNeeded(fileSizeCache);
        return handleSize(sz);
      } else {
        const folderSz = await getFolderSize(canon);
        return handleSize(folderSz);
      }
    } catch (err) {
      geq().logMessage(`计算大小失败: ${canon} - ${err.message}`, "ERROR");
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

  // ★ 终极最优解：容错性配置加载，防止 globalState 返回非预期值
  const storedConfig = globalContext.globalState.get("qqq_config") || {};
  const config = { ...defaultConfig, ...storedConfig };

  // 确保数组字段存在
  if (!Array.isArray(config.recentDirs)) config.recentDirs = [];
  if (!Array.isArray(config.recycleBin)) config.recycleBin = [];
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
      config.isPinned,
      config.sizeMode,
      config.kbmOverlap
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
    config.isPinned,
    config.sizeMode,
    config.kbmOverlap
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
    config.isPinned,
    config.sizeMode,
    config.kbmOverlap
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
      geq().logMessage("获取驱动器列表失败: " + error.message, "ERROR");
      drives.push("C:");
    }
  } else {
    drives.push("/");
  }
  return drives;
}

function getDirectoryContents(dirPath) {
  const contents = { dirs: [], files: [] };
  const canonDir = canonicalizeExistingPath(dirPath);

  try {
    const entries = fs.readdirSync(canonDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(canonDir, entry.name);
      try {
        const stat = fs.statSync(entryPath);
        const item = {
          name: entry.name,
          path: canonicalizeExistingPath(entryPath),
          isDir: entry.isDirectory(),
          mtime: stat.mtime.toISOString(),
        };
        if (item.isDir) contents.dirs.push(item);
        else contents.files.push(item);
      } catch {
        /* ignore */
      }
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    contents.dirs.sort((a, b) => collator.compare(a.name, b.name));
    contents.files.sort((a, b) => collator.compare(a.name, b.name));
  } catch (error) {
    geq().logMessage(`读取目录内容失败: ${canonDir} - ${error.message}`, "ERROR");
  }

  return contents;
}

// ==================== Webview 脚本生成 ====================
function generateWebviewScript(currentSizeMode, currentPath, sidebarRatio) {
  const escapedCurrentPath = escapeJsStringLiteral(currentPath);
  const escapedSizeMode = escapeJsStringLiteral(currentSizeMode);
  const escapedSidebarRatio = Number(sidebarRatio || 0.2).toFixed(4);

  return `
const vscode = acquireVsCodeApi();

let sizeMode = '${escapedSizeMode}';
let currentPath = '${escapedCurrentPath}';
let sidebarRatio = ${escapedSidebarRatio};

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

function setSizeMode(mode){
  hideAllContextMenus();
  vscode.postMessage({ command: 'setSizeMode', mode });
}

// ===== 选择/重命名 =====
let selectedItem = null;
let currentFocusType = 'filenameInput';

function updateFocusType(element){
  if (!element) { currentFocusType = 'other'; return; }
  if (['filenameInput', 'addressInput'].includes(element.id) || element.classList.contains('rename-input')) currentFocusType = 'input';
  else if (element.classList.contains('file-list-container') || element.closest('.file-list-container')) currentFocusType = 'fileList';
  else if (element.classList.contains('sidebar') || element.closest('.sidebar')) currentFocusType = 'sidebar';
  else if (element.classList.contains('recent-section') || element.closest('.recent-section')) currentFocusType = 'recentSection';
  else currentFocusType = 'other';
}

function selectFileItem(fileItem, requestSize){
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

  const nameArea = itemElement.querySelector(\`.\\\${itemType === 'file' ? 'file' : 'folder'}-name-area\`);
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
  const nameArea = itemElement.querySelector(\`.\\\${itemType === 'file' ? 'file' : 'folder'}-name-area\`);
  if (nameArea) {
    nameArea.innerHTML = originalContent || \`<span class="file-name">\\\${itemElement.dataset.name}</span>\`;
  }
}

// ===== 操作 =====
function performEditAction(item){ if (item) startRename(item.path, item.name, item.type); }
function performOpenAction(item){ if (item) vscode.postMessage({ command: 'openWithDefault', path: item.path, type: item.type }); }
function performDeleteAction(item){
  if (!item) return;
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
function performSizeAction(item){
  if (!item) return;
  const el = findItemElementByPath(item.path);
  if (el) {
    const sz = el.querySelector('.sz-area');
    if (sz) sz.textContent = '    \\u2022    ';
  }
  vscode.postMessage({ command: 'refreshSize', path: item.path, type: item.type });
}

// ===== 右键菜单 =====
function handleContextMenuAction(action){
  const menu = document.getElementById('itemContextMenu');
  if (!menu) return;
  const item = { path: menu.dataset.path, name: menu.dataset.name, type: menu.dataset.type };
  hideAllContextMenus();
  if (!item.path) return;

  switch(action){
    case 'rename': performEditAction(item); break;
    case 'open': performOpenAction(item); break;
    case 'delete': performDeleteAction(item); break;
    case 'code': performCodeAction(item); break;
    case 'size': performSizeAction(item); break;
  }
}

function refreshSizeDisplay(){
  const items = document.querySelectorAll('.file-item');
  items.forEach(item => {
    const szArea = item.querySelector('.sz-area');
    if (!szArea) return;
    if (sizeMode !== 'none') {
      szArea.textContent = '    \\u2022    ';
      vscode.postMessage({ command: 'requestSize', path: item.dataset.path, type: item.dataset.type });
    } else {
      szArea.textContent = '';
    }
  });
}

function requestFileSizeUpdates(items){
  if (sizeMode === 'none') return;
  items.forEach(item => {
    if (!item || item.name === '..') return;
    // 文件/文件夹都允许 requestSize（文件会命中 stat；文件夹会走 folderSize）
    const el = findItemElementByPath(item.path, item.type);
    if (el) {
      const sz = el.querySelector('.sz-area');
      if (sz) sz.textContent = '    \\u2022    ';
    }
    vscode.postMessage({ command: 'requestSize', path: item.path, type: item.type, name: item.name });
  });
}

// ====== message ======
window.addEventListener('message', event => {
  const message = event.data;
  if (!message) return;

  if (message.command === 'update') {
    const addr = document.getElementById('addressInput');
    if (addr) addr.value = message.currentPath || '';
    const list = document.getElementById('fileList');
    if (list) list.innerHTML = message.fileListHtml || '';
    requestFileSizeUpdates(message.items || []);
    setTimeout(() => { calculateAndAdjustScroll(); checkAndApplyResponsive(); }, 100);
  } else if (message.command === 'updateSize') {
    const el = findItemElementByPath(message.path, message.type);
    if (el) {
      const sz = el.querySelector('.sz-area');
      if (sz) sz.textContent = message.sizeDisplay || '';
    }
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' && currentFocusType !== 'input') {
    e.preventDefault();
    vscode.postMessage({ command: 'navigateUp' });
  }
});

document.addEventListener('keydown', (e) => {
  if (currentFocusType === 'input' || !selectedItem) return;
  const key = (e.key || '').toLowerCase();

  // 避免把 ctrl+a/c/x 吞掉（让 vscode/webview 自己处理）
  if (e.ctrlKey && (key === 'a' || key === 'c' || key === 'x')) { e.preventDefault(); e.stopPropagation(); return; }

  if (key === 'q') { e.preventDefault(); e.stopPropagation(); performCodeAction(selectedItem); }
  else if (key === 'w') { e.preventDefault(); e.stopPropagation(); performOpenAction(selectedItem); }
  else if (key === 's') { e.preventDefault(); e.stopPropagation(); performDeleteAction(selectedItem); }
  else if (key === 'e') { e.preventDefault(); e.stopPropagation(); performEditAction(selectedItem); }
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

      selectFileItem(fileItem, true);
      if (isSzArea) {
        const szArea = event.target;
        szArea.textContent = '    \\u2022    ';
        vscode.postMessage({ command: 'requestSize', path: fileItem.dataset.path, type });
      }
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
        selectFileItem(itemElement, false);

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
        else if (act === 'cancel') cancel();
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
window.setSizeMode = setSizeMode;
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
  });

  function updateResourceExplorer() {
    try {
      if (!panel || !activePanelAlive) return;

      const directoryContents = getDirectoryContents(currentPath);
      const items = [];
      let fileListHtml = "";

      // 允许返回上级：root 不显示 ..
      const canonCur = canonicalizeExistingPath(currentPath);
      const parent = canonicalizeExistingPath(path.dirname(canonCur));
      const root = (() => {
        try {
          return path.parse(canonCur).root || "";
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
        items.push({ path: dir.path, name: dir.name, type: "folder" });
        fileListHtml += `<div class="file-item folder" data-path="${escapeHtmlAttribute(
          dir.path
        )}" data-name="${escapeHtmlAttribute(dir.name)}" data-type="folder"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">📁</span></div><div class="folder-name-area"><span class="file-name">${escapeHtmlAttribute(
          dir.name
        )}</span></div></div>`;
      });

      directoryContents.files.forEach((file) => {
        items.push({ path: file.path, name: file.name, type: "file" });
        fileListHtml += `<div class="file-item file" data-path="${escapeHtmlAttribute(
          file.path
        )}" data-name="${escapeHtmlAttribute(file.name)}" data-type="file"><div class="file-select-area"><div class="sz-area"></div><span class="file-icon">🗎</span></div><div class="file-name-area"><span class="file-name">${escapeHtmlAttribute(
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
      geq().logMessage(`更新资源展示区失败: ${error}`, "ERROR");
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
      geq().logMessage("Refresh Webview failed: " + e.message, "ERROR");
    }
  }

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
              path: canonicalizeExistingPath(message.path),
              type: message.type,
              sizeDisplay: display,
            });
          }
        } catch { }
        break;

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

            vscode.workspace.openTextDocument(fullFilePath).then((doc) => {
              global.showTextDocument(doc, getShowOptions(openInCurrentGroup)).then(() => {
                if (!isPinned) {
                  if (panel && activePanelAlive) panel.dispose();
                } else {
                  if (panel && activePanelAlive) refreshWebview();
                }
              });
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

        vscode.workspace
          .openTextDocument(p)
          .then((doc) => {
            vscode.window.showTextDocument(doc, getShowOptions(message.openInCurrentGroup)).then(() => {
              if (!message.isPinned && panel && activePanelAlive) panel.dispose();
            });
          })
          .catch((error) => vscode.window.showErrorMessage("打开文件失败: " + error.message));
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
        global.openExternal(vscode.Uri.file(p));
        refreshWebview();
        break;
      }

      case "quickDeleteToRecycleBin": {
        const itemToDelete = canonicalizeExistingPath(message.path);
        if (fs.existsSync(itemToDelete)) {
          saveRecentDirectory(currentPath);
          (async () => {
            try {
              const { default: trash } = await import("trash");
              await trash([itemToDelete]);
              setTimeout(() => {
                if (activePanel && activePanelAlive) refreshWebview();
              }, 300);
              global.setStatusBarMessage(`${path.basename(itemToDelete)} 已移至回收站`, 5000);
            } catch (error) {
              if (panel && activePanelAlive)
                panel.webview.postMessage({ command: "restoreDeletedItem", path: itemToDelete });
              global.showErrorMessage("删除失败：文件正被占用。");
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

  isCoreIntegrityValid = verifySystemIntegrity();
  geq().logMessage(`Q2 Integrity: ${isCoreIntegrityValid ? "PASSED" : "FAILED"}`, "INFO");

  getConfig();
  geq().logMessage("Q2: 文件管理器已激活（使用 geq().js 四级回退 + size调度/缓存 + 最新 IO 路径逻辑）", "INFO");

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
}

module.exports = { activate, deactivate };

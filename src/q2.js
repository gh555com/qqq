// ★★★ File Manager: Webview UI + use geq().js four-level fallback + thundering-herd-proof size scheduling/cache ★★★
// Adaptation: match latest qqq IO engine path logic (cross-platform normalize + keep absolute paths + canonical dedup)
// Note: this file has built-in normalize/resolve/canonical; if geq().js exports same-name functions it will automatically prefer qqq's implementation

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const cp = require("child_process");
const h = require("./h");
const { q, onLanguageChange } = require("./i18n");

// ★★★ Paste feature core module: import transaction manager, task counter, clipboard snapshot, etc. from global.js ★★★
const { TransactionManager, TaskCounter, TaskMessage, wq, savePasteStats, cancelScans } = require("./global");

// ==================== Import core interfaces from geq().js ====================
// Lazy-load qqq to avoid circular dependency
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


// ==================== Configuration Constants ====================

// Concurrency control
const MAX_CONCURRENT_TASKS = 6;

const UNSUPPORTED_CODE_EXTENSIONS = global.NON_TEXT_EXTS;

// ==================== Utility Functions ====================

/**
 * Sanitize a string for use as webview panel tab title
 * @param {string} str - Raw title string
 * @param {number} maxBytes - Maximum byte length (default 222)
 * @returns {string} Sanitized title safe for VS Code tab display
 */
function sanitizeTabTitle(str, maxBytes = 222) {
  if (!str || typeof str !== "string") return "的梦gaea";

  let s = str
    // 1) Remove newlines (DESTRUCTIVE: break tab display)
    .replace(/[\r\n]/g, "")
    // 2) Remove control characters ASCII 0-31 except space (DESTRUCTIVE: break rendering)
    .replace(/[\x00-\x1F]/g, "")
    // 3) Strip HTML tags (DESTRUCTIVE: potential injection / settings.json corruption)
    .replace(/<[^>]*>/g, "")
    .trim();

  // 4) Limit byte length (DESTRUCTIVE: excessive memory / settings.json bloat)
  const encoder = new TextEncoder();
  let bytes = encoder.encode(s);
  if (bytes.length > maxBytes) {
    // Truncate and ensure valid UTF-8 (avoid cutting in middle of multi-byte char)
    bytes = bytes.slice(0, maxBytes);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    s = decoder.decode(bytes).replace(/\uFFFD$/, ""); // Remove trailing replacement char
  }

  return s || "的梦gaea"; // Fallback if everything was stripped
}

// ==================== Global Variables ====================
let activePanel = null;
let activePanelAlive = false;
let currentWatcher = null; // Used to watch current directory changes
let sRequestVersion = 0; // sRequest version number, used to cancel stale requests
const usePanelReveal = 1;

// ★ q2 window tracking via temp file (for Space+Q hotkey, cross-IDE)
const Q2_TRACKING_FILE = path.join(os.tmpdir(), 'vix_q2_windows.json');
const _updateQ2TrackingFile = (action) => {
  // action: 'register' - add/update this window in tracking file
  if (!activePanelAlive || action !== 'register') return;
  if (!global.pythonBridge?.isAvailable()) return;

  // Get current foreground window hwnd via Python and write to file
  const procName = path.basename(process.execPath);
  global.pythonBridge.call("get_foreground_hwnd", { expected_proc: procName }, 1000)
    .then(r => {
      if (r?.hwnd) {
        try {
          let records = {};
          if (fs.existsSync(Q2_TRACKING_FILE)) {
            try { records = JSON.parse(fs.readFileSync(Q2_TRACKING_FILE, 'utf8')); } catch {}
          }
          // Add/update current window with timestamp and process name
          records[String(r.hwnd)] = { ts: Date.now(), proc: procName };

          // Clean up stale records (> 7 days) and dead/legacy windows
          const now = Date.now();
          const sevenDays = 7 * 24 * 60 * 60 * 1000;
          for (const key in records) {
            const entry = records[key];
            // Entry must be an object with a valid timestamp and the correct process name
            if (typeof entry !== 'object' || !entry.ts || (now - entry.ts) > sevenDays || entry.proc !== procName) {
              delete records[key];
            }
          }
          fs.writeFileSync(Q2_TRACKING_FILE, JSON.stringify(records), 'utf8');
        } catch (e) {
          console.error('[q2.js] _updateQ2TrackingFile write error:', e);
        }
      } else {
        // ★ Log if python returns an error or no hwnd
        console.error('[q2.js] get_foreground_hwnd call failed. Response:', r);
      }
    })
    .catch(err => {
      // ★ Log if the python call itself fails
      console.error('[q2.js] get_foreground_hwnd call threw an error:', err);
    });
};




let globalContext = null;

// Global refresh function reference (set by showSaveAsDialog)
let globalRefreshWebview = null;

let cachedInMemoryConfig = null; // Add in-memory cache to prevent read delay/conflicts caused by globalState debounce
let lastResourceExplorerPath = ""; // Record last path used to update the resource display area, used to clear size cache

// ==================== IO / Path: match latest engine logic (key) ====================

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

// =============================================================================
// Windows .lnk shortcut parser (pure Node.js Buffer, no daemon/shell dependency)
// Spec: MS-SHLLINK (Shell Link Binary File Format)
// =============================================================================

/**
 * Parse Windows .lnk shortcut file and extract target path
 * @param {string} lnkPath - Path to .lnk file
 * @returns {string|null} - Target path or null if parsing fails
 */
function parseLnkTarget(lnkPath) {
  try {
    const buf = fs.readFileSync(lnkPath);

    // Minimum valid .lnk size: 76 bytes header
    if (buf.length < 76) return null;

    // Verify magic number: 4C 00 00 00
    if (buf.readUInt32LE(0) !== 0x4C) return null;

    // Read LinkFlags at offset 0x14 (20)
    const linkFlags = buf.readUInt32LE(0x14);
    const hasLinkTargetIDList = (linkFlags & 0x01) !== 0;
    const hasLinkInfo = (linkFlags & 0x02) !== 0;

    // Start after 76-byte header
    let offset = 76;

    // Skip LinkTargetIDList if present
    if (hasLinkTargetIDList) {
      if (offset + 2 > buf.length) return null;
      const idListSize = buf.readUInt16LE(offset);
      offset += 2 + idListSize;
    }

    // Try to get path from LinkInfo first (works for pure ASCII paths)
    let ansiPath = null;
    if (hasLinkInfo) {
      if (offset + 28 <= buf.length) {
        const linkInfoStart = offset;
        const linkInfoSize = buf.readUInt32LE(offset);
        const linkInfoHeaderSize = buf.readUInt32LE(offset + 4);
        const linkInfoFlags = buf.readUInt32LE(offset + 8);
        const hasVolumeIDAndLocalBasePath = (linkInfoFlags & 0x01) !== 0;

        if (hasVolumeIDAndLocalBasePath && linkInfoSize >= 28) {
          const localBasePathOffset = buf.readUInt32LE(offset + 16);

          // Try Unicode path first (header size >= 0x24)
          if (linkInfoHeaderSize >= 0x24 && offset + 32 <= buf.length) {
            const localBasePathOffsetUnicode = buf.readUInt32LE(offset + 28);
            if (localBasePathOffsetUnicode > 0 && localBasePathOffsetUnicode < linkInfoSize) {
              const unicodeStart = linkInfoStart + localBasePathOffsetUnicode;
              let unicodeEnd = unicodeStart;
              while (unicodeEnd + 1 < buf.length && !(buf[unicodeEnd] === 0 && buf[unicodeEnd + 1] === 0)) {
                unicodeEnd += 2;
              }
              if (unicodeEnd > unicodeStart) {
                const targetPath = buf.slice(unicodeStart, unicodeEnd).toString('utf16le');
                if (targetPath && targetPath.length > 2 && fs.existsSync(targetPath)) {
                  return targetPath;
                }
              }
            }
          }

          // Try ANSI path (save for later validation)
          if (localBasePathOffset > 0 && localBasePathOffset < linkInfoSize) {
            const ansiStart = linkInfoStart + localBasePathOffset;
            let ansiEnd = ansiStart;
            while (ansiEnd < buf.length && buf[ansiEnd] !== 0) {
              ansiEnd++;
            }
            if (ansiEnd > ansiStart) {
              ansiPath = buf.slice(ansiStart, ansiEnd).toString('latin1');
              // If ANSI path exists and is valid, use it
              if (ansiPath && ansiPath.length > 2 && fs.existsSync(ansiPath)) {
                return ansiPath;
              }
            }
          }
        }
      }
    }

    // Fallback: Scan entire file for Unicode path pattern "X:\" (works for non-ASCII paths)
    // Pattern: [A-Z] 00 3A 00 5C 00 (drive letter : \)
    for (let i = 0; i < buf.length - 10; i++) {
      const byte0 = buf[i];
      // Check for drive letter (A-Z) followed by 00 3A 00 5C 00 (:\)
      if (byte0 >= 0x41 && byte0 <= 0x5A && buf[i + 1] === 0 &&
          buf[i + 2] === 0x3A && buf[i + 3] === 0 &&
          buf[i + 4] === 0x5C && buf[i + 5] === 0) {
        // Found potential Unicode path, extract it
        let end = i;
        while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) {
          end += 2;
        }
        if (end > i + 4) {
          const unicodePath = buf.slice(i, end).toString('utf16le');
          // Validate: must be absolute path and longer than ANSI path (more specific)
          if (unicodePath && unicodePath.length > 3 && /^[A-Z]:\\.+/.test(unicodePath)) {
            // Prefer longer paths (more complete) and existing paths
            if (fs.existsSync(unicodePath)) {
              return unicodePath;
            }
          }
        }
      }
    }

    // Last resort: return ANSI path even if it doesn't exist (let caller handle)
    return ansiPath;
  } catch (e) {
    return null;
  }
}

// =============================================================================
// Non-blocking delete utilities (yield every N items to prevent Extension Host freeze)
// =============================================================================

const DELETE_BATCH_SIZE = 50; // yield every 50 items

/**
 * Map FileSystemError code to i18n key
 * @param {Error} error - the error object
 * @returns {string} - localized error message
 */
function mapFsErrorToI18n(error) {
  // VS Code FileSystemError codes
  const errorCodeMap = {
    'FileNotFound': 'q2.fsError.fileNotFound',
    'FileExists': 'q2.fsError.fileExists',
    'FileNotADirectory': 'q2.fsError.fileNotADirectory',
    'FileIsADirectory': 'q2.fsError.fileIsADirectory',
    'NoPermissions': 'q2.fsError.noPermissions',
    'Unavailable': 'q2.fsError.unavailable',
    // Node.js errno codes (for fallback paths)
    'ENOENT': 'q2.fsError.fileNotFound',
    'EEXIST': 'q2.fsError.fileExists',
    'EACCES': 'q2.fsError.noPermissions',
    'EPERM': 'q2.fsError.noPermissions',
    'EBUSY': 'q2.fsError.fileBusy',
    'ENOTEMPTY': 'q2.fsError.dirNotEmpty',
  };

  const code = error.code || error.name;
  const i18nKey = errorCodeMap[code];

  if (i18nKey) {
    return q(i18nKey);
  }
  // Fallback to original message if code unknown
  return error.message;
}

/**
 * Yield to event loop using setImmediate
 */
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Log delete errors with limit (avoid blocking with 200k+ errors)
 * @param {Array} errors - Array of {path, error} objects
 * @param {number} maxLogs - Maximum number of errors to log (default 100)
 */
function logDeleteErrors(errors, maxLogs = 100) {
  if (!errors || errors.length === 0) return;

  // Log limited number asynchronously to avoid blocking
  const toLog = errors.slice(0, maxLogs);
  setImmediate(() => {
    for (const e of toLog) {
      global.logMessage(`Delete error: ${e.path} - ${e.error}`, "WARN");
    }
    if (errors.length > maxLogs) {
      global.logMessage(`... and ${errors.length - maxLogs} more errors (truncated)`, "WARN");
    }
  });
}

/**
 * Check if errors contain permission denied (EPERM) and offer admin command
 * @param {Array} errors - Array of {path, error} objects
 * @param {string} targetPath - The root path being deleted
 */
async function handlePermissionErrors(errors, targetPath) {
  if (!errors || errors.length === 0 || process.platform !== 'win32') return;

  // Check if any errors are permission-related
  const permissionErrors = errors.filter(e =>
    e.error.includes('权限不足') ||
    e.error.includes('Permission denied') ||
    e.error.includes('EPERM')
  );

  if (permissionErrors.length === 0) return;

  // Show prompt with copy command option
  const choice = await vscode.window.showWarningMessage(
    q('q2.ui.needAdminPermission', permissionErrors.length),
    q('q2.ui.copyAdminCommand')
  );

  if (choice === q('q2.ui.copyAdminCommand')) {
    // Generate admin command: takeown + icacls + rd
    const escapedPath = targetPath.replace(/'/g, "''");
    const cmd = `takeown /F "${escapedPath}" /R /D Y && icacls "${escapedPath}" /grant Administrators:F /T && rd /s /q "${escapedPath}"`;

    await vscode.env.clipboard.writeText(cmd);
    vscode.window.showInformationMessage(q('q2.ui.adminCommandCopied'));

    // Auto-open admin terminal (CMD for Windows, since command uses CMD syntax)
    const parentDir = path.dirname(targetPath);
    openAdminTerminal(parentDir, 'cmd');
  }
}

/**
 * Non-blocking recursive directory walk
 * @param {string} dir - directory to walk
 * @param {object} ctx - context: { files: [], dirs: [], scanned: 0, cancelled: false }
 * @param {function} onProgress - callback(scanned) for progress updates
 * @returns {Promise<void>}
 */
async function walkDirNonBlocking(dir, ctx, onProgress) {
  if (ctx.cancelled) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // Permission denied or other error, skip this directory
    return;
  }

  for (const entry of entries) {
    if (ctx.cancelled) return;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectory first (depth-first)
      await walkDirNonBlocking(fullPath, ctx, onProgress);
      // Add directory AFTER processing its contents (so deeper dirs come first in reverse)
      ctx.dirs.push(fullPath);
    } else {
      ctx.files.push(fullPath);
    }

    ctx.scanned++;

    // Yield every DELETE_BATCH_SIZE items
    if (ctx.scanned % DELETE_BATCH_SIZE === 0) {
      if (onProgress) onProgress(ctx.scanned);
      await yieldToEventLoop();
    }
  }
}

/**
 * Expand a path (file or directory) to list of all files and directories inside
 * @param {string} targetPath - file or directory path
 * @param {object} ctx - context with cancelled flag, files[], dirs[]
 * @param {function} onProgress - progress callback
 * @returns {Promise<void>}
 */
async function expandPathNonBlocking(targetPath, ctx, onProgress) {
  const stat = fs.statSync(targetPath, { throwIfNoEntry: false });
  if (!stat) return;

  if (stat.isFile()) {
    ctx.files = [targetPath];
    ctx.dirs = [];
    return;
  }

  // It's a directory, walk it
  ctx.files = [];
  ctx.dirs = [];
  ctx.scanned = 0;
  await walkDirNonBlocking(targetPath, ctx, onProgress);
  // Note: ctx.dirs is in depth-first order (deepest subdirs at the END)
  // We'll reverse it when deleting to delete deepest first
}

/**
 * Delete items with progress, cancellation support, and error tolerance
 * @param {string} targetPath - single file/directory to delete
 * @param {boolean} useTrash - true for recycle bin, false for permanent delete
 * @param {string} displayName - name to show in progress
 * @returns {Promise<{success: boolean, deleted: number, errors: Array}>}
 */
async function deleteWithProgressUI(targetPath, useTrash, displayName) {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: useTrash ? q('q2.ui.movingToTrash', displayName) : q('q2.ui.permanentlyDeleting', displayName),
    cancellable: true
  }, async (progress, token) => {
    const ctx = { files: [], dirs: [], scanned: 0, cancelled: false };
    const errors = [];
    let deleted = 0;

    // Listen for cancellation
    token.onCancellationRequested(() => {
      ctx.cancelled = true;
    });

    // Phase 1: Expand (scan all files and directories)
    progress.report({ message: q('q2.ui.scanning'), increment: 0 });

    const stat = fs.statSync(targetPath, { throwIfNoEntry: false });
    if (!stat) {
      return { success: false, deleted: 0, errors: [{ path: targetPath, error: 'not_found' }] };
    }

    const isDir = stat.isDirectory();

    if (isDir) {
      await expandPathNonBlocking(targetPath, ctx, (scanned) => {
        progress.report({ message: q('q2.ui.scannedFiles', scanned) });
      });
    }

    if (ctx.cancelled) {
      return { success: false, deleted: 0, errors: [], cancelled: true };
    }

    const totalFiles = isDir ? ctx.files.length : 1;
    const totalDirs = isDir ? ctx.dirs.length : 0;

    // Phase 2: Delete files (for directories, delete contents first)
    if (isDir && ctx.files.length > 0) {
      progress.report({ message: q('q2.ui.deletingFiles', 0, totalFiles), increment: 0 });

      for (let i = 0; i < ctx.files.length; i++) {
        if (ctx.cancelled) break;

        const filePath = ctx.files[i];
        try {
          const uri = vscode.Uri.file(filePath);
          await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: useTrash });
          deleted++;
        } catch (e) {
          errors.push({ path: filePath, error: mapFsErrorToI18n(e) });
          // Log first 5 errors with full details for debugging
          if (errors.length <= 5) {
            global.logMessage(`[DELETE DEBUG] File delete failed: ${filePath}, code=${e.code}, name=${e.name}, msg=${e.message}`, "WARN");
          }
        }

        // Yield every batch
        if ((i + 1) % DELETE_BATCH_SIZE === 0) {
          progress.report({ message: q('q2.ui.deletingFiles', i + 1, totalFiles) });
          await yieldToEventLoop();
        }
      }
    }

    if (ctx.cancelled) {
      return { success: deleted > 0, deleted, errors, cancelled: true };
    }

    // Phase 3: Delete subdirectories bottom-up (deepest first)
    if (isDir && ctx.dirs.length > 0) {
      // Sort by path depth descending (deepest directories first)
      const dirsToDelete = ctx.dirs.slice().sort((a, b) => {
        const depthA = a.split(path.sep).length;
        const depthB = b.split(path.sep).length;
        return depthB - depthA; // Deeper paths first
      });

      progress.report({ message: q('q2.ui.deletingDirs', 0, totalDirs) });

      for (let i = 0; i < dirsToDelete.length; i++) {
        if (ctx.cancelled) break;

        const dirPath = dirsToDelete[i];
        try {
          const uri = vscode.Uri.file(dirPath);
          await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: useTrash });
        } catch (e) {
          errors.push({ path: dirPath, error: mapFsErrorToI18n(e) });
        }

        // Yield every batch
        if ((i + 1) % DELETE_BATCH_SIZE === 0) {
          progress.report({ message: q('q2.ui.deletingDirs', i + 1, totalDirs) });
          await yieldToEventLoop();
        }
      }
    }

    if (ctx.cancelled) {
      return { success: deleted > 0, deleted, errors, cancelled: true };
    }

    // Phase 4: Delete the root directory/file itself (should be empty now)
    progress.report({ message: q('q2.ui.finalizingDelete') });

    try {
      const uri = vscode.Uri.file(targetPath);
      // Use recursive:false since we've already deleted all contents
      await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: useTrash });
      if (!isDir) deleted++;
    } catch (e) {
      // If directory deletion fails, it might be because some files couldn't be deleted
      // Only add error if we haven't already recorded file errors
      if (errors.length === 0) {
        errors.push({ path: targetPath, error: mapFsErrorToI18n(e) });
      }
    }

    return { success: errors.length === 0, deleted: isDir ? deleted : 1, errors };
  });
}

/**
 * Delete multiple items with progress (each item goes through expand-then-delete)
 * @param {Array} items - array of {path, type} objects
 * @param {boolean} useTrash - true for recycle bin
 * @returns {Promise<{deleted: number, errors: Array}>}
 */
async function deleteMultipleWithProgressUI(items, useTrash) {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: useTrash ? q('q2.ui.movingMultipleToTrash', items.length) : q('q2.ui.permanentlyDeletingMultiple', items.length),
    cancellable: true
  }, async (progress, token) => {
    const errors = [];
    let deleted = 0;
    let cancelled = false;
    const ctx = { files: [], dirs: [], scanned: 0, cancelled: false };

    token.onCancellationRequested(() => {
      cancelled = true;
      ctx.cancelled = true;
    });

    for (let i = 0; i < items.length; i++) {
      if (cancelled) break;

      const item = items[i];
      const itemPath = canonicalizeExistingPath(item.path);
      const itemName = path.basename(itemPath);

      // Check if path exists
      const stat = fs.statSync(itemPath, { throwIfNoEntry: false });
      if (!stat) {
        errors.push({ path: itemPath, error: q('q2.fsError.fileNotFound') });
        continue;
      }

      const isDir = stat.isDirectory();

      // Phase 1: Expand directory (if applicable)
      if (isDir) {
        progress.report({ message: q('q2.ui.deletingItem', i + 1, items.length, itemName) + ' - ' + q('q2.ui.scanning') });
        ctx.files = [];
        ctx.dirs = [];
        ctx.scanned = 0;
        await expandPathNonBlocking(itemPath, ctx, (scanned) => {
          progress.report({ message: q('q2.ui.deletingItem', i + 1, items.length, itemName) + ' - ' + q('q2.ui.scannedFiles', scanned) });
        });

        if (ctx.cancelled) break;

        // Phase 2: Delete files inside directory
        const totalFiles = ctx.files.length;
        for (let j = 0; j < ctx.files.length; j++) {
          if (ctx.cancelled) break;

          const filePath = ctx.files[j];
          try {
            const uri = vscode.Uri.file(filePath);
            await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: useTrash });
          } catch (e) {
            errors.push({ path: filePath, error: mapFsErrorToI18n(e) });
          }

          // Yield every batch
          if ((j + 1) % DELETE_BATCH_SIZE === 0) {
            progress.report({ message: q('q2.ui.deletingItem', i + 1, items.length, itemName) + ' - ' + q('q2.ui.deletingFiles', j + 1, totalFiles) });
            await yieldToEventLoop();
          }
        }

        if (ctx.cancelled) break;

        // Phase 3: Delete subdirectories bottom-up (deepest first)
        if (ctx.dirs.length > 0) {
          // Sort by path depth descending (deepest directories first)
          const dirsToDelete = ctx.dirs.slice().sort((a, b) => {
            const depthA = a.split(path.sep).length;
            const depthB = b.split(path.sep).length;
            return depthB - depthA; // Deeper paths first
          });
          const totalDirs = dirsToDelete.length;

          for (let j = 0; j < dirsToDelete.length; j++) {
            if (ctx.cancelled) break;

            const dirPath = dirsToDelete[j];
            try {
              const uri = vscode.Uri.file(dirPath);
              await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: useTrash });
            } catch (e) {
              errors.push({ path: dirPath, error: mapFsErrorToI18n(e) });
            }

            // Yield every batch
            if ((j + 1) % DELETE_BATCH_SIZE === 0) {
              progress.report({ message: q('q2.ui.deletingItem', i + 1, items.length, itemName) + ' - ' + q('q2.ui.deletingDirs', j + 1, totalDirs) });
              await yieldToEventLoop();
            }
          }
        }
      }

      if (ctx.cancelled) break;

      // Phase 4: Delete the item itself (should be empty now)
      progress.report({
        message: q('q2.ui.deletingItem', i + 1, items.length, itemName),
        increment: 100 / items.length
      });

      try {
        const uri = vscode.Uri.file(itemPath);
        // Use recursive:false since we've already deleted all contents
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: useTrash });
        deleted++;
      } catch (e) {
        // Only add error if we haven't already recorded file errors for this item
        const hasItemErrors = errors.some(err => err.path.startsWith(itemPath));
        if (!hasItemErrors) {
          errors.push({ path: itemPath, error: mapFsErrorToI18n(e) });
        }
      }

      // Yield between items
      await yieldToEventLoop();
    }

    return { deleted, errors, cancelled };
  });
}

let activeAbortController = new AbortController();

const globalScheduler = new global.TaskScheduler(MAX_CONCURRENT_TASKS);

/**
 * Cancel all engine scan operations (Node + Python + Rust)
 */
function cancelAllScans() {
  // Node engine: takes effect immediately
  try { geq().cancelScansJS(); } catch { }
  // Python/Rust daemon: send cancel command
  cancelScans();
}

/**
 * Open admin terminal (CMD or PowerShell)
 * @param {string} targetPath - target directory path
 * @param {string} termType - 'cmd' or 'powershell'
 */
function openAdminTerminal(targetPath, termType) {
  try {
    const absPath = path.resolve(targetPath);
    const platform = process.platform;

    if (platform === 'win32') {
      // Windows: use PowerShell Start-Process -Verb RunAs for elevation
      // Escape single quotes for PowerShell and use single-quoted path to avoid backslash escape issues
      const safePath = absPath.replace(/'/g, "''");

      if (termType === 'cmd') {
        // Admin CMD: cd /d to target directory
        const psScript = `Start-Process cmd.exe -ArgumentList '/k','cd /d """${safePath}"""' -Verb RunAs`;
        cp.spawn('powershell.exe', ['-NoProfile', '-Command', psScript], { windowsHide: true, shell: false });
      } else {
        // Admin PowerShell: Set-Location to target directory
        // Use triple quotes to properly escape path with trailing backslash (e.g. C:\)
        const psScript = `Start-Process powershell.exe -ArgumentList '-NoExit','-Command',"Set-Location -LiteralPath '${safePath}'" -Verb RunAs`;
        cp.spawn('powershell.exe', ['-NoProfile', '-Command', psScript], { windowsHide: true, shell: false });
      }
    } else if (platform === 'darwin') {
      // macOS: use osascript to open Terminal with sudo
      const escapedPath = absPath.replace(/'/g, "'\\''");
      const script = `tell application "Terminal" to do script "cd '${escapedPath}' && sudo -s"`;
      cp.spawn('osascript', ['-e', script], { detached: true }).unref();
    } else {
      // Linux: try common terminal emulators
      const escapedPath = absPath.replace(/'/g, "'\"'\"'");
      const sudoCmd = `cd '${escapedPath}' && sudo -s`;

      // Try common Linux terminals
      const terminals = [
        { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', sudoCmd + '; exec bash'] },
        { cmd: 'konsole', args: ['-e', 'bash', '-c', sudoCmd + '; exec bash'] },
        { cmd: 'xfce4-terminal', args: ['-e', `bash -c "${sudoCmd}; exec bash"`] },
        { cmd: 'xterm', args: ['-e', `bash -c "${sudoCmd}; exec bash"`] },
        { cmd: 'tilix', args: ['-e', `bash -c "${sudoCmd}; exec bash"`] },
        { cmd: 'alacritty', args: ['-e', 'bash', '-c', sudoCmd + '; exec bash'] },
        { cmd: 'kitty', args: ['bash', '-c', sudoCmd + '; exec bash'] }
      ];

      // Try to open terminal one by one
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
              global.showAutoCloseNotification('info', `qqq: Terminal ${absPath}`);
              return;
            }
          } catch { }
        }
        global.showAutoCloseNotification('error', q('q2.error.noTerminal'));
      })();
    }

    // Show success notification (Windows only - Linux handled above)
    if (platform === 'win32') {
      const termName = termType === 'cmd' ? 'CMD' : 'PowerShell';
      global.showAutoCloseNotification('info', `qqq: ${termName} ${absPath}`);
    } else if (platform === 'darwin') {
      global.showAutoCloseNotification('info', `qqq: Terminal ${absPath}`);
    }
  } catch (e) {
    global.showAutoCloseNotification('error', q('q2.error.openTerminalFailed', e.message));
  }
}

// ==================== s request: get file/folder size ====================
// Used to force-get size when clicking sz area (folder needs recursive calculation)
async function getSizeForSRequest(itemPath, isFolder) {
  const canon = canonicalizeExistingPath(itemPath);

  if (!isFolder) {
    // File: get size directly
    try {
      const stats = await fs.promises.stat(canon);
      return Number(stats.size) || 0;
    } catch {
      return 0;
    }
  }

  // Folder: use extreme-optimized getPathSize (size only, no extension stats)
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


// ==================== Helper Functions ====================
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

// ==================== File Size Formatting ====================
function getFileSizeSync(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

// ==================== Size Formatting ====================
const SZ_GB_THRESHOLD = 1000000000; // 1GB
const SZ_GB_COLOR = 'rgb(248, 48, 0)';

// Pure implementation: add thousand separator (no toLocaleString dependency)
function addThousandSep(num) {
  const s = String(Math.floor(num));
  const parts = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(',');
}

// Return formatted result: { text, gbPart, restPart }
function formatFileSizeEx(bytes) {
  const formatted = addThousandSep(bytes);

  // Check if it exceeds 1GB (>= 1,000,000,000 means 4+ comma-separated parts)
  if (bytes >= SZ_GB_THRESHOLD) {
    const parts = formatted.split(',');
    if (parts.length >= 4) {
      // GB part = first (parts.length - 3) parts
      // Example: "14,111,222,999" -> gbPart = "14"
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
  return addThousandSep(bytes);
}

function formatDateTime(date) {
  // Format date time: YYYY-MM-DD HH:mm (full year)
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";  // Invalid date
  const year = d.getFullYear();  // Full 4-digit year
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${year}.${month}.${day} ${hour}:${minute}`;
}

// ★ 9-second auto-close popup -> extracted to global.showAutoCloseNotification (single source of truth)

// ==================== Command History Management ====================
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

// ==================== Config Read/Write ====================
function getConfig() {
  const defaultConfig = {
    pinnedDirs: [],
    lineSpacing: -2,
    sidebarWidth: 100,
    sidebarRatio: 0.2,
    qqiq: [],
    isPinned: false,
    szDisplayMode: "nothing",
    sortBy: "name",
  };

  if (!globalContext) return defaultConfig;

  // Prefer in-memory cache to ensure we read the latest (even if still in 1s write debounce window)
  if (cachedInMemoryConfig) {
    return cachedInMemoryConfig;
  }

  // ★ Ultimate best solution: tolerant config loading to prevent globalState returning unexpected values
  const storedConfig = globalContext.globalState.get("qqq_config") || {};
  const config = { ...defaultConfig, ...storedConfig };

  // Migrate old data: recentDirs -> pinnedDirs
  if (Array.isArray(storedConfig.recentDirs) && !Array.isArray(storedConfig.pinnedDirs)) {
    config.pinnedDirs = storedConfig.recentDirs.slice(0, 6);
  }
  delete config.recentDirs;

  // Ensure array fields exist
  if (!Array.isArray(config.pinnedDirs)) config.pinnedDirs = [];
  if (!Array.isArray(config.qqiq)) config.qqiq = [];
  // Migrate old qqiq format (string -> object)
  config.qqiq = config.qqiq.map(item => {
    if (typeof item === 'string') return { path: item, type: 'dir' };
    if (item && typeof item.path === 'string') return item;
    return null;
  }).filter(Boolean);
  if (typeof config.lineSpacing !== "number") config.lineSpacing = -2;
  if (typeof config.sidebarWidth !== "number") config.sidebarWidth = 100;
  if (typeof config.sidebarRatio !== "number") config.sidebarRatio = 0.2;
  if (typeof config.isPinned !== "boolean") config.isPinned = false;

  // Read global settings (via ConfigGate)
  try {
    const szDisplayMode = global.getConfig("szDisplayMode") || "nothing";
    const sortBy = global.getConfig("sortBy") || "name";
    const autoWatchChanges = global.getConfig("autoWatchChanges") || false;

    // Validate and set effective values
    const validDisplayModes = ["nothing", "size", "ctime", "mtime"];
    const validSortBy = ["name", "size", "ctime", "mtime"];

    config.szDisplayMode = validDisplayModes.includes(szDisplayMode) ? szDisplayMode : "nothing";
    config.sortBy = validSortBy.includes(sortBy) ? sortBy : "name";
    config.autoWatchChanges = autoWatchChanges === true;
  } catch (e) {
    // If reading fails, use default values
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
  qqiq,
  isPinned
) {
  if (!globalContext) return;

  const newConfig = {
    pinnedDirs,
    lineSpacing,
    sidebarWidth,
    sidebarRatio,
    qqiq,
    isPinned,
  };

  // ★ Key fix: preserve global setting fields (szDisplayMode, sortBy, autoWatchChanges)
  // These fields are managed by VS Code configuration and should not be overwritten
  if (cachedInMemoryConfig) {
    newConfig.szDisplayMode = cachedInMemoryConfig.szDisplayMode;
    newConfig.sortBy = cachedInMemoryConfig.sortBy;
    newConfig.autoWatchChanges = cachedInMemoryConfig.autoWatchChanges;
  }

  // Update memory state immediately to ensure subsequent reads (e.g. refreshWebview) get correct values
  cachedInMemoryConfig = newConfig;

  // Performance optimization: debounce. When switching directories frequently, do not sync-update globalState
  if (saveConfigTimer) clearTimeout(saveConfigTimer);
  saveConfigTimer = setTimeout(() => {
    try {
      // Exclude global setting fields when saving (they are managed by VS Code config)
      const configToSave = {
        pinnedDirs: newConfig.pinnedDirs,
        lineSpacing: newConfig.lineSpacing,
        sidebarWidth: newConfig.sidebarWidth,
        sidebarRatio: newConfig.sidebarRatio,
        qqiq: newConfig.qqiq,
        isPinned: newConfig.isPinned,
      };
      globalContext.globalState.update("qqq_config", configToSave);
      saveConfigTimer = null;
    } catch (e) { }
  }, 1000);
}

// ==================== Last Visited Directory Storage ====================
// Save immediately to ensure even if it crashes we can restore the last visited directory
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

// ==================== Fine-grained SCM Storage ====================
// Stored separately from config to avoid affecting other config items
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

    // If both are null, delete this entry
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

// ==================== History Management (New) ====================
// qqiq: [{path, type:'dir'|'file'}] up to 60 items, newest on top
// pinnedDirs: [string] up to 6 items, newest at bottom (directories only)

function _qqiqKey(p) {
  return cacheKeyForPath(canonicalizeExistingPath(p) || p);
}

/** Remove specified path from qqiq */
function removeFromqqiq(targetPath) {
  const config = getConfig();
  const key = _qqiqKey(targetPath);
  const newIq = (config.qqiq || []).filter(item => _qqiqKey(item.path) !== key);
  if (newIq.length !== (config.qqiq || []).length) {
    saveConfig(config.pinnedDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, newIq, config.isPinned);
  }
}

/** Insert a record at the top of qqiq (dedup, and skip pinned dirs) */
function _insertToqqiqTop(iq, itemPath, itemType, pinnedDirs) {
  const canon = canonicalizeExistingPath(itemPath);
  if (!canon) return iq;
  // If it's a dir and already in pinnedDirs, do not insert
  if (itemType === 'dir' && Array.isArray(pinnedDirs)) {
    const key = cacheKeyForPath(canon);
    if (pinnedDirs.some(d => cacheKeyForPath(d) === key)) return iq;
  }
  const key = cacheKeyForPath(canon);
  const filtered = iq.filter(item => _qqiqKey(item.path) !== key);
  filtered.unshift({ path: canon, type: itemType });
  return filtered.slice(0, 60);
}

/** Record directory history (only add directories to qqiq; skip pinned ones) */
function recordDirHistory(dirPath) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(dirPath);
  if (!canon || !fs.existsSync(canon)) return;
  // Already in pinnedDirs, do not duplicate into qq iq
  const key = cacheKeyForPath(canon);
  if ((config.pinnedDirs || []).some(d => cacheKeyForPath(d) === key)) return;
  const newIq = _insertToqqiqTop(config.qqiq || [], canon, 'dir', config.pinnedDirs);
  saveConfig(config.pinnedDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, newIq, config.isPinned);
}

/** Record file history (add directory+file pair to qqiq, dir on top and file below) */
function recordFileHistory(filePath) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(filePath);
  if (!canon) return;
  const dirCanon = canonicalizeExistingPath(path.dirname(canon));
  if (!dirCanon) return;
  // Remove old records for both
  const dirKey = cacheKeyForPath(dirCanon);
  const fileKey = cacheKeyForPath(canon);
  let iq = (config.qqiq || []).filter(item => {
    const k = _qqiqKey(item.path);
    return k !== dirKey && k !== fileKey;
  });
  // Insert order: dir on top, file below — but pinned dir is not inserted
  const pinnedKeys = new Set((config.pinnedDirs || []).map(d => cacheKeyForPath(d)));
  const toInsert = [];
  if (!pinnedKeys.has(dirKey)) {
    toInsert.push({ path: dirCanon, type: 'dir' });
  }
  toInsert.push({ path: canon, type: 'file' });
  iq.unshift(...toInsert);
  iq = iq.slice(0, 60);
  saveConfig(config.pinnedDirs, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, iq, config.isPinned);
}

/** Pin directory: move from qqiq to bottom of pinnedDirs (max 6; overflow auto-unpins oldest) */
function pinDirectory(dirPath) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(dirPath);
  if (!canon || !fs.existsSync(canon)) return;
  const key = cacheKeyForPath(canon);
  // Dedup from pinnedDirs
  let pinned = (config.pinnedDirs || []).filter(d => cacheKeyForPath(d) !== key);
  // Remove this dir from qqiq
  let iq = (config.qqiq || []).filter(item => _qqiqKey(item.path) !== key);
  // Add to bottom of pinnedDirs
  pinned.push(canon);
  // If exceeds 6, put oldest (first) back to top of qqiq
  while (pinned.length > 6) {
    const removed = pinned.shift();
    const removedCanon = canonicalizeExistingPath(removed);
    if (removedCanon && fs.existsSync(removedCanon)) {
      iq = _insertToqqiqTop(iq, removedCanon, 'dir');
    }
  }
  saveConfig(pinned, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, iq, config.isPinned);
}

/** Unpin: move from pinnedDirs to top of qqiq */
function unpinDirectory(dirPath) {
  const config = getConfig();
  const canon = canonicalizeExistingPath(dirPath);
  if (!canon) return;
  const key = cacheKeyForPath(canon);
  const pinned = (config.pinnedDirs || []).filter(d => cacheKeyForPath(d) !== key);
  let iq = config.qqiq || [];
  if (fs.existsSync(canon)) {
    iq = _insertToqqiqTop(iq, canon, 'dir');
  }
  saveConfig(pinned, config.lineSpacing, config.sidebarWidth, config.sidebarRatio, iq, config.isPinned);
}

let cachedDrives = null;
let lastDrivesQueryTime = 0;

function getDrives() {
  const now = Date.now();
  // Cache for 5 minutes; drive letters won't change frequently
  if (cachedDrives && (now - lastDrivesQueryTime < 300000)) {
    return cachedDrives;
  }

  const drives = [];
  if (process.platform === "win32") {
    // Performance optimization: use fs.existsSync to brute-force A-Z.
    // This is 100x faster than spawning powershell and does not block the Extension Host main thread.
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

  // Determine whether we need to prefetch stats info
  const needStats = sortBy !== "name" || szDisplayMode !== "nothing";

  try {
    // Async performance optimization: use VS Code native async API, do not block Extension Host, and perfectly support cross-platform/remote paths
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

      // Prefetch stats for sorting and sz-area display
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

    // Sort according to sortBy param
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

    if (sortBy === "name") {
      // name: folders on top, sort by name
      contents.dirs.sort((a, b) => collator.compare(a.name, b.name));
      contents.files.sort((a, b) => collator.compare(a.name, b.name));
    } else if (sortBy === "size") {
      // size: folders on top (sorted by name), files below (sorted by size desc, larger first)
      contents.dirs.sort((a, b) => collator.compare(a.name, b.name));
      contents.files.sort((a, b) => (b.size || 0) - (a.size || 0));
    } else if (sortBy === "ctime") {
      // ctime: folders on top (time desc, newer first), files below (time desc)
      contents.dirs.sort((a, b) => new Date(b.ctime || 0) - new Date(a.ctime || 0));
      contents.files.sort((a, b) => new Date(b.ctime || 0) - new Date(a.ctime || 0));
    } else if (sortBy === "mtime") {
      // mtime: folders on top (time desc, newer first), files below (time desc)
      contents.dirs.sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
      contents.files.sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
    }
  } catch (error) {
    global.logMessage(q('q2.log.readDirError', canonDir, error.message), "ERROR");
  }

  return contents;
}

// ==================== Webview Script Generation ====================
function generateWebviewScript(currentPath, sidebarRatio) {
  const escapedCurrentPath = escapeJsStringLiteral(currentPath);
  const escapedSidebarRatio = Number(sidebarRatio || 0.2).toFixed(4);

  return `
const vscode = acquireVsCodeApi();

// i18n strings injected from extension
const I18N_ENTER_FILE_NAME = '${escapeJsStringLiteral(q('q2.ui.enterFileName'))}';
const I18N_ENTER_FOLDER_NAME = '${escapeJsStringLiteral(q('q2.ui.enterFolderName'))}';
const I18N_DESKTOP = '${escapeJsStringLiteral(q('q2.ui.desktop'))}';
const I18N_RECYCLE_BIN = '${escapeJsStringLiteral(q('q2.ui.recycleBin'))}';

let currentPath = '${escapedCurrentPath}';
let sidebarRatio = ${escapedSidebarRatio};

let sessionSizeCache = new Map(); // path -> { text, gbPart, restPart }
let currentSizeMode = 'nothing'; // Current sz-area display mode

let resizeObserver = null;
const MIN_RESPONSIVE_WIDTH = 240;
const MIN_TAG_WIDTH = 170;
const PIN_HIDE_WIDTH = 360;
let baseRecentHeight = 0;

let pathTooltipEl = null;
let pathTooltipVisible = false;

// ====== QQ iq lazy load ======
let qqiqLoading = false;
const QQ_BATCH_SIZE = 20;

// ====== Character-level undo/redo system ======
// Provide character-level Ctrl+Z / Ctrl+Y for all input boxes
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

  // Listen to typing changes and record every change
  input.addEventListener('input', () => {
    const st = getInputUndoState(input);

    // If it's programmatic undo/redo, do not record history
    if (st.isProgrammatic) {
      st.isProgrammatic = false;
      return;
    }

    const currentValue = input.value;

    // If currently not at end of history, truncate later history
    if (st.index < st.history.length - 1) {
      st.history = st.history.slice(0, st.index + 1);
    }

    // Only record when value actually changes
    if (currentValue !== st.lastValue) {
      st.history.push(currentValue);
      st.index = st.history.length - 1;
      st.lastValue = currentValue;
    }
  });

  // Intercept Ctrl+Z and Ctrl+Y
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
        // Trigger input event so other listeners can respond
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
        // Trigger input event
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

// ====== Drive free space update mechanism ======
// Rules:
// - Poll only when webview is visible (6s interval)
// - Batch request: one request returns full answers for all drives
// - Compare final answers: update UI only when different from last answer
// - When free space < 1% or < 2GB show red warning (and show decimals)
const DISK_FREE_INTERVAL_MS = 30000; // 30 seconds
const DISK_FREE_WARNING_PERCENT = 0.01; // 1%
const DISK_FREE_WARNING_BYTES = 2147483648; // 2GB
const DISK_FREE_WARNING_COLOR = 'rgb(248, 48, 0)';
let diskFreeTimer = null;
let lastDiskFreeSnapshot = ''; // Last answer JSON string, used for compare
let diskFreeInFlight = false;

// ====== Fine-grained SCM system ======
// Fine-grained SCM settings for current folder (sent from backend)
let currentFineSCM = { szMode: null, sortBy: null };

// ====== Command history dropdown ======
function hideAllDropdowns() {
    const dropdowns = document.querySelectorAll('.history-dropdown');
    dropdowns.forEach(d => d.style.display = 'none');
}

function showHistoryDropdown(inputEl, dropdownEl, history) {
    hideAllDropdowns();
    // ★ Harden: show dropdown only when input holds focus
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
  // Update left szMode buttons
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

  // Update right sortBy buttons
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
  // If already selected, click again = cancel
  const newMode = (currentFineSCM.szMode === mode) ? null : mode;
  currentFineSCM.szMode = newMode;
  updateFineSCMButtons();
  // Send to backend to save and refresh
  vscode.postMessage({
    command: 'setFineSCM',
    path: currentPath,
    szMode: newMode,
    sortBy: currentFineSCM.sortBy
  });
}

function handleSortByClick(sort) {
  // If already selected, click again = cancel
  const newSort = (currentFineSCM.sortBy === sort) ? null : sort;
  currentFineSCM.sortBy = newSort;
  updateFineSCMButtons();
  // Send to backend to save and refresh
  vscode.postMessage({
    command: 'setFineSCM',
    path: currentPath,
    szMode: currentFineSCM.szMode,
    sortBy: newSort
  });
}

function handleOpenFolderClick() {
  // Open current folder in default file explorer
  vscode.postMessage({
    command: 'openWithDefault',
    path: currentPath,
    type: 'folder'
  });
  vscode.postMessage({ command: 'playEnterSfx' }); // ★ Open folder SFX
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
  const maxAllowedWidth = vw - 20;

  // ★ 测量真实内容宽度：必须用 max-width:none 移除所有限制
  pathTooltipEl.style.whiteSpace = 'nowrap';
  pathTooltipEl.style.maxWidth = 'none'; // ★ 关键：用 none 而不是 '''
  pathTooltipEl.style.width = 'auto';
  pathTooltipEl.style.left = '0px';
  pathTooltipEl.style.top = '0px';
  pathTooltipEl.style.display = 'block';
  pathTooltipVisible = true;

  const naturalWidth = pathTooltipEl.scrollWidth; // ★ 用 scrollWidth 而不是 offsetWidth

  // ★ 如果内容宽度超过允许宽度，强制换行显示
  if (naturalWidth > maxAllowedWidth) {
    pathTooltipEl.style.whiteSpace = 'pre-wrap';
    pathTooltipEl.style.wordBreak = 'break-all';
    pathTooltipEl.style.maxWidth = maxAllowedWidth + 'px';
    // 居中显示
    let left = Math.max(4, Math.min(clientX - maxAllowedWidth / 2, vw - maxAllowedWidth - 4));
    let top = clientY + margin;
    pathTooltipEl.style.left = left + 'px';
    pathTooltipEl.style.top = top + 'px';
    const rect = pathTooltipEl.getBoundingClientRect();
    if (rect.bottom > vh - 4) {
      pathTooltipEl.style.top = Math.max(4, vh - rect.height - 4) + 'px';
    }
    return;
  }

  // 单行可以放下，判断左对齐还是右对齐
  const leftAlignOk = (clientX + margin + naturalWidth) <= vw - 4;
  const rightAlignOk = (clientX - margin - naturalWidth) >= 4;

  // 单行显示
  pathTooltipEl.style.whiteSpace = 'nowrap';
  pathTooltipEl.style.maxWidth = 'none';
  pathTooltipEl.style.wordBreak = '';

  let left;
  if (leftAlignOk) {
    left = clientX + margin;
  } else if (rightAlignOk) {
    left = clientX - margin - naturalWidth;
  } else {
    // 两边都放不下，居中显示
    left = Math.max(4, (vw - naturalWidth) / 2);
  }

  let top = clientY + margin;
  pathTooltipEl.style.left = left + 'px';
  pathTooltipEl.style.top = top + 'px';

  // 垂直越界保护
  const rect = pathTooltipEl.getBoundingClientRect();
  if (rect.bottom > vh - 4) {
    pathTooltipEl.style.top = Math.max(4, vh - rect.height - 4) + 'px';
  }
}

function isEllipsisActive(el){
  if (!el) return false;
  // Method 1: standard scrollWidth check (works for most block/flex-child)
  if (el.scrollWidth > el.clientWidth + 1) return true;
  // Method 2: Range measurement fallback (for elements like button where scrollWidth is unreliable)
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

// Key fix: do not use querySelector attribute concatenation for paths (special chars will break)
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

// ====== Unified pathTooltip hover handler (covers all 4 areas) ======
// Area 1: drive area .nav-item  Area 2: qq iq area .qq-item
// Area 3: history area .recent-item  Area 4: resource list area .file-item
function handlePathTooltipHover(e){
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;

  // ---- Area 1: drive area (.nav-item button) ----
  const navItem = t.closest('.nav-item');
  if (navItem) {
    if (isEllipsisActive(navItem)) {
      showPathTooltip(navItem.textContent.trim(), e.clientX, e.clientY);
    } else if (pathTooltipVisible) { hidePathTooltip(); }
    return;
  }

  // ---- Area 2: qq iq area (.qq-item) ----
  const qqItem = t.closest('.qq-item');
  if (qqItem) {
    // File row: skip here, globalTooltip handles via data-tooltip
    if (qqItem.classList.contains('qq-file')) {
      if (pathTooltipVisible) { hidePathTooltip(); }
      return;
    }
    // Dir row: show only when truncated
    const textEl = qqItem.querySelector('.qq-text');
    const checkEl = textEl || qqItem;
    if (isEllipsisActive(checkEl)) {
      const tip = qqItem.getAttribute('data-fullpath') || (textEl ? textEl.textContent : qqItem.textContent || '').trim();
      showPathTooltip(tip, e.clientX, e.clientY);
    } else if (pathTooltipVisible) { hidePathTooltip(); }
    return;
  }

  // ---- Area 3: history area (.recent-item) ----
  const recentItem = t.closest('.recent-item');
  if (recentItem) {
    const span = recentItem.querySelector('span:not(.delete-button)');
    const checkEl = span || recentItem;
    if (isEllipsisActive(checkEl)) {
      showPathTooltip(span ? span.textContent.trim() : recentItem.textContent.trim(), e.clientX, e.clientY);
    } else if (pathTooltipVisible) { hidePathTooltip(); }
    return;
  }

  // ---- Area 4: resource list area (.file-item) ----
  const fileItem = t.closest('.file-item');
  if (fileItem) {
    const nameArea = fileItem.querySelector('.folder-name-area, .file-name-area');
    if (nameArea && isEllipsisActive(nameArea)) {
      showPathTooltip(fileItem.getAttribute('data-path') || fileItem.getAttribute('data-name') || '', e.clientX, e.clientY);
    } else if (pathTooltipVisible) { hidePathTooltip(); }
    return;
  }

  // Not on any target element
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

  // footer: calculate by page width
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

  // Address bar row: calculate by right panel width
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
function onQqFileClick(p){ vscode.postMessage({ command: 'qqFileClick', path: p }); }
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
  if (!filename) { alert(I18N_ENTER_FILE_NAME); return; }

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
  if (!folderName) { alert(I18N_ENTER_FOLDER_NAME); return; }
  vscode.postMessage({ command: 'createFolder', folderName });
}



// ===== Selection/Rename =====
let selectedItem = null;
let selectedItems = []; // Store multi-select items
let lastSelectedItem = null; // Track the last selected item, used for Shift range selection
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

  // Key: when selecting an item, if focus is on an input box, force blur so hotkeys work
  if (isInputFocused()) {
    document.activeElement.blur();
  }

  const type = fileItem.dataset.type;
  const p = fileItem.dataset.path;
  const name = fileItem.dataset.name;

  if (!shiftPressed) {
    // Non-Shift click: clear previous selection
    const prevSelectedItems = document.querySelectorAll('.file-item.selected');
    prevSelectedItems.forEach(item => {
      if (item.querySelector('.rename-input')) cancelRename(item);
      item.classList.remove('selected');
    });
    selectedItems = [];
    fileItem.classList.add('selected');
    selectedItem = { type, path: p, name };
    selectedItems.push(selectedItem);
    lastSelectedItem = fileItem; // Update last selected item
  } else {
    // Shift click: range-select from lastSelectedItem to current item
    if (lastSelectedItem) {
      // Get all file items
      const allFileItems = Array.from(document.querySelectorAll('.file-item'));

      // Find start and end indexes
      const startIndex = allFileItems.indexOf(lastSelectedItem);
      const endIndex = allFileItems.indexOf(fileItem);

      if (startIndex !== -1 && endIndex !== -1) {
        // Clear previous selection
        const prevSelectedItems = document.querySelectorAll('.file-item.selected');
        prevSelectedItems.forEach(item => {
          if (item.querySelector('.rename-input')) cancelRename(item);
          item.classList.remove('selected');
        });
        selectedItems = [];

        // Determine selection range
        const start = Math.min(startIndex, endIndex);
        const end = Math.max(startIndex, endIndex);

        // Select all items in range
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

        // Update last selected item
        selectedItem = { type, path: p, name };
      }
    } else {
      // If no last selected item, just select current item
      fileItem.classList.add('selected');
      selectedItem = { type, path: p, name };
      selectedItems = [selectedItem];
      lastSelectedItem = fileItem;
    }
  }

  currentFocusType = 'fileList';

  // When selecting a file, always request size display exceptionally (force: true)
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

  // ★ Initialize character-level undo/redo
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
      vscode.postMessage({ command: 'playEnterSfx' }); // ★ Enter key SFX
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      cancelRename(itemElement, originalContent);
    }
  };

  // ★ Click handling: clicking inside input moves caret; clicking outside input equals save
  renameMouseHandler = (e) => {
    if (e.button !== 0) return; // Only handle left click
    if (input.contains(e.target) || e.target === input) {
      // Click inside input: do nothing, let caret move naturally
      return;
    }
    // Click outside input: same as pressing Enter to save
    e.preventDefault();
    e.stopPropagation();
    commitRename(itemElement, itemPath, itemType, input.value.trim());
  };

  // ★ Block right-click menu during edit
  renameContextMenuHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // ★ Block wheel events during edit
  renameWheelHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // ★ Block middle-click during edit
  renameMiddleClickHandler = (e) => {
    if (e.button === 1) { // Middle button
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Register event listeners (use capture to ensure intercept first)
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

// ===== Actions =====
function performEditAction(item){
  if (item) {
    if (item.name === '..') return; // Strictly forbid renaming parent directory
    startRename(item.path, item.name, item.type);
  }
}
function performOpenAction(item){ if (item) vscode.postMessage({ command: 'openWithDefault', path: item.path, type: item.type }); }
function performDeleteAction(item){
  if (!item) return;
  if (item.name === '..') return; // Strictly forbid deleting parent directory
  const el = findItemElementByPath(item.path);
  if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
  vscode.postMessage({ command: 'quickDeleteToqqiq', path: item.path, type: item.type });
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
  // Allow copying parent dir in single-select; this is considered the user's explicit intent
  vscode.postMessage({ command: 'copy', paths: [item.path] });
}
function performPasteAction(){
  vscode.postMessage({ command: 'paste', destDir: currentPath });
}

// ===== Context Menu =====
function handleContextMenuAction(action){
  const menu = document.getElementById('itemContextMenu');
  if (!menu) return;
  hideAllContextMenus();

  if (selectedItems.length > 1) {
    // Multi-select case
    if (action === 'delete') {
      // Filter out parent directory, strictly forbid delete
      const targets = selectedItems.filter(item => item.name !== '..');
      if (targets.length === 0) return;

      targets.forEach(item => {
        const el = findItemElementByPath(item.path);
        if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
      });
      vscode.postMessage({ command: 'quickDeleteMultipleToqqiq', items: targets });
      selectedItem = null;
      selectedItems = [];
    } else if (action === 'rename') {
      // Renaming is forbidden in multi-select
      vscode.postMessage({ command: 'showAutoCloseMessage', type: 'warning', message: '${escapeJsStringLiteral(q('q2.ui.selectSingleForRename'))}' });
    } else if (action === 'open') {
      // Multi-select: open only the first selected item
      const firstItem = selectedItems.find(item => item.name !== '..');
      if (firstItem) {
        performOpenAction(firstItem);
      }
    }
  } else {
    // Single-select case
    const item = { path: menu.dataset.path, name: menu.dataset.name, type: menu.dataset.type };
    if (!item.path) return;
    if (item.name === '..') {
        // For parent directory, only allow q (code) and w (open); block delete/rename
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
  // Deprecated: backend has prefilled sz-area; webview does not need to request actively
}

function requestFileSizeUpdates(items){
  // Deprecated: backend has prefilled sz-area; webview does not need to request actively
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

    // ★ After address-bar navigation succeeds: save history and blur
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

      // Clear cache when mode changes or directory changes
      if (isNewDir || isModeChanged) {
        sessionSizeCache.clear();
      }

      // ★ Clear filter box when switching directory
      if (isNewDir) {
        const fileFilterInput = document.getElementById('fileFilterInput');
        if (fileFilterInput) {
          fileFilterInput.value = '';
          // Reset file list display (do not trigger input event to avoid dropdown)
          const fileItems = document.querySelectorAll('.file-item');
          fileItems.forEach(item => {
            item.style.display = '';
          });
        }
        hideAllDropdowns();
      }

      // Update current mode
      currentSizeMode = newSizeMode;
      currentPath = message.currentPath || '';

      // ★ Update fine-grained SCM state
      currentFineSCM = {
        szMode: message.fineSCM?.szMode || null,
        sortBy: message.fineSCM?.sortBy || null
      };
      updateFineSCMButtons();

      const addr = document.getElementById('addressInput');
      const addrBar = document.getElementById('addressBarInner');
      const addrDisplay = document.getElementById('addressDisplay');
      if (addr) {
        addr.value = message.currentPath || '';
        updateAddressDisplay(addr.value);
        // Update tooltip on entire address bar to currentPath
        if (addrBar) addrBar.setAttribute('data-tooltip', message.currentPath || '');
        // Update editing state (should be normal after navigation)
        if (addrDisplay) addrDisplay.classList.remove('editing');
      }

      const list = document.getElementById('fileList');
      if (list) {
        // ★ Same-directory refresh (SCM switch etc.): save current selection state
        const lastSelPath = lastSelectedItem ? lastSelectedItem.dataset?.path : null;

        // Re-render list (backend has prefilled sz-area content)
        list.innerHTML = message.fileListHtml || '';

        // Restore sz-area display from cache (prefer cache value, may be s request result)
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

        // ★ Restore selection state: keep single/multi red highlight on same-directory refresh
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

        // ★ Clear selection state when switching directories
        if (isNewDir) {
          selectedItems = [];
          selectedItem = null;
          lastSelectedItem = null;
        }
      }

      // Note: backend has prefilled sz-area; no need to request actively
      // requestFileSizeUpdates is only used for s requests

      setTimeout(() => { calculateAndAdjustScroll(); checkAndApplyResponsive(); }, 100);
    } else if (message.command === 'updateSizeBatch') {
      (message.results || []).forEach(res => {
        // Cache only when we actually got size string (avoid caching empty or error tips)
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
            // If GB part exists, use innerHTML to show red
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
      // Dynamically update sidebar area
      const qqSec = document.querySelector('.sidebar .qq-iq-section');
      const divider = document.querySelector('.sidebar .divider');
      if (message.qqiqHtml) {
        // Has content: replace or insert
        const temp = document.createElement('div');
        temp.innerHTML = message.qqiqHtml;
        const newDivider = temp.querySelector('.divider');
        const newSection = temp.querySelector('.qq-iq-section');
        if (qqSec && divider) {
          divider.replaceWith(newDivider || document.createElement('div'));
          qqSec.replaceWith(newSection || document.createElement('div'));
        } else if (newDivider && newSection) {
          const sidebar = document.querySelector('.sidebar');
          if (sidebar) { sidebar.appendChild(newDivider); sidebar.appendChild(newSection); }
        }
      } else {
        // No content: remove
        if (qqSec) qqSec.remove();
        if (divider) divider.remove();
      }
      // Update pinned history area
      const recentList = document.querySelector('.recent-list');
      if (recentList) recentList.innerHTML = message.pinnedDirsHtml || '';
  } else if (message.command === 'updateSidebarRatio') {
    sidebarRatio = message.ratio;
    adjustSidebarByRatio();
  } else if (message.command === 'focusInput') {
    const f = document.getElementById('filenameInput');
    if (f) { f.focus(); f.select(); }
  } else if (message.command === 'diskFreeResult') {
    // Batch answer returned: { data: { 'C': {free, total}, 'D': {free, total}, 'DESKTOP': {used}, 'RECYCLE': {used}, ... } }
    diskFreeInFlight = false;
    const data = message.data;
    if (data && typeof data === 'object') {
      // Answer compare: compare after JSON serialization
      const snapshot = JSON.stringify(data);
      if (snapshot !== lastDiskFreeSnapshot) {
        lastDiskFreeSnapshot = snapshot;
        // Batch update all drive displays (including special entries)
        for (const drive in data) {
          updateDriveDisplay(drive, data[drive]);
        }
      }
    }
    // After completion, schedule next round
    scheduleDiskFreeUpdate();
  } else if (message.command === 'appendqqiq') {
    // QQ iq lazy load: append new items
    const section = document.querySelector('.qq-iq-section');
    if (section && message.itemsHtml) {
      section.insertAdjacentHTML('beforeend', message.itemsHtml);
      section.dataset.loaded = message.loaded;
      section.dataset.total = message.total;
      qqiqLoading = false;
    }
  }
});

// ====== QQ iq scroll lazy load ======
function initqqiqLazyLoad() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  sidebar.addEventListener('scroll', () => {
    if (qqiqLoading) return;

    const section = document.querySelector('.qq-iq-section');
    if (!section) return;

    const total = parseInt(section.dataset.total || '0', 10);
    const loaded = parseInt(section.dataset.loaded || '0', 10);

    // Fully loaded
    if (loaded >= total) return;

    // Check if scrolled near bottom (within 100px)
    if (sidebar.scrollTop + sidebar.clientHeight > sidebar.scrollHeight - 100) {
      qqiqLoading = true;
      vscode.postMessage({
        command: 'requestqqiq',
        offset: loaded,
        limit: QQ_BATCH_SIZE
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

  // Ctrl+C / Ctrl+V / Ctrl+A handling
  if (e.ctrlKey || e.metaKey) {
    if (key === 'c') {
      e.preventDefault(); e.stopPropagation();
      if (selectedItems.length > 1) {
        // Multi-select copy: auto-filter out parent directory to avoid accidental inclusion via select-all, etc.
        const paths = selectedItems
          .filter(item => item.name !== '..')
          .map(item => item.path);

        if (paths.length > 0) {
          vscode.postMessage({ command: 'copy', paths: paths });
        }
      } else if (selectedItem) {
        // Single-select copy: allow including parent directory (user's manual selection intent)
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
      // Select all file items (exclude ".." parent directory item)
      const prevSelectedItems = document.querySelectorAll('.file-item.selected');
      prevSelectedItems.forEach(item => {
        if (item.querySelector('.rename-input')) cancelRename(item);
        item.classList.remove('selected');
      });
      selectedItems = [];

      const allFileItems = document.querySelectorAll('.file-item');
      let lastEl = null;
      allFileItems.forEach(item => {
        if (item.dataset.name === '..') return; // Exclude parent directory for Ctrl+A
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
    // Allow other Ctrl combos to pass through
    return;
  }

  // ★ Space key: s request (get size info for selected items or all items)
  if (key === ' ' || e.key === ' ') {
    e.preventDefault(); e.stopPropagation();

    let itemsToRequest = [];

    if (selectedItems.length > 0) {
      // Has selection: trigger sRequest for selected items
      itemsToRequest = selectedItems
        .filter(item => item.name !== '..')
        .map(item => ({ path: item.path, type: item.type }));
    } else {
      // No selection: trigger sRequest for all items in current directory
      const allFileItems = document.querySelectorAll('.file-item');
      allFileItems.forEach(item => {
        if (item.dataset.name === '..') return;
        itemsToRequest.push({ path: item.dataset.path, type: item.dataset.type });
      });
    }

    if (itemsToRequest.length > 0) {
      // Show loading state
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
    vscode.postMessage({ command: 'playEnterSfx' }); // ★ Keypress SFX
  } else if (key === 'w') {
    e.preventDefault(); e.stopPropagation();
    performOpenAction(selectedItem);
    vscode.postMessage({ command: 'playEnterSfx' }); // ★ Keypress SFX
  } else if (key === 'd') {
    e.preventDefault(); e.stopPropagation();
    if (selectedItems.length > 1) {
      // Multi-select delete: filter out parent directory
      const targets = selectedItems.filter(item => item.name !== '..');
      if (targets.length > 0) {
        targets.forEach(item => {
          const el = findItemElementByPath(item.path);
          if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
        });
        vscode.postMessage({ command: 'quickDeleteMultipleToqqiq', items: targets });
        selectedItem = null;
        selectedItems = [];
      }
    } else if (selectedItem && selectedItem.name !== '..') {
      // Single-select delete: exclude parent directory
      performDeleteAction(selectedItem);
    }
  } else if (key === 'e') {
    e.preventDefault(); e.stopPropagation();
    if (selectedItems.length > 1) {
      // Renaming is forbidden in multi-select
      vscode.postMessage({ command: 'showAutoCloseMessage', type: 'warning', message: '${escapeJsStringLiteral(q('q2.ui.selectSingleForRename'))}' });
      return;
    }
    if (selectedItem && selectedItem.name !== '..') {
        performEditAction(selectedItem);
        vscode.postMessage({ command: 'playEnterSfx' }); // ★ Keypress SFX
    }
  } else if (e.key === 'Delete' && e.shiftKey) {
    // Shift+Delete: permanent delete, no confirmation prompt
    e.preventDefault(); e.stopPropagation();
    if (selectedItems.length > 1) {
      // Multi-select permanent delete
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
      // Single-select permanent delete
      const el = findItemElementByPath(selectedItem.path);
      if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
      vscode.postMessage({ command: 'quickPermanentDelete', path: selectedItem.path, type: selectedItem.type });
      selectedItem = null;
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  ensurePathTooltip();
  // ★ QQ iq lazy loading moved to deferred initialization (3s after UI stable)

  // ★ Disable the system default context menu
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  }, false);

  // ★ Global custom tooltip system
  const globalTooltip = document.getElementById('globalTooltip');
  if (globalTooltip) {
    let currentTooltipTarget = null;

    // Add tooltip events for all elements with data-tooltip
    document.addEventListener('mouseenter', (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const target = e.target.closest('[data-tooltip]');
      if (target) {
        currentTooltipTarget = target;
        const text = target.getAttribute('data-tooltip');
        if (text) {
          const pageWidth = window.innerWidth;
          const availableWidth = pageWidth - 20;

          // ★ Always use pre-wrap and limit max-width to prevent text overflow
          globalTooltip.style.whiteSpace = 'pre-wrap';
          globalTooltip.style.maxWidth = availableWidth + 'px';

          // ★ Check if should render as HTML (for styled tooltips like qq iq files)
          if (currentTooltipTarget.getAttribute('data-use-html') === 'true') {
            globalTooltip.innerHTML = text; // text already escaped at generation time
          } else {
            globalTooltip.textContent = text;
          }

          globalTooltip.style.display = 'block';
        }
      }
    }, true);

    document.addEventListener('mousemove', (e) => {
      if (globalTooltip.style.display === 'block' && currentTooltipTarget) {
        const pageWidth = window.innerWidth;
        const leftPadding = 10;
        const rightPadding = 0;
        const availableWidth = pageWidth - leftPadding - rightPadding;

        // ★ Always keep pre-wrap and max-width to prevent text overflow
        globalTooltip.style.whiteSpace = 'pre-wrap';
        globalTooltip.style.maxWidth = availableWidth + 'px';

        // Get tooltip width after wrapping
        const tooltipWidth = globalTooltip.offsetWidth;

        // Determine element position category to decide tooltip alignment
        const isLeftScmButton = currentTooltipTarget.classList.contains('scm-btn') &&
          currentTooltipTarget.closest('#szModeGroup');
        const isOpenButton = currentTooltipTarget.classList.contains('open-btn');
        const isRightSideButton = currentTooltipTarget.classList.contains('save-button') ||
          currentTooltipTarget.classList.contains('cancel-button') ||
          (currentTooltipTarget.classList.contains('scm-btn') &&
            currentTooltipTarget.closest('#sortByGroup'));

        // Vertical position
        if (currentTooltipTarget.classList.contains('save-button') ||
          currentTooltipTarget.classList.contains('cancel-button')) {
          globalTooltip.style.top = (e.clientY - 44) + 'px';
        } else {
          globalTooltip.style.top = (e.clientY + 22) + 'px';
        }

        // Compute position
        let leftPos;
        if (isLeftScmButton || isOpenButton) {
          leftPos = e.clientX - 11;
        } else if (isRightSideButton) {
          leftPos = e.clientX - tooltipWidth + 11;
        } else {
          leftPos = e.clientX - tooltipWidth / 2;
        }

        // Boundary protection
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
    // ★ Initialize per-character undo/redo
    initInputUndoRedo(filenameInput);

    // ★★★ Fix first-click-swallowed when window loses focus: use mousedown + click ★★★
    filenameInput.addEventListener('mousedown', (e) => {
      setTimeout(() => filenameInput.focus(), 0);
    });
    filenameInput.addEventListener('click', (e) => {
      if (document.activeElement !== filenameInput) {
        filenameInput.focus();
      }
    });

    filenameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        saveFile();
        vscode.postMessage({ command: 'playEnterSfx' }); // ★ Enter key SFX
      }
    });
    // ★ Right-click: paste at cursor position (no deletion, no tip)
    filenameInput.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          const start = filenameInput.selectionStart;
          const end = filenameInput.selectionEnd;
          const before = filenameInput.value.substring(0, start);
          const after = filenameInput.value.substring(end);
          filenameInput.value = before + text + after;
          // Move cursor to end of pasted text
          const newPos = start + text.length;
          filenameInput.setSelectionRange(newPos, newPos);
          // Trigger input event to persist
          filenameInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch { }
    });
  }

  // ★ Address bar logic (with history dropdown)
  const addressInput = document.getElementById('addressInput');
  const addressHistoryDropdown = document.getElementById('addressHistoryDropdown');
  const addressBarInner = document.getElementById('addressBarInner');
  const addressDisplay = document.getElementById('addressDisplay');
  if (addressInput && addressHistoryDropdown) {
    initInputUndoRedo(addressInput);

    // Helper: update tooltip on entire address bar
    function updateAddressBarTooltip(path) {
      if (addressBarInner) addressBarInner.setAttribute('data-tooltip', path || '');
    }

    // Helper: update editing state (italic + plain separators when editing or mismatched)
    function updateAddressEditingState() {
      if (!addressDisplay) return;
      const isFocused = document.activeElement === addressInput;
      const isMismatched = addressInput.value !== currentPath;
      if (isFocused || isMismatched) {
        addressDisplay.classList.add('editing');
      } else {
        addressDisplay.classList.remove('editing');
      }
    }

    addressInput.addEventListener('input', (e) => {
      updateAddressDisplay(e.target.value);
      updateAddressEditingState();
      // Dynamically update tooltip to current address (on entire bar)
      updateAddressBarTooltip(currentPath);
      // Hide dropdown on input first, then check if empty
      hideAllDropdowns();
      if (addressInput.value === '') {
        vscode.postMessage({ command: 'getHistory', key: 'address' });
      }
    });
    // Initial tooltip setup (use currentPath, not input value)
    updateAddressBarTooltip(currentPath);
    updateAddressEditingState();

    addressInput.addEventListener('focus', () => {
      updateAddressEditingState();
      if (addressInput.value === '') {
        vscode.postMessage({ command: 'getHistory', key: 'address' });
      }
    });

    // ★★★ Fix first-click-swallowed when window loses focus: use mousedown + click ★★★
    addressInput.addEventListener('mousedown', (e) => {
      setTimeout(() => addressInput.focus(), 0);
    });
    addressInput.addEventListener('click', (e) => {
      if (document.activeElement !== addressInput) {
        addressInput.focus();
      }
    });

    addressInput.addEventListener('blur', (e) => {
      const relatedTarget = e.relatedTarget;
      const isDropdownElement = relatedTarget && addressHistoryDropdown.contains(relatedTarget);
      if (!isDropdownElement) {
        hideAllDropdowns();
      }
      updateAddressEditingState();
    });

    // Right-click: paste from clipboard (clear -> paste -> cursor at end -> show tip)
    const addressPasteTip = document.getElementById('addressPasteTip');
    addressInput.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          addressInput.value = text;
          // ★ Trigger input event to persist the change
          addressInput.dispatchEvent(new Event('input', { bubbles: true }));
          updateAddressDisplay(text);
          addressInput.focus();
          // Move cursor to end
          addressInput.setSelectionRange(text.length, text.length);
          // Show paste tip
          if (addressPasteTip) {
            addressPasteTip.classList.add('show');
            setTimeout(() => addressPasteTip.classList.remove('show'), 1500);
          }
        }
      } catch { }
    });

    // Copy button: restore to currentPath and copy to clipboard
    const addressCopyBtn = document.getElementById('addressCopyBtn');
    if (addressCopyBtn) {
      addressCopyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        addressInput.value = currentPath;
        updateAddressDisplay(currentPath);
        updateAddressBarTooltip(currentPath);
        navigator.clipboard.writeText(currentPath).catch(() => { });
        // ★ Clipboard SFX is handled uniformly by Python clipboard_watcher
      });
    }

    addressHistoryDropdown.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    addressInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const p = addressInput.value.trim();
        if (p) {
          vscode.postMessage({ command: 'navigate', path: p });
          // ★ Do not save history here; wait for backend navigateSuccess message
        }
        hideAllDropdowns();
        vscode.postMessage({ command: 'playEnterSfx' }); // ★ Enter key SFX
      } else if (e.key === 'Escape') {
        hideAllDropdowns();
      } else if (e.key === ' ') {
        // Space key hides dropdown (space is not empty text, so hide)
        hideAllDropdowns();
      }
    });

    // Click dropdown item
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

  // ★ Added: file filter input logic (improved)
  const fileFilterInput = document.getElementById('fileFilterInput');
  const fileFilterDropdown = document.getElementById('fileFilterHistoryDropdown');
  if (fileFilterInput && fileFilterDropdown) {
    initInputUndoRedo(fileFilterInput);

    fileFilterInput.addEventListener('input', () => {
      // Hide dropdown on input first
      hideAllDropdowns();

      // If empty, request history
      if (fileFilterInput.value === '') {
        vscode.postMessage({ command: 'getHistory', key: 'fileFilter' });
      }

      // Apply filter
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

    // ★★★ Fix first-click-swallowed when window loses focus: use mousedown + click ★★★
    fileFilterInput.addEventListener('mousedown', (e) => {
      setTimeout(() => fileFilterInput.focus(), 0);
    });
    fileFilterInput.addEventListener('click', (e) => {
      if (document.activeElement !== fileFilterInput) {
        fileFilterInput.focus();
      }
    });

    // Hide dropdown immediately on blur
    fileFilterInput.addEventListener('blur', (e) => {
      // Check whether relatedTarget is an element inside dropdown
      const relatedTarget = e.relatedTarget;
      const isDropdownElement = relatedTarget && fileFilterDropdown.contains(relatedTarget);
      if (!isDropdownElement) {
        hideAllDropdowns();
      }
    });

    // Prevent default on dropdown click to avoid triggering blur
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
        fileFilterInput.blur(); // ★ Lose focus after Enter to save
        vscode.postMessage({ command: 'playEnterSfx' }); // ★ Enter key SFX
      } else if (e.key === 'Escape') {
        hideAllDropdowns();
      }
    });

    // Click dropdown item
    fileFilterDropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.history-dropdown-item');
      if (item) {
        fileFilterInput.value = item.textContent;
        hideAllDropdowns();
        fileFilterInput.focus();
        // Trigger input event to apply filter
        fileFilterInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }

  // ★ Fine-grained SCM button event listeners
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

    // ★★★ Fix QQ area first-click-swallowed: use mousedown (fires before focus transfer) ★★★
    sidebarEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left click
      const qqItem = e.target.closest('.qq-item');
      if (qqItem) {
        // ★ Handle pin-icon click
        const pinIcon = e.target.closest('.pin-icon');
        if (pinIcon) {
          e.preventDefault();
          e.stopPropagation();
          // ★ CRITICAL: Ignore pin-icon click when window is not focused (avoids complex state issues)
          if (!document.hasFocus()) return;
          const fullpath = qqItem.dataset.fullpath;
          if (fullpath) pinDir(fullpath);
          return;
        }
        e.preventDefault(); // Prevent default to avoid focus issues
        const isFile = qqItem.classList.contains('qq-file');
        const fullpath = qqItem.dataset.fullpath;
        if (fullpath) {
          if (isFile) {
            onQqFileClick(fullpath);
          } else {
            navigateTo(fullpath);
          }
        }
      }
    });
  }

  const kyEl = document.getElementById('kyContent');
  if (kyEl) {
    kyEl.addEventListener('mousemove', handlePathTooltipHover);
    kyEl.addEventListener('mouseleave', hidePathTooltip);

    // ★★★ Fix history area first-click-swallowed: use mousedown ★★★
    const recentSection = kyEl.querySelector('.recent-section');
    if (recentSection) {
      recentSection.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Only left click
        const recentItem = e.target.closest('.recent-item');
        if (recentItem) {
          // ★ Handle delete-button click
          const deleteBtn = e.target.closest('.delete-button');
          if (deleteBtn) {
            e.preventDefault();
            e.stopPropagation();
            // ★ CRITICAL: Ignore delete-button click when window is not focused (avoids complex state issues)
            if (!document.hasFocus()) return;
            const pathSpan = recentItem.querySelector('span:not(.delete-button)');
            if (pathSpan) unpinDir(pathSpan.textContent);
            return;
          }
          e.preventDefault(); // Prevent default to avoid focus issues
          const pathSpan = recentItem.querySelector('span:not(.delete-button)');
          if (pathSpan) {
            navigateTo(pathSpan.textContent);
          }
        }
      });
    }
  }

  document.addEventListener('scroll', hidePathTooltip, true);

  window.addEventListener('resize', () => {
    adjustSidebarByRatio();
    checkAndApplyResponsive();
  });

  const container = document.querySelector('.container');
  // ★ ResizeObserver moved to deferred initialization (3s after UI stable)

  // Click to select/enter
  const fileList = document.getElementById('fileList');
  if (fileList) {
    fileList.addEventListener('click', (event) => {
      // ★ While renaming, clicking inside rename-input does nothing so the cursor moves naturally
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

      // Exclude parent directory
      if (itemName === '..') {
        if (type === 'folder' && !isSzArea) {
          vscode.postMessage({ command: 'navigate', path: itemPath });
        }
        return;
      }

      if (type === 'folder') {
        if (isSzArea) {
          // Clicking folder sz area: select only
          selectFileItem(fileItem, false, event.shiftKey);
          currentFocusType = 'fileList';
          return;
        }
        // Non sz-area: enter folder directly
        vscode.postMessage({ command: 'navigate', path: itemPath });
        currentFocusType = 'fileList';
        return;
      }

      // File click: always select only
      selectFileItem(fileItem, false, event.shiftKey);
      currentFocusType = 'fileList';
    });

    // Right-click: item / empty
    fileList.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      hideAllContextMenus();

      const itemElement = e.target.closest('.file-item');
      const itemMenu = document.getElementById('itemContextMenu');
      const emptyMenu = document.getElementById('emptyContextMenu');

      if (itemElement && itemMenu) {
        // If there are selected items and you right-click one of them, keep selection
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

  // empty menu: admin terminal shortcuts
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
        hideAllContextMenus();
        const act = e.currentTarget.dataset.action;
        if (act === 'createFolder') createFolder();
        else if (act === 'saveFile') saveFile();
        else if (act === 'openAdminCmd') vscode.postMessage({ command: 'openAdminCmd', path: currentPath });
        else if (act === 'openAdminPowershell') vscode.postMessage({ command: 'openAdminPowershell', path: currentPath });
      });
    });
  }

  // Sidebar drag
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

  // Final: run a layout pass after first render
  adjustSidebarByRatio();
  checkAndApplyResponsive();
  updateAddressDisplay(currentPath);

  // Note: actual list refresh is performed by extension-side postMessage(update)
});

// ====== Drive free-space polling mechanism functions ======

/**
 * Update drive display text
 * @param {string} drive - drive letter, e.g. 'C', 'D', or special keys 'DESKTOP', 'RECYCLE'
 * @param {object} info - { free, total } for drives, or { used } for special entries
 */
function updateDriveDisplay(drive, info) {
  // ★ Handle special entries: Desktop and Recycle Bin (show used space)
  if (drive === 'DESKTOP') {
    const el = document.getElementById('special-desktop-text');
    if (!el) return;
    const usedGB = (info.used || 0) / (1024 * 1024 * 1024);
    // ★ Show "0" instead of "0.00" when near zero
    const gbText = usedGB < 0.01 ? '0' : (usedGB >= 1 ? Math.floor(usedGB).toString() : usedGB.toFixed(2));
    el.textContent = I18N_DESKTOP + ' ' + gbText;
    return;
  }
  if (drive === 'RECYCLE') {
    const el = document.getElementById('special-recycle-text');
    if (!el) return;
    const usedGB = (info.used || 0) / (1024 * 1024 * 1024);
    // ★ Show "0" instead of "0.00" when near zero
    const gbText = usedGB < 0.01 ? '0' : (usedGB >= 1 ? Math.floor(usedGB).toString() : usedGB.toFixed(2));
    el.textContent = I18N_RECYCLE_BIN + ' ' + gbText;
    return;
  }

  // ★ Normal drives: show free space
  const el = document.getElementById('drive-' + drive.toLowerCase() + '-text');
  if (!el) return;
  const freeBytes = info.free || 0;
  const totalBytes = info.total || 0;
  const freeGB = freeBytes / (1024 * 1024 * 1024);

  // Check if red warning is needed: space < 1% or < 2GB
  const isLow = (totalBytes > 0 && freeBytes / totalBytes < DISK_FREE_WARNING_PERCENT) ||
    (freeBytes < DISK_FREE_WARNING_BYTES);

  // Show integer normally; show decimals only when red
  const gbText = isLow ? freeGB.toFixed(2) : Math.floor(freeGB).toString();
  el.textContent = drive.toUpperCase() + ':\\  ' + gbText;
  el.style.color = isLow ? DISK_FREE_WARNING_COLOR : '';
}

/**
 * Open Recycle Bin (Windows only)
 */
function openRecycleBin() {
  vscode.postMessage({ command: 'openRecycleBin' });
}

/**
 * Detect whether webview is visible
 */
function isDiskFreePollingAllowed() {
  // Poll only when page is visible
  return document.visibilityState === 'visible';
}

/**
 * Request free space for all drives (batched)
 */
function requestDiskFree() {
  if (diskFreeInFlight) return;
  diskFreeInFlight = true;
  vscode.postMessage({ command: 'getDiskFree' });
}

/**
 * Schedule next C drive free-space update
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
      scheduleDiskFreeUpdate(); // Retry later
    }
  }, DISK_FREE_INTERVAL_MS);
}

/**
 * Stop C drive free-space polling
 */
function stopDiskFreePolling() {
  if (diskFreeTimer) {
    clearTimeout(diskFreeTimer);
    diskFreeTimer = null;
  }
}

// Listen for visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Became visible: request once immediately and start polling
    requestDiskFree();
  } else {
    // Stop polling when hidden
    stopDiskFreePolling();
  }
});

// ★★★ Deferred initialization: wait for UI stable then delay 3 seconds ★★★
// These operations are non-critical for initial render, delay them to speed up startup
function runDeferredInitialization() {
  // 1. QQ iq lazy loading
  initqqiqLazyLoad();

  // 2. ResizeObserver for container
  const container = document.querySelector('.container');
  if (container && 'ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => {
      adjustSidebarByRatio();
      checkAndApplyResponsive();
    });
    resizeObserver.observe(container);
  }

  // 3. Disk free space polling
  if (isDiskFreePollingAllowed()) {
    requestDiskFree();
  }
}

// Wait for UI to be fully rendered and stable, then delay 3 seconds
window.addEventListener('load', () => {
  // Use requestAnimationFrame to ensure paint is complete
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // UI is now stable, start 3 second countdown
      setTimeout(runDeferredInitialization, 3000);
    });
  });
});

// ====== Export for template inline onclick ======
window.navigateTo = navigateTo;
window.navigateIntoFolder = navigateIntoFolder;
window.unpinDir = unpinDir;
window.pinDir = pinDir;
window.onQqFileClick = onQqFileClick;
window.cancel = cancel;
window.saveFile = saveFile;
window.createFolder = createFolder;
window.togglePin = togglePin;
window.openRecycleBin = openRecycleBin;

// ====== Custom scrollbar (exactly matches q4 outer scrollbar)======
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

  // Drag the scrollbar thumb
  let isDragging = false, startY, startST;
  thumb.onmousedown = function (e) {
    isDragging = true;
    startY = e.clientY;
    startST = container.scrollTop;
    document.onmousemove = function (e) {
      if (!isDragging) return;
      const dy = e.clientY - startY;
      const barH = scrollbar.clientHeight;
      const th = thumb.offsetHeight;
      const sh = container.scrollHeight, ch = container.clientHeight;
      container.scrollTop = startST + (dy / (barH - th)) * (sh - ch);
    };
    document.onmouseup = function () {
      isDragging = false;
      document.onmousemove = null;
    };
    e.preventDefault();
    e.stopPropagation();
  };

  // Click track: left click page / Shift+left click or right click jump
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

  scrollbar.addEventListener('mousedown', function (e) {
    if (e.target === thumb) return;
    e.preventDefault();

    if (e.shiftKey || e.button === 2) {
      // Shift+left click or right click: jump to click position
      jumpToClick(e);
    } else if (e.button === 0) {
      // Normal left click: page
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

  // Block right-click context menu in scrollbar area
  scrollbar.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
  });

  // Initial update
  update();
  window.addEventListener('resize', update);
  // ★ MutationObserver: immediate load (low overhead, critical for scrollbar)
  const observer = new MutationObserver(update);
  observer.observe(container, { childList: true, subtree: true });

  // JS hover: only switch hover when cursor actually moves; if cursor doesn't move during scroll, trigger zero times to remove artifacts
  let hoveredItem = null;
  container.addEventListener('mousemove', function (e) {
    const item = e.target.closest('.file-item');
    if (item === hoveredItem) return;
    if (hoveredItem) hoveredItem.classList.remove('js-hover');
    hoveredItem = item;
    if (hoveredItem) hoveredItem.classList.add('js-hover');
  });
  container.addEventListener('mouseleave', function () {
    if (hoveredItem) hoveredItem.classList.remove('js-hover');
    hoveredItem = null;
  });

  // Final backstop: after interaction stops, repaint once when browser is idle to clear all artifacts
  let idleHandle = null;
  function scheduleIdleRepaint() {
    if (idleHandle) return;
    idleHandle = requestIdleCallback(function () {
      idleHandle = null;
      container.style.willChange = 'transform';
      requestAnimationFrame(function () { container.style.willChange = ''; });
    });
  }
  container.addEventListener('scroll', scheduleIdleRepaint);
  container.addEventListener('mousemove', scheduleIdleRepaint);

  // Press 1 to scroll to top, press 2 to scroll to bottom (split jump based on midpoint)
  document.addEventListener('keydown', function (e) {
    if (isInputFocused()) return;
    const maxScroll = container.scrollHeight - container.clientHeight;
    const midPoint = maxScroll / 2;
    const currentPos = container.scrollTop;
    const tolerance = 10; // Tolerance to avoid floating-point precision issues
    if (e.key === '1') {
      e.preventDefault();
      if (currentPos <= midPoint + tolerance) {
        // At midpoint or upper half: go directly to top
        container.scrollTop = 0;
      } else {
        // Lower half: go to midpoint first
        container.scrollTop = midPoint;
      }
      vscode.postMessage({ command: 'playEnterSfx' });
    } else if (e.key === '2') {
      e.preventDefault();
      if (currentPos >= midPoint - tolerance) {
        // At midpoint or lower half: go directly to bottom
        container.scrollTop = maxScroll;
      } else {
        // Upper half: go to midpoint first
        container.scrollTop = midPoint;
      }
      vscode.postMessage({ command: 'playEnterSfx' });
    }
  }, true);
}

setTimeout(setupCustomScrollbar, 100);

// a key -> admin CMD/Terminal, x key -> admin PowerShell (Windows only)
const isWindows = {{IS_WINDOWS}};
document.addEventListener('keydown', function (e) {
  if (isInputFocused()) return;
  const key = (e.key || '').toLowerCase();
  if (key === 'a' && !e.ctrlKey && !e.metaKey) { // ★ 排除 Ctrl+A 全选
    e.preventDefault();
    vscode.postMessage({ command: 'openAdminCmd', path: currentPath });
  } else if (key === 'x' && isWindows) {
    e.preventDefault();
    vscode.postMessage({ command: 'openAdminPowershell', path: currentPath });
  }
}, true);
`;
}

// ==================== sidebar HTML generation (shared) ====================
const QQ_IQ_BATCH_SIZE = 20; // Items per batch

// ★ Desktop & Recycle Bin paths for exclusion (already shown in drive bar)
const _desktopPathForExclusion = process.platform === 'win32'
  ? path.join(process.env.USERPROFILE || os.homedir(), 'Desktop')
  : path.join(os.homedir(), 'Desktop');
const _recycleBinPathForExclusion = process.platform === 'darwin'
  ? path.join(os.homedir(), '.Trash')
  : process.platform !== 'win32'
    ? path.join(os.homedir(), '.local/share/Trash/files')
    : null; // Windows: virtual folder, no real path to exclude

// ★ Build exclusion set (using cacheKeyForPath for case-insensitive comparison)
const _driveBarExclusionKeys = new Set();
_driveBarExclusionKeys.add(cacheKeyForPath(_desktopPathForExclusion));
if (_recycleBinPathForExclusion) {
  _driveBarExclusionKeys.add(cacheKeyForPath(_recycleBinPathForExclusion));
  // Also exclude parent Trash folder on Linux
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    _driveBarExclusionKeys.add(cacheKeyForPath(path.join(os.homedir(), '.local/share/Trash')));
  }
}

function _isExcludedFromSidebar(pathStr) {
  return _driveBarExclusionKeys.has(cacheKeyForPath(pathStr));
}

function generateSidebarHtml(config, qqiqLimit = QQ_IQ_BATCH_SIZE) {
  // ★ Filter out Desktop & Recycle Bin from pinned dirs (already shown in drive bar)
  const safePinnedDirs = (config.pinnedDirs || []).filter((dir) =>
    dir && fs.existsSync(dir) && !_isExcludedFromSidebar(dir)
  );
  const pinnedKeySet = new Set(safePinnedDirs.map(d => cacheKeyForPath(d)));
  // ★ Filter out Desktop & Recycle Bin from qq iq (already shown in drive bar)
  const safeqqiq = (config.qqiq || []).filter(
    (item) => item && item.path && typeof item.path === "string" && fs.existsSync(item.path)
      && !(item.type === 'dir' && pinnedKeySet.has(cacheKeyForPath(item.path)))
      && !_isExcludedFromSidebar(item.path)
  );
  const totalqqiq = safeqqiq.length;
  const displayedqqiq = safeqqiq.slice(0, qqiqLimit);
  const showqqiq = displayedqqiq.length > 0;

  const qqiqHtml = showqqiq
    ? `
  <div class="divider"></div>
    <div class="qq-iq-section" data-total="${totalqqiq}" data-loaded="${displayedqqiq.length}">
      ${displayedqqiq
      .map((item) => {
        const escaped = escapeJsStringLiteral(item.path);
        const fullDisplay = escapeHtmlAttribute(item.path);
        if (item.type === 'file') {
          const fileName = escapeHtmlAttribute(path.basename(item.path));
          // ★ For tooltip: highlight last backslash in bold red
          const lastBackslash = item.path.lastIndexOf('\\');
          let tooltipHtml = fullDisplay;
          if (lastBackslash !== -1) {
            const beforeSlash = escapeHtmlAttribute(item.path.substring(0, lastBackslash));
            const afterSlash = escapeHtmlAttribute(item.path.substring(lastBackslash + 1));
            tooltipHtml = `${beforeSlash} <span style="font-weight:bold;color:#dc322f;">\\</span> ${afterSlash}`;
          }
          // ★ Double-escape for HTML attribute: replace quotes and encode special chars
          const tooltipAttr = tooltipHtml.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
          return `<div class="qq-item qq-file" onclick="onQqFileClick('${escaped}')" data-fullpath="${fullDisplay}" data-tooltip="${tooltipAttr}" data-use-html="true"><span class="qq-text">${fileName}</span></div>`;
        } else {
          return `<div class="qq-item qq-dir" onclick="navigateTo('${escaped}')" data-fullpath="${fullDisplay}"><span class="qq-text">${fullDisplay}</span><span class="pin-icon"><svg viewBox="0 0 20 20" width="14" height="14"><path d="M5 17 L15 5 M15 5 L5 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></span></div>`;
        }
      })
      .join("")}
    </div>`
    : "";

  const pinnedDirsHtml = safePinnedDirs
    .map(
      (dir) => `
      <div class="recent-item" onclick="navigateTo('${escapeJsStringLiteral(dir)}')">
  <span class="delete-button">\u00d7</span>
  <span>${escapeHtmlAttribute(dir)}</span>
</div>`
    )
    .join("");

  return { qqiqHtml, pinnedDirsHtml };
}

// Generate HTML for a single qq iq item
function generateqqiqItemHtml(item) {
  const escaped = escapeJsStringLiteral(item.path);
  const fullDisplay = escapeHtmlAttribute(item.path);
  if (item.type === 'file') {
    const fileName = escapeHtmlAttribute(path.basename(item.path));
    // ★ For tooltip: highlight last backslash in bold red
    const lastBackslash = item.path.lastIndexOf('\\');
    let tooltipHtml = fullDisplay;
    if (lastBackslash !== -1) {
      const beforeSlash = escapeHtmlAttribute(item.path.substring(0, lastBackslash));
      const afterSlash = escapeHtmlAttribute(item.path.substring(lastBackslash + 1));
      tooltipHtml = `${beforeSlash} <span style="font-weight:bold;color:#dc322f;">\\</span> ${afterSlash}`;
    }
    // ★ Double-escape for HTML attribute: replace quotes and encode special chars
    const tooltipAttr = tooltipHtml.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return `<div class="qq-item qq-file" onclick="onQqFileClick('${escaped}')" data-fullpath="${fullDisplay}" data-tooltip="${tooltipAttr}" data-use-html="true"><span class="qq-text">${fileName}</span></div>`;
  } else {
    return `<div class="qq-item qq-dir" onclick="navigateTo('${escaped}')" data-fullpath="${fullDisplay}"><span class="qq-text">${fullDisplay}</span><span class="pin-icon"><svg viewBox="0 0 20 20" width="14" height="14"><path d="M5 17 L15 5 M15 5 L5 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></span></div>`;
  }
}

// Get qq iq items within a specified range
function getqqiqItems(offset, limit) {
  const config = getConfig();
  // ★ Filter out Desktop & Recycle Bin from pinned dirs (already shown in drive bar)
  const safePinnedDirs = (config.pinnedDirs || []).filter((dir) =>
    dir && fs.existsSync(dir) && !_isExcludedFromSidebar(dir)
  );
  const pinnedKeySet = new Set(safePinnedDirs.map(d => cacheKeyForPath(d)));
  // ★ Filter out Desktop & Recycle Bin from qq iq (already shown in drive bar)
  const safeqqiq = (config.qqiq || []).filter(
    (item) => item && item.path && typeof item.path === "string" && fs.existsSync(item.path)
      && !(item.type === 'dir' && pinnedKeySet.has(cacheKeyForPath(item.path)))
      && !_isExcludedFromSidebar(item.path)
  );
  const total = safeqqiq.length;
  const items = safeqqiq.slice(offset, offset + limit);
  const itemsHtml = items.map(generateqqiqItemHtml).join('');
  return { itemsHtml, total, loaded: offset + items.length };
}

function getWebviewContent(currentPath) {
  const config = getConfig();
  const drives = getDrives();

  const { qqiqHtml, pinnedDirsHtml } = generateSidebarHtml(config);

  let htmlTemplate = "";
  try {
    htmlTemplate = require("./q2.html");
  } catch (error) {
    geq().logMessage(q('q2.log.templateReadError', error.message), "ERROR");
    return `<h1>${q('q2.error.templateLoadFailed')}</h1><p>${escapeHtmlAttribute(error.message)}</p>`;
  }

  const drivesHtml = drives
    .map((drive) => {
      const driveUpper = drive.toUpperCase();
      const driveLetter = driveUpper.replace(/[^A-Z]/g, '') || 'X';
      return '<button class="nav-item" id="drive-' + driveLetter.toLowerCase() + '-btn" onclick="navigateTo(\'' + escapeJsStringLiteral(drive) + '\')"><span id="drive-' + driveLetter.toLowerCase() + '-text">' + escapeHtmlAttribute(drive) + '</span></button>';
    })
    .join("");

  // ★ Special entries: Desktop and Recycle Bin (after drives)
  const desktopPath = process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || os.homedir(), 'Desktop')
    : path.join(os.homedir(), 'Desktop');
  const desktopExists = fs.existsSync(desktopPath);

  // ★ Recycle Bin path: Windows uses virtual folder (must open externally), macOS/Linux have real paths
  const recycleBinPath = process.platform === 'darwin'
    ? path.join(os.homedir(), '.Trash')
    : process.platform !== 'win32'
      ? path.join(os.homedir(), '.local/share/Trash/files')
      : null; // Windows: no direct path
  const recycleBinExists = recycleBinPath && fs.existsSync(recycleBinPath);

  const specialEntriesHtml = (desktopExists
    ? '<button class="nav-item nav-special" id="special-desktop-btn" onclick="navigateTo(\'' + escapeJsStringLiteral(desktopPath) + '\')"><span id="special-desktop-text">' + escapeHtmlAttribute(q('q2.ui.desktop')) + '</span></button>'
    : '')
    + (recycleBinExists
      ? '<button class="nav-item nav-special" id="special-recycle-btn" onclick="navigateTo(\'' + escapeJsStringLiteral(recycleBinPath) + '\')"><span id="special-recycle-text">' + escapeHtmlAttribute(q('q2.ui.recycleBin')) + '</span></button>'
      : '<button class="nav-item nav-special" id="special-recycle-btn" onclick="openRecycleBin()"><span id="special-recycle-text">' + escapeHtmlAttribute(q('q2.ui.recycleBin')) + '</span></button>');

  const inlineScript = generateWebviewScript(currentPath, config.sidebarRatio);

  let finalHtml = htmlTemplate
    .replace(/\{\{SIDEBAR_WIDTH\}\}/g, config.sidebarWidth)
    .replace(/\{\{LINE_SPACING\}\}/g, config.lineSpacing)
    .replace("{{DRIVES_HTML}}", drivesHtml + specialEntriesHtml)
    .replace("{{QQ_IQ_HTML}}", qqiqHtml)
    .replace("{{RECENT_DIRS_HTML}}", pinnedDirsHtml)
    .replace("{{CURRENT_PATH}}", escapeHtmlAttribute(currentPath))
    .replace("{{PIN_CLASS}}", config.isPinned ? "pinned" : "")
    .replace("{{PIN_CHECKBOX}}", config.isPinned ? "✓" : "□")
    .replace("{{INLINE_SCRIPT}}", inlineScript.replace(/<\/script>/gi, "<\\/script>"))
    // ★ i18n placeholder replacement
    .replace("{{I18N_PIN}}", q('q2.ui.pin'))
    .replace("{{I18N_NEW_FILE}}", q('q2.ui.newFile'))
    .replace("{{I18N_NEW_FOLDER}}", q('q2.ui.newFolder'))
    .replace("{{I18N_OPEN_FOLDER}}", q('q2.ui.openFolder'))
    .replace("{{I18N_PASTED}}", q('q2.ui.pasted'))
    .replace("{{I18N_SZ_SIZE}}", q('q2.ui.szSize'))
    .replace("{{I18N_SZ_CTIME}}", q('q2.ui.szCtime'))
    .replace("{{I18N_SZ_MTIME}}", q('q2.ui.szMtime'))
    .replace("{{I18N_SORT_SIZE}}", q('q2.ui.sortSize'))
    .replace("{{I18N_SORT_CTIME}}", q('q2.ui.sortCtime'))
    .replace("{{I18N_SORT_MTIME}}", q('q2.ui.sortMtime'))
    // Admin terminal context menu - platform specific (hardcoded, no i18n)
    .replace("{{ADMIN_TERM_1}}", process.platform === 'win32' ? 'CMD' : 'Terminal')
    .replace("{{ADMIN_TERM_2_HTML}}", process.platform === 'win32'
      ? `<div class="context-menu-item" data-action="openAdminPowershell"><span>PowerShell</span><span class="context-menu-shortcut">= "x"</span></div>`
      : '')
    .replace("{{IS_WINDOWS}}", process.platform === 'win32' ? 'true' : 'false');

  return finalHtml;
}


// ==================== Q2 paste feature (fully ported from Q1) ====================
// ★★★ Based on transactions, multi-tasks, fingerprint dedupe, auto-rename on same name, perfect cancel rollback, complete UI ★★★

/**
 * Execute paste operation for Q2 explorer
 * @param {string} targetDir - target directory
 * @param {Function} refreshCallback - callback to refresh Webview
 */
async function performQ2Paste(targetDir, refreshCallback) {
  // ★ Generate task title using target directory (equivalent to q1 approach)
  const taskNum = await TaskCounter.increment(targetDir);
  const iconNum = await TaskCounter.incrementIcon();
  const transId = TransactionManager.createTransactionId();
  const taskTitle = TaskCounter.formatTitle(targetDir, transId, iconNum);

  // ★ Get clipboard snapshot
  const snapshot = await wq();

  // ★ If clipboard is whitelist type (plain text), do not process
  if (snapshot.type === 'whitelist') {
    global.showAutoCloseNotification('info', q('q2.paste.plainTextOnly'))
    return;
  }

  // ★ Determine task type and estimated size
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

  // ★ Save transaction (for rollback)
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

  // ★ Use VS Code progress bar + cancel button
  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: taskTitle,
    cancellable: true
  }, async (progress, token) => {
    const isCancelled = () => token.isCancellationRequested;

    try {
      // ★ Call h.autoDetectAndPaste to perform actual paste, passing progress callback
      let result = await h.autoDetectAndPaste(
        targetDir,
        async (p, msg) => {
          progress.report({ increment: p, message: msg });
        },
        token,
        transId,
        snapshot,  // pass snapshot to avoid redundant detection
        null,
        () => token.isCancellationRequested,
        true  // autoRename = true, auto-rename same-name files
      );

      // ★ User cancellation handling
      if (isCancelled()) {
        const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
        if (trans) await TransactionManager.rollback(trans);

        TaskMessage.showSimpleToast(q('qqq.ui.taskCancelledRollback', taskTitle), 15000, 'cancel');

        // Refresh Webview
        if (refreshCallback) setTimeout(refreshCallback, 300);
        return;
      }

      // ★ Handle result
      if (result) {
        await TransactionManager.removeTransaction(transId);

        // ★ Stats and completion message
        const elapsedMs = Date.now() - taskStartTime;
        let detail = '';
        let totalSizeForStats = 0;

        if (result.type === 'html_blocks' || result.type === 'skeleton') {
          // HTML paste
          const mediaBlocks = result.blocks?.filter(b => b.type === 'media' && b.status === 'ok') || [];
          const mediaCount = mediaBlocks.length;
          const totalSize = mediaBlocks.reduce((sum, block) => sum + (block.size || 0), 0);
          totalSizeForStats = totalSize;

          let sizeStr = '';
          if (totalSize > 0) {
            if (totalSize < 1024) sizeStr = `${totalSize} b`;
            else if (totalSize < 1048576) sizeStr = `${(totalSize / 1024).toFixed(1)} k`;
            else sizeStr = `${(totalSize / 1048576).toFixed(1)} m`;
          }
          detail = q('q1.ui.mediaLanded', mediaCount, sizeStr ? ` ${sizeStr}` : '');

          if (result.baseUrl) {
            const urlSnippet = result.baseUrl.length > 33 ? result.baseUrl.substring(0, 33) + '...' : result.baseUrl;
            detail += q('q1.ui.fromUrl', urlSnippet);
          }
        } else if (result.type === 'file_folder' || result.type === 'file') {
          // File/folder paste
          const totalCount = (result.files?.length || 0) + (result.folders?.length || 0);
          const skippedCount = result.skippedCount || 0;
          detail = q('q1.ui.fileFolderCopied', totalCount);
          if (skippedCount > 0) {
            detail += ` ${q('q1.ui.skippedInaccessible', skippedCount)}`;
          }

          // Get total size
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
          // Image paste
          detail = q('q2.ui.imageSaved');
          if (result.path) {
            try { totalSizeForStats = fs.statSync(result.path).size; } catch { }
          }
        }

        // ★ Show completion message
        if (detail) {
          const msg = TaskMessage.done(taskTitle, detail, elapsedMs, taskNum);
          TaskMessage.showSimpleToast(msg, 15000, 'success');
        }

        // ★ Stats reporting
        if (taskType === 'video') {
          global.saveVideoStats(totalSizeForStats);
        } else {
          savePasteStats(totalSizeForStats);
        }

        // ★ Paste succeeded: record target directory to history
        recordDirHistory(targetDir);

        // Refresh Webview
        if (refreshCallback) setTimeout(refreshCallback, 300);
      } else {
        // Result is empty: rollback
        const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
        if (trans) await TransactionManager.rollback(trans);

        TaskMessage.showSimpleToast(q('q2.ui.noPasteContent', taskTitle), 10000, 'info');

        if (refreshCallback) setTimeout(refreshCallback, 300);
      }
    } catch (e) {
      console.error('[Q2 Paste Error]', e);
      const trans = (TransactionManager.getTransactions() || []).find(t => t.id === transId);
      if (trans) await TransactionManager.rollback(trans);

      TaskMessage.showSimpleToast(q('q1.ui.exceptionOccurred', taskTitle), 15000, 'cancel');

      if (refreshCallback) setTimeout(refreshCallback, 300);
    }
  });
}

// ==================== Main logic ====================
function showSaveAsDialog() {
  console.log('[q2] showSaveAsDialog called, activePanel=' + !!activePanel + ', activePanelAlive=' + activePanelAlive);
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

  // Start directory priority:
  // 1. last visited directory (restore session)
  // 2. first item in pinnedDirs
  // 3. first directory in qqiq
  // 4. platform default directory
  let currentPath = "";
  let lnkJumpFromPath = null; // ★ Record source directory when jumping via .lnk shortcut
  const lastVisited = getLastVisitedDir();
  if (lastVisited) {
    const canon = canonicalizeExistingPath(lastVisited);
    if (canon && fs.existsSync(canon)) currentPath = canon;
  }
  if (!currentPath && config.pinnedDirs && config.pinnedDirs.length > 0) {
    currentPath = canonicalizeExistingPath(config.pinnedDirs[0]);
  }
  if (!currentPath) {
    const firstDir = (config.qqiq || []).find(item => item.type === 'dir');
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

  // ★ Read roam name from config (defaults to "的梦gaea")
  const rawRoamName = global.getConfig("roamName") || "的梦gaea";
  // ★ Sanitize tab title to prevent UI issues and potential security risks
  // - Remove newlines (\r, \n) that break tab display
  // - Remove control characters (ASCII 0-31 except space) that cause rendering issues
  // - Strip HTML tags to prevent injection (though VS Code escapes them)
  // - Remove zero-width characters that can cause confusion
  // - Limit to 222 bytes to prevent excessive memory usage
  const roamName = sanitizeTabTitle(rawRoamName, 222);

  const panel = vscode.window.createWebviewPanel(
    "q2",
    roamName,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],

    }
  );
  activePanel = panel;
  activePanelAlive = true;

  // ★ Immediately register this window as having visible q2
  _updateQ2TrackingFile('register')

  const iconPath = path.join(globalContext.extensionPath, "assets", "icon.png");
  if (fs.existsSync(iconPath)) panel.iconPath = vscode.Uri.file(iconPath);

  panel.onDidDispose(() => {
    activePanelAlive = false;
    activePanel = null;
    sRequestVersion++; // Invalidate all in-flight sRequest operations
    cancelAllScans(); // Cancel long-running scans in all engines
    if (currentWatcher) {
      currentWatcher.dispose();
      currentWatcher = null;
    }
    // Note: tracking file cleanup happens automatically when Python detects dead windows
  });

  // ★ Track panel visibility: remove from tracking when q2 becomes hidden
  panel.onDidChangeViewState(e => {
    if (e.webviewPanel.visible) {
      _updateQ2TrackingFile('register');  // Visible again, re-register
    }
    // Note: when hidden, Python will clean up dead windows automatically
  });

  // ★ Track window focus: when losing focus with visible q2, write to tracking file
  const focusDisposable = vscode.window.onDidChangeWindowState(e => {
    if (e.focused && activePanelAlive) {
      // Window gained focus while q2 is visible - register this window
      _updateQ2TrackingFile('register')
    }
  });
  panel.onDidDispose(() => focusDisposable.dispose());

  // ★ Listen for language changes and refresh Webview in real time
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
  // Unsubscribe when panel is closed
  panel.onDidDispose(() => langChangeDisposable.dispose());

  async function updateResourceExplorer() {
    try {
      if (!panel || !activePanelAlive) return;

      // ★ Key fix: sync cooldown timestamp on every refresh (manual or watcher-triggered)
      // This prevents duplicate refreshes and ensures consistent cooldown behavior
      markWatcherRefreshTime();

      // Record current directory for detecting directory changes
      if (currentPath !== lastResourceExplorerPath) {
        lastResourceExplorerPath = currentPath;
        // ★ Save last visited directory immediately (can restore even if crashed)
        saveLastVisitedDir(currentPath);
      }

      // When switching directories, cancel previous pending size requests
      activeAbortController.abort();
      activeAbortController = new AbortController();
      const currentSignal = activeAbortController.signal;

      // ★ Note: file watcher cleanup moved to end of function (unified with setup logic)
      // This minimizes the gap where no watcher is active during directory read

      const config = getConfig();

      // ★ Fine-grained SCM has higher priority than global settings
      const fineSCM = getFineSCM(currentPath);
      const szDisplayMode = fineSCM.szMode || config.szDisplayMode;
      const sortBy = fineSCM.sortBy || config.sortBy;

      const directoryContents = await getDirectoryContents(currentPath, sortBy, szDisplayMode);
      const items = [];
      let fileListHtml = "";

      // Helper: generate sz-area content based on szDisplayMode
      function getSzContent(item, isFolder) {
        if (szDisplayMode === "nothing") return "";
        if (szDisplayMode === "size") {
          // size mode: only show file sizes; folders do not participate
          if (isFolder) return "";
          const bytes = item.size || 0;
          const sizeInfo = formatFileSizeEx(bytes);
          // If there is a GB part, return HTML with red color
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

      // Allow parent navigation: root does not show ..
      const canonCur = canonicalizeExistingPath(currentPath);
      const parent = canonicalizeExistingPath(path.dirname(canonCur));
      const root = (() => {
        try {
          // Use vscode.Uri to help resolve root path and improve cross-platform compatibility
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

      // ★ Update sidebar synchronously (history qq iq + pinned history)
      const sidebarData = generateSidebarHtml(config);
      panel.webview.postMessage({
        command: "updateSidebar",
        qqiqHtml: sidebarData.qqiqHtml,
        pinnedDirsHtml: sidebarData.pinnedDirsHtml,
      });

      // ★ Smart file watcher: only enable when user has autoWatchChanges enabled
      // Cleanup/setup is unified here to minimize monitoring gap during async operations
      if (config.autoWatchChanges) {
        setupFileWatcher(currentPath);
      } else {
        // User disabled autoWatch: clean up any existing watcher
        if (currentWatcher) {
          currentWatcher.dispose();
          currentWatcher = null;
        }
      }
    } catch (error) {
      geq().logMessage(q('q2.log.updatePreviewError', error), "ERROR");
    }
  }

  // File watcher setup (6s cooldown - ignore events within 6s after refresh)
  let lastWatcherRefreshTime = 0;
  const WATCHER_COOLDOWN_MS = 6000;

  // ★ Exported function: update cooldown timestamp (called by both manual refresh and watcher)
  function markWatcherRefreshTime() {
    lastWatcherRefreshTime = Date.now();
  }

  function setupFileWatcher(watchPath) {
    // Clean up old watcher
    if (currentWatcher) {
      currentWatcher.dispose();
      currentWatcher = null;
    }

    try {
      // Cooldown refresh: first event triggers refresh, then ignore for cooldown period
      const smartRefresh = () => {
        const now = Date.now();
        // Within cooldown period → ignore
        if (now - lastWatcherRefreshTime < WATCHER_COOLDOWN_MS) {
          return;
        }
        // Outside cooldown → refresh and start new cooldown
        lastWatcherRefreshTime = now;
        if (activePanel && activePanelAlive && globalRefreshWebview) {
          globalRefreshWebview();
        }
      };

      // Use VS Code FileSystemWatcher
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
      // Performance optimization: if Webview already has content, do not fully refresh HTML
      // Only initialize when HTML is empty. Directory switching is handled via update messages.
      if (!panel.webview.html || panel.webview.html === "") {
        panel.webview.html = getWebviewContent(currentPath);
        // First load needs a bit of time
        setTimeout(async () => {
          if (!panel || !activePanelAlive) return;
          await updateResourceExplorer();
          try {
            panel.webview.postMessage({ command: "focusInput" });
          } catch { }
        }, 300);
      } else {
        // Already active: update content asynchronously for "instant-open" responsiveness
        await updateResourceExplorer();
      }
    } catch (e) {
      geq().logMessage("Refresh Webview failed: " + e.message, "ERROR");
    }
  }

  // Register global refresh function
  globalRefreshWebview = refreshWebview;

  function getShowOptions(openInCurrentGroup) {
    const options = { preserveFocus: false, preview: true };
    if (!activePanel) {
      options.viewColumn = vscode.ViewColumn.One;
      return options;
    }

    const currentCol = activePanel.viewColumn || vscode.ViewColumn.One;

    if (openInCurrentGroup) {
      // !isPinned case: implement "one-for-one", open in the group where q2 is
      options.viewColumn = currentCol;
      return options;
    }

    // isPinned case: smartly find the adjacent group (left/right direction)
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
        // 1. Prefer the adjacent right group
        options.viewColumn = columns[idx + 1];
      } else if (idx > 0) {
        // 2. If already at rightmost limit, use left neighbor
        options.viewColumn = columns[idx - 1];
      } else {
        // 3. Only one group: create beside
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
          // ★ Update sidebar immediately (don't wait for refreshWebview async operations)
          if (panel && activePanelAlive) {
            const sbData = generateSidebarHtml(getConfig());
            panel.webview.postMessage({ command: "updateSidebar", qqiqHtml: sbData.qqiqHtml, pinnedDirsHtml: sbData.pinnedDirsHtml });
          }
          refreshWebview();
        }
        break;
      case "pinDirectory":
        if (message.path) {
          pinDirectory(message.path);
          // ★ Update sidebar immediately (don't wait for refreshWebview async operations)
          if (panel && activePanelAlive) {
            const sbData = generateSidebarHtml(getConfig());
            panel.webview.postMessage({ command: "updateSidebar", qqiqHtml: sbData.qqiqHtml, pinnedDirsHtml: sbData.pinnedDirsHtml });
          }
          currentPath = canonicalizeExistingPath(message.path);
          refreshWebview();
        }
        break;
      case "qqFileClick": {
        // Click qq iq file: re-pin dir+file, then edit the file
        const clickedFile = canonicalizeExistingPath(message.path);
        if (clickedFile && fs.existsSync(clickedFile)) {
          recordFileHistory(clickedFile);
          // Open for editing
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

      // QQ iq lazy load: request more items
      case "requestqqiq": {
        const offset = message.offset || 0;
        const limit = message.limit || QQ_IQ_BATCH_SIZE;
        const result = getqqiqItems(offset, limit);
        if (panel && activePanelAlive) {
          panel.webview.postMessage({
            command: 'appendqqiq',
            itemsHtml: result.itemsHtml,
            total: result.total,
            loaded: result.loaded
          });
        }
        break;
      }

      // Drive free space request (batched) - single IPC call for all drives
      case "getDiskFree": {
        (async () => {
          try {
            // ★ Use batch API: single IPC call instead of N calls for N drives
            const drives = getDrives();
            const res = await geq().getDiskFreeBatch(drives);

            if (panel && activePanelAlive) {
              // ★ Always send response to unblock frontend polling, even on failure
              panel.webview.postMessage({
                command: "diskFreeResult",
                data: (res && res.success && res.data) ? res.data : {} // Empty object on failure
              });
            }
          } catch (e) {
            geq().logMessage(q('q2.log.diskFreeError', e.message), "WARN");
            // ★ Send empty response on exception to unblock frontend
            if (panel && activePanelAlive) {
              panel.webview.postMessage({ command: "diskFreeResult", data: {} });
            }
          }
        })();
        break;
      }

      // ★ Open Recycle Bin/Trash (cross-platform)
      case "openRecycleBin": {
        try {
          if (process.platform === 'win32') {
            require('child_process').exec('explorer.exe shell:RecycleBinFolder');
          } else if (process.platform === 'darwin') {
            // macOS: open ~/.Trash
            require('child_process').exec('open ~/.Trash');
          } else {
            // Linux: open ~/.local/share/Trash
            const trashPath = path.join(os.homedir(), '.local/share/Trash');
            if (fs.existsSync(trashPath)) {
              require('child_process').exec('xdg-open "' + trashPath + '"');
            }
          }
        } catch (e) {
          geq().logMessage('Failed to open Recycle Bin: ' + e.message, 'WARN');
        }
        break;
      }

      // s request: click sz area to force-get size (including recursive folder size)
      // Optimization: render-as-you-go + version cancel mechanism
      case "sRequest": {
        const thisVersion = ++sRequestVersion; // Increment version to invalidate previous requests
        cancelAllScans(); // ★ Cancel ongoing underlying scans
        (async () => {
          const items = message.items || [];
          if (items.length === 0) return;

          // Render-as-you-go: send each result immediately when done, without blocking other items
          const promises = items.map(async (item) => {
            // Version check: if expired, skip
            if (sRequestVersion !== thisVersion) return;

            const isFolder = item.type === 'folder';
            const size = await getSizeForSRequest(item.path, isFolder);

            // Check version again: directory may have changed after computation finished
            if (sRequestVersion !== thisVersion) return;
            if (!panel || !activePanelAlive) return;

            // Send single result for immediate render
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

          // Execute concurrently, but do not wait for all to complete
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
          sRequestVersion++; // Invalidate in-flight sRequest when switching directories
          cancelAllScans(); // Cancel long-running scans in all engines
          const resolved = resolveNavPath(message.path, currentPath);

          // Windows: if user clicked drives "C:", after resolve it may still be "C:"; force root here
          let newPath = resolved;
          if (process.platform === "win32" && /^[A-Z]:$/i.test(newPath)) newPath = newPath.toUpperCase() + "\\";

          newPath = canonicalizeExistingPath(newPath);

          if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
            // ★ Clear lnk jump source on normal navigation (user navigated elsewhere)
            lnkJumpFromPath = null;
            currentPath = newPath;
            refreshWebview();
            // ★ After successful navigation, send success message so frontend can save history and blur
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
        sRequestVersion++; // Invalidate in-flight sRequest when switching directories
        cancelAllScans(); // Cancel long-running scans in all engines

        // ★ If we jumped here via .lnk, return to the source directory instead of parent
        if (lnkJumpFromPath && fs.existsSync(lnkJumpFromPath)) {
          currentPath = lnkJumpFromPath;
          lnkJumpFromPath = null; // Clear after use (one-time return)
          refreshWebview();
          break;
        }

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
          currentConfig.qqiq,
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
          currentConfig.qqiq,
          message.isPinned
        );
        // ★ Checkmark SFX
        if (global.pythonBridge?.isAvailable()) {
          const sfxName = message.isPinned ? "a1.mp3" : "kj2.mp3";
          global.pythonBridge.call("play_sfx", { category: "yz", name: sfxName }, 1000).catch(() => { });
        }
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

            // Link Q4 stats: accumulate created file count
            try {
              const q4 = vscode.extensions.getExtension(global.extensionId())?.exports;
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
        const p = canonicalizeExistingPath(message.path);
        const ext = path.extname(p).toLowerCase();

        // Quick filter for known binary extensions
        if (UNSUPPORTED_CODE_EXTENSIONS.has(ext)) {
          global.showAutoCloseNotification('warning', q('q2.error.unsupportedFile', path.basename(p)));
          break;
        }

        if (!fs.existsSync(p)) {
          global.showAutoCloseNotification('warning', q('q2.error.fileNotExists', path.basename(p)));
          refreshWebview();
          break;
        }

        // ★ Perfect mechanism: try to open first, record history only on success
        vscode.workspace
          .openTextDocument(p)
          .then((doc) => {
            // ★ Only record history after successful open
            recordFileHistory(message.path);
            // ★ Update sidebar immediately
            if (panel && activePanelAlive) {
              const sbData = generateSidebarHtml(getConfig());
              panel.webview.postMessage({ command: "updateSidebar", qqiqHtml: sbData.qqiqHtml, pinnedDirsHtml: sbData.pinnedDirsHtml });
            }
            vscode.window.showTextDocument(doc, getShowOptions(message.openInCurrentGroup)).then(() => {
              if (!message.isPinned && panel && activePanelAlive) panel.dispose();
            });
          })
          .catch((error) => {
            // ★ Failed to open: show warning, do NOT record history
            global.showAutoCloseNotification('warning', q('q2.error.unsupportedFile', path.basename(p)));
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
        // ★ Record parent directory to qqiq (not the item itself)
        // Logic: user pressed w in this directory, so record where they were working
        recordDirHistory(path.dirname(p));
        // ★ Update sidebar immediately (same as q-key behavior)
        if (panel && activePanelAlive) {
          const sbData = generateSidebarHtml(getConfig());
          panel.webview.postMessage({ command: "updateSidebar", qqiqHtml: sbData.qqiqHtml, pinnedDirsHtml: sbData.pinnedDirsHtml });
        }
        // ★ Special handling for .lnk files pointing to folders: navigate in q2 instead of opening in Explorer
        // Uses pure Node.js Buffer parsing (no PowerShell/daemon dependency, <1ms)
        if (process.platform === "win32" && path.extname(p).toLowerCase() === ".lnk") {
          const target = parseLnkTarget(p);
          if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
            // Target is a folder: navigate in q2
            // ★ Save source directory for backspace to return here
            lnkJumpFromPath = currentPath;
            sRequestVersion++;
            cancelAllScans();
            currentPath = canonicalizeExistingPath(target);
            refreshWebview();
            if (panel && activePanelAlive) {
              panel.webview.postMessage({ command: 'navigateSuccess', path: target });
            }
            break;
          }
        }
        try {
          global.openExternal(vscode.Uri.file(p));
        } catch (error) {
          global.showAutoCloseNotification('error', q('q2.error.openFileError', error.message));
        }
        break;
      }

      case "quickDeleteToqqiq": {
        // Delete to recycle bin (non-blocking with progress)
        const itemToDelete = canonicalizeExistingPath(message.path);
        // Safety guard: absolutely forbid deleting parent directory
        if (path.basename(itemToDelete) === '..' || message.name === '..') {
          global.showAutoCloseNotification('error', q('q2.error.deleteParentForbidden'));
          refreshWebview();
          break;
        }
        if (fs.existsSync(itemToDelete)) {
          recordDirHistory(currentPath);
          (async () => {
            try {
              const result = await deleteWithProgressUI(itemToDelete, true, path.basename(itemToDelete));

              if (result.cancelled) {
                global.showAutoCloseNotification('info', q('q2.ui.deleteCancelled', result.deleted));
              } else if (result.errors.length > 0) {
                global.showAutoCloseNotification('warning', q('q2.ui.deleteErrors', result.errors.length));
                logDeleteErrors(result.errors);
                await handlePermissionErrors(result.errors, itemToDelete);
              } else {
                global.showAutoCloseNotification('info', q('q2.ui.movedToRecycleBin', path.basename(itemToDelete)));
                // ★ Move-to-qq-iq SFX
                if (global.pythonBridge?.isAvailable()) {
                  global.pythonBridge.call("play_sfx", { category: "yz", name: "4.mp3" }, 1000).catch(() => { });
                }
              }
            } catch (error) {
              global.showAutoCloseNotification('error', q('q2.ui.deleteFailed', error.message));
            } finally {
              // Refresh list and restore state regardless of success/failure
              if (activePanel && activePanelAlive) refreshWebview();
            }
          })();
        } else {
          refreshWebview();
        }
        break;
      }

      case "quickDeleteMultipleToqqiq": {
        // Delete multiple items to recycle bin (non-blocking with progress)
        const itemsToDelete = (message.items || []).filter(item => item.name !== '..'); // Second-pass filtering on extension side to ensure safety
        if (itemsToDelete.length > 0) {
          recordDirHistory(currentPath);
          (async () => {
            try {
              const result = await deleteMultipleWithProgressUI(itemsToDelete, true);

              if (result.cancelled) {
                global.showAutoCloseNotification('info', q('q2.ui.deleteCancelled', result.deleted));
              } else if (result.deleted > 0 && result.errors.length === 0) {
                global.showAutoCloseNotification('info', q('q2.ui.multiDeleteSuccess', result.deleted));
              } else if (result.deleted > 0 && result.errors.length > 0) {
                global.showAutoCloseNotification('warning', q('q2.ui.multiDeletePartial', result.deleted, result.errors.length));
              } else if (result.errors.length > 0) {
                global.showAutoCloseNotification('error', q('q2.ui.multiDeleteFailed', result.errors.length));
              }

              // ★ Move-to-qq-iq SFX
              if (result.deleted > 0 && global.pythonBridge?.isAvailable()) {
                global.pythonBridge.call("play_sfx", { category: "yz", name: "4.mp3" }, 1000).catch(() => { });
              }

              logDeleteErrors(result.errors);
              // For multi-select, use first failed item's path or currentPath
              const firstFailedPath = result.errors.length > 0 ? result.errors[0].path : currentPath;
              await handlePermissionErrors(result.errors, firstFailedPath);
            } finally {
              // No matter what errors happen during deletion, must force refresh at end to restore UI
              if (activePanel && activePanelAlive) refreshWebview();
            }
          })();
        } else {
          refreshWebview();
        }
        break;
      }

      case "quickPermanentDelete": {
        // Shift+Delete permanently delete a single item (non-blocking with progress)
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
              const result = await deleteWithProgressUI(itemToDelete, false, path.basename(itemToDelete));

              if (result.cancelled) {
                global.showAutoCloseNotification('info', q('q2.ui.deleteCancelled', result.deleted));
              } else if (result.errors.length > 0) {
                global.showAutoCloseNotification('warning', q('q2.ui.deleteErrors', result.errors.length));
                logDeleteErrors(result.errors);
                await handlePermissionErrors(result.errors, itemToDelete);
              } else {
                global.showAutoCloseNotification('info', q('q2.ui.permanentDeleted', path.basename(itemToDelete)));
                // ★ Permanent delete SFX
                if (global.pythonBridge?.isAvailable()) {
                  global.pythonBridge.call("play_sfx", { category: "yz", name: "rou1.mp3" }, 1000).catch(() => { });
                }
              }
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
        // Shift+Delete permanently delete multiple items (non-blocking with progress)
        const itemsToDelete = (message.items || []).filter(item => item.name !== '..');
        if (itemsToDelete.length > 0) {
          recordDirHistory(currentPath);
          (async () => {
            try {
              const result = await deleteMultipleWithProgressUI(itemsToDelete, false);

              if (result.cancelled) {
                global.showAutoCloseNotification('info', q('q2.ui.deleteCancelled', result.deleted));
              } else if (result.deleted > 0 && result.errors.length === 0) {
                global.showAutoCloseNotification('info', q('q2.ui.multiPermanentDeleteSuccess', result.deleted));
              } else if (result.deleted > 0 && result.errors.length > 0) {
                global.showAutoCloseNotification('warning', q('q2.ui.multiPermanentDeletePartial', result.deleted, result.errors.length));
              } else if (result.errors.length > 0) {
                global.showAutoCloseNotification('error', q('q2.ui.multiPermanentDeleteFailed', result.errors.length));
              }

              // ★ Permanent delete SFX
              if (result.deleted > 0 && global.pythonBridge?.isAvailable()) {
                global.pythonBridge.call("play_sfx", { category: "yz", name: "rou1.mp3" }, 1000).catch(() => { });
              }

              logDeleteErrors(result.errors);
              // For multi-select, use first failed item's path or currentPath
              const firstFailedPath = result.errors.length > 0 ? result.errors[0].path : currentPath;
              await handlePermissionErrors(result.errors, firstFailedPath);
            } finally {
              if (activePanel && activePanelAlive) refreshWebview();
            }
          })();
        } else {
          refreshWebview();
        }
        break;
      }

      case "copy":
        if (message.paths && message.paths.length > 0) {
          // Extension-side safety filter: only filter literal ".." relative paths; allow resolved absolute paths
          const safePaths = message.paths.filter(p => p !== '..' && !p.endsWith(path.sep + '..'));
          if (safePaths.length > 0) {
            await h.copyFilesToClipboard(safePaths);
          }
        }
        break;

      case "paste":
        // ★★★ Q2 paste feature: fully ported from Q1, transaction-based, with progress bar, cancellable ★★★
        await performQ2Paste(message.destDir, refreshWebview);
        break;

      case "setFineSCM": {
        // ★ Save fine-grained SCM and refresh immediately
        const folderPath = message.path;
        const szMode = message.szMode;
        const sortByValue = message.sortBy;
        setFineSCMValue(folderPath, szMode, sortByValue);
        // Refresh UI immediately
        if (activePanel && activePanelAlive) refreshWebview();
        break;
      }

      case "showAutoCloseMessage": {
        // ★ Auto-close popup (9 seconds)
        const msgType = message.type || 'info';
        const msgText = message.message || '';
        global.showAutoCloseNotification(msgType, msgText);
        break;
      }

      // Admin terminal: a key -> CMD, x key -> PowerShell
      case "openAdminCmd": {
        const targetPath = canonicalizeExistingPath(message.path || currentPath);
        openAdminTerminal(targetPath, 'cmd');
        // ★ Open terminal SFX
        if (global.pythonBridge?.isAvailable()) {
          global.pythonBridge.call("play_sfx", { category: "yz", name: "zs861.mp3" }, 1000).catch(() => { });
        }
        break;
      }

      case "openAdminPowershell": {
        const targetPath = canonicalizeExistingPath(message.path || currentPath);
        openAdminTerminal(targetPath, 'powershell');
        // ★ Open terminal SFX
        if (global.pythonBridge?.isAvailable()) {
          global.pythonBridge.call("play_sfx", { category: "yz", name: "zs861.mp3" }, 1000).catch(() => { });
        }
        break;
      }

      case "playEnterSfx": {
        // ★ Enter key SFX
        if (global.pythonBridge?.isAvailable()) {
          global.pythonBridge.call("play_sfx", { category: "yz", name: "a2.mp3" }, 1000).catch(() => { });
        }
        break;
      }
    }
  });

  refreshWebview();
}

// ==================== Extension activation ====================
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

  // ★ Debug i18n
  console.log(`[Q2] i18n test: q('q2.ui.pin') = "${q('q2.ui.pin')}"`);

  LARGE_WATERMARK_PATH = path.join(extensionPath, "assets", "al.png");
  SMALL_WATERMARK_PATH = path.join(extensionPath, "assets", "as.png");

  // Verify integrity asynchronously without blocking activation
  global.verifySystemIntegrityAsync(context).then(valid => {
    geq().logMessage(`Q2 Integrity: ${valid ? "PASSED" : "FAILED"}`, "INFO");
  });

  getConfig();
  geq().logMessage(q('q2.log.activated'), "INFO");

  // ★ Ultimate fix: use ConfigGate callback mechanism to receive config update notifications (resolve race condition)
  // Previously, directly listening to onDidChangeConfiguration caused reading config before sessionOverrides update
  global.ConfigManager.onConfigUpdated((changedKeys, event) => {
    // Only care about q2-related config
    const q2Keys = ["szDisplayMode", "sortBy", "autoWatchChanges"];
    if (!changedKeys.some(k => q2Keys.includes(k))) return;

    // Clear config cache and force re-read
    cachedInMemoryConfig = null;
    geq().logMessage(q('q2.log.configRefresh'), "INFO");
    // If panel is showing, refresh it
    if (activePanel && activePanelAlive && globalRefreshWebview) {
      globalRefreshWebview();
    }
  });

  // ★ Multi-window sync: refresh sidebar (qq area + history) when window gains focus
  // This ensures cross-window consistency since globalState is shared but UI is per-window
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused && activePanel && activePanelAlive) {
        // Clear config cache to force re-read from globalState (may have been modified by other windows)
        cachedInMemoryConfig = null;
        const config = getConfig();
        const sbData = generateSidebarHtml(config);
        try {
          activePanel.webview.postMessage({
            command: "updateSidebar",
            qqiqHtml: sbData.qqiqHtml,
            pinnedDirsHtml: sbData.pinnedDirsHtml,
          });
        } catch { }
      }
    })
  );

  // ★ 防御性命令注册：防止开发环境热重载或新旧版本共存时命令重复注册
  const safeRegisterCommand = (commandId, handler) => {
    try {
      return vscode.commands.registerCommand(commandId, handler);
    } catch (e) {
      if (e.message?.includes('already exists')) {
        global.logMessage(`[Q2] Command ${commandId} already exists, skipping`, 'WARN');
        return { dispose: () => {} };
      }
      throw e;
    }
  };

  context.subscriptions.push(
    safeRegisterCommand("qqq.q2", global.withReady(showSaveAsDialog)),
    safeRegisterCommand("qqq.saveAsDialog", global.withReady(showSaveAsDialog))
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

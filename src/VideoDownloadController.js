const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const h = require('./h');
const { getSharedDownloader } = require('./dow');
const https = require('https');

class VideoDownloadController {
    constructor(context) {
        this.context = context;
        this.downloader = getSharedDownloader();
        this.outputChannel = vscode.window.createOutputChannel("qqq: Video Downloader");

        // ✅ 修复：globalStorageUri.fsPath 已经包含扩展ID目录（例如 ...\globalStorage\gh555.qqq）
        this.chromeHome = this.context.globalStorageUri.fsPath;

        // 持久化用户数据目录（登录信息）
        this.userDataDir = path.join(this.chromeHome, 'user-data');

        // globalState keys
        this.KEY_CUSTOM_BROWSER = 'customBrowserPath';         // 用户选择并成功跑过一次的 Chromium
        this.KEY_DEDICATED_BROWSER = 'dedicatedChromeExePath'; // 下载的专用 Chrome 并成功跑过一次

        // 三号弹窗：点“打开”后能选中文件
        this.CMD_REVEAL_DOWNLOADED = 'qqq.revealDownloaded';
        this._ensureRevealCommandOnce();
    }

    log(msg) {
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
    }

    async start() {
        const url = await vscode.window.showInputBox({
            prompt: "直接粘贴 [ 包含视频滴网址 ] ",
            ignoreFocusOut: true,
            placeHolder: "https://..."
        });
        if (!url) return;

        // 异步确保 yt-dlp，不阻塞 UI
        this.downloader.ensureYtdlpReady(this.context).catch(e => console.error(e));

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("请先打开一个文档以便插入视频。");
            return;
        }

        const currentDocDir = path.dirname(editor.document.uri.fsPath);
        const targetDir = path.join(currentDocDir, "qqq");
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        this.log(`开始处理: ${url}`);
        this.outputChannel.show(true);

        await this._fastProcess(url, targetDir);
    }

    // ============ 小工具 ============
    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    _formatBytesSimple(bytes) {
        if (!bytes || bytes <= 0) return "0k";
        const k = 1024;
        const m = 1024 * 1024;
        if (bytes >= m) return Math.round(bytes / m) + "m";
        return Math.round(bytes / k) + "k";
    }

    _parseSizeToBytes(sizeStr) {
        if (!sizeStr) return 0;
        const match = sizeStr.match(/([\d\.]+)([KMGTiB]+)/i);
        if (!match) return 0;
        const val = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        let multiplier = 1;
        if (unit.startsWith('K')) multiplier = 1024;
        else if (unit.startsWith('M')) multiplier = 1024 * 1024;
        else if (unit.startsWith('G')) multiplier = 1024 * 1024 * 1024;
        return Math.floor(val * multiplier);
    }

    _sanitizeFilename(title) {
        if (!title) return null;
        let safe = title.replace(/[\\/:*?"<>|]/g, "_");
        safe = safe.replace(/\s+/g, " ").trim();
        if (safe.length > 80) safe = safe.substring(0, 80);
        return safe;
    }

    _isForbidden(code, error) {
        return code === 403 || code === 401 || (error && error.toString().includes('403'));
    }

    _deduplicateTasks(tasks) {
        const seen = new Set();
        return tasks.filter(t => {
            if (!t.url) return false;
            if (seen.has(t.url)) return false;
            seen.add(t.url);
            return true;
        });
    }

    _createTask(videoUrl, title, targetDir, referer) {
        let destPath = null;
        let fileName = null;

        if (title && title !== 'Direct Link' && title !== 'Web Resource') {
            fileName = this._sanitizeFilename(title) + ".mp4";
        } else {
            try {
                const u = new URL(videoUrl);
                const base = path.basename(u.pathname);
                if (base && base.match(/\.(mp4|webm|mkv|mov|flv|avi|wmv|m4v|mpg|mpeg|3gp|ts|ogv)$/i)) {
                    fileName = decodeURIComponent(base);
                }
            } catch (e) { }

            if (!fileName || fileName.length > 50 || !/^[a-zA-Z0-9._-]+$/.test(fileName)) {
                fileName = h.getTimestampFilename('.mp4');
            }
        }

        if (fileName) destPath = path.join(targetDir, fileName);

        const headers = {};
        if (referer) headers["Referer"] = referer;

        return {
            url: videoUrl,
            destPath: destPath,
            kind: "video",
            baseDir: targetDir,
            headers: headers
        };
    }

    // ==================== 三号弹窗（15s 自动消失 + 点击能选中文件） ====================
    _ensureRevealCommandOnce() {
        if (VideoDownloadController.__revealCmdRegistered) return;
        VideoDownloadController.__revealCmdRegistered = true;

        const disp = vscode.commands.registerCommand(this.CMD_REVEAL_DOWNLOADED, async (filePath, folderPath) => {
            try {
                // 点了就让三号立刻消失
                if (VideoDownloadController.__resultToastCts) {
                    VideoDownloadController.__resultToastCts.cancel();
                }
            } catch (e) { }

            try {
                await this._revealFileOrFolder(filePath, folderPath);
            } catch (e) { }
        });

        try { this.context.subscriptions.push(disp); } catch (e) { }
        VideoDownloadController.__revealCmdDisposable = disp;
    }

    _makeCommandLink(commandId, argsArray) {
        try {
            const arg = encodeURIComponent(JSON.stringify(argsArray || []));
            return `[打开下载位置](command:${commandId}?${arg})`;
        } catch (e) {
            return '';
        }
    }

    async _revealFileOrFolder(filePath, folderPath) {
        const existsFile = filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        const folder = folderPath && fs.existsSync(folderPath) ? folderPath : (existsFile ? path.dirname(filePath) : null);

        // 1) 尽量选中文件
        if (existsFile) {
            const p = filePath;

            if (process.platform === 'win32') {
                // explorer.exe /select,"C:\path\file.mp4"
                return await new Promise((resolve) => {
                    try {
                        cp.execFile('explorer.exe', ['/select,', p], { windowsHide: true }, () => resolve());
                    } catch (e) { resolve(); }
                });
            }

            if (process.platform === 'darwin') {
                return await new Promise((resolve) => {
                    try {
                        cp.execFile('open', ['-R', p], {}, () => resolve());
                    } catch (e) { resolve(); }
                });
            }

            // linux: 没统一“选中某文件”能力，退化打开目录
            if (folder) {
                try { await vscode.env.openExternal(vscode.Uri.file(folder)); } catch (e) { }
                return;
            }
        }

        // 2) 退化：打开目录
        if (folder) {
            try { await vscode.env.openExternal(vscode.Uri.file(folder)); } catch (e) { }
        }
    }

    _pickFirstFileBySize(paths) {
        if (!paths || paths.length === 0) return null;
        let best = null;
        let bestSize = -1;
        for (const p of paths) {
            try {
                if (!fs.existsSync(p)) continue;
                const s = fs.statSync(p);
                if (!s.isFile()) continue;
                if (s.size > bestSize) {
                    bestSize = s.size;
                    best = p;
                }
            } catch (e) { }
        }
        return best || paths[0] || null;
    }

    async _showResultToastTimed(resultMsg, targetDir, firstFilePath, timeoutMs = 15000) {
        // 干掉旧的三号弹窗
        try {
            if (VideoDownloadController.__resultToastCts) {
                VideoDownloadController.__resultToastCts.cancel();
                VideoDownloadController.__resultToastCts.dispose();
            }
        } catch (e) { }

        const cts = new vscode.CancellationTokenSource();
        VideoDownloadController.__resultToastCts = cts;

        const link = this._makeCommandLink(this.CMD_REVEAL_DOWNLOADED, [firstFilePath || null, targetDir || null]);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "qqq: 任务结束",
            cancellable: true   // ✅ 给你一个系统“取消”按钮（用户可立刻关掉）
        }, async (progress) => {
            progress.report({ message: `${resultMsg}  ${link}` });

            return await new Promise((resolve) => {
                let done = false;

                const cleanup = () => {
                    if (done) return;
                    done = true;
                    try { sub.dispose(); } catch (e) { }
                    try { clearTimeout(t); } catch (e) { }
                    try {
                        if (VideoDownloadController.__resultToastCts === cts) {
                            VideoDownloadController.__resultToastCts.dispose();
                            VideoDownloadController.__resultToastCts = null;
                        }
                    } catch (e) { }
                    resolve(null);
                };

                const sub = cts.token.onCancellationRequested(() => cleanup());
                const t = setTimeout(() => cleanup(), timeoutMs);
            });
        });
    }

    // ==================== 通知屏蔽：清掉 downloader 内部那种“成功/失败”弹窗 ====================
    async _runWithSuppressedPopups(fn) {
        const win = vscode.window;

        const origInfo = win.showInformationMessage;
        const origWarn = win.showWarningMessage;
        const origErr = win.showErrorMessage;

        const suppress = async (kind, msg) => {
            try { this.log(`[Suppressed ${kind}] ${String(msg || '').slice(0, 200)}`); } catch (e) { }
            return undefined;
        };

        win.showInformationMessage = async (message, ...rest) => suppress('Info', message);
        win.showWarningMessage = async (message, ...rest) => suppress('Warn', message);
        win.showErrorMessage = async (message, ...rest) => suppress('Error', message);

        try {
            return await fn();
        } finally {
            win.showInformationMessage = origInfo;
            win.showWarningMessage = origWarn;
            win.showErrorMessage = origErr;
        }
    }

    // ==================== 普通流程：一号下载进度 + 三号结果 ====================
    async _fastProcess(url, targetDir) {
        try {
            const urlSnippet = url.length > 44 ? url.slice(0, 44) + "..." : url;

            // ========= 一号弹窗（进度通知） =========
            const outcome = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "",
                cancellable: true
            }, async (progress, token) => {
                progress.report({ message: `已交换 0k 于 ${urlSnippet} (正在解析...)` });

                token.onCancellationRequested(() => {
                    this.log("用户取消下载（仅关闭弹窗；不一定能中断底层下载）");
                });

                this.log("正在智能嗅探资源...");
                let tasks = [];

                let probeForbidden = false;
                try {
                    const res = await this.downloader.probe(url);

                    if (res && res.success) {
                        if (res.isPlaylist && res.entries && res.entries.length > 0) {
                            this.log(`识别为列表，共 ${res.entries.length} 个视频。`);
                            tasks = res.entries.map(e => this._createTask(e.url || e.webpage_url, e.title, targetDir, url));
                        } else {
                            this.log(`识别为单个视频: ${res.title}`);
                            tasks.push(this._createTask(res.url || res.webpageUrl || url, res.title, targetDir, url));
                        }
                    } else {
                        if (this._isForbidden(403, res?.error)) {
                            probeForbidden = true;
                            this.log("探测返回 403，尝试直接加入下载队列以触发增强流程。");
                            tasks.push(this._createTask(url, null, targetDir, url));
                        } else {
                            this.log(`yt-dlp 探测未发现资源或不支持: ${res?.error}`);
                        }
                    }
                } catch (e) {
                    this.log(`yt-dlp 探测异常: ${e.message}`);
                }

                // 静态分析（保留：你以后可能还想用）
                try {
                    const webUrls = await h.extractVideoUrlsFromWebPage(url);
                    if (webUrls && webUrls.length > 0) {
                        this.log(`静态分析发现 ${webUrls.length} 个资源链接。`);
                        webUrls.forEach(u => tasks.push(this._createTask(u, 'Web Resource', targetDir, url)));
                    }
                } catch (e) { }

                tasks = this._deduplicateTasks(tasks);

                if (tasks.length === 0) {
                    this.log("未探测到明确资源，尝试直接下载原链接...");
                    tasks.push(this._createTask(url, 'Direct Link', targetDir, url));
                }

                this.log(`准备下载 ${tasks.length} 个任务...`);
                progress.report({ message: `已交换 0k 于 ${urlSnippet}` });

                // 文件名前缀集合（用于扫盘统计）
                const activePrefixes = new Set();
                tasks.forEach(t => {
                    if (t.destPath) {
                        const name = path.basename(t.destPath, path.extname(t.destPath));
                        if (name) activePrefixes.add(name);
                    }
                });

                let diskTotalBytes = 0;
                let logTotalBytes = 0;
                const logProgressMap = new Map();

                let fileSizeTimer = null;

                try {
                    fileSizeTimer = setInterval(() => {
                        let currentDiskBytes = 0;
                        try {
                            if (fs.existsSync(targetDir)) {
                                const files = fs.readdirSync(targetDir);
                                for (const f of files) {
                                    for (const prefix of activePrefixes) {
                                        if (f.startsWith(prefix)) {
                                            try {
                                                const s = fs.statSync(path.join(targetDir, f));
                                                if (s.isFile()) currentDiskBytes += s.size;
                                            } catch (e) { }
                                            break;
                                        }
                                    }
                                }
                            }
                        } catch (e) { }
                        diskTotalBytes = currentDiskBytes;

                        const finalBytes = Math.max(diskTotalBytes, logTotalBytes);
                        const totalStr = this._formatBytesSimple(finalBytes);
                        progress.report({ message: `已交换 ${totalStr} 于 ${urlSnippet}` });
                    }, 500);

                    const res = await this.downloader.downloadAll(tasks, targetDir, {
                        downloadVideos: "all",
                        onProgress: (task, event) => {
                            if (event.type === 'start') {
                                this.log(`开始: ${this._sanitizeFilename(task.url).slice(0, 30)}...`);
                            } else if (event.type === 'progress') {
                                const p = event.progress;
                                let currentBytes = 0;
                                if (typeof p === 'object' && p.currentSize) {
                                    currentBytes = this._parseSizeToBytes(p.currentSize);
                                }
                                if (currentBytes > 0) {
                                    logProgressMap.set(task.url, currentBytes);
                                    let sum = 0;
                                    for (const b of logProgressMap.values()) sum += b;
                                    logTotalBytes = sum;
                                }
                            } else if (event.type === 'done') {
                                this.log(`完成: ${path.basename(task.destPath)}`);
                            } else if (event.type === 'error') {
                                // ✅ 只记日志，不弹失败弹窗
                                this.log(`失败: ${task.url} - ${event.error}`);
                            } else if (event.type === 'retry') {
                                this.log(`重试: ${task.url} (Wait ${event.delayMs}ms)`);
                            }
                        }
                    });

                    const results = res.results || [];
                    const successResults = results.filter(r => r.success);
                    const failResults = results.filter(r => !r.success);

                    const landedFiles = [];
                    let finalTotalBytes = 0;

                    for (const r of successResults) {
                        const p = r.path || r.destPath;
                        const finalPath = await this._postProcess(p);
                        if (finalPath) {
                            landedFiles.push(finalPath);
                            try { finalTotalBytes += fs.statSync(finalPath).size; } catch (e) { }
                        }
                    }

                    const forbiddenErrors = failResults.filter(r => this._isForbidden(r.code || r.httpStatus, r.error));
                    const needEnhanced =
                        forbiddenErrors.length > 0 ||
                        (probeForbidden && landedFiles.length === 0) ||
                        (landedFiles.length === 0 && successResults.length > 0);

                    return {
                        needEnhanced,
                        code: forbiddenErrors[0]?.code || 403,
                        landedFiles,
                        finalTotalBytes,
                        urlSnippet
                    };

                } finally {
                    if (fileSizeTimer) {
                        try { clearInterval(fileSizeTimer); } catch (e) { }
                    }
                }
            });

            // ========= 到这里：一号弹窗必然已结束（消失） =========
            if (!outcome) return;

            if (outcome.needEnhanced) {
                await this._handleForbidden(outcome.code || 403, url, targetDir);
                return;
            }

            const landedCount = (outcome.landedFiles || []).length;
            const finalTotalStr = this._formatBytesSimple(outcome.finalTotalBytes || 0);
            const resultMsg = `任务结束, 共落盘${landedCount}个视频共：${finalTotalStr} 从 ${outcome.urlSnippet}`;

            this.log(`[Done] ${resultMsg}`);

            const firstFile = this._pickFirstFileBySize(outcome.landedFiles || []);
            await this._showResultToastTimed(resultMsg, targetDir, firstFile, 15000);

        } catch (error) {
            this.log(`处理失败: ${error.message}`);
        }
    }

    // ==================== 后处理：验证 + 可能改名 + 插入路径（返回最终落盘路径） ====================
    async _postProcess(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return null;

        this.log(`正在验证文件: ${path.basename(filePath)}`);

        let ffmpeg = 'ffmpeg';
        if (this.downloader.ytdlp && this.downloader.ytdlp.ffmpegPath) {
            ffmpeg = this.downloader.ytdlp.ffmpegPath;
        }

        return new Promise((resolve) => {
            const proc = cp.spawn(ffmpeg, ['-i', filePath]);
            let stderr = '';
            proc.stderr.on('data', d => stderr += d.toString());

            proc.on('close', async () => {
                const isVideo = stderr.includes('Video:') || stderr.includes('Audio:');
                const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);

                if (isVideo && durationMatch) {
                    const currentName = path.basename(filePath);
                    const ext = path.extname(filePath).toLowerCase();
                    let finalPath = filePath;

                    const isTooLong = currentName.length > 100;

                    let newExt = ext;
                    if (stderr.includes("Video: h264") && !['.mp4', '.mkv', '.mov'].includes(ext)) newExt = '.mp4';
                    else if (stderr.includes("Video: vp9") && ext !== '.webm' && ext !== '.mkv') newExt = '.webm';

                    if (isTooLong) {
                        const safeName = h.getTimestampFilename(newExt || '.mp4');
                        const p2 = path.join(path.dirname(filePath), safeName);
                        try { fs.renameSync(filePath, p2); finalPath = p2; } catch (e) { finalPath = filePath; }
                    } else if (newExt !== ext) {
                        const p2 = filePath.replace(ext, newExt);
                        try { fs.renameSync(filePath, p2); finalPath = p2; } catch (e) { finalPath = filePath; }
                    }

                    await this._insertToCursor(path.basename(finalPath), finalPath);
                    resolve(finalPath);
                } else {
                    this.log(`文件无效 (非视频或损坏)，删除: ${filePath}`);
                    try { fs.unlinkSync(filePath); } catch (e) { }
                    resolve(null);
                }
            });
        });
    }

    async _insertToCursor(fileName, fullPath) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const docDir = path.dirname(editor.document.uri.fsPath);
        let relPath = path.relative(docDir, fullPath).replace(/\\/g, '/');

        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, `/\\${relPath}\\/\n`);
        });
    }

    // ==================== 逻辑 Q：增强流程入口 ====================
    async _handleForbidden(code, url, targetDir) {
        const selection = await vscode.window.showInformationMessage(
            `qqq: 被拒绝，返回 ${code}，当前可尝试启动增强流程。`,
            { modal: false },
            "🚀启动增强流程",
            "选择类似 chrome.exe 滴浏览器入口文件"
        );

        if (selection === "🚀启动增强流程") {
            await this._runEnhancedPreferSaved(url, targetDir);
        } else if (selection === "选择类似 chrome.exe 滴浏览器入口文件") {
            await this._runEnhancedForcePick(url, targetDir);
        } else {
            // ✅ 不再额外弹提示，避免噪音
            this.log("用户取消增强流程");
        }
    }

    async _runEnhancedPreferSaved(url, targetDir) {
        await this._cleanupSavedBrowserPaths();

        const dedicated = this.context.globalState.get(this.KEY_DEDICATED_BROWSER);
        if (dedicated && fs.existsSync(dedicated)) {
            const v = await this._validateChromiumSilently(dedicated);
            if (v.valid) {
                this.log(`[增强] 使用已保存专用浏览器: ${dedicated} (${v.version})`);
                await this._startSniffer(dedicated, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
                return;
            } else {
                await this.context.globalState.update(this.KEY_DEDICATED_BROWSER, undefined);
            }
        }

        const custom = this.context.globalState.get(this.KEY_CUSTOM_BROWSER);
        if (custom && fs.existsSync(custom)) {
            const v = await this._validateChromiumSilently(custom);
            if (v.valid) {
                this.log(`[增强] 使用已保存用户浏览器: ${custom} (${v.version})`);
                await this._startSniffer(custom, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
                return;
            } else {
                await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);
            }
        }

        await this._promptPickThenMaybeDownload(url, targetDir);
    }

    async _runEnhancedForcePick(url, targetDir) {
        await this._promptPickThenMaybeDownload(url, targetDir);
    }

    async _promptPickThenMaybeDownload(url, targetDir) {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: process.platform === 'win32'
                ? { 'Executables': ['exe'] }
                : { 'Executables': ['', 'app'] },
            title: "请选择 Chromium 内核浏览器的可执行文件"
        });

        if (!uris || uris.length === 0) {
            const sel = await vscode.window.showErrorMessage(
                "qqq: 未选择浏览器入口文件。可选下载chrome（约150m）或终止一切。",
                "下载 chrome", "终止一切"
            );
            if (sel === "下载 chrome") {
                await this._downloadChrome(url, targetDir);
            } else {
                this.log("用户终止增强流程");
            }
            return;
        }

        const exePath = uris[0].fsPath;
        this.log(`[增强] 用户选择: ${exePath}`);

        const validation = await this._validateChromiumSilently(exePath);

        if (validation.valid) {
            this.log(`[增强] 用户浏览器验证通过: ${validation.version}`);
            await this._startSniffer(exePath, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
            return;
        }

        await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);

        this.log(`[增强] 用户浏览器验证失败: ${validation.error}`);

        const sel = await vscode.window.showErrorMessage(
            `qqq: 该入口文件无效，可选下载chrome（约150m）或终止一切。\n原因: ${validation.error}`,
            "下载 chrome", "终止一切"
        );

        if (sel === "下载 chrome") {
            await this._downloadChrome(url, targetDir);
        } else {
            this.log("用户终止增强流程");
        }
    }

    async _cleanupSavedBrowserPaths() {
        try {
            const savedDedicated = this.context.globalState.get(this.KEY_DEDICATED_BROWSER);
            if (savedDedicated && !fs.existsSync(savedDedicated)) {
                await this.context.globalState.update(this.KEY_DEDICATED_BROWSER, undefined);
            }
        } catch (e) { }

        try {
            const savedCustom = this.context.globalState.get(this.KEY_CUSTOM_BROWSER);
            if (savedCustom && !fs.existsSync(savedCustom)) {
                await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);
            }
        } catch (e) { }
    }

    _psQuote(s) {
        return String(s).replace(/'/g, "''");
    }

    _validateChromiumSilently(exePath) {
        return new Promise((resolve) => {
            if (!exePath || !fs.existsSync(exePath)) {
                resolve({ valid: false, error: '文件不存在' });
                return;
            }

            const platform = process.platform;

            if (platform === 'win32') {
                const p = this._psQuote(exePath);
                const cmd = [
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy', 'Bypass',
                    '-Command',
                    `
$it = Get-Item -LiteralPath '${p}' -ErrorAction Stop;
$vi = $it.VersionInfo;
$pn = $vi.ProductName;
$fd = $vi.FileDescription;
$pv = $vi.ProductVersion;
$fv = $vi.FileVersion;
$of = $vi.OriginalFilename;
"$pn|$fd|$pv|$fv|$of"
                    `.trim()
                ];

                cp.execFile('powershell', cmd, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
                    if (err) {
                        resolve({ valid: false, error: '无法读取版本信息' });
                        return;
                    }

                    const out = String(stdout || '').trim();
                    if (!out) {
                        resolve({ valid: false, error: '版本信息为空' });
                        return;
                    }

                    const parts = out.split('|').map(s => (s || '').trim());
                    const productName = parts[0] || '';
                    const fileDesc = parts[1] || '';
                    const productVersion = parts[2] || '';
                    const fileVersion = parts[3] || '';
                    const originalFilename = parts[4] || '';

                    const text = `${productName} ${fileDesc} ${originalFilename}`.toLowerCase();
                    const isChromiumFamily =
                        text.includes('chrome') ||
                        text.includes('chromium') ||
                        text.includes('edge') ||
                        text.includes('brave') ||
                        text.includes('vivaldi') ||
                        text.includes('opera');

                    const version = productVersion || fileVersion || '';
                    const hasVersion = /\d+\.\d+\.\d+\.\d+/.test(version) || /\d+\.\d+/.test(version);

                    if (isChromiumFamily && hasVersion) {
                        resolve({ valid: true, version: `${productName || 'Chromium'} ${version}`.trim(), raw: out });
                    } else if (isChromiumFamily) {
                        resolve({ valid: true, version: (productName || fileDesc || 'Chromium').slice(0, 80), raw: out });
                    } else {
                        resolve({ valid: false, error: '不是 Chromium 内核浏览器' });
                    }
                });

                return;
            }

            cp.execFile(exePath, ['--version'], { timeout: 8000 }, (err, stdout, stderr) => {
                if (err) {
                    resolve({ valid: false, error: '无法执行 --version' });
                    return;
                }
                const output = ((stdout || '') + (stderr || '')).trim();
                const chromiumPattern = /(Chromium|Chrome|Brave|Edge|Opera|Vivaldi)[\s\/:]*([\d\.]+)/i;
                const match = output.match(chromiumPattern);
                if (match) {
                    resolve({ valid: true, version: `${match[1]} ${match[2]}`, raw: output });
                } else {
                    resolve({ valid: true, version: output.slice(0, 80) || 'Chromium', raw: output });
                }
            });
        });
    }

    _getChromeDownloadInfo() {
        const version = '123.0.6312.4';
        const platform = process.platform;
        const arch = process.arch;

        let platformKey, zipName;

        if (platform === 'win32') {
            platformKey = (arch === 'x64' || arch === 'arm64') ? 'win64' : 'win32';
            zipName = (arch === 'x64' || arch === 'arm64') ? 'chrome-win64.zip' : 'chrome-win32.zip';
        } else if (platform === 'darwin') {
            platformKey = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
            zipName = arch === 'arm64' ? 'chrome-mac-arm64.zip' : 'chrome-mac-x64.zip';
        } else {
            platformKey = 'linux64';
            zipName = 'chrome-linux64.zip';
        }

        return {
            url: `https://cdn.npmmirror.com/binaries/chrome-for-testing/${version}/${platformKey}/${zipName}`,
            version,
            platform: platformKey,
            zipName
        };
    }

    async _downloadChrome(url, targetDir) {
        if (!fs.existsSync(this.chromeHome)) fs.mkdirSync(this.chromeHome, { recursive: true });

        const zipPath = path.join(this.chromeHome, 'chrome.zip');
        const chromeInfo = this._getChromeDownloadInfo();

        this.log(`[Chrome] 下载源: npmmirror (国内)`);
        this.log(`[Chrome] 版本: ${chromeInfo.version}`);
        this.log(`[Chrome] 平台: ${chromeInfo.platform}`);
        this.log(`[Chrome] URL: ${chromeInfo.url}`);
        this.log(`[Chrome] 目标目录: ${this.chromeHome}`);

        let exePath = null;

        exePath = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在下载 Chrome for Testing...",
            cancellable: true
        }, async (progress, token) => {
            let cancelled = false;
            token.onCancellationRequested(() => {
                cancelled = true;
                this.log("[Chrome] 用户取消下载");
            });

            try {
                progress.report({ message: `0% (版本 ${chromeInfo.version})` });

                await this._downloadFile(chromeInfo.url, zipPath, progress, () => cancelled);

                if (cancelled) {
                    try { fs.unlinkSync(zipPath); } catch (e) { }
                    return null;
                }

                progress.report({ message: "解压中..." });

                await this._extractZip(zipPath, this.chromeHome);

                try { fs.unlinkSync(zipPath); } catch (e) { }

                const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
                const foundExe = this._findFileRecursive(this.chromeHome, exeName, 6);

                if (!foundExe) throw new Error("解压完成但找不到 chrome 可执行文件");

                this.log(`[Chrome] 找到: ${foundExe}`);

                if (process.platform === 'darwin' || process.platform === 'linux') {
                    try { cp.execSync(`chmod +x "${foundExe}"`); } catch (e) { }
                }

                const validation = await this._validateChromiumSilently(foundExe);
                if (!validation.valid) throw new Error(`下载的 Chrome 验证失败: ${validation.error}`);

                this.log(`[Chrome] 验证通过: ${validation.version}`);

                return foundExe;

            } catch (e) {
                this.log(`[Chrome] 失败: ${e.message}`);
                vscode.window.showErrorMessage(`下载 Chrome 失败: ${e.message}`);
                return null;
            }
        });

        if (!exePath) return;

        await this._startSniffer(exePath, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
    }

    _downloadFile(url, destPath, progress, isCancelled) {
        return new Promise((resolve, reject) => {
            const doRequest = (currentUrl, redirectCount = 0) => {
                if (redirectCount > 10) return reject(new Error('重定向次数过多'));
                if (isCancelled && isCancelled()) return resolve();

                const protocol = currentUrl.startsWith('https') ? https : require('http');

                protocol.get(currentUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 qqq-vscode-extension' }
                }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        let next = res.headers.location;
                        if (!next.startsWith('http')) {
                            const urlObj = new URL(currentUrl);
                            next = next.startsWith('/')
                                ? `${urlObj.protocol}//${urlObj.host}${next}`
                                : `${urlObj.protocol}//${urlObj.host}${urlObj.pathname.replace(/\/[^\/]*$/, '/')}${next}`;
                        }
                        res.resume();
                        return doRequest(next, redirectCount + 1);
                    }

                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }

                    const total = parseInt(res.headers['content-length'], 10) || 0;
                    let downloaded = 0;
                    let lastUpdate = 0;

                    const dir = path.dirname(destPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                    const file = fs.createWriteStream(destPath);

                    let cancelledMid = false;
                    const cancelNow = () => {
                        if (cancelledMid) return;
                        cancelledMid = true;
                        try { res.destroy(); } catch (e) { }
                        try { file.close(); } catch (e) { }
                        try { fs.unlinkSync(destPath); } catch (e) { }
                        resolve();
                    };

                    res.on('data', (chunk) => {
                        if (isCancelled && isCancelled()) {
                            cancelNow();
                            return;
                        }

                        downloaded += chunk.length;

                        const now = Date.now();
                        if (now - lastUpdate > 200) {
                            lastUpdate = now;
                            if (total > 0) {
                                const percent = Math.round((downloaded * 100) / total);
                                const dlMB = (downloaded / 1024 / 1024).toFixed(1);
                                const totalMB = (total / 1024 / 1024).toFixed(1);
                                progress.report({ message: `${percent}% (${dlMB}/${totalMB} MB)` });
                            } else {
                                progress.report({ message: `${(downloaded / 1024 / 1024).toFixed(1)} MB` });
                            }
                        }
                    });

                    res.on('error', (err) => {
                        if (cancelledMid || (isCancelled && isCancelled())) return resolve();
                        try { file.close(); } catch (e) { }
                        try { fs.unlinkSync(destPath); } catch (e) { }
                        reject(err);
                    });

                    file.on('error', (err) => {
                        if (cancelledMid || (isCancelled && isCancelled())) return resolve();
                        try { file.close(); } catch (e) { }
                        try { fs.unlinkSync(destPath); } catch (e) { }
                        reject(err);
                    });

                    file.on('finish', () => {
                        if (cancelledMid || (isCancelled && isCancelled())) {
                            try { fs.unlinkSync(destPath); } catch (e) { }
                            return resolve();
                        }
                        file.close(() => resolve());
                    });

                    res.pipe(file);
                }).on('error', (err) => {
                    if (isCancelled && isCancelled()) return resolve();
                    try { fs.unlinkSync(destPath); } catch (e) { }
                    reject(err);
                });
            };

            doRequest(url);
        });
    }

    _extractZip(zipPath, destFolder) {
        return new Promise((resolve, reject) => {
            const platform = process.platform;

            if (platform === 'win32') {
                const zp = this._psQuote(zipPath);
                const df = this._psQuote(destFolder);

                const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${zp}' -DestinationPath '${df}' -Force"`;
                cp.exec(cmd, { timeout: 300000, windowsHide: true }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            } else {
                cp.exec(`unzip -o "${zipPath}" -d "${destFolder}"`, { timeout: 300000 }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            }
        });
    }

    _findFileRecursive(dir, fileName, maxDepth = 5, depth = 0) {
        if (depth > maxDepth) return null;
        try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                const full = path.join(dir, f);
                let st;
                try { st = fs.statSync(full); } catch (e) { continue; }

                if (st.isDirectory()) {
                    const found = this._findFileRecursive(full, fileName, maxDepth, depth + 1);
                    if (found) return found;
                } else if (f.toLowerCase() === fileName.toLowerCase()) {
                    return full;
                }
            }
        } catch (e) { }
        return null;
    }

    // ==================== 增强流程：防重复 + 一号/三号体系 ====================

    _looksLikeMaster(url) {
        if (!url) return false;
        const u = String(url);
        return u.includes('.m3u8') || u.includes('.mpd') || u.match(/\.(mp4|webm|mkv|mov)(\?|$)/i);
    }

    _dedupeAndPickBestCapturedVideo(videos) {
        if (!Array.isArray(videos) || videos.length === 0) return null;

        // 1) URL 去重：同 URL 取 priority 更高的那条
        const map = new Map();
        for (const v of videos) {
            if (!v || !v.url) continue;
            const key = String(v.url).trim();
            const old = map.get(key);
            if (!old) {
                map.set(key, v);
            } else {
                const p1 = Number(old.priority || 0);
                const p2 = Number(v.priority || 0);
                if (p2 > p1) map.set(key, v);
            }
        }

        const uniq = Array.from(map.values());

        // 2) 如果有 master 候选：只在 master 里挑一个最优（避免同视频多次下载/合成）
        const masters = uniq.filter(v => this._looksLikeMaster(v.url));
        const pool = masters.length > 0 ? masters : uniq;

        // 3) 按 priority 排序（再按“更像 master”微调）
        pool.sort((a, b) => {
            const pa = Number(a.priority || 0);
            const pb = Number(b.priority || 0);
            if (pb !== pa) return pb - pa;

            const am = this._looksLikeMaster(a.url) ? 1 : 0;
            const bm = this._looksLikeMaster(b.url) ? 1 : 0;
            return bm - am;
        });

        return pool[0] || null;
    }

    _scanRecentBytes(targetDir, sinceMs) {
        let total = 0;
        try {
            if (!fs.existsSync(targetDir)) return 0;
            const files = fs.readdirSync(targetDir);
            for (const f of files) {
                const full = path.join(targetDir, f);
                try {
                    const s = fs.statSync(full);
                    if (!s.isFile()) continue;
                    if (s.mtimeMs >= sinceMs) total += s.size;
                } catch (e) { }
            }
        } catch (e) { }
        return total;
    }

    _findLandedVideoFilesSince(targetDir, sinceMs) {
        const exts = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.wmv', '.flv']);
        const ignoreSuffix = ['.part', '.tmp', '.ytdl', '.download'];

        const out = [];
        try {
            if (!fs.existsSync(targetDir)) return out;
            const files = fs.readdirSync(targetDir);

            for (const f of files) {
                const full = path.join(targetDir, f);
                try {
                    const s = fs.statSync(full);
                    if (!s.isFile()) continue;
                    if (s.mtimeMs < sinceMs) continue;

                    const lower = f.toLowerCase();
                    if (ignoreSuffix.some(x => lower.endsWith(x))) continue;

                    const ext = path.extname(lower);
                    if (!exts.has(ext)) continue;
                    if (s.size <= 0) continue;

                    out.push({ path: full, size: s.size, mtimeMs: s.mtimeMs });
                } catch (e) { }
            }
        } catch (e) { }

        // 按时间排序（更稳定）
        out.sort((a, b) => a.mtimeMs - b.mtimeMs);
        return out.map(x => x.path);
    }

    async _downloadEnhancedOne(url, targetDir, bestVideo) {
        const urlSnippet = url.length > 44 ? url.slice(0, 44) + "..." : url;
        const startMs = Date.now();

        const outcome = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "",
            cancellable: true
        }, async (progress, token) => {
            progress.report({ message: `已交换 0k 于 ${urlSnippet} (增强下载中...)` });

            token.onCancellationRequested(() => {
                this.log("用户取消增强下载弹窗（仅关闭弹窗；不一定能中断底层下载）");
            });

            let timer = null;
            try {
                timer = setInterval(() => {
                    const bytes = this._scanRecentBytes(targetDir, startMs);
                    progress.report({ message: `已交换 ${this._formatBytesSimple(bytes)} 于 ${urlSnippet} (增强下载中...)` });
                }, 500);

                // ✅ 屏蔽 downloader 内部弹窗（那种“成功/失败”）
                await this._runWithSuppressedPopups(async () => {
                    await this.downloader.downloadVideos([bestVideo], targetDir);
                });

            } finally {
                if (timer) {
                    try { clearInterval(timer); } catch (e) { }
                }
            }

            // 给落盘一点点时间（避免 mtime 还没刷完）
            await this._sleep(300);

            const landedFiles = this._findLandedVideoFilesSince(targetDir, startMs);

            let totalBytes = 0;
            for (const p of landedFiles) {
                try { totalBytes += fs.statSync(p).size; } catch (e) { }
            }

            // ✅ 插入：跟普通流程一致（插入所有落盘文件路径）
            const inserted = new Set();
            for (const p of landedFiles) {
                if (inserted.has(p)) continue;
                inserted.add(p);
                try {
                    await this._insertToCursor(path.basename(p), p);
                } catch (e) { }
            }

            return { landedFiles, totalBytes, urlSnippet };
        });

        return outcome;
    }

    async _startSniffer(browserPath, url, targetDir, opts = {}) {
        this.log("启动增强嗅探流程...");
        this.log(`浏览器: ${browserPath}`);
        this.log(`用户数据目录: ${this.userDataDir}`);

        if (!fs.existsSync(this.userDataDir)) fs.mkdirSync(this.userDataDir, { recursive: true });

        let sniffer = null;
        try {
            const CdpSniffer = require('./cdp-sniffer');

            CdpSniffer.setCustomBrowserPath(browserPath);

            if (typeof CdpSniffer.setUserDataDir === 'function') {
                CdpSniffer.setUserDataDir(this.userDataDir);
            }

            sniffer = new CdpSniffer();

            const startOptions = { userDataDir: this.userDataDir };

            await sniffer.start(url, (msg) => this.log(msg), startOptions);

            if (opts.rememberKey) {
                try {
                    await this.context.globalState.update(opts.rememberKey, browserPath);
                    this.log(`[增强] 已写入 globalState: ${opts.rememberKey} = ${browserPath}`);
                } catch (e) {
                    this.log(`[增强] 写入 globalState 失败: ${e.message}`);
                }
            }

            const selection = await vscode.window.showInformationMessage(
                "请在打开的浏览器中播放视频（登录信息会自动保存），完成后点击下方按钮。",
                { modal: true },
                "我已在外部播放"
            );

            if (selection !== "我已在外部播放") {
                try { await sniffer.stop(); } catch (e) { }
                this.log("用户取消增强嗅探");
                return;
            }

            let videos = sniffer.getCapturedVideos();
            await sniffer.stop();

            // ✅ 只关心“主资源”，并做去重 + 只取一个最优（防止重复下载/重复合成）
            const best = this._dedupeAndPickBestCapturedVideo(videos || []);

            if (!best) {
                const msg = `任务结束, 共落盘0个视频共：0k 从 ${url.length > 44 ? url.slice(0, 44) + "..." : url}`;
                this.log(`[增强] 未捕获到可用视频资源`);
                await this._showResultToastTimed(msg, targetDir, null, 6000);
                return;
            }

            // ✅ 补 meta（只传 headers，不传 cookies db 路径）
            if (!best.meta) best.meta = {};
            if (best.headers) {
                best.meta.cookie = best.headers['Cookie'];
                best.meta.referer = best.headers['Referer'];
                best.meta.userAgent = best.headers['User-Agent'];
                best.meta.origin = best.headers['Origin'];
            }

            // ========= 增强下载：一号 + 三号 =========
            const out = await this._downloadEnhancedOne(url, targetDir, best);

            const landedCount = (out?.landedFiles || []).length;
            const totalStr = this._formatBytesSimple(out?.totalBytes || 0);
            const resultMsg = `任务结束, 共落盘${landedCount}个视频共：${totalStr} 从 ${out?.urlSnippet || (url.length > 44 ? url.slice(0, 44) + "..." : url)}`;

            this.log(`[增强 Done] ${resultMsg}`);

            const firstFile = this._pickFirstFileBySize(out?.landedFiles || []);
            await this._showResultToastTimed(resultMsg, targetDir, firstFile, 15000);

        } catch (e) {
            this.log(`增强流程出错: ${e.message}`);
            if (sniffer) {
                try { await sniffer.stop(); } catch (e2) { }
            }
            // ✅ 不再额外弹出失败弹窗，避免噪音；只写日志
        }
    }
}

// 静态字段
VideoDownloadController.__revealCmdRegistered = false;
VideoDownloadController.__revealCmdDisposable = null;
VideoDownloadController.__resultToastCts = null;

module.exports = VideoDownloadController;

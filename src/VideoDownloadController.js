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

    async _fastProcess(url, targetDir) {
        try {
            const urlSnippet = url.length > 44 ? url.slice(0, 44) + "..." : url;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "",
                cancellable: true
            }, async (progress, token) => {
                progress.report({ message: `已下载 0k 从 ${urlSnippet} (正在解析...)` });

                token.onCancellationRequested(() => {
                    this.log("用户取消下载");
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

                // 静态分析
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
                progress.report({ message: `已下载 0k 从 ${urlSnippet}` });

                // 文件名前缀集合
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

                let fileSizeTimer = setInterval(() => {
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
                    progress.report({ message: `已下载 ${totalStr} 从 ${urlSnippet}` });
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
                            this.log(`失败: ${task.url} - ${event.error}`);
                        } else if (event.type === 'retry') {
                            this.log(`重试: ${task.url} (Wait ${event.delayMs}ms)`);
                        }
                    }
                });

                if (fileSizeTimer) clearInterval(fileSizeTimer);

                const results = res.results || [];
                const successResults = results.filter(r => r.success);
                const failResults = results.filter(r => !r.success);

                let verifiedCount = 0;
                let finalTotalBytes = 0;

                for (const r of successResults) {
                    const p = r.path || r.destPath;
                    if (await this._postProcess(p)) {
                        verifiedCount++;
                        if (fs.existsSync(p)) {
                            try { finalTotalBytes += fs.statSync(p).size; } catch (e) { }
                        }
                    }
                }

                const finalTotalStr = this._formatBytesSimple(finalTotalBytes);
                const forbiddenErrors = failResults.filter(r => this._isForbidden(r.code || r.httpStatus, r.error));
                const needEnhanced =
                    forbiddenErrors.length > 0 ||
                    (probeForbidden && verifiedCount === 0) ||
                    (verifiedCount === 0 && successResults.length > 0);

                if (needEnhanced) {
                    await this._handleForbidden(forbiddenErrors[0]?.code || 403, url, targetDir);
                } else {
                    const resultMsg = `任务结束, 共下载${verifiedCount}个视频共：${finalTotalStr} 从 ${urlSnippet}`;
                    this.log(`[Done] ${resultMsg}`);

                    const action = await vscode.window.showInformationMessage(resultMsg, "打开下载文件夹");
                    if (action === "打开下载文件夹") {
                        vscode.env.openExternal(vscode.Uri.file(targetDir));
                    }
                }
            });

        } catch (error) {
            this.log(`处理失败: ${error.message}`);
        }
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

    _formatBytesSimple(bytes) {
        if (bytes === 0) return "0k";
        const k = 1024;
        const m = 1024 * 1024;
        if (bytes >= m) return Math.round(bytes / m) + "m";
        return Math.round(bytes / k) + "k";
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

    _deduplicateTasks(tasks) {
        const seen = new Set();
        return tasks.filter(t => {
            if (!t.url) return false;
            if (seen.has(t.url)) return false;
            seen.add(t.url);
            return true;
        });
    }

    _isForbidden(code, error) {
        return code === 403 || code === 401 || (error && error.toString().includes('403'));
    }

    _sanitizeFilename(title) {
        if (!title) return null;
        let safe = title.replace(/[\\/:*?"<>|]/g, "_");
        safe = safe.replace(/\s+/g, " ").trim();
        if (safe.length > 80) safe = safe.substring(0, 80);
        return safe;
    }

    async _postProcess(filePath) {
        if (!fs.existsSync(filePath)) return false;

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
                        finalPath = path.join(path.dirname(filePath), safeName);
                        try { fs.renameSync(filePath, finalPath); } catch (e) { finalPath = filePath; }
                    } else if (newExt !== ext) {
                        finalPath = filePath.replace(ext, newExt);
                        try { fs.renameSync(filePath, finalPath); } catch (e) { finalPath = filePath; }
                    }

                    await this._insertToCursor(path.basename(finalPath), finalPath);
                    resolve(true);
                } else {
                    this.log(`文件无效 (非视频或损坏)，删除: ${filePath}`);
                    try { fs.unlinkSync(filePath); } catch (e) { }
                    resolve(false);
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

    // ==================== 逻辑 Q：增强流程核心 ====================

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
            vscode.window.showInformationMessage("qqq: 你取消了增强流程。");
        }
    }

    async _runEnhancedPreferSaved(url, targetDir) {
        // ✅ 零代价价值：路径变更检测（不存在就清理，避免脏值冲突）
        await this._cleanupSavedBrowserPaths();

        const dedicated = this.context.globalState.get(this.KEY_DEDICATED_BROWSER);
        if (dedicated && fs.existsSync(dedicated)) {
            const v = await this._validateChromiumSilently(dedicated);
            if (v.valid) {
                this.log(`[增强] 使用已保存专用浏览器: ${dedicated} (${v.version})`);
                await this._startSniffer(dedicated, url, targetDir, { rememberKey: this.KEY_DEDICATED_BROWSER });
                return;
            } else {
                // ✅ 零代价价值：验证失败清理旧 globalState
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
                // ✅ 零代价价值：验证失败清理旧 globalState
                await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);
            }
        }

        // ✅ 都不可用：先弹文件选择；取消/失败 -> “下载 chrome / 终止一切”
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
                vscode.window.showInformationMessage("qqq: 你终止了一切。");
            }
            return;
        }

        const exePath = uris[0].fsPath;
        this.log(`[增强] 用户选择: ${exePath}`);

        // ✅ 只做静默验证：绝不打开 exe（Windows 用版本信息，不执行 exe）
        const validation = await this._validateChromiumSilently(exePath);

        if (validation.valid) {
            this.log(`[增强] 用户浏览器验证通过: ${validation.version}`);
            await this._startSniffer(exePath, url, targetDir, { rememberKey: this.KEY_CUSTOM_BROWSER });
            return;
        }

        // ✅ 零代价价值：验证失败清理旧 globalState（避免下次误用脏值）
        await this.context.globalState.update(this.KEY_CUSTOM_BROWSER, undefined);

        this.log(`[增强] 用户浏览器验证失败: ${validation.error}`);

        const sel = await vscode.window.showErrorMessage(
            `qqq: 该入口文件无效，可选下载chrome（约150m）或终止一切。\n原因: ${validation.error}`,
            "下载 chrome", "终止一切"
        );

        if (sel === "下载 chrome") {
            await this._downloadChrome(url, targetDir);
        } else {
            vscode.window.showInformationMessage("qqq: 你终止了一切。");
        }
    }

    // ✅ 零代价价值：路径变更检测（不存在就清理）
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
        // PowerShell 单引号字符串内部用 '' 表示一个 '
        return String(s).replace(/'/g, "''");
    }

    /**
     * ✅ 静默验证（重点修复）
     * - Windows：用 PowerShell 读取 PE 版本信息（不执行 exe，不会弹窗，不会打开浏览器，不会乱码）
     * - 其他平台：尽量轻量；必要时才 fallback 到 --version
     */
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
                        // 家族像，但版本缺失：也当作有效（避免误杀你说的“正确 exe”）
                        resolve({ valid: true, version: (productName || fileDesc || 'Chromium').slice(0, 80), raw: out });
                    } else {
                        resolve({ valid: false, error: '不是 Chromium 内核浏览器' });
                    }
                });

                return;
            }

            // 非 Windows：尽量不打开 UI，一般 --version 不会起 GUI
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

    /**
     * ✅ 下载专用 Chrome（重点修复：下载/解压/验证弹窗会正常关闭）
     * - withProgress 只做“下载+解压+验证”
     * - ✅ 绝不在 withProgress 里启动 sniffer（否则你说的“解压中... 永不关闭”必现）
     * - 结束后再启动 sniffer
     */
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

        // 只负责下载/解压/验证，结束就关闭通知
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

                // ✅ 解压到 chromeHome（得到 chrome-win64/...）
                await this._extractZip(zipPath, this.chromeHome);

                try { fs.unlinkSync(zipPath); } catch (e) { }

                const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
                const foundExe = this._findFileRecursive(this.chromeHome, exeName, 6);

                if (!foundExe) throw new Error("解压完成但找不到 chrome 可执行文件");

                this.log(`[Chrome] 找到: ${foundExe}`);

                if (process.platform === 'darwin' || process.platform === 'linux') {
                    try { cp.execSync(`chmod +x "${foundExe}"`); } catch (e) { }
                }

                // ✅ 静默验证（不执行 exe）
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

        // ✅ 到这里：进度通知已经必然关闭（因为 withProgress 已 return）
        if (!exePath) return;

        // ✅ 成功后再启动 sniffer（不占用下载弹窗）
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

                // ✅ NoProfile + NonInteractive + timeout：防止“解压中...”卡死
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

    // ==================== 嗅探器（带持久化登录信息） ====================

    async _startSniffer(browserPath, url, targetDir, opts = {}) {
        this.log("启动增强嗅探流程...");
        this.log(`浏览器: ${browserPath}`);
        this.log(`用户数据目录: ${this.userDataDir}`);

        if (!fs.existsSync(this.userDataDir)) fs.mkdirSync(this.userDataDir, { recursive: true });

        let sniffer = null;
        try {
            const CdpSniffer = require('./cdp-sniffer');

            CdpSniffer.setCustomBrowserPath(browserPath);

            // 可选：如果 sniffer 支持，就喂进去（不支持也不会报错）
            if (typeof CdpSniffer.setUserDataDir === 'function') {
                CdpSniffer.setUserDataDir(this.userDataDir);
            }

            sniffer = new CdpSniffer();

            const startOptions = { userDataDir: this.userDataDir };

            // ✅ “执行成功一次”的判定点：sniffer.start 成功返回
            await sniffer.start(url, (msg) => this.log(msg), startOptions);

            // ✅ 成功启动后再写入 globalState
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

            if (selection === "我已在外部播放") {
                let videos = sniffer.getCapturedVideos();
                await sniffer.stop();

                // 智能过滤：检测到主视频时过滤碎片
                const hasMaster = videos.some(r =>
                    (r.priority && r.priority >= 80) ||
                    (r.url && (r.url.includes('.m3u8') ||
                        r.url.includes('.mpd') ||
                        r.url.match(/\.(mp4|webm|mkv|mov)(\?|$)/i)))
                );

                if (hasMaster) {
                    const originalCount = videos.length;
                    videos = videos.filter(r =>
                        (r.priority && r.priority >= 50) ||
                        (r.url && !r.url.match(/\.ts(\?|$)/i) &&
                            !r.url.match(/\.m4s(\?|$)/i) &&
                            !r.url.match(/\.key(\?|$)/i))
                    );
                    this.log(`[Filter] 已过滤碎片文件: ${originalCount} -> ${videos.length}`);
                }

                if (videos.length > 0) {
                    this.log(`捕获到 ${videos.length} 个视频，开始下载...`);

                    // ✅ 关键修复：不要无脑塞 browserProfilePath（会触发 yt-dlp 找 cookies db 并直接失败）
                    // 只传 headers cookie/referer/ua 即可（参考你说“本地 exe 近乎完美”那条路径）
                    videos.forEach(v => {
                        if (!v.meta) v.meta = {};
                        if (v.headers) {
                            v.meta.cookie = v.headers['Cookie'];
                            v.meta.referer = v.headers['Referer'];
                            v.meta.userAgent = v.headers['User-Agent'];
                            v.meta.origin = v.headers['Origin'];
                        }
                        // ❌ 不再强制：v.meta.browserProfilePath = this.userDataDir;
                        // 如果未来你想启用 cookies db，也必须先检测 DB 是否存在再赋值（否则必炸）。
                    });

                    await this.downloader.downloadVideos(videos, targetDir);
                } else {
                    vscode.window.showErrorMessage("未能捕获到视频。请重试并确保视频已开始播放。");
                }
            } else {
                await sniffer.stop();
                vscode.window.showInformationMessage("已取消增强流程。");
            }

        } catch (e) {
            this.log(`增强流程出错: ${e.message}`);
            if (sniffer) {
                try { await sniffer.stop(); } catch (e2) { }
            }
            vscode.window.showErrorMessage(`增强流程出错: ${e.message}`);
        }
    }
}

module.exports = VideoDownloadController;

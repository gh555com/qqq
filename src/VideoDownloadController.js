const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const h = require('./h');
const { getSharedDownloader, isPlatformOrSegmentVideo } = require('./dow');
const https = require('https');

class VideoDownloadController {
    constructor(context) {
        this.context = context;
        this.downloader = getSharedDownloader();
        this.outputChannel = vscode.window.createOutputChannel("qqq: Video Downloader");
    }

    log(msg) {
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
    }

    async start() {
        // 0. 确保 yt-dlp 可用
        await this.downloader.ensureYtdlpReady(this.context);

        // 1. 获取URL
        const url = await vscode.window.showInputBox({
            prompt: "直接粘贴 [ 包含视频滴网址 ] ",
            ignoreFocusOut: true,
            placeHolder: "https://..."
        });
        if (!url) return;

        // 2. 确定目标目录
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("请先打开一个文档以便插入视频。");
            return;
        }
        const currentDocDir = path.dirname(editor.document.uri.fsPath);
        const targetDir = path.join(currentDocDir, "qqq");
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        this.log(`开始处理: ${url}`);
        this.outputChannel.show(true);

        // 3. 极速嗅探与下载
        await this._fastProcess(url, targetDir);
    }

    async _fastProcess(url, targetDir) {
        try {
            this.log("正在智能嗅探资源...");
            let tasks = [];

            // 1. 尝试使用 yt-dlp 探测 (涵盖了 平台视频 和 普通视频的 yt-dlp 支持)
            // yt-dlp 能够处理 playlist，也能提取大部分网站的视频信息
            let probeSuccess = false;
            try {
                // 注意：dow.js 的 probe 目前是深度探测 (--no-flat-playlist)，能获取详细列表
                const res = await this.downloader.probe(url);

                if (res && res.success) {
                    probeSuccess = true;
                    if (res.isPlaylist && res.entries && res.entries.length > 0) {
                        this.log(`识别为列表，共 ${res.entries.length} 个视频。`);
                        tasks = res.entries.map(e => this._createTask(e.url || e.webpage_url, e.title, targetDir, url));
                    } else {
                        // 单个视频
                        this.log(`识别为单个视频: ${res.title}`);
                        tasks.push(this._createTask(res.url || res.webpageUrl || url, res.title, targetDir, url));
                    }
                } else {
                    // Probe 失败 (可能是 403，也可能是 yt-dlp 不支持该站点)
                    if (this._isForbidden(403, res?.error)) {
                        this.log("探测返回 403，尝试直接加入下载队列以触发增强流程。");
                        // 这是一个策略：如果探测 403，我们直接把原 URL 当作一个任务去下载。
                        // downloadAll 内部也会尝试 yt-dlp，如果再次 403，就会在结果中体现，从而触发 handleForbidden。
                        tasks.push(this._createTask(url, null, targetDir, url));
                    } else {
                        this.log(`yt-dlp 探测未发现资源或不支持: ${res?.error}`);
                    }
                }
            } catch (e) {
                this.log(`yt-dlp 探测异常: ${e.message}`);
            }

            // 2. 静态分析 (作为补充，仅当 yt-dlp 没找到东西，或者我们想通过网页分析找到更多非平台资源时)
            // 如果 yt-dlp 已经找到了列表，通常就不需要静态分析了，除非为了“宁滥勿缺”
            // 用户的指令是 "智能多层 嗅探该网址存在滴一切视频... 找到一个下载一个"
            // 所以我们可以把静态分析的结果也加进去，去重即可。
            try {
                const webUrls = await h.extractVideoUrlsFromWebPage(url);
                if (webUrls && webUrls.length > 0) {
                    this.log(`静态分析发现 ${webUrls.length} 个资源链接。`);
                    webUrls.forEach(u => tasks.push(this._createTask(u, 'Web Resource', targetDir, url)));
                }
            } catch (e) { }

            // 3. 去重
            tasks = this._deduplicateTasks(tasks);

            // 4. 兜底：如果啥都没找到，把原 URL 当作任务试一把 (Blind Download)
            if (tasks.length === 0) {
                this.log("未探测到明确资源，尝试直接下载原链接...");
                tasks.push(this._createTask(url, 'Direct Link', targetDir, url));
            }

            this.log(`准备下载 ${tasks.length} 个任务...`);

            // 5. 批量并行下载 (调用 dow.js 的 downloadAll，利用其内部并发控制)
            const res = await this.downloader.downloadAll(tasks, targetDir, {
                downloadVideos: "all", // 允许 yt-dlp
                report: (msg) => this.log(msg.message)
            });

            // 6. 处理结果
            const results = res.results || [];
            const successResults = results.filter(r => r.success);
            const failResults = results.filter(r => !r.success);

            this.log(`下载完成: 成功 ${successResults.length}, 失败 ${failResults.length}`);

            // 后处理成功的文件 (验证、改名、插入)
            for (const r of successResults) {
                await this._postProcess(r.path || r.destPath);
            }

            // 检查是否有 403 错误需要触发增强流程
            // 只要有一个任务因为 403 失败，就触发增强流程 (针对该 URL)
            const forbiddenErrors = failResults.filter(r => this._isForbidden(r.code || r.httpStatus, r.error));
            if (forbiddenErrors.length > 0) {
                this.log("检测到 403 拒绝，启动增强流程处理...");
                await this._handleForbidden(forbiddenErrors[0].code || 403, url, targetDir);
            }

        } catch (error) {
            vscode.window.showErrorMessage(`处理失败: ${error.message}`);
        }
    }

    _createTask(videoUrl, title, targetDir, referer) {
        let destPath = null;
        if (title && title !== 'Direct Link' && title !== 'Web Resource') {
            const safeTitle = this._sanitizeFilename(title);
            if (safeTitle) {
                destPath = path.join(targetDir, safeTitle + ".mp4");
            }
        }
        return {
            url: videoUrl,
            destPath: destPath, // null 让 dow.js 自动生成
            kind: "video",
            baseDir: targetDir,
            headers: {
                "Referer": referer,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
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

    // 针对平台视频的直接下载：让 yt-dlp 处理一切 (合并、文件名、Temp文件等)
    // 兼容旧代码调用，实际上 _fastProcess 已经覆盖了它的功能，但保留以防万一
    async _downloadDirect(url, targetDir) {
        // 复用 _fastProcess 的逻辑，因为现在 _fastProcess 已经足够智能且支持并行
        return this._fastProcess(url, targetDir);
    }

    // _downloadOne 已经不再需要，被 downloadAll 批量调用取代

    async _postProcess(filePath) {
        if (!fs.existsSync(filePath)) return;

        this.log(`正在验证文件: ${path.basename(filePath)}`);

        // 获取 ffmpeg 路径 (避免循环依赖 qqq.js)
        let ffmpeg = 'ffmpeg';
        if (this.downloader.ytdlp && this.downloader.ytdlp.ffmpegPath) {
            ffmpeg = this.downloader.ytdlp.ffmpegPath;
        }

        const args = ['-i', filePath];

        return new Promise((resolve) => {
            const proc = cp.spawn(ffmpeg, args);
            let stderr = '';
            proc.stderr.on('data', d => stderr += d.toString());

            proc.on('close', async (code) => {
                const isVideo = stderr.includes('Video:') || stderr.includes('Audio:');
                const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);

                if (isVideo && durationMatch) {
                    const currentName = path.basename(filePath);
                    const ext = path.extname(filePath).toLowerCase();
                    let finalPath = filePath;

                    // 1. 检查文件名长度
                    const isTooLong = currentName.length > 100;

                    // 2. 检查后缀名修正
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

                    // 插入暗号
                    const fileName = path.basename(finalPath);
                    await this._insertToCursor(fileName, finalPath);
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
        let relPath = path.relative(docDir, fullPath);

        // 强制使用 / 作为分隔符
        relPath = relPath.replace(/\\/g, '/');

        // 暗号格式: /\qqq/filename\/
        const snippet = `/\\${relPath}\\/\n`;

        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, snippet);
        });
    }

    async _handleForbidden(code, url, targetDir) {
        // 用户反馈：左右按钮反了。
        // 要求：左边 "选择类似..."，右边 "启动增强..." (默认)
        // 调整顺序以匹配用户预期的视觉顺序。
        const selection = await vscode.window.showInformationMessage(
            `qqq: 被拒绝，返回 ${code}，当前可尝试启动增强流程。`,
            { modal: false },
            "🚀启动增强流程",
            "选择类似 chrome.exe 滴浏览器入口文件"
        );

        if (!selection || selection === "🚀启动增强流程") {
            await this._runEnhancedFlow(url, targetDir);
        } else if (selection === "选择类似 chrome.exe 滴浏览器入口文件") {
            await this._promptForBrowser(url, targetDir);
        }
    }

    async _runEnhancedFlow(url, targetDir) {
        let browserPath = this.context.globalState.get('customBrowserPath');
        const ownChromePath = path.join(this.context.globalStorageUri.fsPath, 'gh555.qqq', 'chrome-win', 'chrome.exe');

        // 优先检查已下载的专用 Chrome
        if (fs.existsSync(ownChromePath)) {
            browserPath = ownChromePath;
        }

        if (browserPath && fs.existsSync(browserPath)) {
            if (await this._validateBrowser(browserPath)) {
                await this._startSniffer(browserPath, url, targetDir);
                return;
            }
        }

        await this._promptForBrowser(url, targetDir);
    }

    async _promptForBrowser(url, targetDir) {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: { 'Executables': ['exe'] },
            title: "请选择类似 chrome.exe 滴浏览器入口文件"
        });

        if (uris && uris.length > 0) {
            const exePath = uris[0].fsPath;
            if (await this._validateBrowser(exePath)) {
                await this.context.globalState.update('customBrowserPath', exePath);
                await this._startSniffer(exePath, url, targetDir);
            } else {
                const sel = await vscode.window.showErrorMessage(
                    "qqq: 该入口文件无效，可选下载chrome（约150m）或终止增强流程。",
                    "下载 chrome", "终止一切"
                );

                if (sel === "下载 chrome") {
                    await this._downloadChrome(url, targetDir);
                } else {
                    vscode.window.showInformationMessage("qqq: 你取消了增强流程。");
                }
            }
        } else {
            vscode.window.showInformationMessage("qqq: 你取消了增强流程。");
        }
    }

    async _validateBrowser(exePath) {
        return new Promise(resolve => {
            const check = cp.spawn(exePath, ['--version']);
            check.on('error', () => resolve(false));
            check.on('close', code => resolve(code === 0));
        });
    }

    async _downloadChrome(url, targetDir) {
        const destFolder = path.join(this.context.globalStorageUri.fsPath, 'gh555.qqq');
        if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });

        const zipPath = path.join(destFolder, 'chrome.zip');
        // 使用一个稳定的 ungoogled-chromium Windows 版本
        const chromeUrl = "https://github.com/ungoogled-software/ungoogled-chromium-binaries/releases/download/120.0.6099.109-1/ungoogled-chromium_120.0.6099.109-1.1_windows_x64.zip";

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在下载专用 Chrome...",
            cancellable: false
        }, async (progress) => {
            try {
                await this._downloadFileNative(chromeUrl, zipPath, progress);
                progress.report({ message: "解压中..." });

                // 使用 PowerShell 解压 (Windows 内置)
                const psCommand = `Expand-Archive -Path "${zipPath}" -DestinationPath "${destFolder}" -Force`;
                await new Promise((resolve, reject) => {
                    cp.exec(`powershell -Command "${psCommand}"`, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                // 查找解压后的 chrome.exe
                const findExe = (dir) => {
                    const files = fs.readdirSync(dir);
                    for (const f of files) {
                        const full = path.join(dir, f);
                        if (fs.statSync(full).isDirectory()) {
                            const res = findExe(full);
                            if (res) return res;
                        } else if (f === 'chrome.exe') {
                            return full;
                        }
                    }
                    return null;
                };

                const exePath = findExe(destFolder);
                if (exePath) {
                    await this._startSniffer(exePath, url, targetDir);
                } else {
                    throw new Error("Cannot find chrome.exe in downloaded archive");
                }

            } catch (e) {
                vscode.window.showErrorMessage(`下载 Chrome 失败: ${e.message}`);
            }
        });
    }

    _downloadFileNative(url, destPath, progress) {
        return new Promise((resolve, reject) => {
            const request = (currentUrl) => {
                https.get(currentUrl, (response) => {
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        request(response.headers.location);
                        return;
                    }
                    if (response.statusCode !== 200) {
                        reject(new Error(`Failed to download: Status Code ${response.statusCode}`));
                        return;
                    }
                    const total = parseInt(response.headers['content-length'], 10);
                    let downloaded = 0;
                    const file = fs.createWriteStream(destPath);
                    response.pipe(file);
                    response.on('data', (chunk) => {
                        downloaded += chunk.length;
                        if (total) {
                            const percent = Math.round((downloaded * 100) / total);
                            progress.report({ message: `${percent}%` });
                        }
                    });
                    file.on('finish', () => { file.close(resolve); });
                    file.on('error', (err) => { fs.unlink(destPath, () => reject(err)); });
                }).on('error', (err) => { fs.unlink(destPath, () => reject(err)); });
            };
            request(url);
        });
    }

    async _startSniffer(browserPath, url, targetDir) {
        this.log("启动增强嗅探流程...");

        let sniffer = null;
        try {
            const CdpSniffer = require('./cdp-sniffer');
            CdpSniffer.setCustomBrowserPath(browserPath);

            sniffer = new CdpSniffer();

            // 1. 启动浏览器
            await sniffer.start(url, (msg) => this.log(msg));

            // 2. 弹出模态框等待用户确认
            const selection = await vscode.window.showInformationMessage(
                "请在打开的浏览器中播放视频，完成后点击下方按钮。",
                { modal: true },
                "我已在外部播放"
            );

            // 3. 用户确认后，提取结果并关闭浏览器
            if (selection === "我已在外部播放") {
                const videos = sniffer.getCapturedVideos();
                await sniffer.stop();

                if (videos.length > 0) {
                    this.log(`捕获到 ${videos.length} 个视频，开始下载...`);
                    const downloadPromises = videos.map(v => this._downloadOne(v, targetDir, url));
                    await Promise.all(downloadPromises);
                } else {
                    vscode.window.showErrorMessage("未能捕获到视频。请重试并确保视频已开始播放。");
                }
            } else {
                await sniffer.stop();
                vscode.window.showInformationMessage("已取消增强流程。");
            }

        } catch (e) {
            this.log(`增强流程出错: ${e.message}`);
            if (sniffer) await sniffer.stop();
        }
    }

    _deduplicate(videos) {
        const seen = new Set();
        return videos.filter(v => {
            if (!v.url) return false;
            if (seen.has(v.url)) return false;
            seen.add(v.url);
            return true;
        });
    }
}

module.exports = VideoDownloadController;

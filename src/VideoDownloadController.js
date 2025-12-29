const vscode = require('vscode');
const h = require('./h');
const { getSharedDownloader } = require('./dow');

class VideoDownloadController {
    constructor(context) {
        this.context = context;
        this.downloader = getSharedDownloader();
    }

    async start() {
        // 1. 获取URL
        const url = await h.promptForUrl("请输入包含视频的网页URL");
        if (!url) return;

        // 2. 确保 yt-dlp 就绪
        if (!await this.downloader.ensureYtdlpReady(this.context)) return;

        // 3. 选择下载目录
        const targetDir = await h.pickTargetDirectory();
        if (!targetDir) return;

        // 4. 执行探测和下载流程
        await this.runProbeAndDownload(url, targetDir);
    }

    async _sniffFromBrowser(url, progress) {
        let sniffer = null;
        // 创建或获取输出面板
        if (!this.snifferOutput) {
            this.snifferOutput = vscode.window.createOutputChannel("Video Sniffer Log");
        }
        this.snifferOutput.show(true); // 自动显示面板
        this.snifferOutput.clear();
        this.snifferOutput.appendLine(`[System] 正在启动嗅探器... 目标: ${url}`);

        try {
            const CdpSniffer = require('./cdp-sniffer');

            // 尝试恢复持久化的浏览器路径
            if (!CdpSniffer.getCustomBrowserPath()) {
                const savedPath = this.context.globalState.get('customBrowserPath');
                if (savedPath) {
                    if (await CdpSniffer.validateBrowserPath(savedPath)) {
                        CdpSniffer.setCustomBrowserPath(savedPath);
                    } else {
                        this.context.globalState.update('customBrowserPath', undefined);
                    }
                }
            }

            sniffer = new CdpSniffer();

            // 1. 非阻塞启动浏览器
            if (progress) progress.report({ message: "正在启动专用浏览器...", increment: 0 });

            // 启动时挂载日志回调
            await sniffer.start(url, (msg) => {
                this.snifferOutput.appendLine(msg);
            });

            // 2. 弹窗等待用户确认 (非 Modal，右下角)
            // 启动一个定时器，在用户点确认之前，每秒检查一次是否有结果
            let isWaiting = true;
            let capturedResult = null;

            // 后台轮询检查
            const checkTimer = setInterval(() => {
                if (!isWaiting) {
                    clearInterval(checkTimer);
                    return;
                }
                sniffer.getLatestCapture().then((latest) => {
                    if (!isWaiting) return;
                    if (latest) {
                        capturedResult = latest;
                        if (progress) progress.report({ message: "✅ 已检测到视频流！请点击右下角【确认】开始下载", increment: 0 });
                    }
                }).catch(() => { /* ignore */ });
            }, 1000);

            // 使用 modal: true 确保弹窗是模态的，并且显示所有按钮
            const selection = await vscode.window.showInformationMessage(
                "专用浏览器已启动。请在其中播放视频。一旦检测到播放，系统会自动提示。",
                { modal: true },
                "✅ 我已播放，开始下载",
                "取消"
            );

            isWaiting = false;
            clearInterval(checkTimer);

            if (selection !== "✅ 我已播放，开始下载") {
                // 用户取消
                sniffer.stop();
                return [];
            }

            // 3. 用户确认后，提取结果
            // 如果轮询已经抓到了，直接用；否则再抓一次
            // 增加兜底：尝试注入 JS 获取
            let result = capturedResult || await sniffer.getLatestCapture(true);
            sniffer.stop(); // 停止嗅探

            if (result) {
                if (result.url) {
                    h.log(`[Controller] 用户确认，获取到结果: ${result.url}`);
                    this.snifferOutput.appendLine(`[Success] 最终捕获: ${result.url}`);
                } else {
                    h.log(`[Controller] 用户确认，但结果对象缺少 url 字段`);
                    this.snifferOutput.appendLine(`[Warn] 捕获到结果对象，但缺少 url 字段`);
                }

                // 尝试补充元数据 (Duration, Resolution)
                try {
                    if (progress) progress.report({ message: "正在解析视频元数据...", increment: 5 });
                    const probeRes = await this.downloader.probe(result.url);
                    if (probeRes && probeRes.success) {
                        const meta = probeRes.isPlaylist && probeRes.entries ? probeRes.entries[0] : probeRes;
                        if (meta) {
                            result.duration = meta.duration;
                            result.resolution = meta.resolution || (meta.width && meta.height ? `${meta.width}x${meta.height}` : null);
                            // 如果嗅探没拿到大小，尝试用 probe 的
                            if (!result.filesize) result.filesize = meta.filesize || meta.filesize_approx;

                            this.snifferOutput.appendLine(`[Metadata] 时长: ${result.duration}s, 分辨率: ${result.resolution}, 大小: ${result.filesize}`);
                        }
                    }
                } catch (e) {
                    this.snifferOutput.appendLine(`[Metadata] 元数据解析失败: ${e.message}`);
                }

                // 打印最终透传的 Headers，方便调试 403 问题
                if (result.headers) {
                    this.snifferOutput.appendLine(`[Headers] Cookie: ${result.headers['Cookie'] ? 'Yes' : 'No'}, Referer: ${result.headers['Referer'] || 'None'}, Origin: ${result.headers['Origin'] || 'None'}`);
                }

                if (progress) progress.report({ message: "捕获成功，准备下载...", increment: 10 });
                return [{
                    title: "浏览器嗅探结果",
                    description: "通过浏览器自动捕获",
                    url: result.url,
                    duration: result.duration,
                    filesize: result.filesize,
                    resolution: result.resolution,
                    _meta: {
                        cookieSource: 'custom',
                        referer: result.headers ? result.headers['Referer'] : undefined,
                        userAgent: result.headers ? result.headers['User-Agent'] : undefined,
                        cookie: result.headers ? result.headers['Cookie'] : undefined,
                        origin: result.headers ? result.headers['Origin'] : undefined, // 传递 Origin
                        browserProfilePath: result.userDataDir // 传递浏览器配置路径
                    }
                }];
            } else {
                h.log(`[Controller] 用户确认，但未获取到结果`); // 兜底日志
                this.snifferOutput.appendLine(`[Error] 用户点击确认，但未能提取到有效视频流。`);

                // 尝试 dump 最近的几条捕获（如果有的话，可能是被过滤掉的？）
                // 但 sniffer.capturedVideos 只存符合条件的。
                // 我们在 onLog 里已经打印了所有相关的。

                vscode.window.showErrorMessage("未检测到视频流。请检查【Video Sniffer Log】面板查看是否有相关请求被拦截。");
                return [];
            }

        } catch (e) {
            if (sniffer) sniffer.stop();
            const msg = e.message || '';
            const CdpSniffer = require('./cdp-sniffer');

            if (msg.includes('未找到 Chrome 或 Edge')) {
                const choice = await vscode.window.showErrorMessage(
                    `启动专用浏览器失败：系统路径中未找到 Chrome/Edge。请手动指定浏览器可执行文件(.exe)的位置。`,
                    "📂 手动选择浏览器"
                );

                if (choice === "📂 手动选择浏览器") {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: { 'Executables': ['exe'], 'Applications': ['app'] },
                        title: "请选择 Chrome 或 Edge 的启动文件 (chrome.exe / msedge.exe)"
                    });

                    if (uris && uris.length > 0) {
                        const exePath = uris[0].fsPath;
                        if (await CdpSniffer.validateBrowserPath(exePath)) {
                            CdpSniffer.setCustomBrowserPath(exePath);
                            await this.context.globalState.update('customBrowserPath', exePath);
                            vscode.window.showInformationMessage(`路径已保存，正在重试...`);
                            return this._sniffFromBrowser(url, progress); // 递归重试
                        } else {
                            vscode.window.showErrorMessage(`验证失败：选择的文件不是有效的浏览器程序。`);
                        }
                    }
                }
            } else {
                vscode.window.showErrorMessage(`浏览器嗅探失败: ${msg}`);
            }
        }
        return [];
    }

    async runProbeAndDownload(url, targetDir) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "视频下载任务",
            cancellable: true
        }, async (progress, token) => {
            try {
                // --- 阶段 1: 智能探测 ---
                progress.report({ message: "正在智能探测视频资源...", increment: 10 });

                let candidates = [];
                let probeErrors = [];

                // 策略 A: 直接使用 yt-dlp 探测 URL
                try {
                    const res = await this.downloader.probe(url);
                    if (res.success) {
                        candidates.push(...this._normalizeProbeResult(res));
                    } else {
                        probeErrors.push(`yt-dlp直连失败: ${res.error}`);
                    }
                } catch (e) {
                    probeErrors.push(`yt-dlp异常: ${e.message}`);
                }

                if (token.isCancellationRequested) return;

                // 策略 B: 如果 yt-dlp 失败或返回为空，尝试网页解析 (递归嗅探)
                // 针对类似 gazeta.ru 这种新闻页，视频往往在 iframe 里
                if (candidates.length === 0) {
                    progress.report({ message: "尝试深度网页解析...", increment: 20 });
                    try {
                        const webVideoUrls = await h.extractVideoUrlsFromWebPage(url);
                        if (webVideoUrls && webVideoUrls.length > 0) {
                            // 对提取到的每个潜在视频URL，再次尝试用 yt-dlp 确认
                            // 限制并发数为 3，避免卡死
                            const validVideos = [];
                            await this._batchProbe(webVideoUrls, 3, (v) => validVideos.push(v), progress);
                            candidates.push(...validVideos);
                        }
                    } catch (e) {
                        probeErrors.push(`网页解析失败: ${e.message}`);
                    }
                }

                if (token.isCancellationRequested) return;

                // --- 阶段 2: 用户选择 ---
                if (candidates.length === 0) {
                    const detailMsg = probeErrors.join('; ');

                    // 检查是否为 Cloudflare/403/Unsupported 错误
                    const isAntiBot = probeErrors.some(e =>
                        e.includes("403") ||
                        e.includes("Cloudflare") ||
                        e.includes("Unsupported URL") ||
                        e.includes("Sign in")
                    );

                    if (isAntiBot) {
                        // 发现反爬虫，直接无感切换到强力模式，不再弹窗询问
                        // 用户只会看到浏览器的启动和随后的“确认”弹窗，流程更加连贯
                        const sniffed = await this._sniffFromBrowser(url, progress);
                        if (sniffed && sniffed.length > 0) {
                            candidates.push(...sniffed);
                        } else {
                            // 强力模式用户手动取消或失败
                            return;
                        }
                    } else {
                        vscode.window.showErrorMessage(`未找到可下载视频。详情: ${detailMsg}`);
                        return;
                    }
                }

                // 去重
                const uniqueCandidates = this._deduplicateVideos(candidates);

                progress.report({ message: "等待用户选择...", increment: 40 });
                const selected = await this._promptUserSelection(uniqueCandidates);
                if (selected && selected.length > 0) {
                    // 兜底：如果是直接下载没经过列表选择，确保元数据存在
                    if (uniqueCandidates.length === 1 && selected[0] && !selected[0]._meta) {
                        selected[0]._meta = uniqueCandidates[0]._meta;
                    }

                    if (token.isCancellationRequested) return;

                    // --- 阶段 3: 执行下载 ---
                    // 针对强力反爬虫网站（如 sex.com, missav 等），即便获取到了链接，
                    // 如果直接下载失败，也尝试回退到强力模式重新获取一次
                    // 或者在这里捕获下载失败，引导进入强力模式？
                    // 现在的逻辑是：如果 probe 阶段就失败，直接进强力模式（上面已修改）。
                    // 如果 probe 成功了（比如解析出了 m3u8），但下载阶段失败（403），
                    // 我们需要在 downloadVideos 里处理，或者在这里捕获。

                    // 但 VideoDownloadController 并没有直接捕获 downloadVideos 的每个结果。
                    // 我们可以修改 downloadVideos 的调用方式。

                    const dlResults = await this.downloader.downloadVideos(
                        Array.isArray(selected) ? selected : [selected],
                        targetDir,
                        progress
                    );

                    // 检查下载结果
                    const failed403 = dlResults.results.filter(r => !r.success && (
                        String(r.error).includes('403') ||
                        String(r.error).includes('Forbidden') ||
                        String(r.error).includes('HTTP Error')
                    ));

                    if (failed403.length > 0) {
                        // 下载阶段遇到 403，也直接无感切换到强力模式重试
                        // 弹窗提示一下，给用户一个心理预期，但不需要用户做选择题
                        const retryAction = await vscode.window.showWarningMessage(
                            `检测到下载权限不足(403)，准备启动专用浏览器辅助验证...`,
                            "🚀 启动验证", "取消任务"
                        );

                        if (retryAction === "🚀 启动验证") {
                            for (const failTask of failed403) {
                                const sniffed = await this._sniffFromBrowser(failTask.url, progress);
                                if (sniffed && sniffed.length > 0) {
                                    await this.downloader.downloadVideos(
                                        sniffed,
                                        targetDir,
                                        progress
                                    );
                                }
                            }
                        }
                    }
                }

            } catch (err) {
                vscode.window.showErrorMessage(`任务执行出错: ${err.message}`);
            }
        });
    }

    async _pollForProbeSuccess(url, progress, token) {
        const maxAttempts = 12; // 12 * 5s = 60s
        const intervalMs = 5000;

        for (let i = 1; i <= maxAttempts; i++) {
            if (token.isCancellationRequested) return null;

            progress.report({ message: `正在等待浏览器验证通过 (尝试 ${i}/${maxAttempts})...`, increment: 0 });

            try {
                // 每次尝试都进行探测
                // 注意：底层 dow.js 的 probe 已经包含了 Cookie 重试逻辑
                const res = await this.downloader.probe(url);
                if (res.success) {
                    return res;
                }
            } catch (e) {
                // 忽略错误，继续轮询
            }

            // 等待下一次
            await new Promise(r => setTimeout(r, intervalMs));
        }
        return null;
    }

    _normalizeProbeResult(res) {
        if (!res.success) return [];

        // 提取元数据
        const meta = {
            cookieSource: res.cookieSource,
            referer: res.webpageUrl || res.url // 优先使用网页 URL 作为 Referer
        };

        if (res.isPlaylist) {
            return res.entries.map(e => ({
                title: e.title || `Video ${e.id}`,
                url: e.url || e.webpage_url,
                pageUrl: res.webpageUrl || e.webpage_url, // 记录原始页面URL作为Referer
                duration: e.duration,
                thumbnail: e.thumbnail,
                is_direct: false,
                // 将元数据附加到每个视频对象上
                _meta: meta
            }));
        } else {
            return [{
                title: res.title || "未知标题视频",
                url: res.url || res.webpageUrl,
                pageUrl: res.webpageUrl || res.url, // 记录原始页面URL作为Referer
                duration: res.duration,
                thumbnail: res.thumbnail,
                is_direct: false,
                _meta: meta
            }];
        }
    }

    async _batchProbe(urls, concurrency, onValid, progress) {
        const queue = [...urls];
        let active = 0;
        let completed = 0;
        const total = urls.length;

        return new Promise((resolve) => {
            const next = async () => {
                if (queue.length === 0 && active === 0) {
                    resolve();
                    return;
                }

                while (active < concurrency && queue.length > 0) {
                    const u = queue.shift();
                    active++;

                    // 只有当URL看起来像视频文件或知名平台时才深入探测，避免浪费时间
                    // 但为了最大兼容性，这里我们稍微放宽，或者信任 extractVideoUrlsFromWebPage 的结果

                    this.downloader.probe(u).then(res => {
                        if (res.success) {
                            const items = this._normalizeProbeResult(res);
                            items.forEach(onValid);
                        } else {
                            // 如果 yt-dlp 失败，但 url 结尾是 .mp4 等，可以直接当作直链
                            if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(u)) {
                                onValid({
                                    title: path.basename(u).split('?')[0] || "直接链接视频",
                                    url: u,
                                    is_direct: true
                                });
                            }
                        }
                    }).catch(() => { }).finally(() => {
                        active--;
                        completed++;
                        if (progress) progress.report({ message: `深度分析中 ${completed}/${total}...`, increment: 0 });
                        next();
                    });
                }
            };
            next();
        });
    }

    _deduplicateVideos(videos) {
        const seen = new Set();
        return videos.filter(v => {
            if (!v.url) return false;
            if (seen.has(v.url)) return false;
            seen.add(v.url);
            return true;
        });
    }

    _formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const pad = (n) => n.toString().padStart(2, '0');
        if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
        return `${m}:${pad(s)}`;
    }

    _formatSize(bytes) {
        if (!bytes || isNaN(bytes)) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let i = 0;
        while (size >= 1024 && i < units.length - 1) {
            size /= 1024;
            i++;
        }
        return `${size.toFixed(1)} ${units[i]}`;
    }

    async _promptUserSelection(videos) {
        if (videos.length === 1) {
            const v = videos[0];
            const metaParts = [];
            if (v.duration) metaParts.push(this._formatDuration(v.duration));
            if (v.filesize) metaParts.push(this._formatSize(v.filesize));
            if (v.resolution) metaParts.push(v.resolution);

            const metaStr = metaParts.length > 0 ? `(${metaParts.join(', ')})` : '';

            const choice = await vscode.window.showInformationMessage(
                `发现视频: ${v.title} ${metaStr}`,
                "立即下载", "取消"
            );
            return choice === "立即下载" ? [v] : null;
        }

        const items = videos.map((v, i) => {
            const metaParts = [];
            if (v.duration) metaParts.push(this._formatDuration(v.duration));
            if (v.filesize) metaParts.push(this._formatSize(v.filesize));
            if (v.resolution) metaParts.push(v.resolution);

            return {
                label: `$(device-camera-video) ${v.title}`,
                description: metaParts.join(' | '),
                detail: v.url,
                video: v,
                picked: true
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: `检测到 ${videos.length} 个视频，请选择要下载的项目`,
            matchOnDetail: true
        });

        return selected ? selected.map(x => x.video) : null;
    }
}

module.exports = VideoDownloadController;

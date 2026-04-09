const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const h = require('./h');
// const WebSocket = require('ws'); // 移除对 ws 的依赖，改用内置实现

// 一个极其精简的 WebSocket 客户端实现，仅支持 CDP 通信
class SimpleWebSocket {
    constructor(url) {
        this.url = url;
        this.listeners = { open: [], message: [], error: [] };
        this.socket = null;
        this.connect();
    }

    on(event, cb) {
        if (this.listeners[event]) this.listeners[event].push(cb);
    }

    send(data) {
        if (this.socket) {
            // 简单的 WebSocket 帧封装 (Masked)
            const payload = Buffer.from(data);
            const length = payload.length;
            let frame;

            // 构造帧头
            let headerLen = 2;
            if (length <= 125) {
                // headerLen = 2
            } else if (length <= 65535) {
                headerLen = 4;
            } else {
                headerLen = 10;
            }

            frame = Buffer.alloc(headerLen + 4 + length); // +4 for mask key

            frame[0] = 0x81; // FIN + Text

            if (length <= 125) {
                frame[1] = 0x80 | length; // Masked + len
            } else if (length <= 65535) {
                frame[1] = 0x80 | 126;
                frame.writeUInt16BE(length, 2);
            } else {
                frame[1] = 0x80 | 127;
                frame.writeBigUInt64BE(BigInt(length), 2);
            }

            // Mask key (random)
            const mask = Buffer.alloc(4);
            require('crypto').randomFillSync(mask);
            mask.copy(frame, headerLen);

            // Mask payload
            for (let i = 0; i < length; i++) {
                frame[headerLen + 4 + i] = payload[i] ^ mask[i % 4];
            }

            this.socket.write(frame);
        }
    }

    close() {
        if (this.socket) this.socket.destroy();
    }

    connect() {
        const u = new URL(this.url);
        const options = {
            host: u.hostname,
            port: u.port || 80,
            path: u.pathname + u.search,
            headers: {
                'Connection': 'Upgrade',
                'Upgrade': 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': require('crypto').randomBytes(16).toString('base64')
            }
        };

        const req = http.request(options);
        req.on('upgrade', (res, socket, head) => {
            this.socket = socket;
            this.listeners['open'].forEach(cb => cb());

            let buffer = Buffer.alloc(0);

            socket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);

                while (true) {
                    if (buffer.length < 2) break;

                    const firstByte = buffer[0];
                    const opCode = firstByte & 0x0F;
                    const secondByte = buffer[1];
                    const isMasked = (secondByte & 0x80) !== 0;
                    let payloadLen = secondByte & 0x7F;
                    let offset = 2;

                    if (payloadLen === 126) {
                        if (buffer.length < offset + 2) break;
                        payloadLen = buffer.readUInt16BE(offset);
                        offset += 2;
                    } else if (payloadLen === 127) {
                        if (buffer.length < offset + 8) break;
                        // 简化：假设长度不超过 2^32
                        payloadLen = Number(buffer.readBigUInt64BE(offset));
                        offset += 8;
                    }

                    let maskKey = null;
                    if (isMasked) {
                        if (buffer.length < offset + 4) break;
                        maskKey = buffer.slice(offset, offset + 4);
                        offset += 4;
                    }

                    if (buffer.length < offset + payloadLen) break;

                    const payload = buffer.slice(offset, offset + payloadLen);

                    if (isMasked) {
                        for (let i = 0; i < payloadLen; i++) {
                            payload[i] = payload[i] ^ maskKey[i % 4];
                        }
                    }

                    if (opCode === 0x1) { // Text
                        const str = payload.toString('utf8');
                        this.listeners['message'].forEach(cb => cb(str));
                    }

                    buffer = buffer.slice(offset + payloadLen);
                }
            });
        });

        req.on('error', (e) => this.listeners['error'].forEach(cb => cb(e)));
        req.end();
    }
}

// 查找 Chrome/Edge 路径
function findBrowserPath() {
    const platform = process.platform;
    const commonPaths = [];

    if (platform === 'win32') {
        commonPaths.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            // 补充 Local AppData 路径，这是很多用户（特别是没有管理员权限安装的）Chrome/Edge 的安装位置
            path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
            path.join(os.homedir(), 'AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'),
            // 增加 E 盘的常见路径探测
            'E:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'E:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'E:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'E:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            // 增加 D 盘的常见路径探测
            'D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'D:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'D:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'D:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        );
    } else if (platform === 'darwin') {
        commonPaths.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        );
    } else {
        commonPaths.push(
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/microsoft-edge'
        );
    }

    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }

    // 如果还没找到，尝试从注册表查找（仅限 Windows，简单实现，通过 reg query）
    // 或者尝试环境变量
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    if (process.env.EDGE_PATH && fs.existsSync(process.env.EDGE_PATH)) return process.env.EDGE_PATH;

    return null;
}

let customBrowserPath = null;

// 验证浏览器路径是否有效
function validateBrowserPath(exePath) {
    return new Promise((resolve) => {
        if (!exePath || !fs.existsSync(exePath)) return resolve(false);

        // 尝试执行 --version
        const proc = spawn(exePath, ['--version']);

        let output = '';
        proc.stdout.on('data', d => output += d.toString());

        proc.on('error', () => resolve(false));

        proc.on('close', (code) => {
            // 只要能运行且返回0，或者打印包含 Chrome/Edge/Chromium 字样
            if (code === 0 || output.includes('Chrome') || output.includes('Edge') || output.includes('Chromium')) {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        // 2秒超时
        setTimeout(() => {
            try { proc.kill(); } catch { }
            // 超时也算失败，或者如果已经有打印了就算成功？保守点算失败
            resolve(output.length > 0);
        }, 2000);
    });
}

// 获取 CDP WebSocket URL
function getDebugUrl(port) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const check = () => {
            const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const info = JSON.parse(data);
                        resolve(info.webSocketDebuggerUrl);
                    } catch (e) {
                        retry();
                    }
                });
            });
            req.on('error', retry);
        };

        const retry = () => {
            attempts++;
            if (attempts > 20) return reject(new Error('无法连接到浏览器调试端口'));
            setTimeout(check, 500);
        };

        check();
    });
}

class CdpSniffer {
    constructor() {
        this.browserProcess = null;
        this.ws = null;
        this.tmpDir = path.join(os.tmpdir(), 'vscode-video-sniffer-' + Date.now());
        this.nextId = 1000; // 初始化 ID 计数器
    }

    // 统一发送命令的方法
    sendCommand(method, params = {}, sessionId = undefined) {
        if (!this.ws) return;
        const id = this.nextId++;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        this.ws.send(JSON.stringify(msg));
    }

    // 启动监听模式
    async start(targetUrl, onLog, options = {}) {
        // 优先使用自定义路径
        const browserPath = customBrowserPath || findBrowserPath();
        if (!browserPath) throw new Error('未找到 Chrome 或 Edge 浏览器');

        // 随机端口
        const port = 9222 + Math.floor(Math.random() * 100);

        // 使用固定的用户数据目录，以便保存登录状态 (Cookie, LocalStorage 等)
        // 优先使用外部传入的 userDataDir（从 context.globalStorageUri 获得，完全动态）
        let userDateDir = options.userDataDir;
        if (!userDateDir) {
            // fallback: 动态获取扩展 ID，无硬编码
            const globalExt = require('./global');
            const pkg = require('../package.json');
            const extId = globalExt.extensionId() || `${pkg.publisher}.${pkg.name}`;
            userDateDir = path.join(
                process.env.APPDATA || process.env.HOME,
                "Code", "User", "globalStorage", extId, "chrome-user-data"
            );
        }

        // 确保目录存在
        if (!fs.existsSync(userDateDir)) {
            try { fs.mkdirSync(userDateDir, { recursive: true }); } catch (e) { }
        }

        // 更新 tmpDir，以便 _addCapture 能传递正确的 userDataDir 给 yt-dlp
        this.tmpDir = userDateDir;

        // 启动浏览器
        const args = [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDateDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
            '--disable-blink-features=AutomationControlled', // 关键：防止被识别为自动化工具
            '--new-window',
            '--disable-gpu',
            '--no-sandbox',
            targetUrl
        ];

        const logMsg = (msg) => {
            h.log(msg);
            if (onLog) onLog(msg);
        };

        logMsg(`[CDP] 启动浏览器: ${browserPath} ${args.join(' ')}`);
        this.browserProcess = spawn(browserPath, args);

        // 存储捕获到的视频流
        this.capturedVideos = [];
        this.sessions = new Set(); // 维护所有 Session ID

        try {
            const wsUrl = await getDebugUrl(port);
            logMsg(`[CDP] 连接 WebSocket: ${wsUrl}`);
            this.ws = new SimpleWebSocket(wsUrl);

            return new Promise((resolve, reject) => {
                this.ws.on('open', () => {
                    // 策略改变：不依赖 AutoAttach，而是主动轮询 Targets 并连接 Page
                    // 但由于 SimpleWebSocket 只能连一个地址，我们还是保持连接 Browser Target
                    // 并通过 Target.attachToTarget 来管理 Page 会话
                    // 只是不再使用 AutoAttach 的 flatten 模式，或者尝试手动 Attach

                    // 1. 发现所有 Target
                    this.sendCommand('Target.setDiscoverTargets', { discover: true });

                    // 2. 启用 AutoAttach (保险起见，但可能在某些版本失效)
                    this.sendCommand('Target.setAutoAttach', {
                        autoAttach: true,
                        waitForDebuggerOnStart: false,
                        flatten: true
                    });

                    // 注意：不要在 Browser 级别启用 Network（该域仅在 Page/Session 上可用）

                    resolve();
                });

                this.ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data);

                        // 打印详细的协议交互日志
                        if (msg.error) {
                            logMsg(`[CDP Error] ${JSON.stringify(msg)}`);
                        } else if (msg.id && msg.id >= 100) {
                            // 打印所有我们发出的命令的响应
                            logMsg(`[CDP] Command Response ${msg.id}: ${JSON.stringify(msg)}`);
                        }

                        // 主动 Attach 到新发现的 Page
                        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
                            const target = msg.params.targetInfo;
                            if (target.type === 'page' && !target.attached) { // 避免重复 Attach
                                logMsg(`[CDP] 发现 Target: ${target.type} - ${target.url}`);
                                this.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                            }
                        }

                        // 处理 Attach 成功后的会话
                        if (msg.method === 'Target.attachedToTarget') {
                            const sessionId = msg.params.sessionId;
                            const targetInfo = msg.params.targetInfo;
                            logMsg(`[CDP] 已挂载会话: ${sessionId} (${targetInfo.type})`);

                            this.sessions.add(sessionId); // 记录 session

                            // 关键：为每个会话启用 Network 监听
                            const enableNetwork = () => {
                                this.sendCommand('Network.enable', {}, sessionId);
                            };
                            enableNetwork();

                            // 保活：每2秒重发一次 Network.enable，防止 Session 掉线或被重置
                            if (!this.keepAliveTimers) this.keepAliveTimers = [];
                            const timer = setInterval(enableNetwork, 2000);
                            this.keepAliveTimers.push(timer);

                            // 同时启用 Runtime 以便后续注入
                            this.sendCommand('Runtime.enable', {}, sessionId);
                        }

                        // 处理 Network.requestWillBeSent (支持 flattened sessionId)
                        if (msg.method === 'Network.requestWillBeSent') {
                            const req = msg.params.request;
                            const url = req.url;

                            // 只打印非静态资源的请求
                            if (!url.match(/\.(js|css|png|jpg|gif|svg|woff|ttf|ico)(\?|$)/)) {
                                logMsg(`[Request] ${req.method} : ${url}`);
                            }

                            if (url.includes('.m3u8') || url.includes('.mpd') ||
                                (url.match(/\.(mp4|webm|flv)(\?|$)/) && !url.includes('.png') && !url.includes('.jpg'))) {

                                this._addCapture(url, req.headers, 'request-url', targetUrl);
                                logMsg(`[!!! CAPTURED] ${url}`);
                            }
                        }

                        // 处理 Network.responseReceived
                        if (msg.method === 'Network.responseReceived') {
                            const resp = msg.params.response;
                            const url = resp.url;
                            const mime = resp.mimeType || '';

                            logMsg(`[Response] ${mime} : ${url}`);

                            if (mime.includes('video') || mime.includes('audio') || mime.includes('mpeg') || mime.includes('stream') ||
                                url.includes('.m3u8') || url.includes('.mpd')) {

                                const lenStr = resp.headers['Content-Length'] || resp.headers['content-length'];
                                const len = lenStr ? parseInt(lenStr, 10) : null;

                                // 优先捕获 m3u8/mpd
                                if (url.includes('.m3u8') || url.includes('.mpd')) {
                                    this._addCapture(url, null, 'response-mime', targetUrl, len, 100); // 优先级 100
                                    logMsg(`[!!! CAPTURED PRIORITY] ${url}`);
                                } else if (url.match(/\.(mp4|webm|flv|mov|mkv)(\?|$)/) || mime.includes('mp4') || mime.includes('webm')) {
                                    // 完整视频文件，优先级也设为 80，避免被 m3u8 过滤掉
                                    this._addCapture(url, null, 'response-mime', targetUrl, len, 80);
                                    logMsg(`[!!! CAPTURED VIDEO] ${url}`);
                                } else {
                                    // 对于 ts, m4s 等片段，或者未识别后缀的流，优先级设低
                                    this._addCapture(url, null, 'response-mime', targetUrl, len, 10); // 优先级 10
                                    logMsg(`[!!! CAPTURED FRAGMENT] ${url}`);
                                }
                            }
                        }
                    } catch (e) { }
                });
            });
        } catch (e) {
            h.log(`[CDP] 启动异常: ${e.message}`);
            this.cleanup();
            throw e;
        }
    }

    _addCapture(url, headers, source, targetUrl, contentLength = null, priority = 50) {
        // 如果已经有更高优先级的，忽略低优先级的（除非是同一个URL）
        if (this.capturedVideos.length > 0 && this.capturedVideos[0].priority > priority && this.capturedVideos[0].url !== url) return;

        // 避免重复
        if (this.capturedVideos.some(v => v.url === url)) return;

        const result = {
            url: url,
            userDataDir: this.tmpDir, // 传递用户数据目录，供 yt-dlp 提取 Cookie
            headers: headers ? {
                'Cookie': headers['Cookie'] || headers['cookie'],
                'Referer': headers['Referer'] || headers['referer'] || targetUrl,
                'User-Agent': headers['User-Agent'] || headers['user-agent'],
                'Origin': headers['Origin'] || headers['origin']
            } : {
                // 如果是从 response 抓到的，可能没有 request headers，暂且留空或者给个默认
                'Referer': targetUrl
            },
            cookieSource: 'cdp-sniffed',
            timestamp: Date.now(),
            filesize: contentLength, // 记录 Content-Length
            resolution: url.includes('1080') ? '1080p' : (url.includes('720') ? '720p' : 'unknown'), // 简单的分辨率推断
            priority: priority
        };

        // 如果 Cookie 缺失，尝试主动获取
        if (!result.headers.Cookie && this.ws && this.sessions.size > 0) {
            // 策略优化：向所有 Sessions 广播获取 Cookie，因为我们不知道视频到底在哪个 Frame
            // 但为了性能，我们稍微限制一下，或者只发给最近的几个
            const sessionIds = Array.from(this.sessions);

            // 标记正在获取 Cookie
            result.waitingForCookie = true;

            sessionIds.forEach(sessionId => {
                const id = this.nextId++;

                // 临时监听一次
                const listener = (data) => {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.id === id && msg.result && msg.result.cookies) {
                            const cookies = msg.result.cookies;
                            if (cookies.length > 0) {
                                const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                                // 只有当新的 Cookie 比现有长（或者现有为空）时才更新
                                if (!result.headers.Cookie || cookieStr.length > result.headers.Cookie.length) {
                                    result.headers.Cookie = cookieStr;
                                    h.log(`[CDP] 主动获取 Cookie 成功 (Session ${sessionId}): ${cookieStr.substring(0, 50)}...`);
                                    result.waitingForCookie = false; // 标记完成
                                }
                            }
                            // 移除监听
                            const idx = this.ws.listeners['message'].indexOf(listener);
                            if (idx > -1) this.ws.listeners['message'].splice(idx, 1);
                        }
                    } catch (e) { }
                };
                this.ws.on('message', listener);

                this.ws.send(JSON.stringify({
                    id: id,
                    method: 'Network.getCookies',
                    params: { urls: [url, targetUrl] }, // 指定 URL 范围
                    sessionId: sessionId
                }));
            });

            // 2秒后强制取消等待标记，防止死锁
            setTimeout(() => { result.waitingForCookie = false; }, 2000);
        }

        // 清洗 Referer (更严格：只取第一个 URL，去除尾随逗号)
        if (result.headers.Referer) {
            let ref = result.headers.Referer.trim();
            // 处理可能的 "url, url" 或 "url," 情况
            if (ref.includes(',')) {
                ref = ref.split(',')[0].trim();
            }
            result.headers.Referer = ref;
        }

        // 补全 Origin (如果 Referer 存在但 Origin 不存在)
        if (!result.headers.Origin && result.headers.Referer) {
            try {
                result.headers.Origin = new URL(result.headers.Referer).origin;
            } catch { }
        }

        h.log(`[CDP] !!! 捕获成功 (${source}): ${url} Size:${contentLength}`);

        // 按照优先级排序插入
        if (priority >= 90) {
            this.capturedVideos.unshift(result);
        } else {
            // 总是追加低优先级视频
            this.capturedVideos.push(result);
        }
    }

    // 获取所有捕获的视频
    getCapturedVideos() {
        return this.capturedVideos || [];
    }

    // 获取最近捕获的一个结果
    async getLatestCapture(injectJs = false) {
        if (this.capturedVideos && this.capturedVideos.length > 0) {
            const latest = this.capturedVideos[0];
            // 如果还在等待 Cookie，稍微等一下，给它 500ms 机会
            if (latest.waitingForCookie) {
                await new Promise(r => setTimeout(r, 500));
                // 不管等到没等到，都返回，因为不能一直卡着
            }
            return latest;
        }

        if (injectJs && this.ws && this.sessions.size > 0) {
            h.log(`[CDP] 尝试 JS 注入兜底... Sessions: ${this.sessions.size}`);

            // 构造注入脚本：利用 Performance API 和 DOM 深度扫描
            const script = `(function() {
                try {
                    // 1. 扫描 Performance API (浏览器自带的网络日志)
                    // 这是最强大的，即使 CDP Network 漏了，这里也不会漏
                    var resources = performance.getEntriesByType('resource');
                    // 倒序查找最近的视频请求
                    for (var i = resources.length - 1; i >= 0; i--) {
                        var name = resources[i].name;
                        // 增加对 blob: 协议的支持
                        if (name.startsWith('blob:') || name.includes('.m3u8') || name.includes('.mpd') || name.match(/\.(mp4|webm|flv)(\?|$)/)) {
                             // 过滤掉 icon
                             if (!name.includes('.png') && !name.includes('.ico')) return name;
                        }
                    }

                    // 2. 扫描 DOM <video>
                    var v = document.querySelector('video');
                    if (v) {
                        // 增加对 src 属性的严格检查
                        if (v.src && (v.src.startsWith('http') || v.src.startsWith('blob:'))) return JSON.stringify({ url: v.src, cookie: document.cookie, referer: document.referrer });
                        if (v.currentSrc && (v.currentSrc.startsWith('http') || v.currentSrc.startsWith('blob:'))) return JSON.stringify({ url: v.currentSrc, cookie: document.cookie, referer: document.referrer });
                        var s = v.querySelector('source');
                        if (s && s.src) return JSON.stringify({ url: s.src, cookie: document.cookie, referer: document.referrer });
                    }

                    // 3. 扫描 iframe
                    var iframes = document.querySelectorAll('iframe');
                    for (var i=0; i<iframes.length; i++) {
                         var src = iframes[i].src;
                         if (src && (src.includes('m3u8') || src.includes('mp4'))) return JSON.stringify({ url: src, cookie: document.cookie, referer: document.referrer });
                    }

                    // 4. 常见播放器探测
                    if (window.hls && window.hls.url) return JSON.stringify({ url: window.hls.url, cookie: document.cookie, referer: document.referrer });

                    // 5. 全局变量深度扫描 (针对百度新闻等 SPA)
                    // 扫描 window 对象中看起来像视频配置的属性
                    try {
                        var keys = Object.keys(window);
                        for (var i = 0; i < keys.length; i++) {
                            var k = keys[i];
                            if (k.includes('Info') || k.includes('Data') || k.includes('Player') || k.includes('Config')) {
                                var val = window[k];
                                if (val && typeof val === 'object') {
                                    var str = JSON.stringify(val);
                                    // 简单的正则匹配 http + mp4/m3u8
                                    var match = str.match(/https?:\/\/[^"']+\.(mp4|m3u8|mpd)[^"']*/);
                                    if (match) return JSON.stringify({ url: match[0].replace(/\\\//g, '/'), cookie: document.cookie, referer: document.referrer });
                                }
                            }
                        }
                    } catch(e) {}
                } catch(e) { return null; }
                return null;
            })()`;

            // 遍历所有 session 执行
            // 这是一个异步并发过程，我们等待第一个有效结果
            const promises = Array.from(this.sessions).map(sessionId => {
                return new Promise(resolve => {
                    const id = Date.now() + Math.floor(Math.random() * 10000);

                    const listener = (data) => {
                        try {
                            const msg = JSON.parse(data);
                            if (msg.id === id && msg.result && msg.result.result) {
                                const val = msg.result.result.value;
                                if (val && typeof val === 'string') {
                                    // 尝试解析 JSON
                                    try {
                                        const obj = JSON.parse(val);
                                        if (obj.url) resolve(obj);
                                        else if (val.startsWith('http')) resolve({ url: val }); // 兼容旧脚本
                                        else resolve(null);
                                    } catch {
                                        if (val.startsWith('http')) resolve({ url: val });
                                        else resolve(null);
                                    }
                                } else {
                                    resolve(null);
                                }
                            }
                        } catch (e) { resolve(null); }
                    };

                    // 临时监听
                    this.ws.on('message', listener);

                    // 发送执行请求
                    this.sendCommand('Runtime.evaluate', {
                        expression: script,
                        returnByValue: true
                    }, sessionId);

                    // 超时清理
                    setTimeout(() => resolve(null), 1000);
                });
            });

            try {
                const results = await Promise.all(promises);
                const found = results.find(r => r && r.url);
                if (found) {
                    h.log(`[CDP] JS 注入成功提取: ${found.url}`);
                    // 构造伪造的捕获结果
                    let referer = found.referer ? found.referer.trim() : 'https://www.google.com/';
                    if (referer) referer = referer.split(',')[0].trim();

                    let origin = '';
                    try { origin = new URL(referer).origin; } catch { }

                    const result = {
                        url: found.url,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Referer': referer,
                            'Origin': origin,
                            'Cookie': found.cookie || '' // 从 JS 获取的 Cookie
                        },
                        cookieSource: 'cdp-injected',
                        timestamp: Date.now()
                    };
                    this.capturedVideos.unshift(result);
                    return result;
                }
            } catch (e) {
                h.log(`[CDP] JS 注入执行失败: ${e.message}`);
            }
        }
        return null;
    }

    // 获取所有 Frame 的页面源码
    async getPageSource() {
        if (!this.ws || this.sessions.size === 0) return null;

        const sessionIds = Array.from(this.sessions);
        const promises = sessionIds.map(sessionId => {
            return new Promise(resolve => {
                const id = this.nextId++;
                const listener = (data) => {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.id === id) {
                            const idx = this.ws.listeners['message'].indexOf(listener);
                            if (idx > -1) this.ws.listeners['message'].splice(idx, 1);

                            if (msg.result && msg.result.result && msg.result.result.value) {
                                resolve(msg.result.result.value);
                            } else {
                                resolve('');
                            }
                        }
                    } catch { resolve(''); }
                };
                this.ws.on('message', listener);

                this.sendCommand('Runtime.evaluate', {
                    expression: 'document.documentElement.outerHTML',
                    returnByValue: true
                }, sessionId);

                setTimeout(() => resolve(''), 1500); // 稍微缩短单个超时
            });
        });

        try {
            const sources = await Promise.all(promises);
            // 将所有源码拼接，用注释分隔，方便分析
            return sources.filter(s => s && s.length > 0).join('\n<!-- FRAME SEPARATOR -->\n');
        } catch { return null; }
    }

    // 停止并清理
    stop() {
        this.cleanup();
    }

    // 兼容旧 API (如果还有地方调用的话，   即便 我们打算重构 Controller)
    async sniff(targetUrl, onFound, timeoutMs = 121000) {
        await this.start(targetUrl);
        // ... 旧逻辑兼容实现略，或者直接让 Controller 改用 start/stop ...
        // 为了安全起见，我们还是保留基本的兼容性，或者直接在 Controller 里改掉
        // 鉴于我们要重构 Controller，这里不需要太复杂的兼容
        return new Promise((resolve) => {
            const timer = setInterval(() => {
                const latest = this.getLatestCapture();
                if (latest) {
                    if (onFound(latest)) {
                        clearInterval(timer);
                        this.stop();
                        resolve(latest);
                    }
                }
            }, 500);
            setTimeout(() => { clearInterval(timer); this.stop(); resolve(null); }, timeoutMs);
        });
    }

    cleanup() {
        if (this.ws) {
            try { this.ws.close(); } catch { }
            this.ws = null;
        }
        if (this.keepAliveTimers) {
            this.keepAliveTimers.forEach(t => clearInterval(t));
            this.keepAliveTimers = [];
        }
        if (this.browserProcess) {
            const pid = this.browserProcess.pid;

            // ★ 修复：在 Windows 上使用 taskkill 彻底杀死进程树（防止僵尸进程）
            if (process.platform === 'win32' && pid) {
                try {
                    // /F = Force, /T = Tree (kills children), /PID = Process ID
                    // QQQ_NO_TRACK=1 防止此命令本身被追踪系统误判
                    require('child_process').execSync(`taskkill /pid ${pid} /T /F`, {
                        stdio: 'ignore',
                        env: { ...process.env, QQQ_NO_TRACK: '1' }
                    });
                } catch (e) {
                    // 忽略错误（例如进程已经不存在）
                }
            }

            try {
                this.browserProcess.kill();
            } catch { }
            this.browserProcess = null;
        }
        // 清理临时目录 (可选，可能需要递归删除)
    }
    static setCustomBrowserPath(path) {
        customBrowserPath = path;
    }

    static getCustomBrowserPath() {
        return customBrowserPath;
    }

    static validateBrowserPath = validateBrowserPath;
}

module.exports = CdpSniffer;

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
            // 只要能运行且返回0，或者输出包含 Chrome/Edge/Chromium 字样
            if (code === 0 || output.includes('Chrome') || output.includes('Edge') || output.includes('Chromium')) {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        // 2秒超时
        setTimeout(() => {
            try { proc.kill(); } catch { }
            // 超时也算失败，或者如果已经有输出了就算成功？保守点算失败
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
    }

    // 启动监听模式
    async start(targetUrl, onLog) {
        // 优先使用自定义路径
        const browserPath = customBrowserPath || findBrowserPath();
        if (!browserPath) throw new Error('未找到 Chrome 或 Edge 浏览器');

        // 随机端口
        const port = 9222 + Math.floor(Math.random() * 100);

        // 启动浏览器
        const args = [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${this.tmpDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disk-cache-dir=null',
            '--media-cache-size=1',
            // 关键优化：避免复用已有实例，强制新窗口
            '--new-window',
            // 移除可能导致 CDP 异常的 flags，尝试更原生的启动方式
            // '--no-default-browser-check',
            // '--disable-extensions',
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
                    this.ws.send(JSON.stringify({ id: 100, method: 'Target.setDiscoverTargets', params: { discover: true } }));

                    // 2. 启用 AutoAttach (保险起见，但可能在某些版本失效)
                    this.ws.send(JSON.stringify({
                        id: 101,
                        method: 'Target.setAutoAttach',
                        params: {
                            autoAttach: true,
                            waitForDebuggerOnStart: false,
                            flatten: true
                        }
                    }));

                    // 注意：不要在 Browser 级别启用 Network（该域仅在 Page/Session 上可用）

                    resolve();
                });

                this.ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data);

                        // 打印详细的协议交互日志 (仅限关键命令回复)
                        if (msg.id && msg.id >= 100 && msg.id <= 105) {
                            logMsg(`[CDP] Command Response ${msg.id}: ${JSON.stringify(msg)}`);
                        }

                        // 主动 Attach 到新发现的 Page
                        if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
                            const target = msg.params.targetInfo;
                            if (target.type === 'page' && !target.attached) { // 避免重复 Attach
                                logMsg(`[CDP] 发现 Target: ${target.type} - ${target.url}`);
                                this.ws.send(JSON.stringify({
                                    id: Date.now(),
                                    method: 'Target.attachToTarget',
                                    params: { targetId: target.targetId, flatten: true }
                                }));
                            }
                        }

                        // 处理 Attach 成功后的会话
                        if (msg.method === 'Target.attachedToTarget') {
                            const sessionId = msg.params.sessionId;
                            const targetInfo = msg.params.targetInfo;
                            logMsg(`[CDP] 已挂载会话: ${sessionId} (${targetInfo.type})`);

                            this.sessions.add(sessionId); // 记录 session

                            // 关键：为每个会话启用 Network 监听
                            this.ws.send(JSON.stringify({
                                id: Date.now(),
                                sessionId: sessionId,
                                method: 'Network.enable'
                            }));
                            // 同时启用 Runtime 以便后续注入
                            this.ws.send(JSON.stringify({
                                id: Date.now(),
                                sessionId: sessionId,
                                method: 'Runtime.enable'
                            }));
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
                                this._addCapture(url, null, 'response-mime', targetUrl, len);
                                logMsg(`[!!! CAPTURED] ${url}`);
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

    _addCapture(url, headers, source, targetUrl, contentLength = null) {
        if (this.capturedVideos.some(v => v.url === url)) return;

        const result = {
            url: url,
            headers: headers ? {
                'Cookie': headers['Cookie'] || headers['cookie'],
                'Referer': headers['Referer'] || headers['referer'] || targetUrl,
                'User-Agent': headers['User-Agent'] || headers['user-agent']
            } : {
                // 如果是从 response 抓到的，可能没有 request headers，暂且留空或者给个默认
                // 实际场景下，requestWillBeSent 通常会先触发，所以大概率能抓到 headers
                'Referer': targetUrl
            },
            cookieSource: 'cdp-sniffed',
            timestamp: Date.now(),
            filesize: contentLength, // 记录 Content-Length
            resolution: url.includes('1080') ? '1080p' : (url.includes('720') ? '720p' : 'unknown') // 简单的分辨率推断
        };

        h.log(`[CDP] !!! 捕获成功 (${source}): ${url} Size:${contentLength}`);
        this.capturedVideos.unshift(result);
    }

    // 获取最近捕获的一个结果
    async getLatestCapture(injectJs = false) {
        if (this.capturedVideos && this.capturedVideos.length > 0) return this.capturedVideos[0];

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
                        if (name.includes('.m3u8') || name.includes('.mpd') || name.match(/\.(mp4|webm|flv)(\?|$)/)) {
                             // 过滤掉 icon
                             if (!name.includes('.png') && !name.includes('.ico')) return name;
                        }
                    }

                    // 2. 扫描 DOM <video>
                    var v = document.querySelector('video');
                    if (v) {
                        if (v.src && (v.src.startsWith('http') || v.src.startsWith('blob'))) return v.src;
                        if (v.currentSrc) return v.currentSrc;
                        var s = v.querySelector('source');
                        if (s && s.src) return s.src;
                    }

                    // 3. 扫描 iframe
                    var iframes = document.querySelectorAll('iframe');
                    for (var i=0; i<iframes.length; i++) {
                         var src = iframes[i].src;
                         if (src && (src.includes('m3u8') || src.includes('mp4'))) return src;
                    }

                    // 4. 常见播放器探测
                    if (window.hls && window.hls.url) return window.hls.url;
                    if (window.jwplayer) {
                        var jw = window.jwplayer();
                        if (jw && jw.getPlaylist) {
                            var pl = jw.getPlaylist();
                            if (pl && pl.length > 0 && pl[0].file) return pl[0].file;
                        }
                    }
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
                                if (val && typeof val === 'string' && val.startsWith('http')) {
                                    resolve(val);
                                } else {
                                    resolve(null);
                                }
                            }
                        } catch (e) { resolve(null); }
                    };

                    // 临时监听
                    this.ws.on('message', listener);

                    // 发送执行请求
                    this.ws.send(JSON.stringify({
                        id: id,
                        sessionId: sessionId,
                        method: 'Runtime.evaluate',
                        params: { expression: script, returnByValue: true }
                    }));

                    // 超时清理
                    setTimeout(() => resolve(null), 1000);
                });
            });

            try {
                const results = await Promise.all(promises);
                const found = results.find(r => r);
                if (found) {
                    h.log(`[CDP] JS 注入成功提取: ${found}`);
                    // 构造伪造的捕获结果
                    const result = {
                        url: found,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Referer': 'https://www.google.com/' // 默认 Referer
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

    // 停止并清理
    stop() {
        this.cleanup();
    }

    // 兼容旧 API (如果还有地方调用的话，虽然我们打算重构 Controller)
    async sniff(targetUrl, onFound, timeoutMs = 120000) {
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
        if (this.browserProcess) {
            // 在 Windows 上 kill 进程可能不会关闭所有子进程，但通常足够了
            // 注意：我们不强制关闭浏览器，留给用户自己关，或者根据需求关
            // 但为了清理连接，我们断开 WS
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

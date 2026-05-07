// -*- coding: utf-8 -*-
/**
 * BrokerBridge: IPC client for global singleton Python Broker
 *
 * Design:
 * - All VS Code windows (across multiple AI IDEs) share ONE Python Broker process
 * - Communication via IPC (Unix socket on Linux/macOS, Named Pipe on Windows)
 * - Uses endpoint.json + token.txt for discovery and authentication
 * - Heartbeat mechanism for lease renewal (TTL-based auto-shutdown)
 *
 * Architecture:
 * - 15 windows → 1 Python Broker process
 * - Each window has its own BrokerBridge instance (client)
 * - Broker handles: clipboard watching, audio playback, savoring
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { randomUUID } = require('crypto');
const EventEmitter = require('events');

// ============================================================================
// Constants (must match Python kp.py)
// ============================================================================
const ENDPOINT_DIRNAME = "vix_audio_broker";
const ENDPOINT_FILENAME = "endpoint.json";
const TOKEN_FILENAME = "token.txt";
const APP_ID = "vix-broker";

// Heartbeat: 20s interval, Broker TTL: 80s (must satisfy TTL >= heartbeat * 2)
const HEARTBEAT_INTERVAL_MS = 20000;
const CONNECT_RETRY_MAX = 30;
const CONNECT_RETRY_DELAY_BASE_MS = 121;
const DEFERRED_RECONNECT_INTERVAL_MS = 15000; // ★ 失败后每15秒重连一次
const DEFERRED_RECONNECT_MAX = 20;            // ★ 最多重试20次（5分钟内覆盖）

// ============================================================================
// Helper Functions
// ============================================================================

function getCacheDir() {
	if (process.platform === 'win32') {
		const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
		return path.join(base, ENDPOINT_DIRNAME);
	}
	const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
	return path.join(base, ENDPOINT_DIRNAME);
}

function readJsonFile(filePath) {
	try {
		const content = fs.readFileSync(filePath, 'utf8');
		return JSON.parse(content);
	} catch {
		return null;
	}
}

function readTextFile(filePath) {
	try {
		return fs.readFileSync(filePath, 'utf8').trim();
	} catch {
		return null;
	}
}

// ============================================================================
// BrokerBridge Class
// ============================================================================

class BrokerBridge extends EventEmitter {
	constructor(name = "PythonBroker") {
		super();
		this.name = name;
		this.socket = null;
		this.connected = false;

		// Client identity
		this.clientId = randomUUID();
		this.token = "";
		this.endpoint = null;

		// Request-response matching
		this.lineBuf = "";
		this.nextId = 1;
		this.pending = new Map();

		// Heartbeat timer
		this.hbTimer = null;

		// Spawn throttling (per-window, 3s cooldown)
		this.lastSpawnAt = 0;
		this.spawning = null;
		this._lastHealAttempt = 0;  // ★ Self-healing throttle (prevent spam)

		// Status flags (compatible with DaemonBridge)
		this.available = null;
		this.isStarting = false;
		this.startPromise = null;
		this.process = null; // Placeholder for compatibility

		// Error tracking (compatible with DaemonBridge)
		this.lastStartError = "";
		this.lastCrashReason = "";
		this.lastStderrSnippet = ""; // Not used in IPC mode, but needed for compatibility

		// Context (set externally)
		this.extensionPath = "";
		this._downloadedPythonPath = null; // Set by dow.js when Python is ready
		this._diagPrinted = false; // 诊断日志只打印一次
	}

	// =========================================================================
	// Public API (compatible with DaemonBridge)
	// =========================================================================

	isAvailable() {
		return this.connected && this.socket !== null;
	}

	async start() {
		if (this.isStarting) return this.startPromise;
		if (this.isAvailable()) return true;

		this.isStarting = true;
		this.startPromise = this._doStart();

		try {
			const result = await this.startPromise;
			return result;
		} finally {
			this.isStarting = false;
			this.startPromise = null;
		}
	}

	async stop() {
		this.stopHeartbeat();
		// ★ Stop deferred reconnect timer
		if (this._deferredTimer) {
			clearInterval(this._deferredTimer);
			this._deferredTimer = null;
		}

		// ★ Best-effort: notify Broker we're leaving (don't depend on it executing)
		// Broker uses TTL-based auto-shutdown, so this is just a hint for faster cleanup
		if (this.isAvailable()) {
			try {
				// Send bye with very short timeout, don't wait for response
				this.socket.write(JSON.stringify({
					_id: this.nextId++,
					action: 'bye',
					client_id: this.clientId,
					token: this.token
				}) + '\n', 'utf8');
			} catch {
				// Ignore: socket may already be closed
			}
		}

		this.closeSocket();
	}

	dispose() {
		this.stop();
	}

	/**
	 * Call a method on the Broker
	 * @param {string} action - Action name (e.g., "play_sfx", "ping")
	 * @param {object} payload - Additional parameters
	 * @param {number} timeoutMs - Timeout in milliseconds
	 * @returns {Promise<object>} Response from Broker
	 */
	async call(action, payload = {}, timeoutMs = 5000) {
		if (!this.isAvailable()) {
			// Try to reconnect if not available
			const ok = await this.start();
			if (!ok) {
				throw new Error(`BrokerBridge not connected, cannot call ${action}`);
			}
		}

		const id = this.nextId++;
		const req = {
      _id: id,
      action,
      client_id: this.clientId,
      token: this.token,
      ...payload
    };

		const line = JSON.stringify(req) + "\n";

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`BrokerBridge RPC timeout: ${action}`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timer });

			try {
				this.socket.write(line, 'utf8');
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(e);
			}
		});
	}

	// =========================================================================
	// Internal Methods
	// =========================================================================

	async _doStart() {
		// Step 1: Try connecting to existing Broker
		const connResult = await this._tryConnectOnce();
		try { const global = require('./global'); global.logMessage(`[Broker] Connect attempt: ${connResult ? 'connected to existing' : 'need spawn'}`, "DEBUG"); } catch { }

		if (connResult) {
			this._startHeartbeat();
			this.emit('event', { event: 'broker_connected' }); // ★ Notify listeners
			return true;
		}

		// Step 2: Spawn Broker if connection failed
		await this._spawnBrokerThrottled();

		// Step 3: Retry connection with backoff
		for (let i = 0; i < CONNECT_RETRY_MAX; i++) {
			await this._sleep(CONNECT_RETRY_DELAY_BASE_MS + i * 30);
			if (await this._tryConnectOnce()) {
				this._startHeartbeat();
				this.emit('event', { event: 'broker_connected' }); // ★ Notify listeners
				return true;
			}
		}

		this.lastStartError = "Broker connect failed after spawn+retries";
		this.available = false;
		// ★ 启动延迟重连定时器：Python Broker 冷启动可能需要 20-60 秒
		// 首次连接窗口（~17s）不够时，后台周期性重试确保最终连上
		this._startDeferredReconnect();
		return false;
	}

	async _tryConnectOnce() {
		const cacheDir = getCacheDir();
		const endpointPath = path.join(cacheDir, ENDPOINT_FILENAME);
		const tokenPath = path.join(cacheDir, TOKEN_FILENAME);

		const endpoint = readJsonFile(endpointPath);
		const token = readTextFile(tokenPath);

		if (!endpoint || !token) {
			// ★ 诊断：endpoint.json 或 token.txt 不存在（首次打印）
			if (!this._diagPrinted) {
				this._diagPrinted = true;
				try {
					const global = require('./global');
					global.logMessage(`[Broker] No existing broker: endpoint=${!!endpoint}, token=${!!token}`, "DEBUG");
				} catch { }
			}
			return false;
		}

		if (endpoint.app_id !== APP_ID) {
			try { const global = require('./global'); global.logMessage(`[Broker] app_id mismatch: expected=${APP_ID}, got=${endpoint.app_id}`, "WARN"); } catch { }
			return false;
		}

		// Determine connection options based on family
		let connOpts;
		if (endpoint.family === 'unix') {
			connOpts = { path: endpoint.path };
		} else if (endpoint.family === 'pipe') {
			// Python uses 'name' field for pipe name
			const pipePath = endpoint.name || endpoint.pipe;
			if (!pipePath) return false;
			connOpts = { path: pipePath };
		} else if (endpoint.family === 'tcp') {
			// TCP socket (Windows replacement for Named Pipe)
			const host = endpoint.host || '127.0.0.1';
			const port = endpoint.port;
			if (!port) return false;
			connOpts = { host, port };
		} else {
			return false;
		}

		// Try to connect
		const canConnect = await new Promise((resolve) => {
			const s = net.connect(connOpts);
			s.once('error', () => {
				try { s.destroy(); } catch { }
				resolve(false);
			});
			s.once('connect', () => {
				try { s.destroy(); } catch { }
				resolve(true);
			});
			// Timeout
			setTimeout(() => {
				try { s.destroy(); } catch { }
				resolve(false);
			}, 2000);
		});

		if (!canConnect) return false;

		// Establish real connection with event handlers
		return await this._openAndHello(connOpts, token, endpoint);
	}

	async _openAndHello(connOpts, token, endpoint) {
		this.closeSocket();
		try { const global = require('./global'); global.logMessage(() => `[Broker] Connecting to ${JSON.stringify(connOpts)}`, "DEBUG"); } catch { }

		const s = net.connect(connOpts);
		this.socket = s;
		this.token = token;
		this.endpoint = endpoint;

		s.setKeepAlive(true);
		s.on('data', (buf) => this._onData(buf));
		s.on('error', (e) => { try { const global = require('./global'); global.logMessage(`[Broker] Socket error: ${e.message}`, "WARN"); } catch { } this._onDisconnected(); });
		s.on('close', () => this._onDisconnected());

		const connected = await new Promise((resolve) => {
			let resolved = false;
			const timeoutId = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					try { const global = require('./global'); global.logMessage("[Broker] _openAndHello: connect timeout", "WARN"); } catch { }
					resolve(false);
				}
			}, 3000);
			s.once('connect', () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeoutId);
					resolve(true);
				}
			});
			s.once('error', () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeoutId);
					resolve(false);
				}
			});
		});

		if (!connected) {
			this.closeSocket();
			return false;
		}

		// Verify with hello - DIRECT write to avoid call() re-entrance check
		try {
			const helloId = this.nextId++;
			const helloReq = {
				_id: helloId,
				action: "hello",
				client_id: this.clientId,
				token: this.token
			};
			const helloLine = JSON.stringify(helloReq) + "\n";

			const res = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(helloId);
					reject(new Error("hello timeout"));
				}, 3000);

				this.pending.set(helloId, { resolve, reject, timer });

				try {
					this.socket.write(helloLine, 'utf8');
				} catch (e) {
					clearTimeout(timer);
					this.pending.delete(helloId);
					reject(e);
				}
			});

			try { const global = require('./global'); global.logMessage(() => `[Broker] _openAndHello: hello response: ${JSON.stringify(res)}`, "DEBUG"); } catch { }
			if (!res || res.ok !== true || res.app_id !== APP_ID) {
				this.closeSocket();
				return false;
			}
			this.connected = true;
			this.available = true;
			this.lastStartError = "";
			try { const global = require('./global'); global.logMessage("[Broker] Connected successfully", "INFO"); } catch { }
			return true;
		} catch (e) {
			try { const global = require('./global'); global.logMessage(`[Broker] _openAndHello failed: ${e.message}`, "WARN"); } catch { }
			this.closeSocket();
			return false;
		}
	}

	_onData(buf) {
		this.lineBuf += buf.toString('utf8');

		while (true) {
			const idx = this.lineBuf.indexOf('\n');
			if (idx < 0) break;

			const line = this.lineBuf.slice(0, idx).trim();
			this.lineBuf = this.lineBuf.slice(idx + 1);

			if (!line) continue;

			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}

			const id = obj?._id;

			// Handle events (no _id or marked as event)
			if (id === undefined || obj.event) {
				this.emit('event', obj);
				continue;
			}

			// Handle request-response
			if (typeof id === 'number' && this.pending.has(id)) {
				const p = this.pending.get(id);
				clearTimeout(p.timer);
				this.pending.delete(id);

				if (obj.ok === false) {
					p.reject(new Error(obj.error || 'rpc_error'));
				} else {
					p.resolve(obj);
				}
			}
		}
	}

	_onDisconnected() {
		if (!this.connected && !this.socket) return;

		this.connected = false;
		this.available = false;

		// Reject all pending requests
		for (const [id, p] of this.pending.entries()) {
			clearTimeout(p.timer);
			p.reject(new Error('BrokerBridge disconnected'));
			this.pending.delete(id);
		}

		this.closeSocket();
		this.emit('event', { event: 'broker_disconnected' });
	}

	closeSocket() {
		const s = this.socket;
		this.socket = null;
		this.connected = false;
		this.available = false;
		this.lineBuf = "";

		if (s) {
			try { s.removeAllListeners(); } catch { }
			try { s.destroy(); } catch { }
		}
	}

	// =========================================================================
	// Spawn Broker
	// =========================================================================

	async _spawnBrokerThrottled() {
		const now = Date.now();
		if (this.spawning) {
			return this.spawning;
		}

		// 3s cooldown per window
		if (now - this.lastSpawnAt < 3000) {
			return;
		}

		this.lastSpawnAt = now;

		this.spawning = new Promise(async (resolve) => {
			// ★ OPTIMIZATION: Random delay (0-2s) to stagger multi-window spawns
			// This reduces the chance of 8 windows spawning 8 Python processes simultaneously
			// Most will find existing Broker after the first one succeeds
			const randomDelayMs = Math.floor(Math.random() * 2000); // ★ 减少到 0-2s
			if (randomDelayMs > 0) {
				await this._sleep(randomDelayMs);

				// ★ After random delay, check again if Broker is now available
				// (another window may have started it during our delay)
				if (await this._tryConnectOnce()) {
					this._startHeartbeat();
					this.emit('event', { event: 'broker_connected' });
					resolve();
					return;
				}
			}

			// ★ Step 1: 跨窗口 spawn 锁 - 确保只有一个窗口尝试 spawn
			const spawnQlokPath = path.join(getCacheDir(), "broker_spawning.qlok");
			const qlokMaxAge = 30000; // 30秒超时（spawn + Broker 启动应该足够）

			try {
				// 检查是否有其他窗口正在 spawn
				if (fs.existsSync(spawnQlokPath)) {
					const stat = fs.statSync(spawnQlokPath);
					const age = Date.now() - stat.mtimeMs;
					if (age < qlokMaxAge) {
						// 其他窗口正在 spawn，等待后重试连接
						resolve();
						return;
					}
					// qlok 过期，删除它
					try { fs.unlinkSync(spawnQlokPath); } catch { }
				}

				// 创建 spawn qlok（原子写入）
				const qlokContent = JSON.stringify({ pid: process.pid, time: Date.now() });
				fs.writeFileSync(spawnQlokPath, qlokContent, { flag: 'wx' }); // wx = exclusive create
			} catch (e) {
				if (e.code === 'EEXIST') {
					// 另一个窗口刚刚创建了 qlok，等待
					resolve();
					return;
				}
				// 其他错误，继续尝试 spawn（不阻塞）
			}

			// ★ Step 2: 完美性检查（每次 spawn 前都检查）
			const pythonPerfect = await this._checkPythonPerfect();
			if (!pythonPerfect.ok) {
				try {
					const global = require('./global');
					global.logMessage(`[Broker] Python not ready: ${pythonPerfect.reason}`, "WARN");

					// ★ FIX: 如果 Python 正在安装中，启动定时检查等待安装完成
					if (pythonPerfect.reason === 'install_in_progress' || pythonPerfect.reason === 'python_not_downloaded') {
						try {
							const { getSharedDownloader } = require('./dow');
							const downloader = getSharedDownloader();
							if (downloader && downloader._scheduleInstallCheck && global.extensionContext) {
								global.logMessage("[Broker] Scheduling install check for Python readiness...", "INFO");
								downloader._scheduleInstallCheck(global.extensionContext, 5000, 180000); // 3分钟超时
							}
						} catch (scheduleErr) {
							global.logMessage(`[Broker] Failed to schedule install check: ${scheduleErr.message}`, "WARN");
						}
					}

					// ★ FIX: Python 环境损坏（deps_missing / interpreter_invalid）→ 主动触发重新安装
					// 这是关键：之前只处理了 install_in_progress 和 python_not_downloaded，
					// 但 pip install 崩溃后留下半成品文件夹的情况完全没覆盖
					// ★ 60秒冷却防止心跳每20秒都触发一次
					if ((pythonPerfect.reason === 'deps_missing' || pythonPerfect.reason === 'interpreter_invalid')
						&& Date.now() - this._lastHealAttempt > 60000) {
						this._lastHealAttempt = Date.now();
						try {
							const { getSharedDownloader } = require('./dow');
							const downloader = getSharedDownloader();
							if (downloader && global.extensionContext) {
								// ★ 先删掉坏的文件夹
								const installDir = path.join(global.extensionContext.globalStorageUri.fsPath, "python_engine");
								if (fs.existsSync(installDir)) {
									global.logMessage(`[Broker] ★ Self-healing: nuking corrupt python_engine (${pythonPerfect.reason})`, "WARN");
									try {
										if (fs.rmSync) fs.rmSync(installDir, { recursive: true, force: true });
									} catch (nukeErr) {
										global.logMessage(`[Broker] Nuke failed (files locked?): ${nukeErr.message}`, "WARN");
									}
								}
								// ★ 触发重新安装（ensurePythonReady 会调用 autoInstall）
								global.logMessage("[Broker] Triggering fresh Python install...", "INFO");
								downloader.ensurePythonReady(global.extensionContext).catch(() => {});
							}
						} catch (healErr) {
							global.logMessage(`[Broker] Self-healing trigger failed: ${healErr.message}`, "WARN");
						}
					}
				} catch { }
				// 清理 spawn qlok
				try { fs.unlinkSync(spawnQlokPath); } catch { }
				resolve();
				return;
			}

			// Find Python executable and script
			const { pythonPath, scriptPath } = this._findPythonAndScript();

			if (!pythonPath || !scriptPath) {
				try {
					const global = require('./global');
					global.logMessage(`[Broker] Missing path: python=${!!pythonPath}, script=${!!scriptPath}`, "WARN");
				} catch { }
				// 清理 spawn qlok
				try { fs.unlinkSync(spawnQlokPath); } catch { }
				resolve();
				return;
			}

			// ★ Verify script exists before spawning
			if (!fs.existsSync(scriptPath)) {
				try {
					const global = require('./global');
					global.logMessage(`[Broker] Script not found: ${scriptPath}`, "WARN");
				} catch { }
				// 清理 spawn qlok
				try { fs.unlinkSync(spawnQlokPath); } catch { }
				resolve();
				return;
			}

			try {
				// ★ Fix: Use DaemonBridge pattern (NO detached on Windows)
				// Old py daemon & Rust daemon work because they DON'T use detached:true
				// detached:true changes Windows process behavior and breaks pywin32 Named Pipe
				const isWin = process.platform === 'win32';
				let child;

				if (isWin) {
					// ★ Windows: Match working Rust daemon spawn pattern exactly
					child = cp.spawn(pythonPath, [scriptPath, '--broker'], {
						stdio: ['pipe', 'pipe', 'pipe'],  // ★ Full stdio pipes like Rust
						windowsHide: true,               // ★ Hide console window
						// NO detached: true!  This is the key fix.
						env: { ...process.env, Q_PARENT_PID: String(process.pid) }  // ★ For orphan detection
					});
				} else {
					// Unix: detached + setsid for true daemon behavior
					child = cp.spawn(pythonPath, [scriptPath, '--broker'], {
						detached: true,
						stdio: ['ignore', 'ignore', 'pipe'],
					});
					child.unref();  // Only unref on Unix
				}

				const actualPythonPath = pythonPath;

				// ★ Spawn 成功日志
				try {
					const global = require('./global');
					global.logMessage(`[Broker] Spawned Python Broker, PID=${child.pid}, exe=${actualPythonPath}`, "DEBUG");
				} catch { }

				// ★ 捕获 stdout 和 stderr（3秒内的打印）
				let stderrBuf = '';
				let stdoutBuf = '';
				if (child.stdout) {
					child.stdout.on('data', (chunk) => {
						stdoutBuf += chunk.toString();
						if (stdoutBuf.length > 2000) stdoutBuf = stdoutBuf.slice(-2000);
					});
				}
				if (child.stderr) {
					child.stderr.on('data', (chunk) => {
						stderrBuf += chunk.toString();
						if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-2000);
					});
				}

				// ★ 监听退出事件（前 3 秒的快速失败诊断）
				const exitHandler = (code, signal) => {
					try {
						const global = require('./global');
						const errSnip = stderrBuf ? stderrBuf.trim().split('\n').slice(-5).join(' | ') : '';
						const outSnip = stdoutBuf ? stdoutBuf.trim().split('\n').slice(-3).join(' | ') : '';
						const combined = [errSnip, outSnip].filter(Boolean).join(' || ') || 'no output';
						// ★ 只记录异常退出
						if (code !== 0 && code !== null) {
							global.logMessage(`[Broker] Python exited(${code}): ${combined}`, "WARN");
						} else if (signal) {
							global.logMessage(`[Broker] Python killed by signal: ${signal}`, "WARN");
						}
					} catch { }
				};
				child.once('exit', exitHandler);

				// ★ 3秒后断开 stdout/stderr 监听，让进程独立运行，并清理 spawn qlok
				setTimeout(() => {
					try {
						child.stdout?.removeAllListeners();
						child.stdout?.destroy();
						child.stderr?.removeAllListeners();
						child.stderr?.destroy();
						child.removeListener('exit', exitHandler);
					} catch { }
					// 清理 spawn qlok（Broker 应该已经启动）
					try { fs.unlinkSync(spawnQlokPath); } catch { }
				}, 3000);

				// ★ Note: Windows does NOT use unref() - child stays attached
				// This means VS Code process may wait for Broker on exit
				// But Broker has TTL auto-shutdown, so this is acceptable
				// Unix already called unref() in the else branch above
			} catch (e) {
				// Spawn failed - log for debugging
				try {
					const global = require('./global');
					global.logMessage(`[Broker] Spawn failed: ${e.message}`, "WARN");
				} catch { }
				// 清理 spawn qlok
				try { fs.unlinkSync(spawnQlokPath); } catch { }
			}

			resolve();
		}).finally(() => {
			this.spawning = null;
		});

		return this.spawning;
	}

	/**
	 * ★ 完美性检查：验证 Python 环境在 spawn 前是否就绪
	 * 优先检查 _downloadedPythonPath（已被 onPythonReady 设置说明检查已通过）
	 */
	async _checkPythonPerfect() {
		// ★ 如果 _downloadedPythonPath 已设置，说明完美性检查早已通过
		// （它只有在 checkL1Perfect 返回 perfect 时才会被 global.js 设置）
		if (this._downloadedPythonPath && fs.existsSync(this._downloadedPythonPath)) {
			return { ok: true, pythonPath: this._downloadedPythonPath };
		}

		// 否则尝试调用 checkL1Perfect（可能 context 还没准备好）
		try {
			const global = require('./global');
			const downloader = global.downloader;
			const context = global.extensionContext;

			if (!downloader || !downloader.python || !context) {
				// context 未就绪，但 _downloadedPythonPath 也没设置 => Python 真的没准备好
				return { ok: false, reason: 'python_not_downloaded' };
			}

			const result = await downloader.python.checkL1Perfect(context);
			if (result.perfect) {
				return { ok: true, pythonPath: result.pythonPath };
			}
			return { ok: false, reason: result.reason, missing: result.missing || [] };
		} catch (e) {
			return { ok: false, reason: `check_error: ${e.message}` };
		}
	}

	_findPythonAndScript() {
		// Find kp.py script
		let scriptPath = null;
		if (this.extensionPath) {
			const distScript = path.join(this.extensionPath, 'dist', 'kp.py');
			const srcScript = path.join(this.extensionPath, 'src', 'kp.py');

			if (fs.existsSync(distScript)) {
				scriptPath = distScript;
			} else if (fs.existsSync(srcScript)) {
				scriptPath = srcScript;
			}
		}

		// Find Python executable:
		// ★ 只认 dow.js 下载的 globalStorage/python_engine，不使用系统Python
		let pythonPath = null;

		// ★ Use path from dow.js (globalStorage/python_engine)
		if (this._downloadedPythonPath && fs.existsSync(this._downloadedPythonPath)) {
			pythonPath = this._downloadedPythonPath;
		}

		// 如果 Python 不可用，pythonPath 为 null，调用方会处理（不启动 Broker）

		return { pythonPath, scriptPath };
	}

	// =========================================================================
	// Deferred Reconnect (cold-start recovery)
	// =========================================================================

	_startDeferredReconnect() {
		if (this._deferredTimer) return; // 已经在重连中
		let attempt = 0;
		this._deferredTimer = setInterval(async () => {
			attempt++;
			if (attempt > DEFERRED_RECONNECT_MAX || this.isAvailable()) {
				clearInterval(this._deferredTimer);
				this._deferredTimer = null;
				return;
			}
			try {
				const ok = await this._tryConnectOnce();
				if (ok) {
					try { const global = require('./global'); global.logMessage(`[Broker] Deferred reconnect succeeded (attempt ${attempt})`, "INFO"); } catch { }
					this._startHeartbeat();
					this.emit('event', { event: 'broker_connected' });
					clearInterval(this._deferredTimer);
					this._deferredTimer = null;
				}
			} catch { }
		}, DEFERRED_RECONNECT_INTERVAL_MS);
	}

	// =========================================================================
	// Passive Reconnect (cross-window sync for idle windows)
	// =========================================================================

	/**
	 * ★ 被动重连：供 5 秒状态栏定时器调用
	 * 当窗口未连接但 Broker 已被其他窗口启动时，静默连接
	 * 解决：非活跃窗口状态栏一直显示 "R" 而非 "RP" 的问题
	 */
	async tryPassiveReconnect() {
		// 已连接 or 正在启动 → 跳过
		if (this.isAvailable() || this.isStarting) return false;
		// deferred reconnect 仍在运行 → 让它处理
		if (this._deferredTimer) return false;
		// 冷却：30 秒内不重复尝试
		const now = Date.now();
		if (now - (this._lastPassiveReconnectAt || 0) < 30000) return false;
		this._lastPassiveReconnectAt = now;

		// 检查 endpoint.json 是否存在（说明 Broker 已在运行）
		const cacheDir = getCacheDir();
		const endpointPath = path.join(cacheDir, ENDPOINT_FILENAME);
		if (!fs.existsSync(endpointPath)) return false;

		// 尝试连接
		try {
			const ok = await this._tryConnectOnce();
			if (ok) {
				try { const global = require('./global'); global.logMessage(`[Broker] Passive reconnect succeeded (idle window)`, "INFO"); } catch { }
				this._startHeartbeat();
				this.emit('event', { event: 'broker_connected' });
				return true;
			}
		} catch { }
		return false;
	}

	// =========================================================================
	// Heartbeat
	// =========================================================================

	_startHeartbeat() {
		if (this.hbTimer) return;

		this._heartbeatFailCount = 0; // Track consecutive failures

		this.hbTimer = setInterval(async () => {
			try {
				if (!this.isAvailable()) {
					// Try to reconnect
					await this.start();
				}
				await this.call('ping', {}, 5000);
				this._heartbeatFailCount = 0; // Reset on success
			} catch (e) {
				this._heartbeatFailCount++;
				// Log only on first failure and every 10th failure (rate limited)
				if (this._heartbeatFailCount === 1 || this._heartbeatFailCount % 10 === 0) {
					// Avoid circular require at top level
					try {
						const global = require('./global');
						global.logMessage(`[Broker] Heartbeat failed (count=${this._heartbeatFailCount}): ${e.message}`, "WARN");
					} catch { }
				}
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	stopHeartbeat() {
		if (this.hbTimer) {
			clearInterval(this.hbTimer);
			this.hbTimer = null;
		}
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	_sleep(ms) {
		return new Promise(r => setTimeout(r, ms));
	}
}

module.exports = { BrokerBridge };

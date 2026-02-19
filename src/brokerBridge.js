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
const CONNECT_RETRY_DELAY_BASE_MS = 120;

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
		if (await this._tryConnectOnce()) {
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
		return false;
	}

	async _tryConnectOnce() {
		const cacheDir = getCacheDir();
		const endpointPath = path.join(cacheDir, ENDPOINT_FILENAME);
		const tokenPath = path.join(cacheDir, TOKEN_FILENAME);

		const endpoint = readJsonFile(endpointPath);
		const token = readTextFile(tokenPath);

		if (!endpoint || !token) {
			return false;
		}

		if (endpoint.app_id !== APP_ID) {
			return false;
		}

		// Determine connection path
		let connPath;
		if (endpoint.family === 'unix') {
			connPath = endpoint.path;
		} else if (endpoint.family === 'pipe') {
			// Python uses 'name' field for pipe name, not 'pipe'
			connPath = endpoint.name || endpoint.pipe;
		} else {
			// Unsupported family (tcp not supported via net.connect({path}))
			return false;
		}

		if (!connPath) return false;

		// Try to connect
		const canConnect = await new Promise((resolve) => {
			const s = net.connect({ path: connPath });
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
		return await this._openAndHello(connPath, token, endpoint);
	}

	async _openAndHello(connPath, token, endpoint) {
		this.closeSocket();

		const s = net.connect({ path: connPath });
		this.socket = s;
		this.token = token;
		this.endpoint = endpoint;

		s.setKeepAlive(true);
		s.on('data', (buf) => this._onData(buf));
		s.on('error', () => this._onDisconnected());
		s.on('close', () => this._onDisconnected());

		const connected = await new Promise((resolve) => {
			s.once('connect', () => resolve(true));
			s.once('error', () => resolve(false));
			setTimeout(() => resolve(false), 3000);
		});

		if (!connected) {
			this.closeSocket();
			return false;
		}

		// Verify with hello
		try {
			const res = await this.call("hello", {}, 3000);
			if (!res || res.ok !== true || res.app_id !== APP_ID) {
				this.closeSocket();
				return false;
			}
			this.connected = true;
			this.available = true;
			this.lastStartError = "";
			return true;
		} catch {
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
		if (this.spawning) return this.spawning;

		// 3s cooldown per window
		if (now - this.lastSpawnAt < 3000) return;

		this.lastSpawnAt = now;

		this.spawning = new Promise(async (resolve) => {
			// ★ OPTIMIZATION: Random delay (0-2s) to stagger multi-window spawns
			// This reduces the chance of 8 windows spawning 8 Python processes simultaneously
			// Most will find existing Broker after the first one succeeds
			const randomDelayMs = Math.floor(Math.random() * 6000);
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

			// Find Python executable and script
			const { pythonPath, scriptPath } = this._findPythonAndScript();

			if (!pythonPath || !scriptPath) {
				resolve();
				return;
			}

			// ★ Verify script exists before spawning
			if (!fs.existsSync(scriptPath)) {
				try {
					const global = require('./global');
					global.logMessage(`[Broker] Script not found: ${scriptPath}`, "WARN");
				} catch { }
				resolve();
				return;
			}

			try {
				const child = cp.spawn(pythonPath, [scriptPath, '--broker'], {
					detached: true,
					stdio: 'ignore',
					windowsHide: true
				});

				child.unref();
			} catch (e) {
				// Spawn failed - log for debugging
				try {
					const global = require('./global');
					global.logMessage(`[Broker] Spawn failed: ${e.message}`, "WARN");
				} catch { }
			}

			resolve();
		}).finally(() => {
			this.spawning = null;
		});

		return this.spawning;
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

		// Find Python executable (priority order):
		// 1. _downloadedPythonPath from dow.js (most reliable, respects download state)
		// 2. Bundled python_engine directory
		// 3. System python (fallback)
		let pythonPath = null;

		// ★ Priority 1: Use path from dow.js if available
		if (this._downloadedPythonPath && fs.existsSync(this._downloadedPythonPath)) {
			pythonPath = this._downloadedPythonPath;
		}

		// ★ Priority 2: Bundled python_engine
		if (!pythonPath && this.extensionPath) {
			const engineDir = path.join(this.extensionPath, 'python_engine');
			if (process.platform === 'win32') {
				const winPy = path.join(engineDir, 'python.exe');
				if (fs.existsSync(winPy)) pythonPath = winPy;
			} else {
				const unixPy = path.join(engineDir, 'bin', 'python3');
				if (fs.existsSync(unixPy)) pythonPath = unixPy;
			}
		}

		// ★ Priority 3: System python (fallback)
		if (!pythonPath) {
			pythonPath = process.platform === 'win32' ? 'python' : 'python3';
		}

		return { pythonPath, scriptPath };
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
						global.logMessage(`[Broker] Heartbeat failed (count=${this._heartbeatFailCount}): ${e.message}`, "DEBUG");
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

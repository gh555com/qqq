// src/global.js - Global state, logging, and dialog management
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const os = require("os");
const readline = require("readline");
const crypto = require("crypto");
const { q } = require('./i18n');
const { BrokerBridge } = require('./brokerBridge');

const NO_TRACK_ENV = { ...process.env, QQQ_NO_TRACK: "1" };

// ============================================================================
// ★ 引擎可用时间戳追踪（用于状态栏按检测顺序显示引擎标签）
// ============================================================================
const _engineAvailableTimestamps = { R: 0, P: 0, N: 0 };

function recordEngineAvailable(engineKey) {
	if (_engineAvailableTimestamps[engineKey] === 0) {
		_engineAvailableTimestamps[engineKey] = Date.now();
	}
}

function clearEngineAvailable(engineKey) {
	_engineAvailableTimestamps[engineKey] = 0;
}

function getEngineTagByOrder() {
	// 过滤出已可用的引擎（时间戳 > 0），按时间戳排序
	const available = Object.entries(_engineAvailableTimestamps)
		.filter(([_, ts]) => ts > 0)
		.sort((a, b) => a[1] - b[1])
		.map(([key]) => key);
	return available.join('');
}

// ============================================================================
// ★ Daemon Bridge (migrated from qqq.js)
// ============================================================================
const EventEmitter = require('events');

class DaemonBridge extends EventEmitter {
	constructor(name, startFn) {
		super();
		this.name = name;
		this.startFn = startFn;
		this.process = null;
		this.pending = new Map();
		this.requestId = 0;
		this.isStarting = false;
		this.startPromise = null;
		this.restartCount = 0;
		this.maxRestarts = 3;
		this.available = null;

		this._stopping = false;

		// ★ Failure reason collection (for tooltip + err.log)
		this.lastStartError = "";
		this.lastCrashReason = "";
		this.lastStderrSnippet = "";

		// ★ DoS protection: if crashes >5 times within 1 minute, permanently disable
		this.recentCrashes = [];
		this.isPermDisabled = false;
	}

	_setStartError(msg) {
		this.lastStartError = cleanReason(msg || "");
	}

	_appendStderrSnippet(text) {
		const t = String(text || "").trim();
		if (!t) return;
		const next = (this.lastStderrSnippet ? this.lastStderrSnippet + "\n" : "") + t;
		this.lastStderrSnippet = next.slice(-2000);
	}

	async start() {
		this._stopping = false;

		// Prevent re-entrancy
		if (this.isStarting) return this.startPromise;

		// Check existing process: only available === true is considered healthy
		if (this.process && !this.process.killed) {
			if (this.available === true) return true;
			// Process exists but unavailable, kill and restart
			try { this.process.kill(); } catch { }
			this.process = null;
		}

		this.isStarting = true;
		const currentSession = Date.now();
		this._currentStartSession = currentSession;

		this.startPromise = (async () => {
			try {
				if (this.process && !this.process.killed && this.available === true) return true;
				const result = await this.startFn(this);
				if (this._currentStartSession !== currentSession) return false;
				return result;
			} finally {
				if (this._currentStartSession === currentSession) {
					this.isStarting = false;
					this.startPromise = null;
				}
			}
		})();

		return this.startPromise;
	}

	setupProcess(proc, resolve) {
		this.process = proc;
		this.available = null; // ★ Reset available during startup to allow ping

		const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => {
			try {
				if (!line || !line.trim()) return;

				let result;
				try {
					result = JSON.parse(line);
				} catch (e) {
					// Try Base64 decode (PowerShell mode output is Base64-wrapped)
					try {
						const decoded = Buffer.from(line, "base64").toString("utf8");
						result = JSON.parse(decoded);
					} catch (e2) {
						throw e;
					}
				}

				const id = result._id;

				// ★ Added: handle async events (no _id or explicitly marked as event)
				if (id === undefined || result.event) {
					this.emit("event", result);
					return;
				}

				if (result.error) logMessage(q('bridge.errorResponse', this.name, result.error), "WARN");

				if (this.pending.has(id)) {
					const { resolve: res, timer } = this.pending.get(id);
					clearTimeout(timer);
					this.pending.delete(id);
					res(result);
				}
			} catch (e) {
				logMessage(`${this.name} stdout: ${line}`, "WARN");
			}
		});

		proc.stderr.on("data", (d) => {
			const text = d?.toString?.() || "";
			this._appendStderrSnippet(text);
			const key = bridgeStderrKey(this.name, text);
			logMessageRateLimited(key, `${this.name} stderr: ${text}`, "WARN", 300000);
		});

		proc.on("error", (err) => {
			if (this.process !== proc) return;
			logMessage(q('bridge.processError', this.name, err.message), "ERROR");
			this.lastCrashReason = cleanReason(err.message);
			this._handleCrash();
		});
		proc.on("close", (code) => {
			if (this.process !== proc) return;
			logMessage(q('bridge.processClose', this.name, code), "INFO");
			this.lastCrashReason = cleanReason(`exit_code=${code}`);
			this._handleCrash();
		});

		// Implement ping retry logic, up to 15 attempts, totaling about 7.5 seconds
		let pingAttempts = 0;
		const maxPingAttempts = 15;
		const pingInterval = 500; // 500ms between pings
		const pingTimeout = 5000; // Increase ping timeout to 5 seconds

		const attemptPing = async () => {
			pingAttempts++;
			try {
				const pong = await this.call("ping", {}, 3000);
				if (pong?.status === "alive") {
					this.restartCount = 0;
					this.available = true;
					// ★ 记录引擎可用时间戳（用于状态栏按检测顺序显示）
					if (this.name === "Rust") recordEngineAvailable("R");
					else if (this.name === "Shell") recordEngineAvailable("N");
					this._setStartError("");
					invalidateEngineCache(); // ★ Engine state changed, clear cache
					logMessage(`${this.name} bridge started and handshaked`, "INFO");
					resolve(true);
					return true;
				} else {
					logMessage(`${this.name} ping response invalid: ${JSON.stringify(pong)}`, "WARN");
				}
			} catch (e) { }

			if (pingAttempts < maxPingAttempts) {
				setTimeout(attemptPing, 200);
				return;
			}

			// All ping attempts failed
			const reason = `ping_failed_after_${maxPingAttempts}_attempts${this.lastStderrSnippet ? ` ; stderr=${this.lastStderrSnippet}` : ""}`;
			this._setStartError(reason);
			logMessage(q('bridge.pingFailed', this.name, maxPingAttempts), "WARN");
			this.available = false;
			try { proc.kill(); } catch { }
			this.process = null;
			resolve(false);
		};

		// Start ping attempts with an initial 100ms delay to give the process time to boot
		setTimeout(attemptPing, 100);
	}

	_handleCrash() {
		this.process = null;
		invalidateEngineCache(); // ★ Engine crashed, clear cache

		// ★ 清除引擎可用时间戳（状态栏会反映实际能力）
		if (this.name === "Rust") clearEngineAvailable("R");
		else if (this.name === "Shell") clearEngineAvailable("N");

		// ★ 延迟更新状态栏（避免在 crash 重启循环中频繁更新）
		setTimeout(() => {
			if (typeof updateStatusBarNow === 'function') updateStatusBarNow();
		}, 100);

		// ★ Emit crash event so UI layer can react
		this.emit("event", { event: "process_crashed", bridge: this.name });

		for (const [id, { resolve, timer }] of this.pending) {
			clearTimeout(timer);
			resolve({ error: "process_crashed" });
		}
		this.pending.clear();

		if (this._stopping) {
			this.available = false;
			return;
		}

		if (this.isPermDisabled) {
			this.available = false;
			return;
		}

		// ★ DoS check
		const now = Date.now();
		this.recentCrashes.push(now);
		this.recentCrashes = this.recentCrashes.filter(t => now - t < 60000); // Keep only last 1 minute

		if (this.recentCrashes.length > 5) {
			this.isPermDisabled = true;
			this.available = false;
			const msg = q('bridge.circuitBreaker', this.name);
			this._setStartError(msg);
			logMessage(msg, "ERROR");

			// ★ Shell Daemon fatal error modal
			if (this.name === "Shell") {
				showErrorMessage(
					q('bridge.shellDaemonCrash'),
					{
						modal: true,
						detail: q('bridge.shellDaemonDetail')
					},
					q('bridge.restartWindow')
				).then(selection => {
					if (selection === q('bridge.restartWindow')) {
						vscode.commands.executeCommand("workbench.action.reloadWindow");
					}
				});
			}

			return;
		}

		if (this.restartCount < this.maxRestarts) {
			this.restartCount++;
			// Exponential backoff: start at 50ms, retry fast
			const backoff = 50 * Math.pow(2, this.restartCount - 1);
			logMessage(q('bridge.crashRestart', this.name, this.restartCount, this.maxRestarts, backoff), "WARN");

			// ★ Industrial-grade fix: ensure available isn't false, otherwise start() checks may block restart
			this.available = null;

			setTimeout(() => {
				logMessage(q('bridge.restarting', this.name), "INFO");
				this.start().then(ok => {
					if (ok) {
						logMessage(q('bridge.restartSuccess', this.name), "INFO");
					} else {
						logMessage(q('bridge.restartFailed', this.name), "WARN");
					}
				}).catch(e => {
					logMessage(q('bridge.restartException', this.name, e?.message || e), "ERROR");
				});
			}, backoff);
		} else {
			logMessage(q('bridge.maxRestartsReached', this.name), "ERROR");
			this.available = false;

			// ★ Shell Daemon privilege: infinite revive
			if (this.name === "Shell") {
				logMessage(q('bridge.forceRevive', this.name), "WARN");
				this.restartCount = 0; // Reset count to allow restart loop again
				setTimeout(() => this.start(), 3000);
			}
		}
	}

	async call(action, params = {}, timeout = 5000) {
		if (_isDeactivated) {
			return { error: "extension_deactivated" };
		}
		if (this.isPermDisabled) {
			return { error: `${this.name}_disabled_too_many_crashes` };
		}

		// ★ Multi-window SFX deduplication: only one window plays within 300ms
		if (action === 'play_sfx' || action === 'play_audio') {
			const dedupKey = `sfx_${action}_${params.category || ''}_${params.name || params.path || ''}`;
			const lastTime = extensionContext?.globalState?.get(dedupKey, 0) || 0;
			if (Date.now() - lastTime < 300) {
				return { status: 'ok', deduplicated: true };
			}
			extensionContext?.globalState?.update(dedupKey, Date.now());
		}

		// ★ Industrial-grade fix: if engine is known unavailable, don't keep trying to start
		// available === false means confirmed failure/crash; should not retry on every call
		// Only startDaemons or explicit restart should retry
		if (this.available === false) {
			return { error: `${this.name}_not_available` };
		}

		if (!this.process || this.process.killed) {
			const started = await this.start();
			if (!started) return { error: `${this.name}_not_available` };
		}

		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					resolve({ error: "timeout" });
				}
			}, timeout);

			this.pending.set(id, { resolve, timer });

			try {
				this.process.stdin.write(cmd);
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ error: "write_error" });
			}
		});
	}

	/**
	 * Check if daemon process is alive
	 */
	isAlive() {
		return !!(this.process && !this.process.killed && this.available === true);
	}

	isAvailable() {
		return this.available === true;
	}

	async stop() {
		this._stopping = true;

		for (const [id, { resolve, timer }] of this.pending) {
			clearTimeout(timer);
			resolve({ error: "stopped" });
		}
		this.pending.clear();

		// ★ 清除引擎可用时间戳（stop 时也要清除）
		if (this.name === "Rust") clearEngineAvailable("R");
		else if (this.name === "Shell") clearEngineAvailable("N");

		if (!this.process) {
			this.available = false;
			this.restartCount = 0;
			return;
		}

		if (!this.process.killed) {
			// Graceful negotiated exit
			let exitedCleanly = false;
			try {
				const exitCmd = JSON.stringify({ _id: 0, action: "exit" }) + "\n";
				if (this.process.stdin && !this.process.stdin.destroyed) {
					this.process.stdin.write(exitCmd);
				}
				const exitPromise = new Promise(resolve => {
					this.process.once('exit', () => resolve(true));
					this.process.once('close', () => resolve(true));
				});
				const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(false), 1000));
				exitedCleanly = await Promise.race([exitPromise, timeoutPromise]);
			} catch (e) { }

			if (!exitedCleanly) {
				// Force exit
				try {
					if (process.platform === "win32") {
						try { cp.execSync(`taskkill /pid ${this.process.pid} /T /F`); } catch { }
					} else {
						this.process.kill("SIGKILL");
					}
				} catch { }
			}
		}

		this.process = null;
		this.available = false;
		this.restartCount = 0;
	}
}

// ============================================================================
// ★ Bridge Instances & Management
// ============================================================================

// ★ Python bridge: Now uses BrokerBridge for IPC Broker singleton mode
// - All VS Code windows (across multiple AI IDEs) share ONE Python Broker process
// - Handles: clipboard watching, audio playback, savoring
// - Uses endpoint.json + token.txt for discovery and authentication
const pythonBridge = new BrokerBridge("Python");

// ★ Listen for Broker events to refresh engine cache
pythonBridge.on('event', (evt) => {
	if (evt.event === 'broker_connected') {
		logMessage("[Broker] Connected, refreshing engine cache", "DEBUG");
		invalidateEngineCache();
		recordEngineAvailable("P"); // ★ 记录 Python 引擎可用时间戳
	} else if (evt.event === 'broker_disconnected') {
		logMessage("[Broker] Disconnected", "DEBUG");
		invalidateEngineCache();
		clearEngineAvailable("P"); // ★ 清除 Python 引擎可用时间戳
	}
});

// Initialize pythonBridge with extension path and Python downloader integration
function initPythonBrokerBridge() {
	if (!extensionContext || pythonBridge.extensionPath !== "") return;

	// ★ excludePython: skip Python Broker entirely
	if (getEnginePreference() === 'excludePython') {
		logMessage("[Broker] Exclude Python mode - Python Broker disabled", "INFO");
		return;
	}

	pythonBridge.extensionPath = extensionContext.extensionPath;
	logMessage("[Broker] pythonBridge.extensionPath initialized", "DEBUG");

	// ★ CRITICAL: Integrate with Python downloader (dow.js)
	// This ensures Python environment is ready before spawning Broker
	(async () => {
		try {
			const { getSharedDownloader } = require("./dow");
			const downloader = getSharedDownloader();

			// ★ Register hot-start callback: when Python download completes, refresh caches
			downloader.python.onPythonReady(async (pythonPath, context) => {
				logMessage(`[Broker] Python ready callback triggered: ${pythonPath}`, "INFO");

				// ★ Refresh engine cache (important!)
				invalidateEngineCache();

				// ★ Reset Python audio engine cache
				try {
					const qqq = require('./qqq');
					if (qqq.resetPythonAudioCache) {
						qqq.resetPythonAudioCache();
						logMessage("[Broker] Audio cache reset (qqq)", "INFO");
					}
				} catch (e) {
					logMessage(`[Broker] Audio cache reset error (qqq): ${e.message}`, "WARN");
				}

				// ★ Reset Q4 audio source state
				try {
					const q4 = require('./q4');
					if (q4.resetQ4AudioSource) {
						q4.resetQ4AudioSource();
						logMessage("[Broker] Audio cache reset (q4)", "INFO");
					}
				} catch (e) {
					logMessage(`[Broker] Audio cache reset error (q4): ${e.message}`, "WARN");
				}

				// ★ If Broker not connected yet, try to start it now with correct Python path
				if (!pythonBridge.isAvailable()) {
					logMessage("[Broker] Attempting to start Broker after Python ready...", "INFO");
					pythonBridge._downloadedPythonPath = pythonPath;
					try {
						const ok = await pythonBridge.start();
						if (ok) {
							logMessage("[Broker] Broker hot-started successfully", "INFO");
							invalidateEngineCache();
						}
					} catch (e) {
						logMessage(`[Broker] Broker hot-start failed: ${e.message}`, "WARN");
					}
				}
			});

			// ★ Check current Python status (triggers download if needed)
			const pythonPath = await downloader.ensurePythonReady(extensionContext);
			if (pythonPath) {
				pythonBridge._downloadedPythonPath = pythonPath;
			} else {
				logMessage("[Broker] Python L1 imperfect, waiting for download...", "INFO");
			}
		} catch (e) {
			logMessage(`[Broker] Python downloader integration error: ${e.message}`, "WARN");
		}
	})();
}

// Rust bridge
const rustBridge = new DaemonBridge("Rust", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		// ★ 统一使用 q_engine 文件名，平台特定 vsix 打包时会将对应二进制复制为此名
		const filename = platform === "win32" ? "q_engine.exe" : "q_engine";

		const assetsDir = path.join(extensionContext.extensionPath, "assets");
		const exePath = path.join(assetsDir, filename);

		if (!fs.existsSync(exePath)) {
			bridge._setStartError(`exe_not_found: ${filename}`);
			logMessage(q('rust.exeNotFound'), "WARN");
			bridge.available = false;
			resolve(false);
			return;
		}

		// ★ Win7/8 兼容：复制 VC++ 运行库到 assets 目录
		if (platform === "win32") {
			try {
				const arch = process.arch === "x64" ? "x64" : "x86";
				const runtimesDir = path.join(assetsDir, "runtimes", arch);
				if (fs.existsSync(runtimesDir)) {
					const dlls = fs.readdirSync(runtimesDir).filter(f => f.endsWith(".dll"));
					for (const dll of dlls) {
						const src = path.join(runtimesDir, dll);
						const dst = path.join(assetsDir, dll);
						if (!fs.existsSync(dst)) {
							fs.copyFileSync(src, dst);
							logMessage(`[Rust] Copied ${dll} to assets`, "DEBUG");
						}
					}
				}
			} catch (e) {
				logMessage(`[Rust] Failed to copy VC++ runtime: ${e.message}`, "WARN");
			}
		}

		// ★ Multi-instance fix: remove system-level singleton check
		// Each IDE instance runs its own daemon independently, no interference
		(async () => {
			try {
				logMessage(q('rust.tryStart', exePath), "INFO");
				const proc = cp.spawn(exePath, ["--daemon"], {
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
					// ★ Industrial-grade fix: pass parent PID for daemon watchdog to detect parent death
					env: { ...process.env, Q_PARENT_PID: String(process.pid) }
				});

				proc.once("error", (err) => {
					bridge._setStartError(`process_error: ${err.message}`);
					logMessage(q('rust.processError', err.message), "WARN");
					bridge.available = false;
					resolve(false);
				});

				bridge.setupProcess(proc, (ok) => {
					if (ok) {
						logMessage(q('rust.startSuccess'), "INFO");
						resolve(true);
					} else {
						logMessage(q('rust.startFailed', bridge.lastStartError || "unknown"), "WARN");
						resolve(false);
					}
				});
			} catch (e) {
				bridge._setStartError(`start_exception: ${e.message}`);
				logMessage(q('rust.startException', e.message), "ERROR");
				bridge.available = false;
				resolve(false);
			}
		})();  // ★ End async IIFE
	});  // ★ End Promise
});  // ★ End DaemonBridge

// Shell bridge
const shellBridge = new DaemonBridge("Shell", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		let proc = null;

		if (platform === "win32") {
			let clipboardHelperCode = "";
			try { clipboardHelperCode = require("./h").CLIPBOARD_HELPER_CS; } catch (e) { }

			const simplePsScript = `
# --- Optimized PowerShell Daemon ---
# ★ Win7 兼容: 检测 PowerShell 版本，低于 3.0 无法使用 ConvertTo-Json
if ($PSVersionTable.PSVersion.Major -lt 3) {
  [Console]::Error.WriteLine("PowerShell version too low: $($PSVersionTable.PSVersion). Requires 3.0+")
  exit 1
}

# Ensure all output uses UTF-8 encoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

# Load basic components (faster)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Ensure-ClipboardHelper {
  if (-not ([System.Management.Automation.PSTypeName]'ClipboardHelper').Type) {
    try {
      $code = @'
${clipboardHelperCode}
'@
      Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies "System.Drawing", "System.Windows.Forms"
    } catch {
      Write-Warning "Helper injection failed: $($_.Exception.Message)"
    }
  }
}

function Process-Command {
  param($cmd)
  $result = @{ _id = $cmd._id }
  try {
    switch ($cmd.action) {
      'ping' { $result.status = 'alive' }
      'warmup' {
         Ensure-ClipboardHelper
         $result.status = 'warmed'
      }
      'dumpHtmlToFile' {
         try {
             Ensure-ClipboardHelper
             if (([System.Management.Automation.PSTypeName]'ClipboardHelper').Type) {
                $res = [ClipboardHelper]::DumpHtmlToFile($cmd.path)
                if ($res -eq "Success") { $result.success = $true }
                else { $result.success = $false; $result.error = $res }
             } else { throw "Helper not available" }
         } catch {
             $result.success = $false
             $result.error = $_.Exception.Message
         }
      }
      'wq' {
        $formats = [System.Windows.Forms.Clipboard]::GetDataObject().GetFormats()
        $result.hasFile = $formats -contains "FileDrop"
        $result.hasHtml = $formats -contains "HTML Format"
        $result.hasImage = ($formats -contains "Bitmap") -or ($formats -contains "DeviceIndependentBitmap") -or ($formats -contains "PNG")
        $result.hasText = ($formats -contains "UnicodeText") -or ($formats -contains "Text")
      }
      'hasImage' {
        $val = [System.Windows.Forms.Clipboard]::ContainsImage()
        $result.value = $val
      }
      'hasFiles' {
        $val = [System.Windows.Forms.Clipboard]::ContainsFileDropList()
        $result.value = $val
      }
      'hasHtml' {
        $val = [System.Windows.Forms.Clipboard]::ContainsText([System.Windows.Forms.TextDataFormat]::Html)
        $result.value = $val
      }
      'getFiles' {
        $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
        $result.files = @()
        if ($files) { foreach ($f in $files) { $result.files += $f } }
      }
      'setFiles' {
        try {
            if (([System.Management.Automation.PSTypeName]'ClipboardHelper').Type) {
                $res = [ClipboardHelper]::SetFiles($cmd.paths)
                if ($res -eq "Success") { $result.success = $true; return }
            }
            # Fallback to pure PS
            $files = New-Object System.Collections.Specialized.StringCollection
            foreach ($p in $cmd.paths) { [void]$files.Add($p) }
            [System.Windows.Forms.Clipboard]::SetFileDropList($files)
            $result.success = $true
        } catch {
            try {
                $files = New-Object System.Collections.Specialized.StringCollection
                foreach ($p in $cmd.paths) { [void]$files.Add($p) }
                [System.Windows.Forms.Clipboard]::SetFileDropList($files)
                $result.success = $true
            } catch {
                $result.success = $false
                $result.error = $_.Exception.Message
            }
        }
      }
      'saveImage' {
        try {
            if (([System.Management.Automation.PSTypeName]'ClipboardHelper').Type) {
                $res = [ClipboardHelper]::SaveClipboardImage($cmd.path)
                if ($res -ne $null -and $res.StartsWith("{")) {
                    $p = $res | ConvertFrom-Json
                    if (-not $p.error) { $result.success = $true; return }
                }
            }
            # Fallback to pure PS
            $img = [System.Windows.Forms.Clipboard]::GetImage()
            if ($img) { $img.Save($cmd.path, [System.Drawing.Imaging.ImageFormat]::Png); $result.success = $true }
            else { $result.success = $false }
        } catch {
             try {
                $img = [System.Windows.Forms.Clipboard]::GetImage()
                if ($img) { $img.Save($cmd.path, [System.Drawing.Imaging.ImageFormat]::Png); $result.success = $true }
                else { $result.success = $false }
             } catch {
                $result.success = $false
                $result.error = $_.Exception.Message
             }
        }
      }
      'extract_icon' {
         try {
             # Ensure the C# Helper is loaded (IconHelper and ClipboardHelper are in the same code block)
             Ensure-ClipboardHelper
             # Prefer high-quality extraction via C#
             # Ensure path uses correct Unicode encoding
             $iconB64 = [IconHelper]::GetIconBase64($cmd.path)
             if ($iconB64) {
                 $result.icon = $iconB64
                 $result.status = 'ok'
             } else {
                 throw "C# extraction failed"
             }
         } catch {
             # Fallback: pure PowerShell native approach (only gets file association icon)
             try {
                 $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($cmd.path)
                 if ($icon) {
                     $ms = New-Object System.IO.MemoryStream
                     $bmp = $icon.ToBitmap()
                     $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                     $result.icon = [Convert]::ToBase64String($ms.ToArray())
                     $result.status = 'ok'
                     $bmp.Dispose(); $icon.Dispose(); $ms.Dispose()
                 } else { $result.status = 'error' }
             } catch {
                 $result.status = 'error'
                 $result.message = $_.Exception.Message
             }
         }
      }
      'trigger_system_paste' {
        try {
          $rawPath = $cmd.path -replace '/', '\'
          $cleanPath = $rawPath.TrimEnd('\')

          # Check if this is a dot-ending path
          $hasDotPath = $cleanPath.EndsWith('.') -or $cleanPath.Contains('.\\')

          # Check target directory
          $checkPath = if ($hasDotPath) { '\\\\?\\' + $cleanPath } else { $cleanPath }
          $dirExists = [System.IO.Directory]::Exists($checkPath)
          if (-not $dirExists) {
            $result.success = $false
            $result.error = "Target folder not found: $cleanPath"
          } else {
            # Get clipboard files
            $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
            if (-not $files -or $files.Count -eq 0) {
              $result.success = $false
              $result.error = "No files in clipboard"
            } else {
              # Compute total size
              $totalSize = 0
              foreach ($src in $files) {
                if ([System.IO.File]::Exists($src)) {
                  $totalSize += (Get-Item $src).Length
                } elseif ([System.IO.Directory]::Exists($src)) {
                  $totalSize += 100MB
                }
              }

              # Large file threshold: 100MB
              $useBgCopy = $totalSize -gt 100MB

              # ★ Dot-ending path must use .NET methods; normal path uses robocopy/cmd
              $copiedCount = 0
              $errors = @()

              foreach ($src in $files) {
                try {
                  $srcName = [System.IO.Path]::GetFileName($src)

                  if ($hasDotPath) {
                    # ★ Dot-ending path: use .NET methods + \\?\ prefix
                    $destPath = '\\\\?\\' + $cleanPath + '\\' + $srcName

                    if ([System.IO.Directory]::Exists($src)) {
                      # Recursively copy folder
                      $srcPrefix = '\\\\?\\' + $src
                      [System.IO.Directory]::CreateDirectory($destPath) | Out-Null
                      $allFiles = [System.IO.Directory]::GetFiles($srcPrefix, '*', 'AllDirectories')
                      foreach ($f in $allFiles) {
                        $rel = $f.Substring($srcPrefix.Length + 1)
                        $dstFile = $destPath + '\\' + $rel
                        $dstDir = [System.IO.Path]::GetDirectoryName($dstFile)
                        if (-not [System.IO.Directory]::Exists($dstDir)) {
                          [System.IO.Directory]::CreateDirectory($dstDir) | Out-Null
                        }
                        [System.IO.File]::Copy($f, $dstFile, $true)
                      }
                      $copiedCount++
                    } elseif ([System.IO.File]::Exists($src)) {
                      # Copy file
                      $srcPath = '\\\\?\\' + $src
                      [System.IO.File]::Copy($srcPath, $destPath, $true)
                      $copiedCount++
                    }
                  } else {
                    # ★ Normal path: use robocopy/cmd
                    if ([System.IO.Directory]::Exists($src)) {
                      $destDir = $cleanPath + '\\' + $srcName
                      if ($useBgCopy) {
                        $robocopyArgs = '"' + $src + '" "' + $destDir + '" /E /R:1 /W:1'
                        Start-Process -FilePath 'robocopy' -ArgumentList $robocopyArgs -WindowStyle Hidden
                        $copiedCount++
                      } else {
                        $robocopyArgs = '"' + $src + '" "' + $destDir + '" /E /R:1 /W:1'
                        $p = Start-Process -FilePath 'robocopy' -ArgumentList $robocopyArgs -WindowStyle Hidden -Wait -PassThru
                        if ($p.ExitCode -lt 8) { $copiedCount++ }
                      }
                    } elseif ([System.IO.File]::Exists($src)) {
                      if ($useBgCopy) {
                        $copyArgs = '/c copy /Y "' + $src + '" "' + $cleanPath + '\\"'
                        Start-Process -FilePath 'cmd' -ArgumentList $copyArgs -WindowStyle Hidden
                        $copiedCount++
                      } else {
                        $copyArgs = '/c copy /Y "' + $src + '" "' + $cleanPath + '\\"'
                        $p = Start-Process -FilePath 'cmd' -ArgumentList $copyArgs -WindowStyle Hidden -Wait -PassThru
                        if ($p.ExitCode -eq 0) { $copiedCount++ }
                      }
                    }
                  }
                } catch {
                  $errors += $_.Exception.Message
                }
              }

              $result.success = ($copiedCount -gt 0)
              $result.mode = if ($useBgCopy -and -not $hasDotPath) { "background" } else { "sync" }
              $result.copiedCount = $copiedCount
              $result.totalCount = $files.Count
              if ($errors.Count -gt 0) {
                $result.partialErrors = ($errors | Select-Object -First 3) -join "; "
              }
            }
          }
        } catch {
          $result.success = $false
          $result.error = $_.Exception.Message
        }
      }
      'getHtml' {
        $obj = [System.Windows.Forms.Clipboard]::GetData("HTML Format")
        $b64 = ""
        if ($obj -is [System.IO.Stream]) {
          $ms = [System.IO.MemoryStream]::new()
          $obj.CopyTo($ms)
          $bytes = $ms.ToArray()
          $b64 = [Convert]::ToBase64String($bytes)
        } elseif ($obj -is [string]) {
          $bytes = [Text.Encoding]::UTF8.GetBytes($obj)
          $b64 = [Convert]::ToBase64String($bytes)
        } else {
           $txt = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::Html)
           if ($txt) {
             $bytes = [Text.Encoding]::UTF8.GetBytes($txt)
             $b64 = [Convert]::ToBase64String($bytes)
           }
        }
        if ($b64) {
           $result.value_base64 = $b64
        }
      }
      default { $result.error = "unknown action" }
    }
  } catch {
    $result.error = $_.Exception.Message
  }

  $json = $result | ConvertTo-Json -Compress -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $b64 = [Convert]::ToBase64String($bytes)
  [Console]::Out.WriteLine($b64)
}

# Read input using UTF-8 encoding
$encoding = [System.Text.Encoding]::UTF8
$reader = New-Object System.IO.StreamReader([System.Console]::OpenStandardInput(), $encoding)

while ($true) {
  $line = $reader.ReadLine()
  if ($line -eq $null) { break }
  try {
    $cmd = ConvertFrom-Json $line
    Process-Command $cmd
  } catch {
    $err = @{ _id = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress
    $bytes = $encoding.GetBytes($err)
    $b64 = [Convert]::ToBase64String($bytes)
    [Console]::Out.WriteLine($b64)
  }
}
`.trim();

			logMessage(q('shell.tryStart'), "DEBUG");

			// ★ Key fix: wrap the entire startup logic in async IIFE and resolve inside
			(async () => {
				// ★ Remove singleton check; rely on cleanupGhostDaemons to clear residual processes
				// Singleton check can mis-detect (when residual process hasn't fully exited)

				try {
					const psOptions = [
						["powershell.exe", "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", simplePsScript],
						["powershell.exe", "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", simplePsScript],
						["pwsh.exe", "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", simplePsScript],
						["pwsh.exe", "-STA", "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", simplePsScript],
					];

					let lastError = null;
					for (const [index, options] of psOptions.entries()) {
						try {
							logMessage(q('shell.tryOption', index + 1, options[0]), "DEBUG");
							proc = cp.spawn(options[0], options.slice(1), {
								stdio: ["pipe", "pipe", "pipe"],
								windowsHide: true,
							});
							logMessage(q('shell.processCreated', options[0]), "DEBUG");
							break;
						} catch (e) {
							lastError = e;
							logMessage(q('shell.optionFailed', index + 1, e.message), "DEBUG");
						}
					}

					if (!proc) {
						throw lastError || new Error(q('global.cannotStartPowerShell'));
					}

					proc.on("error", (err) => {
						bridge._setStartError(`process_error: ${err.message}`);
						logMessage(q('shell.processError', err.message), "ERROR");
					});
					proc.on("exit", (code, signal) => {
						logMessage(q('shell.processExit', code, signal), "INFO");
					});

					// ★ Key: call setupProcess inside async IIFE
					bridge.setupProcess(proc, (ok) => {
						if (!ok) logMessage(q('shell.bridgeStartFailed', bridge.lastStartError || "unknown"), "WARN");
						resolve(ok);
					});
				} catch (e) {
					bridge._setStartError(`create_fail: ${e.message} `);
					logMessage(q('shell.processCreateFailed', e.message), "ERROR");
					bridge.available = false;
					resolve(false);
				}
			})();
			return;  // ★ Key: return early in Windows branch; do not execute common code below
		} else {
			const nodeBin = process.execPath.replace(/"/g, '\\"');
			const bashScript = platform === "darwin"
				? `
			NODE_BIN = "${nodeBin}"
			json_get() { echo "$1" | "$NODE_BIN" - e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j[process.argv[1]]??"")))}catch(e){}});' "$2" 2 > /dev/null; }

			while IFS = read - r line; do
				action = $(json_get "$line" "action")
  id = $(json_get "$line" "_id")
  case "$action" in
	ping) echo '{"_id":'"$id"',"status":"alive"}';;
    hasImage) if command -v pngpaste > /dev/null 2>&1 && pngpaste - > /dev/null 2>&1; then echo '{"_id":'"$id"',"value":true}'; else echo '{"_id":'"$id"',"value":false}'; fi;;
    saveImage)
      dest=$(json_get "$line" "path")
      if command -v pngpaste > /dev/null 2>&1 && pngpaste "$dest" 2>/dev/null; then echo '{"_id":'"$id"',"success":true}'; else echo '{"_id":'"$id"',"success":false}'; fi;;
    extract_icon)
      path=$(json_get "$line" "path")
      icon_b64=$(osascript -e "use framework \"AppKit\"
        set iconImage to (current application's NSWorkspace's sharedWorkspace()'s iconForFile:\"$path\")
        set bitmapRep to (current application's NSBitmapImageRep's imageRepWithData:(iconImage's TIFFRepresentation()))
        set pngData to (bitmapRep's representationUsingType:(current application's NSPNGFileType) properties:(missing value))
        return (pngData's base64EncodedStringWithOptions:0) as text" 2>/dev/null)
      if [ -n "$icon_b64" ]; then
        echo '{"_id":'"$id"',"icon":"'"$icon_b64"'","status":"ok"}'
      else
        echo '{"_id":'"$id"',"status":"error"}'
      fi;;
    trigger_system_paste)
      dest=$(json_get "$line" "path")
      if osascript -e "tell application \"Finder\" to paste to folder (POSIX file \"$dest\")" >/dev/null 2>&1; then
        echo '{"_id":'"$id"',"success":true}'
      else
        echo '{"_id":'"$id"',"success":false,"error":"AppleScript failed"}'
      fi;;
    setFiles)
      paths=$(json_get "$line" "paths")
      # macOS setFiles implementation via osascript
      script="set the clipboard to "
      # Simplified single file for now as array handling in bash+osascript is tricky
      # But it's a fallback anyway
      if osascript -e "set the clipboard to POSIX file \"$paths\"" >/dev/null 2>&1; then
        echo '{"_id":'"$id"',"success":true}'
      else
        echo '{"_id":'"$id"',"success":false}'
      fi;;
    *) echo '{"_id":'"$id"',"error":"unknown action"}';;
esac
done
	`.trim()
				: `
NODE_BIN = "${nodeBin}"
json_get() { echo "$1" | "$NODE_BIN" - e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String((j[process.argv[1]]??"")))}catch(e){}});' "$2" 2 > /dev/null; }

while IFS = read - r line; do
	action = $(json_get "$line" "action")
  id = $(json_get "$line" "_id")
  case "$action" in
	ping) echo '{"_id":'"$id"',"status":"alive"}';;
    hasImage) if command - v xclip > /dev/null 2 >& 1 && xclip - selection clipboard - t TARGETS - o 2 > /dev/null | grep - q "image/png"; then echo '{"_id":'"$id"',"value":true}'; else echo '{"_id":'"$id"',"value":false}'; fi;;
    hasHtml) if command - v xclip > /dev/null 2 >& 1 && xclip - selection clipboard - t TARGETS - o 2 > /dev/null | grep - q "text/html"; then echo '{"_id":'"$id"',"value":true}'; else echo '{"_id":'"$id"',"value":false}'; fi;;
    getHtml)
content = $(xclip - selection clipboard - o - t text / html 2 > /dev/null | python3 - c 'import json,sys; print(json.dumps(sys.stdin.read()))')
      echo '{"_id":'"$id"',"value":'$content'}';;
    saveImage)
      dest=$(json_get "$line" "path")
      if command -v xclip > /dev/null 2>&1 && xclip -selection clipboard -t image/png -o > "$dest" 2>/dev/null && [ -s "$dest" ]; then echo '{"_id":'"$id"',"success":true}'; else echo '{"_id":'"$id"',"success":false}'; fi;;
    extract_icon)
      path=$(json_get "$line" "path")
      # Linux: try extracting icon via python3 + gi (Gio/GdkPixbuf)
      icon_b64=$(python3 -c "
import sys, os
try:
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GdkPixbuf
    import base64
    from io import BytesIO

    file = Gio.File.new_for_path('$path')
    info = file.query_info('standard::icon', Gio.FileQueryInfoFlags.NONE, None)
    icon = info.get_icon()

    theme = Gio.IconTheme.get_default()
    # Try locating icon
    icon_info = theme.lookup_by_gicon(icon, 32, Gio.IconLookupFlags.FORCE_SIZE)
    if icon_info:
        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(icon_info.get_filename(), 32, 32)
        buffer = BytesIO()
        pixbuf.save_to_bufferv(buffer, 'png', [], [])
        print(base64.b64encode(buffer.getvalue()).decode('utf-8'))
except:
    pass
" 2>/dev/null)
      if [ -n "$icon_b64" ]; then
        echo '{"_id":'"$id"',"icon":"'"$icon_b64"'","status":"ok"}'
      else
        echo '{"_id":'"$id"',"status":"error"}'
      fi;;
    *) echo '{"_id":'"$id"',"error":"unknown action"}';;
esac
done
`.trim();

			logMessage(q('shell.tryBash'), "DEBUG");
			try {
				proc = cp.spawn("bash", ["-c", bashScript], {
					stdio: ["pipe", "pipe", "pipe"],
					env: NO_TRACK_ENV
				});
				logMessage(q('shell.bashCreated'), "DEBUG");
			} catch (e) {
				bridge._setStartError(`spawn_fail(bash): ${e.message} `);
				logMessage(q('shell.bashCreateFailed', e.message), "ERROR");
				bridge.available = false;
				resolve(false);
				return;
			}
		}

		if (!proc) {
			bridge._setStartError("proc_null");
			resolve(false);
			return;
		}

		bridge.setupProcess(proc, (ok) => {
			if (!ok) logMessage(q('shell.bridgeStartFailed', bridge.lastStartError || "unknown"), "WARN");
			resolve(ok);
		});
	});
});

let _daemonBootSeq = 0;

function updateStatusBarNow() {
	updateStatusBar(_cacheStatsGetter(), pythonBridge, rustBridge, shellBridge);
}

// ============================================================================
// ★ Linux dependency detection and install guidance
// ============================================================================
let _linuxDepsChecked = false;

/**
 * Detect whether xclip is installed on Linux
 * @returns {Promise<boolean>}
 */
async function checkXclipInstalled() {
	if (process.platform !== 'linux') return true;

	return new Promise((resolve) => {
		const child = cp.spawn('which', ['xclip'], { stdio: ['ignore', 'pipe', 'ignore'] });
		let found = false;

		child.stdout.on('data', (d) => {
			if (d.toString().trim()) found = true;
		});

		child.on('close', () => resolve(found));
		child.on('error', () => resolve(false));

		setTimeout(() => {
			try { child.kill(); } catch { }
			resolve(false);
		}, 3000);
	});
}

/**
 * Detect Linux package manager type
 * @returns {Promise<'apt'|'dnf'|'yum'|'pacman'|'zypper'|null>}
 */
async function detectLinuxPackageManager() {
	const managers = [
		{ name: 'apt', check: 'apt-get' },
		{ name: 'dnf', check: 'dnf' },
		{ name: 'yum', check: 'yum' },
		{ name: 'pacman', check: 'pacman' },
		{ name: 'zypper', check: 'zypper' }
	];

	for (const mgr of managers) {
		const exists = await new Promise((resolve) => {
			const child = cp.spawn('which', [mgr.check], { stdio: 'ignore' });
			child.on('close', (code) => resolve(code === 0));
			child.on('error', () => resolve(false));
			setTimeout(() => { try { child.kill(); } catch { } resolve(false); }, 2000);
		});
		if (exists) return mgr.name;
	}
	return null;
}

/**
 * Get command to install xclip
 * @param {string} pkgMgr - package manager name
 * @returns {string}
 */
function getXclipInstallCommand(pkgMgr) {
	switch (pkgMgr) {
		case 'apt': return 'sudo apt update && sudo apt install -y xclip';
		case 'dnf': return 'sudo dnf install -y xclip';
		case 'yum': return 'sudo yum install -y xclip';
		case 'pacman': return 'sudo pacman -S --noconfirm xclip';
		case 'zypper': return 'sudo zypper install -y xclip';
		default: return 'sudo apt install -y xclip';
	}
}

/**
 * Run install command in VS Code terminal
 * @param {string} command - command to execute
 * @param {string} title - terminal title
 * @returns {Promise<void>}
 */
async function runInTerminal(command, title) {
	const terminal = vscode.window.createTerminal({
		name: title,
		shellPath: '/bin/bash',
		shellArgs: ['-c', `${command}; echo ''; echo '${q('global.pressKeyToClose')}'; read -n 1`]
	});
	terminal.show();
	return terminal;
}

/**
 * Detect and guide installation of Linux dependency (xclip)
 * Only check once on first startup to avoid frequent user interruption
 */
async function checkAndInstallLinuxDeps() {
	// Linux only
	if (process.platform !== 'linux') return;

	// Avoid repeated checks
	if (_linuxDepsChecked) return;
	_linuxDepsChecked = true;

	// Check if already prompted (user chose "don't ask again")
	const suppressKey = 'xclipInstallSuppressed';
	if (extensionContext) {
		const suppressed = extensionContext.globalState.get(suppressKey);
		if (suppressed) return;
	}

	// Detect whether xclip is installed
	const hasXclip = await checkXclipInstalled();
	if (hasXclip) {
		logMessage(q('linux.xclipInstalled'), 'INFO');
		return;
	}

	logMessage(q('linux.xclipNotInstalled'), 'INFO');

	// Detect package manager
	const pkgMgr = await detectLinuxPackageManager();
	const installCmd = getXclipInstallCommand(pkgMgr);

	// Prompt user
	const choice = await vscode.window.showWarningMessage(
		q('linux.xclipPrompt'),
		{ modal: false },
		q('linux.installNow'),
		q('linux.copyCommand'),
		q('linux.dontAskAgain')
	);

	if (choice === q('linux.installNow')) {
		logMessage(q('linux.installingXclip', installCmd), 'INFO');

		// Execute install command in terminal
		const terminal = await runInTerminal(installCmd, q('linux.terminalTitle'));

		// Listen for terminal close and verify install success
		const disposable = vscode.window.onDidCloseTerminal(async (closedTerminal) => {
			if (closedTerminal === terminal) {
				disposable.dispose();

				// Wait a bit for system refresh
				await new Promise(r => setTimeout(r, 500));

				// Re-check
				const nowHasXclip = await checkXclipInstalled();
				if (nowHasXclip) {
					showAutoCloseNotification('success', q('global.xclipInstallSuccess'));
					logMessage(q('linux.xclipInstallSuccess'), 'INFO');
				} else {
					showAutoCloseNotification('warning', q('global.xclipInstallMayFailed'));
					logMessage(q('linux.xclipInstallMaybeFailed'), 'WARN');
				}
			}
		});

	} else if (choice === q('linux.copyCommand')) {
		await vscode.env.clipboard.writeText(installCmd);
		showAutoCloseNotification('info', q('global.cmdCopied', installCmd));
		logMessage(q('linux.userCopyCmd', installCmd), 'INFO');

	} else if (choice === q('linux.dontAskAgain')) {
		if (extensionContext) {
			await extensionContext.globalState.update(suppressKey, true);
		}
		logMessage(q('linux.userDismiss'), 'INFO');
	}
}

/**
 * ★ Ghost process purge protocol - disabled
 *
 * Multi-instance fix: no longer clean up any daemon processes
 * Because all daemons (Python/Rust/Shell) use stdin/stdout for communication
 * Multiple IDE instances each run their own daemon; cleanup would kill others by mistake
 *
 * Zombie processes are handled by each daemon's watchdog mechanism:
 * - Python: watchdog (6s) + exit on stdin EOF
 * - Rust: watchdog (6s) + exit on stdin EOF
 * - Shell: auto-exit when stdin closes
 */
async function cleanupGhostDaemons() {
	// No-op: no longer clean up any processes
}

async function startDaemons() {
	// ★ Ultimate fix: check if any bridge is available or starting
	// available === true means usable
	// isStarting === true means in startup (spawn -> handshake)
	// process/socket exists means connection started
	// Note: pythonBridge uses BrokerBridge (IPC socket), not DaemonBridge (child process)
	const pythonBusy = pythonBridge.available === true || pythonBridge.isStarting || pythonBridge.socket;
	const rustBusy = rustBridge.available === true || rustBridge.isStarting || rustBridge.process;
	const shellBusy = shellBridge.available === true || shellBridge.isStarting || shellBridge.process;

	if (pythonBusy || rustBusy || shellBusy) {
		logMessage(q('daemons.bridgeBusy', pythonBusy, rustBusy, shellBusy), "INFO");
	} else {
		// ★ Primary init task: purge all "previous life" residual ghost processes
		try { await cleanupGhostDaemons(); } catch (e) { }
	}

	const bootSeq = ++_daemonBootSeq;

	// ★ Key: print unique version marker for accurate log tracing
	try {
		const pkg = require(path.join(extensionContext.extensionPath, 'package.json'));
		const buildTime = new Date().toLocaleString();
		logMessage(`====================================================`, "INFO");
		logMessage(`🚀 Q-ENGINE STARTING | VERSION: ${pkg.version} | ${buildTime}`, "INFO");
		logMessage(`🎯 ACTIVE FFmpeg: ${ffmpegPath || "NONE"} (${ffmpegSource})`, "INFO");
		logMessage(`====================================================`, "INFO");
	} catch (e) {
		logMessage(`🚀 Q-ENGINE STARTING | (Failed to read version)`, "INFO");
	}

	const pref = getEnginePreference();
	logMessage(q('daemons.startWithEngine', pref), "INFO");

	const ensureStarted = async (bridge) => {
		if (bootSeq !== _daemonBootSeq) return false;
		try {
			if (bridge.isAvailable()) return true;

			logMessage(q('daemons.startBridge', bridge.name), "INFO");
			const ok = await bridge.start();

			if (bootSeq !== _daemonBootSeq) return false;

			if (ok) {
				logMessage(`${bridge.name} Bridge OK`, "INFO");
			} else {
				logMessage(q('daemons.bridgeStartFailedNamed', bridge.name, bridge.lastStartError || "unknown"), "WARN");
			}
			return !!ok;
		} catch (e) {
			logMessage(q('daemons.bridgeStartException', bridge.name, e?.message || e), "WARN");
			return false;
		} finally {
			updateStatusBarNow();
		}
	};

	(async () => {
		// ★ Ultimate optimal: check if already deactivated before starting
		if (_isDeactivated) return;

		// ★ ARCHITECTURE UPGRADE: Rust ALWAYS starts first, regardless of ioEngine config
		// Rust handles: wq, setFiles, getFiles, dumpHtmlToFile, trigger_system_paste
		// If Rust fails, Shell (PowerShell) daemon becomes the fallback
		const pref = getEnginePreference();
		logMessage(`[Daemon] User preference: ${pref}, but Rust always starts first`, "INFO");

		// ★ OPTIMIZATION: Start Rust and Python in PARALLEL (they don't depend on each other)
		// - Rust: handles IO operations (wq, clipboard, paste)
		// - Python: handles audio playback + clipboard watching (sfx)
		// This saves 1-2 seconds on startup

		const rustPromise = ensureStarted(rustBridge);
		const pythonPromise = (pref !== 'shell') ? ensureStarted(pythonBridge) : Promise.resolve(false);

		// Wait for Rust first (needed to decide if Shell fallback is required)
		const rustOk = await rustPromise;

		// ★ Step 2: Shell (PowerShell) is fallback only when Rust fails
		if (!rustOk) {
			logMessage("[Daemon] Rust failed, starting Shell as fallback for wq/clipboard", "INFO");
			await ensureStarted(shellBridge);
		}

		// ★ Wait for Python to finish (it was started in parallel)
		await pythonPromise;

		if (bootSeq === _daemonBootSeq) {
			const anyAvailable = pythonBridge.isAvailable() || rustBridge.isAvailable() || shellBridge.isAvailable();
			if (!anyAvailable) {
				logMessage("All daemons failed, using spawn fallback", "WARN");
			}
			updateStatusBarNow();

			// ★ Start clipboard watcher when Python is available (kope sfx)
			if (pythonBridge.isAvailable()) {
				pythonBridge.call("start_clipboard_watcher", {}, 5000).then(res => {
					if (res && res.status === 'started') {
						logMessage("[Audio] Clipboard watcher started (kope sfx)", "INFO");
					} else {
						logMessage(`[Audio] Clipboard watcher failed: ${JSON.stringify(res)}`, "WARN");
					}
				}).catch(e => {
					logMessage(`[Audio] Clipboard watcher error: ${e?.message || e}`, "WARN");
				});
			}

			// ★ Detect Linux dependency (delayed to avoid blocking startup)
			setTimeout(() => {
				checkAndInstallLinuxDeps().catch(e => {
					logMessage(q('linux.checkException', e?.message || e), 'WARN');
				});
			}, 2000);
		}
	})().catch((e) => {
		logMessage(q('daemons.flowException', e?.message || e), "WARN");
		updateStatusBarNow();
	});
}

// ============================================================================
// ★ Global context
// ============================================================================
let extensionContext = null;
let ffmpegPath = null;
let ffprobePath = null;
let ffmpegSource = "NOT_FOUND";
let _ffmpegInitPromise = null; // ★ Async FFmpeg init promise

// ★ Ultimate optimal: global deactivation flag
let _isDeactivated = false;

// ★ Ultimate optimal: global process tracker
const _activeProcesses = new Set();

function trackProcess(proc) {
	if (!proc) return;
	_activeProcesses.add(proc);
	proc.on("exit", () => _activeProcesses.delete(proc));
	proc.on("error", () => _activeProcesses.delete(proc));
}

async function killAllProcesses() {
	const procs = Array.from(_activeProcesses);
	_activeProcesses.clear();

	const killPromises = procs.map(proc => {
		return new Promise((resolve) => {
			if (proc.killed) return resolve();
			proc.once('exit', () => resolve());
			try {
				if (process.platform === "win32") {
					cp.exec(`taskkill /pid ${proc.pid} /T /F`, () => resolve());
				} else {
					proc.kill("SIGKILL");
					resolve();
				}
			} catch { resolve(); }
			// Fallback timeout
			setTimeout(resolve, 1000);
		});
	});
	await Promise.all(killPromises);
}

// ★ Ultimate optimal: ready signal
let _resolveReady;
const _readyPromise = new Promise(resolve => { _resolveReady = resolve; });

/**
 * Higher-order wrapper: ensure readiness before running a function
 * Especially ensure watermark verification passed
 */
function withReady(fn) {
	return async (...args) => {
		await _readyPromise;
		return fn(...args);
	};
}

// ============================================================================
// ★ FFmpeg async initialization (non-blocking startup optimization)
// ============================================================================

/**
 * Internal: async FFmpeg initialization
 * Called immediately at startup, runs in background without blocking activate()
 */
function _initFFmpegAsync(context) {
	if (_ffmpegInitPromise) return _ffmpegInitPromise;

	// ★ Set immediate fallback (system PATH) so q1.js works even before async completes
	const isWin = process.platform === "win32";
	const ffName = isWin ? "ffmpeg.exe" : "ffmpeg";
	const ffprobeName = isWin ? "ffprobe.exe" : "ffprobe";
	ffmpegPath = ffName;   // Immediate fallback to system PATH
	ffprobePath = ffprobeName;

	_ffmpegInitPromise = (async () => {
		const extensionPath = context.extensionUri?.fsPath || context.extensionPath;
		const globalStoragePath = context.globalStorageUri?.fsPath;
		const ffInAssets = path.join(extensionPath, "assets", ffName);
		const ffprobeInAssets = path.join(extensionPath, "assets", ffprobeName);
		const ffInGlobalStorage = globalStoragePath ? path.join(globalStoragePath, ffName) : null;
		const ffprobeInGlobalStorage = globalStoragePath ? path.join(globalStoragePath, ffprobeName) : null;

		// Ensure globalStorage directory exists (async-friendly check)
		if (globalStoragePath) {
			try {
				await fs.promises.mkdir(globalStoragePath, { recursive: true });
			} catch { }
		}

		// Check globalStorage first
		if (ffInGlobalStorage) {
			try {
				await fs.promises.access(ffInGlobalStorage);
				ffmpegPath = ffInGlobalStorage;
				ffprobePath = ffprobeInGlobalStorage;
				ffmpegSource = "GLOBAL_STORAGE";
				logMessage(`FFmpeg Path: ${ffInGlobalStorage}`, "INFO");
				return;
			} catch { }
		}

		// Check assets and move to globalStorage
		try {
			await fs.promises.access(ffInAssets);
			if (ffInGlobalStorage) {
				try {
					await fs.promises.rename(ffInAssets, ffInGlobalStorage);
					if (ffprobeInGlobalStorage) {
						try { await fs.promises.rename(ffprobeInAssets, ffprobeInGlobalStorage); } catch { }
					}
					ffmpegPath = ffInGlobalStorage;
					ffprobePath = ffprobeInGlobalStorage;
					ffmpegSource = "GLOBAL_STORAGE";
					logMessage(`FFmpeg moved to globalStorage: ${ffInGlobalStorage}`, "INFO");
					return;
				} catch {
					// Cross-disk: copy + delete
					try {
						await fs.promises.copyFile(ffInAssets, ffInGlobalStorage);
						await fs.promises.unlink(ffInAssets);
						if (ffprobeInGlobalStorage) {
							try {
								await fs.promises.copyFile(ffprobeInAssets, ffprobeInGlobalStorage);
								await fs.promises.unlink(ffprobeInAssets);
							} catch { }
						}
						ffmpegPath = ffInGlobalStorage;
						ffprobePath = ffprobeInGlobalStorage;
						ffmpegSource = "GLOBAL_STORAGE";
						logMessage(`FFmpeg copied to globalStorage: ${ffInGlobalStorage}`, "INFO");
						return;
					} catch (cpErr) {
						logMessage(`FFmpeg move failed: ${cpErr.message}`, "WARN");
					}
				}
			}
			// Fallback to assets
			ffmpegPath = ffInAssets;
			ffprobePath = ffprobeInAssets;
			ffmpegSource = "ASSETS";
			logMessage(`FFmpeg Path: ${ffInAssets}`, "INFO");
			return;
		} catch { }

		// Not found, fallback to system PATH
		ffmpegSource = "NOT_FOUND";
		ffmpegPath = ffName;
		ffprobePath = ffprobeName;
		logMessage("FFmpeg not found, fallback to system PATH", "DEBUG");
	})();

	return _ffmpegInitPromise;
}

/**
 * Ensure FFmpeg is ready before use
 * Call this before any FFmpeg operation (e.g., decorators, video processing)
 * Returns immediately if already initialized
 */
async function ensureFFmpegReady() {
	if (_ffmpegInitPromise) {
		await _ffmpegInitPromise;
	}
	return { ffmpegPath, ffprobePath, ffmpegSource };
}

function init(context) {
	_isDeactivated = false; // Reset on startup
	extensionContext = context;

	// ★ Initialize BrokerBridge with extension path (for IPC Broker singleton)
	initPythonBrokerBridge();

	// ★ FFmpeg: async initialization (non-blocking, but starts immediately)
	// Use ensureFFmpegReady() to wait for completion when needed
	_initFFmpegAsync(context);

	// Start assets sentinel
	startAssetsSentinel(context);

	initUserTracking(context);

	// ★ Pre-warm ShellBridge in background to remove first-paste C# injection delay
	setTimeout(() => {
		if (shellBridge && shellBridge.isAvailable()) {
			shellBridge.call("warmup", {}, 5000).then(res => {
				if (res?.status === 'warmed') {
					logMessage(q('shell.warmupSuccess'), "INFO");
				}
			}).catch(() => { });
		}
	}, 3000);
}

// ============================================================================
// ★ Logging
// ============================================================================
let LOG_PATH = null;
const outputChannel = vscode.window.createOutputChannel("qqq");

// ★ Log level filter: DEBUG < INFO < WARN < ERROR
// Set to "WARN" to only show warnings and errors in Output panel
// let LOG_LEVEL = "DEBUG";
let LOG_LEVEL = "WARN";
const LOG_LEVEL_PRIORITY = { "DEBUG": 0, "INFO": 1, "WARN": 2, "ERROR": 3 };

function setLogLevel(level) {
	if (LOG_LEVEL_PRIORITY[level] !== undefined) {
		LOG_LEVEL = level;
	}
}

function getLogLevel() {
	return LOG_LEVEL;
}

function setLogPath(p) {
	LOG_PATH = p;
}

function getLogPath() {
	return LOG_PATH;
}

// ★ Log noise reduction (rate-limit) infrastructure
const _rateLimitLastTs = new Map();
function logMessageRateLimited(key, message, level = "WARN", intervalMs = 300000) {
	const now = Date.now();
	const last = _rateLimitLastTs.get(key) || 0;
	if (now - last < intervalMs) return;
	_rateLimitLastTs.set(key, now);
	logMessage(message, level);
}

function bridgeStderrKey(name, text) {
	const head = String(text || "").replace(/\s+/g, " ").slice(0, 120);
	return `bridge:${name}:${head} `;
}

function rotateLogIfNeeded() {
	if (!LOG_PATH) return;

	try {
		const maxLogSize = 8388608; // 8MB
		if (fs.existsSync(LOG_PATH)) {
			const stats = fs.statSync(LOG_PATH);
			if (stats.size >= maxLogSize) {
				const oldLogPath = `${LOG_PATH} .1`;
				if (fs.existsSync(oldLogPath)) {
					fs.unlinkSync(oldLogPath);
				}
				fs.renameSync(LOG_PATH, oldLogPath);
			}
		}
	} catch (e) {
		// Log rotation failure should not affect main program
	}
}

function logMessage(message, level = "INFO") {
	// ★ Filter by log level (early return before any string processing)
	const msgPriority = LOG_LEVEL_PRIORITY[level] ?? 1;
	const minPriority = LOG_LEVEL_PRIORITY[LOG_LEVEL] ?? 0;
	if (msgPriority < minPriority) return;

	// ★ Lazy evaluation: if message is a function, call it only when needed
	// This avoids expensive JSON.stringify or string concatenation when log is filtered out
	const msg = typeof message === 'function' ? message() : message;

	const now = new Date();
	// ★ Use client local time + timezone offset
	const tzOffset = -now.getTimezoneOffset();
	const tzSign = tzOffset >= 0 ? '+' : '-';
	const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
	const tzMins = String(Math.abs(tzOffset) % 60).padStart(2, '0');
	const localISO = now.getFullYear() + '-' +
		String(now.getMonth() + 1).padStart(2, '0') + '-' +
		String(now.getDate()).padStart(2, '0') + 'T' +
		String(now.getHours()).padStart(2, '0') + ':' +
		String(now.getMinutes()).padStart(2, '0') + ':' +
		String(now.getSeconds()).padStart(2, '0') + '.' +
		String(now.getMilliseconds()).padStart(3, '0') +
		tzSign + tzHours + ':' + tzMins;
	const line = `[${localISO}][${level}] ${msg} `;
	outputChannel.appendLine(line);

	if ((level === "ERROR" || level === "WARN") && LOG_PATH) {
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

			rotateLogIfNeeded();

			fs.appendFileSync(LOG_PATH, line + "\n");
		} catch (e) { }
	}
}

// ============================================================================
// ★ Unified task message module (single source of truth)
// Used for formatting/displaying progress/done messages for file paste, video downloads, etc.
// ============================================================================
const TaskMessage = {
	/**
	 * Format duration
	 * @param {number} ms - milliseconds
	 * @returns {string} like "6s", "1m30s"
	 */
	formatDuration(ms) {
		const sec = Math.round(ms / 1000);
		if (sec < 60) return `${sec}s`;
		const min = Math.floor(sec / 60);
		const s = sec % 60;
		return s > 0 ? `${min}m${s}s` : `${min}m`;
	},

	/**
	 * Build progress message
	 * @param {string} taskTitle - task title, e.g. "qqq：'d:/122.txt task 19'"
	 * @param {string} content - progress content, e.g. "swapped 7m at https://..."
	 * @returns {string}
	 */
	progress(taskTitle, content) {
		const prefix = taskTitle || 'qqq';
		return `${prefix} ${content}`;
	},

	/**
	 * Build done message
	 * @param {string} taskTitle - task title
	 * @param {string} summary - result summary, e.g. "files/folders copied 59" or "flushed 3 videos total 19m"
	 * @param {string|number} elapsed - duration, can be string "6s" or ms number
	 * @param {string} taskId - task id (optional)
	 * @returns {string}
	 */
	done(taskTitle, summary, elapsed, taskId = '') {
		const prefix = taskTitle || 'qqq';
		const dur = typeof elapsed === 'number' ? this.formatDuration(elapsed) : elapsed;
		// ★ Two spaces between taskTitle and summary
		const idPart = taskId ? `;  id: ${taskId}` : '';
		return `${prefix}  ${summary}( ${q('global.elapsed')}: ${dur}${idPart} )`;
	},

	/**
	 * Build user prompt message
	 * @param {string} taskTitle - task title
	 * @param {string} message - prompt text
	 * @returns {string}
	 */
	prompt(taskTitle, message) {
		const prefix = taskTitle || 'qqq:';
		return `${prefix} ${message}`;
	},

	/**
	 * Show auto-close done toast (with optional buttons)
	 * @param {string} message - message content
	 * @param {Object} options - options
	 * @param {string[]} options.buttons - button texts
	 * @param {number} options.timeout - auto close ms, default 15000
	 * @param {Function} options.onButton - callback on click (buttonText) => {}
	 * @returns {Promise<string|undefined>} clicked button text, or undefined (timeout/no action)
	 */
	async showDoneToast(message, options = {}) {
		const { buttons = [], timeout = 15000, onButton } = options;

		const p = vscode.window.showInformationMessage(message, ...buttons);

		let timer = null;
		const timeoutPromise = new Promise(resolve => {
			timer = setTimeout(() => resolve(undefined), timeout);
		});

		const choice = await Promise.race([p, timeoutPromise]);
		try { if (timer) clearTimeout(timer); } catch (e) { }

		if (choice && onButton) {
			await onButton(choice);
		}

		return choice;
	},

	/**
	 * Show simple auto-close message (no buttons), delegate to showAutoCloseNotification
	 * @param {string} message - message content
	 * @param {number} [_timeout] - deprecated, kept for signature compatibility
	 * @param {'success'|'cancel'|'error'|'info'} type - message type
	 */
	showSimpleToast(message, _timeout, type = 'info') {
		showAutoCloseNotification(type, message);
	}
};

// ============================================================================
// ★ Dialog wrappers (dialogs used by qqq)
// ============================================================================
function showInformationMessage(message, ...items) {
	return vscode.window.showInformationMessage(message, ...items);
}

// ============================================================================
// ★ Single source of truth: precise 9-second countdown auto-close notification
// All "pure notification" popups must call this function; change default seconds only here
// ============================================================================
const AUTO_CLOSE_SECONDS = 9; // ★ Global default seconds; change this one number only

/**
 * Show an auto-close notification with countdown progress (single source of truth)
 * @param {'info'|'warning'|'error'|'success'|'cancel'} type - message type
 * @param {string} message - message text
 * @param {number} [seconds] - auto close seconds, default AUTO_CLOSE_SECONDS
 */
function showAutoCloseNotification(type, message, seconds) {
	const sec = (typeof seconds === 'number' && seconds > 0) ? seconds : AUTO_CLOSE_SECONDS;
	const prefixMap = { 'success': '✅', 'cancel': '❌', 'error': '⚠️', 'warning': '⚠️', 'info': '' };
	const emoji = prefixMap[type] || '';
	// ★ 格式：qqq: ✅message 或 qqq: ⚠️message（qqq 是播报者，放在最前）
	const qPrefix = /^qqq[:：]/i.test(message) ? '' : 'qqq: ';
	const text = `${qPrefix}${emoji}${message}`;
	vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: '',
		cancellable: false
	}, async (progress) => {
		for (let s = sec; s >= 1; s--) {
			// progress.report({ increment: 86 / sec, message: `${text}\u3000\u3000\u3000${s} s` });
			progress.report({ increment: 86 / sec, message: `${text}` });
			await new Promise(r => setTimeout(r, 1000));
		}
	});
}

function showErrorMessage(message, ...items) {
	return vscode.window.showErrorMessage(message, ...items);
}

function showWarningMessage(message, ...items) {
	return vscode.window.showWarningMessage(message, ...items);
}

function showInputBox(options, token) {
	return vscode.window.showInputBox(options, token);
}

function showQuickPick(items, options, token) {
	return vscode.window.showQuickPick(items, options, token);
}

function showSaveDialog(options) {
	return vscode.window.showSaveDialog(options);
}

function withProgress(options, task) {
	return vscode.window.withProgress(options, task);
}

function showTextDocument(document, column, preserveFocus) {
	if (!document) return Promise.resolve(undefined);
	try {
		return vscode.window.showTextDocument(document, column, preserveFocus);
	} catch (e) {
		logMessage(q('editor.showDocFailed', e.message), "ERROR");
		return Promise.resolve(undefined);
	}
}

function openExternal(uri) {
	const filePath = uri.fsPath;

	// First try opening via Node.js engine
	try {
		if (process.platform === 'win32') {
			// Windows: use start
			require('child_process').execSync(`start "" "${filePath.replace(/"/g, '""')}"`, { stdio: 'ignore' });
			return Promise.resolve();
		} else if (process.platform === 'darwin') {
			// macOS: use open
			require('child_process').execSync(`open "${filePath.replace(/"/g, '""')}"`, { stdio: 'ignore' });
			return Promise.resolve();
		} else {
			// Linux: use xdg-open
			require('child_process').execSync(`xdg-open "${filePath.replace(/"/g, '""')}"`, { stdio: 'ignore' });
			return Promise.resolve();
		}
	} catch (error) {
		// If Node.js open fails, try VS Code API
		try {
			return vscode.env.openExternal(uri);
		} catch (vsCodeError) {
			// If VS Code API also fails, try Python fallback
			try {
				const pythonCode = `
				import os
				import sys

				file_path = "${filePath.replace(/"/g, '""')}"

				if sys.platform == 'win32':
					try:
						import win32com.client
						shell = win32com.client.Dispatch('WScript.Shell')
						shell.Run(f'"{file_path}"', 1, False)
						exit(0)
					except ImportError:
						pass

				# Generic method
				os.startfile(file_path)
				`;

				require('child_process').execSync(`python -c "${pythonCode}"`, { stdio: 'ignore' });
				return Promise.resolve();
			} catch (pythonError) {
				// All methods failed, return error
				return Promise.reject(new Error(q('global.cannotOpenFile', filePath)));
			}
		}
	}
}

function setStatusBarMessage(text, hideAfterTimeout) {
	return vscode.window.setStatusBarMessage(text, hideAfterTimeout);
}

// ============================================================================
// ★ Usage duration stats (minimal: +60s every 60 seconds)
// ============================================================================
const KEY_TOTAL_SECONDS = "qqq_stats_total_seconds";
const KEY_CACHE_HIT_TOTAL = "qqq_stats_cache_hit_total";
const KEY_CACHE_MISS_TOTAL = "qqq_stats_cache_miss_total";

let _durationTimer = null;

// ============================================================================
// ★ ConfigGate (ULTIMATE VIP/Trial Config System)
// ============================================================================
const DEFAULT_CONFIG = {
	"roamAsStartPage": true,
	"roamName": "的梦gaea",
	"enlargeSmallImages": false,
	"performanceMode": "optmum",
	"frameSizeMode": "fix",
	"cleanFreak": false,
	"ioEngine": "v16  auto",
	"downloadSecurityLevel": "1: 平衡", // qq2q
	"enhancedHtmlPasteCompatibility": false,
	"docExportImageResolution": "原始分辨率", // qq2q
	"docExportIncludeCipher": true,
	"transactionLevel": "half",
	"textSlideColorScheme": "light",
	"textSlideFontSize": 14,
	// ★ Add missing config items (ensure VIP Gate fully covers)
	"szDisplayMode": "nothing",
	"sortBy": "name",
	"autoWatchChanges": false,
	"codelensLevel": "3",
	"takeOverCodelensStyle": true,
	"forceTextFlowScheme": false,
	"autoDownload": true
};


// ===================== VIP / Trial ConfigGate (ULTIMATE) =====================
let _isVip = true; // ★ Default true = VIP behavior (backward compatible until setVipMode is called)
let _sessionOverrides = Object.create(null);
let _suppressConfigEcho = 0; // Prevent "we echo settings back" from causing infinite loop
let _trialHintShown = false;
let _configChangeCallback = null;
let _configUpdateCallbacks = []; // ★ List of callbacks after config update completes (fix race conditions)
// ★ Bootstrap reset completion flag (non-VIP only)
// Purpose: Prevent race condition where q2 opens before settings.json is cleared
// - false: non-VIP get() returns DEFAULT_CONFIG directly (safe startup)
// - true: non-VIP get() can read settings.json (cleared or user-modified in session)
// Note: This flag ONLY affects non-VIP users. VIP users bypass this check entirely.
let _bootstrapResetDone = false;

function setVipMode(v) {
	_isVip = !!v;
	_sessionOverrides = Object.create(null); // Clear session overrides on mode switch to avoid cross-contamination
	// ★ VIP users don't need bootstrap reset, mark as done immediately
	// This ensures VIP users can always read settings.json without waiting
	if (_isVip) {
		_bootstrapResetDone = true;
	}
	// logMessage(`[ConfigGate] VIP 模式设置为: ${_isVip}`, "INFO"); // qq2q
}
function isVip() { return _isVip; }

// Hard bounce: delete qqq.xxx from settings.json (clear Global/Workspace/WorkspaceFolder)
async function _clearVscodeSettingEverywhere(key) {
	_suppressConfigEcho++;
	try {
		const cfg = vscode.workspace.getConfiguration("qqq");
		const ins = cfg.inspect(key);
		if (ins?.globalValue !== undefined) {
			await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
		}
		if (ins?.workspaceValue !== undefined) {
			await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
		}
		// WorkspaceFolder (clear per folder)
		const folders = vscode.workspace.workspaceFolders || [];
		for (const wf of folders) {
			const folderCfg = vscode.workspace.getConfiguration("qqq", wf.uri);
			const fin = folderCfg.inspect(key);
			if (fin?.workspaceFolderValue !== undefined) {
				await folderCfg.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		}
	} catch (e) {
		logMessage(q('config.clearFailed', key, e.message), "WARN");
	} finally {
		_suppressConfigEcho--;
	}
}

const ConfigManager = {
	get(key) {
		// 1) Session overrides always win (VIP/non-VIP can both use for "instant override")
		if (Object.prototype.hasOwnProperty.call(_sessionOverrides, key)) {
			return _sessionOverrides[key];
		}

		// 2) Non-VIP bootstrap guard: return default until settings.json is cleared
		// ★ This check is SKIPPED for VIP users (_isVip=true makes condition false)
		// ★ VIP users always proceed to step 3 immediately
		if (!_isVip && !_bootstrapResetDone) {
			return DEFAULT_CONFIG[key];
		}

		// 3) Try to read settings.json (both VIP and non-VIP can read after bootstrap)
		try {
			const wsVal = vscode.workspace.getConfiguration("qqq").get(key);
			if (wsVal !== undefined) return wsVal;
		} catch { }

		// 4) VIP only: read DB (globalState) for persisted configs
		if (_isVip && extensionContext) {
			// Backward compatible old trailing-space key
			const v1 = extensionContext.globalState.get(`cfg_${key}`);
			if (v1 !== undefined) return v1;
			const v2 = extensionContext.globalState.get(`cfg_${key} `);
			if (v2 !== undefined) return v2;
		}

		// 5) Fallback to hardcoded default
		return DEFAULT_CONFIG[key];
	},

	// Ultimate set: VIP can persist; non-VIP session-only
	async set(key, value, opts = {}) {
		const persist = opts.persist !== false; // default true
		_sessionOverrides[key] = value;

		if (_configChangeCallback) _configChangeCallback(key, value);

		if (!_isVip || !persist) {
			// Non-VIP: never write DB
			// ★ Ultimate fix: no longer aggressively clear settings.json in real time
			// Because VS Code won't fire events for "choose default" (if settings.json doesn't have it)
			// Keep settings.json value so VS Code can detect changes normally
			// Reset on restart is done via nonVipBootstrapResetAll() during startup
			if (!_isVip && !_trialHintShown) {
				_trialHintShown = true;
				try { showAutoCloseNotification('info', q('global.trialModeHint')); } catch { }
			}
			return;
		}

		// VIP: write DB (globalState) with new key (no trailing space), and clear old key
		if (extensionContext) {
			await extensionContext.globalState.update(`cfg_${key}`, value);
			await extensionContext.globalState.update(`cfg_${key} `, undefined); // Clear old
		}
	},

	getAll() {
		const res = {};
		for (const k of Object.keys(DEFAULT_CONFIG)) {
			res[k] = this.get(k);
		}
		return res;
	},


	onChange(cb) {
		_configChangeCallback = cb;
	},

	// On non-VIP startup: clear all qqq.* settings once to ensure "reset on restart"
	async nonVipBootstrapResetAll() {
		if (_isVip) {
			_bootstrapResetDone = true; // VIP: no clearing needed, mark ready immediately
			return;
		}
		// logMessage("[ConfigGate] 非 VIP 启动，清除所有 settings.json 中的 qqq.* 配置", "INFO"); // qq2q
		for (const k of Object.keys(DEFAULT_CONFIG)) {
			await _clearVscodeSettingEverywhere(k);
		}
		_bootstrapResetDone = true; // ★ Clearing done, now get() can read settings.json
	},

	// VS Code settings change entry (single entry)
	// ★ Returns changedKeys array for caller to determine if sound should play
	async handleVscodeConfigChanged(event) {
		if (_suppressConfigEcho) return [];

		const changedKeys = [];
		for (const key of Object.keys(DEFAULT_CONFIG)) {
			const fullKey = `qqq.${key}`;
			if (!event.affectsConfiguration(fullKey)) continue;

			const val = vscode.workspace.getConfiguration("qqq").get(key);
			// ★ 比较 session 缓存而不是 get()，因为 get() 会读 settings.json 导致永远相等
			const sessionVal = _sessionOverrides[key];
			const compareVal = sessionVal !== undefined ? sessionVal : DEFAULT_CONFIG[key];
			if (val === compareVal) continue;

			// VIP: persist; non-VIP: session + bounce-clear
			await this.set(key, val, { persist: _isVip });
			changedKeys.push(key);
		}

		// ★ After config update completes, notify all subscribers (fix race conditions)
		if (changedKeys.length > 0) {
			for (const cb of _configUpdateCallbacks) {
				try { cb(changedKeys, event); } catch (e) { }
			}
		}

		return changedKeys;
	},


	// ★ Callback after config update completes (solves the race condition between q1.js/q2.js)
	onConfigUpdated(callback) {
		if (typeof callback === 'function' && !_configUpdateCallbacks.includes(callback)) {
			_configUpdateCallbacks.push(callback);
		}
	},

	// ★ Remove callback
	offConfigUpdated(callback) {
		const idx = _configUpdateCallbacks.indexOf(callback);
		if (idx !== -1) _configUpdateCallbacks.splice(idx, 1);
	}
};

function getConfig(key) {
	return ConfigManager.get(key);
}

async function setConfig(key, value) {
	await ConfigManager.set(key, value, { persist: _isVip });
}

let _cacheHitTotal = 0;
let _cacheMissTotal = 0;
let _statsFlushTimer = null;
let _statsDirty = false;

// ★ Crash fix: add missing Getter definition
let _cacheStatsGetter = () => ({ totalSize: 0, fileCount: 0, hitCount: 0, missCount: 0 });

function setCacheStatsGetter(fn) {
	_cacheStatsGetter = fn;
}

function _loadPersistentStats(context) {
	try {
		_cacheHitTotal = context?.globalState?.get(KEY_CACHE_HIT_TOTAL, 0) || 0;
		_cacheMissTotal = context?.globalState?.get(KEY_CACHE_MISS_TOTAL, 0) || 0;
	} catch { }
}

function _scheduleStatsFlush() {
	if (!extensionContext || !_statsDirty) return;
	if (_statsFlushTimer) return;

	_statsFlushTimer = setTimeout(() => {
		_statsFlushTimer = null;
		if (!extensionContext || !_statsDirty) return;
		_statsDirty = false;

		try {
			extensionContext.globalState.update(KEY_CACHE_HIT_TOTAL, _cacheHitTotal);
			extensionContext.globalState.update(KEY_CACHE_MISS_TOTAL, _cacheMissTotal);
		} catch { }
	}, 2000);
}

function markCacheHit() {
	_cacheHitTotal++;
	_statsDirty = true;
	_scheduleStatsFlush();
}

function markCacheMiss() {
	_cacheMissTotal++;
	_statsDirty = true;
	_scheduleStatsFlush();
}

function getPersistentCacheStatsSnapshot() {
	return {
		hitTotal: _cacheHitTotal || 0,
		missTotal: _cacheMissTotal || 0,
	};
}

function initUserTracking(context) {
	_loadPersistentStats(context);
	_startDurationTimer();
}

function _startDurationTimer() {
	if (_durationTimer || !extensionContext) return;

	const tick = () => {
		if (!extensionContext) return;
		const total = extensionContext.globalState.get(KEY_TOTAL_SECONDS, 0) || 0;
		extensionContext.globalState.update(KEY_TOTAL_SECONDS, total + 60);
		_durationTimer = setTimeout(tick, 60000); // Schedule the next run after finishing
	};

	_durationTimer = setTimeout(tick, 60000);
}

function finishUserTracking() {
	if (_durationTimer) {
		clearTimeout(_durationTimer);
		_durationTimer = null;
	}
	if (extensionContext && _statsDirty) {
		try {
			extensionContext.globalState.update(KEY_CACHE_HIT_TOTAL, _cacheHitTotal);
			extensionContext.globalState.update(KEY_CACHE_MISS_TOTAL, _cacheMissTotal);
		} catch { }
	}
	// ★ 停止 WqReporter
	if (_wqReporter) {
		_wqReporter.stop();
		_wqReporter = null;
	}
}

// ============================================================================
// ★ WqReporter: 统计上报模块 (device_id + total_seconds + user_id)
// ============================================================================
const KEY_DEVICE_ID = 'qqq_device_id';
const WQ_API_BASE = 'https://gh555.com/api';
const WQ_GOOD_SLG = 'qqq';

/**
 * 获取 device_id：IDE 实例级别的唯一标识
 * 每个 IDE（VS Code/Cursor/Trae）独立生成 UUID，存在各自的 globalState
 */
function getDeviceId() {
	if (!extensionContext) return null;
	let deviceId = extensionContext.globalState.get(KEY_DEVICE_ID);
	if (!deviceId) {
		deviceId = crypto.randomUUID();
		extensionContext.globalState.update(KEY_DEVICE_ID, deviceId);
		logMessage(`[wq] Generated new device_id: ${deviceId}`, 'INFO');
	}
	return deviceId;
}

/**
 * 获取 user_id：从设置中读取手机号
 */
function getUserPhone() {
	try {
		const phone = vscode.workspace.getConfiguration('qqq').get('phone');
		if (phone && typeof phone === 'string' && phone.trim()) {
			return phone.trim();
		}
	} catch { }
	return undefined;
}

/**
 * 获取 IDE 类型
 */
function getIDEFamily() {
	try {
		const appName = (vscode.env.appName || '').toLowerCase();
		if (appName.includes('cursor')) return 'cursor';
		if (appName.includes('trae')) return 'trae';
		if (appName.includes('insiders')) return 'vscode-insiders';
	} catch { }
	return 'vscode';
}

/**
 * 获取插件版本
 */
function getClientVersion() {
	try {
		return vscode.extensions.getExtension('gh555.qqq')?.packageJSON?.version || 'unknown';
	} catch { }
	return 'unknown';
}

let _wqReporter = null;

class WqReporter {
	constructor() {
		this.retryDelay = 60 * 1000;
		this._initialTimer = null;
		this._intervalTimer = null;
		this._stopped = false;
	}

	start() {
		if (this._stopped) return;
		// 1. 启动后随机抖动 30~120 秒发一次
		const initialDelay = 30000 + Math.random() * 90000;
		this._initialTimer = setTimeout(() => this._ping(), initialDelay);
		// 2. 每 12 小时兖底发一次
		this._intervalTimer = setInterval(() => this._ping(), 12 * 60 * 60 * 1000);
		logMessage(`[wq] Reporter started, initial ping in ${Math.round(initialDelay/1000)}s`, 'INFO');
	}

	stop() {
		this._stopped = true;
		if (this._initialTimer) {
			clearTimeout(this._initialTimer);
			this._initialTimer = null;
		}
		if (this._intervalTimer) {
			clearInterval(this._intervalTimer);
			this._intervalTimer = null;
		}
	}

	async _ping() {
		if (this._stopped || !extensionContext) return;
		try {
			const deviceId = getDeviceId();
			const userId = getUserPhone();
			const totalSeconds = extensionContext.globalState.get(KEY_TOTAL_SECONDS, 0) || 0;

			const body = {
				good_slg: WQ_GOOD_SLG,
				device_id: deviceId,
				total_seconds: Math.floor(totalSeconds),
				event_time: Math.floor(Date.now() / 1000),
				ide_family: getIDEFamily(),
				client_ver: getClientVersion()
			};
			if (userId) body.user_id = userId;

			const bodyStr = JSON.stringify(body);

			// 使用 Node.js https 模块，避免 VS Code 环境下 fetch 可能的问题
			const data = await new Promise((resolve, reject) => {
				const url = new URL(`${WQ_API_BASE}/wq/ping`);
				const options = {
					hostname: url.hostname,
					port: 443,
					path: url.pathname,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(bodyStr)
					}
				};

				const req = require('https').request(options, (res) => {
					let chunks = [];
					res.on('data', chunk => chunks.push(chunk));
					res.on('end', () => {
						try {
							resolve(JSON.parse(Buffer.concat(chunks).toString()));
						} catch (e) {
							reject(new Error('Invalid JSON response'));
						}
					});
				});

				req.on('error', reject);
				req.setTimeout(10000, () => {
					req.destroy();
					reject(new Error('Request timeout'));
				});

				req.write(bodyStr);
				req.end();
			});

			if (data.ok) {
				this.retryDelay = 60 * 1000; // 重置重试延迟
				logMessage(`[wq] Ping ok, delta=${data.delta_seconds}s`, 'INFO');
				// 服务端纠正
				if (data.force_reset && typeof data.server_total_seconds === 'number') {
					extensionContext.globalState.update(KEY_TOTAL_SECONDS, data.server_total_seconds);
					logMessage(`[wq] Force reset local total to ${data.server_total_seconds}`, 'INFO');
				}
			} else {
				// 服务端返回错误，打印详情以便调试
				logMessage(`[wq] Ping rejected: ${JSON.stringify(data)}, body: ${bodyStr}`, 'WARN');
			}
		} catch (e) {
			// 网络错误才重试
			logMessage(`[wq] Ping network error: ${e.message}, retry in ${this.retryDelay/1000}s`, 'WARN');
			if (!this._stopped) {
				setTimeout(() => this._ping(), this.retryDelay);
				this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60 * 1000); // 最大 1 小时
			}
		}
	}
}

function startWqReporter() {
	if (_wqReporter) return;
	_wqReporter = new WqReporter();
	_wqReporter.start();
}

// ★ 安全解析 JSON（统一处理非 JSON 响应）
function safeParseJson(text, tag = 'api') {
	try {
		return { ok: true, data: JSON.parse(text), hint: null };
	} catch {
		const hint = text.slice(0, 50).replace(/[\r\n]/g, ' ');
		logMessage(`[wq] ${tag}: non-JSON response: ${hint}...`, 'WARN');
		return { ok: false, data: null, hint };
	}
}

// ============================================================================
// ★ Phone 配置变化监听：失焦时静默验证并拉取配置
// ============================================================================
let _phoneVerifyDebounce = null;

/**
 * 抓取云端配置并应用到本地
 * @param {string} phone - 手机号
 * @param {object} options - 选项
 * @param {boolean} options.silent - 是否静默模式（成功不弹窗，只在失败时弹窗）
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function syncCloudConfig(phone, options = {}) {
	const { silent = false } = options;

	// 未填写账号
	if (!phone || !phone.trim()) {
		const msg = q('wq.noPhone');
		if (!silent) showAutoCloseNotification('warning', msg);
		return { success: false, message: msg };
	}

	phone = phone.trim();

	if (!extensionContext) {
		const msg = q('wq.notReady');
		if (!silent) showAutoCloseNotification('warning', msg);
		return { success: false, message: msg };
	}

	const deviceId = getDeviceId();
	if (!deviceId) {
		const msg = q('wq.noDevice');
		if (!silent) showAutoCloseNotification('warning', msg);
		return { success: false, message: msg };
	}

	try {
		// 使用 https.request 代替 fetch，因为 VS Code 对 fetch 有诸多限制
		const url = new URL(`${WQ_API_BASE}/gaea/qqq/config`);
		const postData = JSON.stringify({ phone, device_id: deviceId });

		const data = await new Promise((resolve, reject) => {
			const options = {
				hostname: url.hostname,
				port: 443,
				path: url.pathname,
				method: 'POST',
				timeout: 10000,
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(postData)
				}
			};

			const req = require('https').request(options, (res) => {
				let chunks = [];
				res.on('data', chunk => chunks.push(chunk));
				res.on('end', () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString()));
					} catch (e) {
						reject(new Error('Invalid JSON response'));
					}
				});
			});

			req.on('error', (e) => reject(e));
			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Request timeout'));
			});

			req.write(postData);
			req.end();
		});

		if (data.ok && data.profile) {
			// 写入配置到 globalState（不写 settings.json）
			for (const [key, value] of Object.entries(data.profile)) {
				await extensionContext.globalState.update(`cfg_${key}`, value);
			}
			const msg = q('wq.syncSuccessFmt', phone);
			if (!silent) showAutoCloseNotification('success', msg);
			logMessage(`[wq] Config synced for phone: ${phone}`, 'INFO');
			return { success: true, message: msg };
		} else {
			// 根据错误类型返回对应消息
			let reason = data.error || 'unknown';
			if (data.error === 'phone_not_registered') reason = q('wq.errPhoneNotRegistered');
			else if (data.error === 'not_purchased') reason = q('wq.errNotPurchased');
			else if (data.error === 'rate_limit') reason = q('wq.errRateLimit');
			else if (data.error === 'too_many_accounts') reason = q('wq.errTooManyAccounts');
			else if (data.error === 'invalid_phone') reason = q('wq.errInvalidPhone');

			const msg = q('wq.syncFailedFmt', phone, reason);
			showAutoCloseNotification('warning', msg);
			return { success: false, message: msg };
		}
	} catch (e) {
		logMessage(`[wq] Sync config error: ${e.message}`, 'WARN');
		const msg = q('wq.syncFailedFmt', phone, q('wq.errNetwork'));
		showAutoCloseNotification('error', msg);
		return { success: false, message: msg };
	}
}

// ★ 旧函数保留兼容，内部调用 syncCloudConfig
async function verifyPhoneAndSyncConfig(phone) {
	await syncCloudConfig(phone, { silent: false });
}

function onPhoneConfigChanged(phone) {
	// 防抖：等 500ms 确保用户键入完
	if (_phoneVerifyDebounce) {
		clearTimeout(_phoneVerifyDebounce);
	}
	_phoneVerifyDebounce = setTimeout(() => {
		_phoneVerifyDebounce = null;
		if (phone && phone.trim()) {
			syncCloudConfig(phone.trim(), { silent: false });
		}
	}, 500);
}

function getTotalSecondsIncludingSession() {
	if (!extensionContext) return 0;
	return extensionContext.globalState.get(KEY_TOTAL_SECONDS, 0) || 0;
}

// ============================================================================
// ★ Status bar management
// ============================================================================
let statusBarItem = null;

function initStatusBar() {
	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Infinity);
		statusBarItem.command = "qqq.showStatusPanel";
		if (extensionContext) extensionContext.subscriptions.push(statusBarItem);
		statusBarItem.show();
	}
}

function disposeStatusBar() {
	if (statusBarItem) {
		statusBarItem.dispose();
		statusBarItem = null;
	}
}

// ==================== Path helper functions ====================

// ★ Unified path canonicalization (uppercase drive letter + trim trailing slash + remove UNC prefix)
function canonicalizeExistingPath(p) {
	if (!p) return "";
	let out = path.normalize(p);

	if (process.platform === "win32") {
		out = out.replace(/^\\\\\?\\/, "");
		out = out.replace(/^[a-z]:/i, (m) => m.toUpperCase());
	}

	// Remove trailing slashes (keep root like C:\ or /)
	try {
		const root = path.parse(out).root;
		if (out.length > root.length) out = out.replace(/[\\\/]+$/, "");
	} catch { }

	return out;
}


// ★ Unified cache-key generator (case-insensitive on Windows)
function cacheKeyForPath(p) {
	const canon = canonicalizeExistingPath(p);
	return process.platform === "win32" ? canon.toLowerCase() : canon;
}


// ★ Unified byte formatter, decimals controls fractional digits (default 1)
function formatBytes(size, decimals = 1) {
	if (size == null || isNaN(size)) return "?";
	// const units = ["b", "kb", "mb", "gb"];
	const units = ["B", "KB", "MB", "GB"];
	let idx = 0;
	let val = size;
	while (val >= 1024 && idx < units.length - 1) {
		val /= 1024;
		idx++;
	}
	return `${val.toFixed(idx > 0 ? decimals : 0)} ${units[idx]}`;
}

function formatHours(totalSeconds) {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	return `${h}h : ${m.toString().padStart(2, '0')}m`;
}

/**
 * ★ Unified compact time formatter (mm:ss or h:mm:ss)
 * @param {number} ms - Milliseconds
 * @returns {string}
 */
function formatTimeCompact(ms) {
	const total = Math.floor(ms / 1000);
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const ss = String(s).padStart(2, '0');
	const mm = String(m).padStart(2, '0');
	if (h > 0) return `${h}:${mm}:${ss}`;
	return `${m}:${ss}`;
}

/**
 * ★ Unified compact byte formatter (e.g. "222m", "1.2g")
 * @param {number} bytes - Bytes
 * @returns {string}
 */
function formatBytesCompact(bytes) {
	if (!bytes || bytes <= 0) return '0k';
	if (bytes < 1048576) return `${Math.round(bytes / 1024)}k`;
	if (bytes < 1073741824) return `${Math.round(bytes / 1048576)}m`;
	return `${(bytes / 1073741824).toFixed(1)}g`;
}

function formatCompactTime(totalSeconds) {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	return { h, m };
}

function cleanReason(s, maxLen = 260) {
	const t = String(s || "").replace(/\s+/g, " ").trim();
	return t.length > maxLen ? t.slice(0, maxLen) + "..." : t;
}

function getEnginePreference() {
	try {
		const v = getConfig("ioEngine") || "v16  auto";
		// ★ v16 config: "v16  auto" -> auto, "Exclude Python" -> excludePython
		if (v === "v16  auto" || v === "auto") return "auto";
		if (v === "Exclude Python") return "excludePython";
		// Legacy fallback (node -> shell)
		if (v === "node") return "shell";
		return v;
	} catch {
		return "auto";
	}
}

// ============================================================================
// ★ Transaction Manager (strong consistency management based on globalState)
// ============================================================================
const KEY_TRANSACTIONS = "qqq.transactions";

/**
 * Async get directory snapshot: record full paths of all existing files and folders in the directory
 * @param {string} targetDir - Target directory
 * @returns {Promise<string[]>} - Array of full paths (normalized)
 */
async function getDirectorySnapshot(targetDir) {
	if (!targetDir || !fs.existsSync(targetDir)) {
		return [];
	}

	try {
		const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
		const snapshot = [];

		for (const entry of entries) {
			const fullPath = path.normalize(path.join(targetDir, entry.name));
			snapshot.push(fullPath);
		}

		return snapshot;
	} catch (e) {
		logMessage(q('snapshot.getFailed', e.message), "WARN");
		return [];
	}
}

const TransactionManager = {
	getTransactions() {
		if (!extensionContext) return [];
		return extensionContext.globalState.get(KEY_TRANSACTIONS, []);
	},

	async saveTransaction(trans) {
		if (!extensionContext) return;
		let list = this.getTransactions();

		// ★ Ultimate optimal solution: perfect whitelist field sanitization (prevent 1.8MB explosion)
		const now = Date.now();
		const cleanTrans = {
			id: trans.id,
			targetDir: trans.targetDir,
			// Use toString() instead of fsPath to ensure 100% compatibility with all schemes
			targetUri: typeof trans.targetUri === 'string' ? trans.targetUri : trans.targetUri?.toString(),
			docUri: typeof trans.docUri === 'string' ? trans.docUri : trans.docUri?.toString(),
			tempFiles: Array.isArray(trans.tempFiles) ? trans.tempFiles : [],
			status: 'pending',
			createdAt: trans.createdAt || now,
			// ★ lastActiveAt: last active time of the transaction, used as time baseline for recover scenario
			// Updated on each cancel check; rollback uses this time instead of file birthtime
			lastActiveAt: trans.lastActiveAt || now,
			taskType: trans.taskType || 'unknown',
			// Reserved metadata space (simple types only)
			extra: trans.extra || {}
		};

		list.push(cleanTrans);

		// ★ Ultimate optimal solution: 200/100 priority truncation logic
		if (list.length > 200) {
			const SIXTY_DAYS = 5184000000;  // 60 days
			const now = Date.now();

			// Define cleanup weight: closed (success/cancelled) highest, expired (>60 days) next
			const getWeight = (t) => {
				let weight = 0;
				if (t.status === 'success' || t.status === 'cancelled') weight += 2;
				if (now - (t.createdAt || 0) > SIXTY_DAYS) weight += 1;
				return weight;
			};

			// Sort by weight desc, tie-breaker by time oldest->newest
			const sortedForDeletion = [...list].sort((a, b) => {
				const wA = getWeight(a);
				const wB = getWeight(b);
				if (wA !== wB) return wB - wA; // higher weight first
				return (a.createdAt || 0) - (b.createdAt || 0); // older first
			});

			const toDeleteIds = new Set(sortedForDeletion.slice(0, 100).map(t => t.id));
			list = list.filter(t => !toDeleteIds.has(t.id));
		}

		await extensionContext.globalState.update(KEY_TRANSACTIONS, list);
	},

	async updateTransaction(id, updates) {
		if (!extensionContext) return;
		let list = this.getTransactions();
		list = list.map(t => t.id === id ? { ...t, ...updates } : t);
		await extensionContext.globalState.update(KEY_TRANSACTIONS, list);
	},

	/**
	 * ★ Lightweight update of lastActiveAt (used for frequent calls during cancel check)
	 * Throttled to at most once per 5 seconds to avoid excessive I/O
	 */
	_lastActiveThrottle: {},
	async touchLastActive(transId) {
		if (!extensionContext || !transId) return;
		const now = Date.now();
		// Throttle: at most once per 5 seconds
		const lastTouch = this._lastActiveThrottle[transId] || 0;
		if (now - lastTouch < 5000) return;
		this._lastActiveThrottle[transId] = now;

		try {
			let list = this.getTransactions();
			let found = false;
			list = list.map(t => {
				if (t.id === transId) {
					found = true;
					return { ...t, lastActiveAt: now };
				}
				return t;
			});
			if (found) {
				await extensionContext.globalState.update(KEY_TRANSACTIONS, list);
			}
		} catch (e) {
			// Silent failure, do not affect main flow
		}
	},

	async removeTransaction(id) {
		if (!extensionContext) return;
		let list = this.getTransactions();
		list = list.filter(t => t.id !== id);
		await extensionContext.globalState.update(KEY_TRANSACTIONS, list);
	},

	async rollback(transOrId, options = {}) {
		// ★ Always fetch the latest transaction data from globalState (avoid stale snapshot)
		const transId = typeof transOrId === 'string' ? transOrId : transOrId?.id;
		if (!transId) {
			logMessage(q('rollback.invalidId'), "WARN");
			return;
		}

		// Re-fetch latest data from globalState
		const trans = this.getTransactions().find(t => t.id === transId);
		if (!trans) {
			logMessage(q('rollback.notFound', transId), "WARN");
			return;
		}

		logMessage(q('rollback.rollingBack', trans.id), "WARN");

		// 0. ★ Delete residual anchor (zero-cost, zero-risk: only delete the specific anchor string format)
		try {
			const anchor = `/__PENDING_${trans.id}/`;
			const targetUri = trans.targetUri || trans.docUri;
			if (targetUri) {
				const uri = typeof targetUri === 'string'
					? (targetUri.startsWith('file:') ? vscode.Uri.parse(targetUri) : vscode.Uri.file(targetUri))
					: targetUri;
				try {
					const doc = await vscode.workspace.openTextDocument(uri);
					const text = doc.getText();
					const idx = text.indexOf(anchor);
					if (idx !== -1) {
						const pos = doc.positionAt(idx);
						const endPos = doc.positionAt(idx + anchor.length);
						const range = new vscode.Range(pos, endPos);
						const edit = new vscode.WorkspaceEdit();
						edit.replace(uri, range, '');
						await vscode.workspace.applyEdit(edit);
						logMessage(q('rollback.anchorDeleted', anchor), "INFO");
					}
				} catch (e) {
					logMessage(q('rollback.anchorDeleteFailed', e.message), "WARN");
				}
			}
		} catch (e) {
			logMessage(q('rollback.anchorError', e.message), "WARN");
		}

		logMessage(q('rollback.completed'), "INFO");
		await this.removeTransaction(trans.id);

		// ★ Background cleanup (do not block dialogs and user interaction)
		const isRecover = options.isRecover === true;
		if (trans.targetDir) {
			setTimeout(() => {
				// 1. Clean .part/.ytdl temp files (pass trans to clean pre-registered tempFiles)
				// ★ Pass isRecover so cleanup uses transaction time baseline
				this._cleanupTempFiles(trans.targetDir, trans, { isRecover }).catch(e => {
					logMessage(q('cleanup.tempFileFailed', e.message), "WARN");
				});
			}, 100);

			// ★ Decide fallback cleanup timing based on task type
			const taskType = trans.taskType || '';

			if (taskType === 'video') {
				// ★ video type: skip cleanup here; VideoDownloadController will run it right after killAll
				// (because yt-dlp process must be killed before deleting files)
				logMessage(q('cleanup.videoWaitKillAll'), "INFO");
			} else if (taskType === 'html') {
				// ★ html type: no long-running process, run cleanup after 1 second
				setTimeout(() => {
					this._cleanupOrphanFiles(trans.targetDir).catch(e => {
						logMessage(q('cleanup.fallbackFailed', e.message), "WARN");
					});
				}, 1000);
			} else {
				// ★ Other types (local_file, etc.): run pure fallback after 11 seconds
				setTimeout(() => {
					this._cleanupOrphanFiles(trans.targetDir).catch(e => {
						logMessage(q('cleanup.fallbackFailed', e.message), "WARN");
					});
				}, 11000);
			}
		}

		// ★ Return trans so caller can get targetDir
		return trans;
	},

	/**
	 * ★ Background temp file cleanup (match by transId anchor + fuzzy match for .part/.ytdl etc.)
	 * @param {string} targetDir
	 * @param {object} trans - Optional transaction object containing id and tempFiles
	 * @param {object} options - Optional params { isRecover: boolean }
	 */
	async _cleanupTempFiles(targetDir, trans = null, options = {}) {
		if (!targetDir || !fs.existsSync(targetDir)) return;

		const tempExts = ['.part', '.ytdl', '.tmp', '.download'];
		const now = Date.now();
		const SIX_MINUTES = 360000;
		const transId = trans?.id || null;

		// Collect files to clean (anchor match vs fuzzy match)
		const transIdMatchFiles = new Set(); // ★ Match by transId anchor (first 4 chars, no time limit)
		const fuzzyTempFiles = new Set();    // Fuzzy temp files (with 6-minute limit)

		// 1. Scan files in directory
		try {
			const files = fs.readdirSync(targetDir);
			for (const f of files) {
				const fullPath = path.normalize(path.join(targetDir, f));
				const ext = path.extname(f).toLowerCase();

				// ★ Strategy A: match by transId anchor (first 4 chars); unified 4+2 filename format
				// Filename format: {anchor4}{index2}_{date}__{day}__{time}{ext}
				// Example: jhrY00_2026.02.06__5__12.20.30.mp4 (anchor=jhrY, index=00)
				if (transId && transId.length >= 4 && f.startsWith(transId.slice(0, 4))) {
					transIdMatchFiles.add(fullPath);
					continue; // Already matched by anchor, no need fuzzy match
				}

				// ★ Strategy B: fuzzy match temp suffix files (with 6-minute limit)
				if (tempExts.includes(ext) || /\.f\d+\.(mp4|m4a|webm|mkv|mp3|opus|aac)(\.part)?$/i.test(f)) {
					fuzzyTempFiles.add(fullPath);
				}
			}
		} catch { }

		// 2. Include trans.tempFiles explicitly recorded (also exact match, no time limit)
		if (trans && Array.isArray(trans.tempFiles)) {
			trans.tempFiles.forEach(f => {
				if (f && typeof f === 'string') transIdMatchFiles.add(path.normalize(f));
			});
		}

		const allFiles = new Set([...transIdMatchFiles, ...fuzzyTempFiles]);
		if (allFiles.size === 0) return;

		// ★ Key fix: before deleting anything, first fetch the full reference whitelist
		// So even if a file is in tempFiles, if it's referenced by a document, never delete it
		const referencedItems = this._getReferencedItemsSync(targetDir);

		let deletedCount = 0;

		// 3. Execute deletion
		for (const fullPath of allFiles) {
			try {
				const fileName = path.basename(fullPath);
				// ★ Reference protection: if in whitelist, skip
				if (referencedItems.has(fileName.toLowerCase())) {
					continue;
				}

				if (!fs.existsSync(fullPath)) continue;
				const stat = fs.statSync(fullPath);
				if (!stat.isFile()) continue;

				// ★ Exact-match files: no time limit, delete directly
				// ★ Fuzzy-match files: keep 6-minute limit
				const isExactMatch = transIdMatchFiles.has(fullPath);
				let shouldDelete = false;

				if (isExactMatch) {
					// ★ transId anchor match / tempFiles record: no time limit, delete directly
					shouldDelete = true;
				} else {
					// ★ Fuzzy-match files: keep 6-minute limit
					const birthtime = stat.birthtimeMs || stat.mtimeMs || 0;
					if (birthtime && !isNaN(birthtime)) {
						const age = now - birthtime;
						shouldDelete = age >= 0 && age < SIX_MINUTES;
					}
				}

				if (!shouldDelete) continue;

				// ★ With retry logic
				let deleted = false;
				for (let retry = 0; retry < 5 && !deleted; retry++) {
					try {
						fs.unlinkSync(fullPath);
						logMessage(q('cleanup.tempFileDeleted', fileName, isExactMatch ? q('cleanup.exactMatch') : ''), "INFO");
						deleted = true;
						deletedCount++;
					} catch (e) {
						if ((e.code === 'EBUSY' || e.code === 'EPERM') && retry < 4) {
							await new Promise(r => setTimeout(r, 500 * (retry + 1)));
						} else { break; }
					}
				}
			} catch { }
		}

		if (deletedCount > 0) {
			logMessage(q('cleanup.tempFileCompleted', deletedCount), "INFO");
		}

		// ★ After cleanup, check if qqq folder is empty and created by us; if so, delete it
		try {
			const h = require('./h');
			h.cleanupEmptyQqqFolder(path.dirname(targetDir));
		} catch { }
	},

	/**
	 * ★ Sync/fast get all current references in the directory (for whitelist check before cleanup)
	 * Includes: in-memory docs, on-disk docs, active transactions
	 */
	_getReferencedItemsSync(targetDir) {
		const referencedItems = new Set();
		try {
			const parentDir = path.dirname(targetDir);
			if (!parentDir || !fs.existsSync(parentDir)) return referencedItems;

			// 1. Scan all currently open documents (memory protection)
			vscode.workspace.textDocuments.forEach(doc => {
				try {
					const docDir = path.dirname(doc.uri.fsPath);
					if (path.normalize(docDir).toLowerCase() === path.normalize(parentDir).toLowerCase()) {
						this._extractReferences(doc.getText(), referencedItems);
					}
				} catch { }
			});

			// 2. Scan files on disk (text files only)
			const BINARY_EXTS = new Set([
				".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
				".exe", ".dll", ".zip", ".tar", ".gz",
				".mp3", ".mp4", ".avi", ".mov", ".mkv",
				".pdf", ".doc", ".docx", ".psd", ".ai",
			]);
			const parentFiles = fs.readdirSync(parentDir);
			for (const fileName of parentFiles) {
				try {
					if (fileName === "qqq" || fileName === "qqq.pure") continue;
					const fullPath = path.join(parentDir, fileName);
					const ext = path.extname(fileName).toLowerCase();
					if (BINARY_EXTS.has(ext)) continue;

					const stat = fs.statSync(fullPath);
					if (!stat.isFile() || stat.size > 60 * 1048576) continue; // Narrow scope to improve speed

					const content = fs.readFileSync(fullPath, "utf-8");
					this._extractReferences(content, referencedItems);
				} catch { }
			}

			// 3. Scan all active transactions (protect files being downloaded)
			const allTrans = this.getTransactions();
			for (const otherTrans of allTrans) {
				if (Array.isArray(otherTrans.landedFiles)) {
					otherTrans.landedFiles.forEach(f => {
						if (f) referencedItems.add(path.basename(f).toLowerCase());
					});
				}
				if (Array.isArray(otherTrans.tempFiles)) {
					otherTrans.tempFiles.forEach(f => {
						if (f) referencedItems.add(path.basename(f).toLowerCase());
					});
				}
			}
		} catch (e) {
			logMessage(q('cleanup.refScanFailed', e.message), "WARN");
		}
		return referencedItems;
	},

	/**
	 * ★ Ultimate fallback: clean orphan files and folders created < 5 minutes in qqq folder
	 * @param {string} targetDir - Path to qqq folder
	 */
	async _cleanupOrphanFiles(targetDir) {
		// ★ Wrap the whole function in try-catch to prevent any exception from crashing the extension
		try {
			if (!targetDir || typeof targetDir !== 'string') return;
			if (!fs.existsSync(targetDir)) return;

			// ★ Use unified reference scanning logic (memory + disk + transactions)
			const referencedItems = this._getReferencedItemsSync(targetDir);

			// ★ Get all files and folders in qqq folder (treat equally)
			let qqqItems = [];  // { name: string, isDir: boolean }
			try {
				const entries = fs.readdirSync(targetDir);
				for (const f of entries) {
					try {
						const fullPath = path.join(targetDir, f);
						const stat = fs.statSync(fullPath);
						qqqItems.push({ name: f, isDir: stat.isDirectory() });
					} catch { }
				}
			} catch { return; }

			if (!qqqItems.length) return;

			// ★ Find orphans (files and folders treated equally)
			const orphans = qqqItems.filter(item => !referencedItems.has(item.name.toLowerCase()));
			if (!orphans.length) return;

			// ★ Delete orphan files/folders created < 5 minutes
			const now = Date.now();
			const FIVE_MINUTES = 300000;
			let cleanedCount = 0;

			for (const orphan of orphans) {
				try {
					const fullPath = path.join(targetDir, orphan.name);
					const stat = fs.statSync(fullPath);
					// ★ Ensure birthtimeMs is valid
					const birthtime = stat.birthtimeMs || stat.mtimeMs || 0;
					if (!birthtime || isNaN(birthtime)) continue;

					const age = now - birthtime;
					// ★ Relax: allow age < 0 (system clock adjustment), and extend to 6 minutes
					if (age < 360000) {
						if (orphan.isDir) {
							// ★ Folder: recursive delete with rmSync
							fs.rmSync(fullPath, { recursive: true, force: true });
							logMessage(q('cleanup.orphanFolderDeleted', orphan.name, Math.round(age / 1000)), "INFO");
						} else {
							// ★ File: unlink with retry logic
							let deleted = false;
							for (let retry = 0; retry < 3 && !deleted; retry++) {
								try {
									fs.unlinkSync(fullPath);
									logMessage(q('cleanup.orphanFileDeleted', orphan.name, Math.round(age / 1000)), "INFO");
									deleted = true;
								} catch (e) {
									if ((e.code === 'EBUSY' || e.code === 'EPERM') && retry < 2) {
										await new Promise(r => setTimeout(r, 500 * (retry + 1)));
									} else { break; }
								}
							}
						}
						cleanedCount++;
					}
				} catch { }
			}

			if (cleanedCount > 0) {
				logMessage(q('cleanup.orphanCompleted', cleanedCount), "INFO");
			}

			// ★ After cleanup, check if qqq folder is empty and created by us; if so, delete it
			try {
				const h = require('./h');
				h.cleanupEmptyQqqFolder(path.dirname(targetDir));
			} catch { }
		} catch (e) {
			// ★ Catch all exceptions to prevent extension crash
			logMessage(q('cleanup.orphanException', e.message), "WARN");
		}
	},

	async recover() {
		const list = this.getTransactions();
		if (list.length === 0) return;

		logMessage(q('recovery.found', list.length), "WARN");
		for (const trans of list) {
			// Simple rule: if leftover, clean it. recover is only called on startup.
			// ★ Pass isRecover: true so cleanup uses lastActiveAt as time baseline
			// instead of file birthtime, so even if VS Code restarts long after crash, rollback works correctly
			await this.rollback(trans, { isRecover: true });
		}
	},

	createTransactionId() {
		const chars = 'ABEGHJKLNQRVWXYZabeghjknqrvwxyz234567890O1lI';
		let id = '';
		for (let i = 0; i < 6; i++) {
			id += chars[Math.floor(Math.random() * chars.length)];
		}
		return id;
	},

	/**
	 * ★ Helper: extract all referenced qqq file names from content
	 * Improved regex: supports filenames with spaces and special chars until common terminators
	 */
	_extractReferences(content, set) {
		if (!content) return;
		// Improved regex:
		// 1. Match qqq/ or qqq\
		// 2. Match subsequent chars until encountering quotes, angle brackets, brackets, parentheses, newline, or our special \/ terminator
		const regex = /qqq[\\/]([^"'<>\[\]\(\)\r\n]+?)(?=[\\"']|[\r\n]|\\\/|\s*[\)\}\]]|$)/gi;
		let match;
		regex.lastIndex = 0;
		while ((match = regex.exec(content))) {
			let name = (match[1] || "").trim();
			// If filename ends with backslash (possibly our /\\...\\/ format), remove it
			if (name.endsWith('\\')) name = name.slice(0, -1).trim();
			if (name) set.add(name.toLowerCase());
		}
	},

	async insertAnchor(editor, transId) {
		try {
			// Check if editor is still valid
			if (!editor || !vscode.window.visibleTextEditors.includes(editor)) {
				return false;
			}
			const anchor = `/__PENDING_${transId}/`;
			const success = await editor.edit(editBuilder => {
				editBuilder.replace(editor.selection, anchor);
			});
			return success;
		} catch (e) {
			logMessage(`insertAnchor failed: ${e.message}`, "WARN");
			return false;
		}
	}
};

// ============================================================================
// ★ Task counter system (per file path, a permanently increasing task counter q)
// ============================================================================
const KEY_TASK_COUNTERS = "qqq.task_counters";
let _iconCounter = Math.floor(Math.random() * 17);
const TaskCounter = {
	getCount(filePath) {
		if (!extensionContext) return 0;
		const counters = extensionContext.globalState.get(KEY_TASK_COUNTERS, {});
		return counters[filePath] || 0;
	},

	/**
	 * Increment and return new task count (never resets, counted per file)
	 */
	async increment(filePath) {
		if (!extensionContext) return 1;
		const counters = extensionContext.globalState.get(KEY_TASK_COUNTERS, {});
		const newCount = (counters[filePath] || 0) + 1;
		counters[filePath] = newCount;
		await extensionContext.globalState.update(KEY_TASK_COUNTERS, counters);
		return newCount;
	},

	incrementIcon() {
		_iconCounter++;
		return _iconCounter;
	},

	/**
	 * Truncate path display: truncate directory part if it exceeds 22 chars
	 * Example: E:\s\dqqqqqqqqqqqqqqqqqqq\11.txt -> ...qqqqqqqqqqqqqqq\11.txt
	 * ★ Always display with forward slashes (avoid Windows backslashes being escaped as double slashes)
	 */
	formatPath(filePath, maxDirLen = 22) {
		if (!filePath) return '';

		// ★ Convert to forward slashes for user-friendly display, avoid backslash escaping issues
		const normalizedPath = filePath.replace(/\\/g, '/');
		const lastSlash = normalizedPath.lastIndexOf('/');

		let dir = lastSlash >= 0 ? normalizedPath.substring(0, lastSlash) : '';
		const fileName = lastSlash >= 0 ? normalizedPath.substring(lastSlash + 1) : normalizedPath;

		let displayDir = dir;
		if (dir.length > maxDirLen) {
			// Keep only the rightmost 22 characters
			displayDir = '...' + dir.slice(-maxDirLen);
		}

		return displayDir + '/' + fileName;
	},

	/**
	 * Generate task title: qqq: 'truncated path ❤️ taskId'
	 * @param {string} filePath - File path
	 * @param {string} taskId - Task ID (6-char random string)
	 * @param {number} iconNum - Global icon index (increments across files)
	 * @param {string} suffix - Optional suffix description
	 */
	formatTitle(filePath, taskId, iconNum = 1, suffix = '') {
		// ★ Fixed sequence of 17 icons looping (global queue across files)
		// Rules: alternate shape (heart vs non-heart), alternate color, avoid visual repetition
		const ICONS = [
			'❤️', '⬛', '💚', '⭐', '💜', '🔵',
			'💙', '🌸', '🤎', '⬜', '💛', '🔷',
			'🖤', '🍄', '🤍', '🌺', '🔶'
		];
		const icon = ICONS[(iconNum - 1) % ICONS.length];

		const displayPath = this.formatPath(filePath);
		const base = q('global.taskPrefix', displayPath, icon, taskId);
		return suffix ? `${base} ${suffix}` : base;
	}
};

/**
 * ★ Single source of truth: precise classification + full snapshot
 * Returns { type, subType, files?, totalSize?, rawStatus }
 * - type: 'whitelist' | 'yellowlist'
 * - subType: 'text' | 'html_text' | 'file' | 'image' | 'html_rich' | 'video_url' | 'unknown'
 * - files: file list (only when hasFile)
 * - totalSize: total file size (only when hasFile)
 * - rawStatus: original status { hasFile, hasHtml, hasImage, hasText }
 *
 * ★ 引擎优先级：Rust > Shell > VS Code API
 * ★ 极致优化：200ms 缓存 + 精简 timeout + 合并调用
 */

// ★ wq 缓存（避免短时间内重复调用，如 q1.js 中连续两次 wq()）
let _wqCache = null;
let _wqCacheTime = 0;
const WQ_CACHE_TTL = 200; // 200ms 内重复调用直接返回缓存

async function wq() {
	// ★ 缓存命中：200ms 内的重复调用直接返回
	const now = Date.now();
	if (_wqCache && (now - _wqCacheTime) < WQ_CACHE_TTL) {
		return _wqCache;
	}

	let status = { hasFile: false, hasHtml: false, hasImage: false, hasText: false };
	let handled = false;
	let files = [];
	let totalSize = 0;
	let wqExecutionTime = 0;
	let usedEngine = "none";

	// ★ 1. 优先尝试 Rust daemon（最快，内存最小）
	// timeout 精简为 500ms（正常应 <50ms，500ms 足够处理极端情况）
	if (!handled && rustBridge && rustBridge.isAvailable()) {
		try {
			const startTime = Date.now();
			const res = await rustBridge.call("wq", {}, 500);
			wqExecutionTime = Date.now() - startTime;

			if (res && !res.error && (res.hasFile !== undefined || res.hasHtml !== undefined || res.hasImage !== undefined || res.hasText !== undefined)) {
				status = {
					hasFile: !!res.hasFile,
					hasHtml: !!res.hasHtml,
					hasImage: !!res.hasImage,
					hasText: !!res.hasText,
				};
				handled = true;
				usedEngine = "rust";

				// ★ If there are files, immediately fetch file list
				if (status.hasFile) {
					try {
						const filesRes = await rustBridge.call("getFiles", {}, 1000);
						if (filesRes && filesRes.files) {
							files = filesRes.files;
							for (const f of files) {
								try { totalSize += fs.statSync(f).size; } catch { }
							}
						}
					} catch (e) { }
				}
			}
		} catch (e) {
			logMessage(`[wq] Rust failed: ${e?.message || e}`, "DEBUG");
		}
	}

	// ★ 2. Fallback: Shell daemon（稳定兜底）
	// 如果 Shell 未启动但 Rust 失败了，按需启动 Shell
	if (!handled && shellBridge) {
		// 按需启动 Shell daemon（仅在 Rust 失败时触发）
		if (!shellBridge.isAvailable() && !shellBridge.isStarting) {
			logMessage("[wq] Rust unavailable, starting Shell daemon on-demand", "INFO");
			try {
				await shellBridge.start();
			} catch (e) {
				logMessage(`[wq] Shell on-demand start failed: ${e?.message || e}`, "WARN");
			}
		}

		if (shellBridge.isAvailable()) {
			try {
				const startTime = Date.now();
				const res = await shellBridge.call("wq", {}, 2000);
				wqExecutionTime = Date.now() - startTime;

				if (res && !res.error) {
					status = res;
					handled = true;
					usedEngine = "shell";

					// ★ If there are files, immediately fetch file list (within same Shell call window)
					if (status.hasFile) {
						try {
							const filesRes = await shellBridge.call("getFiles", {}, 2000);
							if (filesRes && filesRes.files) {
								files = filesRes.files;
								for (const f of files) {
									try { totalSize += fs.statSync(f).size; } catch { }
								}
							}
						} catch (e) { }
					}
				}
			} catch (e) {
				logMessage(`[wq] Shell failed: ${e?.message || e}`, "DEBUG");
			}
		}
	}

	// ★ 3. Ultimate fallback: VS Code API（仅能检测文本）
	if (!handled) {
		const startTime = Date.now();
		const text = await vscode.env.clipboard.readText();
		wqExecutionTime = Date.now() - startTime;
		if (text) status.hasText = true;
		usedEngine = "vscode";
	}

	// --- Core classification logic ---
	const baseResult = { rawStatus: status, files, totalSize, _engine: usedEngine };

	// ★ 辅助函数：返回结果前更新缓存
	const cacheAndReturn = (result) => {
		_wqCache = result;
		_wqCacheTime = Date.now();
		return result;
	};

	// A. Whitelist recognition (1. pure text 2. text-only HTML)
	if (status.hasText && !status.hasFile && !status.hasImage && !status.hasHtml) {
		// Save stats data
		saveWqStats(wqExecutionTime);
		return cacheAndReturn({ type: 'whitelist', subType: 'text', ...baseResult });
	}

	if (status.hasHtml && !status.hasImage && !status.hasFile) {
		try {
			const hModule = require('./h');
			const res = await hModule._getSmartHtmlFromClipboard();
			if (res && res.$) {
				const $ = res.$;
				// ★ 方案A：有效媒体标签检测（过滤无意义的空标签、追踪像素等）
				const hasValidMedia = $('img, video, iframe, embed, object').filter((i, el) => {
					const $el = $(el);
					const tag = el.tagName?.toLowerCase() || el.name?.toLowerCase();
					const src = $el.attr('src') || '';
					const dataSrc = $el.attr('data-src') || '';

					// 1. 无 src 且无 data-src 的标签视为无效
					if (!src && !dataSrc) return false;

					// 2. 过滤 javascript:/about:blank 等无效 src
					if (src && /^(javascript:|about:blank|#)/i.test(src)) return false;

					// 3. 过滤小型 data URI（追踪像素、占位符，通常 < 500 字符）
					if (src && src.startsWith('data:')) {
						// 允许较大的 base64 图片（可能是实际内容）
						if (src.length < 500) return false;
					}

					// 4. 对于 video/iframe/embed/object，必须有有效 src
					if (tag !== 'img' && !src) return false;

					return true;
				}).length > 0;

				if (!hasValidMedia) {
					// Save stats data
					saveWqStats(wqExecutionTime);
					return cacheAndReturn({ type: 'whitelist', subType: 'html_text', ...baseResult });
				}
			} else if (status.hasText) {
				// ★ HTML 检测失败但有文本，safe fallback 到 whitelist（避免不必要的事务粘贴）
				logMessage("[wq] HTML detection failed, fallback to text whitelist", "DEBUG");
				saveWqStats(wqExecutionTime);
				return cacheAndReturn({ type: 'whitelist', subType: 'text', ...baseResult });
			}
		} catch (e) {
			// ★ 异常时 safe fallback：如果同时有文本，返回 whitelist
			if (status.hasText) {
				logMessage(`[wq] HTML detection exception, fallback to text whitelist: ${e?.message || e}`, "DEBUG");
				saveWqStats(wqExecutionTime);
				return cacheAndReturn({ type: 'whitelist', subType: 'text', ...baseResult });
			}
		}
	}

	// B. Yellowlist recognition (everything else)
	let subType = 'unknown';
	if (status.hasFile) subType = 'file';
	else if (status.hasImage) subType = 'image';
	else if (status.hasHtml) subType = 'html_rich';
	else if (status.hasText) {
		const text = await vscode.env.clipboard.readText();
		const { isPlatformOrSegmentVideo } = require('./dow');
		if (isPlatformOrSegmentVideo(text) || /\.(mp4|webm|mkv|mov)(\?|$)/i.test(text)) {
			subType = 'video_url';
		}
	}

	// Save stats data
	saveWqStats(wqExecutionTime);

	return cacheAndReturn({ type: 'yellowlist', subType, ...baseResult });
}

// Helper function to save wq stats
function saveWqStats(wqExecutionTime) {
	// Outlier filtering: only count times between 1ms and 1000ms
	if (wqExecutionTime >= 1 && wqExecutionTime <= 1000) {
		// Persist stats to globalState
		if (extensionContext) {
			const wqStats = extensionContext.globalState.get("qqq_wq_stats", {
				totalTime: 0,
				count: 0,
				recentTimes: [],
				maxTime: 0
			});

			// Update stats
			wqStats.totalTime += wqExecutionTime;
			wqStats.count += 1;

			// Update last 7 times (ring buffer)
			wqStats.recentTimes.push(wqExecutionTime);
			if (wqStats.recentTimes.length > 7) {
				wqStats.recentTimes.shift();
			}

			// Update max time
			if (wqExecutionTime > wqStats.maxTime) {
				wqStats.maxTime = wqExecutionTime;
			}

			// Save to globalState
			extensionContext.globalState.update("qqq_wq_stats", wqStats);
			// Trigger status bar update
			if (typeof updateStatusBarNow === 'function') {
				updateStatusBarNow();
			}
		}
	}
}

// Helper function to save paste stats
function savePasteStats(sizeInBytes) {
	if (extensionContext) {
		const stats = extensionContext.globalState.get("qqq_paste_stats", {
			count: 0,
			totalSize: 0,
			firstUse: Date.now()
		});

		stats.count += 1;
		stats.totalSize += (sizeInBytes || 0);

		// If firstUse is missing (compat with old data), init it
		if (!stats.firstUse) stats.firstUse = Date.now();

		extensionContext.globalState.update("qqq_paste_stats", stats);

		// Trigger sidebar update (if a Webview is listening)
		if (typeof updateStatusBarNow === 'function') {
			updateStatusBarNow();
		}
	}
}

// Helper function to save video download stats
function saveVideoStats(sizeInBytes) {
	if (extensionContext) {
		const stats = extensionContext.globalState.get("qqq_video_stats", {
			count: 0,
			totalSize: 0,
			firstUse: Date.now()
		});

		stats.count += 1;
		stats.totalSize += (sizeInBytes || 0);

		if (!stats.firstUse) stats.firstUse = Date.now();

		extensionContext.globalState.update("qqq_video_stats", stats);

		if (typeof updateStatusBarNow === 'function') {
			updateStatusBarNow();
		}
	}
}

function getEngineTryOrder(pref) {
	// ★ Core truth: define fallback order under different preferences
	// The final "spawn" is an implicit last resort, usually handled by caller, listed here to clarify logic
	switch (pref) {
		case "python":
			return ["python", "rust", "shell", "spawn"];
		case "rust":
			return ["rust", "python", "shell", "spawn"];
		case "shell": // Corresponds to config "node"
			return ["shell", "spawn"];
		case "auto":
		default:
			return ["python", "rust", "shell", "spawn"];
	}
}

// ★★★ Engine scheduling optimization: cache effective engine order ★★★
let _cachedEffectiveOrder = null;
let _cachedPref = null;

function getEffectiveEngineOrder() {
	const pref = getEnginePreference();

	// Recompute if preference changes
	if (_cachedPref !== pref) {
		_cachedEffectiveOrder = null;
		_cachedPref = pref;
	}

	// ★ Cached (including empty array), return directly
	if (_cachedEffectiveOrder !== null) {
		return _cachedEffectiveOrder;
	}

	// Recompute: keep only available engines
	const fullOrder = getEngineTryOrder(pref);
	const bridges = { "python": pythonBridge, "rust": rustBridge, "shell": shellBridge };

	// ★ Get Python L1 imperfect status
	let pythonL1Imperfect = false;
	try {
		const { getSharedDownloader } = require("./dow");
		const downloader = getSharedDownloader();
		if (downloader && downloader.python) {
			const status = downloader.python.getL1ImperfectStatus();
			pythonL1Imperfect = status.imperfect;
		}
	} catch { }

	_cachedEffectiveOrder = fullOrder.filter(name => {
		if (name === "spawn") return false; // spawn is handled separately by caller

		// ★ If Python L1 is known imperfect, skip Python
		if (name === "python" && pythonL1Imperfect) {
			return false;
		}

		const bridge = bridges[name];
		return bridge && bridge.isAvailable();
	});

	return _cachedEffectiveOrder;
}

// ★ Clear cache when engine state changes
function invalidateEngineCache() {
	_cachedEffectiveOrder = null;
}


// ★ 生成引擎状态详情（用于 tooltip 显示每个引擎的对接状态和失败原因）
function getEngineStatusDetails(pythonBridge, rustBridge, shellBridge) {
	const details = [];

	// Rust 状态
	const rsAvailable = rustBridge?.isAvailable?.() === true || rustBridge?.available === true;
	const rsReason = cleanReason(rustBridge?.lastStartError || rustBridge?.lastCrashReason || rustBridge?.lastStderrSnippet);
	if (rsAvailable) {
		details.push(`✅ **R** (Rust)`);
	} else if (rsReason) {
		details.push(`❌ **R** (Rust): ${rsReason}`);
	} else if (rustBridge?.isStarting) {
		details.push(`⏳ **R** (Rust): starting...`);
	} else {
		details.push(`⬜ **R** (Rust): not started`);
	}

	// Python 状态
	const pyAvailable = pythonBridge?.isAvailable?.() === true;
	const pyReason = cleanReason(pythonBridge?.lastStartError || pythonBridge?.lastCrashReason || pythonBridge?.lastStderrSnippet);
	if (pyAvailable) {
		details.push(`✅ **P** (Python Broker)`);
	} else if (pyReason) {
		details.push(`❌ **P** (Python): ${pyReason}`);
	} else if (pythonBridge?.isStarting) {
		details.push(`⏳ **P** (Python): connecting...`);
	} else {
		details.push(`⬜ **P** (Python): not connected`);
	}

	// Node/Shell 状态
	const shAvailable = shellBridge?.isAvailable?.() === true || shellBridge?.available === true;
	const shReason = cleanReason(shellBridge?.lastStartError || shellBridge?.lastCrashReason || shellBridge?.lastStderrSnippet);
	if (shAvailable) {
		details.push(`✅ **N** (Shell daemon)`);
	} else if (shReason) {
		details.push(`❌ **N** (Shell): ${shReason}`);
	} else if (shellBridge?.isStarting) {
		details.push(`⏳ **N** (Shell): starting...`);
	} else {
		details.push(`⬜ **N** (Shell): not started`);
	}

	return details.join('<br>');
}

function getActiveEngineState(pythonBridge, rustBridge, shellBridge) {
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);

	const py = pythonBridge?.isAvailable?.() === true;
	const rs = rustBridge?.isAvailable?.() === true;
	const sh = shellBridge?.isAvailable?.() === true;

	for (const e of order) {
		if (e === "python" && py) return { code: "P", name: "Python" };
		if (e === "rust" && rs) return { code: "R", name: "Rust" };
		if (e === "shell" && sh) {
			return { code: "N", nodeMode: "D", name: "Node (Shell daemon)" };
		}
		if (e === "spawn") {
			return { code: "N", nodeMode: "S", name: "Node (Node spawn)" };
		}
	}
	// Fallback
	const mode = sh ? "D" : "S";
	return { code: "N", nodeMode: mode, name: mode === "D" ? "Node (Shell daemon)" : "Node (Node spawn)" };
}

async function tryOneByOne(callback) {
	// ★ Simplified: directly use cached effective engine order
	const effectiveOrder = getEffectiveEngineOrder();
	const bridges = { "python": pythonBridge, "rust": rustBridge, "shell": shellBridge };

	for (const name of effectiveOrder) {
		const bridge = bridges[name];
		try {
			const res = await callback(bridge, name);
			if (res) return res;
		} catch (e) {
			logMessage(`Engine ${name} execution error: ${e.message}`, "WARN");
		}
	}

	return null;
}

/**
 * Trigger system native paste (independent of user's IO engine preference)
 * Simple and direct: only use shell daemon
 */
async function triggerSystemPaste(targetDir) {
	if (!targetDir) {
		logMessage(q('q2paste.targetEmpty'), "ERROR");
		return { success: false, error: q('q2paste.targetEmptyError') };
	}

	const normalizedPath = process.platform === 'win32' ? targetDir.replace(/\//g, '\\') : targetDir;
	logMessage(q('q2paste.triggering', normalizedPath), "INFO");

	// ★ 优先使用 Rust daemon（更快，内存更小）
	if (rustBridge && rustBridge.isAvailable()) {
		try {
			const res = await rustBridge.call("trigger_system_paste", { path: normalizedPath }, 10000);
			if (res && !res.error) {
				logMessage(q('q2paste.shellResponse', JSON.stringify(res)) + " [Rust]", "INFO");
				return res;
			}
		} catch (e) {
			logMessage(`[triggerSystemPaste] Rust failed: ${e?.message || e}, falling back to Shell`, "DEBUG");
		}
	}

	// ★ Fallback: Shell daemon
	if (!shellBridge || !shellBridge.isAvailable()) {
		logMessage(q('q2paste.shellUnavailable'), "ERROR");
		return { success: false, error: q('q2paste.shellUnavailableError') };
	}

	try {
		const res = await shellBridge.call("trigger_system_paste", { path: normalizedPath }, 10000);
		logMessage(q('q2paste.shellResponse', JSON.stringify(res)), "INFO");
		return res;
	} catch (e) {
		logMessage(q('q2paste.shellError', e.message), "ERROR");
		return { success: false, error: e.message };
	}
}

let _integrityCache = null;
const LARGE_WATERMARK_HASH = "dd931dba64fd02a5fd683dd83692bc04311e4bc8ce5df5b44d64491fa1536cc7";
const SMALL_WATERMARK_HASH = "7e2d52d43e5383b8638026552dc4b01e84012643415916ffe745d047541c3c67";

/**
 * Async system integrity check (non-blocking startup)
 */
async function verifySystemIntegrityAsync(context, force = false) {
	if (!force && _integrityCache !== null) return _integrityCache;

	try {
		const extensionPath = context.extensionUri?.fsPath || context.extensionPath;
		const assetsDir = path.join(extensionPath, "assets");
		const largePath = path.join(assetsDir, "al.png");
		const smallPath = path.join(assetsDir, "as.png");

		const [largeBuf, smallBuf] = await Promise.all([
			fs.promises.readFile(largePath).catch(() => null),
			fs.promises.readFile(smallPath).catch(() => null)
		]);

		if (!largeBuf || !smallBuf) {
			_integrityCache = false;
			return false;
		}

		const largeHash = crypto.createHash("sha256").update(largeBuf).digest("hex");
		const smallHash = crypto.createHash("sha256").update(smallBuf).digest("hex");

		const isValid = (largeHash === LARGE_WATERMARK_HASH && smallHash === SMALL_WATERMARK_HASH);

		// ★ Fuse mechanism: if tampering is detected, proactively disable core engine
		if (isValid === false) {
			logMessage(q('integrity.fuseLocked'), "ERROR");
			killAllProcesses();
			_integrityCache = false;
			return false;
		}

		_integrityCache = true;
		return true;
	} catch (e) {
		logMessage(`Integrity Check Error: ${e.message}`, "ERROR");
		_integrityCache = false;
		return false;
	}
}

/**
 * Asset sentinel logic has been moved to q3.js as an independent module
 */
function startAssetsSentinel(context) {
	// Migrated
}

// ==================== Shared constants and extensions ====================
const IMAGE_EXTS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif",
	".svg", ".ai", ".eps", ".cdr", ".psd"
]);

const VIDEO_EXTS = new Set([
	".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv", ".rmvb",
	".mpeg", ".mpg", ".3gp", ".m4v", ".f4v", ".ts", ".mts", ".m2ts", ".vob"
]);

const AUDIO_EXTS = new Set([
	".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma"
]);

const DOCUMENT_EXTS = new Set([
	".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".rtf", ".md"
]);

const ARCHIVE_EXTS = new Set([
	".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"
]);

const EXECUTABLE_EXTS = new Set([
	".exe", ".dll", ".bin", ".dat", ".iso", ".msi", ".bat", ".cmd", ".ps1"
]);

// Includes all file types that preview does not support or should not be read as text (used by q2)
const NON_TEXT_EXTS = new Set([
	...EXECUTABLE_EXTS,
	...ARCHIVE_EXTS,
	...IMAGE_EXTS,
	...VIDEO_EXTS,
	...AUDIO_EXTS,
	".pdf"
]);

async function tryEngineCall(actionOrMap, params = {}, timeout = 5000) {
	return tryOneByOne(async (bridge, name) => {
		const action = typeof actionOrMap === "object" ? actionOrMap[name] : actionOrMap;
		if (!action) return null;

		// ★ Key fix: support function-style Action mapping, for direct Node-side logic injection
		if (typeof action === "function") {
			try {
				const res = await action(params);
				if (res && (res.success || !res.error)) return res;
				return null;
			} catch (e) {
				logMessage(q('bridge.actionFailed', name, e.message), "WARN");
				return null;
			}
		}

		const res = await bridge.call(action, params, timeout);
		// ★ Fault-tolerance: success if success flag exists, or no error and not unknown
		if (res && (res.success === true || (res.success !== false && !res.error && res.type !== "unknown"))) return res;
		return null;
	});
}

/**
 * Send cancel_scans command to all active daemons
 * Used to cancel long-running scan operations (path_size, folder_info)
 */
async function cancelScans() {
	const bridges = [pythonBridge, rustBridge];
	const promises = bridges.map(async (bridge) => {
		if (!bridge || !bridge.isAlive()) return null;
		try {
			// Fast call, do not wait for response (fire and forget)
			bridge.call("cancel_scans", {}, 500).catch(() => { });
		} catch { }
	});
	await Promise.allSettled(promises);
}

function getActiveEngineCode(pythonBridge, rustBridge, shellBridge) {
	return getActiveEngineState(pythonBridge, rustBridge, shellBridge).code;
}

function getActiveEngineName(pythonBridge, rustBridge, shellBridge) {
	return getActiveEngineState(pythonBridge, rustBridge, shellBridge).name;
}

// ★ Core update logic: receive external data (cache snapshot, Bridge objects), render status bar
function updateStatusBar(cacheStatsSnapshot, pythonBridge, rustBridge, shellBridge) {
	if (!statusBarItem) return;

	const totalSeconds = getTotalSecondsIncludingSession();
	const { h } = formatCompactTime(totalSeconds); // m 不再使用

	const cacheBytes = cacheStatsSnapshot.totalSize;
	const cacheMB = cacheBytes / 1048576;

	const pstats = getPersistentCacheStatsSnapshot();
	const denom = pstats.hitTotal + pstats.missTotal;
	const hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;

	// Get wq windup time stats
	let wqStats = { totalTime: 0, count: 0, recentTimes: [], maxTime: 0 };
	if (extensionContext) {
		wqStats = extensionContext.globalState.get("qqq_wq_stats", wqStats);
	}
	const averageTime = wqStats.count > 0 ? Math.round(wqStats.totalTime / wqStats.count) : 0;

	// ★ v16 逻辑：按检测顺序显示引擎标签（R/P/N），不再区分 nd/ns
	const engineTag = getEngineTagByOrder();

	// ★ 分隔符逻辑：Rust 和 Python 双持双在线用 ▌，否则用 ▪（与 Node 无关）
	const rs = rustBridge?.isAvailable?.() === true || rustBridge?.available === true;
	const py = pythonBridge?.isAvailable?.() === true;
	const dualOnline = rs && py;

	if (dualOnline) {
		statusBarItem.text = ` ▌ qqq${h}h     ${cacheMB.toFixed(0)}m     ${hitRate.toFixed(0)}%    ${engineTag}   ▌`;
	} else {
		statusBarItem.text = ` ▪  qqq${h}h     ${cacheMB.toFixed(0)}m     ${hitRate.toFixed(0)}%    ${engineTag} ▪ `;
	}

	// Format wq time display
	const recentTimesStr = wqStats.recentTimes.join(', ');
	const wqLine = `💪 **${q('global.tooltipAvgLatency')}：** ${averageTime} ms${wqStats.count > 0 ? `（ ${recentTimesStr}${wqStats.maxTime > 0 ? `...[${q('global.tooltipMax', wqStats.maxTime)}]` : ''}）` : ''}`;

	// ★ 引擎状态详情（显示每个引擎的对接状态和失败原因）
	const engineStatusDetails = getEngineStatusDetails(pythonBridge, rustBridge, shellBridge);

	const tooltip = new vscode.MarkdownString(
		`⏱️ **${q('global.tooltipCompanionTime')}：** ${formatHours(totalSeconds)}

💾 **${q('global.tooltipDiskCache')}：** ${formatBytes(cacheBytes)}

🎯 **${q('global.tooltipCacheHit')}：** ${hitRate.toFixed(2)}% (hit = ${pstats.hitTotal}, miss = ${pstats.missTotal})

${wqLine}

🔌 **Engine Status:**<br>${engineStatusDetails}`
	);

	tooltip.isTrusted = true;
	tooltip.supportHtml = true;

	statusBarItem.tooltip = tooltip;
	statusBarItem.show();
}

class TaskScheduler {
	constructor(maxConcurrency = 8) {
		this.maxConcurrency = Math.max(1, maxConcurrency | 0);
		this.runningCount = 0;
		this.queue = [];
		this.pendingPromises = new Map();
	}

	async schedule(taskKey, taskGenerator) {
		if (this.pendingPromises.has(taskKey)) return this.pendingPromises.get(taskKey);

		const p = new Promise((resolve, reject) => {
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
		});

		this.pendingPromises.set(taskKey, p);
		this._next();
		return p;
	}

	_next() {
		while (this.runningCount < this.maxConcurrency && this.queue.length > 0) {
			const task = this.queue.shift();
			task();
		}
	}
}

class TaskQueue {
	constructor() {
		this.queue = [];
		this.running = false;
	}

	enqueue(task) {
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
			this.processNext();
		});
	}

	async processNext() {
		if (this.running || this.queue.length === 0) return;
		this.running = true;
		const { task, resolve, reject } = this.queue.shift();
		try {
			const result = await task();
			resolve(result);
		} catch (e) {
			reject(e);
		} finally {
			this.running = false;
			this.processNext();
		}
	}
}

const probeScheduler = new TaskScheduler(12);
const genScheduler = new TaskScheduler(6);
const iconScheduler = new TaskScheduler(4); // Scheduler for icon fetching
const pasteQueue = new TaskQueue();
const metaSaveQueue = new TaskQueue();

async function getIcon(filePath) {
	const qqq = require("./qqq");
	const cached = qqq.getIconCache(filePath);
	if (cached) return cached;

	const res = await tryEngineCall({
		shell: "extract_icon",
		python: "extract_icon",
		rust: "extract_icon"
	}, { path: filePath });

	if (res && res.status === "ok" && res.icon) {
		qqq.setIconCache(filePath, res.icon);
		return res.icon; // base64 string
	}
	return null;
}

// ============================================================================
// ★ URL validation (single source of truth, shared by Node.js and Webview)
// ============================================================================
function isValidUrl(input) {
	if (input === null || input === undefined) return false;

	// ES3/ES5 compatible trim
	var s = ('' + input).replace(/^\s+|\s+$/g, '');
	if (!s) return false;

	// Any whitespace is invalid (prevent "http://a b.com")
	if (/\s/.test(s)) return false;

	// Reject backslashes to avoid mistaking Windows paths as URLs
	if (/\\/.test(s)) return false;

	// Reject scheme-relative: //example.com
	if (s.indexOf('//') === 0) return false;

	// Parse scheme (if present, must be http/https)
	var rest = s;
	var m = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
	if (m) {
		var scheme = m[1].toLowerCase();
		if (scheme !== 'http' && scheme !== 'https') return false;
		rest = rest.slice(m[0].length);
	}

	// authority until first / ? #
	var cut = rest.search(/[\/?#]/);
	var authority = (cut === -1) ? rest : rest.slice(0, cut);
	if (!authority) return false;

	// Do not support userinfo (safer): user:pass@host
	if (authority.indexOf('@') !== -1) return false;

	// Split host / port
	var host = '';
	var portStr = '';

	if (authority.charAt(0) === '[') {
		// [IPv6]:port
		var end = authority.indexOf(']');
		if (end === -1) return false;
		host = authority.slice(0, end + 1);
		var after = authority.slice(end + 1);
		if (after) {
			if (after.charAt(0) !== ':') return false;
			portStr = after.slice(1);
			if (!portStr) return false;
		}
	} else {
		// host:port (split by last colon)
		var lastColon = authority.lastIndexOf(':');
		if (lastColon !== -1 && authority.indexOf(':') === lastColon) {
			var possiblePort = authority.slice(lastColon + 1);
			if (/^\d+$/.test(possiblePort)) {
				host = authority.slice(0, lastColon);
				portStr = possiblePort;
			} else {
				host = authority;
			}
		} else {
			host = authority;
		}
	}

	if (!host) return false;

	// Port 1..65535
	if (portStr) {
		if (!/^\d{1,5}$/.test(portStr)) return false;
		var port = parseInt(portStr, 10);
		if (!(port >= 1 && port <= 65535)) return false;
	}

	// Host validation: localhost / IPv4 / [IPv6] / domain (including punycode)
	if (isLocal(host) || isIPv4(host) || isBracketIPv6(host) || isDomain(host)) return true;
	return false;

	function isLocal(h) {
		if (/^(localhost|127\.0\.0\.1)$/i.test(h)) return true;
		return h.toLowerCase() === '[::1]';
	}

	function isBracketIPv6(h) {
		// Practical IPv6 validation (not full RFC, but robust enough)
		if (h.length < 4) return false;
		if (h.charAt(0) !== '[' || h.charAt(h.length - 1) !== ']') return false;
		var inner = h.slice(1, -1);
		if (inner.indexOf(':') === -1) return false;
		if (!/^[0-9a-fA-F:.]+$/.test(inner)) return false;
		return true;
	}

	function isIPv4(h) {
		var mm = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
		if (!mm) return false;
		for (var i = 1; i <= 4; i++) {
			var n = parseInt(mm[i], 10);
			if (!(n >= 0 && n <= 255)) return false;
		}
		return true;
	}

	function isDomain(h) {
		// Allow trailing dot: example.com.
		if (h.charAt(h.length - 1) === '.') h = h.slice(0, -1);
		if (!h) return false;
		if (h.length > 253) return false;

		// Must contain at least one dot (avoid treating "abc" as a domain; localhost handled by isLocal)
		if (h.indexOf('.') === -1) return false;

		var labels = h.split('.');
		if (labels.length < 2) return false;

		for (var i = 0; i < labels.length; i++) {
			var lab = labels[i];
			if (!lab || lab.length > 63) return false;
			// Each label: alnum start/end, hyphen allowed in middle
			if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(lab)) return false;
		}

		// TLD: letters 2-63 or punycode xn--
		var tld = labels[labels.length - 1];
		if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(tld)) return false;

		return true;
	}
}

// ============================================================================
// ★ 公用解压模块：四级回退策略 (Win7 兼容)
// 1. VBScript Shell.Application (Win7 最稳定，不依赖 PowerShell)
// 2. .NET ZipFile (PowerShell + .NET 4.5+)
// 3. tar (Win10+)
// 4. PowerShell Shell.Application COM
// ============================================================================
function extractZip(zipPath, destFolder) {
	return new Promise((resolve, reject) => {
		const platform = process.platform;

		if (platform === 'win32') {
			const zipPathWin = zipPath.replace(/\//g, '\\');
			const destFolderWin = destFolder.replace(/\//g, '\\');

			// Ensure dest folder exists
			if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });

			// ★ Win7 最稳定方案：VBScript 直接调用 Shell.Application
			const vbsPath = path.join(os.tmpdir(), `extract_${Date.now()}.vbs`);
			const vbsScript = `
Set objShell = CreateObject("Shell.Application")
Set zipFile = objShell.NameSpace("${zipPathWin}")
Set destDir = objShell.NameSpace("${destFolderWin}")
If zipFile Is Nothing Then
    WScript.Echo "Cannot open zip"
    WScript.Quit 1
End If
If destDir Is Nothing Then
    WScript.Echo "Cannot open dest"
    WScript.Quit 2
End If
destDir.CopyHere zipFile.Items, 1044
WScript.Quit 0
`;

			const tryVBS = () => {
				fs.writeFileSync(vbsPath, vbsScript, 'utf8');
				cp.exec(`cscript //nologo "${vbsPath}"`, { windowsHide: true, timeout: 300000 }, (e1) => {
					try { fs.unlinkSync(vbsPath); } catch (x) { }
					if (!e1) return resolve();
					tryDotNet(e1);
				});
			};

			const tryDotNet = (prevErr) => {
				const dotnetScript = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPathWin}', '${destFolderWin}')`;
				cp.exec(`powershell -NoProfile -Command "${dotnetScript.replace(/"/g, '\\"')}"`,
					{ windowsHide: true, timeout: 300000 }, (e2) => {
						if (!e2) return resolve();
						tryTar(prevErr, e2);
					});
			};

			const tryTar = (e1, e2) => {
				cp.exec(`tar -xf "${zipPath}" -C "${destFolder}"`, { windowsHide: true, timeout: 300000 }, (e3) => {
					if (!e3) return resolve();
					reject(new Error(`Extract failed: VBS=${e1?.message}, .NET=${e2?.message}, tar=${e3.message}`));
				});
			};

			tryVBS();
		} else {
			cp.exec(`unzip -o "${zipPath}" -d "${destFolder}"`, { timeout: 300000 }, (err) => {
				if (err) reject(err);
				else resolve();
			});
		}
	});
}

async function getQqqStats() {
    try {
        const data = await new Promise((resolve, reject) => {
            const url = new URL(`${WQ_API_BASE}/goods/qqq/stats`);
            const options = {
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: 'GET',
                timeout: 5000
            };

            const req = require('https').request(options, (res) => {
                let chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString()));
                    } catch (e) {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });

            req.end();
        });

        if (data && typeof data.active_12h === 'number') {
            return data.active_12h;
        }
        return null;
    } catch (e) {
        return null;
    }
}

module.exports = {
    getQqqStats,
	init,
	getIcon,

	// Schedulers and queues
	TaskScheduler,
	TaskQueue,
	probeScheduler,
	genScheduler,
	iconScheduler,
	pasteQueue,
	metaSaveQueue,

	// Logs
	setLogPath,
	getLogPath,
	setLogLevel,
	getLogLevel,
	logMessage,
	logMessageRateLimited,
	bridgeStderrKey,

	// Dialogs
	showInformationMessage,
	showAutoCloseNotification,
	showErrorMessage,
	showWarningMessage,
	showInputBox,
	showQuickPick,
	showSaveDialog,
	withProgress,
	showTextDocument,
	openExternal,
	setStatusBarMessage,

	// ★ Unified task message module
	TaskMessage,

	// Stats
	markCacheHit,
	markCacheMiss,
	getPersistentCacheStatsSnapshot,
	setCacheStatsGetter,
	finishUserTracking,

	// ★ WqReporter
	startWqReporter,
	getDeviceId,
	getUserPhone,
	onPhoneConfigChanged,
	verifyPhoneAndSyncConfig,
	syncCloudConfig,

	// Status bar related
	initStatusBar,
	disposeStatusBar,
	updateStatusBar,

	cleanReason,

	// Engine helpers (for external use)
	DaemonBridge,
	ConfigManager,
	getConfig,
	setConfig,
	setVipMode,
	isVip,

	pythonBridge,
	rustBridge,
	shellBridge,
	startDaemons,
	updateStatusBarNow,
	getEnginePreference,
	getEngineTryOrder,
	tryOneByOne,
	tryEngineCall,
	cancelScans,
	triggerSystemPaste,
	getActiveEngineCode,
	getActiveEngineName,
	invalidateEngineCache,  // ★ Refresh engine cache
	extensionPath: () => extensionContext?.extensionPath,
	ffmpegPath: () => ffmpegPath,
	ffprobePath: () => ffprobePath,
	ensureFFmpegReady,

	// Formatting helpers (for CodeLens etc.)
	formatBytes,
	formatHours,
	formatTimeCompact,    // ★ Unified time formatter (mm:ss or h:mm:ss)
	formatBytesCompact,   // ★ Unified compact byte formatter ("222m", "1.2g")

	// Path helper functions
	canonicalizeExistingPath,
	cacheKeyForPath,

	// ★ Core logic exports
	savePasteStats,
	saveVideoStats,
	wq,
	TransactionManager,
	TaskCounter,
	getDirectorySnapshot,  // ★ Directory snapshot function
	extractZip,            // ★ 公用解压模块 (Win7 兼容三级回退)

	// ★ Ultimate optimal solution: process and state management APIs
	trackProcess,
	killAllProcesses,
	isValid: () => _integrityCache !== false,
	verifySystemIntegrityAsync,
	markReady: () => {
		if (_resolveReady) {
			_resolveReady();
			_resolveReady = null; // Release reference
		}
	},
	withReady,
	setDeactivated: (v) => { _isDeactivated = !!v; },
	isDeactivated: () => _isDeactivated,

	// Constants
	IMAGE_EXTS,
	VIDEO_EXTS,
	AUDIO_EXTS,
	DOCUMENT_EXTS,
	ARCHIVE_EXTS,
	NON_TEXT_EXTS,

	// URL validation (single source of truth)
	isValidUrl
};



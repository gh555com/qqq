// src/global.js - 全局状态、日志和对话框管理
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const readline = require("readline");

const NO_TRACK_ENV = { ...process.env, QQQ_NO_TRACK: "1" };

// ============================================================================
// ★ Daemon Bridge (从 qqq.js 迁移)
// ============================================================================
class DaemonBridge {
	constructor(name, startFn) {
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

		// ★ 失败原因收集（用于 tooltip + err.log）
		this.lastStartError = "";
		this.lastCrashReason = "";
		this.lastStderrSnippet = "";

		// ★ DoS 防护：1分钟内崩溃超过5次则永久禁用
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
		logMessage(`${this.name} start 方法被调用`, "DEBUG");

		this._stopping = false;

		// ★ 关键修复：添加 startLock 防止重入
		// 即使 this.isStarting 为 false，只要上一个 startPromise 还没完全 resolve/reject，也不应该重新开始
		// 这里我们简化为：如果 isStarting，直接返回正在进行滴 promise
		if (this.isStarting) {
			logMessage(`${this.name} 正在启动中 (isStarting=true)，返回现有 Promise`, "DEBUG");
			return this.startPromise;
		}

		// 检查现有进程状态
		if (this.process && !this.process.killed) {
			logMessage(`${this.name} 进程已存在且健康，无需启动`, "DEBUG");
			return true;
		}

		this.isStarting = true;

		// 每次启动生成唯一滴 session ID，用于区分不同滴启动尝试
		const currentSession = Date.now();
		this._currentStartSession = currentSession;

		logMessage(`${this.name} 开始新一轮启动流程 (session=${currentSession})`, "DEBUG");

		this.startPromise = (async () => {
			try {
				// 再次检查（因为异步间隙可能发生变化）
				if (this.process && !this.process.killed) return true;

				const result = await this.startFn(this);

				// 再次检查 session，如果启动过程中被新滴启动请求覆盖了，则当前结果无效
				if (this._currentStartSession !== currentSession) {
					logMessage(`${this.name} 启动结果被丢弃 (session mismatch: ${currentSession} vs ${this._currentStartSession})`, "WARN");
					// 注意：这里不能 stop，因为新滴 session 可能正在使用进程
					return false;
				}

				return result;
			} finally {
				// 只有当自己是当前 session 滴 owner 时，才重置 isStarting
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

		logMessage(`${this.name} setupProcess called`, "DEBUG");

		const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => {
			try {
				if (!line || !line.trim()) return;

				let result;
				try {
					result = JSON.parse(line);
				} catch (e) {
					// 尝试 Base64 解码 (PowerShell 模式下输出是 Base64 封装滴)
					try {
						const decoded = Buffer.from(line, "base64").toString("utf8");
						result = JSON.parse(decoded);
					} catch (e2) {
						throw e;
					}
				}

				const id = result._id;

				if (result.error) logMessage(`${this.name} 错误响应: ${result.error}`, "WARN");

				if (this.pending.has(id)) {
					const { resolve: res, timer } = this.pending.get(id);
					clearTimeout(timer);
					this.pending.delete(id);
					res(result);
				}
			} catch (e) {
				// 非JSON输出，可能是Python脚本滴调试输出或错误信息
				logMessage(`${this.name} stdout: ${line}`, "WARN");
			}
		});

		proc.stderr.on("data", (d) => {
			const text = d?.toString?.() || "";
			this._appendStderrSnippet(text);
			const key = bridgeStderrKey(this.name, text);
			logMessageRateLimited(key, `${this.name} stderr: ${text}`, "WARN", 5 * 60 * 1000);
		});

		proc.on("error", (err) => {
			if (this.process !== proc) return;
			logMessage(`${this.name} 进程错误: ${err.message}`, "ERROR");
			this.lastCrashReason = cleanReason(err.message);
			this._handleCrash();
		});
		proc.on("close", (code) => {
			if (this.process !== proc) return;
			logMessage(`${this.name} 进程关闭，退出码: ${code}`, "INFO");
			this.lastCrashReason = cleanReason(`exit_code=${code}`);
			this._handleCrash();
		});

		// 实现ping重试逻辑，最多重试 15 次，总计约 7.5 秒
		let pingAttempts = 0;
		const maxPingAttempts = 15;
		const pingInterval = 500; // 每次ping间隔500ms
		const pingTimeout = 5000; // 增加ping超时时间到5秒

		const attemptPing = async () => {
			pingAttempts++;
			try {
				logMessage(`${this.name} 发送 ping 请求 (尝试 ${pingAttempts}/${maxPingAttempts})`, "DEBUG");
				// ★ 增加 Ping 超时时间，防止 PowerShell 启动慢导致误判
				const pong = await this.call("ping", {}, 3000);
				logMessage(`${this.name} ping 响应: ${JSON.stringify(pong)}`, "DEBUG");
				if (pong?.status === "alive") {
					this.restartCount = 0;
					this.available = true;
					this._setStartError("");
					logMessage(`${this.name} started`, "INFO");
					resolve(true);
					// 注意：这里我们无法直接调用 qqq.js 滴 updateStatusBarNow，
					// 但 updateStatusBarNow 本质是调用 global.updateStatusBar，
					// 我们需要从外部传入 bridge 实例，或者让 global 自己持有 bridge 实例。
					// 暂时让 qqq.js 负责轮询状态栏更新，或者通过回调机制。
					return true;
				}
			} catch (e) {
				logMessage(`${this.name} ping 超时 (尝试 ${pingAttempts}/${maxPingAttempts}): ${e.message}`, "DEBUG");
			}

			// 如果还有重试机会，继续尝试
			if (pingAttempts < maxPingAttempts) {
				// ★ 每次重试时稍微等一下，给进程喘息机会，避免死循环刷屏
				setTimeout(attemptPing, 200);
				return;
			}

			// 所有ping尝试都失败
			const reason = `ping_failed_after_${maxPingAttempts}_attempts${this.lastStderrSnippet ? ` ; stderr=${this.lastStderrSnippet}` : ""}`;
			this._setStartError(reason);
			logMessage(`${this.name} ping 失败，已尝试 ${maxPingAttempts} 次`, "WARN");
			this.available = false;
			resolve(false);
		};

		// 启动ping尝试，将初始延迟恢复为 5ms，解决 500ms 延迟问题
		setTimeout(attemptPing, 5);
	}

	_handleCrash() {
		logMessage(`${this.name} _handleCrash 方法被调用`, "DEBUG");
		this.process = null;

		for (const [id, { resolve, timer }] of this.pending) {
			logMessage(`${this.name} 清理待处理请求，id: ${id}`, "DEBUG");
			clearTimeout(timer);
			resolve({ error: "process_crashed" });
		}
		this.pending.clear();

		if (this._stopping) {
			logMessage(`${this.name} stopping=true，忽略自动重启`, "INFO");
			this.available = false;
			return;
		}

		if (this.isPermDisabled) {
			logMessage(`${this.name} 已被永久禁用，忽略重启`, "WARN");
			this.available = false;
			return;
		}

		// ★ DoS 检查
		const now = Date.now();
		this.recentCrashes.push(now);
		this.recentCrashes = this.recentCrashes.filter(t => now - t < 60000); // 只保留最近1分钟

		if (this.recentCrashes.length > 5) {
			this.isPermDisabled = true;
			this.available = false;
			const msg = `${this.name} 1分钟内崩溃超过5次，已触发熔断保护，永久禁用该 Bridge。`;
			this._setStartError(msg);
			logMessage(msg, "ERROR");

			// ★ Shell Daemon 致命错误弹窗
			if (this.name === "Shell") {
				showErrorMessage(
					"node shell deamo 陷入异常，qqq 将停止工作。 解决方案：重启。",
					{
						modal: true,
						detail: "检测到后台守护进程频繁崩溃，可能是被杀毒软件拦截或环境异常。为保护系统稳定性，核心功能已暂停。"
					},
					"立即重启窗口"
				).then(selection => {
					if (selection === "立即重启窗口") {
						vscode.commands.executeCommand("workbench.action.reloadWindow");
					}
				});
			}

			return;
		}

		if (this.restartCount < this.maxRestarts) {
			this.restartCount++;
			// 指数退避策略：从 50ms 开始，快速重试
			const backoff = 50 * Math.pow(2, this.restartCount - 1);
			logMessage(`${this.name} 进程崩溃，尝试重启 (${this.restartCount}/${this.maxRestarts})，延迟 ${backoff}ms`, "WARN");
			setTimeout(() => this.start(), backoff);
		} else {
			logMessage(`${this.name} 进程崩溃，达到最大重启次数，标记为不可用`, "ERROR");
			this.available = false;

			// ★ Shell Daemon 特权：无限复活
			if (this.name === "Shell") {
				logMessage(`${this.name} 达到最大重启次数，但作为常驻服务将在 3秒 后强制复活`, "WARN");
				this.restartCount = 0; // 重置计数以允许再次进入重启循环
				setTimeout(() => this.start(), 3000);
			}
		}
	}

	async call(action, params = {}, timeout = 5000) {
		logMessage(`${this.name} call 方法被调用，action: ${action}`, "DEBUG");

		if (this.isPermDisabled) {
			return { error: `${this.name}_disabled_too_many_crashes` };
		}

		// 允许再尝试启动/重启（尤其是 cold start/ping race）
		if (this.available === false) {
			// 如果进程还活着，给一次机会重新 ping/start
			this.available = null;
		}

		if (!this.process || this.process.killed) {
			logMessage(`${this.name} 进程不存在或已被杀死，尝试启动`, "DEBUG");
			const started = await this.start();
			if (!started) {
				logMessage(`${this.name} 启动失败，返回错误`, "DEBUG");
				return { error: `${this.name}_not_available` };
			}
		}

		const id = ++this.requestId;
		const cmd = JSON.stringify({ _id: id, action, ...params }) + "\n";

		logMessage(`${this.name} 发送命令: ${cmd}`, "DEBUG");

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				logMessage(`${this.name} 命令超时，id: ${id}`, "DEBUG");
				if (this.pending.has(id)) {
					this.pending.delete(id);
					resolve({ error: "timeout" });
				}
			}, timeout);

			this.pending.set(id, { resolve, timer });

			try {
				this.process.stdin.write(cmd);
				logMessage(`${this.name} 命令写入成功，id: ${id}`, "DEBUG");
			} catch (e) {
				logMessage(`${this.name} 命令写入失败: ${e.message}, id: ${id}`, "ERROR");
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ error: "write_error" });
			}
		});
	}

	isAvailable() {
		return this.available === true;
	}

	async stop() {
		logMessage(`${this.name} stop 方法被调用`, "DEBUG");

		this._stopping = true;

		for (const [id, { resolve, timer }] of this.pending) {
			clearTimeout(timer);
			resolve({ error: "stopped" });
		}
		this.pending.clear();

		if (!this.process) {
			this.available = false;
			this.restartCount = 0;
			return;
		}

		if (!this.process.killed) {
			logMessage(`${this.name} 尝试优雅退出...`, "DEBUG");

			// ★ 阶段 1：协商退出 (Graceful Exit Protocol)
			// 发送 exit 指令，让子进程自己清理资源（释放锁、关闭句柄）
			let exitedCleanly = false;
			try {
				// 给它发个信，别回了，直接走吧
				const exitCmd = JSON.stringify({ _id: 0, action: "exit" }) + "\n";
				if (this.process.stdin && !this.process.stdin.destroyed) {
					this.process.stdin.write(exitCmd);
				}

				// 等待进程退出，最长 1000ms
				const exitPromise = new Promise(resolve => {
					this.process.once('exit', () => resolve(true));
					this.process.once('close', () => resolve(true));
				});

				const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(false), 1000));

				exitedCleanly = await Promise.race([exitPromise, timeoutPromise]);
			} catch (e) {
				logMessage(`${this.name} 发送 exit 指令失败: ${e.message}`, "WARN");
			}

			if (exitedCleanly) {
				logMessage(`${this.name} 已优雅退出`, "DEBUG");
			} else {
				// ★ 阶段 2：强制退出 (Force Kill)
				logMessage(`${this.name} 协商退出超时，执行强制终止`, "WARN");
				try {
					if (process.platform === "win32") {
						// ★ Windows 专用：使用 taskkill 杀进程树，防止孤儿进程
						try {
							cp.execSync(`taskkill /pid ${this.process.pid} /T /F`);
							logMessage(`${this.name} Windows taskkill 成功`, "DEBUG");
						} catch (e) {
							// 忽略进程不存在滴错误
						}
					} else {
						// Unix: SIGKILL
						this.process.kill("SIGKILL");
					}
				} catch (e) {
					logMessage(`${this.name} 进程终止失败: ${e.message}`, "ERROR");
				}
			}
		} else {
			logMessage(`${this.name} 进程已被杀死`, "DEBUG");
		}

		this.process = null;
		this.available = false;
		this.restartCount = 0;
	}
}

// ============================================================================
// ★ Bridge Instances & Management
// ============================================================================

// Python bridge：优先 python，其次 python3（非 win32）
const pythonBridge = new DaemonBridge("Python", (bridge) => {
	return new Promise((resolve) => {
		const scriptPath = path.join(__dirname, "kp.py");
		if (!fs.existsSync(scriptPath)) {
			bridge._setStartError(`kp.py 不存在：${scriptPath}`);
			bridge.available = false;
			resolve(false);
			return;
		}

		const spawnWith = (bin) => {
			return new Promise((res) => {
				let proc;
				try {
					proc = cp.spawn(bin, [scriptPath, "--daemon"], {
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
						env: NO_TRACK_ENV
					});
				} catch (e) {
					const msg = `spawn_fail(${bin}): ${e.message}`;
					bridge._setStartError(msg);
					logMessage(`Python bridge 启动失败 (${bin}): ${e.message}`, "WARN");
					res(false);
					return;
				}

				let settled = false;
				const failFast = () => {
					if (settled) return;
					settled = true;
					try { proc.kill(); } catch { }
					bridge.available = false;
					res(false);
				};

				proc.once("error", (err) => {
					const msg = `process_error(${bin}): ${err.message}`;
					bridge._setStartError(msg);
					logMessage(`Python bridge 进程错误 (${bin}): ${err.message}`, "WARN");
					failFast();
				});

				bridge.setupProcess(proc, (ok) => {
					if (settled) return;
					settled = true;
					if (!ok && bridge.lastStartError) {
						logMessage(`Python Bridge 启动失败原因：${bridge.lastStartError}`, "WARN");
					}
					res(!!ok);
				});
			});
		};

		(async () => {
			const ok1 = await spawnWith("python");
			if (ok1) {
				logMessage("Python Bridge 使用 python 启动成功", "INFO");
				resolve(true);
				return;
			}

			if (process.platform !== "win32") {
				const ok2 = await spawnWith("python3");
				if (ok2) {
					logMessage("Python Bridge 使用 python3 启动成功", "INFO");
					resolve(true);
					return;
				}
			}

			logMessage(`Python Bridge 启动失败，所有尝试均已失败：${bridge.lastStartError || "unknown"}`, "WARN");
			resolve(false);
		})().catch((e) => {
			bridge._setStartError(`start_exception: ${e.message}`);
			logMessage(`Python Bridge 启动异常: ${e.message}`, "ERROR");
			resolve(false);
		});
	});
});

// Rust bridge
const rustBridge = new DaemonBridge("Rust", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		const arch = process.arch;

		let filename;
		if (platform === "win32") filename = arch === "arm64" ? "q_win_arm64.exe" : "q_win_x64.exe";
		else if (platform === "darwin") filename = arch === "arm64" ? "q_mac_arm64" : "q_mac_x64";
		else filename = arch === "arm64" ? "q_linux_arm64" : "q_linux_x64";

		const candidates = [
			path.join(__dirname, "..", "assets", filename),
			path.join(__dirname, "assets", filename),
			path.join(__dirname, filename),
		];

		let exePath = null;
		for (const c of candidates) {
			if (fs.existsSync(c)) { exePath = c; break; }
		}

		if (!exePath) {
			bridge._setStartError(`exe_not_found: ${filename}`);
			logMessage("Rust Bridge 可执行文件未找到", "WARN");
			bridge.available = false;
			resolve(false);
			return;
		}

		try {
			logMessage(`Rust Bridge 尝试启动: ${exePath}`, "INFO");
			const proc = cp.spawn(exePath, ["--daemon"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			proc.once("error", (err) => {
				bridge._setStartError(`process_error: ${err.message}`);
				logMessage(`Rust Bridge 进程错误: ${err.message}`, "WARN");
				bridge.available = false;
				resolve(false);
			});

			bridge.setupProcess(proc, (ok) => {
				if (ok) {
					logMessage("Rust Bridge 启动成功", "INFO");
					resolve(true);
				} else {
					logMessage(`Rust Bridge 启动失败原因：${bridge.lastStartError || "unknown"}`, "WARN");
					resolve(false);
				}
			});
		} catch (e) {
			bridge._setStartError(`start_exception: ${e.message}`);
			logMessage(`Rust Bridge 启动异常: ${e.message}`, "ERROR");
			bridge.available = false;
			resolve(false);
		}
	});
});

// Shell bridge
const shellBridge = new DaemonBridge("Shell", (bridge) => {
	return new Promise((resolve) => {
		const platform = process.platform;
		let proc = null;

		if (platform === "win32") {
			let clipboardHelperCode = "";
			try { clipboardHelperCode = require("./h").CLIPBOARD_HELPER_CS; } catch (e) { }

			const simplePsScript = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Inject C# ClipboardHelper (Optimized for Daemon) ---
try {
    $clipboardHelperCode = @'
${clipboardHelperCode}
'@
    Add-Type -TypeDefinition $clipboardHelperCode -Language CSharp
} catch {
    # Ignore if type already exists
}

function Process-Command {
  param($cmd)
  $result = @{ _id = $cmd._id }
  try {
    switch ($cmd.action) {
      'ping' { $result.status = 'alive' }
      'dumpHtmlToFile' {
         try {
             $res = [ClipboardHelper]::DumpHtmlToFile($cmd.path)
             if ($res -eq "Success") { $result.success = $true }
             else { $result.success = $false; $result.error = $res }
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
      'saveImage' {
        try {
            $res = [ClipboardHelper]::SaveClipboardImage($cmd.path)
            if ($res -ne $null -and $res.StartsWith("{")) {
                $p = $res | ConvertFrom-Json
                if ($p.error) { $result.success = $false; $result.error = $p.error }
                else { $result.success = $true }
            } else {
                # Fallback to pure PS
                $img = [System.Windows.Forms.Clipboard]::GetImage()
                if ($img) { $img.Save($cmd.path, [System.Drawing.Imaging.ImageFormat]::Png); $result.success = $true }
                else { $result.success = $false }
            }
        } catch {
             $img = [System.Windows.Forms.Clipboard]::GetImage()
             if ($img) { $img.Save($cmd.path, [System.Drawing.Imaging.ImageFormat]::Png); $result.success = $true }
             else { $result.success = $false }
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

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $cmd = ConvertFrom-Json $line
    Process-Command $cmd
  } catch {
    $err = @{ _id = 0; error = $_.Exception.Message } | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($err)
    $b64 = [Convert]::ToBase64String($bytes)
    [Console]::Out.WriteLine($b64)
  }
}
`.trim();

			logMessage("尝试启动 PowerShell 进程", "DEBUG");
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
						logMessage(`尝试使用选项 ${index + 1} 启动 PowerShell: ${options[0]}`, "DEBUG");
						proc = cp.spawn(options[0], options.slice(1), {
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
						});
						logMessage(`PowerShell 进程已创建: ${options[0]}`, "DEBUG");
						break;
					} catch (e) {
						lastError = e;
						logMessage(`使用选项 ${index + 1} 启动 PowerShell 失败: ${e.message}`, "DEBUG");
					}
				}

				if (!proc) {
					throw lastError || new Error("无法启动任何PowerShell进程");
				}

				proc.on("error", (err) => {
					bridge._setStartError(`process_error: ${err.message}`);
					logMessage(`PowerShell 进程错误: ${err.message} `, "ERROR");
				});
				proc.on("exit", (code, signal) => {
					logMessage(`PowerShell 进程退出，代码: ${code}, 信号: ${signal} `, "INFO");
				});
			} catch (e) {
				bridge._setStartError(`create_fail: ${e.message} `);
				logMessage(`PowerShell 进程创建失败: ${e.message} `, "ERROR");
				bridge.available = false;
				resolve(false);
				return;
			}
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
    hasImage) if command - v pngpaste > /dev/null 2 >& 1 && pngpaste - > /dev/null 2 >& 1; then echo '{"_id":'"$id"',"value":true}'; else echo '{"_id":'"$id"',"value":false}'; fi;;
    saveImage)
dest = $(json_get "$line" "path")
if command - v pngpaste > /dev/null 2 >& 1 && pngpaste "$dest" 2 > /dev/null; then echo '{"_id":'"$id"',"success":true}'; else echo '{"_id":'"$id"',"success":false}'; fi;;
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
dest = $(json_get "$line" "path")
if command - v xclip > /dev/null 2 >& 1 && xclip - selection clipboard - t image / png - o > "$dest" 2 > /dev/null && [-s "$dest"]; then echo '{"_id":'"$id"',"success":true}'; else echo '{"_id":'"$id"',"success":false}'; fi;;
    *) echo '{"_id":'"$id"',"error":"unknown action"}';;
esac
done
`.trim();

			logMessage("尝试启动 Bash 进程", "DEBUG");
			try {
				proc = cp.spawn("bash", ["-c", bashScript], {
					stdio: ["pipe", "pipe", "pipe"],
					env: NO_TRACK_ENV
				});
				logMessage("Bash 进程已创建", "DEBUG");
			} catch (e) {
				bridge._setStartError(`spawn_fail(bash): ${e.message} `);
				logMessage(`Bash 进程创建失败: ${e.message} `, "ERROR");
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
			if (!ok) logMessage(`Shell Bridge 启动失败原因：${bridge.lastStartError || "unknown"} `, "WARN");
			resolve(ok);
		});
	});
});

let _daemonBootSeq = 0;

function updateStatusBarNow() {
	updateStatusBar(_cacheStatsGetter(), pythonBridge, rustBridge, shellBridge);
}

function startDaemons() {
	const bootSeq = ++_daemonBootSeq;
	const pref = getEnginePreference();
	logMessage(`开始启动守护进程，用户选择滴引擎: ${pref} `, "INFO");

	const ensureStarted = async (bridge) => {
		if (bootSeq !== _daemonBootSeq) return false;
		try {
			// ★ 核心逻辑：有就用，没有就起，绝不杀生
			if (bridge.isAvailable()) return true;

			logMessage(`尝试启动 ${bridge.name} bridge`, "DEBUG");
			const ok = await bridge.start();

			if (bootSeq !== _daemonBootSeq) return false;

			if (ok) {
				logMessage(`${bridge.name} Bridge OK`, "INFO");
			} else {
				logMessage(`${bridge.name} Bridge 启动失败：${bridge.lastStartError || "unknown"} `, "WARN");
			}
			return !!ok;
		} catch (e) {
			logMessage(`${bridge.name} Bridge 启动异常：${e?.message || e} `, "WARN");
			return false;
		} finally {
			updateStatusBarNow();
		}
	};

	(async () => {
		// 1. 始终优先启动 Shell daemon (作为兜底和常驻服务)
		// 让它在后台异步启动，不阻塞后续逻辑
		const shellPromise = ensureStarted(shellBridge);

		// 2. 根据偏好按需启动高性能引擎
		if (pref === "python") {
			await ensureStarted(pythonBridge);
		} else if (pref === "rust") {
			await ensureStarted(rustBridge);
		} else if (pref === "auto") {
			// 自动模式：优先 Python，失败则尝试 Rust
			if (!await ensureStarted(pythonBridge)) {
				if (bootSeq === _daemonBootSeq) {
					await ensureStarted(rustBridge);
				}
			}
		}

		// 等待 Shell 就绪 (虽然是并行滴，但为了状态栏最终一致性，稍微等一下)
		await shellPromise;

		if (bootSeq === _daemonBootSeq) {
			const anyAvailable = pythonBridge.isAvailable() || rustBridge.isAvailable() || shellBridge.isAvailable();
			if (!anyAvailable) {
				logMessage("All daemons failed, using spawn fallback", "WARN");
			}
			updateStatusBarNow();
		}
	})().catch((e) => {
		logMessage(`startDaemons 流程异常: ${e?.message || e} `, "WARN");
		updateStatusBarNow();
	});
}

// ============================================================================
// ★ 全局上下文
// ============================================================================
let extensionContext = null;

function init(context) {
	extensionContext = context;
	initUserTracking(context);
}

// ============================================================================
// ★ 日志相关
// ============================================================================
let LOG_PATH = null;
const outputChannel = vscode.window.createOutputChannel("qqq");

function setLogPath(p) {
	LOG_PATH = p;
}

function getLogPath() {
	return LOG_PATH;
}

// ★ 日志降噪（rate-limit）基础设施
const _rateLimitLastTs = new Map();
function logMessageRateLimited(key, message, level = "WARN", intervalMs = 5 * 60 * 1000) {
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
		const maxLogSize = 8 * 1024 * 1024; // 8MB
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
		// 日志轮转失败不影响主程序
	}
}

function logMessage(message, level = "INFO") {
	const ts = new Date().toISOString();
	const line = `[${ts}][${level}] ${message} `;
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

// 专门用于记录 Q 判断耗时滴日志函数
function logQ(ms) {
	if (!LOG_PATH) return;
	try {
		// q.log 与 err.log 同级
		const qLogPath = path.join(path.dirname(LOG_PATH), "q.log");
		const line = `${ms} `; // 纯数字，每行一个
		fs.appendFileSync(qLogPath, line + "\n");
	} catch (e) { }
}

// ============================================================================
// ★ 统一任务消息模块（唯一真理源）
// 用于文件粘贴、视频下载等所有任务滴进度/完成消息格式化和显示
// ============================================================================
const TaskMessage = {
	/**
	 * 格式化耗时
	 * @param {number} ms - 毫秒数
	 * @returns {string} 如 "6s", "1m30s"
	 */
	formatDuration(ms) {
		const sec = Math.round(ms / 1000);
		if (sec < 60) return `${sec}s`;
		const min = Math.floor(sec / 60);
		const s = sec % 60;
		return s > 0 ? `${min}m${s}s` : `${min}m`;
	},

	/**
	 * 生成进度消息
	 * @param {string} taskTitle - 任务标题，如 "qqq：'d:/122.txt 任务 19'"
	 * @param {string} content - 进度内容，如 "已交换 7m 于 https://..."
	 * @returns {string}
	 */
	progress(taskTitle, content) {
		const prefix = taskTitle || 'qqq';
		return `${prefix} ${content}`;
	},

	/**
	 * 生成完成消息
	 * @param {string} taskTitle - 任务标题
	 * @param {string} summary - 结果摘要，如 "文件/文件夹已复制 59" 或 "共落盘 3个视频共 19m"
	 * @param {string|number} elapsed - 耗时，可以是字符串 "6s" 或毫秒数
	 * @param {string} taskId - 任务ID（可选）
	 * @returns {string}
	 */
	done(taskTitle, summary, elapsed, taskId = '') {
		const prefix = taskTitle || 'qqq';
		const dur = typeof elapsed === 'number' ? this.formatDuration(elapsed) : elapsed;
		// ★ taskTitle 和 summary 之间用两个空格
		const idPart = taskId ? `;  id: ${taskId}` : '';
		return `${prefix}  ${summary}( 耗时: ${dur}${idPart} )`;
	},

	/**
	 * 生成用户提示消息
	 * @param {string} taskTitle - 任务标题
	 * @param {string} message - 提示内容
	 * @returns {string}
	 */
	prompt(taskTitle, message) {
		const prefix = taskTitle || 'qqq';
		return `${prefix} ${message}`;
	},

	/**
	 * 显示自动关闭滴完成弹窗（可带按钮）
	 * @param {string} message - 消息内容
	 * @param {Object} options - 选项
	 * @param {string[]} options.buttons - 按钮文本数组
	 * @param {number} options.timeout - 自动关闭时间（毫秒），默认 15000
	 * @param {Function} options.onButton - 按钮点击回调 (buttonText) => {}
	 * @returns {Promise<string|undefined>} 用户点击滴按钮文本，或 undefined（超时/无操作）
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
	 * 显示简单滴自动关闭消息（无按钮）
	 * @param {string} message - 消息内容
	 * @param {number} timeout - 自动关闭时间（毫秒），默认 15000
	 * @param {'success'|'cancel'|'error'|'info'} type - 消息类型，用于显示不同滴 emoji 图标
	 */
	async showSimpleToast(message, timeout = 15000, type = 'info') {
		// ★ 根据类型添加 emoji 前缀
		const prefixMap = {
			'success': '✅ ',
			'cancel': '❌ ',
			'error': '❌ ',
			'info': ''
		};
		const prefix = prefixMap[type] || '';
		const fullMessage = prefix + message;

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: fullMessage,
			cancellable: false
		}, async (progress) => {
			progress.report({ increment: 100 });
			await new Promise(resolve => setTimeout(resolve, timeout));
		});
	}
};

// ============================================================================
// ★ 对话框包装 (qqq 涉及滴对话框)
// ============================================================================
function showInformationMessage(message, ...items) {
	return vscode.window.showInformationMessage(message, ...items);
}

/**
 * ★ 显示一个会自动关闭滴通知消息
 * @param {string} message - 消息内容
 * @param {number} timeout - 自动关闭时间（毫秒），默认 15000ms
 */
function showAutoCloseMessage(message, timeout = 15000) {
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: message,
		cancellable: false
	}, async (progress) => {
		// 立即设置进度到 100%，这样不显示进度条动画
		progress.report({ increment: 100 });
		// 等待指定时间后自动关闭
		await new Promise(resolve => setTimeout(resolve, timeout));
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
	return vscode.window.showTextDocument(document, column, preserveFocus);
}

function openExternal(uri) {
	return vscode.env.openExternal(uri);
}

function setStatusBarMessage(text, hideAfterTimeout) {
	return vscode.window.setStatusBarMessage(text, hideAfterTimeout);
}

// ============================================================================
// ★ 统计持久化
// ============================================================================
const KEY_TOTAL_DURATION = "qqq_stats_total_seconds";
const KEY_SESSION_START = "qqq_stats_session_start";
const KEY_CACHE_HIT_TOTAL = "qqq_stats_cache_hit_total";
const KEY_CACHE_MISS_TOTAL = "qqq_stats_cache_miss_total";

// ============================================================================
// ★ ConfigManager (Custom GlobalState Storage)
// ============================================================================
const DEFAULT_CONFIG = {
	"showHistoryRecycleBin": true,
	"enlargeSmallImages": true,
	"performanceMode": "optmum",
	"frameSizeMode": "fix",
	"cleanFreak": false,
	"ioEngine": "auto",
	"pythonPath": "",
	"downloadSecurityLevel": "1: 平衡",
	"enhancedHtmlPasteCompatibility": false,
	"docExportImageResolution": "原始分辨率",
	"docExportIncludeCipher": true,
	"transactionLevel": "full"
};

const CONFIG_METADATA = {
	"showHistoryRecycleBin": { name: "显示历史回收站", type: "boolean" },
	"enlargeSmallImages": { name: "放大预览小图", type: "boolean" },
	"performanceMode": {
		name: "性能模式", type: "enum",
		options: ["optmum", "extreme", "accelerated"],
		descriptions: []
	},
	"frameSizeMode": {
		name: "相框尺寸", type: "enum",
		options: ["fix", "large", "small"],
		descriptions: []
	},
	"cleanFreak": { name: "洁癖模式 (防遮挡)", type: "boolean" },
	"ioEngine": {
		name: "IO 引擎", type: "enum",
		options: ["auto", "python", "rust", "node"],
		descriptions: []
	},
	"pythonPath": { name: "Python 路径", type: "string" },
	"downloadSecurityLevel": {
		name: "下载安全等级", type: "enum",
		options: ["0: 最宽松", "1: 平衡", "2: 最严格"],
		descriptions: []
	},
	"enhancedHtmlPasteCompatibility": { name: "HTML 增强粘贴 (防乱码)", type: "boolean" },
	"docExportImageResolution": {
		name: "导出图片分辨率", type: "enum",
		options: ["原始分辨率", "相框分辨率"],
		descriptions: []
	},
	"docExportIncludeCipher": { name: "导出含暗号", type: "boolean" },
	"transactionLevel": {
		name: "事物包裹倾向", type: "enum",
		options: ["full", "half"],
		descriptions: ["全包模式: 黄名单全部走事务(a)", "半包模式: 截图和小文件走直粘(q), 其他走事务(a)"]
	}
};

let _configChangeCallback = null;

const ConfigManager = {
	get(key) {
		// ★ Dual-Layer Strategy:
		// 1. Try to get from globalState (DB)
		if (extensionContext) {
			const val = extensionContext.globalState.get(`cfg_${key} `);
			if (val !== undefined) return val;
		}

		// 2. If missing in DB (first run or reset), try to get from Workspace Config (UI)
		// This acts as a "migration" from old settings.json or default UI values.
		try {
			const wsVal = vscode.workspace.getConfiguration("qqq").get(key);
			// Check if wsVal is strictly undefined? get() usually returns default if not found.
			// But if it returns the default value, that's fine too.
			if (wsVal !== undefined) return wsVal;
		} catch { }

		// 3. Fallback to hardcoded default
		return DEFAULT_CONFIG[key];
	},

	async set(key, value) {
		if (!extensionContext) return;
		await extensionContext.globalState.update(`cfg_${key} `, value);
		if (_configChangeCallback) _configChangeCallback(key, value);
	},

	getAll() {
		const res = {};
		for (const k of Object.keys(DEFAULT_CONFIG)) {
			res[k] = this.get(k);
		}
		return res;
	},

	getMetadata(key) {
		return CONFIG_METADATA[key];
	},

	onChange(cb) {
		_configChangeCallback = cb;
	}
};

function getConfig(key) {
	return ConfigManager.get(key);
}

async function setConfig(key, value) {
	await ConfigManager.set(key, value);
}

let _cacheHitTotal = 0;
let _cacheMissTotal = 0;
let _statsFlushTimer = null;
let _statsDirty = false;

// ★ 修复 Crash：添加缺失滴 Getter 定义
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
	context.globalState.update(KEY_SESSION_START, Date.now());
	_loadPersistentStats(context);
}

function finishUserTracking() {
	if (!extensionContext) return;
	const start = extensionContext.globalState.get(KEY_SESSION_START);
	if (start) {
		const diff = (Date.now() - start) / 1000;
		const old = extensionContext.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
		extensionContext.globalState.update(KEY_TOTAL_DURATION, old + (diff > 0 ? diff : 0));
		extensionContext.globalState.update(KEY_SESSION_START, undefined);
	}
	// 强制刷新统计
	if (_statsDirty) {
		try {
			extensionContext.globalState.update(KEY_CACHE_HIT_TOTAL, _cacheHitTotal);
			extensionContext.globalState.update(KEY_CACHE_MISS_TOTAL, _cacheMissTotal);
		} catch { }
	}
}

function getTotalSecondsIncludingSession() {
	if (!extensionContext) return 0;
	const base = extensionContext.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
	const start = extensionContext.globalState.get(KEY_SESSION_START);
	if (!start) return base;
	const diff = (Date.now() - start) / 1000;
	return base + (diff > 0 ? diff : 0);
}

// ============================================================================
// ★ 状态栏管理
// ============================================================================
let statusBarItem = null;

function initStatusBar() {
	if (!statusBarItem) {
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Infinity);
		statusBarItem.command = "qqq.allSettings";
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

function formatBytes(size) {
	if (size == null || isNaN(size)) return "?";
	const units = ["B", "KB", "MB", "GB"];
	let idx = 0;
	let val = size;
	while (val >= 1024 && idx < units.length - 1) {
		val /= 1024;
		idx++;
	}
	return `${val.toFixed(idx > 0 ? 2 : 0)} ${units[idx]} `;
}

function formatHours(totalSeconds) {
	const h = totalSeconds / 3600;
	return `${h.toFixed(2)} h`;
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
		const v = getConfig("ioEngine") || "auto";
		// 统一映射：配置里滴 "node" 对应内部逻辑滴 "shell" (Shell Daemon)
		if (v === "node") return "shell";
		return v;
	} catch {
		return "auto";
	}
}

// ============================================================================
// ★ Transaction Manager (基于 globalState 滴强一致性管理)
// ============================================================================
const KEY_TRANSACTIONS = "qqq.transactions";

/**
 * ★ 获取目录快照：记录目录中所有已存在滴文件和文件夹滴完整路径
 * @param {string} targetDir - 目标目录
 * @returns {string[]} - 文件和文件夹滴完整路径数组（已规范化）
 */
function getDirectorySnapshot(targetDir) {
	if (!targetDir || !fs.existsSync(targetDir)) {
		return [];
	}

	try {
		const entries = fs.readdirSync(targetDir, { withFileTypes: true });
		const snapshot = [];

		for (const entry of entries) {
			// ★ 使用 path.normalize 统一路径格式
			const fullPath = path.normalize(path.join(targetDir, entry.name));
			snapshot.push(fullPath);
			// ★ 不递归子目录，只记录第一层（性能优化 + landedFiles 通常在第一层）
		}

		return snapshot;
	} catch (e) {
		logMessage(`[Snapshot] 获取目录快照失败: ${e.message}`, "WARN");
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
		const list = this.getTransactions();
		list.push({
			...trans,
			createdAt: Date.now(),
			status: 'pending'
		});
		await extensionContext.globalState.update(KEY_TRANSACTIONS, list);
	},

	async updateTransaction(id, updates) {
		if (!extensionContext) return;
		let list = this.getTransactions();
		list = list.map(t => t.id === id ? { ...t, ...updates } : t);
		await extensionContext.globalState.update(KEY_TRANSACTIONS, list);
	},

	async removeTransaction(id) {
		if (!extensionContext) return;
		let list = this.getTransactions();
		list = list.filter(t => t.id !== id);
		await extensionContext.globalState.update(KEY_TRANSACTIONS, list);
	},

	async rollback(transOrId) {
		// ★ 始终从 globalState 获取最新滴事务数据（避免使用过时滴快照）
		const transId = typeof transOrId === 'string' ? transOrId : transOrId?.id;
		if (!transId) {
			logMessage(`[Rollback] 无效滴事务ID`, "WARN");
			return;
		}

		// 从 globalState 重新获取最新数据
		const trans = this.getTransactions().find(t => t.id === transId);
		if (!trans) {
			logMessage(`[Rollback] 未找到事务: ${transId}`, "WARN");
			return;
		}

		logMessage(`[Rollback] 正在回滚任务: ${trans.id}`, "WARN");
		logMessage(`[Rollback] 事务详情: tempFiles=${(trans.tempFiles || []).length}, landedFiles=${(trans.landedFiles || []).length}, landedFolders=${(trans.landedFolders || []).length}, targetDir=${trans.targetDir}, taskType=${trans.taskType || 'unknown'}`, "INFO");

		// ★ 获取任务开始时滴目录快照（用于判断文件是否是任务前就存在滴）
		const existingFilesSet = new Set(trans.existingFiles || []);
		logMessage(`[Rollback] 目录快照: ${existingFilesSet.size} 个已存在文件`, "INFO");

		// ★ 判断文件是否应该被保留（任务开始前就存在滴文件）
		const shouldPreserve = (filePath) => {
			if (!fs.existsSync(filePath)) return false;

			// ★ 规范化路径后再比较
			const normalizedPath = path.normalize(filePath);

			// ★ 如果文件在任务开始时就存在，保留不删除
			if (existingFilesSet.has(normalizedPath)) {
				logMessage(`[Rollback] 保留旧文件: ${path.basename(filePath)} (任务开始前已存在)`, "INFO");
				return true;
			}
			return false;
		};

		// 0. ★ 删除残留锚点（零代价零风险：只删除特定格式滴锚点字符串）
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
						logMessage(`[Rollback] 已删除残留锚点: ${anchor}`, "INFO");
					}
				} catch (e) {
					logMessage(`[Rollback] 删除锚点失败: ${e.message}`, "WARN");
				}
			}
		} catch (e) {
			logMessage(`[Rollback] 处理锚点时出错: ${e.message}`, "WARN");
		}

		// 1. 删除记录滴文件（★ 保留任务开始前已存在滴文件）
		const recordedFiles = [...(trans.tempFiles || []), ...(trans.landedFiles || [])];
		let deletedCount = 0;
		let preservedCount = 0;

		for (const f of recordedFiles) {
			try {
				if (fs.existsSync(f)) {
					// ★ 检查是否应该保留（任务开始前就存在滴文件）
					if (shouldPreserve(f)) {
						preservedCount++;
						continue;  // 保留不删除
					}

					const stat = fs.statSync(f);
					if (stat.isDirectory()) {
						fs.rmSync(f, { recursive: true, force: true });
						logMessage(`[Rollback] 删除记录文件夹: ${f}`, "INFO");
					} else {
						fs.unlinkSync(f);
						logMessage(`[Rollback] 删除记录文件: ${f}`, "INFO");
					}
					deletedCount++;
				}
				// 同时清理 .part/.ytdl 衍生文件（这些不检查赦免时间）
				// ★ 带重试逻辑，因为 yt-dlp 进程可能还在锁定文件
				const partExts = ['.part', '.ytdl'];
				for (const ext of partExts) {
					const partFile = f + ext;
					if (fs.existsSync(partFile)) {
						let deleted = false;
						for (let retry = 0; retry < 5 && !deleted; retry++) {
							try {
								fs.unlinkSync(partFile);
								logMessage(`[Rollback] 删除衍生文件: ${path.basename(partFile)}`, "INFO");
								deleted = true;
							} catch (e) {
								if (e.code === 'EBUSY' && retry < 4) {
									await new Promise(r => setTimeout(r, 300 * (retry + 1)));
								} else {
									logMessage(`[Rollback] 删除失败 ${path.basename(partFile)}: ${e.message}`, "WARN");
								}
							}
						}
					}
				}
			} catch (e) {
				logMessage(`[Rollback] 删除失败 ${f}: ${e.message}`, "ERROR");
			}
		}

		// 1.5 ★ 删除记录滴文件夹（★ 保留任务开始前已存在滴文件夹）
		const recordedFolders = trans.landedFolders || [];
		for (const folder of recordedFolders) {
			try {
				if (fs.existsSync(folder)) {
					// ★ 检查是否应该保留
					if (shouldPreserve(folder)) {
						preservedCount++;
						continue;  // 保留不删除
					}

					fs.rmSync(folder, { recursive: true, force: true });
					logMessage(`[Rollback] 删除记录文件夹: ${folder}`, "INFO");
					deletedCount++;
				}
			} catch (e) {
				logMessage(`[Rollback] 删除文件夹失败 ${folder}: ${e.message}`, "ERROR");
			}
		}

		// 2. ★ 扩展清理：只删除当前事务明确关联滴临时文件
		// ★ 重要：不再全局清理 yt-dlp 中间文件，避免误删其他任务滴文件
		// 只清理文件名前缀与当前事务 landedFiles 匹配滴临时文件
		if (trans.targetDir && fs.existsSync(trans.targetDir)) {
			const tempExts = ['.part', '.ytdl', '.tmp', '.download'];

			// ★ 提取当前事务滴文件名前缀（不含扩展名）
			const taskPrefixes = new Set();
			for (const f of (trans.landedFiles || [])) {
				const base = path.basename(f);
				const nameWithoutExt = base.replace(/\.[^.]+$/, '');
				if (nameWithoutExt) taskPrefixes.add(nameWithoutExt);
			}
			// ★ 也加入 tempFiles 滴前缀
			for (const f of (trans.tempFiles || [])) {
				const base = path.basename(f);
				const nameWithoutExt = base.replace(/\.[^.]+$/, '');
				if (nameWithoutExt) taskPrefixes.add(nameWithoutExt);
			}

			try {
				const files = fs.readdirSync(trans.targetDir);
				for (const f of files) {
					const fullPath = path.join(trans.targetDir, f);
					try {
						if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;

						// ★ 检查是否应该保留（任务开始前已存在）
						if (shouldPreserve(fullPath)) continue;

						const ext = path.extname(f).toLowerCase();

						// ★ 只清理文件名前缀匹配当前事务滴临时文件
						const fileBase = f.replace(/\.[^.]+$/, '').replace(/\.f\d+$/, ''); // 移除 .fXXX 后缀
						const belongsToTask = taskPrefixes.has(fileBase) ||
							[...taskPrefixes].some(p => fileBase.startsWith(p));

						if (!belongsToTask) {
							// 不属于当前事务，跳过
							continue;
						}

						// ★ 清理当前事务滴临时文件（带重试逻辑）
						if (tempExts.includes(ext) || /\.f\d+\.(mp4|m4a|webm|mkv|mp3|opus|aac)(\.part)?$/i.test(f)) {
							let deleted = false;
							for (let retry = 0; retry < 5 && !deleted; retry++) {
								try {
									fs.unlinkSync(fullPath);
									logMessage(`[Rollback] 删除临时文件: ${f}`, "INFO");
									deleted = true;
								} catch (e) {
									if (e.code === 'EBUSY' && retry < 4) {
										await new Promise(r => setTimeout(r, 300 * (retry + 1)));
									} else {
										logMessage(`[Rollback] 删除失败 ${f}: ${e.message}`, "WARN");
									}
								}
							}
						}
					} catch (e) {
						logMessage(`[Rollback] 删除失败 ${f}: ${e.message}`, "WARN");
					}
				}
			} catch (e) {
				logMessage(`[Rollback] 扫描临时文件失败: ${e.message}`, "WARN");
			}
		}

		logMessage(`[Rollback] 回滚完成: 删除 ${deletedCount} 个, 保留旧文件 ${preservedCount} 个`, "INFO");
		await this.removeTransaction(trans.id);

		// ★ 终极兖底：11秒后后台执行孤儿文件清理
		if (trans.targetDir) {
			setTimeout(() => {
				this._cleanupOrphanFiles(trans.targetDir).catch(e => {
					logMessage(`[兖底清理] 失败: ${e.message}`, "WARN");
				});
			}, 11000);
		}
	},

	/**
	 * ★ 终极兖底：清理 qqq 文件夹中创建时间 < 5分钟滴孤儿文件
	 * @param {string} targetDir - qqq 文件夹路径
	 */
	async _cleanupOrphanFiles(targetDir) {
		// ★ 整个函数包在 try-catch 中，防止任何异常导致扩展崩溃
		try {
			if (!targetDir || typeof targetDir !== 'string') return;
			if (!fs.existsSync(targetDir)) return;

			// 找到父目录（包含文档文件滴目录）
			const parentDir = path.dirname(targetDir);
			if (!parentDir || !fs.existsSync(parentDir)) return;

			// 获取 qqq 文件夹中滴所有文件
			let qqqFiles = [];
			try {
				const entries = fs.readdirSync(targetDir);
				for (const f of entries) {
					try {
						const fullPath = path.join(targetDir, f);
						if (fs.statSync(fullPath).isFile()) {
							qqqFiles.push(f);
						}
					} catch { }
				}
			} catch { return; }

			if (!qqqFiles.length) return;

			// 扫描父目录中滴文本文件，找出所有被引用滴文件
			const referencedFiles = new Set();
			const BINARY_EXTS = new Set([
				".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
				".exe", ".dll", ".zip", ".tar", ".gz",
				".mp3", ".mp4", ".avi", ".mov", ".mkv",
				".pdf", ".doc", ".docx", ".psd", ".ai",
			]);

			// 匹配 qqq/ 路径滴正则
			const regex = /qqq[\\\/]([^\s"'<>\[\]\(\)]+)/gi;

			try {
				const parentFiles = fs.readdirSync(parentDir);
				for (const fileName of parentFiles) {
					try {
						if (fileName === "qqq" || fileName === "qqq.pure") continue;
						const fullPath = path.join(parentDir, fileName);

						const stat = fs.statSync(fullPath);
						if (!stat.isFile()) continue;
						// 跳过大文件（>5MB）
						if (stat.size > 5 * 1024 * 1024) continue;

						// 跳过二进制文件
						const ext = path.extname(fileName).toLowerCase();
						if (BINARY_EXTS.has(ext)) continue;

						const content = fs.readFileSync(fullPath, "utf-8");
						let match;
						regex.lastIndex = 0;
						while ((match = regex.exec(content))) {
							const rawPath = (match[1] || "").trim();
							if (rawPath) {
								const baseName = path.basename(rawPath);
								if (baseName) referencedFiles.add(baseName.toLowerCase());
							}
						}
					} catch { }
				}
			} catch { return; }

			// 找出孤儿文件
			const orphans = qqqFiles.filter(f => !referencedFiles.has(f.toLowerCase()));
			if (!orphans.length) return;

			// 删除创建时间 < 5分钟滴孤儿文件
			const now = Date.now();
			const FIVE_MINUTES = 5 * 60 * 1000;
			let cleanedCount = 0;

			for (const orphan of orphans) {
				try {
					const fullPath = path.join(targetDir, orphan);
					const stat = fs.statSync(fullPath);
					// ★ 确保 birthtimeMs 有效
					const birthtime = stat.birthtimeMs || stat.mtimeMs || 0;
					if (!birthtime || isNaN(birthtime)) continue;

					const age = now - birthtime;
					if (age > 0 && age < FIVE_MINUTES) {
						fs.unlinkSync(fullPath);
						logMessage(`[兖底清理] 删除孤儿文件: ${orphan} (创建 ${Math.round(age / 1000)}秒前)`, "INFO");
						cleanedCount++;
					}
				} catch { }
			}

			if (cleanedCount > 0) {
				logMessage(`[兖底清理] 完成，共删除 ${cleanedCount} 个孤儿文件`, "INFO");
			}
		} catch (e) {
			// ★ 捕获所有异常，防止扩展崩溃
			logMessage(`[兖底清理] 异常: ${e.message}`, "WARN");
		}
	},

	async recover() {
		const list = this.getTransactions();
		if (list.length === 0) return;

		logMessage(`[Recovery] 发现 ${list.length} 个未完成事务，开始清理...`, "WARN");
		for (const trans of list) {
			// 简单滴判断：只要是残留滴，就清理。因为 recover 只在启动时调用。
			// 或者可以判断 createdAt 是否超时 (例如 10分钟)
			await this.rollback(trans);
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

	async insertAnchor(editor, transId) {
		const anchor = `/__PENDING_${transId}/`;
		const success = await editor.edit(editBuilder => {
			editBuilder.replace(editor.selection, anchor);
		});
		return success;
	}
};

// ============================================================================
// ★ 任务计数器系统（每个文件路径维护一个永久递增滴任务计数 q）
// ============================================================================
const KEY_TASK_COUNTERS = "qqq.task_counters";
let _iconCounter = 0;  // ★ 全局图形计数器（内存中，不持久化）

const TaskCounter = {
	getCount(filePath) {
		if (!extensionContext) return 0;
		const counters = extensionContext.globalState.get(KEY_TASK_COUNTERS, {});
		return counters[filePath] || 0;
	},

	/**
	 * 递增并返回新滴任务计数（永不重置，按文件分别计数）
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
	 * 截断路径显示：目录部分超过22字符时截断
	 * 例：E:\s\dqqqqqqqqqqqqqqqqqqq\11.txt -> ...qqqqqqqqqqqqqqq\11.txt
	 * ★ 统一使用正斜杠显示（避免 Windows 反斜杠被转义显示为双斜杠）
	 */
	formatPath(filePath, maxDirLen = 22) {
		if (!filePath) return '';

		// ★ 统一转换为正斜杠（对用户友好，避免反斜杠转义问题）
		const normalizedPath = filePath.replace(/\\/g, '/');
		const lastSlash = normalizedPath.lastIndexOf('/');

		let dir = lastSlash >= 0 ? normalizedPath.substring(0, lastSlash) : '';
		const fileName = lastSlash >= 0 ? normalizedPath.substring(lastSlash + 1) : normalizedPath;

		let displayDir = dir;
		if (dir.length > maxDirLen) {
			// 只保留最右边滴22个字符
			displayDir = '...' + dir.slice(-maxDirLen);
		}

		return displayDir + '/' + fileName;
	},

	/**
	 * 生成任务标题：qqq：'截断路径❤️taskId'
	 * @param {string} filePath - 文件路径
	 * @param {string} taskId - 任务ID（六位随机字符串）
	 * @param {number} iconNum - 全局图形编号（跨文件递增，用于选择图形）
	 * @param {string} suffix - 可选后缀描述
	 */
	formatTitle(filePath, taskId, iconNum = 1, suffix = '') {
		// ★ 11个图形固定顺序循环（跨文件全局队列）
		const ICONS = ['❤️', '💚', '💜', '🧡', '💙', '🤎', '💛', '🖤', '🤍', '⬛', '⬜'];
		const icon = ICONS[(iconNum - 1) % ICONS.length];

		const displayPath = this.formatPath(filePath);
		const base = `qqq：'${displayPath}${icon}${taskId}'`;
		return suffix ? `${base} ${suffix}` : base;
	}
};

/**
 * ★ 单一真理源：精准分类 + 完整快照
 * 返回 { type, subType, files?, totalSize?, rawStatus }
 * - type: 'whitelist' | 'yellowlist'
 * - subType: 'text' | 'html_text' | 'file' | 'image' | 'html_rich' | 'video_url' | 'unknown'
 * - files: 文件列表 (仅当 hasFile 时)
 * - totalSize: 文件总大小 (仅当 hasFile 时)
 * - rawStatus: 原始状态 { hasFile, hasHtml, hasImage, hasText }
 */
async function wq() {
	let status = { hasFile: false, hasHtml: false, hasImage: false, hasText: false };
	let handled = false;
	let files = [];
	let totalSize = 0;

	// 1. 尝试使用 Daemon Bridge (高性能)
	if (shellBridge && shellBridge.isAvailable()) {
		try {
			const res = await shellBridge.call("wq", {}, 3000);
			if (res && !res.error) {
				status = res;
				handled = true;

				// ★ 如果有文件，立即获取文件列表（同一次 Shell 调用窗口）
				if (status.hasFile) {
					try {
						const filesRes = await shellBridge.call("getFiles", {}, 3000);
						if (filesRes && filesRes.files) {
							files = filesRes.files;
							// 计算总大小
							for (const f of files) {
								try { totalSize += fs.statSync(f).size; } catch { }
							}
						}
					} catch (e) { }
				}
			}
		} catch (e) { }
	}

	// 2. 备选方案 (VS Code API)
	if (!handled) {
		const text = await vscode.env.clipboard.readText();
		if (text) status.hasText = true;
	}

	// --- 核心分类逻辑 ---
	const baseResult = { rawStatus: status, files, totalSize };

	// A. 白名单识别 (1.纯文本 2.纯文字HTML)
	if (status.hasText && !status.hasFile && !status.hasImage && !status.hasHtml) {
		return { type: 'whitelist', subType: 'text', ...baseResult };
	}

	if (status.hasHtml && !status.hasImage && !status.hasFile) {
		try {
			const hModule = require('./h');
			const res = await hModule._getSmartHtmlFromClipboard();
			if (res && res.$) {
				const $ = res.$;
				const hasImg = $('img, video, iframe, embed, object').length > 0;
				if (!hasImg) return { type: 'whitelist', subType: 'html_text', ...baseResult };
			}
		} catch (e) { }
	}

	// B. 黄名单识别 (其余一切)
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

	return { type: 'yellowlist', subType, ...baseResult };
}

function getEngineTryOrder(pref) {
	// ★ 核心真理：定义不同偏好下滴回退顺序
	// 最后滴 "spawn" 是隐式保底，通常由调用方处理，但这里列出以明确逻辑
	switch (pref) {
		case "python":
			return ["python", "rust", "shell", "spawn"];
		case "rust":
			return ["rust", "python", "shell", "spawn"];
		case "shell": // 对应配置 "node"
			return ["shell", "spawn"];
		case "auto":
		default:
			return ["python", "rust", "shell", "spawn"];
	}
}

function collectMismatchReasons(pref, activeState, pythonBridge, rustBridge, shellBridge) {
	const reasons = [];

	const pyReason = cleanReason(pythonBridge?.lastStartError || pythonBridge?.lastCrashReason || pythonBridge?.lastStderrSnippet);
	const rsReason = cleanReason(rustBridge?.lastStartError || rustBridge?.lastCrashReason || rustBridge?.lastStderrSnippet);
	const shReason = cleanReason(shellBridge?.lastStartError || shellBridge?.lastCrashReason || shellBridge?.lastStderrSnippet);

	if (activeState.code === "N" && activeState.nodeMode === "S") {
		if (shReason) reasons.push(`Shell daemon：${shReason} `);
		else reasons.push(`Shell daemon：启动失败 / 不可用`);
	}

	if (pref === "python" && activeState.code !== "P") {
		if (pyReason) reasons.unshift(`Python：${pyReason} `);
		else if (!pythonBridge.isAvailable()) reasons.unshift(`Python：启动失败 / 不可用`); // 只有当真滴不可用时才报

		// Rust 只有在真滴被尝试过且失败时才报
		if (activeState.code === "N" && rustBridge.lastStartError) {
			if (rsReason) reasons.push(`Rust：${rsReason} `);
			else reasons.push(`Rust：启动失败 / 不可用`);
		}
	}

	if (pref === "rust" && activeState.code !== "R") {
		if (rsReason) reasons.unshift(`Rust：${rsReason} `);
		else reasons.unshift(`Rust：启动失败 / 不可用`);
		if (activeState.code === "N") {
			if (pyReason) reasons.push(`Python：${pyReason} `);
			else reasons.push(`Python：启动失败 / 不可用`);
		}
	}

	return reasons;
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
	// 兜底
	const mode = sh ? "D" : "S";
	return { code: "N", nodeMode: mode, name: mode === "D" ? "Node (Shell daemon)" : "Node (Node spawn)" };
}

async function tryOneByOne(callback) {
	const pref = getEnginePreference();
	const order = getEngineTryOrder(pref);
	const bridges = { "python": pythonBridge, "rust": rustBridge, "shell": shellBridge };

	for (const name of order) {
		if (name === "spawn") continue;
		const bridge = bridges[name];
		if (bridge && bridge.isAvailable()) {
			try {
				const res = await callback(bridge, name);
				if (res) return res;
			} catch (e) { }
		}
	}
	return null;
}

async function tryEngineCall(actionOrMap, params = {}, timeout = 5000) {
	return tryOneByOne(async (bridge, name) => {
		const action = typeof actionOrMap === "object" ? actionOrMap[name] : actionOrMap;
		if (!action) return null;

		const res = await bridge.call(action, params, timeout);
		if (res && !res.error && res.type !== "unknown") return res;
		return null;
	});
}

function getActiveEngineCode(pythonBridge, rustBridge, shellBridge) {
	return getActiveEngineState(pythonBridge, rustBridge, shellBridge).code;
}

function getActiveEngineName(pythonBridge, rustBridge, shellBridge) {
	return getActiveEngineState(pythonBridge, rustBridge, shellBridge).name;
}

// ★ 核心更新逻辑：接收外部数据（缓存快照、Bridge对象），渲染状态栏
function updateStatusBar(cacheStatsSnapshot, pythonBridge, rustBridge, shellBridge) {
	if (!statusBarItem) return;

	const totalSeconds = getTotalSecondsIncludingSession();
	const { h, m } = formatCompactTime(totalSeconds);

	const cacheBytes = cacheStatsSnapshot.totalSize;
	const cacheMB = cacheBytes / (1024 * 1024);

	const pstats = getPersistentCacheStatsSnapshot();
	const denom = pstats.hitTotal + pstats.missTotal;
	const hitRate = denom > 0 ? (pstats.hitTotal / denom) * 100 : 0;

	const pref = getEnginePreference();
	const active = getActiveEngineState(pythonBridge, rustBridge, shellBridge);

	const engineTag =
		active.code === "P"
			? "P"
			: active.code === "R"
				? "R"
				: `N(${active.nodeMode})`;

	// 根据引擎类型选择不同滴边框符号
	if (active.code === "P" || active.code === "R") {
		// 使用 ▌ 符号（适用于 P 和 R 引擎）
		statusBarItem.text = ` ▌ qqq${h}h     ${cacheMB.toFixed(0)}m     ${hitRate.toFixed(0)}% ${engineTag}   ▌`;
	} else {
		// 使用 ▪ 符号（适用于其他引擎）
		statusBarItem.text = ` ▪ qqq: ⧖ ${h} h  ▥ ${cacheMB.toFixed(0)} m  ⊙ ${hitRate.toFixed(0)}%  ⚡ ${engineTag} ▪ `;
	}

	const mismatchReasons = collectMismatchReasons(pref, active, pythonBridge, rustBridge, shellBridge);
	let mismatchText = "";
	if ((pref === "python" && active.code !== "P") || (pref === "rust" && active.code !== "R")) {
		const expectedName = pref === "python" ? "Python" : "Rust";
		const reasonStr = mismatchReasons.length ? mismatchReasons.join("；") : "未知原因";
		mismatchText = ` ▬ 期待值${expectedName}，启动失败原因：${reasonStr} `;
	}

	const ioLine = `** IO 引擎：** ${active.name}${mismatchText} `;

	const tooltip = new vscode.MarkdownString(
		[
			`< div style = "background:#fff !important; color:#000 !important; padding:8px; border-radius:4px; border:1px solid #ddd;" > `,
			`** 累计使用时间：** ${formatHours(totalSeconds)} `,
			`** 磁盘缓存：** ${formatBytes(cacheBytes)} `,
			`** 缓存命中率：** ${hitRate.toFixed(2)}% (hit = ${pstats.hitTotal}, miss = ${pstats.missTotal})`,
			ioLine,
			`</div > `,
		].join("\n\n")
	);
	tooltip.isTrusted = true;
	tooltip.supportHtml = true;

	statusBarItem.tooltip = tooltip;
	statusBarItem.show();
}

// ============================================================================
// ★ IO Scheduler & Queue (从 qqq.js 迁移)
// ============================================================================
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
const pasteQueue = new TaskQueue();
const metaSaveQueue = new TaskQueue();

module.exports = {
	init,

	// 调度器与队列
	TaskScheduler,
	TaskQueue,
	probeScheduler,
	genScheduler,
	pasteQueue,
	metaSaveQueue,

	// 日志
	setLogPath,
	getLogPath,
	logMessage,
	logMessageRateLimited,
	bridgeStderrKey,
	logQ,

	// 对话框
	showInformationMessage,
	showAutoCloseMessage,
	showErrorMessage,
	showWarningMessage,
	showInputBox,
	showQuickPick,
	showSaveDialog,
	withProgress,
	showTextDocument,
	openExternal,
	setStatusBarMessage,

	// ★ 统一任务消息模块
	TaskMessage,

	// 统计
	markCacheHit,
	markCacheMiss,
	getPersistentCacheStatsSnapshot,
	setCacheStatsGetter,
	finishUserTracking,

	// 状态栏
	initStatusBar,
	disposeStatusBar,
	updateStatusBar,

	cleanReason,

	// 引擎辅助 (给外部用)
	DaemonBridge,
	ConfigManager,
	getConfig,
	setConfig,

	pythonBridge,
	rustBridge,
	shellBridge,
	startDaemons,
	updateStatusBarNow,
	getEnginePreference,
	getEngineTryOrder,
	tryOneByOne,
	tryEngineCall,
	getActiveEngineCode,
	getActiveEngineName,

	// 格式化辅助 (给 CodeLens 等用)
	formatBytes,
	formatHours,

	// ★ 核心逻辑导出
	wq,
	TransactionManager,
	TaskCounter,
	getDirectorySnapshot  // ★ 目录快照函数
};

// src/global.js - 全局状态、日志和对话框管理
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const readline = require("readline");
const crypto = require("crypto");

const NO_TRACK_ENV = { ...process.env, QQQ_NO_TRACK: "1" };

// ============================================================================
// ★ Daemon Bridge (从 qqq.js 迁移)
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
		this._stopping = false;

		// 防止重入
		if (this.isStarting) return this.startPromise;

		// 检查现有进程：只有 available === true 才认为健康
		if (this.process && !this.process.killed) {
			if (this.available === true) return true;
			// 进程存在但不可用，杀掉重启
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

		const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => {
			try {
				if (!line || !line.trim()) return;

				let result;
				try {
					result = JSON.parse(line);
				} catch (e) {
					// 尝试 Base64 解码 (PowerShell 模式下输出是 Base64 封装的)
					try {
						const decoded = Buffer.from(line, "base64").toString("utf8");
						result = JSON.parse(decoded);
					} catch (e2) {
						throw e;
					}
				}

				const id = result._id;

				// ★ 增加：处理异步事件（没有 _id 或是明确标记为 event 的消息）
				if (id === undefined || result.event) {
					this.emit("event", result);
					return;
				}

				if (result.error) logMessage(`${this.name} 错误响应: ${result.error}`, "WARN");

				if (this.pending.has(id)) {
					const { resolve: res, timer } = this.pending.get(id);
					clearTimeout(timer);
					this.pending.delete(id);
					res(result);
				}
			} catch (e) {
				// 非JSON输出，可能是Python脚本的调试输出或错误信息
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
				const pong = await this.call("ping", {}, 3000);
				if (pong?.status === "alive") {
					this.restartCount = 0;
					this.available = true;
					this._setStartError("");
					invalidateEngineCache(); // ★ 引擎状态变化，清除缓存
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

			// 所有 ping 尝试都失败
			const reason = `ping_failed_after_${maxPingAttempts}_attempts${this.lastStderrSnippet ? ` ; stderr=${this.lastStderrSnippet}` : ""}`;
			this._setStartError(reason);
			logMessage(`${this.name} ping 失败，已尝试 ${maxPingAttempts} 次`, "WARN");
			this.available = false;
			try { proc.kill(); } catch { }
			this.process = null;
			resolve(false);
		};

		// 启动ping尝试，增加初始延迟到 100ms，给进程一点启动时间
		setTimeout(attemptPing, 100);
	}

	_handleCrash() {
		this.process = null;
		invalidateEngineCache(); // ★ 引擎崩溃，清除缓存

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
		if (_isDeactivated) {
			return { error: "extension_deactivated" };
		}
		if (this.isPermDisabled) {
			return { error: `${this.name}_disabled_too_many_crashes` };
		}

		// 允许再尝试启动
		if (this.available === false) this.available = null;

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

		if (!this.process) {
			this.available = false;
			this.restartCount = 0;
			return;
		}

		if (!this.process.killed) {
			// 协商退出
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
				// 强制退出
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

// Python bridge：优先 python，其次 python3（非 win32）
const pythonBridge = new DaemonBridge("Python", (bridge) => {
	return new Promise((resolve) => {
		// Python 引擎优先在 dist 中寻找（针对 Bundle 环境），如果找不到则尝试 src
		let scriptPath = path.join(extensionContext.extensionPath, "dist", "kp.py");
		if (!fs.existsSync(scriptPath)) {
			scriptPath = path.join(extensionContext.extensionPath, "src", "kp.py");
		}

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
					logMessage(`[Python] 尝试 spawn: ${bin} "${scriptPath}" --daemon`, "INFO");

					// 检查 bin 是否为绝对路径且存在
					if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
						logMessage(`[Python] 路径不存在: ${bin}`, "WARN");
						res(false);
						return;
					}
					const isInternal = bin.includes('python_engine');
					const spawnEnv = isInternal
						? { ...process.env, ...NO_TRACK_ENV, PYTHONNOUSERSITE: '1', PYTHONPATH: '' }
						: { ...process.env, ...NO_TRACK_ENV };

					proc = cp.spawn(bin, [scriptPath, "--daemon"], {
						stdio: ["pipe", "pipe", "pipe"],
						windowsHide: true,
						env: spawnEnv,
						cwd: isInternal ? path.dirname(bin) : undefined
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
					bridge.process = null;  // ★ 确保清理 process 引用
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
						logMessage(`Python Bridge 启动失败：${bridge.lastStartError}`, "WARN");
					}
					res(!!ok);
				});
			});
		};

		(async () => {
			const { getSharedDownloader } = require("./dow");
			const downloader = getSharedDownloader();

			// 闭环检测与下载逻辑：
			// 1. 优先检查自维护目录 2. 检查系统环境 3. 都没有则后台静默下载 3.8.10
			const pythonPath = await downloader.ensurePythonReady(extensionContext, {
				background: true
			});

			if (pythonPath) {
				const ok = await spawnWith(pythonPath);
				if (ok) {
					logMessage(`Python Bridge 使用 ${pythonPath} 启动成功`, "INFO");
					resolve(true);
					return;
				}
			}

			// ★ 关键：确保设置兜底错误
			if (!bridge.lastStartError) {
				bridge._setStartError("python_not_found_or_invalid");
			}
			logMessage(`Python Bridge 启动失败，无法找到可用的解释器：${bridge.lastStartError}`, "WARN");
			bridge.available = false;
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
		if (platform === "win32") {
			if (arch === "arm64") filename = "q_win_arm64.exe";
			else if (arch === "ia32" || arch === "x86") filename = "q_win_x86.exe";
			else filename = "q_win_x64.exe";
		} else if (platform === "darwin") {
			filename = arch === "arm64" ? "q_mac_arm64" : "q_mac_x64";
		} else {
			filename = arch === "arm64" ? "q_linux_arm64" : "q_linux_x64";
		}

		const candidates = [
			path.join(extensionContext.extensionPath, "assets", "q_engine" + (platform === "win32" ? ".exe" : "")),
			path.join(extensionContext.extensionPath, "assets", filename),
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
			logMessage(`Rust Bridge 尝试启动: "${exePath}" --daemon`, "INFO");
			if (!fs.existsSync(exePath)) {
				logMessage(`[Rust] 路径不存在: ${exePath}`, "WARN");
				bridge._setStartError(`exe_not_found_real: ${exePath}`);
				resolve(false);
				return;
			}
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
# --- Optimized PowerShell Daemon ---
# 确保所有输出使用UTF-8编码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

# 基础组件加载（较快）
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
             # 确保 C# Helper 已加载（IconHelper 和 ClipboardHelper 在同一个代码块中）
             Ensure-ClipboardHelper
             # 优先尝试 C# 高质量提取
             # 确保路径使用正确的Unicode编码
             $iconB64 = [IconHelper]::GetIconBase64($cmd.path)
             if ($iconB64) {
                 $result.icon = $iconB64
                 $result.status = 'ok'
             } else {
                 throw "C# extraction failed"
             }
         } catch {
             # 回退：纯 PowerShell 原生方案 (虽然只能拿文件关联图标)
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
          # 路径归一化：Windows COM 喜欢反斜杠且不喜欢结尾斜杠
          $rawPath = $cmd.path -replace '/', '\'
          $cleanPath = $rawPath.TrimEnd('\')
          $shell = New-Object -ComObject Shell.Application
          $folder = $shell.NameSpace($cleanPath)
          if ($folder) {
            # 尝试多种可能的 Verb 形式以增强兼容性
            $verbFound = $false
            foreach ($v in @("Paste", "paste", "&Paste")) {
              $item = $folder.Self.Verbs() | Where-Object { $_.Name -eq $v -or $_.Name.Replace("&","") -eq $v }
              if ($item) {
                $item.DoIt()
                $verbFound = $true
                break
              }
            }
            if (-not $verbFound) {
              # 终极保底：直接 Invoke
              $folder.Self.InvokeVerb("Paste")
            }
            $result.success = $true
          } else {
            $result.success = $false
            $result.error = "Folder not found: " + $cleanPath
          }
        } catch {
          $result.success = $false
          $result.error = "PowerShell Trigger Error: " + $_.Exception.Message
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

# 使用UTF-8编码读取输入
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
      # simplified single file for now as array handling in bash+osascript is tricky
      # but it's a fallback anyway
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
      # Linux: 尝试使用 python3 + gi (Gio/GdkPixbuf) 提取图标
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
    # 尝试查找图标
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

// ============================================================================
// ★ Linux 依赖检测与安装引导
// ============================================================================
let _linuxDepsChecked = false;

/**
 * 检测 Linux 上是否安装了 xclip
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
 * 检测 Linux 包管理器类型
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
 * 获取安装 xclip 的命令
 * @param {string} pkgMgr - 包管理器名称
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
 * 在 VS Code 终端中执行安装命令
 * @param {string} command - 要执行的命令
 * @param {string} title - 终端标题
 * @returns {Promise<void>}
 */
async function runInTerminal(command, title) {
	const terminal = vscode.window.createTerminal({
		name: title,
		shellPath: '/bin/bash',
		shellArgs: ['-c', `${command}; echo ''; echo '按任意键关闭此终端...'; read -n 1`]
	});
	terminal.show();
	return terminal;
}

/**
 * 检测并引导安装 Linux 依赖 (xclip)
 * 只在首次启动时检测一次，避免频繁打扰用户
 */
async function checkAndInstallLinuxDeps() {
	// 仅 Linux 平台检测
	if (process.platform !== 'linux') return;

	// 避免重复检测
	if (_linuxDepsChecked) return;
	_linuxDepsChecked = true;

	// 检查是否已经提示过（用户选择了"不再提示"）
	const suppressKey = 'xclipInstallSuppressed';
	if (extensionContext) {
		const suppressed = extensionContext.globalState.get(suppressKey);
		if (suppressed) return;
	}

	// 检测 xclip 是否已安装
	const hasXclip = await checkXclipInstalled();
	if (hasXclip) {
		logMessage('Linux 依赖检测: xclip 已安装', 'INFO');
		return;
	}

	logMessage('Linux 依赖检测: xclip 未安装，准备提示用户', 'INFO');

	// 检测包管理器
	const pkgMgr = await detectLinuxPackageManager();
	const installCmd = getXclipInstallCommand(pkgMgr);

	// 弹窗询问用户
	const choice = await vscode.window.showWarningMessage(
		'qqq: 剪贴板功能需要 xclip，是否立即安装？',
		{ modal: false },
		'立即安装',
		'复制命令',
		'不再提示'
	);

	if (choice === '立即安装') {
		logMessage(`正在安装 xclip，使用命令: ${installCmd}`, 'INFO');

		// 在终端中执行安装命令
		const terminal = await runInTerminal(installCmd, 'qqq: 安装 xclip');

		// 监听终端关闭，检测是否安装成功
		const disposable = vscode.window.onDidCloseTerminal(async (closedTerminal) => {
			if (closedTerminal === terminal) {
				disposable.dispose();

				// 等待一下让系统刷新
				await new Promise(r => setTimeout(r, 500));

				// 重新检测
				const nowHasXclip = await checkXclipInstalled();
				if (nowHasXclip) {
					vscode.window.showInformationMessage('qqq: xclip 安装成功！剪贴板功能现已可用。');
					logMessage('xclip 安装成功', 'INFO');
				} else {
					vscode.window.showWarningMessage('qqq: xclip 安装可能未成功，请检查终端输出或手动安装。');
					logMessage('xclip 安装可能失败', 'WARN');
				}
			}
		});

	} else if (choice === '复制命令') {
		await vscode.env.clipboard.writeText(installCmd);
		vscode.window.showInformationMessage(`qqq: 安装命令已复制到剪贴板: ${installCmd}`);
		logMessage(`用户选择复制安装命令: ${installCmd}`, 'INFO');

	} else if (choice === '不再提示') {
		if (extensionContext) {
			await extensionContext.globalState.update(suppressKey, true);
		}
		logMessage('用户选择不再提示 xclip 安装', 'INFO');
	}
}

/**
 * ★ 幽灵进程肃清协议 (Ghost Process Purgatory)
 * 在插件启动初始化时执行，确保环境中没有旧版本的守护进程残留。
 */
async function cleanupGhostDaemons() {
	const isWin = process.platform === "win32";

	// 1. 定义清理目标 (Rust 引擎所有可能的平台二进制名)
	const rustBins = [
		"q_engine_win_x64.exe", "q_engine_win_arm64.exe",
		"q_engine_linux_x64", "q_engine_linux_arm64",
		"q_engine_mac_x64", "q_engine_mac_arm64"
	];

	try {
		if (isWin) {
			// Windows: 使用 PowerShell 精准匹配命令行中的 kp.py，避免误杀用户其他 Python 任务
			const pyKill = `Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'python3.exe'" | Where-Object { $_.CommandLine -like '*kp.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
			try { cp.execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${pyKill}"`, { stdio: 'ignore' }); } catch (e) { }

			// 清理 Rust 引擎残留
			for (const bin of rustBins) {
				if (bin.endsWith(".exe")) {
					try { cp.execSync(`taskkill /F /IM "${bin}" /T`, { stdio: 'ignore' }); } catch (e) { }
				}
			}
		} else {
			// Linux/macOS: 使用 pkill -f 匹配全路径/全命令行
			try { cp.execSync(`pkill -9 -f "kp.py"`, { stdio: 'ignore' }); } catch (e) { }
			try { cp.execSync(`pkill -9 -f "q_engine_"`, { stdio: 'ignore' }); } catch (e) { }
		}
	} catch (e) { }
}

async function startDaemons() {
	// ★ 初始化首要任务：肃清所有“前世”残留的幽灵进程
	try { await cleanupGhostDaemons(); } catch (e) { }

	const bootSeq = ++_daemonBootSeq;

	// ★ 关键点：打印唯一版本标识，确保日志溯源准确
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
	logMessage(`开始启动守护进程，用户选择的引擎: ${pref} `, "INFO");

	const ensureStarted = async (bridge) => {
		if (bootSeq !== _daemonBootSeq) return false;
		try {
			if (bridge.isAvailable()) return true;

			logMessage(`启动 ${bridge.name} bridge...`, "INFO");
			const ok = await bridge.start();

			if (bootSeq !== _daemonBootSeq) return false;

			if (ok) {
				logMessage(`${bridge.name} Bridge OK`, "INFO");
			} else {
				logMessage(`${bridge.name} Bridge 启动失败：${bridge.lastStartError || "unknown"}`, "WARN");
			}
			return !!ok;
		} catch (e) {
			logMessage(`${bridge.name} Bridge 启动异常：${e?.message || e}`, "WARN");
			return false;
		} finally {
			updateStatusBarNow();
		}
	};

	(async () => {
		// ★ 终极最优解：启动前检查是否已停用
		if (_isDeactivated) return;

		// ★ 核心设计：三个引擎全部启动，全部待命
		// 不管用户选什么，能启动滨都启动起来
		// 切换引擎时只是改变“谁来响应”，不杀不重启
		const shellPromise = ensureStarted(shellBridge);
		const pythonPromise = ensureStarted(pythonBridge);
		const rustPromise = ensureStarted(rustBridge);

		// 并行等待所有引擎启动完成
		await Promise.all([shellPromise, pythonPromise, rustPromise]);

		if (bootSeq === _daemonBootSeq) {
			const anyAvailable = pythonBridge.isAvailable() || rustBridge.isAvailable() || shellBridge.isAvailable();
			if (!anyAvailable) {
				logMessage("All daemons failed, using spawn fallback", "WARN");
			}
			updateStatusBarNow();

			// ★ 检测 Linux 依赖（延迟执行，避免阻塞启动流程）
			setTimeout(() => {
				checkAndInstallLinuxDeps().catch(e => {
					logMessage(`Linux 依赖检测异常: ${e?.message || e}`, 'WARN');
				});
			}, 2000);
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
let ffmpegPath = null;
let ffprobePath = null;
let ffmpegSource = "NOT_FOUND";

// ★ 终极最优解：全局停用标志位
let _isDeactivated = false;

// ★ 终极最优解：全局进程追踪器
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
			// 兜底超时
			setTimeout(resolve, 1000);
		});
	});
	await Promise.all(killPromises);
}

// ★ 终极最优解：启动就绪信号灯
let _resolveReady;
const _readyPromise = new Promise(resolve => { _resolveReady = resolve; });

/**
 * 高阶函数：包装需要等待就绪的函数
 * 特别确保水印校验通过
 */
function withReady(fn) {
	return async (...args) => {
		await _readyPromise;
		return fn(...args);
	};
}

function init(context) {
	_isDeactivated = false; // 启动时重置
	extensionContext = context;

	// 初始化 FFmpeg 路径
	const isWin = process.platform === "win32";
	const ffName = isWin ? "ffmpeg.exe" : "ffmpeg";
	const extensionPath = context.extensionUri?.fsPath || context.extensionPath;
	const ffInAssets = path.join(extensionPath, "assets", ffName);

	if (fs.existsSync(ffInAssets)) {
		ffmpegPath = ffInAssets;
		ffmpegSource = "ASSETS (Verified)";
		logMessage(`Global FFmpeg initialized from assets: ${ffInAssets}`, "INFO");
		// 异步验证，不阻塞启动
		(async () => {
			try {
				const { spawn } = require('child_process');
				const cp = spawn(ffInAssets, ["-version"], { windowsHide: true });
				cp.on('error', (e) => {
					logMessage(`FFmpeg 验证失败 (Spawn Error): ${e.message}`, "WARN");
				});
			} catch (e) {
				logMessage(`FFmpeg 异步验证异常: ${e.message}`, "WARN");
			}
		})();
	} else {
		ffmpegSource = "NOT_FOUND";
		ffmpegPath = ffName; // 系统环境变量兜底
	}

	if (ffmpegPath) {
		ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"));
	}

	// 启动资产哨兵
	startAssetsSentinel(context);

	initUserTracking(context);

	// ★ 后台预热 ShellBridge，消除首次粘贴时的 C# 注入延迟
	setTimeout(() => {
		if (shellBridge && shellBridge.isAvailable()) {
			shellBridge.call("warmup", {}, 5000).then(res => {
				if (res?.status === 'warmed') {
					logMessage("ShellBridge 后台预热成功，C# 组件已就绪", "INFO");
				}
			}).catch(() => { });
		}
	}, 3000);
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

// ============================================================================
// ★ 统一任务消息模块（唯一真理源）
// 用于文件粘贴、视频下载等所有任务的进度/完成消息格式化和显示
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
	 * 显示自动关闭的完成弹窗（可带按钮）
	 * @param {string} message - 消息内容
	 * @param {Object} options - 选项
	 * @param {string[]} options.buttons - 按钮文本数组
	 * @param {number} options.timeout - 自动关闭时间（毫秒），默认 15000
	 * @param {Function} options.onButton - 按钮点击回调 (buttonText) => {}
	 * @returns {Promise<string|undefined>} 用户点击的按钮文本，或 undefined（超时/无操作）
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
	 * 显示简单的自动关闭消息（无按钮）
	 * @param {string} message - 消息内容
	 * @param {number} timeout - 自动关闭时间（毫秒），默认 15000
	 * @param {'success'|'cancel'|'error'|'info'} type - 消息类型，用于显示不同的 emoji 图标
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
// ★ 对话框包装 (qqq 涉及的对话框)
// ============================================================================
function showInformationMessage(message, ...items) {
	return vscode.window.showInformationMessage(message, ...items);
}

/**
 * ★ 显示一个会自动关闭的通知消息
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
	if (!document) return Promise.resolve(undefined);
	try {
		return vscode.window.showTextDocument(document, column, preserveFocus);
	} catch (e) {
		logMessage(`showTextDocument 失败: ${e.message}`, "ERROR");
		return Promise.resolve(undefined);
	}
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
const KEY_LAST_FLUSH_TIME = "qqq_stats_last_flush"; // ★ 上次持久化时的时间戳
const KEY_CACHE_HIT_TOTAL = "qqq_stats_cache_hit_total";
const KEY_CACHE_MISS_TOTAL = "qqq_stats_cache_miss_total";

// ★ 定期持久化定时器
let _durationFlushTimer = null;
const DURATION_FLUSH_INTERVAL = 60 * 1000; // 每60秒自动持久化一次

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
	"downloadSecurityLevel": "1: 平衡",
	"enhancedHtmlPasteCompatibility": false,
	"docExportImageResolution": "原始分辨率",
	"docExportIncludeCipher": true,
	"transactionLevel": "full",
	"textSlideColorScheme": "light",
	"textSlideFontSize": 14
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
	},
	"textSlideColorScheme": {
		name: "文本胶片底色", type: "enum",
		options: ["light", "dark"],
		descriptions: ["白底黑字", "黑巧克力底白字"]
	},
	"textSlideFontSize": {
		name: "文本胶片字体大小", type: "number"
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

// ★ 修复 Crash：添加缺失的 Getter 定义
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
	// ★ 恢复上次异常退出未保存的会话时间
	const lastSessionStart = context.globalState.get(KEY_SESSION_START);
	const lastFlushTime = context.globalState.get(KEY_LAST_FLUSH_TIME);

	if (lastSessionStart && lastFlushTime && lastFlushTime > lastSessionStart) {
		// 上次会话异常退出，恢复 lastFlushTime 到 现在 之间没有记录的时间
		// 但只恢复到 lastFlushTime 为止（那之后的时间无法确定用户是否在使用）
		const unrecordedSeconds = (lastFlushTime - lastSessionStart) / 1000;
		const oldTotal = context.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
		// 检查是否已经累加过（避免重复累加）
		const alreadyAdded = context.globalState.get("qqq_stats_pending_recovered");
		if (!alreadyAdded && unrecordedSeconds > 0) {
			context.globalState.update(KEY_TOTAL_DURATION, oldTotal + unrecordedSeconds);
			logMessage(`[UserTracking] 恢复上次未保存的会话时间: ${unrecordedSeconds.toFixed(0)}秒`, "INFO");
		}
	} else if (lastSessionStart && !lastFlushTime) {
		// 旧版本没有 lastFlushTime，按旧逻辑处理
		const now = Date.now();
		// 如果上次会话开始时间在合理范围内（比如48小时内），尝试恢复
		const diffMs = now - lastSessionStart;
		if (diffMs > 0 && diffMs < 48 * 60 * 60 * 1000) {
			// 保守估计：假设用户使用了一半时间
			// 但为了精确，我们不做任何假设，只记录日志
			logMessage(`[UserTracking] 检测到上次会话未正常关闭，开始时间: ${new Date(lastSessionStart).toISOString()}`, "WARN");
		}
	}

	// ★ 清除恢复标记并设置新的会话开始时间
	context.globalState.update("qqq_stats_pending_recovered", undefined);
	context.globalState.update(KEY_SESSION_START, Date.now());
	context.globalState.update(KEY_LAST_FLUSH_TIME, Date.now());

	_loadPersistentStats(context);

	// ★ 启动定期持久化定时器
	_startDurationFlushTimer();
}

// ★ 定期持久化累计时间（防止异常退出丢失数据）
function _flushDurationToStorage() {
	if (!extensionContext) return;

	const start = extensionContext.globalState.get(KEY_SESSION_START);
	const lastFlush = extensionContext.globalState.get(KEY_LAST_FLUSH_TIME) || start;
	const now = Date.now();

	if (start && lastFlush) {
		// 计算自上次 flush 以来的增量时间
		const incrementSeconds = (now - lastFlush) / 1000;
		if (incrementSeconds > 0) {
			const oldTotal = extensionContext.globalState.get(KEY_TOTAL_DURATION, 0) || 0;
			extensionContext.globalState.update(KEY_TOTAL_DURATION, oldTotal + incrementSeconds);
			extensionContext.globalState.update(KEY_LAST_FLUSH_TIME, now);
		}
	}
}

function _startDurationFlushTimer() {
	if (_durationFlushTimer) return;

	_durationFlushTimer = setInterval(() => {
		try {
			_flushDurationToStorage();
		} catch (e) {
			logMessage(`[UserTracking] 定期持久化失败: ${e.message}`, "WARN");
		}
	}, DURATION_FLUSH_INTERVAL);
}

function _stopDurationFlushTimer() {
	if (_durationFlushTimer) {
		clearInterval(_durationFlushTimer);
		_durationFlushTimer = null;
	}
}

function finishUserTracking() {
	if (!extensionContext) return;

	// ★ 停止定时器
	_stopDurationFlushTimer();

	// ★ 最后一次持久化
	_flushDurationToStorage();

	// ★ 清除会话标记（表示正常退出）
	extensionContext.globalState.update(KEY_SESSION_START, undefined);
	extensionContext.globalState.update(KEY_LAST_FLUSH_TIME, undefined);

	// 强制刷新缓存统计
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
	const lastFlush = extensionContext.globalState.get(KEY_LAST_FLUSH_TIME);

	// ★ 计算自上次 flush 以来的未持久化时间
	if (!lastFlush) return base;
	const diff = (Date.now() - lastFlush) / 1000;
	return base + (diff > 0 ? diff : 0);
}

// ============================================================================
// ★ 状态栏管理
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

// ==================== 路径工具函数 ====================

// ★ 统一的路径规范化函数（盘符大写 + 去尾部斜杠 + 移除 UNC 前缀）
function canonicalizeExistingPath(p) {
	if (!p) return "";
	let out = path.normalize(p);

	if (process.platform === "win32") {
		out = out.replace(/^\\\\\?\\/, "");
		out = out.replace(/^[a-z]:/i, (m) => m.toUpperCase());
	}

	// 去除尾部斜杠（保留根目录如 C:\ 或 /）
	try {
		const root = path.parse(out).root;
		if (out.length > root.length) out = out.replace(/[\\\/]+$/, "");
	} catch { }

	return out;
}

// ★ 统一的缓存键生成函数（Windows 下不区分大小写）
function cacheKeyForPath(p) {
	const canon = canonicalizeExistingPath(p);
	return process.platform === "win32" ? canon.toLowerCase() : canon;
}

// ★ 统一的字节格式化函数，decimals 控制小数位数（默认 1 位）
function formatBytes(size, decimals = 1) {
	if (size == null || isNaN(size)) return "?";
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
		// 统一映射：配置里的 "node" 对应内部逻辑的 "shell" (Shell Daemon)
		if (v === "node") return "shell";
		return v;
	} catch {
		return "auto";
	}
}

// ============================================================================
// ★ Transaction Manager (基于 globalState 的强一致性管理)
// ============================================================================
const KEY_TRANSACTIONS = "qqq.transactions";

/**
 * 异步获取目录快照：记录目录中所有已存在的文件和文件夹的完整路径
 * @param {string} targetDir - 目标目录
 * @returns {Promise<string[]>} - 文件和文件夹的完整路径数组（已规范化）
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
		let list = this.getTransactions();

		// ★ 终极最优解：完美白名单字段清洗 (防止 1.8MB 爆炸)
		const cleanTrans = {
			id: trans.id,
			targetDir: trans.targetDir,
			// 使用 toString() 替代 fsPath，确保 100% 兼容所有协议
			targetUri: typeof trans.targetUri === 'string' ? trans.targetUri : trans.targetUri?.toString(),
			docUri: typeof trans.docUri === 'string' ? trans.docUri : trans.docUri?.toString(),
			tempFiles: Array.isArray(trans.tempFiles) ? trans.tempFiles : [],
			status: 'pending',
			createdAt: trans.createdAt || Date.now(),
			taskType: trans.taskType || 'unknown',
			// 预留元数据空间 (仅限简单类型)
			extra: trans.extra || {}
		};

		list.push(cleanTrans);

		// ★ 终极最优解：200/100 优先级截断逻辑
		if (list.length > 200) {
			const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
			const now = Date.now();

			// 定义清理权重：已结案(success/cancelled) 权重最高，超期(>60天) 权重次之
			const getWeight = (t) => {
				let weight = 0;
				if (t.status === 'success' || t.status === 'cancelled') weight += 2;
				if (now - (t.createdAt || 0) > SIXTY_DAYS) weight += 1;
				return weight;
			};

			// 按权重从大到小排序，权重相同按时间从老到新排序
			const sortedForDeletion = [...list].sort((a, b) => {
				const wA = getWeight(a);
				const wB = getWeight(b);
				if (wA !== wB) return wB - wA; // 权重大的在前
				return (a.createdAt || 0) - (b.createdAt || 0); // 时间老的在前
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

	async removeTransaction(id) {
		if (!extensionContext) return;
		let list = this.getTransactions();
		list = list.filter(t => t.id !== id);
		await extensionContext.globalState.update(KEY_TRANSACTIONS, list);
	},

	async rollback(transOrId, options = {}) {
		// ★ 始终从 globalState 获取最新的事务数据（避免使用过时的快照）
		const transId = typeof transOrId === 'string' ? transOrId : transOrId?.id;
		if (!transId) {
			logMessage(`[Rollback] 无效的事务ID`, "WARN");
			return;
		}

		// 从 globalState 重新获取最新数据
		const trans = this.getTransactions().find(t => t.id === transId);
		if (!trans) {
			logMessage(`[Rollback] 未找到事务: ${transId}`, "WARN");
			return;
		}

		logMessage(`[Rollback] 正在回滚任务: ${trans.id}`, "WARN");

		// 0. ★ 删除残留锚点（零代价零风险：只删除特定格式的锚点字符串）
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

		logMessage(`[Rollback] 回滚完成`, "INFO");
		await this.removeTransaction(trans.id);

		// ★ 后台清理（不阻塞弹窗和用户交互）
		if (trans.targetDir) {
			setTimeout(() => {
				// 1. 清理 .part/.ytdl 临时文件 (传入 trans 以便清理预注册的 tempFiles)
				this._cleanupTempFiles(trans.targetDir, trans).catch(e => {
					logMessage(`[临时文件清理] 失败: ${e.message}`, "WARN");
				});
			}, 100);

			// ★ 根据任务类型决定兜底清理时机
			const taskType = trans.taskType || '';

			if (taskType === 'video') {
				// ★ video 类型：跳过此处清理，由 VideoDownloadController 在 killAll 后立即执行
				// （因为需要先杀死 yt-dlp 进程才能删除文件）
				logMessage(`[兜底清理] video 类型任务，等待 killAll 后执行`, "INFO");
			} else if (taskType === 'html') {
				// ★ html 类型：无长进程，1秒后立即执行清理
				setTimeout(() => {
					this._cleanupOrphanFiles(trans.targetDir).catch(e => {
						logMessage(`[兜底清理] 失败: ${e.message}`, "WARN");
					});
				}, 1000);
			} else {
				// ★ 其他类型（local_file 等）：11秒后执行 pure 兜底
				setTimeout(() => {
					this._cleanupOrphanFiles(trans.targetDir).catch(e => {
						logMessage(`[兜底清理] 失败: ${e.message}`, "WARN");
					});
				}, 11000);
			}
		}

		// ★ 返回 trans 便于调用方获取 targetDir
		return trans;
	},

	/**
	 * ★ 后台清理临时文件（.part/.ytdl 等，以及事务预注册的 tempFiles）
	 * @param {string} targetDir
	 * @param {object} trans - 可选的事务对象，包含显式的 tempFiles 列表
	 */
	async _cleanupTempFiles(targetDir, trans = null) {
		if (!targetDir || !fs.existsSync(targetDir)) return;

		const tempExts = ['.part', '.ytdl', '.tmp', '.download'];
		const now = Date.now();
		const FIVE_MINUTES = 5 * 60 * 1000;

		// 收集需要清理的文件
		const filesToDelete = new Set();

		// 1. 扫描目录下的临时后缀文件
		try {
			const files = fs.readdirSync(targetDir);
			for (const f of files) {
				const ext = path.extname(f).toLowerCase();
				if (tempExts.includes(ext) || /\.f\d+\.(mp4|m4a|webm|mkv|mp3|opus|aac)(\.part)?$/i.test(f)) {
					filesToDelete.add(path.normalize(path.join(targetDir, f)));
				}
			}
		} catch { }

		// 2. 加上事务显式记录的 tempFiles
		if (trans && Array.isArray(trans.tempFiles)) {
			trans.tempFiles.forEach(f => {
				if (f && typeof f === 'string') filesToDelete.add(path.normalize(f));
			});
		}

		if (filesToDelete.size === 0) return;

		// ★ 关键修复：在删除任何文件之前，先获取全量引用“白名单”
		// 这样即便文件在 tempFiles 中，只要有文档正在引用它，就绝不删除
		const referencedItems = this._getReferencedItemsSync(targetDir);

		// 3. 执行删除
		for (const fullPath of filesToDelete) {
			try {
				const fileName = path.basename(fullPath).toLowerCase();
				// ★ 引用保护：如果在白名单中，跳过
				if (referencedItems.has(fileName)) {
					continue;
				}

				if (!fs.existsSync(fullPath)) continue;
				const stat = fs.statSync(fullPath);
				if (!stat.isFile()) continue;

				// ★ 只删除创建时间 < 5分钟的 (放松到 6分钟，容忍误差)
				const birthtime = stat.birthtimeMs || stat.mtimeMs || 0;
				if (!birthtime || isNaN(birthtime)) continue;
				const age = now - birthtime;
				if (age > 6 * 60 * 1000) continue; // 允许 age 为负数（系统时钟微差）

				// ★ 带重试逻辑
				let deleted = false;
				for (let retry = 0; retry < 5 && !deleted; retry++) {
					try {
						fs.unlinkSync(fullPath);
						logMessage(`[临时文件清理] 删除: ${path.basename(fullPath)}`, "INFO");
						deleted = true;
					} catch (e) {
						if ((e.code === 'EBUSY' || e.code === 'EPERM') && retry < 4) {
							await new Promise(r => setTimeout(r, 500 * (retry + 1)));
						} else { break; }
					}
				}
			} catch { }
		}
	},

	/**
	 * ★ 同步/快速获取当前目录下的所有引用（用于清理前的白名单检查）
	 * 包含：内存文档、磁盘文档、活跃事务
	 */
	_getReferencedItemsSync(targetDir) {
		const referencedItems = new Set();
		try {
			const parentDir = path.dirname(targetDir);
			if (!parentDir || !fs.existsSync(parentDir)) return referencedItems;

			// 1. 扫描当前打开的所有文档（内存保护）
			vscode.workspace.textDocuments.forEach(doc => {
				try {
					const docDir = path.dirname(doc.uri.fsPath);
					if (path.normalize(docDir).toLowerCase() === path.normalize(parentDir).toLowerCase()) {
						this._extractReferences(doc.getText(), referencedItems);
					}
				} catch { }
			});

			// 2. 扫描磁盘上的文件（仅限文本文件）
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
					if (!stat.isFile() || stat.size > 30 * 1024 * 1024) continue; // 缩小范围提高速度

					const content = fs.readFileSync(fullPath, "utf-8");
					this._extractReferences(content, referencedItems);
				} catch { }
			}

			// 3. 扫描所有活跃事务（保护正在下载的文件）
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
			logMessage(`[引用扫描] 失败: ${e.message}`, "WARN");
		}
		return referencedItems;
	},

	/**
	 * ★ 终极兖底：清理 qqq 文件夹中创建时间 < 5分钟的孤儿文件和文件夹
	 * @param {string} targetDir - qqq 文件夹路径
	 */
	async _cleanupOrphanFiles(targetDir) {
		// ★ 整个函数包在 try-catch 中，防止任何异常导致扩展崩溃
		try {
			if (!targetDir || typeof targetDir !== 'string') return;
			if (!fs.existsSync(targetDir)) return;

			// ★ 使用统一的引用扫描逻辑 (内存 + 磁盘 + 事务)
			const referencedItems = this._getReferencedItemsSync(targetDir);

			// ★ 获取 qqq 文件夹中的所有文件和文件夹（一视同仁）
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

			// ★ 找出孤儿（文件和文件夹一视同仁）
			const orphans = qqqItems.filter(item => !referencedItems.has(item.name.toLowerCase()));
			if (!orphans.length) return;

			// ★ 删除创建时间 < 5分钟的孤儿文件/文件夹
			const now = Date.now();
			const FIVE_MINUTES = 5 * 60 * 1000;
			let cleanedCount = 0;

			for (const orphan of orphans) {
				try {
					const fullPath = path.join(targetDir, orphan.name);
					const stat = fs.statSync(fullPath);
					// ★ 确保 birthtimeMs 有效
					const birthtime = stat.birthtimeMs || stat.mtimeMs || 0;
					if (!birthtime || isNaN(birthtime)) continue;

					const age = now - birthtime;
					// ★ 放宽限制：允许 age < 0 (系统时钟微调)，且扩展到 6分钟
					if (age < 6 * 60 * 1000) {
						if (orphan.isDir) {
							// ★ 文件夹：使用 rmSync 递归删除
							fs.rmSync(fullPath, { recursive: true, force: true });
							logMessage(`[兖底清理] 删除孤儿文件夹: ${orphan.name} (创建 ${Math.round(age / 1000)}秒前)`, "INFO");
						} else {
							// ★ 文件：带重试逻辑的 unlink
							let deleted = false;
							for (let retry = 0; retry < 3 && !deleted; retry++) {
								try {
									fs.unlinkSync(fullPath);
									logMessage(`[兖底清理] 删除孤儿文件: ${orphan.name} (创建 ${Math.round(age / 1000)}秒前)`, "INFO");
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
				logMessage(`[兖底清理] 完成，共删除 ${cleanedCount} 个孤儿项目`, "INFO");
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
			// 简单的判断：只要是残留的，就清理。因为 recover 只在启动时调用。
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

	/**
	 * ★ 辅助函数：从内容中提取所有引用的 qqq 文件名
	 * 改进的正则：支持包含空格和特殊字符的文件名，直到遇到常见的结束符
	 */
	_extractReferences(content, set) {
		if (!content) return;
		// 改进后的正则：
		// 1. 匹配 qqq/ 或 qqq\
		// 2. 匹配后续字符，直到遇到引号、尖括号、方括号、圆括号、换行符 或 我们特有的 \/ 结束符
		const regex = /qqq[\\/]([^"'<>\[\]\(\)\r\n]+?)(?=[\\"']|[\r\n]|\\\/|\s*[\)\}\]]|$)/gi;
		let match;
		regex.lastIndex = 0;
		while ((match = regex.exec(content))) {
			let name = (match[1] || "").trim();
			// 如果文件名末尾有反斜杠（可能是我们的 /\\...\\/ 格式），去掉它
			if (name.endsWith('\\')) name = name.slice(0, -1).trim();
			if (name) set.add(name.toLowerCase());
		}
	},

	async insertAnchor(editor, transId) {
		try {
			// 检查编辑器是否仍然有效
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
// ★ 任务计数器系统（每个文件路径维护一个永久递增的任务计数 q）
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
	 * 递增并返回新的任务计数（永不重置，按文件分别计数）
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
			// 只保留最右边的22个字符
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
		// ★ 17个图形固定顺序循环（跨文件全局队列）
		// 规则：形状交替（心形 vs 非心形），颜色交替，避免视觉重复
		const ICONS = [
			'❤️', '⬛', '💚', '⭐', '💜', '🔵',
			'💙', '🌸', '🤎', '⬜', '💛', '🔷',
			'🖤', '🍄', '🤍', '🌺', '🔶'
		];
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
	let wqExecutionTime = 0;

	// 1. 尝试使用 Daemon Bridge (高性能)
	if (shellBridge && shellBridge.isAvailable()) {
		try {
			const startTime = Date.now(); // 只在核心操作前开始计时
			const res = await shellBridge.call("wq", {}, 3000);
			wqExecutionTime = Date.now() - startTime; // 只测量核心操作时间

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
	} else {
		// 2. 备选方案 (VS Code API)
		const startTime = Date.now(); // 只在核心操作前开始计时
		const text = await vscode.env.clipboard.readText();
		wqExecutionTime = Date.now() - startTime; // 只测量核心操作时间
		if (text) status.hasText = true;
	}

	// --- 核心分类逻辑 ---
	const baseResult = { rawStatus: status, files, totalSize };

	// A. 白名单识别 (1.纯文本 2.纯文字HTML)
	if (status.hasText && !status.hasFile && !status.hasImage && !status.hasHtml) {
		// 保存统计数据
		saveWqStats(wqExecutionTime);
		return { type: 'whitelist', subType: 'text', ...baseResult };
	}

	if (status.hasHtml && !status.hasImage && !status.hasFile) {
		try {
			const hModule = require('./h');
			const res = await hModule._getSmartHtmlFromClipboard();
			if (res && res.$) {
				const $ = res.$;
				const hasImg = $('img, video, iframe, embed, object').length > 0;
				if (!hasImg) {
					// 保存统计数据
					saveWqStats(wqExecutionTime);
					return { type: 'whitelist', subType: 'html_text', ...baseResult };
				}
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

	// 保存统计数据
	saveWqStats(wqExecutionTime);

	return { type: 'yellowlist', subType, ...baseResult };
}

// 保存wq统计数据的辅助函数
function saveWqStats(wqExecutionTime) {
	// 异常值过滤：只统计1ms到1000ms之间的时间
	if (wqExecutionTime >= 1 && wqExecutionTime <= 1000) {
		// 持久化统计到globalState
		if (extensionContext) {
			const wqStats = extensionContext.globalState.get("qqq_wq_stats", {
				totalTime: 0,
				count: 0,
				recentTimes: [],
				maxTime: 0
			});

			// 更新统计数据
			wqStats.totalTime += wqExecutionTime;
			wqStats.count += 1;

			// 更新最近7次时间（使用环形缓冲区）
			wqStats.recentTimes.push(wqExecutionTime);
			if (wqStats.recentTimes.length > 7) {
				wqStats.recentTimes.shift();
			}

			// 更新最大时间
			if (wqExecutionTime > wqStats.maxTime) {
				wqStats.maxTime = wqExecutionTime;
			}

			// 保存到globalState
			extensionContext.globalState.update("qqq_wq_stats", wqStats);
			// 触发状态栏更新
			if (typeof updateStatusBarNow === 'function') {
				updateStatusBarNow();
			}
		}
	}
}

// 保存粘贴统计数据的辅助函数
function savePasteStats(sizeInBytes) {
	if (extensionContext) {
		const stats = extensionContext.globalState.get("qqq_paste_stats", {
			count: 0,
			totalSize: 0,
			firstUse: Date.now()
		});

		stats.count += 1;
		stats.totalSize += (sizeInBytes || 0);

		// 如果是首次使用且未设置，初始化时间（兼容旧数据）
		if (!stats.firstUse) stats.firstUse = Date.now();

		extensionContext.globalState.update("qqq_paste_stats", stats);

		// 触发侧边栏更新（如果有 Webview 正在监听）
		if (typeof updateStatusBarNow === 'function') {
			updateStatusBarNow();
		}
	}
}

// 保存视频下载统计数据的辅助函数
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
	// ★ 核心真理：定义不同偏好下的回退顺序
	// 最后的 "spawn" 是隐式保底，通常由调用方处理，但这里列出以明确逻辑
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

// ★★★ 引擎调度优化：缓存有效引擎顺序 ★★★
let _cachedEffectiveOrder = null;
let _cachedPref = null;

function getEffectiveEngineOrder() {
	const pref = getEnginePreference();

	// 偏好变化时重新计算
	if (_cachedPref !== pref) {
		_cachedEffectiveOrder = null;
		_cachedPref = pref;
	}

	// 已有缓存且有效
	if (_cachedEffectiveOrder && _cachedEffectiveOrder.length > 0) {
		return _cachedEffectiveOrder;
	}

	// 重新计算：只保留可用引擎
	const fullOrder = getEngineTryOrder(pref);
	const bridges = { "python": pythonBridge, "rust": rustBridge, "shell": shellBridge };

	_cachedEffectiveOrder = fullOrder.filter(name => {
		if (name === "spawn") return false; // spawn 由调用方单独处理
		const bridge = bridges[name];
		return bridge && bridge.isAvailable();
	});

	return _cachedEffectiveOrder;
}

// ★ 引擎状态变化时清除缓存
function invalidateEngineCache() {
	_cachedEffectiveOrder = null;
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
		else if (!pythonBridge.isAvailable()) reasons.unshift(`Python：启动失败 / 不可用`); // 只有当真的不可用时才报

		// Rust 只有在真的被尝试过且失败时才报
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

// ★ 已记录不可用状态的引擎（避免重复打印日志）
const _loggedUnavailableEngines = new Set();

async function tryOneByOne(callback) {
	// ★★★ 优化：使用缓存的有效引擎顺序，避免每次都检查不可用引擎 ★★★
	const effectiveOrder = getEffectiveEngineOrder();
	const bridges = { "python": pythonBridge, "rust": rustBridge, "shell": shellBridge };

	// ★ 快速路径：有缓存的有效引擎，直接遍历
	if (effectiveOrder.length > 0) {
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

	// ★ 慢速路径：没有缓存时，走完整逻辑（并更新缓存）
	const pref = getEnginePreference();
	const fullOrder = getEngineTryOrder(pref);

	for (const name of fullOrder) {
		if (name === "spawn") continue;
		const bridge = bridges[name];
		if (bridge && bridge.isAvailable()) {
			_loggedUnavailableEngines.delete(name);
			try {
				const res = await callback(bridge, name);
				if (res) return res;
			} catch (e) {
				logMessage(`Engine ${name} execution error: ${e.message}`, "WARN");
			}
		} else if (bridge) {
			if (!_loggedUnavailableEngines.has(name)) {
				const reason = bridge.lastStartError || bridge.lastCrashReason || "not_started";
				logMessage(`Engine ${name} is unavailable (${reason}), skipping...`, "DEBUG");
				_loggedUnavailableEngines.add(name);
			}
		}
	}
	return null;
}

/**
 * 触发系统原生粘贴（与用户 IO 引擎偏好无关）
 * 链路：Node.js Shell (PowerShell) → Python (win32com) 回退
 */
async function triggerSystemPaste(targetDir) {
	// 归一化路径：确保 Windows 下使用反斜杠，这对 Shell COM 对象至关重要
	const normalizedPath = process.platform === 'win32' ? targetDir.replace(/\//g, '\\') : targetDir;

	logMessage(`[Q2] 正在触发系统粘贴至: ${normalizedPath}`, "INFO");

	// 1. 首选：Node.js Shell Bridge (PowerShell daemon，延迟最低)
	if (shellBridge && shellBridge.isAvailable()) {
		try {
			const res = await shellBridge.call("trigger_system_paste", { path: normalizedPath }, 8000);
			if (res && res.success) {
				logMessage(`[Q2] 系统粘贴成功 (Shell)`, "INFO");
				return res;
			}
			logMessage(`[Q2] Shell 粘贴失败: ${res?.error || 'unknown'}, 尝试 Python 回退`, "WARN");
		} catch (e) {
			logMessage(`[Q2] Shell 调用异常: ${e.message}, 尝试 Python 回退`, "WARN");
		}
	}

	// 2. 回退：Python win32com (不依赖 PowerShell，企业环境保底)
	if (pythonBridge && pythonBridge.isAvailable()) {
		try {
			const res = await pythonBridge.call("trigger_system_paste", { path: normalizedPath }, 8000);
			if (res && res.success) {
				logMessage(`[Q2] 系统粘贴成功 (Python win32com)`, "INFO");
				return res;
			}
			logMessage(`[Q2] Python 粘贴失败: ${res?.error || 'unknown'}`, "WARN");
			return res;
		} catch (e) {
			logMessage(`[Q2] Python 调用异常: ${e.message}`, "WARN");
		}
	}

	logMessage(`[Q2] 系统粘贴失败：所有引擎不可用`, "ERROR");
	return { success: false, error: "所有引擎不可用" };
}

let _integrityCache = null;
const LARGE_WATERMARK_HASH = "dd931dba64fd02a5fd683dd83692bc04311e4bc8ce5df5b44d64491fa1536cc7";
const SMALL_WATERMARK_HASH = "7e2d52d43e5383b8638026552dc4b01e84012643415916ffe745d047541c3c67";

/**
 * 异步系统完整性校验（防阻塞启动）
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

		// ★ 熔断机制：如果发现被篡改，主动瘫痪核心引擎
		if (isValid === false) {
			logMessage("!!! 熔断保护：核心资产校验失败，引擎已锁定 !!!", "ERROR");
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
 * 资产哨兵逻辑已移至 q3.js 独立模块实现
 */
function startAssetsSentinel(context) {
	// 已迁移
}

// ==================== 共享常量与扩展名 ====================
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

// 包含所有预览不支持或不应作为文本读取的文件类型（q2 使用）
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

		// ★ 关键修复：支持函数式 Action 映射，用于 Node 侧逻辑直接注入
		if (typeof action === "function") {
			try {
				const res = await action(params);
				if (res && (res.success || !res.error)) return res;
				return null;
			} catch (e) {
				logMessage(`${name} 函数 Action 执行失败: ${e.message}`, "WARN");
				return null;
			}
		}

		const res = await bridge.call(action, params, timeout);
		// ★ 容错增强：只要有 success 标志或者没有 error 且不是 unknown，都视为成功
		if (res && (res.success === true || (res.success !== false && !res.error && res.type !== "unknown"))) return res;
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

	// 获取wq前摇时间统计
	let wqStats = { totalTime: 0, count: 0, recentTimes: [], maxTime: 0 };
	if (extensionContext) {
		wqStats = extensionContext.globalState.get("qqq_wq_stats", wqStats);
	}
	const averageTime = wqStats.count > 0 ? Math.round(wqStats.totalTime / wqStats.count) : 0;

	const pref = getEnginePreference();
	const active = getActiveEngineState(pythonBridge, rustBridge, shellBridge);

	const engineTag =
		active.code === "P"
			? "P"
			: active.code === "R"
				? "R"
				: `N(${active.nodeMode})`;


	if (active.code === "P" || active.code === "R") {

		statusBarItem.text = ` ▌ qqq${h}h     ${cacheMB.toFixed(0)}m     ${hitRate.toFixed(0)}%    ${engineTag}   ▌`;
	} else {

		statusBarItem.text = ` ▪  qqq${h}h     ${cacheMB.toFixed(0)}m     ${hitRate.toFixed(0)}%    ${engineTag} ▪ `;
	}

	const mismatchReasons = collectMismatchReasons(pref, active, pythonBridge, rustBridge, shellBridge);
	let mismatchText = "";
	if ((pref === "python" && active.code !== "P") || (pref === "rust" && active.code !== "R")) {
		const expectedName = pref === "python" ? "Python" : "Rust";
		const reasonStr = mismatchReasons.length ? mismatchReasons.join("；") : "未知原因";
		mismatchText = ` ▬ 期待值${expectedName}，启动失败原因：${reasonStr} `;
	}

	const ioLine = `${active.name}${mismatchText}`;

	// 格式化wq时间显示
	const recentTimesStr = wqStats.recentTimes.join(', ');
	const wqLine = `💪 **平均前摇：** ${averageTime} ms${wqStats.count > 0 ? `（ ${recentTimesStr}${wqStats.maxTime > 0 ? `...[最大${wqStats.maxTime}]` : ''}）` : ''}`;

	const tooltip = new vscode.MarkdownString(
		`⏱️ **陪伴时间：** ${formatHours(totalSeconds)}

💾 **磁盘缓存：** ${formatBytes(cacheBytes)}

🎯 **缓存命中：** ${hitRate.toFixed(2)}% (hit = ${pstats.hitTotal}, miss = ${pstats.missTotal})

${wqLine}

⚡ **IO 引擎：** ${ioLine}`
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
const iconScheduler = new TaskScheduler(4); // 用于图标获取的调度器
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

module.exports = {
	init,
	getIcon,

	// 调度器与队列
	TaskScheduler,
	TaskQueue,
	probeScheduler,
	genScheduler,
	iconScheduler,
	pasteQueue,
	metaSaveQueue,

	// 日志
	setLogPath,
	getLogPath,
	logMessage,
	logMessageRateLimited,
	bridgeStderrKey,

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

	// 状态栏相关
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
	triggerSystemPaste,
	getActiveEngineCode,
	getActiveEngineName,
	extensionPath: () => extensionContext?.extensionPath,
	ffmpegPath: () => ffmpegPath,
	ffprobePath: () => ffprobePath,

	// 格式化辅助 (给 CodeLens 等用)
	formatBytes,
	formatHours,

	// 路径工具函数
	canonicalizeExistingPath,
	cacheKeyForPath,

	// ★ 核心逻辑导出
	savePasteStats,
	saveVideoStats,
	wq,
	TransactionManager,
	TaskCounter,
	getDirectorySnapshot,  // ★ 目录快照函数

	// ★ 终极最优解：进程与状态管理接口
	trackProcess,
	killAllProcesses,
	isValid: () => _integrityCache !== false,
	verifySystemIntegrityAsync,
	markReady: () => {
		if (_resolveReady) {
			_resolveReady();
			_resolveReady = null; // 释放引用
		}
	},
	withReady,
	setDeactivated: (v) => { _isDeactivated = !!v; },
	isDeactivated: () => _isDeactivated,

	// 常量
	IMAGE_EXTS,
	VIDEO_EXTS,
	AUDIO_EXTS,
	DOCUMENT_EXTS,
	ARCHIVE_EXTS,
	NON_TEXT_EXTS
};

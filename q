[2026-02-17T08:28:07.257+08:00][INFO] Global FFmpeg initialized from assets: e:\s\wol\py\q3\assets\ffmpeg.exe
[2026-02-17T08:28:07.290+08:00][INFO] qqq 擴充功能啟用中...
[2026-02-17T08:28:07.302+08:00][INFO] Q2: 檔案管理器已啟用（使用 geq().js 四級回退 + size調度/快取 + 最新 IO 路徑邏輯）
[2026-02-17T08:28:07.303+08:00][INFO] qqq 擴充功能啟用完成
[2026-02-17T08:28:07.750+08:00][INFO] Integrity: PASSED
[2026-02-17T08:28:07.750+08:00][INFO] FFmpeg Path: e:\s\wol\py\q3\assets\ffmpeg.exe
[2026-02-17T08:28:07.750+08:00][INFO] Q2 Integrity: PASSED
[2026-02-17T08:28:08.765+08:00][DEBUG] [FolderScan] F:\qqq: 24ms, 1檔案, 211.8 MB (JS)
[2026-02-17T08:28:10.302+08:00][INFO] qqq 延遲初始化開始...
[2026-02-17T08:28:11.326+08:00][INFO] [PythonCheck] L1 不完美: no_interpreter
[2026-02-17T08:28:11.326+08:00][INFO] [PythonCheck] L1 不完美且不在冷卻期，20 秒後觸發 L4 下載流程
[2026-02-17T08:28:11.326+08:00][INFO] [Python] L1 不完美，等待背景下載完成後熱啟動
[2026-02-17T08:28:13.319+08:00][INFO] qqq startDaemons 開始 (6秒延遲)
[2026-02-17T08:28:13.321+08:00][INFO] ====================================================
[2026-02-17T08:28:13.321+08:00][INFO] 🚀 Q-ENGINE STARTING | VERSION: 15.73.18 | 2/17/2026, 8:28:13 AM
[2026-02-17T08:28:13.321+08:00][INFO] 🎯 ACTIVE FFmpeg: e:\s\wol\py\q3\assets\ffmpeg.exe (ASSETS (Verified))
[2026-02-17T08:28:13.321+08:00][INFO] ====================================================
[2026-02-17T08:28:13.321+08:00][INFO] 開始啟動守護進程，使用者選擇滴引擎: auto
[2026-02-17T08:28:13.321+08:00][INFO] 啟動 Shell bridge...
[2026-02-17T08:28:13.322+08:00][DEBUG] 嘗試啟動 PowerShell 進程
[2026-02-17T08:28:13.322+08:00][DEBUG] 嘗試使用選項 1 啟動 PowerShell: powershell.exe
[2026-02-17T08:28:13.325+08:00][DEBUG] PowerShell 進程已建立: powershell.exe
[2026-02-17T08:28:13.326+08:00][INFO] 啟動 Python bridge...
[2026-02-17T08:28:13.326+08:00][INFO] 啟動 Rust bridge...
[2026-02-17T08:28:13.327+08:00][WARN] Rust Bridge 可執行檔未找到
[2026-02-17T08:28:13.328+08:00][WARN] Rust Bridge 啟動失敗：exe_not_found: q_engine.exe
[2026-02-17T08:28:16.205+08:00][INFO] Shell bridge started and handshaked
[2026-02-17T08:28:16.205+08:00][INFO] Shell Bridge OK
[2026-02-17T08:28:18.614+08:00][INFO] qqq dow.js 預熱 (w10)
[2026-02-17T08:28:31.327+08:00][INFO] [PythonCheck] 開始 L4 下載安裝流程...
[2026-02-17T08:28:31.330+08:00][INFO] [Python] 平台=win32, 架構=x64, URL=https://www.python.org/ftp/python/3.8.10/python-3.8.10-embed-amd64.zip
[2026-02-17T08:28:31.330+08:00][INFO] [Python] 嘗試 淘宝NPM...
[2026-02-17T08:28:33.025+08:00][INFO] [Python] 淘宝NPM 下載成功
[2026-02-17T08:28:35.972+08:00][INFO] [Python] 安裝 pip...
[2026-02-17T08:29:01.013+08:00][ERROR] [Python] 安裝失敗: Command failed: "e:\s\d\qoder\f\a\User\globalStorage\gh555.qqq\python_engine\python.exe" "e:\s\d\qoder\f\a\User\globalStorage\gh555.qqq\python_engine\get-pip.py"
WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
WARNING: Retrying (Retry(total=3, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
WARNING: Retrying (Retry(total=2, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
WARNING: Retrying (Retry(total=1, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
WARNING: Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
ERROR: Could not find a version that satisfies the requirement pip<25.1 (from versions: none)
ERROR: No matching distribution found for pip<25.1

[2026-02-17T08:29:01.318+08:00][ERROR] [PythonCheck] L4 失敗: Command failed: "e:\s\d\qoder\f\a\User\globalStorage\gh555.qqq\python_engine\python.exe" "e:\s\d\qoder\f\a\User\globalStorage\gh555.qqq\python_engine\get-pip.py"
WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
WARNING: Retrying (Retry(total=3, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
WARNING: Retrying (Retry(total=2, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
WARNING: Retrying (Retry(total=1, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
WARNING: Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))': /pypi/simple/pip/
ERROR: Could not find a version that satisfies the requirement pip<25.1 (from versions: none)
ERROR: No matching distribution found for pip<25.1

[2026-02-17T08:29:01.319+08:00][INFO] [Python] L1 不完美，等待背景下載完成後熱啟動
[2026-02-17T08:29:01.319+08:00][WARN] Python Bridge 啟動失敗：unknown
[2026-02-17T08:30:41.827+08:00][INFO] Global FFmpeg initialized from assets: e:\s\wol\py\q3\assets\ffmpeg.exe
[2026-02-17T08:30:41.839+08:00][INFO] qqq 擴充功能啟用中...
[2026-02-17T08:30:41.845+08:00][INFO] Q2: 檔案管理器已啟用（使用 geq().js 四級回退 + size調度/快取 + 最新 IO 路徑邏輯）
[2026-02-17T08:30:41.845+08:00][INFO] qqq 擴充功能啟用完成
[2026-02-17T08:30:42.168+08:00][INFO] Integrity: PASSED
[2026-02-17T08:30:42.168+08:00][INFO] FFmpeg Path: e:\s\wol\py\q3\assets\ffmpeg.exe
[2026-02-17T08:30:42.169+08:00][INFO] Q2 Integrity: PASSED
[2026-02-17T08:30:43.337+08:00][DEBUG] [FolderScan] F:\qqq: 23ms, 1檔案, 211.8 MB (JS)
[2026-02-17T08:30:44.843+08:00][INFO] qqq 延遲初始化開始...
[2026-02-17T08:30:45.938+08:00][INFO] [PythonCheck] 自動複製 VC++ DLL: msvcp140.dll, msvcp140_1.dll, msvcp140_2.dll, concrt140.dll, vccorlib140.dll
[2026-02-17T08:30:46.109+08:00][INFO] [PythonCheck] L1 不完美: deps_missing, 缺失: miniaudio, pywin32
[2026-02-17T08:30:46.109+08:00][INFO] [PythonCheck] 在 72 小時冷卻期內 (剩餘 71h58m)，跳過下載
[2026-02-17T08:30:46.109+08:00][INFO] [Python] L1 不完美，等待背景下載完成後熱啟動
[2026-02-17T08:30:47.859+08:00][INFO] qqq startDaemons 開始 (6秒延遲)
[2026-02-17T08:30:47.861+08:00][INFO] ====================================================
[2026-02-17T08:30:47.861+08:00][INFO] 🚀 Q-ENGINE STARTING | VERSION: 15.73.18 | 2/17/2026, 8:30:47 AM
[2026-02-17T08:30:47.861+08:00][INFO] 🎯 ACTIVE FFmpeg: e:\s\wol\py\q3\assets\ffmpeg.exe (ASSETS (Verified))
[2026-02-17T08:30:47.861+08:00][INFO] ====================================================
[2026-02-17T08:30:47.861+08:00][INFO] 開始啟動守護進程，使用者選擇滴引擎: auto
[2026-02-17T08:30:47.862+08:00][INFO] 啟動 Shell bridge...
[2026-02-17T08:30:47.863+08:00][DEBUG] 嘗試啟動 PowerShell 進程
[2026-02-17T08:30:47.863+08:00][DEBUG] 嘗試使用選項 1 啟動 PowerShell: powershell.exe
[2026-02-17T08:30:47.868+08:00][DEBUG] PowerShell 進程已建立: powershell.exe
[2026-02-17T08:30:47.869+08:00][INFO] 啟動 Python bridge...
[2026-02-17T08:30:47.931+08:00][INFO] 啟動 Rust bridge...
[2026-02-17T08:30:47.932+08:00][WARN] Rust Bridge 可執行檔未找到
[2026-02-17T08:30:48.092+08:00][INFO] [PythonCheck] L1 不完美: deps_missing, 缺失: miniaudio, pywin32
[2026-02-17T08:30:48.092+08:00][INFO] [PythonCheck] 在 72 小時冷卻期內 (剩餘 71h58m)，跳過下載
[2026-02-17T08:30:48.092+08:00][WARN] Rust Bridge 啟動失敗：exe_not_found: q_engine.exe
[2026-02-17T08:30:48.093+08:00][INFO] [Python] L1 不完美，等待背景下載完成後熱啟動
[2026-02-17T08:30:48.093+08:00][WARN] Python Bridge 啟動失敗：unknown
[2026-02-17T08:30:50.688+08:00][INFO] Shell bridge started and handshaked
[2026-02-17T08:30:50.689+08:00][INFO] Shell Bridge OK
[2026-02-17T08:30:53.168+08:00][INFO] qqq dow.js 預熱 (w10)

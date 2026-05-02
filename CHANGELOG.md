# Changelog

All notable changes to this project will be documented in this file.

---


## [16.3.1] - 2026-04-30

### Added
- **Quick copy buttons on file preview**: Three new shortcut buttons appear next to each file in the editor — copy the full file path (c1), copy the file itself like Ctrl+C in Explorer (c2), or copy an image directly as a screenshot-style paste (c3) so you can Ctrl+V it straight into Photoshop or any image editor. The image button only appears for supported image formats and is guaranteed to work when shown.

### Fixed
- **Clipboard pinned cards no longer lost on restart**: Fixed a long-standing issue where pinned items (and sometimes entire cards) would silently disappear — especially when switching languages or closing multiple windows at once. The root cause was that all windows shared one history file but saved blindly, so the last window to exit would overwrite everyone else's changes. Now every save merges with the latest disk state first, so no pin or card is ever lost.
- **Python Broker fails to start**: Fixed an issue where the audio engine and related features (sound effects, disk space display, etc.) would not work because the Python Broker process could not start.
- **Video download**: Fixed known bugs.

### Improved
- **Periodic background save**: History is now automatically saved every 300 seconds, so even if the process is force-killed, at most half a minute of changes is at risk — and the next window's merge-save will recover them.

---


## [16.2.2] - 2026-04-29

### Added
- Avira virus scan report updated to version 16.2.2

### Fixed
- **IO Engine** Known bugs at the IO low level primarily originate from the Python broker - miniaudio_v16
- **Cross Publisher problem in settings.json**  Fixed the issue where cross publisher installation packages caused a conflict in the settings.json file.

---

## [16.2.0] - 2026-04-24

### Added
- **Network Radio**: When radio is live, pressing play automatically tunes in to the live stream — no extra steps needed
- **Clipboard history now survives IDE reinstall**: History is stored in your home directory (`~/.qqq/`) instead of IDE internal storage, so it persists across uninstalls, reinstalls, and even switching between different IDEs

---

## [16.1.7] - 2026-04-23

### Fixed
- **Roam left qq area wheel-expand broken after navigation**: Previously, scrolling to expand from 20 to 60 items would stop working entirely after switching directories. The root cause was that every directory switch replaced the sidebar DOM, destroying the scroll event listener. Now uses event delegation so wheel-expand works reliably regardless of how many times you navigate.

### Improved
- **Audio fully survives screensaver/sleep**: Fixed a long-standing bug where music and sound effects would permanently stop after the screensaver or lock screen activated. The root cause was that the system audio device cleanup call would hang indefinitely when the device was suspended by Windows, freezing the entire audio thread. Now uses non-blocking device cleanup so audio playback continues uninterrupted through any duration of sleep or lock.
- **Linux ARM64 platform now supported**: CI pipeline added `aarch64-unknown-linux-gnu` build target — Linux users on ARM64 hardware can now run the native engine.

---

## [16.1.3] - 2026-04-17

### Fixed
- **Pinned cards now survive restart**: Previously, pinned clipboard history items would disappear after restarting the IDE. Pin state is now reliably persisted and restored.
- **Pinned items protected from cleanup**: Pinned cards will no longer be silently deleted when clipboard history reaches capacity — they are always kept safe.
- **History list scroll freeze fixed**: Scrolling to the bottom of the clipboard history would cause the panel to freeze — only a few cards visible, scrollbar gone, and no further scrolling possible. Now scrolling is smooth and stable at all times.
- **Roam Left qq area now shows all history**: Previously only 20 items were visible and scrolling couldn’t load more. Now all entries (up to 60) are accessible — the first 20 show immediately for a clean look, and a single scroll wheel action reveals the rest.

---

## [16.1.2] - 2026-04-10

### Fixed
- **Audio survives screensaver**: Fixed the long-standing bug where music and sound effects would permanently stop after the screensaver activated. The audio engine now patiently waits for the system to recover (with progressive backoff) instead of giving up after one failed attempt. Recovery status is now fully visible in the diagnostic log.

---

## [16.1.1] - 2026-04-09

### Added

**Avira**: The virus scan credentials specified and required by VS Marketplace have been uploaded: https://cdn.gh555.com/u/01KK1SAAR5B53SJXGNVQWP5EB6/4ILW3YA72W6PQ.jpg

 From this point forward, we will continuously provide virus-free (all clean) certification.

### Fixed
- **Settings categories restored**: Extension settings now display in organized groups (Kernel, Roam, Observer, HTML, Doc Export) instead of a flat list — works correctly across all distribution channels
- **Roam history quick access**: Fix known bugs in the q2 Roam historical access area, especially the issue where clicking the cross to delete quick access entries is unresponsive.

### Improved
- **Build stability**: Eliminated unintended side-effect where bundling could run twice during packaging

---

## [16.1.0] - 2026-04-05

### Fixed
- **Open VSX publishing restored**:
  - Replaced `adm-zip` with system zip/unzip to avoid producing malformed archives (overlapped components)
  - All 7 platform packages (Linux x64, Linux ARM64, Windows x64, Windows ARM64, macOS Intel, macOS Apple Silicon, Universal) now publish successfully

### Added
- **Vig protocol**: Client-side usage statistics collection for user profile/vig feature
  - Full-snapshot idempotent design: server simply overwrites, no merge logic needed

### Changed
- **Dynamic extension ID**: Removed last hardcoded extension identifier fallback, now derived from `package.json` at runtime
- **CI pipeline hardening**: Added zip extra fields stripping step before Open VSX publishing

### Security
- **Build artifact isolation**: Private workflow assets excluded from published VSIX packages

---

## [16.0.2] - 2026-03-21

### Added
- **Real-time watermark refresh**: When watermark status changes, all rendered frames refresh immediately
  - Added `onWatermarkChange()` callback mechanism in `global.js`
  - `q1.js` registers callback to trigger `forceFullUpdateAllVisibleEditors()`
  - No need to reopen files - existing frames update in-place

### Fixed
- **Gear click hint not showing**: Exported `q` function from `global.js` (was missing)
- **Cloud config not taking effect**: Config now applies immediately after fetch
  - Updates `_sessionOverrides` (in-memory, instant effect)
  - Writes to VS Code settings.json (Settings UI updates immediately)
  - Triggers `_configUpdateCallbacks` (q1/q2/q4 components refresh)
  - Filters special fields (`removeWatermark`) and non-config keys

### Changed
- **Overwrite count accuracy**: Only counts keys in `DEFAULT_CONFIG`, logs changed keys for debugging

---

## [16.0.0] - 2026-03-21

### Added
- **Watermark removal**: Licensed users can now remove the preview watermark (toggle on：[https://www.gh555.com/gaea/d/qqq?#profile](https://www.gh555.com/gaea/d/qqq?#profile) )
- **Persist preferences**:
  - By `isPro()` to determine whether is Premium purchaser & will be able to fetch from the network and locally persist preferences.

---

## [15.73.136] - 2026-03-21

### Changed
- **Gear long-press popup sequence**: Two-stage notification for better feedback
  - Stage 1 (immediate): "Fetching cloud config..." popup + sound effect
  - Stage 2 (after response): Success or failure result popup
  - If instant error (no phone, not ready): Only stage 1 popup with error message
  - Both popups auto-dismiss after 9 seconds

### i18n
- Added `wq.fetching` ("Fetching cloud config...") to all 11 languages

---

## [15.73.135] - 2026-03-21

### Changed
- **Gear button interaction**: Long-press triggers immediately at 1 second (no need to release)
  - Long-press ≥1s: Plays `pas2.mp3` + silent cloud config fetch (no popup, no settings panel)
  - Single click: Opens settings + shows 9s hint popup
- **Trial mode popup**: Decoupled from cloud sync, only triggers on manual Settings UI changes
  - Shows once per window lifecycle, resets on restart
  - Updated text: explains local changes are trial-only, directs to official website
- **Notification format**: Fixed `⚠️ qqq: msg` → `qqq: ⚠️msg` (qqq as announcer prefix)
- **Phone display**: No masking in popups/logs, show full original number
- **Sound effects**: q2 unpin button changed from `pas2.mp3` to `kj2.mp3`

### i18n
- **config.phone.desc**: Full 11-language coverage with links and fetch methods explanation
- **Cloud sync messages**: Added `syncSuccessFmt`, `syncFailedFmt`, `noPhone`, `errPhoneNotRegistered`, `errNotPurchased`, `errRateLimit`, `errTooManyAccounts`, `errInvalidPhone`, `errNetwork` to all 11 languages
- **Gear click hint**: Added `q4.gearClickHint` to all 11 languages
- **Trial mode hint**: Updated `trialModeHint` in all 11 languages

### Technical
- JavaScript `q4.js`: Gear button uses `setTimeout` for immediate 1s trigger, `mouseup` cancels timer
- JavaScript `global.js`: Fixed `showAutoCloseNotification` emoji/prefix order
- JavaScript `global.js`: `handleVscodeConfigChanged` compares against session cache instead of `get()`

---

## [15.73.134] - 2026-03-21

### Added
- **Cloud config sync**: Fetch user preferences from server on 3 triggers
  - Window restart: Silent sync (success=no popup, failure=popup)
  - Long-press gear button ≥1s: Show popup for both success/failure
  - Phone field blur: Show popup
  - Uses `https.request` instead of `fetch` (VS Code fetch has restrictions)
  - 21 config items synced to globalState (not settings.json)

### Technical
- JavaScript `global.js`: Added `syncCloudConfig(phone, {silent})` with `https.request`
- JavaScript `q4.js`: Added mousedown/click long-press detection for gear button
- JavaScript `qqq.js`: Added 3s delayed silent sync on startup
- i18n: Added error messages for `phone_not_registered`, `not_purchased`, `rate_limit`, etc.

---

## [15.73.133] - 2026-03-20

### Fixed
- **Input focus on inactive window**: Fixed "first click swallowed" issue for filename, address, and filter input boxes
  - Added `mousedown` + `click` dual event listeners to ensure focus on first click
- **Pin/Unpin button reliability**: Disabled pin-icon (arrow) and delete-button (×) when window is inactive
  - Prevents complex state issues caused by processing clicks during window activation
  - Uses `document.hasFocus()` to check window focus state
  - Removed inline `onclick` handlers, now fully controlled by `mousedown` event delegation

### Technical
- JavaScript `q2.js`:
  - `filenameInput`, `addressInput`, `fileFilterInput`: Added `mousedown` + `click` focus handlers
  - Sidebar `mousedown` handler: Added `!document.hasFocus()` guard for pin-icon
  - Recent section `mousedown` handler: Added `!document.hasFocus()` guard for delete-button
  - Removed inline `onclick` from pin-icon and delete-button HTML generation

---

## [15.73.132] - 2026-03-20

### Fixed
- **Python process won't exit**: `_HOTKEY_LISTENER` missing `daemon=True`, blocking process termination
- **Broker auto-start after Python reinstall**: Added `_scheduleInstallCheck` in `_spawnBrokerThrottled` when Python unavailable

### Technical
- Python `kp.py`: Added `_HOTKEY_LISTENER.daemon = True`
- JavaScript `brokerBridge.js`: Schedule periodic check (5s interval, 3min timeout) when `python_not_downloaded`

---

## [15.73.130] - 2026-03-19

### Fixed
- **wq ping upload**: Fixed `bad_json` error caused by VS Code fetch sending empty body
  - Replaced `fetch()` with Node.js `https.request()` for reliable POST body
  - Added `Math.floor()` for `total_seconds` (server requires integer, not float)
  - Log level: success=INFO (no disk write), failure=WARN (with full context)

---

## [15.73.127] - 2026-03-19

### Added
- **Q4 online count display**: Show active device count (12h) in q4 sidebar title
  - Format: `v15.73.xxx; N` where N is online count
  - Auto-refresh every 5 minutes (matches server update cycle)
  - Uses `GET /api/goods/qqq/stats` endpoint

### Fixed
- **Online stats fetch**: Replaced non-existent `Downloader.downloadToString()` with native `fetch` API
- **Online count initialization**: Moved from `onDidChangeVisibility` (never fires on initial load) to `resolveWebviewView`

---

## [15.73.126] - 2026-03-19

### Fixed
- **Space+Q Stability (Recovery and Hardening)**: After a series of critical fixes, the feature's stability has been restored and significantly improved. The root cause of the total failure was identified and resolved, and the underlying validation logic is now working as intended.

### Changed
- **Removed Process Whitelist**: The hardcoded `_IDE_PROCESS_NAMES` list has been completely removed from the Python backend (`kp.py`).
- **Removed Backward Compatibility**: All logic for handling legacy window tracking data has been removed from both the Python backend and JavaScript client, enforcing a single, clean data format.

### Technical
- **Dynamic Process Validation (Self-Introduction Mechanism)**:
  - **JavaScript `q2.js`**: When registering a window, the client now actively sends its own process name (e.g., `Code.exe`) to the backend.
  - **Python `kp.py`**:
    - `_get_foreground_hwnd()`: Window registration requests now require an `expected_proc` name. The backend uses `psutil` to get the real process name of the foreground window and strictly compares it against the expected name. Any mismatch is rejected, atomically preventing race conditions.
    - `_test_activate_vscode()`: When activating a window, the target window's process name is re-validated against the name recorded during registration, ensuring the correct window type is activated.
    - The data structure of the tracking file (`vix_q2_windows.json`) has been updated to store the window handle, timestamp, and its corresponding process name.
- **Critical Bug Fixes**:
  - **Python `kp.py`**: Fixed a fatal `NameError` in `_test_activate_vscode` caused by incorrect variable unpacking in a loop. This bug had previously caused all window validations to fail, leading to a complete feature outage.
  - **JavaScript `q2.js`**: Replaced a silent error-swallowing `.catch()` block with `console.error` in the `get_foreground_hwnd` call chain. This change was crucial for exposing the underlying Python errors and enabling effective debugging.
- **Dependency Hardening**:
  - **JavaScript `qvenv.js`**: `psutil` has been added as a required dependency to ensure the new dynamic process validation mechanism is always available.
- **Webview Security Hardening**:
  - The q2 Roam webview is now created with a stricter security policy, explicitly disabling same-origin access.
  - This mitigates potential cross-site scripting (XSS) risks and aligns with modern web security best practices by ensuring all communication between the webview and the extension host occurs exclusively through the official `postMessage` API.

---

## [15.73.125] - 2026-03-06

### Fixed
- **Space+Q hotkey reliability**: Fixed "only works once" issue and incorrect window activation
  - Changed from PID-based window lookup to direct hwnd tracking
  - Fixed timing bug: hwnd now captured on window **focus gain**, not focus loss
  - Previously: `GetForegroundWindow()` called on focus loss returned the *other* window's hwnd
  - Now: Correct hwnd captured when q2 panel opens or window gains focus
  - Cross-IDE tracking via temp file (`%TEMP%/vix_q2_windows.json`)

### Changed
- **Code cleanup**: Removed ~160 lines of deprecated window tracking code
  - Removed: `_Q2_WINDOWS` OrderedDict, `_Q2_WINDOWS_LOCK`
  - Removed: `_find_hwnd_by_pid()`, `_register_q2_window()`, `_unregister_q2_window()`
  - Removed: `_update_window_focus()`, `_restore_q2_window()`
  - Removed: Corresponding action handlers (register_q2_window, unregister_q2_window, etc.)
  - Simplified `_updateQ2TrackingFile()` in JS to only handle 'register' action

### Technical
- Python `kp.py`:
  - `_test_activate_vscode()`: Reads hwnd directly from temp file, activates with `IsWindow()` validation
  - `_get_foreground_hwnd()`: New action to get current foreground window hwnd
  - Automatic cleanup of dead windows (invalid hwnd) from tracking file
- JavaScript `q2.js`:
  - `_updateQ2TrackingFile('register')`: Calls Python to get hwnd, writes to temp file
  - Triggers: panel open, panel visible, window focus gain

---

## [15.73.124] - 2026-03-06

### Added
- **Q4 right-click to Explorer**: Right-click anywhere in q4 sidebar to open VS Code built-in file explorer
  - Quick navigation from clipboard history panel to file tree
  - Uses `workbench.view.explorer` command

### Technical
- JavaScript `q4.js`:
  - Modified `contextmenu` event listener to post `executeCommand` message
  - Leverages existing message handler infrastructure

---

## [15.73.119] - 2026-03-04

### Added
- **Random color scheme system**: File list selection now uses randomized pastel color schemes with weighted probabilities
  - 4 color schemes with different appearance rates:
    - **Coral** (`#e8d0c0`): 30% probability - light coral background with black text
    - **Warm Apricot** (`#e8d0b0`): 30% probability - light warm apricot background with black text
    - **Bean Paste Bun** (`#e7e4c2`): 30% probability - light bean paste background with black text
    - **Vivid Red** (`#cb4b16`): 10% probability - original vivid red background with white text
  - Automatically selects on each webview load
  - Console log displays selected scheme name and colors
  - Eye-friendly pastel tones for reduced visual fatigue

### Technical
- HTML `q2.html`:
  - Added IIFE-based random color scheme selector in `<script>` block before `</head>`
  - Weighted random algorithm using `Math.random()` and cumulative weights
  - Dynamic CSS variable assignment via `document.documentElement.style.setProperty()`

---

## [15.73.118] - 2026-03-04

### Added
- **Roam Name configuration**: New setting `qqq.roamName` to customize q2 Roam webview tab title
  - Default value: `的梦gaea`
  - i18n: `漫游器命名` (zh), `漫遊器命名` (zh-tw), `Name Roam` (en), `Roam 命名` (ja), `Benenne Roam` (de), `Roam 이름을 지어주세요` (ko), `Имя Roam` (ru), `سمّوا Roam` (ar), `Nombra Roam` (es), `Nommez Roam` (fr), `Nomeie Roam` (pt-br)
  - Follows license persistence policy (unlicensed: session-only, reset on restart)

### Security
- **Tab title sanitization**: Added `sanitizeTabTitle()` to prevent UI issues and potential risks
  - Remove newlines (`\r`, `\n`) that break tab display
  - Remove control characters (ASCII 0-31) that cause rendering issues
  - Strip HTML tags to prevent injection / settings.json corruption
  - Limit to 222 bytes to prevent memory / settings.json bloat
  - UTF-8 aware truncation (no mid-character cuts)

### Fixed
- **Nunlicensed config read timing**: Fixed race condition where q2 Roam opens before settings.json is cleared
  - Added `_bootstrapResetDone` flag to guard config reads during bootstrap
  - Nunlicensed users now get default values until `nonVipBootstrapResetAll()` completes
  - Zero startup delay (q2 Roam opens immediately with safe defaults)
- **Nunlicensed config modification**: Users can now modify settings in current session
  - Previously: Nunlicensed `get()` always returned defaults, ignoring settings.json
  - Now: After bootstrap, `get()` reads settings.json (cleared or user-modified)
  - Behavior: Session-effective, reset on restart (unchanged)

### Technical
- JavaScript `global.js`:
  - Added `_bootstrapResetDone` flag with dual-safety for license users
  - Modified `ConfigManager.get()` with bootstrap guard (step 2)
  - Modified `setVipMode()` to mark `_bootstrapResetDone = true` for license
  - Modified `nonVipBootstrapResetAll()` to set flag after clearing
- JavaScript `q2.js`:
  - Added `sanitizeTabTitle(str, maxBytes)` utility function
  - Modified panel creation to use sanitized `roamName` config

---

## [15.73.117] - 2026-03-03

### Changed
- **Desktop & Recycle Bin excluded from sidebar**: These paths are now filtered out from qq area and pinned history
  - Already permanently shown in drive bar, no need to duplicate
  - Cross-platform filtering:
    - **Windows**: Desktop (`%USERPROFILE%\Desktop`)
    - **macOS**: Desktop (`~/Desktop`), Trash (`~/.Trash`)
    - **Linux**: Desktop (`~/Desktop`), Trash (`~/.local/share/Trash`, `~/.local/share/Trash/files`)
  - Uses `cacheKeyForPath()` for case-insensitive path comparison

- **Zero display optimization**: Values < 0.01 GB now show `0` instead of `0.00`
  - Applies to Desktop and Recycle Bin used space display
  - Example: Empty recycle bin shows `Trash: 0` instead of `Trash: 0.00`

### Technical
- JavaScript `q2.js`:
  - Added `_driveBarExclusionKeys` Set for path filtering
  - Added `_isExcludedFromSidebar()` function
  - Modified `generateSidebarHtml()` and `getqqiqItems()` to exclude drive bar paths

---

## [15.73.116] - 2026-03-03

### Added
- **Experimental function: Global hotkey Space+Q**: Activate IDE window from anywhere with keyboard shortcut
  - Press and hold `Space`, then tap `Q` to bring IDE window to foreground
  - Works system-wide regardless of current focused application
  - Plays sound effect (`kj3.mp3`) only when window actually activated (silent if no IDE found)
  - 300ms debounce to prevent accidental double-triggers
  - Supports multiple IDEs: VS Code, Cursor, Qoder, Trae (by process name matching)
  - Window activation sequence: SW_RESTORE → Alt trick → SetForegroundWindow → BringWindowToTop

### Changed
- **Python dependency check**: Added `pynput==1.7.7` to required dependencies
  - All 4 dependencies now mandatory (miniaudio, Pillow, pynput, pywin32 on Windows)
  - Missing any dependency triggers full venv reinstall

### Technical
- Python `kp.py`:
  - Added `pynput.keyboard` global listener with `_hotkey_on_press` / `_hotkey_on_release`
  - Added `_test_activate_vscode()` using `EnumWindows` + `GetModuleBaseNameW` for process matching
  - Added `_activate_window()` with Alt key trick to bypass foreground window restrictions
- JavaScript `qvenv.js`:
  - Added `pynput==1.7.7` to `_getLockedDeps()`
  - Moved `pynput` to `_getRequiredDeps()` (mandatory)

---

## [15.73.115] - 2026-03-03

### Performance
- **Broker log optimization**: Reduced log volume by ~90%+ for massive storage savings
  - High-frequency routine actions now silent (no logging):
    - `ping` (every 20s heartbeat)
    - `disk_free_batch` (every 30s disk space poll)
    - `update_window_focus` (every focus change)
    - `register_q2_window` / `unregister_q2_window` (window lifecycle)
  - Only meaningful actions (play_sfx, scan_folder, etc.) are logged
  - Applies to both TCP/Unix socket and Windows Named Pipe handlers

- **Broker log rotation**: Auto-rotate at 2MB to prevent unbounded growth
  - `LOG_MAX_SIZE = 1MB` hard limit
  - Rotation check before every log write
  - Old log deleted, fresh file created with rotation marker
  - Previous issue: broker.log grew to 28MB+ over time

### Technical
- Python `kp.py`:
  - Added `LOG_MAX_SIZE` constant (2 * 1024 * 1024)
  - Added `_LOG_PATH` global for rotation tracking
  - Added `_rotate_log_if_needed()` function
  - Added `_QUIET_ACTIONS` set in both TCP/Unix and Pipe handlers
  - Modified `_log()` to call rotation check before each write

---

## [15.73.114] - 2026-03-03

### Added
- **Desktop & Recycle Bin in drive bar**: Added two special entries after drive letters (C:\, D:\, etc.)
  - Desktop: Shows used space (not free space), click to navigate directly
  - Recycle Bin/Trash: Shows used space, platform-specific behavior:
    - **Windows**: Opens external Explorer (`shell:RecycleBinFolder`) - virtual folder cannot be browsed directly
    - **macOS**: Navigates to `~/.Trash` within q2 Roam
    - **Linux**: Navigates to `~/.local/share/Trash/files` within q2 Roam
  - Display format: `Desktop: 0.30` / `Trash: 1` (with colon, i18n supported)
  - Uses same 30-second cache polling mechanism as drive free space

### Fixed
- **Disk space polling resilience**: Backend now always sends response to frontend even on failure
  - Previously: If Python engine failed, no response was sent, causing `diskFreeInFlight` to stay true forever
  - Now: Empty response `{}` sent on failure, allowing polling to continue

### i18n
- Added `desktop` and `recycleBin` keys to all 10 languages:
  - zh: 桌面: / 回收站:
  - zh-tw: 桌面: / 回收站:
  - en: Desktop: / Trash:
  - ja: デスクトップ: / ごみ箱:
  - ko: 바탕 화면: / 휴지통:
  - de: Desktop: / Papierkorb:
  - fr: Bureau: / Corbeille:
  - es: Escritorio: / Papelera:
  - pt-br: Área de Trabalho: / Lixeira:
  - ru: Рабочий стол: / Корзина:
  - ar: سطح المكتب: / سلة المحذوفات:

### Technical
- Python `kp.py`: Added `_get_folder_size_fast()`, `_get_desktop_path()`, `_get_recycle_bin_size()`
- Cross-platform recycle bin size calculation:
  - Windows: Sum of all `X:\$Recycle.Bin` directories
  - macOS: `~/.Trash` directory size
  - Linux: `~/.local/share/Trash/files` directory size
- Desktop path detection: `%USERPROFILE%\Desktop` (Windows) or `~/Desktop` (macOS/Linux)

---

## [15.73.113] - 2026-03-03

### Added
- **LNK shortcut folder jump**: Press `w` on a folder shortcut (.lnk) to navigate directly within q2 Roam (pure Node.js Buffer parsing, <1ms)
- **Backspace returns to source**: After jumping via .lnk, pressing backspace returns to the source directory instead of parent
- **Preview mode for documents**: Opening documents with `q` key uses preview mode - consecutive opens only keep one tab

### Fixed
- Fixed .lnk shortcut parsing failure for paths containing Chinese characters
- Improved .lnk parsing by scanning ExtraData for Unicode paths

### Changed
- LNK parsing switched from PowerShell to pure Node.js Buffer parsing (500x+ faster)

---

## [15.73.110] - 2026-03-02

### Changed
- Reverted webview focus techniques (causes issues in multi-editor-group scenarios)
- Removed ensureFocus message handler and related focus management code

---

## [15.73.107] - 2026-03-02

### Features
- **Event delegation for sidebar**: qq items and recent/history items now use event delegation instead of inline onclick
- **Multi-layer webview focus fix**: Added 6 techniques to prevent "first click swallowed" issue
  - Body focus with tabindex
  - Window focus fallback
  - Window focus event listener
  - Mouseenter focus preparation
  - Limited focus check after visibility change
  - Extension-side focus command on panel activation

---

## [15.73.106] - 2026-03-01

### Changed
- Performance optimizations for file operations

---

## [15.73.100] - 2026-02-27

### Changed
- Milestone release with accumulated improvements

---

## [15.73.94] - 2026-02-25

### Changed
- Arabic i18n RTL marker improvements for tooltips

---

## [15.73.91] - 2026-02-24

### Fixed
- **yt-dlp fallback logging**: Changed download attempt logs from INFO to WARN for better visibility
- **Spawn error diagnosis**: Added file size logging when yt-dlp spawn fails
- **Verification failure details**: Log status code, stdout, stderr, and file size on verification failure

---

## [15.73.90] - 2026-02-24

### Features
- **Cross-process lock for yt-dlp**: Prevent multiple VS Code windows from downloading yt-dlp simultaneously
  - Lock wait timeout: 121 seconds
  - Lock stale timeout: 300 seconds
  - Double-check after acquiring lock to avoid redundant downloads

---

## [15.73.89] - 2026-02-24

### Fixed
- Cross-process synchronization improvements for video download

---

## [15.73.79] - 2026-02-21

### Features
- **Open VSX Registry support**: Extension now published to Open VSX in addition to VS Code Marketplace
- Added Open VSX namespace verification workflow

### Fixed
- Changed `enlargeSmallImages` default to `false`

### Added
- i18n: Admin permission error messages with copy command button (12 languages)

---

## [15.73.76] - 2026-02-21

### Features
- **Delete progress UI**: Real-time progress notification with cancellation support
  - Phase 1: Scan files with progress
  - Phase 2: Delete files with batch yielding (prevents Extension Host freeze)
  - i18n: Added scanning/deleting progress messages (12 languages)

### Added
- i18n: File system error messages (fileNotFound, noPermissions, fileBusy, etc.)

---

## [15.73.74] - 2026-02-20

### Changed
- SSH signing verification for releases

---

## [15.73.73] - 2026-02-20

### Features
- **Recycle bin tooltip enhancement**: Path displayed with visual separator
  - Directory path shown in normal color
  - Last backslash highlighted in bold red
  - Filename follows the separator
  - Uses `|SPLIT|` marker for path/filename separation

---

## [15.73.63] - 2026-02-19

### Fixed
- Rust engine: Properly separate handle (isize) from pointer for GlobalAlloc/Lock/Free

---

## [15.73.62] - 2026-02-19

### Fixed
- Rust engine: Cast h_mem to isize for GlobalFree

---

## [15.73.61] - 2026-02-19

### Fixed
- Rust engine: Declare GlobalFree via FFI instead of windows-sys import

---

## [15.73.60] - 2026-02-19

### Fixed
- Use once_cell::Lazy instead of OnceLock for Win7 build-std compatibility

---

## [15.73.58] - 2026-02-19

### Features
- **IO Engine v16**: Broker broadcast architecture with zero polling
  - All VS Code windows share ONE Python Broker process (15 windows → 1 broker)
  - IPC via Unix socket (Linux/macOS) or Named Pipe (Windows)
  - Token-based authentication with endpoint.json discovery
  - TTL-based heartbeat for auto-shutdown
  - Memory usage reduced by ~82% (15 windows: ~855MB → ~155MB)
  - Status sync: ~750ms polling → <10ms broadcast
  - Zero CPU when idle (event-driven)
  - Cross-IDE support (VS Code, Cursor, Windsurf, etc.)

### Added
- New `src/brokerBridge.js`: 789-line IPC client for Python Broker

---

## [15.73.54] - 2026-02-19

### Changed
- Recycle bin tooltip now uses globalTooltip instead of pathTooltip
- i18n index.js optimizations

---

## [15.73.50] - 2026-02-18

### Features
- Initial IO Engine v16 Broker broadcast implementation

---

For older releases, see [GitHub Releases](https://github.com/gh555com/qqq/releases).

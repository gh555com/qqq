# Changelog

All notable changes to this project will be documented in this file.

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
- **Event delegation for sidebar**: QQ items and recent/history items now use event delegation instead of inline onclick
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
  - Lock wait timeout: 120 seconds
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

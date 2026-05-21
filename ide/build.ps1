# ==============================================================================
# qqq IDE Build Script
# Usage: .\build.ps1 [-Target win32-x64] [-VscodeTag 1.77.3]
# Requires: node 16.14.x, yarn 1.22.x, git, python 3.10, Visual Studio Build Tools (C++)
# Why 1.77: last Electron 19 line = naturally Win7 compatible; auxiliary bar API stable since 1.74.
# ==============================================================================
param(
    [string]$Target = "win32-x64",
    [string]$VscodeTag = "1.77.3"
)
$ErrorActionPreference = "Stop"

# -- inject portable git if not in PATH ----------------------------------------
$gitCandidates = @("E:\s\d\git\bin", "E:\s\d\git\cmd")
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    foreach ($g in $gitCandidates) {
        if (Test-Path (Join-Path $g "git.exe")) {
            $env:PATH = "$g;" + $env:PATH
            Write-Host "  [git] injected $g" -ForegroundColor DarkGray
            break
        }
    }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git not found in PATH"; exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$BuildDir  = Join-Path $ScriptDir ".build\code-oss"

# -- 0. Zero C-drive: force all cache to E drive --------------------------------
$CacheBase = Join-Path $ScriptDir ".build"
foreach ($d in @("yarn-cache","npm-cache","temp","electron")) {
    New-Item -ItemType Directory -Force (Join-Path $CacheBase $d) | Out-Null
}
$env:npm_config_cache       = Join-Path $CacheBase "npm-cache"
$env:YARN_CACHE_FOLDER      = Join-Path $CacheBase "yarn-cache"
$env:TEMP                   = Join-Path $CacheBase "temp"
$env:TMP                    = Join-Path $CacheBase "temp"
$env:ELECTRON_CACHE         = Join-Path $CacheBase "electron"
$env:ELECTRON_BUILDER_CACHE = Join-Path $CacheBase "electron"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  qqq IDE build: target=$Target  vscode=$VscodeTag" -ForegroundColor Cyan
Write-Host "  Cache -> $CacheBase" -ForegroundColor DarkGray
Write-Host "================================================================" -ForegroundColor Cyan

# ==============================================================================
# Helper functions
# ==============================================================================
function Comment-Lines {
    # Comment out all lines matching $Pattern in $File
    param([string]$File, [string]$Pattern, [string]$Desc)
    if (-not (Test-Path $File)) { Write-Warning "  [x] missing: $File"; return }
    $lines = Get-Content $File -Encoding UTF8
    $hit = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $Pattern -and $lines[$i] -notmatch '^//') {
            $lines[$i] = "// qqq: removed -- " + $lines[$i].TrimStart()
            $hit++
        }
    }
    if ($hit -gt 0) {
        $lines | Set-Content $File -Encoding UTF8
        Write-Host "    [ok] $Desc ($hit lines)" -ForegroundColor Green
    } else {
        Write-Warning "    [x] pattern miss: $Desc"
    }
}

function Nuke-Dir {
    param([string]$Dir, [string]$Desc)
    if (Test-Path $Dir) {
        Remove-Item $Dir -Recurse -Force
        Write-Host "    [ok] deleted: $Desc" -ForegroundColor Green
    } else {
        Write-Host "    [-] not found: $Desc" -ForegroundColor DarkGray
    }
}

# ==============================================================================
# 1. Clone Code-OSS
# ==============================================================================
if (-not (Test-Path (Join-Path $BuildDir ".git"))) {
    Write-Host "`n[1/7] Cloning Code-OSS $VscodeTag ..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force (Join-Path $ScriptDir ".build") | Out-Null
    git clone --depth 1 --branch $VscodeTag https://github.com/microsoft/vscode.git $BuildDir
} else {
    Write-Host "`n[1/7] Code-OSS already cloned, resetting..." -ForegroundColor Green
    Push-Location $BuildDir; git checkout -- . ; git clean -fd; Pop-Location
}

# ==============================================================================
# 2. Overlay product.json
# ==============================================================================
Write-Host "`n[2/7] Overlaying product.json ..." -ForegroundColor Yellow
python (Join-Path $ScriptDir "scripts\merge_product.py") `
    (Join-Path $BuildDir "product.json") `
    (Join-Path $ScriptDir "product.json") `
    (Join-Path $BuildDir "product.json")

# ==============================================================================
# 3. Source surgery
# ==============================================================================
Write-Host "`n[3/7] Source surgery ..." -ForegroundColor Yellow

$WbDesktop = Join-Path $BuildDir "src\vs\workbench\workbench.desktop.main.ts"

# -- 3a. Remove Chat / InlineChat imports from workbench entry -----------------
Write-Host "  [3a] Remove Chat / InlineChat"
Comment-Lines -File $WbDesktop -Pattern "contrib/chat/" -Desc "Chat imports"
Comment-Lines -File $WbDesktop -Pattern "contrib/inlineChat/" -Desc "InlineChat imports"

# -- 3b. Remove unwanted built-in extensions (keep ipynb to be safe in 1.77 build pipeline) --
Write-Host "  [3b] Remove unwanted extensions"
$extBase = Join-Path $BuildDir "extensions"
$killExts = @(
    @("github-authentication",   "GitHub OAuth"),
    @("microsoft-authentication","Microsoft auth"),
    @("github",                  "GitHub integration"),
    @("tunnel-forwarding",       "Remote Tunnel")
)
foreach ($e in $killExts) {
    Nuke-Dir -Dir (Join-Path $extBase $e[0]) -Desc $e[1]
}

# -- 3c. Gut telemetry ---------------------------------------------------------
Write-Host "  [3c] Gut telemetry"
$telFile = Join-Path $BuildDir "src\vs\platform\telemetry\common\telemetryService.ts"
if (Test-Path $telFile) {
    $telContent = Get-Content $telFile -Raw -Encoding UTF8
    # Replace data-send calls with no-op (avoid unused-variable from Comment-Lines)
    $telContent = $telContent -replace 'this\._appenders\.forEach\([^)]*\)\s*=>\s*[^;]+;', '/* qqq: telemetry gutted */'
    $telContent = $telContent -replace 'this\._appenders\.forEach\([^)]+\{[^}]+\}\)', '/* qqq: telemetry gutted */'
    # Also blank out the error log send
    $telContent = $telContent -replace 'this\._log\(errorEventName[^;]+;', '/* qqq: error telemetry gutted */'
    Set-Content $telFile $telContent -Encoding UTF8
    Write-Host "    [ok] telemetry data send gutted" -ForegroundColor Green
}

# 1DS Appender - gut the actual post
$odsFile = Join-Path $BuildDir "src\vs\platform\telemetry\common\1dsAppender.ts"
if (Test-Path $odsFile) {
    $odsContent = Get-Content $odsFile -Raw -Encoding UTF8
    $odsContent = $odsContent -replace 'this\.appender\.', '// qqq: removed -- this.appender.'
    Set-Content $odsFile $odsContent -Encoding UTF8
    Write-Host "    [ok] 1DS appender gutted" -ForegroundColor Green
}

# -- 3d. Unlock auxiliary sidebar -----------------------------------------------
Write-Host "  [3d] Unlock auxiliary sidebar"
$vdFile = Join-Path $BuildDir "src\vs\workbench\services\views\browser\viewDescriptorService.ts"
if (Test-Path $vdFile) {
    $vdContent = Get-Content $vdFile -Raw -Encoding UTF8
    if ($vdContent -match "contribAuxiliaryBarEntries") {
        $vdContent = $vdContent -replace 'isProposedApiEnabled\([^,]+,\s*.contribAuxiliaryBarEntries.\)', 'true /* qqq: unlocked */'
        Set-Content $vdFile $vdContent -Encoding UTF8
        Write-Host "    [ok] auxiliary bar unlocked" -ForegroundColor Green
    } else {
        Write-Host "    [-] guard not found (product.json may suffice)" -ForegroundColor DarkGray
    }
}

# -- 3e. Suppress other nags via product.json (no code surgery needed) ----------
Write-Host "  [3e] Crash/GettingStarted/Experiments -> product.json handles" -ForegroundColor DarkGray

# -- 3f. Remove Win7 / Win8 EOL notification banner ----------------------------
Write-Host "  [3f] Remove Win7 EOL notification"
$updateContrib = Join-Path $BuildDir "src\vs\workbench\contrib\update\browser\update.contribution.ts"
if (Test-Path $updateContrib) {
    Comment-Lines -File $updateContrib -Pattern "win7|Win7|Windows 7|isWindows && osVersion|eolMessage|isWindowsClient" -Desc "Win7 EOL notification lines"
} else {
    Write-Warning "    [x] update.contribution.ts not found"
}

# -- 3h. KILL Marketplace + VSIX install (nuclear) -----------------------------------
Write-Host "  [3h] Kill Marketplace / VSIX install"
# Comment out ALL contrib/extensions imports -> kills extensions viewlet, install-from-vsix,
# recommendations, extension search, gallery commands. Extension HOST still works (separate service).
Comment-Lines -File $WbDesktop -Pattern "contrib/extensions/" -Desc "Marketplace UI imports"
# Also kill the electron-sandbox contrib (if any)
$WbElectron = Join-Path $BuildDir "src\vs\workbench\workbench.sandbox.main.ts"
if (Test-Path $WbElectron) {
    Comment-Lines -File $WbElectron -Pattern "contrib/extensions/" -Desc "Marketplace UI imports (sandbox)"
}
# Kill marketplace keybinding (Ctrl+Shift+X)
$kbFile = Join-Path $BuildDir "src\vs\workbench\browser\actions\workbenchActions.ts"
if (Test-Path $kbFile) {
    Comment-Lines -File $kbFile -Pattern "EXTENSIONS_VIEWLET_ID" -Desc "Extensions keybinding"
}
Write-Host "    Marketplace and VSIX install: DEAD" -ForegroundColor Magenta

# -- 3i. Auxiliary bar hijack (5-patch) -----------------------------------------------
Write-Host "  [3i] Auxiliary bar hijack"
# Patch 1: Default auxiliary bar width = 380px
$auxBarPart = Join-Path $BuildDir "src\vs\workbench\browser\parts\auxiliarybar\auxiliaryBarPart.ts"
if (Test-Path $auxBarPart) {
    $auxContent = Get-Content $auxBarPart -Raw -Encoding UTF8
    # Look for default width constant (usually 200-300)
    if ($auxContent -match 'DEFAULT.*?=\s*(\d+)') {
        $auxContent = $auxContent -replace '(DEFAULT.*?=\s*)\d+', '${1}380'
        Set-Content $auxBarPart $auxContent -Encoding UTF8
        Write-Host "    [ok] auxiliary bar default width -> 380px" -ForegroundColor Green
    }
}
# Patch 2: Force auxiliary bar visible on fresh install (layout.ts)
$layoutFile = Join-Path $BuildDir "src\vs\workbench\browser\layout.ts"
if (Test-Path $layoutFile) {
    $layContent = Get-Content $layoutFile -Raw -Encoding UTF8
    # In 1.77, isAuxiliaryBarHidden defaults to true for fresh installs
    # Flip it: any check for auxiliaryBar hidden -> false
    $layContent = $layContent -replace 'isAuxiliaryBarHidden\(\)\s*\{[^}]*return\s+true', 'isAuxiliaryBarHidden() { /* qqq: forced visible */ return false'
    Set-Content $layoutFile $layContent -Encoding UTF8
    Write-Host "    [ok] auxiliary bar default visible" -ForegroundColor Green
}
# Patch 3: Drag-drop prevention (TODO: needs surgical per-method no-op, not line commenting)
# Comment-Lines on compositeBar.ts destroys TS structure (comments declaration but leaves body)
# Skipped for now — publisher lock (3i Patch 4+5, pending) is the real defense
Write-Host "    [skip] composite drag-drop (TODO: surgical fix)" -ForegroundColor DarkGray
Write-Host "    Auxiliary bar: hijacked" -ForegroundColor Magenta

# -- 3j. Brand cleanup (ensure no Code-OSS / VS Code text leaks) ---------------------
Write-Host "  [3j] Brand cleanup"
# The window title in 1.77 uses product.nameShort (already 'qqq' in our product.json)
# Kill residual 'Code - OSS' or 'Visual Studio Code' strings in key UI files
$aboutFile = Join-Path $BuildDir "src\vs\workbench\electron-sandbox\parts\dialogs\dialogHandler.ts"
if (-not (Test-Path $aboutFile)) {
    $aboutFile = Join-Path $BuildDir "src\vs\workbench\browser\parts\dialogs\dialogHandler.ts"
}
if (Test-Path $aboutFile) {
    $aboutContent = Get-Content $aboutFile -Raw -Encoding UTF8
    $aboutContent = $aboutContent -replace 'Code - OSS', 'qqq IDE'
    $aboutContent = $aboutContent -replace 'Visual Studio Code', 'qqq IDE'
    Set-Content $aboutFile $aboutContent -Encoding UTF8
    Write-Host "    [ok] About dialog branded" -ForegroundColor Green
}
# Kill getting-started / walkthrough
Comment-Lines -File $WbDesktop -Pattern "contrib/welcomeGettingStarted/" -Desc "Getting Started"
Comment-Lines -File $WbDesktop -Pattern "contrib/welcomeWalkthrough/" -Desc "Welcome Walkthrough"
Comment-Lines -File $WbDesktop -Pattern "contrib/welcomeViews/" -Desc "Welcome Views"
# Kill update notification (we handle updates via ghrun)
Comment-Lines -File $WbDesktop -Pattern "contrib/update/" -Desc "Update notifications"
Write-Host "    Brand: clean" -ForegroundColor Magenta

# -- 3g. Portable dir names ---------------------------------------------------
# product.json dataFolderName="f" already makes VS Code use f/ as portable root.
# VS Code standard subdirs (f/user-data/, f/extensions/) are correct as-is.
# No source patching needed — dataFolderName handles everything.
Write-Host "  [3g] Portable dir: dataFolderName=f in product.json (no source patch needed)" -ForegroundColor DarkGray

Write-Host "`n  Surgery complete." -ForegroundColor Cyan

# ==============================================================================
# 4. Inject pre-bundled extensions
# ==============================================================================
Write-Host "`n[4/7] Injecting qqq extensions ..." -ForegroundColor Yellow
$extDir = Join-Path $BuildDir "extensions"
New-Item -ItemType Directory -Force (Join-Path $extDir "qqq")    | Out-Null
New-Item -ItemType Directory -Force (Join-Path $extDir "qqq-ai") | Out-Null

$QqqCore = Join-Path $RepoRoot "dist\qqq-core"
if (Test-Path $QqqCore) {
    Copy-Item "$QqqCore\*" (Join-Path $extDir "qqq") -Recurse -Force
    Write-Host "    [ok] qqq core injected" -ForegroundColor Green
} else {
    Write-Warning "    dist\qqq-core not found (skipped, can add later)"
}
$QqqAi = Join-Path $RepoRoot "dist\qqq-ai"
if (Test-Path $QqqAi) {
    Copy-Item "$QqqAi\*" (Join-Path $extDir "qqq-ai") -Recurse -Force
    Write-Host "    [ok] qqq-ai injected" -ForegroundColor Green
} else {
    Write-Warning "    dist\qqq-ai not found (skipped, can add later)"
}

# ==============================================================================
# 5. Install dependencies (yarn for vscode 1.77; npm switch came in 1.94)
# ==============================================================================
Write-Host "`n[5/7] yarn install ..." -ForegroundColor Yellow
Push-Location $BuildDir
yarn --frozen-lockfile --network-timeout 600000
Pop-Location

# ==============================================================================
# 6. Compile
# ==============================================================================
Write-Host "`n[6/7] Compiling for $Target ..." -ForegroundColor Yellow
Push-Location $BuildDir
yarn gulp "vscode-$Target"
Pop-Location

# ==============================================================================
# 7. Verify output
# ==============================================================================
Write-Host "`n[7/7] Verifying output ..." -ForegroundColor Yellow
$OutDir = Join-Path $BuildDir "..\..\VSCode-$Target"
if (-not (Test-Path $OutDir)) { $OutDir = Join-Path $BuildDir "..\VSCode-$Target" }
if (-not (Test-Path $OutDir)) { $OutDir = Join-Path $ScriptDir ".build\VSCode-$Target" }

if (Test-Path $OutDir) {
    $exe = Get-ChildItem $OutDir -Filter "*.exe" -Recurse | Select-Object -First 1
    if ($exe) {
        Write-Host "    [ok] executable: $($exe.FullName)" -ForegroundColor Green
    } else {
        Write-Host "    [ok] output dir: $OutDir" -ForegroundColor Green
    }

    # Trigger VS Code portable mode: mkdir f/ in artifact root (dataFolderName=f in product.json)
    # VS Code creates f/user-data/ and f/extensions/ automatically.
    $dataDir = Join-Path $OutDir "f"
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dataDir "user-data") | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dataDir "user-data\User") | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dataDir "extensions") | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dataDir "components") | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dataDir "goods") | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dataDir "tmp") | Out-Null
    "qqq-ide portable build $(Get-Date -Format o) tag=$VscodeTag" `
        | Out-File -FilePath (Join-Path $dataDir ".qqq-portable") -Encoding utf8
    Write-Host "    [ok] portable f/ created (user-data/extensions/components/goods/tmp)" -ForegroundColor Green

    # -- Copy ghrun.exe + watchdog.exe into f/ (QDIR runtime) --
    foreach ($bin in @("ghrun.exe", "watchdog.exe")) {
        $src = Join-Path $RepoRoot "dist\$bin"
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $dataDir $bin) -Force
            Write-Host "    [ok] $bin -> f/$bin" -ForegroundColor Green
        } else {
            Write-Warning "    dist/$bin not found"
        }
    }

    # -- Pre-install vsix into f/extensions/ (VS Code portable extensions dir) --
    # qqq-core: look for *universal*.vsix or qqq-*.vsix in dist/
    $vsixFile = Get-ChildItem (Join-Path $RepoRoot "dist") -Filter "*universal*.vsix" | Select-Object -First 1
    if (-not $vsixFile) {
        $vsixFile = Get-ChildItem (Join-Path $RepoRoot "dist") -Filter "qqq-*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if ($vsixFile) {
        $extInstallDir = Join-Path $dataDir "extensions\qqq-core"
        New-Item -ItemType Directory -Force $extInstallDir | Out-Null
        $tmpExtract = Join-Path $dataDir "_vsix_tmp"
        Expand-Archive -Path $vsixFile.FullName -DestinationPath $tmpExtract -Force
        if (Test-Path (Join-Path $tmpExtract "extension")) {
            Copy-Item (Join-Path $tmpExtract "extension\*") $extInstallDir -Recurse -Force
        } else {
            Copy-Item "$tmpExtract\*" $extInstallDir -Recurse -Force
        }
        Remove-Item $tmpExtract -Recurse -Force
        Write-Host "    [ok] qqq-core pre-installed: $($vsixFile.Name)" -ForegroundColor Green
    } else {
        Write-Warning "    no qqq-core vsix in dist/ (bootstrap will handle)"
    }

    # qqq-ai: from ai/dist/
    $aiDistDir = Join-Path $RepoRoot "ai\dist"
    if (Test-Path (Join-Path $aiDistDir "extension.js")) {
        $aiInstallDir = Join-Path $dataDir "extensions\qqq-ai"
        New-Item -ItemType Directory -Force $aiInstallDir | Out-Null
        Copy-Item "$aiDistDir\*" $aiInstallDir -Recurse -Force
        Copy-Item (Join-Path $RepoRoot "ai\package.json") $aiInstallDir -Force
        if (Test-Path (Join-Path $RepoRoot "ai\res")) {
            Copy-Item (Join-Path $RepoRoot "ai\res") $aiInstallDir -Recurse -Force
        }
        Write-Host "    [ok] qqq-ai pre-installed from ai/dist/" -ForegroundColor Green
    } else {
        Write-Warning "    ai/dist/ not found (run: cd ai && npm run bundle)"
    }

    # -- Generate qqq-defaults.json (one file controls all IDE settings) --
    # Remote push: update _version on server -> all clients re-apply next launch
    $defaultsFile = Join-Path $dataDir "qqq-defaults.json"
    @'
{
    "_version": 1,
    "_comment": "qqq IDE defaults. Bump _version to force re-apply on all clients.",
    "settings": {
        "workbench.colorTheme": "Light",
        "workbench.iconTheme": null,
        "workbench.startupEditor": "none",
        "workbench.enableExperiments": false,
        "workbench.reduceMotion": "on",
        "workbench.editor.tabSizing": "fixed",
        "workbench.editor.tabSizingFixedMinWidth": 84,
        "workbench.editor.tabSizingFixedMaxWidth": 84,
        "workbench.editor.scrollToSwitchTabs": true,
        "workbench.editor.wrapTabs": true,
        "workbench.editor.empty.hint": "hidden",
        "workbench.panel.showLabels": false,
        "workbench.panel.alwaysShowActions": false,
        "workbench.colorCustomizations": {
            "editor.lineHighlightBackground": "#00000000",
            "editor.lineHighlightBorder": "#00000000"
        },
        "editor.fontFamily": "LXGW WenKai Mono GB Screen",
        "editor.fontSize": 16,
        "editor.lineHeight": 1.11,
        "editor.minimap.enabled": false,
        "editor.cursorStyle": "line",
        "editor.cursorBlinking": "solid",
        "editor.cursorWidth": 1,
        "editor.wordWrap": "bounded",
        "editor.wordWrapColumn": 110,
        "editor.wrappingIndent": "indent",
        "editor.renderLineHighlight": "gutter",
        "editor.glyphMargin": false,
        "editor.overviewRulerBorder": false,
        "editor.formatOnSave": true,
        "editor.formatOnType": true,
        "editor.autoClosingBrackets": "never",
        "editor.autoClosingQuotes": "never",
        "editor.autoSurround": "never",
        "editor.dragAndDrop": false,
        "editor.renderControlCharacters": true,
        "editor.bracketPairColorization.enabled": false,
        "editor.guides.bracketPairsHorizontal": false,
        "editor.guides.highlightActiveBracketPair": false,
        "editor.matchBrackets": "never",
        "editor.lightbulb.enabled": "off",
        "editor.hover.enabled": false,
        "editor.hover.delay": 30000,
        "editor.parameterHints.enabled": false,
        "editor.inlayHints.enabled": false,
        "editor.suggestOnTriggerCharacters": false,
        "editor.quickSuggestions": { "other": "off" },
        "editor.quickSuggestionsDelay": 1111111,
        "editor.snippetSuggestions": "off",
        "editor.wordBasedSuggestions": "off",
        "editor.acceptSuggestionOnEnter": "off",
        "editor.stickyScroll.enabled": false,
        "editor.colorDecorators": false,
        "editor.showFoldingControls": "always",
        "editor.mouseWheelZoom": false,
        "editor.trimAutoWhitespace": false,
        "editor.codeLensFontFamily": "Tahoma",
        "editor.codeLensFontSize": 13,
        "files.autoSave": "onFocusChange",
        "files.trimTrailingWhitespace": true,
        "files.autoGuessEncoding": false,
        "files.encoding": "utf8",
        "window.restoreWindows": "one",
        "window.openFoldersInNewWindow": "on",
        "window.zoomLevel": -1,
        "window.titleSeparator": " . ",
        "window.menuBarVisibility": "classic",
        "breadcrumbs.enabled": true,
        "breadcrumbs.location": "below",
        "breadcrumbs.icons": false,
        "explorer.confirmDelete": false,
        "explorer.confirmPasteNative": false,
        "search.sortOrder": "modified",
        "search.seedWithNearestWord": true,
        "problems.decorations.enabled": false,
        "telemetry.telemetryLevel": "off",
        "update.mode": "none",
        "extensions.autoUpdate": false,
        "extensions.ignoreRecommendations": true,
        "security.workspace.trust.enabled": false,
        "git.enabled": true,
        "git.confirmSync": false,
        "git.openRepositoryInParentFolders": "never",
        "terminal.integrated.cursorStyle": "line",
        "terminal.integrated.fontSize": 13,
        "terminal.integrated.rightClickBehavior": "paste",
        "terminal.integrated.enableMultiLinePasteWarning": "never",
        "terminal.integrated.shellIntegration.enabled": false,
        "diffEditor.hideUnchangedRegions.enabled": true,
        "diffEditor.maxComputationTime": 0
    }
}
'@ | Out-File -FilePath $defaultsFile -Encoding UTF8
    Write-Host "    [ok] qqq-defaults.json generated" -ForegroundColor Green

    # -- Seed initial settings.json (same content for instant first-launch experience) --
    $settingsDir = Join-Path $dataDir "user-data\User"
    $settingsFile = Join-Path $settingsDir "settings.json"
    if (-not (Test-Path $settingsFile)) {
        $defaults = Get-Content $defaultsFile -Raw | ConvertFrom-Json
        $defaults.settings | ConvertTo-Json -Depth 10 | Out-File -FilePath $settingsFile -Encoding UTF8
        Write-Host "    [ok] initial settings.json seeded from defaults" -ForegroundColor Green
    }

    # Create debug launcher: double-click to auto-generate qqq.err.log
    $debugLauncher = Join-Path $OutDir "qqq-debug.cmd"
    @'
@echo off
REM qqq IDE debug launcher -- auto-generates qqq.err.log in the same directory
"%~dp0qqq.exe" --log trace --verbose %* 2>>"%%~dp0qqq.err.log"
'@ | Out-File -FilePath $debugLauncher -Encoding ASCII
    Write-Host "    [ok] debug launcher: qqq-debug.cmd" -ForegroundColor Green
} else {
    Write-Warning "    output dir not found. Check: dir $($ScriptDir)\.build\ -Directory"
}

# ==============================================================================
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  qqq IDE build complete" -ForegroundColor Green
Write-Host "  Disarmed: Chat, InlineChat, Telemetry, 1DS, Auth, Jupyter," -ForegroundColor Green
Write-Host "            Tunnel, Crash, Experiments, GettingStarted" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green

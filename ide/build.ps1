# ==============================================================================
# qqq IDE Build Script (post-fork: all surgery now lives in kkn1n/qqq-ide-src)
# Usage: .\build.ps1 [-Target win32-x64] [-ForkRepo kkn1n/qqq-ide-src] [-ForkBranch qqq-main]
# Requires: node 16.14.x, yarn 1.22.x, git, python 3.x, Visual Studio Build Tools (C++)
# ==============================================================================
param(
    [string]$Target = "win32-x64",
    [string]$ForkRepo = "kkn1n/qqq-ide-src",
    [string]$ForkBranch = "qqq-main",
    [string]$ForkToken = $env:QQQ_FORK_TOKEN
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
Write-Host "  qqq IDE build: target=$Target  fork=$ForkRepo@$ForkBranch" -ForegroundColor Cyan
Write-Host "  Cache -> $CacheBase" -ForegroundColor DarkGray
Write-Host "================================================================" -ForegroundColor Cyan

# ==============================================================================
# 1. Clone qqq-ide-src fork (all source surgery already committed in-tree)
# ==============================================================================
$cloneUrl = if ($ForkToken) {
    "https://x-access-token:$ForkToken@github.com/$ForkRepo.git"
} else {
    "https://github.com/$ForkRepo.git"
}

if (-not (Test-Path (Join-Path $BuildDir ".git"))) {
    Write-Host "`n[1/5] Cloning $ForkRepo@$ForkBranch ..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force (Join-Path $ScriptDir ".build") | Out-Null
    git clone --depth 1 --branch $ForkBranch $cloneUrl $BuildDir
} else {
    Write-Host "`n[1/5] $ForkRepo already cloned, fetching latest..." -ForegroundColor Green
    Push-Location $BuildDir
    git fetch origin $ForkBranch --depth 1
    git checkout -- .
    git clean -fd
    git reset --hard "origin/$ForkBranch"
    Pop-Location
}

# ==============================================================================
# 2. Inject pre-bundled qqq-core / qqq-ai extensions into source tree
# ==============================================================================
Write-Host "`n[2/5] Injecting qqq extensions ..." -ForegroundColor Yellow
$extDir = Join-Path $BuildDir "extensions"
New-Item -ItemType Directory -Force (Join-Path $extDir "qqq")    | Out-Null
New-Item -ItemType Directory -Force (Join-Path $extDir "qqq-ai") | Out-Null

$QqqCore = Join-Path $RepoRoot "dist\qqq-core"
if (Test-Path $QqqCore) {
    Copy-Item "$QqqCore\*" (Join-Path $extDir "qqq") -Recurse -Force
    Write-Host "    [ok] qqq core injected" -ForegroundColor Green
} else {
    Write-Warning "    dist\qqq-core not found (skipped)"
}
$QqqAi = Join-Path $RepoRoot "dist\qqq-ai"
if (Test-Path $QqqAi) {
    Copy-Item "$QqqAi\*" (Join-Path $extDir "qqq-ai") -Recurse -Force
    Write-Host "    [ok] qqq-ai injected" -ForegroundColor Green
} else {
    Write-Warning "    dist\qqq-ai not found (skipped)"
}

# ==============================================================================
# 3. yarn install (vscode 1.77 era: yarn 1.x; npm switch was 1.94+)
# ==============================================================================
Write-Host "`n[3/5] yarn install ..." -ForegroundColor Yellow
Push-Location $BuildDir
yarn --frozen-lockfile --network-timeout 600000
Pop-Location

# ==============================================================================
# 4. Compile (gulp produces ../VSCode-$Target/)
# ==============================================================================
Write-Host "`n[4/5] Compiling for $Target ..." -ForegroundColor Yellow
Push-Location $BuildDir
yarn gulp "vscode-$Target"
Pop-Location

# ==============================================================================
# 5. Portable f/ layout (QDIR runtime: ghrun + watchdog + extensions + settings)
# ==============================================================================
Write-Host "`n[5/5] Verifying output + portable f/ ..." -ForegroundColor Yellow
$OutDir = Join-Path $BuildDir "..\..\VSCode-$Target"
if (-not (Test-Path $OutDir)) { $OutDir = Join-Path $BuildDir "..\VSCode-$Target" }
if (-not (Test-Path $OutDir)) { $OutDir = Join-Path $ScriptDir ".build\VSCode-$Target" }

if (-not (Test-Path $OutDir)) {
    Write-Warning "    output dir not found. Check: dir $ScriptDir\.build\ -Directory"
    exit 1
}

$exe = Get-ChildItem $OutDir -Filter "*.exe" -Recurse | Select-Object -First 1
if ($exe) {
    Write-Host "    [ok] executable: $($exe.FullName)" -ForegroundColor Green
}

# Trigger VS Code portable mode: mkdir f/ in artifact root (dataFolderName=f in product.json)
$dataDir = Join-Path $OutDir "f"
foreach ($sub in @("user-data", "user-data\User", "extensions", "components", "goods", "tmp")) {
    New-Item -ItemType Directory -Force (Join-Path $dataDir $sub) | Out-Null
}
"qqq-ide portable build $(Get-Date -Format o) fork=$ForkRepo@$ForkBranch" `
    | Out-File -FilePath (Join-Path $dataDir ".qqq-portable") -Encoding utf8
Write-Host "    [ok] portable f/ created (user-data/extensions/components/goods/tmp)" -ForegroundColor Green

# -- Copy ghrun.exe + watchdog.exe into f/ --
foreach ($bin in @("ghrun.exe", "watchdog.exe")) {
    $src = Join-Path $RepoRoot "dist\$bin"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $dataDir $bin) -Force
        Write-Host "    [ok] $bin -> f/$bin" -ForegroundColor Green
    } else {
        Write-Warning "    dist/$bin not found"
    }
}

# -- Pre-install qqq-core vsix into f/extensions/ --
$vsixFile = Get-ChildItem (Join-Path $RepoRoot "dist") -Filter "*universal*.vsix" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $vsixFile) {
    $vsixFile = Get-ChildItem (Join-Path $RepoRoot "dist") -Filter "qqq-*.vsix" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
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

# -- qqq-ai from ai/dist/ --
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
    Write-Warning "    ai/dist/ not found"
}

# -- qqq-defaults.json (single source of truth for IDE settings) --
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

# -- Seed initial settings.json --
$settingsFile = Join-Path $dataDir "user-data\User\settings.json"
if (-not (Test-Path $settingsFile)) {
    $defaults = Get-Content $defaultsFile -Raw | ConvertFrom-Json
    $defaults.settings | ConvertTo-Json -Depth 10 | Out-File -FilePath $settingsFile -Encoding UTF8
    Write-Host "    [ok] initial settings.json seeded" -ForegroundColor Green
}

# -- Debug launcher --
$debugLauncher = Join-Path $OutDir "qqq-debug.cmd"
@'
@echo off
REM qqq IDE debug launcher -- auto-generates qqq.err.log in the same directory
"%~dp0qqq.exe" --log trace --verbose %* 2>>"%~dp0qqq.err.log"
'@ | Out-File -FilePath $debugLauncher -Encoding ASCII
Write-Host "    [ok] debug launcher: qqq-debug.cmd" -ForegroundColor Green

# ==============================================================================
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  qqq IDE build complete" -ForegroundColor Green
Write-Host "  Source: $ForkRepo@$ForkBranch (all surgery in-tree)" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green

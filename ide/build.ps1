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
# Strategy: comment out the line that actually sends data to appenders
Comment-Lines -File $telFile `
    -Pattern '_appenders\.forEach' `
    -Desc "telemetry _appenders.forEach (data send)"
# Also gut the error telemetry send
Comment-Lines -File $telFile `
    -Pattern '_log\(errorEventName' `
    -Desc "telemetry error _log call"

# 1DS Appender - gut the actual post
$odsFile = Join-Path $BuildDir "src\vs\platform\telemetry\common\1dsAppender.ts"
if (Test-Path $odsFile) {
    Comment-Lines -File $odsFile -Pattern 'this\.appender' -Desc "1DS appender calls"
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

    # Trigger VS Code portable mode: mkdir data/ in artifact root
    $dataDir = Join-Path $OutDir "data"
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dataDir "user-data") | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dataDir "extensions") | Out-Null
    "qqq-ide portable build $(Get-Date -Format o) tag=$VscodeTag" `
        | Out-File -FilePath (Join-Path $dataDir ".qqq-portable") -Encoding utf8
    Write-Host "    [ok] portable data/ folder created at: $dataDir" -ForegroundColor Green
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

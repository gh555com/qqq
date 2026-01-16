

















































































# build.ps1 - Windows 编译脚本
$ErrorActionPreference = "Stop"

Set-Location rust

Write-Host "=== Building Rust daemon ===" -ForegroundColor Cyan

# 确保目标目录存在
New-Item -ItemType Directory -Force -Path ..\assets | Out-Null

# Windows x64
Write-Host "Building Windows x64..." -ForegroundColor Yellow
cargo build --release --target x86_64-pc-windows-msvc --manifest-path Cargo_win.toml
Copy-Item target\x86_64-pc-windows-msvc\release\q.exe ..\assets\q_win_x64.exe -Force
Write-Host "✓ Windows x64 done" -ForegroundColor Green

# Windows ARM64 (如果有 ARM64 工具链)
Write-Host "Building Windows ARM64..." -ForegroundColor Yellow
try {
    cargo build --release --target aarch64-pc-windows-msvc --manifest-path Cargo_win.toml
    Copy-Item target\aarch64-pc-windows-msvc\release\q.exe ..\assets\q_win_arm64.exe -Force
    Write-Host "✓ Windows ARM64 done" -ForegroundColor Green
} catch {
    Write-Host "⚠ Skipping Windows ARM64" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Build complete ===" -ForegroundColor Cyan
Get-ChildItem ..\assets\q_*.exe | Format-Table Name, Length






















































































































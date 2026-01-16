











































































#!/bin/bash
set -e

# cd rust (already in rust directory from publish.yml)

echo "=== Building Rust daemon for all platforms ==="

# 确保目标目录存在
mkdir -p ../assets

# Windows x64 (需要安装 mingw 或在 Windows 上编译)
echo "Building Windows x64..."
if command -v x86_64-w64-mingw32-gcc &> /dev/null; then
    cargo build --release --target x86_64-pc-windows-gnu --manifest-path Cargo_win.toml
    cp target/x86_64-pc-windows-gnu/release/q.exe ../assets/q_win_x64.exe
    echo "✓ Windows x64 done"
else
    echo "⚠ Skipping Windows x64 (no mingw)"
fi

# macOS x64
echo "Building macOS x64..."
if [[ "$(uname)" == "Darwin" ]]; then
    cargo build --release --target x86_64-apple-darwin
    cp target/x86_64-apple-darwin/release/q ../assets/q_mac_x64
    chmod +x ../assets/q_mac_x64
    echo "✓ macOS x64 done"
fi

# macOS ARM64
echo "Building macOS ARM64..."
if [[ "$(uname)" == "Darwin" ]]; then
    cargo build --release --target aarch64-apple-darwin
    cp target/aarch64-apple-darwin/release/q ../assets/q_mac_arm64
    chmod +x ../assets/q_mac_arm64
    echo "✓ macOS ARM64 done"
fi

# Linux x64
echo "Building Linux x64..."
cargo build --release --target x86_64-unknown-linux-gnu
cp target/x86_64-unknown-linux-gnu/release/q ../assets/q_linux_x64
chmod +x ../assets/q_linux_x64
echo "✓ Linux x64 done"

# Linux ARM64
echo "Building Linux ARM64..."
if rustup target list --installed | grep -q aarch64-unknown-linux-gnu; then
    cargo build --release --target aarch64-unknown-linux-gnu
    cp target/aarch64-unknown-linux-gnu/release/q ../assets/q_linux_arm64
    chmod +x ../assets/q_linux_arm64
    echo "✓ Linux ARM64 done"
else
    echo "⚠ Skipping Linux ARM64 (target not installed)"
fi

echo ""
echo "=== Build complete ==="
ls -la ../assets/q_*




























































































































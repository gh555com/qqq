











































































#!/bin/bash
set -e

# cd rust (already in rust directory from publish.yml)

echo "=== Building Rust daemon for GitHub Actions ==="

# 确保目标目录存在
mkdir -p ../assets

# 只编译Linux平台的二进制文件，因为GitHub Actions环境是Ubuntu

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




























































































































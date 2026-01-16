











































































#!/bin/bash
# 移除set -e以便看到完整的错误信息

# cd rust (already in rust directory from publish.yml)

echo "=== Building Rust daemon for GitHub Actions ==="
echo "Current directory: $(pwd)"
echo "Rust version: $(cargo --version)"

# 确保目标目录存在
mkdir -p ../assets

# 只编译Linux x64平台的二进制文件，因为GitHub Actions环境是Ubuntu
echo "Building Linux x64..."
echo "Running: cargo build --release --target x86_64-unknown-linux-gnu"
cargo build --release --target x86_64-unknown-linux-gnu

if [ $? -eq 0 ]; then
    echo "Compilation successful!"
    echo "Copying binary..."
    ls -la target/x86_64-unknown-linux-gnu/release/
    cp target/x86_64-unknown-linux-gnu/release/q ../assets/q_linux_x64
    chmod +x ../assets/q_linux_x64
    echo "✓ Linux x64 done"
else
    echo "Compilation failed!"
    exit 1
fi

echo ""
echo "=== Build complete ==="
ls -la ../assets/q_*




























































































































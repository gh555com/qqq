#!/usr/bin/env bash
# qqq IDE Build Script — Code-OSS fork
# Usage: ./build.sh [linux-x64|darwin-x64|darwin-arm64]
# Requires: node 20+, yarn, git, python3
set -euo pipefail

VSCODE_TAG="${VSCODE_TAG:-1.96.4}"  # lock to tested version
TARGET="${1:-linux-x64}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$SCRIPT_DIR/.build/code-oss"

echo "=== qqq IDE build: target=$TARGET vscode=$VSCODE_TAG ==="

# ── 1. Clone Code-OSS (shallow, tag-pinned) ──────────────────────────────────
if [ ! -d "$BUILD_DIR/.git" ]; then
    echo "[1/6] Cloning Code-OSS $VSCODE_TAG..."
    mkdir -p "$SCRIPT_DIR/.build"
    git clone --depth 1 --branch "$VSCODE_TAG" \
        https://github.com/microsoft/vscode.git "$BUILD_DIR"
else
    echo "[1/6] Code-OSS already cloned, skipping."
fi

# ── 2. Apply patches ─────────────────────────────────────────────────────────
echo "[2/6] Applying patches..."
cd "$BUILD_DIR"
git checkout -- .   # reset any previous patch attempts
for patch in "$SCRIPT_DIR/patches/"*.patch; do
    [ -f "$patch" ] || continue
    echo "  applying: $(basename "$patch")"
    git apply --ignore-whitespace "$patch"
done

# ── 3. Overlay product.json ───────────────────────────────────────────────────
echo "[3/6] Overlaying product.json..."
python3 "$SCRIPT_DIR/scripts/merge_product.py" \
    "$BUILD_DIR/product.json" \
    "$SCRIPT_DIR/product.json" \
    "$BUILD_DIR/product.json"

# ── 4. Inject pre-bundled extensions ─────────────────────────────────────────
echo "[4/6] Injecting extensions..."
mkdir -p "$BUILD_DIR/extensions/qqq" "$BUILD_DIR/extensions/qqq-ai"
# qqq-core
if [ -d "$REPO_ROOT/dist/qqq-core" ]; then
    cp -r "$REPO_ROOT/dist/qqq-core/." "$BUILD_DIR/extensions/qqq/"
else
    echo "  WARN: dist/qqq-core not found; run 'npm run bundle' first"
fi
# qqq-ai
if [ -d "$REPO_ROOT/dist/qqq-ai" ]; then
    cp -r "$REPO_ROOT/dist/qqq-ai/." "$BUILD_DIR/extensions/qqq-ai/"
else
    echo "  WARN: dist/qqq-ai not found; run 'cd ai && npm run bundle' first"
fi

# ── 5. Install deps + Compile ─────────────────────────────────────────────────
echo "[5/6] Installing dependencies (this takes ~3 min on first run)..."
cd "$BUILD_DIR"
yarn --frozen-lockfile

echo "[6/6] Compiling for $TARGET..."
case "$TARGET" in
    linux-x64)   yarn gulp vscode-linux-x64 ;;
    darwin-x64)  yarn gulp vscode-darwin-x64 ;;
    darwin-arm64) yarn gulp vscode-darwin-arm64 ;;
    *)           echo "Unknown target: $TARGET"; exit 1 ;;
esac

# ── Done ──────────────────────────────────────────────────────────────────────
OUT_DIR="$BUILD_DIR/.build/VSCode-${TARGET^}"
echo ""
echo "=== Build complete ==="
echo "Output: $OUT_DIR"
echo ""
echo "Next steps:"
echo "  1. Test: open $OUT_DIR/qqq (or qqq.app on macOS)"
echo "  2. Package: ./scripts/package.sh $TARGET"
echo "  3. Upload to R2: ./scripts/upload.sh $TARGET"

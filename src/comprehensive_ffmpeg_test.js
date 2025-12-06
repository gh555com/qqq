// comprehensive_ffmpeg_test.js
// 全面测试 FFmpeg 在不同环境下的兼容性

console.log("Starting comprehensive FFmpeg test...");

// 测试 1: 检查包是否安装
console.log("\n=== Test 1: Checking package installation ===");
try {
    const ffmpegPath = require.resolve("@ffmpeg/ffmpeg");
    const corePath = require.resolve("@ffmpeg/core");
    console.log("✓ @ffmpeg/ffmpeg installed at:", ffmpegPath);
    console.log("✓ @ffmpeg/core installed at:", corePath);
} catch (e) {
    console.log("✗ Package installation check failed:", e.message);
    process.exit(1);
}

// 测试 2: 尝试不同的导入方式
console.log("\n=== Test 2: Trying different import methods ===");
let createFFmpeg, fetchFile;
try {
    // 方法 1: 默认导入
    const ffmpegModule = require("@ffmpeg/ffmpeg");
    createFFmpeg = ffmpegModule.createFFmpeg;
    fetchFile = ffmpegModule.fetchFile;
    console.log("✓ Method 1 (default import) successful");
} catch (e1) {
    console.log("✗ Method 1 failed:", e1.message);
    try {
        // 方法 2: 解构导入
        const imported = require("@ffmpeg/ffmpeg");
        createFFmpeg = imported.createFFmpeg;
        fetchFile = imported.fetchFile;
        console.log("✓ Method 2 (destructuring import) successful");
    } catch (e2) {
        console.log("✗ Method 2 failed:", e2.message);
        try {
            // 方法 3: 分别导入
            createFFmpeg = require("@ffmpeg/ffmpeg").createFFmpeg;
            fetchFile = require("@ffmpeg/ffmpeg").fetchFile;
            console.log("✓ Method 3 (separate imports) successful");
        } catch (e3) {
            console.log("✗ Method 3 failed:", e3.message);
            process.exit(1);
        }
    }
}

// 测试 3: 尝试不同的 corePath 解析方式
console.log("\n=== Test 3: Trying different corePath resolution methods ===");
let corePath;
try {
    corePath = require.resolve("@ffmpeg/core/dist/ffmpeg-core.js");
    console.log("✓ Core path resolved (method 1):", corePath);
} catch (e1) {
    console.log("✗ Method 1 failed:", e1.message);
    try {
        corePath = require.resolve("@ffmpeg/core/dist/umd/ffmpeg-core.js");
        console.log("✓ Core path resolved (method 2):", corePath);
    } catch (e2) {
        console.log("✗ Method 2 failed:", e2.message);
        try {
            corePath = require.resolve("@ffmpeg/core");
            console.log("✓ Core path resolved (method 3):", corePath);
        } catch (e3) {
            console.log("✗ Method 3 failed:", e3.message);
            corePath = null;
        }
    }
}

// 测试 4: 创建 FFmpeg 实例
console.log("\n=== Test 4: Creating FFmpeg instance ===");
if (corePath) {
    try {
        const ffmpeg = createFFmpeg({
            log: true,
            corePath: corePath
        });
        console.log("✓ FFmpeg instance created successfully");

        // 测试 5: 尝试加载 FFmpeg
        console.log("\n=== Test 5: Attempting to load FFmpeg ===");
        ffmpeg.load().then(() => {
            console.log("✓ FFmpeg loaded successfully");
            console.log("=== All tests completed successfully! ===");
        }).catch((e) => {
            console.log("✗ Failed to load FFmpeg:", e.message);
            console.log("=== Tests completed with partial success ===");
        });
    } catch (e) {
        console.log("✗ Failed to create FFmpeg instance:", e.message);
        console.log("=== Tests completed with failures ===");
    }
} else {
    console.log("✗ Skipping FFmpeg instance creation due to unresolved corePath");
    console.log("=== Tests completed with partial success ===");
}
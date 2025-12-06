// final_test.js
// 最终测试脚本，验证 FFmpeg 问题的解决情况

console.log("Starting final test for FFmpeg integration...");

// 检查是否安装了必要的包
try {
    require.resolve("@ffmpeg/ffmpeg");
    require.resolve("@ffmpeg/core");
    console.log("✓ Both @ffmpeg/ffmpeg and @ffmpeg/core are installed");
} catch (e) {
    console.log("✗ Missing required packages:", e.message);
    process.exit(1);
}

// 尝试导入 FFmpeg
let ffmpeg, ffmpegUtils;
try {
    const { createFFmpeg, fetchFile } = require("@ffmpeg/ffmpeg");
    console.log("✓ Successfully imported FFmpeg modules");

    // 尝试解析 corePath
    let corePath;
    try {
        corePath = require.resolve("@ffmpeg/core/dist/ffmpeg-core.js");
        console.log("✓ Resolved corePath:", corePath);
    } catch (e) {
        console.log("✗ Failed to resolve corePath:", e.message);
        process.exit(1);
    }

    // 创建 FFmpeg 实例
    try {
        ffmpeg = createFFmpeg({
            log: false,
            corePath: corePath,
        });
        ffmpegUtils = { fetchFile };
        console.log("✓ FFmpeg instance created successfully");
    } catch (e) {
        console.log("✗ Failed to create FFmpeg instance:", e.message);
        process.exit(1);
    }
} catch (e) {
    console.log("✗ Error importing FFmpeg:", e.message);
    process.exit(1);
}

console.log("\n=== Test Results ===");
console.log("FFmpeg availability check:");
console.log("- FFmpeg instance:", ffmpeg ? "Available" : "Not available");
console.log("- FFmpeg utilities:", ffmpegUtils ? "Available" : "Not available");

if (ffmpeg && ffmpegUtils) {
    console.log("\n✓ FFmpeg integration appears to be working correctly");
    console.log("The extension should now be able to generate video thumbnails");
} else {
    console.log("\n⚠ FFmpeg integration has issues");
    console.log("The extension will skip video thumbnail generation");
}

console.log("\n=== Final Test Completed ===");
// test_ffmpeg_simple.js
// 简化版 FFmpeg 测试脚本

// 检查是否安装了必要的包
try {
    require.resolve("@ffmpeg/ffmpeg");
    require.resolve("@ffmpeg/core");
    console.log("Both @ffmpeg/ffmpeg and @ffmpeg/core are installed");
} catch (e) {
    console.log("Missing required packages:", e.message);
    process.exit(1);
}

// 尝试导入并创建 FFmpeg 实例
try {
    const { createFFmpeg } = require("@ffmpeg/ffmpeg");
    console.log("Successfully imported createFFmpeg");

    // 使用最简单的配置
    const ffmpeg = createFFmpeg({
        log: true,
    });
    console.log("FFmpeg instance created with default config");

    // 尝试加载
    ffmpeg.load().then(() => {
        console.log("FFmpeg loaded successfully!");
    }).catch((e) => {
        console.log("Failed to load FFmpeg:", e.message);
    });
} catch (e) {
    console.log("Error importing or creating FFmpeg:", e.message);
}
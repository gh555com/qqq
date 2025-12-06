// test_ffmpeg.js
console.log("Starting FFmpeg test...");

try {
    const { createFFmpeg, fetchFile } = require("@ffmpeg/ffmpeg");
    console.log("Successfully imported @ffmpeg/ffmpeg");

    // 尝试不同的路径解析方式
    let corePath;
    try {
        // 优先使用默认导出
        corePath = require.resolve("@ffmpeg/core/dist/ffmpeg-core.js");
        console.log("Resolved corePath (method 1):", corePath);
    } catch (e1) {
        console.log("Failed to resolve @ffmpeg/core/dist/ffmpeg-core.js:", e1.message);
        try {
            corePath = require.resolve("@ffmpeg/core");
            console.log("Resolved corePath (method 2):", corePath);
        } catch (e2) {
            console.log("Failed to resolve @ffmpeg/core:", e2.message);
        }
    }

    if (corePath) {
        console.log("Using corePath:", corePath);
        const ffmpeg = createFFmpeg({
            log: true,  // 启用日志以便查看更多信息
            corePath: corePath,
        });
        console.log("FFmpeg instance created successfully");

        // 测试加载
        ffmpeg.load().then(() => {
            console.log("FFmpeg loaded successfully");
        }).catch((e) => {
            console.log("Failed to load FFmpeg:", e.message);
            console.log("Error stack:", e.stack);
        });
    } else {
        console.log("Could not resolve corePath");
    }
} catch (e) {
    console.log("Failed to import or create FFmpeg instance:", e.message);
    console.log("Stack trace:", e.stack);
}
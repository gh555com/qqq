const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

// 导入要测试的函数
const {
    getFileSizeDisplayAsync,
    formatFileSize,
    getSizeFromPython
} = require("./q2.js");

// 测试文件大小获取
async function testFileSizeCalculation() {
    console.log("开始测试文件大小计算功能...\n");

    // 测试1: 文件大小获取
    console.log("测试1: 文件大小获取");
    try {
        const testFilePath = __filename; // 使用当前文件作为测试文件
        const sizeDisplay = await getFileSizeDisplayAsync(testFilePath, "k");
        console.log(`文件大小显示 (k模式): ${sizeDisplay}`);
        
        const sizeDisplayM = await getFileSizeDisplayAsync(testFilePath, "m");
        console.log(`文件大小显示 (m模式): ${sizeDisplayM}`);
        
        const sizeDisplayB = await getFileSizeDisplayAsync(testFilePath, "b");
        console.log(`文件大小显示 (b模式): ${sizeDisplayB}`);
    } catch (error) {
        console.error("文件大小获取测试失败:", error);
    }

    // 测试2: 文件夹大小获取
    console.log("\n测试2: 文件夹大小获取");
    try {
        const testDirPath = __dirname; // 使用当前目录作为测试目录
        const dirSizeDisplay = await getFileSizeDisplayAsync(testDirPath, "k");
        console.log(`文件夹大小显示 (k模式): ${dirSizeDisplay}`);
        
        const dirSizeDisplayM = await getFileSizeDisplayAsync(testDirPath, "m");
        console.log(`文件夹大小显示 (m模式): ${dirSizeDisplayM}`);
    } catch (error) {
        console.error("文件夹大小获取测试失败:", error);
    }

    // 测试3: none模式
    console.log("\n测试3: none模式");
    try {
        const noneDisplay = await getFileSizeDisplayAsync(__filename, "none");
        console.log(`none模式显示: "${noneDisplay}" (应该为空字符串)`);
        console.log(noneDisplay === "" ? "✅ none模式测试通过" : "❌ none模式测试失败");
    } catch (error) {
        console.error("none模式测试失败:", error);
    }

    // 测试4: 错误处理
    console.log("\n测试4: 错误处理");
    try {
        const errorDisplay = await getFileSizeDisplayAsync("不存在的路径.txt", "k");
        console.log(`不存在路径的显示: "${errorDisplay}" (应该为错误指示符)`);
        console.log(errorDisplay.includes("err") ? "✅ 错误处理测试通过" : "❌ 错误处理测试失败");
    } catch (error) {
        console.error("错误处理测试失败:", error);
    }

    console.log("\n测试完成!");
}

// 运行测试
testFileSizeCalculation().catch(console.error);
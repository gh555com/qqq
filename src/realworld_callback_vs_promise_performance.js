const fs = require('fs');
const path = require('path');

// 模拟formatFileSize函数
function formatFileSize(bytes, mode) {
    if (mode === "none") {
        return { size: "", unit: "" };
    }

    let size, unit;

    switch (mode) {
        case "m":
            size = (bytes / (1024 * 1024)).toFixed(0);
            unit = "m";
            break;
        case "k":
            size = (bytes / 1024).toFixed(0);
            unit = "k";
            break;
        case "b":
            size = bytes.toString();
            unit = "b";
            break;
        default:
            size = "";
            unit = "";
    }

    return { size, unit };
}

// 获取测试文件列表
function getTestFiles() {
    const testDir = __dirname;
    const files = fs.readdirSync(testDir);
    return files.slice(0, 10).map(file => path.join(testDir, file));
}

// 回调风格的实现（模拟我们的实际实现）
function getFileSizeDisplayCallback(itemPath, mode, callback) {
    // 'none' 模式直接返回空字符串
    if (mode === "none") {
        callback("");
        return;
    }

    // 检查是文件还是文件夹
    fs.stat(itemPath, (err, stats) => {
        if (err) {
            callback(" ...err ");
            return;
        }

        // 根据类型选择计算方法
        if (stats.isFile()) {
            // 文件：直接使用已获取的stats.size
            const sizeInBytes = stats.size;
            
            // 格式化文件大小
            const { size: displaySize, unit: displayUnit } = formatFileSize(sizeInBytes, mode);

            // 计算需要填充的空格数（右对齐）
            let spacesToFill = 0;
            if (displayUnit === "m") {
                spacesToFill = 0;
            } else if (displayUnit === "k") {
                spacesToFill = 3;
            } else if (displayUnit === "b") {
                spacesToFill = 6;
            }

            // 生成最终显示字符串： [基准空格][数值][空格][单位]
            const finalDisplay =
                " ".repeat(spacesToFill) + displaySize + " " + displayUnit;

            callback(finalDisplay);
        } else {
            // 文件夹：模拟调用 Python 接口（这里简化为直接计算）
            try {
                const files = fs.readdirSync(itemPath);
                let totalSize = 0;
                
                for (const file of files) {
                    const filePath = path.join(itemPath, file);
                    const fileStats = fs.statSync(filePath);
                    if (fileStats.isFile()) {
                        totalSize += fileStats.size;
                    }
                }
                
                // 格式化文件大小
                const { size: displaySize, unit: displayUnit } = formatFileSize(totalSize, mode);

                // 计算需要填充的空格数（右对齐）
                let spacesToFill = 0;
                if (displayUnit === "m") {
                    spacesToFill = 0;
                } else if (displayUnit === "k") {
                    spacesToFill = 3;
                } else if (displayUnit === "b") {
                    spacesToFill = 6;
                }

                // 生成最终显示字符串： [基准空格][数值][空格][单位]
                const finalDisplay =
                    " ".repeat(spacesToFill) + displaySize + " " + displayUnit;

                callback(finalDisplay);
            } catch (error) {
                callback(" ...err ");
            }
        }
    });
}

// Promise风格的实现（模拟我们的实际实现）
function getFileSizeDisplayPromise(itemPath, mode) {
    return new Promise((resolve, reject) => {
        // 'none' 模式直接返回空字符串
        if (mode === "none") {
            resolve("");
            return;
        }

        // 检查是文件还是文件夹
        fs.stat(itemPath, (err, stats) => {
            if (err) {
                resolve(" ...err ");
                return;
            }

            // 根据类型选择计算方法
            if (stats.isFile()) {
                // 文件：直接使用已获取的stats.size
                const sizeInBytes = stats.size;
                
                // 格式化文件大小
                const { size: displaySize, unit: displayUnit } = formatFileSize(sizeInBytes, mode);

                // 计算需要填充的空格数（右对齐）
                let spacesToFill = 0;
                if (displayUnit === "m") {
                    spacesToFill = 0;
                } else if (displayUnit === "k") {
                    spacesToFill = 3;
                } else if (displayUnit === "b") {
                    spacesToFill = 6;
                }

                // 生成最终显示字符串： [基准空格][数值][空格][单位]
                const finalDisplay =
                    " ".repeat(spacesToFill) + displaySize + " " + displayUnit;

                resolve(finalDisplay);
            } else {
                // 文件夹：模拟调用 Python 接口（这里简化为直接计算）
                try {
                    const files = fs.readdirSync(itemPath);
                    let totalSize = 0;
                    
                    for (const file of files) {
                        const filePath = path.join(itemPath, file);
                        const fileStats = fs.statSync(filePath);
                        if (fileStats.isFile()) {
                            totalSize += fileStats.size;
                        }
                    }
                    
                    // 格式化文件大小
                    const { size: displaySize, unit: displayUnit } = formatFileSize(totalSize, mode);

                    // 计算需要填充的空格数（右对齐）
                    let spacesToFill = 0;
                    if (displayUnit === "m") {
                        spacesToFill = 0;
                    } else if (displayUnit === "k") {
                        spacesToFill = 3;
                    } else if (displayUnit === "b") {
                        spacesToFill = 6;
                    }

                    // 生成最终显示字符串： [基准空格][数值][空格][单位]
                    const finalDisplay =
                        " ".repeat(spacesToFill) + displaySize + " " + displayUnit;

                    resolve(finalDisplay);
                } catch (error) {
                    resolve(" ...err ");
                }
            }
        });
    });
}

// 实际使用场景的性能测试
async function realWorldPerformanceTest() {
    const testFiles = getTestFiles();
    const iterations = 100; // 迭代次数
    
    console.log(`开始实际使用场景性能测试，迭代次数: ${iterations}`);
    console.log(`测试文件数量: ${testFiles.length}`);
    console.log('');
    
    // 测试回调风格 - 模拟VSCode扩展中的实际使用
    console.time('回调风格-实际场景总耗时');
    for (let i = 0; i < iterations; i++) {
        // 模拟同时处理多个文件大小
        const promises = testFiles.map(file => {
            return new Promise(resolve => {
                getFileSizeDisplayCallback(file, "k", () => {
                    resolve();
                });
            });
        });
        
        await Promise.all(promises);
    }
    console.timeEnd('回调风格-实际场景总耗时');
    
    // 测试Promise风格 - 模拟VSCode扩展中的实际使用
    console.time('Promise风格-实际场景总耗时');
    for (let i = 0; i < iterations; i++) {
        // 模拟同时处理多个文件大小
        const promises = testFiles.map(file => {
            return getFileSizeDisplayPromise(file, "k");
        });
        
        await Promise.all(promises);
    }
    console.timeEnd('Promise风格-实际场景总耗时');
    
    console.log('');
    console.log('性能测试完成');
}

// 运行测试
realWorldPerformanceTest().catch(console.error);
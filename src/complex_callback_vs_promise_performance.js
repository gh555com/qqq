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

// 测试文件路径
const testFile = __filename; // 使用当前文件作为测试对象
const testDir = __dirname; // 使用当前目录作为测试对象

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

// 性能测试函数
async function performanceTest() {
    const iterations = 5000; // 迭代次数，减少因为文件夹计算比较耗时
    
    console.log(`开始复杂性能测试，迭代次数: ${iterations}`);
    console.log('测试文件:', testFile);
    console.log('测试目录:', testDir);
    console.log('');
    
    // 测试回调风格 - 文件
    console.time('回调风格-文件总耗时');
    for (let i = 0; i < iterations; i++) {
        await new Promise(resolve => {
            getFileSizeDisplayCallback(testFile, "k", () => {
                resolve();
            });
        });
    }
    console.timeEnd('回调风格-文件总耗时');
    
    // 测试Promise风格 - 文件
    console.time('Promise风格-文件总耗时');
    for (let i = 0; i < iterations; i++) {
        await getFileSizeDisplayPromise(testFile, "k");
    }
    console.timeEnd('Promise风格-文件总耗时');
    
    console.log('');
    
    // 测试回调风格 - 文件夹
    console.time('回调风格-文件夹总耗时');
    for (let i = 0; i < iterations; i++) {
        await new Promise(resolve => {
            getFileSizeDisplayCallback(testDir, "k", () => {
                resolve();
            });
        });
    }
    console.timeEnd('回调风格-文件夹总耗时');
    
    // 测试Promise风格 - 文件夹
    console.time('Promise风格-文件夹总耗时');
    for (let i = 0; i < iterations; i++) {
        await getFileSizeDisplayPromise(testDir, "k");
    }
    console.timeEnd('Promise风格-文件夹总耗时');
    
    console.log('');
    console.log('性能测试完成');
}

// 运行测试
performanceTest().catch(console.error);
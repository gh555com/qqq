const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// 从q2.js复制的函数
async function getSizeFromPython(paths) {
    return new Promise((resolve, reject) => {
        const pythonProcess = spawn("python", ["-c", `
import os
import json

def get_folder_size(folder_path):
    total_size = 0
    for dirpath, dirnames, filenames in os.walk(folder_path):
        for filename in filenames:
            file_path = os.path.join(dirpath, filename)
            if os.path.exists(file_path):
                total_size += os.path.getsize(file_path)
    return total_size

paths = ${JSON.stringify(paths)}
sizes = []
for path_item in paths:
    try:
        if os.path.exists(path_item):
            if os.path.isfile(path_item):
                sizes.append(os.path.getsize(path_item))
            elif os.path.isdir(path_item):
                sizes.append(get_folder_size(path_item))
            else:
                sizes.append(0)
        else:
            sizes.append(0)
    except:
        sizes.append(0)
print(json.dumps(sizes))
        `]);
        
        let data = "";
        pythonProcess.stdout.on("data", (chunk) => {
            data += chunk;
        });
        
        pythonProcess.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`Python process exited with code ${code}`));
                return;
            }
            
            try {
                const sizes = JSON.parse(data.trim());
                resolve(sizes[0] || 0);
            } catch (err) {
                reject(err);
            }
        });
        
        pythonProcess.on("error", (err) => {
            reject(err);
        });
    });
}

function formatFileSize(sizeInBytes, mode) {
    if (mode === "none") {
        return { size: "", unit: "" };
    }
    
    if (sizeInBytes === 0) {
        return mode === "b" ? { size: "0", unit: "b" } : { size: "0", unit: "k" };
    }
    
    let size, unit;
    
    if (mode === "k") {
        const k = sizeInBytes / 1024;
        if (k < 1024) {
            size = k.toFixed(0);
            unit = "k";
        } else {
            size = (k / 1024).toFixed(1);
            unit = "m";
        }
    } else if (mode === "m") {
        size = (sizeInBytes / (1024 * 1024)).toFixed(1);
        unit = "m";
    } else if (mode === "b") {
        size = sizeInBytes.toFixed(0);
        unit = "b";
    }
    
    return { size, unit };
}

function logMessage(message, level) {
    console.log(`[${level}] ${message}`);
}

/**
 * ✅ 5. 重构: 异步获取文件大小显示字符串, 文件使用fs.stat()，文件夹使用Python接口
 * @param {string} itemPath - 文件或文件夹路径
 * @param {string} mode - 显示模式
 * @param {function(string): void} callback - 回调函数，接收格式化后的大小字符串
 */
function getFileSizeDisplayAsync(itemPath, mode, callback) {
    // 'none' 模式直接返回空字符串
    if (mode === "none") {
        callback("");
        return;
    }

    // 检查是文件还是文件夹
    fs.stat(itemPath, (err, stats) => {
        if (err) {
            // 如果文件/文件夹不存在，返回错误指示符
            console.log(`[ERROR] 计算大小失败: ${path.basename(itemPath)} - ${err.message}`);
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
            // 文件夹：调用 Python 接口
            getSizeFromPython([itemPath])
                .then(sizeInBytes => {
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
                })
                .catch(error => {
                    // 如果计算失败，记录日志并返回一个错误指示符
                    console.log(`[ERROR] 计算大小失败: ${path.basename(itemPath)} - ${error.message}`);
                    callback(" ...err ");
                });
        }
    });
}

// 测试函数
async function testRequirements() {
    console.log("测试要求实现情况...\n");
    
    // 测试1: 文件大小获取（使用fs.stat）
    console.log("测试1: 文件大小获取（应该使用fs.stat）");
    const testFilePath = __filename;
    
    getFileSizeDisplayAsync(testFilePath, "k", (result) => {
        console.log(`文件大小显示 (k模式): ${result}`);
        
        getFileSizeDisplayAsync(testFilePath, "m", (resultM) => {
            console.log(`文件大小显示 (m模式): ${resultM}`);
            
            getFileSizeDisplayAsync(testFilePath, "b", (resultB) => {
                console.log(`文件大小显示 (b模式): ${resultB}`);
                
                // 测试2: 文件夹大小获取（应该使用Python）
                console.log("\n测试2: 文件夹大小获取（应该使用Python）");
                const testDirPath = __dirname;
                
                getFileSizeDisplayAsync(testDirPath, "k", (dirResult) => {
                    console.log(`文件夹大小显示 (k模式): ${dirResult}`);
                    
                    getFileSizeDisplayAsync(testDirPath, "m", (dirResultM) => {
                        console.log(`文件夹大小显示 (m模式): ${dirResultM}`);
                        
                        // 测试3: none模式
                        console.log("\n测试3: none模式");
                        getFileSizeDisplayAsync(__filename, "none", (noneResult) => {
                            console.log(`none模式显示: "${noneResult}" (应该为空字符串)`);
                            if (noneResult === "") {
                                console.log("✅ none模式测试通过");
                            } else {
                                console.log("❌ none模式测试失败");
                            }
                            
                            // 测试4: 错误处理
                            console.log("\n测试4: 错误处理");
                            getFileSizeDisplayAsync("不存在的路径.txt", "k", (errorResult) => {
                                console.log(`不存在路径的显示: "${errorResult}" (应该为错误指示符)`);
                                if (errorResult.includes("err")) {
                                    console.log("✅ 错误处理测试通过");
                                } else {
                                    console.log("❌ 错误处理测试失败");
                                }
                                
                                console.log("\n测试完成!");
                            });
                        });
                    });
                });
            });
        });
    });
}

// 运行测试
testRequirements();
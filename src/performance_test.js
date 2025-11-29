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
        return "";
    }
    
    if (sizeInBytes === 0) {
        return mode === "b" ? "       0 b" : "   0 k";
    }
    
    const k = sizeInBytes / 1024;
    const m = k / 1024;
    
    let displaySize, displayUnit;
    
    if (mode === "k") {
        if (k < 1024) {
            displaySize = k.toFixed(0);
            displayUnit = "k";
        } else {
            displaySize = m.toFixed(1);
            displayUnit = "m";
        }
    } else if (mode === "m") {
        displaySize = m.toFixed(1);
        displayUnit = "m";
    } else if (mode === "b") {
        displaySize = sizeInBytes.toFixed(0);
        displayUnit = "b";
    }
    
    // 根据单位添加空格
    let spaces = "";
    if (displayUnit === "m") {
        spaces = "  ";
    } else if (displayUnit === "k") {
        spaces = "   ";
    } else if (displayUnit === "b") {
        spaces = "       ";
    }
    
    return spaces + displaySize + " " + displayUnit;
}

// 旧方案：使用缓存
let fileSizeCache = {};

async function getFileSizeDisplayOld(itemPath, mode) {
    const cacheKey = `${itemPath}:${mode}`;
    
    // 检查缓存
    if (fileSizeCache[cacheKey]) {
        return fileSizeCache[cacheKey];
    }
    
    try {
        // 获取大小（总是调用Python）
        const sizeInBytes = await getSizeFromPython([itemPath]);
        const formattedSize = formatFileSize(sizeInBytes, mode);
        
        // 存入缓存
        fileSizeCache[cacheKey] = formattedSize;
        
        return formattedSize;
    } catch (err) {
        return " ...err ";
    }
}

// 新方案：文件直接使用fs.stat，文件夹使用Python
async function getFileSizeDisplayNew(itemPath, mode) {
    if (mode === "none") {
        return "";
    }
    
    try {
        // 检查是文件还是文件夹
        const isFile = await new Promise((resolve, reject) => {
            fs.stat(itemPath, (err, stats) => {
                if (err) {
                    // 如果文件/文件夹不存在，直接拒绝Promise
                    reject(err);
                } else {
                    resolve(stats.isFile());
                }
            });
        });

        let sizeInBytes;

        if (isFile) {
            // 文件：使用 fs.stat() 异步获取大小
            sizeInBytes = await new Promise((resolve, reject) => {
                fs.stat(itemPath, (err, stats) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(stats.size);
                    }
				});
			});
		} else {
			// 文件夹：调用 Python 接口
			sizeInBytes = await getSizeFromPython([itemPath]);
		}

		const formattedSize = formatFileSize(sizeInBytes, mode);
		return formattedSize;
	} catch (err) {
		return " ...err ";
	}
}

// 性能测试
async function performanceTest() {
    // 获取当前目录下的所有文件和文件夹
    const currentDir = "e:\\s\\wol\\py\\q3\\src";
    const items = fs.readdirSync(currentDir);
    
    // 过滤出前10个文件/文件夹进行测试
    const testFiles = items.slice(0, 10).map(item => path.join(currentDir, item));
    
    const iterations = 3; // 每个测试重复次数
    const mode = "k";
    
    console.log("性能测试开始...");
    console.log(`测试文件: ${testFiles.map(f => path.basename(f)).join(", ")}`);
    console.log(`重复次数: ${iterations}`);
    console.log(`模式: ${mode}`);
    console.log("----------------------------------");
    
    // 测试旧方案
    console.log("测试旧方案（缓存）...");
    const oldStartTime = Date.now();
    
    for (let i = 0; i < iterations; i++) {
        for (const file of testFiles) {
            await getFileSizeDisplayOld(file, mode);
        }
    }
    
    const oldEndTime = Date.now();
    const oldDuration = oldEndTime - oldStartTime;
    
    // 清空缓存，确保新方案测试公平
    fileSizeCache = {};
    
    // 测试新方案
    console.log("测试新方案（文件使用fs.stat）...");
    const newStartTime = Date.now();
    
    for (let i = 0; i < iterations; i++) {
        for (const file of testFiles) {
            await getFileSizeDisplayNew(file, mode);
        }
    }
    
    const newEndTime = Date.now();
    const newDuration = newEndTime - newStartTime;
    
    // 输出结果
    console.log("----------------------------------");
    console.log(`旧方案总耗时: ${oldDuration}ms`);
    console.log(`新方案总耗时: ${newDuration}ms`);
    console.log(`性能提升: ${((oldDuration - newDuration) / oldDuration * 100).toFixed(2)}%`);
    
    // 单次平均耗时
    const oldAvg = oldDuration / (iterations * testFiles.length);
    const newAvg = newDuration / (iterations * testFiles.length);
    
    console.log(`旧方案单次平均耗时: ${oldAvg.toFixed(2)}ms`);
    console.log(`新方案单次平均耗时: ${newAvg.toFixed(2)}ms`);
}

// 运行性能测试
performanceTest().catch(console.error);
const cp = require("child_process");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// 从q2.js复制的函数，用于测试
const LOG_PATH = "D:\\view\\p\\kp.log";

function logMessage(message, level = "WARN") {
	if (level !== "ERROR" && level !== "WARN") return;
	const ts = new Date().toISOString();
	const line = `[${ts}] [${level}] ${message}\n`;
	try {
		fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
		fs.appendFileSync(LOG_PATH, line);
	} catch (e) {
		console.error("日志写入失败:", e);
	}
}

function getSizeFromPython(paths) {
	return new Promise((resolve, reject) => {
		const pythonExecutable = 'python';
		const scriptPath = path.join(__dirname, 'kp.py');
		const args = ['get_size', ...paths];

		const pyProcess = spawn(pythonExecutable, [scriptPath, ...args]);

		let stdoutData = '';
		let stderrData = '';

		pyProcess.stdout.on('data', (data) => {
			stdoutData += data.toString();
		});

		pyProcess.stderr.on('data', (data) => {
			stderrData += data.toString();
		});

		pyProcess.on('close', (code) => {
			if (code === 0) {
				try {
					const result = JSON.parse(stdoutData.trim());
					if (result.success) {
						resolve(result.total_size);
					} else {
						reject(new Error(`Python脚本执行失败: ${result.error || '未知错误'}`));
					}
				} catch (parseError) {
					reject(new Error(`解析Python输出失败: ${parseError.message}\nOutput: ${stdoutData}`));
				}
			} else {
				reject(new Error(`Python脚本以非零代码 ${code} 退出。\nStderr: ${stderrData}`));
			}
		});

		pyProcess.on('error', (err) => {
			reject(new Error(`启动Python进程失败: ${err.message}`));
		});
	});
}

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

// 新的文件大小获取函数
async function getFileSizeDisplayAsync(itemPath, mode) {
	// 'none' 模式直接返回空字符串
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

		return finalDisplay;

	} catch (error) {
		// 如果计算失败，记录日志并返回一个错误指示符
		logMessage(`计算大小失败: ${itemPath} - ${error.message}`, "ERROR");
		return " ...err ";
	}
}

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
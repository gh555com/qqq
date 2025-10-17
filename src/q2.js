const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const trash = require("trash"); // ✅ 1. 引入 trash 包

// ==================== q2 模块变量 ====================

// 公共配置常量
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const CONFIG_PATH = "E:\\r\\pz.ini";
const SIZE_CONFIG_KEY = "size_mode";

/**
 * 日志记录函数
 * @param {string} message - 日志消息
 * @param {string} level - 日志级别 (ERROR, WARN)
 */
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

// 全局变量，用于跟踪是否已打开一个窗口
let activePanel = null;

// 面板焦点控制开关：0-不使用panel.reveal，1-使用panel.reveal
const usePanelReveal = 1;

// 文件大小缓存 (键为完整路径，值为 {size: number, unit: string, isFolderTotal: boolean})
let fileSizeCache = {};
// 正在进行的异步计算，防止重复计算（键为文件夹路径）
let sizeCalculationPromises = {};
// 默认大小显示模式：none, m, k, b
let sizeMode = "none";

// ==================== 辅助转义函数 (关键修复) ====================

/**
 * 转义字符串以安全地插入到 HTML 属性值中 (双引号属性，如 `value="..."`)
 * @param {string} str - 原始字符串
 * @returns {string} - 转义后的字符串
 */
function escapeHtmlAttribute(str) {
	if (typeof str !== 'string') str = String(str);
	return str
		.replace(/&/g, '&amp;') // 必须最先转义 &
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * 转义字符串以安全地插入到 JavaScript 单引号字符串字面量中 (例如 `onclick="myFunc('...')"` 或 `let x = '...'`)
 * 这是导致问题的核心函数，必须确保它正确无误。
 * @param {string} str - 原始字符串
 * @returns {string} - 转义后的字符串
 */
function escapeJsStringLiteral(str) {
	if (typeof str !== 'string') str = String(str);
	// 顺序很重要：先转义反斜杠，再转义单引号，避免对已转义的反斜杠再次转义
	return str
		.replace(/\\/g, '\\\\') // 转义反斜杠: \ -> \\
		.replace(/'/g, "\\'")   // 转义单引号: ' -> \'
		.replace(/\n/g, '\\n')  // 转义换行符
		.replace(/\r/g, '\\r')  // 转义回车符
		.replace(/\t/g, '\\t')  // 转义制表符
		.replace(/\u2028/g, '\\u2028') // 行分隔符
		.replace(/\u2029/g, '\\u2029'); // 段落分隔符
}

// ==================== 文件大小处理函数 ====================

/**
 * 格式化文件大小
 * @param {number} bytes - 文件大小（字节）
 * @param {string} mode - 显示模式 (none, m, k, b)
 * @returns {{size: string, unit: string}}
 */
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

/**
 * 递归计算文件夹大小
 * @param {string} folderPath - 文件夹路径
 * @returns {Promise<number>} - 总字节数
 */
function calculateFolderSizeRecursive(folderPath) {
	return new Promise((resolve) => {
		let totalSize = 0;

		try {
			const entries = fs.readdirSync(folderPath, { withFileTypes: true });

			const promises = [];

			for (const entry of entries) {
				const entryPath = path.join(folderPath, entry.name);

				try {
					if (entry.isDirectory()) {
						// 递归计算子文件夹大小
						promises.push(calculateFolderSizeRecursive(entryPath));
					} else {
						// 累加文件大小
						const stat = fs.statSync(entryPath);
						totalSize += stat.size;
					}
				} catch (error) {
					// 忽略无法访问的文件/目录
				}
			}

			// 等待所有子文件夹大小计算完成
			Promise.all(promises).then((sizes) => {
				sizes.forEach((size) => (totalSize += size));
				resolve(totalSize);
			});
		} catch (error) {
			// 如果无法读取文件夹，返回0
			resolve(0);
		}
	});
}

/**
 * 异步获取文件大小显示字符串
 * @param {string} itemPath - 文件或文件夹路径
 * @param {boolean} isFile - 是否为文件
 * @param {string} mode - 显示模式
 * @returns {Promise<string>} - 格式化后的大小字符串
 */
function getFileSizeDisplayAsync(itemPath, isFile, mode) {
	return new Promise((resolve, reject) => {
		const statsKey = `${itemPath}:${isFile ? "file" : "dir"}`;

		// 检查缓存
		if (fileSizeCache[statsKey]) {
			resolve(fileSizeCache[statsKey].display);
			return;
		}

		// none 模式直接返回空字符串
		if (mode === "none") {
			resolve("");
			return;
		}

		// 获取文件大小
		let size = 0;
		try {
			const stat = fs.statSync(itemPath);
			size = stat.size;
		} catch (error) {
			reject(error);
			return;
		}

		// 格式化文件大小
		const { size: displaySize, unit: displayUnit } = formatFileSize(size, mode);

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

		// 缓存结果
		fileSizeCache[statsKey] = {
			size: size,
			unit: unit,
			display: finalDisplay,
			isFolderTotal: false,
		};
		resolve(finalDisplay);
	});
}

// ==================== 配置文件处理函数 ====================

/**
 * 读取配置参数
 */
function getConfig() {
	const config = {
		recentDirs: [],
		lineSpacing: -2, // 默认行间距
		sidebarWidth: 100, // 默认侧边栏宽度
		recycleBin: [], // 历史回收站，最多60条记录
		isPinned: false,
		sizeMode: "none", // 默认不显示文件大小
	};

	try {
		if (!fs.existsSync(CONFIG_PATH)) {
			return config;
		}

		const content = fs.readFileSync(CONFIG_PATH, "utf8");
		const qqqSectionMatch = content.match(/\[qqq\]([\s\S]*?)(\[|$)/);

		if (qqqSectionMatch) {
			const sectionContent = qqqSectionMatch[1];

			// 解析 recent_dirs
			const recentDirsMatch = sectionContent.match(/recent_dirs=(.+)/);
			if (recentDirsMatch) {
				const dirs = recentDirsMatch[1]
					.split(",")
					.map((d) => d.trim())
					.filter(Boolean);
				config.recentDirs = dirs;
			}

			// 解析 line_spacing
			const lineSpacingMatch = sectionContent.match(/line_spacing=(.+)/);
			if (lineSpacingMatch) {
				config.lineSpacing = parseInt(lineSpacingMatch[1].trim());
			}

			// 解析 sidebar_width
			const sidebarWidthMatch = sectionContent.match(/sidebar_width=(.+)/);
			if (sidebarWidthMatch) {
				config.sidebarWidth = parseInt(sidebarWidthMatch[1].trim());
			}

			// 解析 recycle_bin
			const recycleBinMatch = sectionContent.match(/recycle_bin=(.+)/);
			if (recycleBinMatch) {
				const bins = recycleBinMatch[1]
					.split(",")
					.map((d) => d.trim())
					.filter(Boolean);
				config.recycleBin = bins;
			}

			// 解析 is_pinned
			const isPinnedMatch = sectionContent.match(/is_pinned=(.+)/);
			if (isPinnedMatch) {
				const value = isPinnedMatch[1].trim().toLowerCase();
				config.isPinned = value === "true" || value === "1";
			}

			// 解析 size_mode (新增)
			const sizeModeMatch = sectionContent.match(/size_mode=(.+)/);
			if (sizeModeMatch) {
				const mode = sizeModeMatch[1].trim().toLowerCase();
				if (["none", "m", "k", "b"].includes(mode)) {
					config.sizeMode = mode;
				}
			}
		}
	} catch (error) {
		logMessage("读取配置文件失败: " + error.message, "ERROR");
	}

	// 更新全局 sizeMode
	sizeMode = config.sizeMode;

	return config;
}

/**
 * 保存配置参数
 */
function saveConfig(
	recentDirs,
	lineSpacing,
	sidebarWidth,
	recycleBin,
	isPinned,
	newSizeMode
) {
	try {
		let content = "";

		// 读取现有内容
		if (fs.existsSync(CONFIG_PATH)) {
			content = fs.readFileSync(CONFIG_PATH, "utf8");
		}

		// 准备新的配置字符串
		const newConfigs = {
			recent_dirs: recentDirs.join(","),
			line_spacing: lineSpacing,
			sidebar_width: sidebarWidth,
			recycle_bin: recycleBin.join(","),
			is_pinned: isPinned ? "true" : "false",
			[SIZE_CONFIG_KEY]: newSizeMode || "none",
		};

		// 构建节内容
		const sectionContent = Object.entries(newConfigs)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n");

		// 替换或添加qqq节
		if (content.includes("[qqq]")) {
			content = content.replace(
				/\[qqq\]([\s\S]*?)(\[|$)/,
				`[qqq]\n${sectionContent}\n$2`,
			);
		} else {
			// 添加新的qqq节
			const newSection = `
[qqq]
recent_dirs=${newConfigs.recent_dirs}
line_spacing=${newConfigs.line_spacing}
sidebar_width=${newConfigs.sidebar_width}
recycle_bin=${newConfigs.recycle_bin}
is_pinned=${newConfigs.is_pinned}
${SIZE_CONFIG_KEY}=${newConfigs[SIZE_CONFIG_KEY]}
`;
			content += newSection;
		}

		fs.writeFileSync(CONFIG_PATH, content, "utf8");
		sizeMode = newSizeMode; // 更新全局状态
	} catch (error) {
		logMessage("保存配置文件失败: " + error.message, "ERROR");
	}
}

// 其他配置相关函数

/**
 * 读取最近保存的目录
 */
function getRecentDirectories() {
	const config = getConfig();
	return config.recentDirs;
}

/**
 * 从历史回收站中移除一个目录
 */
function removeFromRecycleBin(directory) {
	const config = getConfig();
	let updated = false;

	const newRecycleBin = config.recycleBin.filter((dir) => {
		if (dir === directory) {
			updated = true;
			return false;
		}
		return true;
	});

	if (updated) {
		// 保存更新后的配置 (传递 sizeMode)
		saveConfig(
			config.recentDirs,
			config.lineSpacing,
			config.sidebarWidth,
			newRecycleBin,
			config.isPinned,
			config.sizeMode,
		);
	}
}

/**
 * 添加到历史回收站
 */
function addToRecycleBin(directory) {
	const config = getConfig();

	// 确保目录存在且是有效的字符串
	if (
		!directory ||
		!fs.existsSync(directory) ||
		typeof directory !== "string"
	) {
		return;
	}

	// 1. 先从回收站中移除该项（如果它已经在里面）
	const newRecycleBin = config.recycleBin.filter((dir) => dir !== directory);

	// 2. 添加到回收站开头（最新）
	newRecycleBin.unshift(directory);

	// 3. 限制为60条
	const finalRecycleBin = newRecycleBin.slice(0, 60);

	// 4. 保存更新后的配置 (传递 sizeMode)
	saveConfig(
		config.recentDirs,
		config.lineSpacing,
		config.sidebarWidth,
		finalRecycleBin,
		config.isPinned,
		config.sizeMode,
	);
}

/**
 * 保存最近使用的目录 (最核心的逻辑，用于处理新旧目录的转移)
 * 此函数只在执行了实质操作后才调用
 */
function saveRecentDirectory(directory) {
	const config = getConfig();

	// 确保目录存在
	if (!directory || !fs.existsSync(directory)) {
		return;
	}

	// 1. **从回收站中移除**该目录，因为它现在是最近使用的
	removeFromRecycleBin(directory);

	// 2. 将新目录移到 recentDirs 列表最前面
	let recentDirs = config.recentDirs.filter((dir) => dir && dir !== directory);

	// 3. 检查是否已经有10条记录，如果是，将最旧的记录添加到回收站
	if (recentDirs.length >= 10) {
		const oldestDir = recentDirs.pop(); // 移除最旧的记录
		addToRecycleBin(oldestDir); // 添加到回收站
	}

	// 4. 添加新目录到开头并限制为10个
	recentDirs.unshift(directory);
	const finalRecentDirs = recentDirs.slice(0, 10);

	// 5. 保存更新后的配置 (传递 sizeMode)
	const updatedConfig = getConfig(); // 重新获取配置以包含最新的回收站状态
	saveConfig(
		finalRecentDirs,
		updatedConfig.lineSpacing,
		updatedConfig.sidebarWidth,
		updatedConfig.recycleBin,
		updatedConfig.isPinned,
		updatedConfig.sizeMode,
	);
}

/**
 * 将指定目录从最近目录中移除并添加到回收站（对应Webview的叉叉按钮）
 */
function removeAndRecycleRecentDirectory(directory) {
	const config = getConfig();

	// 1. 从 recentDirs 中移除
	let updated = false;
	const newRecentDirs = config.recentDirs.filter((dir) => {
		if (dir === directory) {
			updated = true;
			return false;
		}
		return true;
	});

	if (updated) {
		// 2. 添加到回收站
		addToRecycleBin(directory);

		// 3. 保存更新后的配置 (注意：addToRecycleBin 已经更新了回收站部分，这里只更新最近目录)
		const updatedConfig = getConfig(); // 重新获取配置以包含最新的回收站状态
		saveConfig(
			newRecentDirs,
			updatedConfig.lineSpacing,
			updatedConfig.sidebarWidth,
			updatedConfig.recycleBin,
			updatedConfig.isPinned,
			updatedConfig.sizeMode,
		);
	}

	return updated; // 返回是否进行了操作
}

// ====================辅助函数 ====================

/**
 * 获取驱动器列表（Windows系统）
 */
function getDrives() {
	const drives = [];

	if (process.platform === "win32") {
		try {
			const child = cp.spawnSync("wmic", ["logicaldisk", "get", "caption"], {
				encoding: "utf8",
			});
			const output = child.stdout;

			// 解析输出，获取驱动器列表
			const lines = output.split("\n");
			for (const line of lines) {
				const driveMatch = line.match(/([A-Z]:)/);
				if (driveMatch) {
					drives.push(driveMatch[1]);
				}
			}
		} catch (error) {
			logMessage("获取驱动器列表失败: " + error.message, "ERROR");
			// 默认添加C盘
			drives.push("C:");
		}
	} else {
		// 非Windows系统，默认添加根目录
		drives.push("/");
	}

	return drives;
}

/**
 * 获取目录结构内容
 */
function getDirectoryContents(dirPath) {
	const contents = {
		dirs: [],
		files: [],
	};

	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dirPath, entry.name);

			try {
				const stat = fs.statSync(entryPath);

				if (entry.isDirectory()) {
					contents.dirs.push({
						name: entry.name,
						path: entryPath,
						isDir: true,
						mtime: stat.mtime.toISOString(),
					});
				} else {
					contents.files.push({
						name: entry.name,
						path: entryPath,
						isDir: false,
						mtime: stat.mtime.toISOString(),
					});
				}
			} catch (error) {
				// 忽略无法访问的文件/目录
			}
		}

		// 排序：文件夹在前，按修改时间从近到远排序
		contents.dirs.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
		contents.files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
	} catch (error) {
		logMessage(`读取目录内容失败: ${dirPath}`, "ERROR");
	}

	return contents;
}

/**
 * 生成 Webview JavaScript 代码
 * @param {string} currentSizeMode - 当前大小显示模式
 * @param {string} currentPath - 当前路径
 */
function generateWebviewScript(currentSizeMode, currentPath) {
	// 核心修复点：将 currentPath 和 currentSizeMode 转义为 JavaScript 字符串字面量
	const escapedCurrentPathForJsLiteral = escapeJsStringLiteral(currentPath);
	const escapedSizeModeForJsLiteral = escapeJsStringLiteral(currentSizeMode);

	// 使用模板字面量，所有动态内容都必须经过转义
	return `
        const vscode = acquireVsCodeApi();
        const sizeMode = '${escapedSizeModeForJsLiteral}';
        let currentPath = '${escapedCurrentPathForJsLiteral}';

        document.addEventListener('DOMContentLoaded', () => {
            const filenameInput = document.getElementById('filenameInput');
            filenameInput.focus();
            updateResourceExplorer();

            document.getElementById('fileList').addEventListener('click', (event) => {
                if (event.target === event.currentTarget) {
                    const prevSelected = document.querySelector('.file-item.selected');
                    if (prevSelected) {
                        const renameInput = prevSelected.querySelector('.rename-input');
                        if (renameInput) {
                            cancelRename(prevSelected);
                        }
                        prevSelected.classList.remove('selected');
                    }
                    selectedItem = null;
                }
            });
        });

        function navigateTo(path) {
            vscode.postMessage({ command: 'navigate', path: path });
        }

        function navigateIntoFolder(path) {
            vscode.postMessage({ command: 'navigate', path: path });
        }

        function handleAddressInputKeyDown(event) {
            if (event.key === 'Enter') {
                const path = event.target.value;
                vscode.postMessage({ command: 'navigate', path: path });
            }
        }

        let currentFocusType = 'filenameInput';

        document.addEventListener('focusin', (event) => {
            updateFocusType(event.target);
        });

        document.addEventListener('focusout', (event) => {
            if (event.target.id === 'filenameInput' || event.target.id === 'addressInput' || event.target.classList.contains('rename-input')) {
                setTimeout(() => {
                    const activeElement = document.activeElement;
                    if (activeElement.id !== 'filenameInput' && activeElement.id !== 'addressInput' && !activeElement.classList.contains('rename-input')) {
                        updateFocusType(activeElement);
                    }
                }, 0);
            }
        });

        document.addEventListener('click', (event) => {
            hideAllContextMenus();
            if ((event.target.id !== 'filenameInput' && event.target.id !== 'addressInput' && !event.target.classList.contains('rename-input')) &&
                currentFocusType === 'input') {
                updateFocusType(event.target);
            }
        });

        function updateFocusType(element) {
            if (element.id === 'filenameInput' || element.id === 'addressInput' || element.classList.contains('rename-input')) {
                currentFocusType = 'input';
            } else if (element.classList.contains('file-list-container') ||
                      element.classList.contains('file-item') ||
                      element.closest('.file-list-container')) {
                currentFocusType = 'fileList';
            } else if (element.classList.contains('sidebar') ||
                      element.classList.contains('nav-item') ||
                      element.closest('.sidebar')) {
                currentFocusType = 'sidebar';
            } else if (element.classList.contains('recent-section') ||
                      element.classList.contains('recent-item') ||
                      element.closest('.recent-section')) {
                currentFocusType = 'recentSection';
            } else {
                currentFocusType = 'other';
            }
        }

        function handleFilenameInputKeyDown(event) {
            if (event.key === 'Enter') {
                saveFile();
            }
        }

        function saveFile() {
            const filename = document.getElementById('filenameInput').value.trim();
            if (filename) {
                const pinButton = document.getElementById('pinButton');
                const pinBox = pinButton.querySelector('.pin-box');
                const isPinned = pinBox.classList.contains('pinned');

                vscode.postMessage({
                    command: 'save',
                    filename: filename,
                    isPinned: isPinned,
                    openInCurrentGroup: !isPinned
                });

                if (isPinned) {
                    document.getElementById('filenameInput').value = '';
                    document.getElementById('filenameInput').focus();
                }
            } else {
                alert('请输入文件名');
            }
        }

        function togglePin() {
            const pinButton = document.getElementById('pinButton');
            const pinBox = pinButton.querySelector('.pin-box');
            const pinCheckbox = pinButton.querySelector('.pin-checkbox');

            const isCurrentlyPinned = pinBox.classList.contains('pinned');
            const newPinState = !isCurrentlyPinned;

            if (newPinState) {
                pinBox.classList.add('pinned');
                pinCheckbox.textContent = '\\u2713';
            } else {
                pinBox.classList.remove('pinned');
                pinCheckbox.textContent = '\\u25a1';
            }

            vscode.postMessage({
                command: 'togglePin',
                isPinned: newPinState
            });
        }

        function removeFromRecent(path) {
            vscode.postMessage({ command: 'removeFromRecent', path: path });
        }

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        function refreshSizeDisplay() {
            const fileList = document.getElementById('fileList');
            const items = fileList.querySelectorAll('.file-item');

            items.forEach(item => {
                const szArea = item.querySelector('.sz-area');
                const type = item.dataset.type;

                if (szArea) {
                    if (type === 'file' && sizeMode !== 'none') {
                        szArea.textContent = '    \\u2022    ';
                    } else {
                        szArea.textContent = '';
                    }
                    vscode.postMessage({
                        command: 'requestSize',
                        path: item.dataset.path,
                        type: type
                    });
                }
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;

            if (message.command === 'update') {
                document.getElementById('addressInput').value = message.currentPath;
                document.getElementById('fileList').innerHTML = message.fileListHtml;
                requestFileSizeUpdates(message.items);
            }
            else if (message.command === 'updateSize') {
                const safePathSelector = message.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
                const item = document.querySelector(\`.file-item[data-path="\${safePathSelector}"].\${message.type}\`);
                if (item) {
                    const szArea = item.querySelector('.sz-area');
                    if (szArea) {
                        szArea.textContent = message.sizeDisplay;
                    }
                }
            }
            else if (message.command === 'clearFilenameInput') {
                document.getElementById('filenameInput').value = '';
                document.getElementById('filenameInput').focus();
            }
            else if (message.command === 'startRename') {
                startRename(message.path, message.name, message.type);
            }
            else if (message.command === 'refreshSizes') {
                refreshSizeDisplay();
            }
            else if (message.command === 'restoreDeletedItem') {
                const safePathSelector = message.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
                const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
                if (itemElement) {
                    itemElement.style.opacity = '';
                    itemElement.style.pointerEvents = '';
                }
            }
        });

        function requestFileSizeUpdates(items) {
            if (sizeMode === 'none') return;

            items.forEach(item => {
                if (item.name === '..') return;

                const safePathSelector = item.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
                const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"].\${item.type}\`);
                if (itemElement) {
                    const szArea = itemElement.querySelector('.sz-area');
                    if (szArea) {
                        if (item.type === 'file') {
                            szArea.textContent = '    \\u2022    ';
                        }
                    }
                }

                vscode.postMessage({
                    command: 'requestSize',
                    path: item.path,
                    type: item.type,
                    name: item.name
                });
            });
        }

        let selectedItem = null;

        function selectItem(event, type, path, name) {
            event.stopPropagation();
            hideAllContextMenus();

            const item = event.currentTarget.closest('.file-item');
            if (!item) return;

            const prevSelected = document.querySelector('.file-item.selected');
            if (prevSelected && prevSelected !== item) {
                const renameInput = prevSelected.querySelector('.rename-input');
                if (renameInput) {
                    cancelRename(prevSelected);
                }
                prevSelected.classList.remove('selected');
            }

            item.classList.add('selected');
            selectedItem = {
                type: type,
                path: path,
                name: name
            };

            currentFocusType = 'fileList';
        }

        let renameBlurHandler = null;

        function startRename(itemPath, itemName, itemType) {
            const safePathSelector = itemPath.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
            const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
            if (!itemElement) return;

            selectItem({ currentTarget: itemElement.querySelector('.file-select-area'), stopPropagation: () => {} }, itemType, itemPath, itemName);

            const nameArea = itemElement.querySelector(\`.\${itemType === 'file' ? 'file' : 'folder'}-name-area\`);
            if (!nameArea || nameArea.querySelector('.rename-input')) return;

            const originalContent = nameArea.innerHTML;

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'rename-input';
            input.value = itemName;
            input.style.width = '100%';
            input.style.padding = '0';
            input.style.border = '1px solid #ff6b00';
            input.style.boxSizing = 'border-box';
            input.style.fontSize = 'inherit';
            input.style.fontFamily = 'inherit';
            input.style.lineHeight = 'inherit';
            input.style.backgroundColor = '#ff6b00';
            input.style.color = 'white';

            nameArea.innerHTML = '';
            nameArea.appendChild(input);
            input.focus();

            const dotIndex = itemName.lastIndexOf('.');
            if (dotIndex > 0) {
                input.setSelectionRange(0, dotIndex);
            } else {
                input.select();
            }

            currentFocusType = 'input';

            renameBlurHandler = () => cancelRename(itemElement, originalContent);

            const handleKeyDown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    commitRename(itemElement, itemPath, itemType, input.value.trim());
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelRename(itemElement, originalContent);
                }
            };

            input.addEventListener('keydown', handleKeyDown);
            input.addEventListener('blur', renameBlurHandler);

            itemElement.dataset.originalContent = originalContent;
        }

        function commitRename(itemElement, oldPath, itemType, newName) {
            const input = itemElement.querySelector('.rename-input');
            if (!input) return;

            input.removeEventListener('blur', renameBlurHandler);
            renameBlurHandler = null;
            currentFocusType = 'fileList';

            const oldName = itemElement.dataset.name;

            if (newName && newName !== oldName) {
                vscode.postMessage({
                    command: 'renameItem',
                    oldPath: oldPath,
                    newName: newName,
                    itemType: itemType
                });
            } else {
                cancelRename(itemElement, itemElement.dataset.originalContent);
            }
        }

        function cancelRename(itemElement, originalContent) {
             const input = itemElement.querySelector('.rename-input');
            if (!input) return;

            input.removeEventListener('blur', renameBlurHandler);
            renameBlurHandler = null;
            currentFocusType = 'fileList';

            const itemType = itemElement.dataset.type;
            const nameArea = itemElement.querySelector(\`.\${itemType === 'file' ? 'file' : 'folder'}-name-area\`);

            if (nameArea) {
                 nameArea.innerHTML = originalContent || \`<span class="file-name">\${itemElement.dataset.name}</span>\`;
            }
        }

        function performEditAction(itemToEdit) {
            if (!itemToEdit) return;
            startRename(itemToEdit.path, itemToEdit.name, itemToEdit.type);
        }

        function performOpenAction(itemToOpen) {
            if (!itemToOpen) return;
            vscode.postMessage({
                command: 'openWithDefaultApp',
                path: itemToOpen.path,
                type: itemToOpen.type
            });
        }

        function performDeleteAction(itemToDelete) {
            if (!itemToDelete) return;

            const safePathSelector = itemToDelete.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
            const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
            if (itemElement) {
                itemElement.style.opacity = '0.5';
                itemElement.style.pointerEvents = 'none';
            }

            vscode.postMessage({
                command: 'quickDeleteToRecycleBin',
                path: itemToDelete.path,
                type: itemToDelete.type
            });

            selectedItem = null;
        }

        function performKodeAction(itemToKode) {
            if (!itemToKode) return;
            if (itemToKode.type === 'file') {
                vscode.postMessage({
                    command: 'editFile',
                    path: itemToKode.path,
                    isPinned: false,
                    openInCurrentGroup: true
                });
            } else {
                 vscode.postMessage({
                    command: 'openFolderInNewWindow',
                    path: itemToKode.path
                });
            }
        }

        function performSizeAction(itemToRefresh) {
            if (!itemToRefresh) return;
            const safePathSelector = itemToRefresh.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
            const item = document.querySelector(\`.file-item[data-path="\${safePathSelector}"]\`);
            if (item) {
                const szArea = item.querySelector('.sz-area');
                if (szArea) {
                    szArea.textContent = '    \\u2022    ';
                }
            }
            vscode.postMessage({
                command: 'refreshSize',
                path: itemToRefresh.path,
                type: itemToRefresh.type
            });
        }

        function handleContextMenuAction(action) {
            const contextMenu = document.getElementById('itemContextMenu');
            const itemForAction = {
                path: contextMenu.dataset.path,
                name: contextMenu.dataset.name,
                type: contextMenu.dataset.type
            };

            hideAllContextMenus();

            if (!itemForAction || !itemForAction.path) {
                return;
            }

            switch(action) {
                case 'rename': performEditAction(itemForAction); break;
                case 'open': performOpenAction(itemForAction); break;
                case 'delete': performDeleteAction(itemForAction); break;
                case 'kode': performKodeAction(itemForAction); break;
                case 'size': performSizeAction(itemForAction); break;
            }
        }

        function hideAllContextMenus() {
            document.getElementById('itemContextMenu').style.display = 'none';
            document.getElementById('emptyContextMenu').style.display = 'none';
        }

        const itemContextMenu = document.getElementById('itemContextMenu');

        itemContextMenu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const action = e.currentTarget.dataset.action;
                handleContextMenuAction(action);
            });
        });

        document.getElementById('fileList').addEventListener('contextmenu', (e) => {
            e.preventDefault();
            hideAllContextMenus();

            const itemElement = e.target.closest('.file-item');
            const emptyContextMenu = document.getElementById('emptyContextMenu');

            if (itemElement) {
                const itemPath = itemElement.dataset.path;
                const itemName = itemElement.dataset.name;
                const itemType = itemElement.dataset.type;

                selectItem({ currentTarget: itemElement.querySelector('.file-select-area'), stopPropagation: () => {} }, itemType, itemPath, itemName);

                itemContextMenu.dataset.path = itemPath;
                itemContextMenu.dataset.name = itemName;
                itemContextMenu.dataset.type = itemType;

                itemContextMenu.style.left = e.clientX + 'px';
                itemContextMenu.style.top = e.clientY + 'px';
                itemContextMenu.style.display = 'flex';

            } else {
                 emptyContextMenu.style.left = e.clientX + 'px';
                 emptyContextMenu.style.top = e.clientY + 'px';
                 emptyContextMenu.style.display = 'flex';
            }
        });

        function setSizeMode(mode) {
            hideAllContextMenus();
            vscode.postMessage({
                command: 'setSizeMode',
                mode: mode
            });
        }

        document.addEventListener('keydown', event => {
            if (currentFocusType === 'input') return;
            if (!selectedItem) return;

            const key = event.key.toLowerCase();

            if (key === 'q') {
                event.preventDefault();
                event.stopPropagation();
                performEditAction(selectedItem);
            }
            else if (key === 'w') {
                event.preventDefault();
                event.stopPropagation();
                performOpenAction(selectedItem);
            }
            else if (key === 's') {
                event.preventDefault();
                event.stopPropagation();
                performDeleteAction(selectedItem);
            }
            else if (key === 'e') {
                event.preventDefault();
                event.stopPropagation();
                performKodeAction(selectedItem);
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Backspace' && currentFocusType !== 'input') {
                event.preventDefault();
                vscode.postMessage({ command: 'navigateUp' });
            }
        });

        const sidebarResizer = document.getElementById('sidebarResizer');
        const sidebar = document.querySelector('.sidebar');
        const mainContent = document.querySelector('.main-content');
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        if (sidebarResizer && sidebar && mainContent) {
            const computedStyle = getComputedStyle(sidebar);
            const sidebarWidth = parseInt(computedStyle.width) || 100;

            sidebarResizer.style.left = sidebarWidth + 'px';
            mainContent.style.left = sidebarWidth + 'px';

            sidebarResizer.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                startWidth = sidebar.offsetWidth;
                sidebarResizer.classList.add('active');
                document.body.style.userSelect = 'none';
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                let newWidth = startWidth + (e.clientX - startX);
                newWidth = Math.max(50, Math.min(500, newWidth));
                sidebar.style.width = newWidth + 'px';
                sidebarResizer.style.left = newWidth + 'px';
                mainContent.style.left = newWidth + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (!isResizing) return;
                isResizing = false;
                sidebarResizer.classList.remove('active');
                document.body.style.userSelect = '';
                const newWidth = parseInt(sidebar.style.width) || 100;
                vscode.postMessage({
                    command: 'saveSidebarWidth',
                    width: newWidth
                });
            });

            document.addEventListener('mouseleave', () => {
                if (isResizing) {
                    isResizing = false;
                    sidebarResizer.classList.remove('active');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }
            });
        }

        function createFolder() {
            const folderName = document.getElementById('filenameInput').value.trim();
            if (folderName) {
                vscode.postMessage({ command: 'createFolder', folderName: folderName });
            } else {
                alert('请输入文件夹名');
            }
        }

        function updateResourceExplorer() {
            // This function is a stub in the webview.
            // The extension will send an 'update' message which triggers the real update.
        }
    `;
}

// ==================== Webview 内容生成 ====================

/**
 * 生成 Webview HTML 内容（从模板文件读取并替换变量）
 */
function getWebviewContent(currentPath) {
	const currentConfig = getConfig();
	const drives = getDrives();

	const LINE_SPACING = currentConfig.lineSpacing;
	const SIDEBAR_WIDTH = currentConfig.sidebarWidth;
	const currentRecentDirs = currentConfig.recentDirs;
	const currentSizeMode = currentConfig.sizeMode;

	// 获取VS Code设置，检查是否显示历史回收站
	const showRecycleBinSetting = vscode.workspace
		.getConfiguration("qqq")
		.get("showHistoryRecycleBin", true);

	// 验证路径存在
	const safeRecentDirs =
		currentRecentDirs && currentRecentDirs.length > 0
			? currentRecentDirs.filter((dir) => dir && fs.existsSync(dir))
			: [];

	const safeRecycleBin =
		currentConfig.recycleBin && Array.isArray(currentConfig.recycleBin)
			? currentConfig.recycleBin.filter(
				(dir) => dir && typeof dir === "string" && fs.existsSync(dir),
			)
			: [];

	const showRecycleBin = showRecycleBinSetting && safeRecycleBin.length > 0;
	const isPinned = currentConfig.isPinned || false;

	// 读取 HTML 模板
	const templatePath = path.join(__dirname, "q2.html");
	let htmlTemplate = '';
	try {
		htmlTemplate = fs.readFileSync(templatePath, "utf8");
	} catch (error) {
		logMessage(`无法读取 q2.html 模板文件: ${error.message}`, "ERROR");
		return `<h1>错误: 无法加载 q2.html 模板</h1><p>${error.message}</p>`;
	}

	// 生成驱动器列表 HTML
	const drivesHtml = drives
		.map(
			(drive) => `
            <button class="nav-item" onclick="navigateTo('${escapeJsStringLiteral(drive)}')">${escapeHtmlAttribute(drive)}</button>
            `,
		)
		.join("");

	// 生成回收站 HTML
	const recycleBinHtml = showRecycleBin
		? `
        <div class="divider"></div>
        <div class="recycle-bin-section">
            <div class="recycle-bin-header">历史回收站 (${safeRecycleBin.length}/60)</div>
            ${safeRecycleBin
			.map(
				(dir) => `
            <div class="recycle-item" onclick="navigateTo('${escapeJsStringLiteral(dir)}')">${escapeHtmlAttribute(dir)}</div>
            `,
			)
			.join("")}
        </div>
        `
		: "";

	// 生成最近目录 HTML
	const recentDirsHtml = safeRecentDirs
		.reverse()
		.map(
			(dir) => `
            <div class="recent-item" onclick="navigateTo('${escapeJsStringLiteral(dir)}')">
                <span class="delete-button" onclick="event.stopPropagation(); removeFromRecent('${escapeJsStringLiteral(dir)}')">×</span>
                <span>${escapeHtmlAttribute(dir)}</span>
            </div>
            `,
		)
		.join("");

	// 生成内联脚本
	const inlineScript = generateWebviewScript(currentSizeMode, currentPath);

	// 替换所有占位符
	let finalHtml = htmlTemplate;
	finalHtml = finalHtml.replace(/\{\{SIDEBAR_WIDTH\}\}/g, SIDEBAR_WIDTH);
	finalHtml = finalHtml.replace(/\{\{LINE_SPACING\}\}/g, LINE_SPACING);
	finalHtml = finalHtml.replace(/\{\{DRIVES_HTML\}\}/g, drivesHtml);
	finalHtml = finalHtml.replace(/\{\{RECYCLE_BIN_HTML\}\}/g, recycleBinHtml);
	finalHtml = finalHtml.replace(/\{\{RECENT_DIRS_HTML\}\}/g, recentDirsHtml);
	finalHtml = finalHtml.replace(/\{\{CURRENT_PATH\}\}/g, escapeHtmlAttribute(currentPath));
	finalHtml = finalHtml.replace(/\{\{PIN_CLASS\}\}/g, isPinned ? "pinned" : "");
	finalHtml = finalHtml.replace(/\{\{PIN_CHECKBOX\}\}/g, isPinned ? "✓" : "□");
	finalHtml = finalHtml.replace(/\{\{SIZE_MODE_NONE_CLASS\}\}/g, currentSizeMode === "none" ? "selected" : "");
	finalHtml = finalHtml.replace(/\{\{SIZE_MODE_M_CLASS\}\}/g, currentSizeMode === "m" ? "selected" : "");
	finalHtml = finalHtml.replace(/\{\{SIZE_MODE_K_CLASS\}\}/g, currentSizeMode === "k" ? "selected" : "");
	finalHtml = finalHtml.replace(/\{\{SIZE_MODE_B_CLASS\}\}/g, currentSizeMode === "b" ? "selected" : "");

	// 关键：替换脚本占位符。确保 </script> 不会出现在 inlineScript 字符串中
	const safeInlineScript = inlineScript.replace(/<\/script>/gi, '<\\/script>');
	finalHtml = finalHtml.replace('{{INLINE_SCRIPT}}', safeInlineScript);

	return finalHtml;
}

// ==================== 主对话框函数 ====================

/**
 * 显示自定义另存为对话框
 */
function showSaveAsDialog() {
	// 单窗口控制
	if (activePanel !== null) {
		if (usePanelReveal === 1) {
			activePanel.reveal();
		}
		return;
	}

	// 每次打开对话框都重新读取配置
	const config = getConfig();
	const recentDirs = config.recentDirs;
	let currentPath =
		recentDirs.length > 0 ? recentDirs[0] : process.env.USERPROFILE || "C:\\";

	// 确保当前路径存在
	try {
		if (!fs.existsSync(currentPath)) {
			currentPath = process.env.USERPROFILE || "C:\\";
		} else if (!fs.statSync(currentPath).isDirectory()) {
			currentPath = path.dirname(currentPath);
		}
	} catch (error) {
		currentPath = process.env.USERPROFILE || "C:\\";
	}

	// 创建Webview面板
	const panel = vscode.window.createWebviewPanel(
		"q2",
		"qqq new 新建",
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		},
	);

	activePanel = panel;

	// 设置面板图标
	const iconPath = path.join(__dirname, "..", "assets", "icon.png");
	if (fs.existsSync(iconPath)) {
		panel.iconPath = vscode.Uri.file(iconPath);
	}

	panel.onDidDispose(() => {
		activePanel = null;
	});

	// 更新资源展示区
	function updateResourceExplorer() {
		try {
			if (!panel || panel.disposed) {
				return;
			}

			const directoryContents = getDirectoryContents(currentPath);
			const items = [];
			let fileListHtml = "";

			// 添加上级目录
			if (
				currentPath.length > 3 && // 避免 C:\
				path.dirname(currentPath) !== currentPath
			) {
				const parentPath = path.dirname(currentPath);
				const parentItem = { path: parentPath, name: "..", type: "folder" };
				items.push(parentItem);

				fileListHtml += `
                <div class="file-item folder" data-path="${escapeHtmlAttribute(parentPath)}" data-name=".." data-type="folder">
                    <div class="file-select-area" onclick="selectItem(event, 'folder', '${escapeJsStringLiteral(parentPath)}', '..')">
                        <div class="sz-area"></div>
                        <span class="file-icon">📁</span>
                    </div>
                    <div class="folder-name-area" onclick="selectItem(event, 'folder', '${escapeJsStringLiteral(parentPath)}', '..'); navigateIntoFolder('${escapeJsStringLiteral(parentPath)}')">
                        <span class="file-name">..</span>
                    </div>
                </div>`;
			}


			// 添加文件夹
			directoryContents.dirs.forEach((dir) => {
				items.push({ path: dir.path, name: dir.name, type: "folder" });
				fileListHtml += `
                <div class="file-item folder" data-path="${escapeHtmlAttribute(dir.path)}" data-name="${escapeHtmlAttribute(dir.name)}" data-type="folder">
                    <div class="file-select-area" onclick="selectItem(event, 'folder', '${escapeJsStringLiteral(dir.path)}', '${escapeJsStringLiteral(dir.name)}')">
                        <div class="sz-area"></div>
                        <span class="file-icon">📁</span>
                    </div>
                    <div class="folder-name-area" onclick="selectItem(event, 'folder', '${escapeJsStringLiteral(dir.path)}', '${escapeJsStringLiteral(dir.name)}'); navigateIntoFolder('${escapeJsStringLiteral(dir.path)}')">
                        <span class="file-name">${escapeHtmlAttribute(dir.name)}</span>
                    </div>
                </div>`;
			});

			// 添加文件
			directoryContents.files.forEach((file) => {
				items.push({ path: file.path, name: file.name, type: "file" });
				fileListHtml += `
                <div class="file-item file" data-path="${escapeHtmlAttribute(file.path)}" data-name="${escapeHtmlAttribute(file.name)}" data-type="file">
                    <div class="file-select-area" onclick="selectItem(event, 'file', '${escapeJsStringLiteral(file.path)}', '${escapeJsStringLiteral(file.name)}')">
                        <div class="sz-area"></div>
                        <span class="file-icon">📄</span>
                    </div>
                    <div class="file-name-area" onclick="selectItem(event, 'file', '${escapeJsStringLiteral(file.path)}', '${escapeJsStringLiteral(file.name)}');">
                        <span class="file-name">${escapeHtmlAttribute(file.name)}</span>
                    </div>
                </div>`;
			});

			panel.webview.postMessage({
				command: "update",
				currentPath: currentPath,
				fileListHtml: fileListHtml,
				items: items,
			});
		} catch (error) {
			logMessage(`更新资源展示区失败: ${error}`, "ERROR");
		}
	}

	// 统一的Webview刷新函数
	function refreshWebview() {
		if (panel && !panel.disposed) {
			// 重新生成整个HTML内容，确保所有变量最新
			panel.webview.html = getWebviewContent(currentPath);
			// 延迟确保HTML渲染完成再更新文件列表
			setTimeout(() => updateResourceExplorer(), 100);
		}
	}

	// Webview消息处理
	panel.webview.onDidReceiveMessage((message) => {
		const currentConfig = getConfig();
		const currentSizeMode = currentConfig.sizeMode;

		switch (message.command) {
			case "removeFromRecent":
				if (removeAndRecycleRecentDirectory(message.path)) {
					refreshWebview();
				}
				break;

			case "setSizeMode":
				saveConfig(
					currentConfig.recentDirs, currentConfig.lineSpacing, currentConfig.sidebarWidth,
					currentConfig.recycleBin, currentConfig.isPinned, message.mode
				);
				fileSizeCache = {};
				sizeCalculationPromises = {};
				refreshWebview();
				break;

			case "requestSize":
				if (currentSizeMode === "none") break;
				getFileSizeDisplayAsync(message.path, message.type === "file", currentSizeMode)
					.then(display => {
						if (panel && !panel.disposed) {
							panel.webview.postMessage({
								command: "updateSize", path: message.path, type: message.type, sizeDisplay: display
							});
						}
					})
					.catch(e => logMessage(`异步获取文件大小失败: ${message.path} - ${e.message}`, "ERROR"));
				break;

			case "refreshSize":
				const { path: itemToRefresh, type: itemTypeToRefresh } = message;
				const statsKey = `${itemToRefresh}:${itemTypeToRefresh === "folder" ? "dir" : "file"}`;
				delete fileSizeCache[statsKey];
				if (itemTypeToRefresh === "folder") {
					delete sizeCalculationPromises[itemToRefresh];
					calculateFolderSizeRecursive(itemToRefresh).then(totalSize => {
						const { size, unit } = formatFileSize(totalSize, sizeMode);
						let spacesToFill = (unit === "k" ? 3 : (unit === "b" ? 6 : 0));
						const displayString = " ".repeat(spacesToFill) + size + " " + unit;
						fileSizeCache[statsKey] = { size: totalSize, unit: unit, display: displayString, isFolderTotal: true };
						if (panel && !panel.disposed) {
							panel.webview.postMessage({ command: "updateSize", path: itemToRefresh, type: "folder", sizeDisplay: displayString });
						}
					}).catch(e => logMessage(`刷新文件夹大小失败: ${itemToRefresh} - ${e.message}`, "ERROR"));
				} else {
					getFileSizeDisplayAsync(itemToRefresh, true, currentSizeMode).then(display => {
						if (panel && !panel.disposed) {
							panel.webview.postMessage({ command: "updateSize", path: itemToRefresh, type: "file", sizeDisplay: display });
						}
					}).catch(e => logMessage(`刷新文件大小失败: ${itemToRefresh} - ${e.message}`, "ERROR"));
				}
				break;

			case "renameItem":
				try {
					const { oldPath, newName } = message;
					const newPath = path.join(path.dirname(oldPath), newName);
					if (fs.existsSync(newPath)) {
						vscode.window.showErrorMessage(`重命名失败：目标位置已存在同名项。`);
						refreshWebview();
					} else {
						fs.renameSync(oldPath, newPath);
						saveRecentDirectory(path.dirname(oldPath));
						fileSizeCache = {};
						sizeCalculationPromises = {};
						setTimeout(() => refreshWebview(), 100);
					}
				} catch (error) {
					vscode.window.showErrorMessage("重命名失败: " + error.message);
					logMessage("重命名失败: " + error.message, "ERROR");
					refreshWebview();
				}
				break;

			case "navigate":
				try {
					let newPath = message.path;
					if (process.platform === "win32" && /^[A-Z]:$/i.test(newPath)) {
						newPath += "\\";
					}
					if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
						currentPath = newPath;
						refreshWebview();
					} else {
						vscode.window.showErrorMessage("无效的目录路径: " + newPath);
					}
				} catch (error) {
					vscode.window.showErrorMessage("导航失败: " + error.message);
				}
				break;

			case "navigateUp":
				const parentDir = path.dirname(currentPath);
				if (parentDir !== currentPath) {
					currentPath = parentDir;
					refreshWebview();
				}
				break;

			case "saveSidebarWidth":
				saveConfig(
					currentConfig.recentDirs, currentConfig.lineSpacing, message.width,
					currentConfig.recycleBin, currentConfig.isPinned, currentConfig.sizeMode
				);
				break;

			case "togglePin":
				saveConfig(
					currentConfig.recentDirs, currentConfig.lineSpacing, currentConfig.sidebarWidth,
					currentConfig.recycleBin, message.isPinned, currentConfig.sizeMode
				);
				break;

			case "save":
				const { filename, isPinned, openInCurrentGroup } = message;
				const fullFilePath = path.join(currentPath, filename);

				const createFileAction = () => {
					try {
						// 再次确认，以防万一
						if (fs.existsSync(fullFilePath) && fs.statSync(fullFilePath).isDirectory()) {
							vscode.window.showErrorMessage(`无法创建文件，因为已存在同名文件夹: "${filename}"`);
							return;
						}

						fs.writeFileSync(fullFilePath, "\n".repeat(199), "utf8");

						saveRecentDirectory(currentPath); // 仅在成功创建后保存
						fileSizeCache = {};

						if (!isPinned) {
							panel.dispose();
						} else {
							refreshWebview();
						}

						vscode.workspace.openTextDocument(fullFilePath).then(doc => {
							vscode.window.showTextDocument(doc, openInCurrentGroup ? undefined : vscode.ViewColumn.Beside);
						});

					} catch (error) {
						logMessage(`创建文件失败: ${error.message}`, "ERROR");
						vscode.window.showErrorMessage(`创建文件失败: ${error.message}`);
					}
				};

				if (fs.existsSync(fullFilePath)) {
					const stats = fs.statSync(fullFilePath);
					if (stats.isDirectory()) {
						vscode.window.showErrorMessage(`无法创建文件，因为已存在同名文件夹: "${filename}"`);
					} else {
						vscode.window.showWarningMessage(`文件 "${filename}" 已存在，是否覆盖？`, { modal: true }, "是", "否")
							.then(answer => {
								if (answer === "是") {
									createFileAction();
								}
							});
					}
				} else {
					createFileAction();
				}

				break;

			case "createFolder":
				const newFolderPath = path.join(currentPath, message.folderName);
				if (fs.existsSync(newFolderPath)) {
					vscode.window.showErrorMessage(`无法创建，"${message.folderName}" 已存在。`);
				} else {
					fs.mkdirSync(newFolderPath);
					saveRecentDirectory(currentPath);
					fileSizeCache = {};
					refreshWebview();
					if (panel && !panel.disposed) panel.webview.postMessage({ command: "clearFilenameInput" });
				}
				break;

			case "cancel":
				panel.dispose();
				break;

			case "editFile":
				saveRecentDirectory(path.dirname(message.path));
				vscode.workspace.openTextDocument(message.path).then(doc => {
					vscode.window.showTextDocument(doc, message.openInCurrentGroup ? undefined : vscode.ViewColumn.Beside);
					if (!message.isPinned) panel.dispose(); else refreshWebview();
				});
				break;

			case "openFolderInNewWindow":
				saveRecentDirectory(message.path);
				vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(message.path), { forceNewWindow: true });
				refreshWebview();
				break;

			case "openWithDefaultApp":
				saveRecentDirectory(message.type === 'folder' ? message.path : path.dirname(message.path));
				const command = process.platform === 'win32' ? 'start ""' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
				cp.exec(`${command} "${message.path}"`);
				refreshWebview();
				break;

			case "quickDeleteToRecycleBin": // ✅ 2. 这是主要修改区域
				const itemToDelete = message.path;
				if (fs.existsSync(itemToDelete)) {
					saveRecentDirectory(currentPath);
					fileSizeCache = {};
					sizeCalculationPromises = {};
					vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: `正在将 ${path.basename(itemToDelete)} 移至回收站...`,
						cancellable: false
					}, () => {
						// ✅ 3. 将 Promise 的回调改为 async 函数，以便使用 await
						return new Promise(async (resolve, reject) => {
							try {
								// ✅ 4. 调用 trash()，它会处理好所有平台的回收站逻辑
								await trash([itemToDelete]);
								// 成功后，延迟刷新界面，确保文件系统已更新
								setTimeout(() => { refreshWebview(); resolve(); }, 300);
							} catch (error) {
								// ✅ 5. 统一的错误处理
								logMessage(`移至回收站失败: ${itemToDelete} - ${error.message}`, "ERROR");
								// 如果失败，通知 webview 恢复条目的显示状态
								panel.webview.postMessage({ command: 'restoreDeletedItem', path: itemToDelete });
								reject(error); // 将错误传递给 withProgress
							}
						});
					}).then(undefined, error => {
						// withProgress 的第二个回调函数用于捕获 reject 的错误
						vscode.window.showErrorMessage(`移至回收站失败: ${error.message}`);
					});
				} else {
					vscode.window.showWarningMessage(`删除失败：项目不存在。`);
					refreshWebview();
				}
				break;
		}
	});

	// 首次打开时加载内容
	refreshWebview();
}

// ==================== 模块激活 ====================

function activate(context) {
	getConfig(); // 初始化配置
	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.q2", showSaveAsDialog),
		vscode.commands.registerCommand("qqq.saveAsDialog", showSaveAsDialog),
	);
}

// ==================== 导出 ====================

module.exports = {
	activate
};

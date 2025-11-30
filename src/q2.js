const vscode = require("vscode");
const cp = require("child_process");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const trash = require("trash");

const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const CONFIG_PATH = "E:\\r\\pz.ini";
const SIZE_CONFIG_KEY = "size_mode";

const UNSUPPORTED_KODE_EXTENSIONS = new Set([
	".exe",
	".dll",
	".bin",
	".dat",
	".iso",
	".zip",
	".rar",
	".7z",
	".tar",
	".gz",
	".jpg",
	".jpeg",
	".png",
	".gif",
	".bmp",
	".webp",
	".ico",
	".mp3",
	".wav",
	".flac",
	".mp4",
	".avi",
	".mkv",
	".mov",
	".wmv",
	".pdf"
]);

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

let activePanel = null;
const usePanelReveal = 1;
let sizeMode = "none";

const folderSizeTasks = {
	tasks: new Map(),
	taskIdCounter: 0,
	addTask(folderPath, pyProcess) {
		const taskId = ++this.taskIdCounter;
		this.tasks.set(taskId, {
			id: taskId,
			folderPath,
			process: pyProcess,
			startTime: Date.now()
		});
		return taskId;
	},
	removeTask(taskId) {
		if (this.tasks.has(taskId)) this.tasks.delete(taskId);
	},
	terminateTask(taskId) {
		if (this.tasks.has(taskId)) {
			const task = this.tasks.get(taskId);
			try {
				task.process.kill("SIGTERM");
			} catch (error) {
				logMessage(`终止任务 ${taskId} 失败: ${error.message}`, "ERROR");
			}
			this.removeTask(taskId);
		}
	},
	terminateAllTasks() {
		const taskIds = Array.from(this.tasks.keys());
		taskIds.forEach(id => this.terminateTask(id));
		logMessage(`已终止 ${taskIds.length} 个文件夹大小查询任务`, "WARN");
	},
	getTaskCount() {
		return this.tasks.size;
	},
	getTask(taskId) {
		return this.tasks.get(taskId) || null;
	}
};

function escapeHtmlAttribute(str) {
	if (typeof str !== "string") str = String(str);
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeJsStringLiteral(str) {
	if (typeof str !== "string") str = String(str);
	return str
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

async function getDetailedErrorMessage(filePath, error, operation) {
	return `${operation}失败：文件正被占用。`;
}

function getSizeFromPython(paths) {
	return new Promise((resolve, reject) => {
		const pythonExecutable = "python";
		const scriptPath = path.join(__dirname, "kp.py");
		const args = ["get_size", ...paths];

		let taskId = null;
		const timeout = setTimeout(() => {
			if (taskId) folderSizeTasks.terminateTask(taskId);
			reject(new Error("Python脚本执行超时"));
		}, 30000);

		const pyProcess = spawn(pythonExecutable, [scriptPath, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
			windowsHide: true
		});

		taskId = folderSizeTasks.addTask(paths[0], pyProcess);

		let stdoutData = "";
		let stderrData = "";

		pyProcess.stdout.on("data", d => {
			stdoutData += d.toString();
		});

		pyProcess.stderr.on("data", d => {
			stderrData += d.toString();
		});

		pyProcess.on("close", code => {
			clearTimeout(timeout);
			folderSizeTasks.removeTask(taskId);

			if (code === 0) {
				try {
					const result = JSON.parse(stdoutData.trim());
					if (result.success) {
						resolve(result.total_size);
					} else {
						reject(new Error(`Python脚本执行失败: ${result.error || "未知错误"}`));
					}
				} catch (e) {
					reject(new Error(`解析Python输出失败: ${e.message}\nOutput: ${stdoutData}`));
				}
			} else {
				reject(new Error(`Python脚本以非零代码 ${code} 退出。\nStderr: ${stderrData}`));
			}
		});

		pyProcess.on("error", err => {
			clearTimeout(timeout);
			folderSizeTasks.removeTask(taskId);
			reject(new Error(`启动Python进程失败: ${err.message}`));
		});
	});
}

function formatFileSize(bytes, mode) {
	if (mode === "none") return { size: "", unit: "" };
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

function getFileSizeDisplayAsyncPromise(itemPath, mode) {
	return new Promise(resolve => {
		getFileSizeDisplayAsync(itemPath, mode, result => {
			resolve(result);
		});
	});
}

function getFileSizeDisplayAsync(itemPath, mode, callback) {
	if (mode === "none") {
		callback("");
		return;
	}
	fs.stat(itemPath, (err, stats) => {
		if (err) {
			logMessage(`计算大小失败: ${itemPath} - ${err.message}`, "ERROR");
			callback(" ...err ");
			return;
		}
		if (stats.isFile()) {
			const sizeInBytes = stats.size;
			const { size: displaySize, unit: displayUnit } = formatFileSize(sizeInBytes, mode);
			let spacesToFill = 0;
			if (displayUnit === "k") spacesToFill = 3;
			else if (displayUnit === "b") spacesToFill = 6;
			const finalDisplay = " ".repeat(spacesToFill) + displaySize + " " + displayUnit;
			callback(finalDisplay);
		} else {
			getSizeFromPython([itemPath])
				.then(sizeInBytes => {
					const { size: displaySize, unit: displayUnit } = formatFileSize(sizeInBytes, mode);
					let spacesToFill = 0;
					if (displayUnit === "k") spacesToFill = 3;
					else if (displayUnit === "b") spacesToFill = 6;
					const finalDisplay =
						" ".repeat(spacesToFill) + displaySize + " " + displayUnit;
					callback(finalDisplay);
				})
				.catch(error => {
					logMessage(`计算大小失败: ${itemPath} - ${error.message}`, "ERROR");
					callback(" ...err ");
				});
		}
	});
}

function getConfig() {
	const config = {
		recentDirs: [],
		lineSpacing: -2,
		sidebarWidth: 100,
		sidebarRatio: 0.2,
		recycleBin: [],
		isPinned: false,
		sizeMode: "none"
	};
	try {
		if (!fs.existsSync(CONFIG_PATH)) return config;
		const content = fs.readFileSync(CONFIG_PATH, "utf8");
		const qqqSectionMatch = content.match(/\[qqq\]([\s\S]*?)(\[|$)/);
		if (qqqSectionMatch) {
			const sectionContent = qqqSectionMatch[1];
			const recentDirsMatch = sectionContent.match(/recent_dirs=(.+)/);
			if (recentDirsMatch) {
				const dirs = recentDirsMatch[1]
					.split(",")
					.map(d => d.trim())
					.filter(Boolean);
				config.recentDirs = dirs;
			}
			const lineSpacingMatch = sectionContent.match(/line_spacing=(.+)/);
			if (lineSpacingMatch) {
				config.lineSpacing = parseInt(lineSpacingMatch[1].trim());
			}
			const sidebarWidthMatch = sectionContent.match(/sidebar_width=(.+)/);
			if (sidebarWidthMatch) {
				config.sidebarWidth = parseInt(sidebarWidthMatch[1].trim());
			}
			const sidebarRatioMatch = sectionContent.match(/sidebar_ratio=(.+)/);
			if (sidebarRatioMatch) {
				config.sidebarRatio = parseFloat(sidebarRatioMatch[1].trim());
				if (
					isNaN(config.sidebarRatio) ||
					config.sidebarRatio < 0.05 ||
					config.sidebarRatio > 0.5
				) {
					config.sidebarRatio = 0.2;
				}
			}
			const recycleBinMatch = sectionContent.match(/recycle_bin=(.+)/);
			if (recycleBinMatch) {
				const bins = recycleBinMatch[1]
					.split(",")
					.map(d => d.trim())
					.filter(Boolean);
				config.recycleBin = bins;
			}
			const isPinnedMatch = sectionContent.match(/is_pinned=(.+)/);
			if (isPinnedMatch) {
				const value = isPinnedMatch[1].trim().toLowerCase();
				config.isPinned = value === "true" || value === "1";
			}
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
	sizeMode = config.sizeMode;
	return config;
}

function saveConfig(
	recentDirs,
	lineSpacing,
	sidebarWidth,
	sidebarRatio,
	recycleBin,
	isPinned,
	newSizeMode
) {
	try {
		let content = "";
		if (fs.existsSync(CONFIG_PATH)) {
			content = fs.readFileSync(CONFIG_PATH, "utf8");
		}
		const newConfigs = {
			recent_dirs: recentDirs.join(","),
			line_spacing: lineSpacing,
			sidebar_width: sidebarWidth,
			sidebar_ratio: sidebarRatio.toFixed(4),
			recycle_bin: recycleBin.join(","),
			is_pinned: isPinned ? "true" : "false",
			[SIZE_CONFIG_KEY]: newSizeMode || "none"
		};
		const sectionContent = Object.entries(newConfigs)
			.map(([k, v]) => `${k}=${v}`)
			.join("\n");
		if (content.includes("[qqq]")) {
			content = content.replace(
				/\[qqq\]([\s\S]*?)(\[|$)/,
				`[qqq]\n${sectionContent}\n$2`
			);
		} else {
			const newSection = `
[qqq]
recent_dirs=${newConfigs.recent_dirs}
line_spacing=${newConfigs.line_spacing}
sidebar_width=${newConfigs.sidebar_width}
sidebar_ratio=${newConfigs.sidebar_ratio}
recycle_bin=${newConfigs.recycle_bin}
is_pinned=${newConfigs.is_pinned}
${SIZE_CONFIG_KEY}=${newConfigs[SIZE_CONFIG_KEY]}
`;
			content += newSection;
		}
		fs.writeFileSync(CONFIG_PATH, content, "utf8");
		sizeMode = newSizeMode;
	} catch (error) {
		logMessage("保存配置文件失败: " + error.message, "ERROR");
	}
}

function getRecentDirectories() {
	const config = getConfig();
	return config.recentDirs;
}

function removeFromRecycleBin(directory) {
	const config = getConfig();
	let updated = false;
	const newRecycleBin = config.recycleBin.filter(dir => {
		if (dir === directory) {
			updated = true;
			return false;
		}
		return true;
	});
	if (updated) {
		saveConfig(
			config.recentDirs,
			config.lineSpacing,
			config.sidebarWidth,
			config.sidebarRatio,
			newRecycleBin,
			config.isPinned,
			config.sizeMode
		);
	}
}

function addToRecycleBin(directory) {
	const config = getConfig();
	if (
		!directory ||
		!fs.existsSync(directory) ||
		typeof directory !== "string"
	) {
		return;
	}
	const newRecycleBin = config.recycleBin.filter(dir => dir !== directory);
	newRecycleBin.unshift(directory);
	const finalRecycleBin = newRecycleBin.slice(0, 60);
	saveConfig(
		config.recentDirs,
		config.lineSpacing,
		config.sidebarWidth,
		config.sidebarRatio,
		finalRecycleBin,
		config.isPinned,
		config.sizeMode
	);
}

function saveRecentDirectory(directory) {
	const config = getConfig();
	if (!directory || !fs.existsSync(directory)) return;
	removeFromRecycleBin(directory);
	let recentDirs = config.recentDirs.filter(dir => dir && dir !== directory);
	if (recentDirs.length >= 10) {
		const oldestDir = recentDirs.pop();
		addToRecycleBin(oldestDir);
	}
	recentDirs.unshift(directory);
	const finalRecentDirs = recentDirs.slice(0, 10);
	const updatedConfig = getConfig();
	saveConfig(
		finalRecentDirs,
		updatedConfig.lineSpacing,
		updatedConfig.sidebarWidth,
		updatedConfig.sidebarRatio,
		updatedConfig.recycleBin,
		updatedConfig.isPinned,
		updatedConfig.sizeMode
	);
}

function removeAndRecycleRecentDirectory(directory) {
	const config = getConfig();
	let updated = false;
	const newRecentDirs = config.recentDirs.filter(dir => {
		if (dir === directory) {
			updated = true;
			return false;
		}
		return true;
	});
	if (updated) {
		addToRecycleBin(directory);
		const updatedConfig = getConfig();
		saveConfig(
			newRecentDirs,
			updatedConfig.lineSpacing,
			updatedConfig.sidebarWidth,
			updatedConfig.sidebarRatio,
			updatedConfig.recycleBin,
			updatedConfig.isPinned,
			updatedConfig.sizeMode
		);
	}
	return updated;
}

function getDrives() {
	const drives = [];
	if (process.platform === "win32") {
		try {
			const child = cp.spawnSync("wmic", ["logicaldisk", "get", "caption"], {
				encoding: "utf8"
			});
			const output = child.stdout;
			const lines = output.split("\n");
			for (const line of lines) {
				const driveMatch = line.match(/([A-Z]:)/);
				if (driveMatch) drives.push(driveMatch[1]);
			}
		} catch (error) {
			logMessage("获取驱动器列表失败: " + error.message, "ERROR");
			drives.push("C:");
		}
	} else {
		drives.push("/");
	}
	return drives;
}

function getDirectoryContents(dirPath) {
	const contents = { dirs: [], files: [] };
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
						mtime: stat.mtime.toISOString()
					});
				} else {
					contents.files.push({
						name: entry.name,
						path: entryPath,
						isDir: false,
						mtime: stat.mtime.toISOString()
					});
				}
			} catch {
			}
		}
		contents.dirs.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
		contents.files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
	} catch (error) {
		logMessage(`读取目录内容失败: ${dirPath}`, "ERROR");
	}
	return contents;
}

function generateWebviewScript(currentSizeMode, currentPath, sidebarRatio) {
	const escapedCurrentPathForJsLiteral = escapeJsStringLiteral(currentPath);
	const escapedSizeModeForJsLiteral = escapeJsStringLiteral(currentSizeMode);
	const escapedSidebarRatio = sidebarRatio.toFixed(4);

	return `
        const vscode = acquireVsCodeApi();
        const sizeMode = '${escapedSizeModeForJsLiteral}';
        let currentPath = '${escapedCurrentPathForJsLiteral}';
        let sidebarRatio = ${escapedSidebarRatio};
        let resizeObserver = null;
        const MIN_RESPONSIVE_WIDTH = 240;
        const MIN_TAG_WIDTH = 170;
        const ROW_HEIGHT = 22;
        const PIN_HIDE_WIDTH = 360; // 从 300 调整为 360
        let baseRecentHeight = 0;

        function calculateAndAdjustScroll() {
            const recentSection = document.querySelector('.recent-section');
            const addressBar = document.querySelector('.address-bar');
            const fileList = document.getElementById('fileList');
            const mainContent = document.getElementById('mainContent');
            if (!recentSection || !addressBar || !fileList || !mainContent) return;

            const footerHeight = 60;
            const editorHeight = window.innerHeight - footerHeight;

            if (!baseRecentHeight && recentSection.style.display !== 'none') {
                baseRecentHeight = recentSection.offsetHeight || recentSection.scrollHeight || 0;
            }

            const addressHeight = addressBar.offsetHeight || 0;
            const needHeight = (baseRecentHeight || recentSection.offsetHeight || 0) + addressHeight + 100;

            if (editorHeight < needHeight) {
                recentSection.style.display = 'none';
            } else {
                recentSection.style.display = '';
            }

            // 根据真实内容高度决定是否需要滚动条，防止底部被截断
            const needScroll = mainContent.scrollHeight > mainContent.clientHeight + 1;
            mainContent.style.overflowY = needScroll ? 'auto' : 'hidden';
        }

        function checkAndApplyResponsive() {
            const container = document.querySelector('.container');
            if (!container) return;

            const currentWidth = container.clientWidth;
            const footer = document.querySelector('.footer');
            const pinContainer = document.getElementById('pinButton');
            const saveButton = footer.querySelector('.save-button');
            const createFolderBtn = footer.querySelector('.cancel-button');

            // 第一阶段：在 360px 以下先隐藏“长驻”按钮
            if (pinContainer) {
                if (currentWidth < PIN_HIDE_WIDTH) {
                    pinContainer.style.display = 'none';
                } else {
                    pinContainer.style.display = 'block';
                }
            }

            // 第二阶段：在 240px 以下再隐藏“新建文件”按钮
            if (currentWidth < MIN_RESPONSIVE_WIDTH) {
                if (saveButton) saveButton.style.display = 'none';
                if (createFolderBtn) createFolderBtn.style.display = 'block';
                footer.classList.add('responsive-narrow');
            } else {
                if (saveButton) saveButton.style.display = 'block';
                if (createFolderBtn) createFolderBtn.style.display = 'block';
                footer.classList.remove('responsive-narrow');
            }

            if (currentWidth < MIN_TAG_WIDTH) {
                if (createFolderBtn) createFolderBtn.style.display = 'none';
                footer.classList.add('responsive-extreme');
            } else {
                footer.classList.remove('responsive-extreme');
            }

            setTimeout(calculateAndAdjustScroll, 50);
        }

        document.addEventListener('DOMContentLoaded', () => {
            const filenameInput = document.getElementById('filenameInput');
            filenameInput.focus();
            updateResourceExplorer();

            adjustSidebarByRatio();

            window.addEventListener('resize', () => {
                adjustSidebarByRatio();
                checkAndApplyResponsive();
            });

            const container = document.querySelector('.container');
            if (container && 'ResizeObserver' in window) {
                resizeObserver = new ResizeObserver(() => {
                    adjustSidebarByRatio();
                    checkAndApplyResponsive();
                });
                resizeObserver.observe(container);
            }

            document.getElementById('fileList').addEventListener('click', (event) => {
                const fileItem = event.target.closest('.file-item');
                if (!fileItem) {
                    const prevSelected = document.querySelector('.file-item.selected');
                    if (prevSelected) {
                        const renameInput = prevSelected.querySelector('.rename-input');
                        if (renameInput) {
                            cancelRename(prevSelected);
                        }
                        prevSelected.classList.remove('selected');
                    }
                    selectedItem = null;
                    return;
                }

                const type = fileItem.dataset.type;
                const isSzArea = event.target.classList.contains('sz-area');
                const isSelectArea = event.target.closest('.file-select-area');
                const isFolderNameArea = event.target.closest('.folder-name-area');

                if (type === 'folder') {
                    // 左侧区域（图标和其左边）用于选中并触发大小计算
                    if (isSelectArea && !isFolderNameArea) {
                        selectFileItem(fileItem, true);
                        currentFocusType = 'fileList';
                        return;
                    }

                    // 右侧文字区域用于进入文件夹
                    if (isFolderNameArea) {
                        const path = fileItem.dataset.path;
                        vscode.postMessage({
                            command: 'navigate',
                            path: path
                        });
                        currentFocusType = 'fileList';
                        return;
                    }

                    // 其他区域默认只选中并触发大小计算
                    selectFileItem(fileItem, true);
                    currentFocusType = 'fileList';
                    return;
                }

                // 文件保持原有行为
                selectFileItem(fileItem, type === 'file');
                if (isSzArea) {
                    const path = fileItem.dataset.path;
                    const szArea = event.target;
                    szArea.textContent = '    \\u2022    ';
                    vscode.postMessage({
                        command: 'requestSize',
                        path: path,
                        type: type
                    });
                }
                currentFocusType = 'fileList';
            });

            checkAndApplyResponsive();
        });

        function adjustSidebarByRatio() {
            const container = document.querySelector('.container');
            const sidebar = document.querySelector('.sidebar');
            const resizer = document.getElementById('sidebarResizer');
            const mainContent = document.querySelector('.main-content');

            if (!container || !sidebar || !resizer || !mainContent) return;

            const totalWidth = container.clientWidth;
            let newWidth = Math.max(50, Math.min(500, totalWidth * sidebarRatio));

            sidebar.style.width = newWidth + 'px';
            resizer.style.left = newWidth + 'px';
            mainContent.style.left = newWidth + 'px';
        }

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
                if (type !== 'file') return;

                if (szArea) {
                    if (sizeMode !== 'none') {
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
                setTimeout(() => {
                    calculateAndAdjustScroll();
                    checkAndApplyResponsive();
                }, 100);
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
            else if (message.command === 'updateSidebarRatio') {
                sidebarRatio = message.ratio;
                adjustSidebarByRatio();
            }
            else if (message.command === 'focusInput') {
                const filenameInput = document.getElementById('filenameInput');
                if (filenameInput) {
                    filenameInput.focus();
                    filenameInput.select();
                }
            }
        });

        function requestFileSizeUpdates(items) {
            if (sizeMode === 'none') return;

            items.forEach(item => {
                if (item.name === '..') return;
                if (item.type !== 'file') return;

                const safePathSelector = item.path.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
                const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"].\${item.type}\`);
                if (itemElement) {
                    const szArea = itemElement.querySelector('.sz-area');
                    if (szArea) {
                        szArea.textContent = '    \\u2022    ';
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

        function isPinned() {
            const pinBox = document.querySelector('#pinButton .pin-box');
            return !!(pinBox && pinBox.classList.contains('pinned'));
        }

        function selectFileItem(fileItem, requestSize) {
            if (!fileItem) return;
            const type = fileItem.dataset.type;
            const path = fileItem.dataset.path;
            const name = fileItem.dataset.name;

            const prevSelected = document.querySelector('.file-item.selected');
            if (prevSelected && prevSelected !== fileItem) {
                const renameInput = prevSelected.querySelector('.rename-input');
                if (renameInput) {
                    cancelRename(prevSelected);
                }
                prevSelected.classList.remove('selected');
            }

            fileItem.classList.add('selected');
            selectedItem = { type, path, name };
            currentFocusType = 'fileList';

            if (sizeMode !== 'none' && requestSize) {
                const szArea = fileItem.querySelector('.sz-area');
                if (szArea) szArea.textContent = '    \\u2022    ';
                vscode.postMessage({
                    command: 'requestSize',
                    path: path,
                    type: type
                });
            }
        }

        let renameBlurHandler = null;

        function startRename(itemPath, itemName, itemType) {
            const safePathSelector = itemPath.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\"');
            const itemElement = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
            if (!itemElement) return;

            const prevSelected = document.querySelector('.file-item.selected');
            if (prevSelected && prevSelected !== itemElement) {
                const renameInput = prevSelected.querySelector('.rename-input');
                if (renameInput) {
                    cancelRename(prevSelected);
                }
                prevSelected.classList.remove('selected');
            }
            itemElement.classList.add('selected');
            selectedItem = { type: itemType, path: itemPath, name: itemName };

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
                const pinned = isPinned();
                vscode.postMessage({
                    command: 'editFile',
                    path: itemToKode.path,
                    isPinned: pinned,
                    openInCurrentGroup: !pinned
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
            const item = document.querySelector(\`.file-item[data-path="\${safePathSelector}"\`);
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
            e.stopPropagation();
            hideAllContextMenus();

            const itemElement = e.target.closest('.file-item');
            const emptyContextMenu = document.getElementById('emptyContextMenu');

            if (itemElement) {
                selectFileItem(itemElement, false);

                const itemPath = itemElement.dataset.path;
                const itemName = itemElement.dataset.name;
                const itemType = itemElement.dataset.type;

                if (itemType === 'folder') {
                    const szArea = itemElement.querySelector('.sz-area');
                    if (szArea) {
                        szArea.textContent = '    \\u2022    ';
                    }
                    vscode.postMessage({
                        command: 'requestSize',
                        path: itemPath,
                        type: itemType
                    });
                }

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

        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('#fileList')) {
                e.preventDefault();
                e.stopPropagation();
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
            else if (event.ctrlKey && (key === 'a' || key === 'c' || key === 'x')) {
                event.preventDefault();
                event.stopPropagation();
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
            const container = document.querySelector('.container');

            sidebarResizer.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                startWidth = sidebar.offsetWidth;
                sidebarResizer.classList.add('active');
                document.body.style.userSelect = 'none';
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const deltaX = e.clientX - startX;
                let newWidth = startWidth + deltaX;
                const totalWidth = container ? container.clientWidth : window.innerWidth;
                const newRatio = Math.max(0.05, Math.min(0.5, newWidth / totalWidth));
                newWidth = totalWidth * newRatio;
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

                const container = document.querySelector('.container');
                const totalWidth = container ? container.clientWidth : window.innerWidth;
                const finalWidth = parseInt(sidebar.style.width) || 100;
                const newRatio = finalWidth / totalWidth;

                vscode.postMessage({
                    command: 'saveSidebarRatio',
                    ratio: newRatio
                });

                sidebarRatio = newRatio;
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
        }
    `;
}

function getWebviewContent(currentPath) {
	const currentConfig = getConfig();
	const drives = getDrives();

	const LINE_SPACING = currentConfig.lineSpacing;
	const SIDEBAR_WIDTH = currentConfig.sidebarWidth;
	const SIDEBAR_RATIO = currentConfig.sidebarRatio;
	const currentRecentDirs = currentConfig.recentDirs;
	const currentSizeMode = currentConfig.sizeMode;

	const showRecycleBinSetting = vscode.workspace
		.getConfiguration("qqq")
		.get("showHistoryRecycleBin", true);

	const safeRecentDirs =
		currentRecentDirs && currentRecentDirs.length > 0
			? currentRecentDirs.filter(dir => dir && fs.existsSync(dir))
			: [];

	const safeRecycleBin =
		currentConfig.recycleBin && Array.isArray(currentConfig.recycleBin)
			? currentConfig.recycleBin.filter(
				dir => dir && typeof dir === "string" && fs.existsSync(dir)
			)
			: [];

	const showRecycleBin = showRecycleBinSetting && safeRecycleBin.length > 0;
	const isPinned = currentConfig.isPinned || false;

	const templatePath = path.join(__dirname, "q2.html");
	let htmlTemplate = "";
	try {
		htmlTemplate = fs.readFileSync(templatePath, "utf8");
	} catch (error) {
		logMessage(`无法读取 q2.html 模板文件: ${error.message}`, "ERROR");
		return `<h1>错误: 无法加载 q2.html 模板</h1><p>${error.message}</p>`;
	}

	const drivesHtml = drives
		.map(
			drive => `
            <button class="nav-item" onclick="navigateTo('${escapeJsStringLiteral(
				drive
			)}')">${escapeHtmlAttribute(drive)}</button>
            `
		)
		.join("");

	const recycleBinHtml = showRecycleBin
		? `
        <div class="divider"></div>
        <div class="recycle-bin-section">
            <div class="recycle-bin-header">历史回收站 (${safeRecycleBin.length}/60)</div>
            ${safeRecycleBin
			.map(
				dir => `
            <div class="recycle-item" onclick="navigateTo('${escapeJsStringLiteral(
					dir
				)}')">${escapeHtmlAttribute(dir)}</div>
            `
			)
			.join("")}
        </div>
        `
		: "";

	const recentDirsHtml = safeRecentDirs
		.reverse()
		.map(
			dir => `
            <div class="recent-item" onclick="navigateTo('${escapeJsStringLiteral(
				dir
			)}')">
                <span class="delete-button" onclick="event.stopPropagation(); removeFromRecent('${escapeJsStringLiteral(
				dir
			)}')">×</span>
                <span>${escapeHtmlAttribute(dir)}</span>
            </div>
            `
		)
		.join("");

	const inlineScript = generateWebviewScript(currentSizeMode, currentPath, SIDEBAR_RATIO);

	let finalHtml = htmlTemplate;
	finalHtml = finalHtml.split("{{SIDEBAR_WIDTH}}").join(SIDEBAR_WIDTH);
	finalHtml = finalHtml.split("{{LINE_SPACING}}").join(LINE_SPACING);
	finalHtml = finalHtml.split("{{DRIVES_HTML}}").join(drivesHtml);
	finalHtml = finalHtml.split("{{RECYCLE_BIN_HTML}}").join(recycleBinHtml);
	finalHtml = finalHtml.split("{{RECENT_DIRS_HTML}}").join(recentDirsHtml);
	finalHtml = finalHtml.split("{{CURRENT_PATH}}").join(escapeHtmlAttribute(currentPath));

	finalHtml = finalHtml.split("{{PIN_CLASS}}").join(isPinned ? "pinned" : "");
	finalHtml = finalHtml.split("{{PIN_CHECKBOX}}").join(isPinned ? "✓" : "□");
	finalHtml = finalHtml.split("{{SIZE_MODE_NONE_CLASS}}").join(currentSizeMode === "none" ? "selected" : "");
	finalHtml = finalHtml.split("{{SIZE_MODE_M_CLASS}}").join(currentSizeMode === "m" ? "selected" : "");
	finalHtml = finalHtml.split("{{SIZE_MODE_K_CLASS}}").join(currentSizeMode === "k" ? "selected" : "");
	finalHtml = finalHtml.split("{{SIZE_MODE_B_CLASS}}").join(currentSizeMode === "b" ? "selected" : "");

	const safeInlineScript = inlineScript.replace(/<\/script>/gi, "<\\/script>");
	finalHtml = finalHtml.split("{{INLINE_SCRIPT}}").join(safeInlineScript);

	return finalHtml;
}

function showSaveAsDialog() {
	if (activePanel !== null && !activePanel.disposed) {
		if (usePanelReveal === 1) {
			activePanel.reveal(vscode.ViewColumn.Active);
		}
		setTimeout(() => {
			if (activePanel && !activePanel.disposed) {
				activePanel.webview.postMessage({ command: "focusInput" });
			}
		}, 100);
		return;
	}

	const config = getConfig();
	const recentDirs = config.recentDirs;
	let currentPath =
		recentDirs.length > 0 ? recentDirs[0] : process.env.USERPROFILE || "C:\\";

	try {
		if (!fs.existsSync(currentPath)) {
			currentPath = process.env.USERPROFILE || "C:\\";
		} else if (!fs.statSync(currentPath).isDirectory()) {
			currentPath = path.dirname(currentPath);
		}
	} catch {
		currentPath = process.env.USERPROFILE || "C:\\";
	}

	const panel = vscode.window.createWebviewPanel(
		"q2",
		"qqq new 新建",
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true
		}
	);

	activePanel = panel;

	// 智能选择打开目标分组：保证右侧最多开一组，并尽量往右堆
	function getSmartShowOptions(openInCurrentGroup) {
		const baseOptions = { preserveFocus: false };

		// 兼容老版本 VS Code：没有 tabGroups 就退回原行为
		if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) {
			if (openInCurrentGroup) {
				return baseOptions;
			}
			return Object.assign({}, baseOptions, { viewColumn: vscode.ViewColumn.Beside });
		}

		const tabGroups = vscode.window.tabGroups;
		const allGroups = tabGroups.all || [];
		const activeGroup = tabGroups.activeTabGroup;

		let baseColumn =
			panel.viewColumn ||
			(activeGroup ? activeGroup.viewColumn : vscode.ViewColumn.One) ||
			vscode.ViewColumn.One;

		if (openInCurrentGroup) {
			return Object.assign({}, baseOptions, { viewColumn: baseColumn });
		}

		if (!allGroups.length) {
			return Object.assign({}, baseOptions, { viewColumn: baseColumn });
		}

		const sorted = allGroups
			.filter(g => typeof g.viewColumn === "number")
			.sort((a, b) => a.viewColumn - b.viewColumn);

		let baseGroup = sorted.find(g => g.viewColumn === baseColumn) || sorted[0];
		baseColumn = baseGroup.viewColumn;

		// 尝试使用右侧最近的一组
		const rightGroups = sorted.filter(g => g.viewColumn > baseColumn);
		if (rightGroups.length > 0) {
			return Object.assign({}, baseOptions, { viewColumn: rightGroups[0].viewColumn });
		}

		// 右侧没有分组时，如果还没到第三列，并且最大列小于三，则在右侧新开一组
		const maxColumn = sorted[sorted.length - 1].viewColumn;
		if (baseGroup.viewColumn < vscode.ViewColumn.Three && maxColumn < vscode.ViewColumn.Three) {
			return Object.assign({}, baseOptions, { viewColumn: baseGroup.viewColumn + 1 });
		}

		// 实在不能在右侧开新组，则向左找最近的一组
		const leftGroups = sorted.filter(g => g.viewColumn < baseColumn);
		if (leftGroups.length > 0) {
			return Object.assign({}, baseOptions, { viewColumn: leftGroups[leftGroups.length - 1].viewColumn });
		}

		// 左右都不行，只能覆盖当前组
		return Object.assign({}, baseOptions, { viewColumn: baseColumn });
	}

	const iconPath = path.join(__dirname, "..", "assets", "icon.png");
	if (fs.existsSync(iconPath)) {
		panel.iconPath = vscode.Uri.file(iconPath);
	}

	panel.onDidDispose(() => {
		folderSizeTasks.terminateAllTasks();
		activePanel = null;
	});

	function updateResourceExplorer() {
		try {
			if (!panel || panel.disposed) return;

			const directoryContents = getDirectoryContents(currentPath);
			const items = [];
			let fileListHtml = "";

			if (
				currentPath.length > 3 &&
				path.dirname(currentPath) !== currentPath
			) {
				const parentPath = path.dirname(currentPath);
				const parentItem = { path: parentPath, name: "..", type: "folder" };
				items.push(parentItem);

				fileListHtml += `
                <div class="file-item folder" data-path="${escapeHtmlAttribute(
					parentPath
				)}" data-name=".." data-type="folder">
                    <div class="file-select-area">
                        <div class="sz-area"></div>
                        <span class="file-icon">📁</span>
                    </div>
                    <div class="folder-name-area">
                        <span class="file-name">..</span>
                    </div>
                </div>`;
			}

			directoryContents.dirs.forEach(dir => {
				items.push({ path: dir.path, name: dir.name, type: "folder" });
				fileListHtml += `
                <div class="file-item folder" data-path="${escapeHtmlAttribute(
					dir.path
				)}" data-name="${escapeHtmlAttribute(
					dir.name
				)}" data-type="folder">
                    <div class="file-select-area">
                        <div class="sz-area"></div>
                        <span class="file-icon">📁</span>
                    </div>
                    <div class="folder-name-area">
                        <span class="file-name">${escapeHtmlAttribute(dir.name)}</span>
                    </div>
                </div>`;
			});

			directoryContents.files.forEach(file => {
				items.push({ path: file.path, name: file.name, type: "file" });
				fileListHtml += `
                <div class="file-item file" data-path="${escapeHtmlAttribute(
					file.path
				)}" data-name="${escapeHtmlAttribute(
					file.name
				)}" data-type="file">
                    <div class="file-select-area">
                        <div class="sz-area"></div>
                        <span class="file-icon">📄</span>
                    </div>
                    <div class="file-name-area">
                        <span class="file-name">${escapeHtmlAttribute(file.name)}</span>
                    </div>
                </div>`;
			});

			panel.webview.postMessage({
				command: "update",
				currentPath: currentPath,
				fileListHtml: fileListHtml,
				items: items
			});
		} catch (error) {
			logMessage(`更新资源展示区失败: ${error}`, "ERROR");
		}
	}

	function refreshWebview() {
		if (panel && !panel.disposed) {
			panel.webview.html = getWebviewContent(currentPath);
			setTimeout(() => {
				updateResourceExplorer();
				panel.webview.postMessage({ command: "focusInput" });
			}, 100);
		}
	}

	panel.webview.onDidReceiveMessage(async message => {
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
					currentConfig.recentDirs,
					currentConfig.lineSpacing,
					currentConfig.sidebarWidth,
					currentConfig.sidebarRatio,
					currentConfig.recycleBin,
					currentConfig.isPinned,
					message.mode
				);
				refreshWebview();
				break;

			case "requestSize":
				if (currentSizeMode === "none") break;
				try {
					const display = await getFileSizeDisplayAsyncPromise(
						message.path,
						currentSizeMode
					);
					if (panel && !panel.disposed) {
						panel.webview.postMessage({
							command: "updateSize",
							path: message.path,
							type: message.type,
							sizeDisplay: display
						});
					}
				} catch { }
				break;

			case "refreshSize":
				if (currentSizeMode === "none") break;
				try {
					const display = await getFileSizeDisplayAsyncPromise(
						message.path,
						currentSizeMode
					);
					if (panel && !panel.disposed) {
						panel.webview.postMessage({
							command: "updateSize",
							path: message.path,
							type: message.type,
							sizeDisplay: display
						});
					}
				} catch { }
				break;

			case "renameItem":
				try {
					const { oldPath, newName } = message;
					const newPath = path.join(path.dirname(oldPath), newName);
					if (fs.existsSync(newPath)) {
						vscode.window.showErrorMessage(
							`重命名失败：目标位置已存在同名项。`
						);
						refreshWebview();
					} else {
						fs.renameSync(oldPath, newPath);
						saveRecentDirectory(path.dirname(oldPath));
						setTimeout(() => refreshWebview(), 100);
					}
				} catch (error) {
					logMessage("重命名失败: " + error.message, "ERROR");
					getDetailedErrorMessage(message.oldPath, error, "重命名").then(
						detailedError => {
							vscode.window.showErrorMessage(detailedError);
						}
					);
					refreshWebview();
				}
				break;

			case "navigate":
				try {
					folderSizeTasks.terminateAllTasks();

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
				folderSizeTasks.terminateAllTasks();
				const parentDir = path.dirname(currentPath);
				if (parentDir !== currentPath) {
					currentPath = parentDir;
					refreshWebview();
				}
				break;

			case "saveSidebarRatio":
				const newRatio = message.ratio;
				saveConfig(
					currentConfig.recentDirs,
					currentConfig.lineSpacing,
					currentConfig.sidebarWidth,
					newRatio,
					currentConfig.recycleBin,
					currentConfig.isPinned,
					currentConfig.sizeMode
				);
				if (panel && !panel.disposed) {
					panel.webview.postMessage({
						command: "updateSidebarRatio",
						ratio: newRatio
					});
				}
				break;

			case "saveSidebarWidth":
				break;

			case "togglePin":
				saveConfig(
					currentConfig.recentDirs,
					currentConfig.lineSpacing,
					currentConfig.sidebarWidth,
					currentConfig.sidebarRatio,
					currentConfig.recycleBin,
					message.isPinned,
					currentConfig.sizeMode
				);
				break;

			case "save":
				{
					const { filename, isPinned, openInCurrentGroup } = message;
					const fullFilePath = path.join(currentPath, filename);

					const createFileAction = () => {
						try {
							if (
								fs.existsSync(fullFilePath) &&
								fs.statSync(fullFilePath).isDirectory()
							) {
								vscode.window.showErrorMessage(
									`无法创建文件，因为已存在同名文件夹: "${filename}"`
								);
								return;
							}

							fs.writeFileSync(fullFilePath, "\n".repeat(199), "utf8");

							saveRecentDirectory(currentPath);

							vscode.workspace.openTextDocument(fullFilePath).then(doc => {
								const showOptions = getSmartShowOptions(openInCurrentGroup);
								vscode.window.showTextDocument(doc, showOptions).then(() => {
									if (!isPinned) {
										panel.dispose();
									} else {
										refreshWebview();
									}
								});
							});
						} catch (error) {
							logMessage(`创建文件失败: ${error.message}`, "ERROR");
							vscode.window.showErrorMessage(
								`创建文件失败: ${error.message}`
							);
						}
					};

					if (fs.existsSync(fullFilePath)) {
						const stats = fs.statSync(fullFilePath);
						if (stats.isDirectory()) {
							vscode.window.showErrorMessage(
								`无法创建文件，因为已存在同名文件夹: "${filename}"`
							);
						} else {
							vscode.window
								.showWarningMessage(
									`文件 "${filename}" 已存在，是否覆盖？`,
									{ modal: true },
									"是",
									"否"
								)
								.then(answer => {
									if (answer === "是") {
										createFileAction();
									}
								});
						}
					} else {
						createFileAction();
					}
				}
				break;

			case "createFolder":
				{
					const newFolderPath = path.join(currentPath, message.folderName);
					if (fs.existsSync(newFolderPath)) {
						vscode.window.showErrorMessage(
							`无法创建，"${message.folderName}" 已存在。`
						);
					} else {
						fs.mkdirSync(newFolderPath);
						saveRecentDirectory(currentPath);
						refreshWebview();
						if (panel && !panel.disposed)
							panel.webview.postMessage({
								command: "clearFilenameInput"
							});
					}
				}
				break;

			case "cancel":
				panel.dispose();
				break;

			case "editFile":
				saveRecentDirectory(path.dirname(message.path));

				{
					const ext = path.extname(message.path).toLowerCase();
					if (UNSUPPORTED_KODE_EXTENSIONS.has(ext)) {
						const displayName = path.basename(message.path);
						const warnMessage = `该文件不支持在 VS Code 里打开: "${displayName}"`;
						vscode.window.showWarningMessage(warnMessage);
						vscode.window.setStatusBarMessage(warnMessage, 5000);
						break;
					}
				}

				vscode.workspace.openTextDocument(message.path).then(doc => {
					const showOptions = getSmartShowOptions(message.openInCurrentGroup);
					vscode.window.showTextDocument(doc, showOptions).then(() => {
						if (!message.isPinned) {
							panel.dispose();
						}
						// isPinned 时不刷新 WebView，这样选中状态会保持
					});
				}).catch(error => {
					logMessage("打开文件失败: " + error.message, "ERROR");
					vscode.window.showErrorMessage("打开文件失败: " + error.message);
				});
				break;

			case "openFolderInNewWindow":
				saveRecentDirectory(message.path);
				vscode.commands.executeCommand(
					"vscode.openFolder",
					vscode.Uri.file(message.path),
					{ forceNewWindow: true }
				);
				refreshWebview();
				break;

			case "openWithDefaultApp":
				saveRecentDirectory(
					message.type === "folder"
						? message.path
						: path.dirname(message.path)
				);
				const command =
					process.platform === "win32"
						? 'start ""'
						: process.platform === "darwin"
							? "open"
							: "xdg-open";
				cp.exec(`${command} "${message.path}"`);
				refreshWebview();
				break;

			case "quickDeleteToRecycleBin":
				{
					const itemToDelete = message.path;
					if (fs.existsSync(itemToDelete)) {
						saveRecentDirectory(currentPath);

						(async () => {
							try {
								await trash([itemToDelete]);
								setTimeout(() => {
									refreshWebview();
								}, 300);

								let displayPath = itemToDelete;
								if (itemToDelete.length > 61) {
									displayPath =
										itemToDelete.substring(0, 28) +
										"⋯" +
										itemToDelete.substring(
											itemToDelete.length - 28
										);
								}

								const successMessage = `${displayPath} 已移至回收站`;
								vscode.window.showInformationMessage(
									successMessage
								);

								setTimeout(() => { }, 11000);
							} catch (error) {
								logMessage(
									`移至回收站失败: ${itemToDelete} - ${error.message}`,
									"ERROR"
								);
								panel.webview.postMessage({
									command: "restoreDeletedItem",
									path: itemToDelete
								});

								const errorMessage = "删除失败：文件正被占用。";
								vscode.window.showErrorMessage(errorMessage);

								setTimeout(() => { }, 11000);
							}
						})();
					} else {
						vscode.window.showWarningMessage(
							`删除失败：项目不存在。`
						);
						refreshWebview();
					}
				}
				break;
		}
	});

	refreshWebview();
}

function activate(context) {
	getConfig();
	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.q2", showSaveAsDialog),
		vscode.commands.registerCommand("qqq.saveAsDialog", showSaveAsDialog)
	);
}

module.exports = {
	activate
};

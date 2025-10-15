const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
let sharp;

// 全局变量，用于跟踪是否已打开一个窗口
let activePanel = null;

// 面板焦点控制开关：0-不使用panel.reveal，1-使用panel.reveal
const usePanelReveal = 0;

try {
    sharp = require("sharp");
} catch (e) {
    sharp = null;
    console.log("Sharp库未安装，无法调整图片尺寸");
}

const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";
const CONFIG_PATH = "E:\\r\\pz.ini"; // 统一配置文件路径
const SIZE_CONFIG_KEY = "size_mode"; // 新增文件大小显示模式配置键

// 文件大小缓存 (键为完整路径，值为 {size: number, unit: string, isFolderTotal: boolean})
let fileSizeCache = {};
// 正在进行的异步计算，防止重复计算（键为文件夹路径）
let sizeCalculationPromises = {};
// 默认大小显示模式：none, m, k, b
let sizeMode = "none";

// 日志
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

// -------- q1 粘贴逻辑 (保持不变) --------
// ... (runPythonScript 和 executeClipboardCommand, handleResult 保持不变)
// 通用Python脚本执行函数
function runPythonScript(additionalEnv = {}) {
    const scriptPath = path.join(__dirname, "kp.py");
    if (!fs.existsSync(scriptPath)) {
        logMessage("脚本不存在: " + scriptPath, "ERROR");
        vscode.window.showErrorMessage("脚本不存在");
        return;
    }

    // 合并基础环境变量和额外环境变量
    const env = {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        ...additionalEnv,
    };

    const child = cp.spawn("python", [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: env,
    });

    let stdout = "";
    let stderr = "";
    // 明确指定 UTF-8 编码
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("close", (code) => {
        if (stderr) logMessage("Python stderr: " + stderr, "WARN");
        if (code !== 0) {
            logMessage("退出码 " + code, "ERROR");
            vscode.window.showErrorMessage("执行失败 " + code);
            return;
        }
        try {
            const result = JSON.parse(stdout.trim());
            handleResult(result);
        } catch (e) {
            logMessage("JSON解析失败: " + e.message, "ERROR");
        }
    });
}

// 初始粘贴命令函数
function executeClipboardCommand() {
    runPythonScript();
}

function handleResult(result) {
    if (result.error) {
        logMessage("处理失败: " + result.error, "ERROR");
        vscode.window.showErrorMessage(result.error);
        return;
    }
    const ed = vscode.window.activeTextEditor;
    switch (result.type) {
        case "folder_text":
            // 处理文件夹路径，直接插入文本，不做任何修饰
            if (ed) {
                ed.edit((edit) => edit.insert(ed.selection.active, result.text));
            }
            break;
        case "text":
            if (ed) {
                ed.edit((edit) => edit.insert(ed.selection.active, result.text)).then(
                    () => {
                        setTimeout(() => renderImages(ed), 50);
                    },
                );
            }
            break;
        case "image":
            if (ed) {
                ed.edit((edit) =>
                    edit.insert(ed.selection.active, `[${result.path}]`),
                ).then(() => {
                    setTimeout(() => renderImages(ed), 50);
                });
            }
            break;
        case "file":
            if (result.files && result.files.length > 0) {
                if (ed) {
                    // 插入所有文件的标识符，无论什么格式
                    const fileMarkers = result.files.map((f) => `[${f}]`).join("\n");
                    ed.edit((edit) => edit.insert(ed.selection.active, fileMarkers)).then(
                        () => {
                            setTimeout(() => renderImages(ed), 50);
                        },
                    );
                }
                vscode.window.showInformationMessage(
                    "文件已复制 " + result.files.length,
                );
            }
            break;
        case "binary":
            vscode.window.showInformationMessage(
                "二进制已保存 " + path.basename(result.path),
            );
            break;
        case "cancelled":
            // 用户取消了粘贴操作
            vscode.window.showInformationMessage("粘贴已取消");
            break;
        default:
            vscode.window.showWarningMessage("未知内容");
    }
}
// ... (Decoration & CodeLens, 渲染优化相关函数 保持不变)
// -------- Decoration & CodeLens (保持不变) --------
let blockMode = false;
let decorationType;

// 清理装饰的函数
function clearDecorations() {
    if (decorationType) {
        try {
            decorationType.dispose();
        } catch (e) { }
        decorationType = null;
    }
}

// 异步处理图片渲染
async function renderImages(editor) {
    if (!editor) return;

    // 清理旧装饰
    clearDecorations();

    // 创建新的装饰类型
    decorationType = vscode.window.createTextEditorDecorationType({});
    const decos = [];
    const regex = /\[([A-Za-z]:[\\\/]view[\\\/]p[\\\/][^\[\]]+)\]/gi;

    // 只处理可视区域内的文本
    const visibleRanges = editor.visibleRanges;
    if (!visibleRanges || visibleRanges.length === 0) return;

    for (const range of visibleRanges) {
        // 获取可视区域内的文本
        const text = editor.document.getText(range);

        // 重置正则表达式的lastIndex
        regex.lastIndex = 0;
        let match;

        while ((match = regex.exec(text))) {
            // 计算匹配项在文档中的实际位置
            const offsetInVisibleRange =
                editor.document.offsetAt(range.start) + match.index;
            const pos = editor.document.positionAt(offsetInVisibleRange);
            const endPos = pos.translate(0, match[0].length);
            const decoRange = new vscode.Range(pos, endPos);

            const absPath = match[1].replace(/\//g, "\\");

            // 检查文件是否存在 - 不记录不存在的文件日志，避免日志堆积
            if (!fs.existsSync(absPath)) {
                continue;
            }

            const ext = path.extname(absPath).toLowerCase();

            const isImage = [
                ".png",
                ".jpg",
                ".jpeg",
                ".gif",
                ".bmp",
                ".webp",
                ".ico",
                ".tiff",
                ".tif",
            ].includes(ext);

            // 创建装饰对象
            const deco = {
                range: decoRange,
                renderOptions: {},
            };

            // 所有资源类型统一处理方式，保持原始文字显示
            if (isImage) {
                try {
                    if (sharp) {
                        // 统一目标尺寸：512x288
                        const TARGET_WIDTH = 512;
                        const TARGET_HEIGHT = 288;

                        // 获取图片的MIME类型
                        let mime;
                        if (ext === ".jpg" || ext === ".jpeg") {
                            mime = "jpeg";
                        } else if (ext === ".gif") {
                            mime = "gif";
                        } else if (ext === ".webp") {
                            mime = "webp";
                        } else {
                            mime = "png";
                        }

                        // 统一目标尺寸：512x288
                        // 原图小于此尺寸时，保留原图大小并在四周填充透明像素
                        // 原图大于此尺寸时，等比缩放到适应此尺寸
                        const buffer = await sharp(absPath)
                            .resize(TARGET_WIDTH, TARGET_HEIGHT, {
                                fit: "contain", // 保持原图比例，在目标尺寸内完全显示
                                position: "center", // 居中显示
                                background: { r: 0, g: 0, b: 0, alpha: 0 }, // 透明背景填充
                            })
                            .toBuffer();

                        const base64 = buffer.toString("base64");
                        const dataUri = vscode.Uri.parse(
                            `data:image/${mime};base64,${base64}`,
                        );

                        // 设置图片装饰选项 - 512x288图片区域，516x292虚线框，橙黄色背景
                        // 调整为绝对靠左显示
                        deco.renderOptions.after = {
                            contentIconPath: dataUri,
                            margin: blockMode ? "4px 0 4px -227px" : "4px 0 4px -227px", // 负左边距让图片更靠左
                            height: "294px",
                            width: "518px",
                            // 使用padding和backgroundColor来创建橙黄色背景和虚线框效果
                            padding: "2px",
                            border: "1px dashed #888",
                            backgroundColor: "#fff3cd", // 橙黄色背景色
                            display: "block",
                            position: "relative", // 使图片相对于其正常位置定位
                        };
                    } else {
                        // 如果没有sharp库，使用原始方式显示
                        deco.renderOptions.after = {
                            contentIconPath: vscode.Uri.file(absPath),
                            margin: blockMode ? "4px 0 4px -227px" : "4px 0 4px -227px", // 负左边距让图片更靠左
                            height: blockMode ? "auto" : "148px",
                            width: "auto",
                            border: "1px dashed #888",
                            backgroundColor: "rgba(230, 230, 250, 0.2)",
                            display: "block",
                            position: "relative", // 使图片相对于其正常位置定位
                        };
                    }
                } catch (error) {
                    logMessage("处理图片失败: " + error.message, "WARN");
                    // 出错时使用原始方式显示
                    deco.renderOptions.after = {
                        contentIconPath: vscode.Uri.file(absPath),
                        margin: blockMode ? "4px 0 4px -227px" : "4px 0 4px -227px", // 负左边距让图片更靠左
                        height: blockMode ? "auto" : "148px",
                        width: "auto",
                        border: "1px dashed #888",
                        backgroundColor: "rgba(230, 230, 250, 0.2)",
                        display: "block",
                        position: "relative", // 使图片相对于其正常位置定位
                    };
                }
            } else {
                // 非图片文件只添加简单装饰，不隐藏原始文字
                deco.renderOptions.textDecoration = "underline wavy #888";
                deco.renderOptions.backgroundColor = "rgba(230, 230, 250, 0.1)";
                // 确保字符串显示在正确的位置
                deco.renderOptions.fontSize = "14px";
                deco.renderOptions.lineHeight = "1.2";
                deco.renderOptions.display = "block";
            }

            decos.push(deco);
        }
    }

    // 应用装饰
    editor.setDecorations(decorationType, decos);
}

class FileCodeLensProvider {
    provideCodeLenses(document) {
        const lenses = [];
        const regex = /\[([A-Za-z]:[\\\/]view[\\\/]p[\\\/][^\[\]]+)\]/gi;
        const text = document.getText();
        let match;

        while ((match = regex.exec(text))) {
            const pos = document.positionAt(match.index);
            const range = new vscode.Range(pos, pos);
            const absPath = match[1].replace(/\//g, "\\");

            // 检查文件是否存在
            if (fs.existsSync(absPath)) {
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: blockMode ? "qqq" : "aaa",
                        command: "qqq.openFile",
                        arguments: [absPath],
                    }),
                );
            }
        }
        return lenses;
    }
}

// -------- 渲染优化相关函数 (保持不变) --------
// 防抖处理函数，避免短时间内多次触发渲染
// 添加冷却时间机制：正在执行渲染时忽略新的触发
function debounceRender(editor, delay = 100) {
    // 如果正在执行渲染，忽略新的触发
    if (debounceRender.isProcessing) {
        return;
    }

    clearTimeout(debounceRender.timer);
    debounceRender.timer = setTimeout(() => {
        if (editor && !editor.document.isClosed) {
            // 标记为正在处理
            debounceRender.isProcessing = true;

            // 执行渲染，并在完成后取消处理标记
            Promise.resolve()
                .then(() => {
                    renderImages(editor);
                })
                .finally(() => {
                    // 确保无论成功失败都会取消处理标记
                    setTimeout(() => {
                        debounceRender.isProcessing = false;
                    }, 50); // 小延迟确保渲染完成
                });
        }
    }, delay);
}

// 初始化处理状态标志
debounceRender.isProcessing = false;

// 批量渲染可见编辑器
function renderVisibleEditors(delay = 50) {
    const editors = vscode.window.visibleTextEditors;
    if (editors && editors.length) {
        editors.forEach((ed) => {
            debounceRender(ed, delay);
        });
    }
}

// -------- 文件大小相关逻辑 (新增/修改) --------

/**
 * 递归计算文件夹总大小
 * @param {string} dirPath
 * @returns {Promise<number>} 文件夹总大小 (字节)
 */
function calculateFolderSizeRecursive(dirPath) {
    return new Promise((resolve, reject) => {
        let totalSize = 0;

        function readDir(currentDir) {
            try {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });

                for (const entry of entries) {
                    const entryPath = path.join(currentDir, entry.name);

                    try {
                        const stat = fs.statSync(entryPath);

                        if (entry.isDirectory()) {
                            // 递归调用
                            totalSize += readDir(entryPath);
                        } else {
                            // 文件尺寸
                            totalSize += stat.size;
                        }
                    } catch (error) {
                        // 忽略无法访问的文件/目录，继续
                    }
                }
                return totalSize;
            } catch (error) {
                // 如果目录无法读取，返回当前已累计的大小
                logMessage(`读取目录失败: ${currentDir}`, "WARN");
                return totalSize;
            }
        }

        // 异步执行计算
        const worker = new Promise((res) => {
            setTimeout(() => {
                try {
                    const size = readDir(dirPath);
                    res(size);
                } catch (e) {
                    logMessage(`异步计算文件夹大小失败: ${e.message}`, "ERROR");
                    res(0);
                }
            }, 0);
        });

        worker
            .then((size) => {
                resolve(size);
            })
            .catch(reject);
    });
}

/**
 * 格式化文件大小，四舍五入取整
 * @param {number} size 字节大小
 * @param {string} unitSizeMode 'b', 'k', 'm' 中的一个
 * @returns {{size: number, unit: string}} 格式化后的大小和单位
 */
function formatFileSize(size, unitSizeMode) {
    const ONE_K = 1024;
    const ONE_M = 1024 * 1024;
    const ONE_B = 1;

    let targetUnit;
    let targetDivisor;
    let maxUnit = "m";

    // 确定目标单位和除数
    if (
        unitSizeMode === "m" ||
        (unitSizeMode === "k" && size >= ONE_M) ||
        (unitSizeMode === "b" && size >= ONE_M)
    ) {
        targetUnit = "m";
        targetDivisor = ONE_M;
    } else if (unitSizeMode === "k" || (unitSizeMode === "b" && size >= ONE_K)) {
        targetUnit = "k";
        targetDivisor = ONE_K;
    } else {
        targetUnit = "b";
        targetDivisor = ONE_B;
    }

    // 如果单位限制为 M
    if (maxUnit === "m" && targetUnit !== "m" && size >= ONE_M) {
        targetUnit = "m";
        targetDivisor = ONE_M;
    }

    if (size === 0) {
        return { size: 0, unit: targetUnit };
    }

    // 四舍五入取整
    const formattedSize = Math.round(size / targetDivisor);

    return { size: formattedSize, unit: targetUnit };
}

/**
 * 异步获取文件大小（只对文件，文件夹只返回 0，除非是 size 模式）
 * @param {string} filePath 完整路径
 * @param {boolean} isFile 是否是文件
 * @param {string} currentSizeMode 'none', 'm', 'k', 'b'
 * @returns {Promise<string>} 格式化后的显示字符串
 */
function getFileSizeDisplayAsync(filePath, isFile, currentSizeMode) {
    return new Promise(async (resolve) => {
        // none 模式，不查询，直接返回空白
        if (currentSizeMode === "none") {
            return resolve("");
        }

        const statsKey = `${filePath}:${isFile ? "file" : "dir"}`;

        // 检查缓存
        if (fileSizeCache[statsKey] && fileSizeCache[statsKey].display) {
            return resolve(fileSizeCache[statsKey].display);
        }

        // 检查是否正在计算文件夹总大小
        if (!isFile && sizeCalculationPromises[filePath]) {
            // 如果正在计算，返回计算中标志
            return resolve("    •    ");
        }

        // 默认显示为空白
        let sizeInBytes = 0;

        try {
            // 只查询当前目录下的文件尺寸
            if (isFile) {
                const stats = fs.statSync(filePath);
                sizeInBytes = stats.size;
            } else if (
                fileSizeCache[statsKey] &&
                fileSizeCache[statsKey].isFolderTotal
            ) {
                // 如果是文件夹，但缓存是总大小，则使用缓存 (用于 size = "s")
                sizeInBytes = fileSizeCache[statsKey].size;
            } else {
                // 文件夹在非 "s" 操作下，不查询大小
                return resolve("");
            }
        } catch (e) {
            // 无法读取，返回空白
            return resolve("");
        }

        // ------------------ 过滤逻辑 ------------------
        // b 模式: 显示所有（0字节以上）
        // k 模式: 小于 1K 不显示
        if (currentSizeMode === "k" && sizeInBytes < 1024) {
            // 缓存空白结果
            fileSizeCache[statsKey] = { size: 0, unit: "", display: "" };
            return resolve("");
        }
        // m 模式: 小于 1024K 不显示
        if (currentSizeMode === "m" && sizeInBytes < 1024 * 1024) {
            // 缓存空白结果
            fileSizeCache[statsKey] = { size: 0, unit: "", display: "" };
            return resolve("");
        }

        // ------------------ 格式化和对齐 ------------------
        const formatted = formatFileSize(sizeInBytes, currentSizeMode);
        const { size, unit } = formatted;

        let displaySize = size.toString();
        let displayUnit = unit;

        // 错位显示逻辑：根据用户需求优化
        // m 单位：最靠左，紧挨着分割线 - 尺寸前不加空格
        // k 单位：中间位置，左对齐 - 尺寸前加6个空格
        // b 单位：最靠右，左对齐 - 尺寸前加12个空格
        let spacesToFill = 0;

        if (unit === "m") {
            // m 单位：最靠左，直接贴分割线
            spacesToFill = 0;
        } else if (unit === "k") {
            // k 单位：中间位置，左对齐 - 在尺寸前面加3个空格
            spacesToFill = 3;
        } else if (unit === "b") {
            // b 单位：最靠右，左对齐 - 在尺寸前面加6个空格
            spacesToFill = 6;
        } else {
            // 异常情况，保持原样
            spacesToFill = 0;
        }

        // 确保不会出现负数，如果是负数就填 0
        spacesToFill = Math.max(0, spacesToFill);

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

// -------- 配置文件处理函数 (优化) --------
// 读取配置参数
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
            // 创建目录和配置文件
            fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
            // 注意：这里创建的文件内容应与saveConfig逻辑保持一致
            fs.writeFileSync(
                CONFIG_PATH,
                `[qqq]\nrecent_dirs=\nline_spacing=-2\nsidebar_width=100\nrecycle_bin=\nis_pinned=false\n${SIZE_CONFIG_KEY}=none\n`,
                "utf8",
            );
            sizeMode = config.sizeMode; // 更新全局状态
            return config;
        }

        const content = fs.readFileSync(CONFIG_PATH, "utf8");
        const qqqSection = content.match(/\[qqq\]([\s\S]*?)(\[|$)/);

        if (qqqSection && qqqSection[1]) {
            // 读取其他配置项 (保持不变)
            const recentMatch = qqqSection[1].match(/recent_dirs=(.*)/);
            if (recentMatch && recentMatch[1] !== undefined) {
                config.recentDirs = recentMatch[1]
                    .split(",")
                    .filter((dir) => dir && fs.existsSync(dir))
                    .slice(0, 10);
            }

            const lineSpacingMatch = qqqSection[1].match(/line_spacing=(.*)/);
            if (lineSpacingMatch && lineSpacingMatch[1] !== undefined) {
                const lineSpacing = parseInt(lineSpacingMatch[1]);
                if (!isNaN(lineSpacing)) {
                    config.lineSpacing = lineSpacing;
                }
            }

            const sidebarWidthMatch = qqqSection[1].match(/sidebar_width=(.*)/);
            if (sidebarWidthMatch && sidebarWidthMatch[1] !== undefined) {
                const sidebarWidth = parseInt(sidebarWidthMatch[1]);
                if (!isNaN(sidebarWidth) && sidebarWidth > 50 && sidebarWidth < 500) {
                    config.sidebarWidth = sidebarWidth;
                }
            }

            const recycleBinMatch = qqqSection[1].match(/recycle_bin=(.*)/);
            if (recycleBinMatch && recycleBinMatch[1] !== undefined) {
                config.recycleBin = recycleBinMatch[1]
                    .split(",")
                    .filter((dir) => dir && typeof dir === "string" && fs.existsSync(dir))
                    .slice(0, 60);
            }

            const isPinnedMatch = qqqSection[1].match(/is_pinned=(.*)/);
            if (isPinnedMatch && isPinnedMatch[1] !== undefined) {
                config.isPinned = isPinnedMatch[1].toLowerCase() === "true";
            }

            // 读取文件大小模式 (新增)
            const sizeModeMatch = qqqSection[1].match(
                new RegExp(`${SIZE_CONFIG_KEY}=(.*)`),
            );
            if (sizeModeMatch && sizeModeMatch[1] !== undefined) {
                const mode = sizeModeMatch[1].trim().toLowerCase();
                if (["none", "m", "k", "b"].includes(mode)) {
                    config.sizeMode = mode;
                }
            }
        }
    } catch (error) {
        logMessage("读取配置文件失败: " + error.message, "ERROR");
    }

    sizeMode = config.sizeMode; // 更新全局状态
    return config;
}

// 统一保存配置参数 (修改：添加 sizeMode 参数)
function saveConfig(
    recentDirs,
    lineSpacing,
    sidebarWidth,
    recycleBin,
    isPinned,
    newSizeMode,
) {
    // 获取当前配置，确保参数可选
    const currentConfig = getConfig();
    recentDirs = recentDirs || currentConfig.recentDirs;
    lineSpacing =
        lineSpacing !== undefined ? lineSpacing : currentConfig.lineSpacing;
    sidebarWidth =
        sidebarWidth !== undefined ? sidebarWidth : currentConfig.sidebarWidth;
    recycleBin = recycleBin || currentConfig.recycleBin;
    isPinned = isPinned !== undefined ? isPinned : currentConfig.isPinned;
    newSizeMode = newSizeMode || currentConfig.sizeMode; // 新增

    try {
        let content = "";
        if (fs.existsSync(CONFIG_PATH)) {
            content = fs.readFileSync(CONFIG_PATH, "utf8");
        } else {
            fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        }

        // 准备新的配置行
        const newConfigs = {
            recent_dirs: recentDirs.join(","),
            line_spacing: lineSpacing,
            sidebar_width: sidebarWidth,
            recycle_bin: recycleBin.join(","),
            is_pinned: isPinned,
            [SIZE_CONFIG_KEY]: newSizeMode, // 新增
        };

        let qqqSection = content.match(/\[qqq\]([\s\S]*?)(\[|$)/);

        if (qqqSection) {
            let sectionContent = qqqSection[1];

            // 替换或添加所有配置项
            for (const key in newConfigs) {
                const value = newConfigs[key];
                // 确保匹配的是完整键名，使用 \b
                const regex = new RegExp(`\\b${key}=.*`, "m");

                if (sectionContent.match(regex)) {
                    // 替换现有项
                    sectionContent = sectionContent.replace(regex, `${key}=${value}`);
                } else {
                    // 添加新项
                    sectionContent += `\n${key}=${value}`;
                }
            }

            // 清理多余空行，确保格式整洁
            sectionContent = sectionContent
                .split("\n")
                .filter((line) => line.trim() !== "")
                .join("\n");

            content = content.replace(
                /\[qqq\]([\s\S]*?)(\[|$)/,
                `[qqq]\n${sectionContent}\n$2`,
            );
        } else {
            // 添加新的qqq节
            const newSection = `\n[qqq]\nrecent_dirs=${newConfigs.recent_dirs}\nline_spacing=${newConfigs.line_spacing}\nsidebar_width=${newConfigs.sidebar_width}\nrecycle_bin=${newConfigs.recycle_bin}\nis_pinned=${newConfigs.is_pinned}\n${SIZE_CONFIG_KEY}=${newConfigs[SIZE_CONFIG_KEY]}\n`;
            content += newSection;
        }

        fs.writeFileSync(CONFIG_PATH, content, "utf8");
        sizeMode = newSizeMode; // 更新全局状态
    } catch (error) {
        logMessage("保存配置文件失败: " + error.message, "ERROR");
    }
}

// ... (getRecentDirectories, removeFromRecycleBin, addToRecycleBin, saveRecentDirectory, removeAndRecycleRecentDirectory 保持不变)
// 读取最近保存的目录
function getRecentDirectories() {
    const config = getConfig();
    return config.recentDirs;
}

// 从历史回收站中移除一个目录
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

// 添加到历史回收站
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

// 保存最近使用的目录 (最核心的逻辑，用于处理新旧目录的转移)
// **此函数只在执行了实质操作后才调用**
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

// 将指定目录从最近目录中移除并添加到回收站（对应Webview的叉叉按钮）
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

// -------- 其他不变的辅助函数 --------

// 获取驱动器列表（Windows系统）
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

// 获取目录结构内容 (修改：移除文件大小获取，避免同步调用影响性能)
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

// -------- 自定义另存为对话框 (优化消息处理) --------
function showSaveAsDialog() {
    // 单窗口控制：如果已有面板存在且未被销毁，则显示现有面板
    if (activePanel !== null) {
        if (usePanelReveal === 1) {
            activePanel.reveal();
        }
        return;
    }

    // 每次打开对话框都重新读取配置，确保 sizeMode 状态是新的
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
        "saveAsDialog",
        "qqq new 新建",
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            enableFindWidget: true,
            enableCommandUris: true,
        },
    );

    // 保存面板引用
    activePanel = panel;

    // 设置面板尺寸
    panel.iconPath = vscode.Uri.file(path.join(__filename, "..", "icon.png"));
    panel.onDidChangeViewState(() => {
        // 根据开关决定是否使用panel.reveal
        if (usePanelReveal === 1 && panel.viewColumn) {
            panel.reveal(panel.viewColumn, false);
        }
    });

    // 监听面板销毁事件，重置activePanel
    panel.onDidDispose(() => {
        activePanel = null;
    });

    // 更新资源展示区 (修改：Webview 中异步获取文件大小)
    function updateResourceExplorer() {
        try {
            if (!panel || panel.disposed) return;
            const directoryContents = getDirectoryContents(currentPath);
            const items = [];

            // 生成文件列表HTML
            let fileListHtml = "";

            // 获取当前 sizeMode
            const currentSizeMode = getConfig().sizeMode;

            // 添加上级目录 (特殊处理，图标区选中，名称区导航)
            if (
                currentPath !== "\\" &&
                currentPath !== currentPath.split("\\")[0] + "\\"
            ) {
                const parentPath = path.dirname(currentPath).replace(/\\/g, "\\\\");
                const parentItem = {
                    path: path.dirname(currentPath),
                    name: "..",
                    type: "folder",
                };
                items.push(parentItem); // 添加到 items 列表，Webview 会请求更新

                // [FIXED] 上级目录sz区域为空白
                const szAreaHtml = `<div class="sz-area"></div>`;

                fileListHtml += `
                <div class="file-item folder" data-path="${parentPath}" data-name=".." data-type="folder">
                    <div class="file-select-area" onclick="selectItem(event, 'folder', '${parentPath}', '..')">
                        ${szAreaHtml}
                        <span class="file-icon">📁</span>
                    </div>
                    <div class="folder-name-area" onclick="navigateIntoFolder('${parentPath}')">
                        <span class="file-name">..</span>
                    </div>
                </div>
                `;
            }

            // 添加文件夹
            directoryContents.dirs.forEach((dir) => {
                const safePath = dir.path.replace(/\\/g, "\\\\");
                const safeName = dir.name.replace(/'/g, "\\'");
                const item = { path: dir.path, name: dir.name, type: "folder" };
                items.push(item);

                // [FIXED] 默认 sz 区域为空白
                const szAreaHtml = `<div class="sz-area"></div>`;

                fileListHtml += `
                <div class="file-item folder" data-path="${safePath}" data-name="${safeName}" data-type="folder">
                    <div class="file-select-area" onclick="selectItem(event, 'folder', '${safePath}', '${safeName}')">
                        ${szAreaHtml}
                        <span class="file-icon">📁</span>
                    </div>
                    <div class="folder-name-area" onclick="selectItem(event, 'folder', '${safePath}', '${safeName}'); navigateIntoFolder('${safePath}')">
                        <span class="file-name">${dir.name}</span>
                    </div>
                </div>
                `;
            });

            // 添加文件
            directoryContents.files.forEach((file) => {
                const safePath = file.path.replace(/\\/g, "\\\\");
                const safeName = file.name.replace(/'/g, "\\'");
                const item = { path: file.path, name: file.name, type: "file" };
                items.push(item);

                // [FIXED] 默认 sz 区域为空白
                const szAreaHtml = `<div class="sz-area"></div>`;

                fileListHtml += `
                <div class="file-item file" data-path="${safePath}" data-name="${safeName}" data-type="file">
                    <div class="file-select-area" onclick="selectItem(event, 'file', '${safePath}', '${safeName}')">
                        ${szAreaHtml}
                        <span class="file-icon">📄</span>
                    </div>
                    <div class="file-name-area" onclick="selectItem(event, 'file', '${safePath}', '${safeName}')">
                        <span class="file-name">${file.name}</span>
                    </div>
                </div>
                `;
            });

            // 发送更新消息
            panel.webview.postMessage({
                command: "update",
                currentPath: currentPath,
                fileListHtml: fileListHtml,
                items: items, // 包含所有文件和文件夹路径，用于 Webview 异步请求大小
            });
        } catch (error) {
            logMessage(`更新资源展示区失败: ${error}`, "ERROR");
        }
    }

    // [NEW] 统一的Webview刷新函数
    function refreshWebview() {
        if (panel && !panel.disposed) {
            // 重新生成并设置HTML内容
            panel.webview.html = getWebviewContent();
            // 延迟后更新文件列表，确保HTML加载完成
            setTimeout(() => updateResourceExplorer(), 100);
        }
    }

    // 重新生成HTML内容
    function getWebviewContent() {
        // 每次生成内容都重新读取配置
        const currentConfig = getConfig();
        const drives = getDrives();
        const directoryContents = getDirectoryContents(currentPath);

        const LINE_SPACING = currentConfig.lineSpacing;
        const SIDEBAR_WIDTH = currentConfig.sidebarWidth;
        const currentRecentDirs = currentConfig.recentDirs;
        // 获取文件大小显示模式
        const currentSizeMode = currentConfig.sizeMode;

        // 获取VS Code设置，检查是否显示历史回收站
        const showRecycleBinSetting = vscode.workspace
            .getConfiguration("qqq")
            .get("showHistoryRecycleBin", true);

        // 确保recentDirs有默认值，即使配置为空，并验证所有路径存在
        // 不需要默认值，只需要存在的
        const safeRecentDirs =
            currentRecentDirs && currentRecentDirs.length > 0
                ? currentRecentDirs.filter((dir) => dir && fs.existsSync(dir))
                : [];

        // 只包含实际存在的路径
        const safeRecycleBin =
            currentConfig.recycleBin && Array.isArray(currentConfig.recycleBin)
                ? currentConfig.recycleBin.filter(
                    (dir) => dir && typeof dir === "string" && fs.existsSync(dir),
                )
                : [];

        // 当showRecycleBinSetting为true且safeRecycleBin不为空时才显示历史回收站
        const showRecycleBin = showRecycleBinSetting && safeRecycleBin.length > 0;

        // 获取pin状态（从配置中读取）
        const isPinned = currentConfig.isPinned || false;

        // --- 以下 HTML 模板部分进行修改 ---
        return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' vscode-webview-resource:; style-src 'unsafe-inline' vscode-webview-resource:; img-src vscode-webview-resource: data:; font-src vscode-webview-resource:;">
    <title>qqq new 新建</title>
    <style>
        /* 全局样式和变量定义 */
        :root {
            /* 导航左右分割线宽度 - 可拖动时的宽度 */
            --sidebar-resizer-width: 8px;
            /* SZ 区域宽度，约等于 12 个等宽字符 */
            --sz-area-width: 96px;
            /* 文件/文件夹图标宽度 (包括 margin) */
            --icon-area-width: 24px;
        }

        /* 全局样式重置 */
        * {
            box-sizing: border-box;
        }

        html, body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            margin: 0;
            padding: 0;
            height: 100%;
            width: 100%;
            background-color: #f8f9fa;
        }

        body {
            display: flex;
            flex-direction: column;
            border: 1px solid #dee2e6;
        }

        /* 容器使用固定宽度 */
        .container {
            display: flex;
            flex: 1;
            width: 100%;
            max-width: 100%;
            background-color: #fff;
            position: relative;
        }

        /* 左侧导航栏 - 固定位置 */
        .sidebar {
            width: ${SIDEBAR_WIDTH}px;
            background-color: #fff;
            border-right: 1px solid #dee2e6;
            display: flex;
            flex-direction: column;
            overflow-y: auto; /* 导航栏自身内容可滚动 */
            flex-shrink: 0;
            position: fixed;
            left: 0;
            top: 0;
            bottom: 60px; /* 为底部操作区留出空间 */
            z-index: 20;
            transition: width 0.2s ease;
        }

        /* 可拖动的分割线 */
        .sidebar-resizer {
            width: 4px;
            background-color: transparent;
            position: fixed;
            left: ${SIDEBAR_WIDTH}px;
            top: 0;
            bottom: 60px;
            z-index: 30;
        }

        .sidebar-resizer:hover {
            background-color: #ccc;
            width: var(--sidebar-resizer-width);
        }

        .sidebar-resizer.active {
            background-color: #999;
            width: var(--sidebar-resizer-width);
        }

        .sidebar-header {
            padding: 10px;
            font-weight: bold;
            background-color: #e9ecef;
            border-bottom: 1px solid #dee2e6;
        }

        .nav-item {
            padding: 8px 10px;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
            font-size: 14px;
            color: #333;
        }

        .nav-item:hover {
            background-color: #e3f2fd;
        }

        .nav-item.active {
            background-color: #bbdefb;
        }

        /* 空状态提示样式 */
        .empty-recycle-bin,
        .empty-recent-section {
            padding: 20px 10px;
            color: #999;
            font-style: italic;
            text-align: center;
            font-size: 13px;
        }

        /* 主内容区 - 调整宽度和位置以避开固定的侧边栏 */
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow-y: hidden; /* 主内容区整体不滚动 */
            overflow-x: hidden;
            position: absolute;
            left: ${SIDEBAR_WIDTH}px; /* 侧边栏宽度 */
            right: 0;
            top: 0;
            bottom: 0;
            transition: left 0.2s ease;
        }
        /* 最近保存目录 - 固定在顶部 */
        .recent-section {
            padding: 10px;
            background-color: #fff;
            position: sticky;
            top: 0;
            z-index: 5;
        }
        .recent-header {
            font-weight: bold;
            margin-bottom: 2px;
            font-size: 13px;
            color: #666;
        }
        .recent-list {
            display: flex;
            flex-direction: column;
            gap: ${LINE_SPACING}px;
        }
        .recent-item {
            padding: 2px 8px;
            background-color: #e9ecef;
            border-radius: 0px;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 100%;
            margin: 0;
            line-height: 1.2;
            display: flex;
            align-items: center;
        }
        /* 移除历史区背景色，保持简洁样式 */

        /* 删除按钮样式 */
        .delete-button {
            margin-right: 6px;
            padding: 0 4px;
            font-size: 10px;
            color: #999;
            cursor: pointer;
            opacity: 0.6;
        }
        .recent-item:hover .delete-button {
            opacity: 1;
            color: #f44336;
        }

        /* 分割线样式 */
        .divider {
            height: 1px;
            background-color: #dee2e6;
            margin: 8px 0;
        }

        /* 回收站样式 */
        .recycle-bin-section {
            padding: 8px 10px;
        }
        .recycle-bin-header {
            font-size: 12px;
            color: #666;
            font-weight: normal;
            margin-bottom: 4px;
        }
        .recycle-item {
            padding: 2px 8px;
            font-size: 11px;
            color: #888;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: pointer;
        }
        .recycle-item:hover {
            background-color: #f8f9fa;
            color: #333;
        }
        /* 地址栏 - 自动定位 */
        .address-bar {
            padding: 10px;
            background-color: #fff;
            position: static;
            z-index: 4;
        }
        .address-input {
            width: 100%;
            padding: 5px;
            border: 1px solid #ced4da;
            border-radius: 3px;
            font-size: 14px;
        }
        /* 文件列表 - 可独立滚动 */
        .file-list-container {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            overflow-x: auto;
            /* 确保滚动条始终可见 */
            scrollbar-width: thin;
            scrollbar-color: #888 #f1f1f1;
            margin-bottom: 60px; /* 为底部操作区留出空间 */
            padding-top: 10px;
        }

        /* 滚动条样式 */
        .file-list-container::-webkit-scrollbar {
            width: 10px;
            height: 10px;
        }

        .file-list-container::-webkit-scrollbar-track {
            background: #f1f1f1;
        }

        .file-list-container::-webkit-scrollbar-thumb {
            background: #888;
            border-radius: 5px;
        }

        .file-list-container::-webkit-scrollbar-thumb:hover {
            background: #555;
        }
        /* 文件列表项通用样式 */
        .file-item {
            padding: 0; /* 移除外层padding */
            border-radius: 0px;
            display: flex;
            align-items: center;
            margin: ${LINE_SPACING}px 0;
            min-height: 20px;
            line-height: 1.2;
            cursor: default; /* 默认不显示手型 */
        }
        .file-item:hover {
            background-color: #e3f2fd; /* 悬停背景色 */
        }

        /* SZ 区域样式 (新增) */
        .sz-area {
            /* 固定宽度，紧贴图标 */
            width: var(--sz-area-width);
            height: 100%;
            /* 字体设置为斜体，等宽 */
            font-style: italic;
            font-family: monospace;
            font-size: 12px;
            color: #555;
            text-align: left;
            padding: 2px 0;
            line-height: 1.2;
            flex-shrink: 0;
            white-space: pre; /* 保持空格 */
            cursor: default;
            /* 确保该区域是点击选择的一部分 */
        }

        /* 选中操作区 */
        .file-select-area {
            display: flex;
            align-items: center;
            padding: 2px 4px 2px 8px; /* 左侧留出更多点击空间 */
            cursor: pointer; /* 启用手型 */
            flex-shrink: 0;
        }

        /* 文件夹名称导航区 */
        .folder-name-area {
            flex: 1;
            padding: 2px 8px 2px 4px; /* 右侧留出更多点击空间 */
            cursor: pointer; /* 启用手型 */
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* 文件名称区 */
        .file-name-area {
            flex: 1;
            padding: 2px 8px; /* 文件名区域保持一致的 padding */
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* 选中状态样式 */
        .file-item.selected .sz-area,
        .file-item.selected .file-select-area,
        .file-item.selected .folder-name-area,
        .file-item.selected .file-name-area {
            background-color: #ff6b00;
            color: white;
        }
        .file-item.selected .file-select-area {
            /* 确保选中时图标颜色也一致 */
            color: white;
        }
        .file-item.selected:hover {
            background-color: #ff6b00; /* 悬停保持选中色 */
        }

        .file-icon {
            margin-right: 0;
            font-size: 16px;
        }
        .file-name {
            flex: 1;
        }
        /* 底部操作区 - 固定在底部 */
        .footer {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 10px;
            background-color: #fff;
            border-top: 1px solid #dee2e6;
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 10;
            box-shadow: 0 -2px 5px rgba(0,0,0,0.05);
        }
        .filename-input-container {
            flex: 1;
            margin-right: 10px;
            position: relative;
        }

        /* 长驻按钮样式 (保持不变) */
        .pin-container {
            margin-right: 37px;
            cursor: pointer;
            transform: translateX(12px) translateY(-1px);
        }

        .pin-box {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            padding: 5px 23px;
            border-radius: 20px;
            background-color: #f5f0e6;
            transition: background-color 0.2s;
            width: 96px;
            color: #333;
        }

        .pin-box:hover {
            background-color: #e8ddc3;
        }

        .pin-box.pinned {
            background-color: #d4af37;
        }

        .pin-text {
            font-size: 16px;
            font-weight: 500;
            min-width: 40px;
            display: inline-block;
            text-align: center;
        }

        .pin-checkbox {
            font-size: 15px;
            font-family: monospace;
            min-width: 20px;
            display: inline-block;
            text-align: center;
        }

        .filename-input {
            width: 100%;
            padding: 5px 5px 5px 6px;
            border: 1px solid #ced4da;
            border-radius: 3px;
            font-size: 14px;
        }

        .filename-label {
            font-size: 13px;
            color: #666;
            margin-bottom: 3px;
            display: block;
        }
        .button {
            padding: 6px 12px;
            border: none;
            border-radius: 3px;
            font-size: 14px;
            cursor: pointer;
        }
        .save-button {
            background-color: #0078d4;
            color: white;
        }
        .cancel-button {
            background-color: #f4f4f4;
            color: #333;
            margin-left: 5px;
        }


        /* 右侧功能按钮浮窗样式 (移除) */
        /* .action-buttons-float, .action-button 样式被移除 */

        /* 右键菜单样式 (新增) */
        .context-menu {
            position: fixed;
            background-color: #fff;
            border: 1px solid #ccc;
            box-shadow: 2px 2px 5px rgba(0, 0, 0, 0.2);
            z-index: 9999;
            padding: 4px 0;
            min-width: 150px;
            display: none;
            flex-direction: column;
        }

        .context-menu-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 13px;
            white-space: nowrap;
        }

        .context-menu-item:hover {
            background-color: #e3f2fd;
        }

        .context-menu-shortcut {
            color: #777;
            font-size: 12px;
            margin-left: 20px;
        }

        /* 右键空白处菜单样式 */
        .context-menu-empty {
            position: fixed;
            background-color: #fff;
            border: 1px solid #ccc;
            box-shadow: 2px 2px 5px rgba(0, 0, 0, 0.2);
            z-index: 9999;
            padding: 4px 0;
            min-width: 120px;
            display: none;
            flex-direction: column;
        }

        .context-menu-empty-item {
            padding: 6px 12px;
            cursor: pointer;
            font-size: 13px;
            white-space: nowrap;
        }

        .context-menu-empty-item:hover {
            background-color: #e3f2fd;
        }

        .context-menu-empty-item.selected {
            font-weight: bold;
            background-color: #bbdefb;
        }

    </style>
</head>
<body>
    <div class="container">
        <div class="sidebar">
                <div class="sidebar-header">文件导航</div>
                ${drives
                .map(
                    (drive) => `
                <button class="nav-item" onclick="navigateTo('${drive}')">${drive}</button>
                `,
                )
                .join("")}

                ${showRecycleBin
                ? `
                <div class="divider"></div>
                <div class="recycle-bin-section">
                    <div class="recycle-bin-header">历史回收站 (${safeRecycleBin.length}/60)</div>
                    ${safeRecycleBin
                    .map(
                        (dir) => `
                    <div class="recycle-item" onclick="navigateTo('${dir.replace(/\\/g, "\\\\")}')">${dir}</div>
                    `,
                    )
                    .join("")}
                </div>
                `
                : ""
            }
            </div>

        <div class="sidebar-resizer" id="sidebarResizer"></div>

        <div class="main-content" id="mainContent">
            <div class="recent-section">
                            <div class="recent-list">
                                ${safeRecentDirs
                .reverse()
                .map(
                    (dir) => `
                                <div class="recent-item" onclick="navigateTo('${dir.replace(/\\/g, "\\\\")}')">
                                    <span class="delete-button" onclick="event.stopPropagation(); removeFromRecent('${dir.replace(/\\/g, "\\\\")}')">×</span>
                                    <span>${dir}</span>
                                </div>
                                `,
                )
                .join("")}
                            </div>
                        </div>

            <div class="address-bar">
                <input type="text" id="addressInput" class="address-input" value="${currentPath}" onkeydown="handleAddressInputKeyDown(event)">
            </div>

            <div class="file-list-container" id="fileList" style="margin-bottom: 60px;">
                </div>

            <div class="footer">
                <div id="pinButton" class="pin-container" onclick="togglePin()">
                    <div class="pin-box ${isPinned ? "pinned" : ""}">
                        <span class="pin-text">长驻</span>
                        <span class="pin-checkbox">${isPinned ? "✓" : "□"}</span>
                    </div>
                </div>
                <div class="filename-input-container">
                    <input type="text" id="filenameInput" class="filename-input" onkeydown="handleFilenameInputKeyDown(event)">
                </div>
                <div style="display: flex; gap: 15px;">
                    <button class="button save-button" onclick="saveFile()" title="新建文件">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                            <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
                        </svg>
                    </button>
                    <button class="button cancel-button" onclick="createFolder()" title="新建文件夹">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="#333">
                            <path d="M10,4H4C2.89,4 2,4.89 2,6V20A2,2 0 0,0 4,22H20A2,2 0 0,0 22,20V8L16,2H10M13,9V3.5L18.5,9H13Z"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <div id="emptyContextMenu" class="context-menu-empty">
        <div class="context-menu-empty-item ${currentSizeMode === "none" ? "selected" : ""}" data-mode="none" onclick="setSizeMode('none');refreshSizeDisplay();">none</div>
        <div class="context-menu-empty-item ${currentSizeMode === "m" ? "selected" : ""}" data-mode="m" onclick="setSizeMode('m');refreshSizeDisplay();">m</div>
        <div class="context-menu-empty-item ${currentSizeMode === "k" ? "selected" : ""}" data-mode="k" onclick="setSizeMode('k');refreshSizeDisplay();">k</div>
        <div class="context-menu-empty-item ${currentSizeMode === "b" ? "selected" : ""}" data-mode="b" onclick="setSizeMode('b');refreshSizeDisplay();">b</div>
    </div>

    <div id="itemContextMenu" class="context-menu">
        <div class="context-menu-item" data-action="rename" data-shortcut="q">
            <span>rename</span>
            <span class="context-menu-shortcut">= "q"</span>
        </div>
        <div class="context-menu-item" data-action="open" data-shortcut="w">
            <span>open</span>
            <span class="context-menu-shortcut">= "w"</span>
        </div>
        <div class="context-menu-item" data-action="delete" data-shortcut="s">
            <span>delete</span>
            <span class="context-menu-shortcut">= "s"</span>
        </div>
        <div class="context-menu-item" data-action="kode" data-shortcut="e">
            <span>kode</span>
            <span class="context-menu-shortcut">= "e"</span>
        </div>
        <div class="context-menu-item" data-action="size">
            <span>Refresh size</span>
        </div>
    </div>

    <script>
        // 获取VS Code API对象
        const vscode = acquireVsCodeApi();
        const sizeMode = '${currentSizeMode}';
        let currentPath = '${currentPath.replace(/\\/g, "\\\\")}';

        // 初始化时聚焦文件名输入框
        document.addEventListener('DOMContentLoaded', () => {
            const filenameInput = document.getElementById('filenameInput');
            filenameInput.focus();

            // 首次加载后，更新文件列表 (extension会发送update消息)
            updateResourceExplorer();

            // [FIXED] 添加对文件列表空白区域的点击监听，用于取消选中
            document.getElementById('fileList').addEventListener('click', (event) => {
                if (event.target === event.currentTarget) {
                    const prevSelected = document.querySelector('.file-item.selected');
                    if (prevSelected) {
                        // 如果有重命名框，先取消重命名
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

        // 导航到指定路径 (侧边栏、最近目录、回收站、地址栏回车)
        function navigateTo(path) {
            // 确保路径正确转义
            vscode.postMessage({ command: 'navigate', path: path });
        }

        // 导航进入文件夹 (文件列表中的文件夹名称区域)
        function navigateIntoFolder(path) {
            // 确保路径正确转义
            vscode.postMessage({ command: 'navigate', path: path });
        }

        // 处理地址输入框的回车键
        function handleAddressInputKeyDown(event) {
            if (event.key === 'Enter') {
                const path = event.target.value;
                vscode.postMessage({ command: 'navigate', path: path });
            }
        }

        // 当前焦点元素类型 (保持不变)
        let currentFocusType = 'filenameInput';

        // 监听焦点事件，更新焦点类型
        document.addEventListener('focusin', (event) => {
            updateFocusType(event.target);
        });

        // 添加焦点失去事件处理，确保输入框失去焦点时能正确更新焦点状态
        document.addEventListener('focusout', (event) => {
            if (event.target.id === 'filenameInput' || event.target.id === 'addressInput' || event.target.classList.contains('rename-input')) {
                // 延迟一下，让新的焦点元素有时间获取焦点
                setTimeout(() => {
                    // 如果新的焦点不在输入框上，更新焦点类型
                    const activeElement = document.activeElement;
                    if (activeElement.id !== 'filenameInput' && activeElement.id !== 'addressInput' && !activeElement.classList.contains('rename-input')) {
                        updateFocusType(activeElement);
                    }
                }, 0);
            }
        });

        // 添加点击事件处理，确保点击非输入框区域时能正确更新焦点状态
        document.addEventListener('click', (event) => {
            // 隐藏所有右键菜单
            hideAllContextMenus();

            // 如果点击的不是输入框，并且当前焦点状态还是input，则更新焦点类型
            if ((event.target.id !== 'filenameInput' && event.target.id !== 'addressInput' && !event.target.classList.contains('rename-input')) &&
                currentFocusType === 'input') {
                updateFocusType(event.target);
            }
        });

        // 更新焦点类型的辅助函数 (修改：增加对 rename-input 的识别)
        function updateFocusType(element) {
            if (element.id === 'filenameInput' || element.id === 'addressInput' || element.classList.contains('rename-input')) {
                currentFocusType = 'input'; // 焦点在输入框
            } else if (element.classList.contains('file-list-container') ||
                      element.classList.contains('file-item') ||
                      element.closest('.file-list-container')) {
                currentFocusType = 'fileList'; // 焦点在文件列表区
            } else if (element.classList.contains('sidebar') ||
                      element.classList.contains('nav-item') ||
                      element.closest('.sidebar')) {
                currentFocusType = 'sidebar'; // 焦点在侧边栏
            } else if (element.classList.contains('recent-section') ||
                      element.classList.contains('recent-item') ||
                      element.closest('.recent-section')) {
                currentFocusType = 'recentSection'; // 焦点在最近保存区
            } else {
                currentFocusType = 'other'; // 其他区域
            }
        }

        // 处理文件名输入框的键盘事件 (保持不变)
        function handleFilenameInputKeyDown(event) {
            if (event.key === 'Enter') {
                saveFile();
            }
        }

        // 保存文件 (保持不变)
        function saveFile() {
            const filename = document.getElementById('filenameInput').value.trim();
            if (filename) {
                // 获取当前的pin状态
                const pinButton = document.getElementById('pinButton');
                const pinBox = pinButton.querySelector('.pin-box');
                const isPinned = pinBox.classList.contains('pinned');

                vscode.postMessage({
                    command: 'save',
                    filename: filename,
                    isPinned: isPinned,
                    openInCurrentGroup: !isPinned // 常驻时在右侧打开，不常驻时在当前组打开
                });

                // 在常驻状态下，清空文件名输入框，方便继续新建文件
                if (isPinned) {
                    document.getElementById('filenameInput').value = '';
                    // 让文件名输入框保持焦点
                    document.getElementById('filenameInput').focus();
                }
            } else {
                alert('请输入文件名');
            }
        }

        // 切换pin状态 (保持不变)
        function togglePin() {
            const pinButton = document.getElementById('pinButton');
            const pinBox = pinButton.querySelector('.pin-box');
            const pinCheckbox = pinButton.querySelector('.pin-checkbox');

            // 获取当前状态
            const isCurrentlyPinned = pinBox.classList.contains('pinned');
            const newPinState = !isCurrentlyPinned;

            // 更新样式和显示
            if (newPinState) {
                pinBox.classList.add('pinned');
                pinCheckbox.textContent = '✓';
            } else {
                pinBox.classList.remove('pinned');
                pinCheckbox.textContent = '□';
            }

            // 保存pin状态到VS Code
            vscode.postMessage({
                command: 'togglePin',
                isPinned: newPinState
            });
        }

        // 从最近目录中移除并添加到回收站 (保持不变)
        function removeFromRecent(path) {
            vscode.postMessage({ command: 'removeFromRecent', path: path });
        }

        // 取消操作 (保持不变)
        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        // 刷新当前目录的大小显示
        function refreshSizeDisplay() {
            const fileList = document.getElementById('fileList');
            const items = fileList.querySelectorAll('.file-item');

            items.forEach(item => {
                const szArea = item.querySelector('.sz-area');
                const size = item.dataset.size;
                const type = item.dataset.type;

                if (szArea) {
                    // [FIXED] 刷新时，也显示等待点
                    if (type === 'file' && sizeMode !== 'none') {
                        szArea.textContent = '    •    ';
                    } else {
                        szArea.textContent = ''; // 清空文件夹的大小
                    }
                    vscode.postMessage({
                        command: 'requestSize',
                        path: item.dataset.path,
                        type: type
                    });
                }
            });
        }

        // 监听VSCode消息 (修改：增加对 rename 的处理)
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'update') {
                document.getElementById('addressInput').value = message.currentPath;
                document.getElementById('fileList').innerHTML = message.fileListHtml;
                // 新增：更新文件列表后，触发文件大小异步查询
                requestFileSizeUpdates(message.items);
            }
            else if (message.command === 'updateSize') {
                // 收到异步文件大小更新
                const item = document.querySelector(\`.file-item[data-path="\${message.path.replace(/\\\\/g, '\\\\')}"].\${message.type}\`);
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
                // 启动重命名操作
                startRename(message.path, message.name, message.type);
            }
            else if (message.command === 'refreshSizes') {
                // 刷新所有大小显示
                refreshSizeDisplay();
            }
        });

        // 批量请求文件大小更新
        function requestFileSizeUpdates(items) {
            // [FIXED] sizeMode 在脚本顶部从模板中注入
            if (sizeMode === 'none') return;

            items.forEach(item => {
                // .. (上级目录) 不需要获取大小
                if (item.name === '..') return;

                const itemElement = document.querySelector(\`.file-item[data-path="\${item.path.replace(/\\\\/g, '\\\\')}"].\${item.type}\`);
                if (itemElement) {
                    const szArea = itemElement.querySelector('.sz-area');
                    if (szArea) {
                        // 只为文件显示初始等待点，文件夹按需显示
                        if (item.type === 'file') {
                            szArea.textContent = '    •    ';
                        }
                    }
                }

                // 发送异步请求给 extension.js 查询文件大小
                vscode.postMessage({
                    command: 'requestSize',
                    path: item.path,
                    type: item.type,
                    name: item.name
                });


            });
        }

        // 当前选中的项信息
        let selectedItem = null;

        // 选择文件或文件夹项
        function selectItem(event, type, path, name) {
            // 阻止冒泡
            event.stopPropagation();

            // 隐藏菜单
            hideAllContextMenus();

            const item = event.currentTarget.closest('.file-item');
            if (!item) return;

            // 移除之前的选中状态
            const prevSelected = document.querySelector('.file-item.selected');
            if (prevSelected && prevSelected !== item) {
                // 如果上一个项目处于编辑状态，取消编辑
                const renameInput = prevSelected.querySelector('.rename-input');
                if (renameInput) {
                    cancelRename(prevSelected);
                }
                prevSelected.classList.remove('selected');
            }

            // 总是设为选中，不再取消
            item.classList.add('selected');
            // 保存选中项信息
            selectedItem = {
                type: type, // 'file' 或 'folder'
                path: path,
                name: name
            };

            // 更新焦点状态到文件列表
            currentFocusType = 'fileList';
        }

        // [FIXED] 全新的重命名逻辑
        let renameBlurHandler = null;

        function startRename(itemPath, itemName, itemType) {
            const itemElement = document.querySelector(\`.file-item[data-path="\${itemPath.replace(/\\\\/g, '\\\\')}"]\`);
            if (!itemElement) return;

            // 确保当前项被选中
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

            // 选中文件名（不含扩展名）
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

            // 保存取消重命名需要的信息
            itemElement.dataset.originalContent = originalContent;
            itemElement.dataset.keyDownHandler = handleKeyDown;
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
                // 界面将由vscode刷新，此处不做处理
            } else {
                // 名称无效或未改变，取消
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

        // 执行编辑操作 (重构为接受参数)
        function performEditAction(itemToEdit) {
            if (!itemToEdit) {
                return;
            }
            startRename(itemToEdit.path, itemToEdit.name, itemToEdit.type);
        }

        // 执行打开操作 (重构为接受参数)
        function performOpenAction(itemToOpen) {
            if (!itemToOpen) {
                return;
            }
            vscode.postMessage({
                command: 'openWithDefaultApp',
                path: itemToOpen.path,
                type: itemToOpen.type
            });
        }

        // 执行删除操作 (重构为接受参数)
        function performDeleteAction(itemToDelete) {
            if (!itemToDelete) {
                return;
            }
            // 视觉技巧：立即隐藏DOM元素，让UI瞬间响应
            const itemElement = document.querySelector(\`.file-item[data-path="\${itemToDelete.path.replace(/\\\\/g, '\\\\')}"]\`);
            if (itemElement) {
                itemElement.style.display = 'none';
            }
            // 发送后台删除指令
            vscode.postMessage({
                command: 'deleteToRecycleBin',
                path: itemToDelete.path,
                type: itemToDelete.type
            });

            // Immediately clear the selection to prevent re-triggering on a deleted item
            selectedItem = null;
        }

        // 执行 VS Code 打开操作 (重构为接受参数)
        function performKodeAction(itemToKode) {
            if (!itemToKode) {
                return;
            }
            if (itemToKode.type === 'file') {
                vscode.postMessage({
                    command: 'editFile',
                    path: itemToKode.path,
                    isPinned: false, // 默认在当前组打开
                    openInCurrentGroup: true
                });
            } else {
                 vscode.postMessage({
                    command: 'openFolderInNewWindow',
                    path: itemToKode.path
                });
            }
        }

        // 执行刷新文件/文件夹大小操作 (重构为接受参数)
        function performSizeAction(itemToRefresh) {
            if (!itemToRefresh) {
                return;
            }
            // 在界面上显示等待点
            const item = document.querySelector(\`.file-item[data-path="\${itemToRefresh.path.replace(/\\\\/g, '\\\\')}"]\`);
            if (item) {
                const szArea = item.querySelector('.sz-area');
                if (szArea) {
                    szArea.textContent = '    •    ';
                }
            }
            // 发送异步计算命令
            vscode.postMessage({
                command: 'refreshSize',
                path: itemToRefresh.path,
                type: itemToRefresh.type
            });
        }

        // 统一处理右键菜单点击操作 (简化)
        function handleContextMenuAction(action) {
            const itemForAction = selectedItem;
            hideAllContextMenus();
            if (!itemForAction) return;

            // 直接将右键点击的项数据传递给操作函数
            switch(action) {
                case 'rename':
                    performEditAction(itemForAction);
                    break;
                case 'open':
                    performOpenAction(itemForAction);
                    break;
                case 'delete':
                    performDeleteAction(itemForAction);
                    break;
                case 'kode':
                    performKodeAction(itemForAction);
                    break;
                case 'size':
                    performSizeAction(itemForAction);
                    break;
            }
        }

        // 隐藏所有右键菜单
        function hideAllContextMenus() {
            document.getElementById('itemContextMenu').style.display = 'none';
            document.getElementById('emptyContextMenu').style.display = 'none';
        }

        // ----------------- 右键菜单 (项目) -----------------
        const itemContextMenu = document.getElementById('itemContextMenu');

        // 绑定右键菜单项的点击事件
        itemContextMenu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation(); // Stop event bubbling to document click listener
                const action = e.currentTarget.dataset.action;
                handleContextMenuAction(action);
            });
        });

        // 监听文件列表的右键事件
        document.getElementById('fileList').addEventListener('contextmenu', (e) => {
            e.preventDefault();
            hideAllContextMenus(); // 隐藏其他菜单

            const itemElement = e.target.closest('.file-item');
            const emptyContextMenu = document.getElementById('emptyContextMenu');

            // 检查点击的是否是文件列表中的项目
            if (itemElement) {
                const itemPath = itemElement.dataset.path;
                const itemName = itemElement.dataset.name;
                const itemType = itemElement.dataset.type;

                // 立即将右键点击的项目设为选中状态
                selectItem({ currentTarget: itemElement.querySelector('.file-select-area'), stopPropagation: () => {} }, itemType, itemPath, itemName);

                // 显示菜单
                itemContextMenu.style.left = e.clientX + 'px';
                itemContextMenu.style.top = e.clientY + 'px';
                itemContextMenu.style.display = 'flex';

            } else {
                 // 点击的是空白处
                 emptyContextMenu.style.left = e.clientX + 'px';
                 emptyContextMenu.style.top = e.clientY + 'px';
                 emptyContextMenu.style.display = 'flex';
            }
        });

        // ----------------- 右键菜单 (空白处) -----------------
        const emptyContextMenu = document.getElementById('emptyContextMenu');

        // 设置文件大小显示模式
        function setSizeMode(mode) {
            hideAllContextMenus();
            vscode.postMessage({
                command: 'setSizeMode',
                mode: mode
            });
        }

        // 启用并更新键盘快捷键
        document.addEventListener('keydown', event => {
            // 只有当焦点不在输入框时才处理这些快捷键
            if (currentFocusType === 'input') return;

            // 确保有选中项目
            if (!selectedItem) return;

            const key = event.key.toLowerCase();

            // q: rename
            if (key === 'q') {
                event.preventDefault();
                event.stopPropagation();
                performEditAction(selectedItem);
            }
            // w: open
            else if (key === 'w') {
                event.preventDefault();
                event.stopPropagation();
                performOpenAction(selectedItem);
            }
            // s: delete
            else if (key === 's') {
                event.preventDefault();
                event.stopPropagation();
                performDeleteAction(selectedItem);
            }
            // e: kode
            else if (key === 'e') {
                event.preventDefault();
                event.stopPropagation();
                performKodeAction(selectedItem);
            }
        });

        document.addEventListener('keydown', event => {
            // 处理退格键 - 只有在焦点不在输入框时才触发向上导航
            if (event.key === 'Backspace' && currentFocusType !== 'input') {
                // 阻止默认行为（例如浏览器后退）
                event.preventDefault();
                // 向上一级目录导航
                vscode.postMessage({ command: 'navigateUp' });
            }
        });

        // 可拖动侧边栏功能实现 (保持不变)
        const sidebarResizer = document.getElementById('sidebarResizer');
        const sidebar = document.querySelector('.sidebar');
        const mainContent = document.querySelector('.main-content');
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        if (sidebarResizer && sidebar && mainContent) {
            // 鼠标按下事件 - 开始拖动
            sidebarResizer.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                startWidth = sidebar.offsetWidth;
                sidebarResizer.classList.add('active');
                document.body.style.userSelect = 'none';
            });

            // 鼠标移动事件 - 调整宽度
            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;

                // 计算新的宽度（限制在50-500px之间）
                let newWidth = startWidth + (e.clientX - startX);
                newWidth = Math.max(50, Math.min(500, newWidth));

                // 更新侧边栏宽度和主内容区左边距
                sidebar.style.width = newWidth + 'px';
                sidebarResizer.style.left = newWidth + 'px';
                mainContent.style.left = newWidth + 'px';
            });

            // 鼠标释放事件 - 结束拖动并保存设置
            document.addEventListener('mouseup', () => {
                if (!isResizing) return;

                isResizing = false;
                sidebarResizer.classList.remove('active');
                document.body.style.userSelect = '';

                // 保存新的侧边栏宽度设置
                const newWidth = parseInt(sidebar.style.width) || 100;
                vscode.postMessage({
                    command: 'saveSidebarWidth',
                    width: newWidth
                });
            });

            // 鼠标离开窗口事件 - 防止拖动时鼠标离开导致的问题
            document.addEventListener('mouseleave', () => {
                if (isResizing) {
                    isResizing = false;
                    sidebarResizer.classList.remove('active');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }
            });
        }

        // 创建文件夹 (保持不变)
        function createFolder() {
            const folderName = document.getElementById('filenameInput').value.trim();
            if (folderName) {
                vscode.postMessage({ command: 'createFolder', folderName: folderName });
            } else {
                alert('请输入文件夹名');
            }
        }

        function updateResourceExplorer() {
            // The extension sends the 'update' message which triggers the real update logic.
        }

    </script>
</body>
</html>
        `;
    }

    // 设置Webview内容
    panel.webview.html = getWebviewContent();

    // Webview消息处理 (更新)
    panel.webview.onDidReceiveMessage((message) => {
        // 确保每次接收到消息时，全局状态 sizeMode 都是最新的
        const currentConfig = getConfig();
        const currentSizeMode = currentConfig.sizeMode;

        switch (message.command) {
            case "removeFromRecent":
                // ... (保持不变)
                try {
                    const pathToRemove = message.path;
                    const updated = removeAndRecycleRecentDirectory(pathToRemove);

                    if (updated) {
                        refreshWebview();
                    }
                } catch (error) {
                    logMessage(`移除最近目录失败: ${error}`, "ERROR");
                }
                break;

            case "setSizeMode":
                try {
                    const newMode = message.mode;
                    const config = getConfig();
                    // 1. 保存新的 sizeMode 到配置文件
                    saveConfig(
                        config.recentDirs,
                        config.lineSpacing,
                        config.sidebarWidth,
                        config.recycleBin,
                        config.isPinned,
                        newMode,
                    );
                    // 2. 刷新整个 Webview 内容
                    refreshWebview();
                    // 3. 清空文件大小缓存
                    fileSizeCache = {};
                    sizeCalculationPromises = {};
                } catch (error) {
                    logMessage(`保存 sizeMode 失败: ${error}`, "ERROR");
                }
                break;

            case "requestSize":
                // 异步请求文件大小（性能优化核心）
                const { path: itemPath, type: itemType } = message;

                // none 模式直接返回，不占用计算资源
                if (currentSizeMode === "none") {
                    break;
                }

                if (itemType === "folder" && sizeCalculationPromises[itemPath]) {
                    panel.webview.postMessage({
                        command: "updateSize",
                        path: itemPath,
                        type: itemType,
                        sizeDisplay: "    •    ",
                    });
                }

                getFileSizeDisplayAsync(itemPath, itemType === "file", currentSizeMode)
                    .then((display) => {
                        if (panel && !panel.disposed) {
                            panel.webview.postMessage({
                                command: "updateSize",
                                path: itemPath,
                                type: itemType,
                                sizeDisplay: display,
                            });
                        }
                    })
                    .catch((e) =>
                        logMessage(
                            `异步获取文件大小失败: ${itemPath} - ${e.message}`,
                            "ERROR",
                        ),
                    );

                break;

            // [NEW] 手动刷新文件或文件夹大小
            case "refreshSize":
                try {
                    const { path: itemToRefresh, type: itemTypeToRefresh } = message;
                    const statsKey = `${itemToRefresh}:${itemTypeToRefresh === "folder" ? "dir" : "file"}`;

                    // 1. 清除该项目的缓存
                    delete fileSizeCache[statsKey];
                    if (itemTypeToRefresh === "folder") {
                        delete sizeCalculationPromises[itemToRefresh];
                    }

                    // 2. 重新触发大小计算
                    if (itemTypeToRefresh === "folder") {
                        // 文件夹大小计算逻辑
                        const promise = calculateFolderSizeRecursive(itemToRefresh);
                        sizeCalculationPromises[itemToRefresh] = promise;

                        promise
                            .then((totalSize) => {
                                const formatted = formatFileSize(totalSize, sizeMode);
                                const { size, unit } = formatted;
                                let spacesToFill = 0;
                                if (unit === "m") spacesToFill = 0;
                                else if (unit === "k") spacesToFill = 3;
                                else if (unit === "b") spacesToFill = 6;
                                const displayString =
                                    " ".repeat(spacesToFill) + size + " " + unit;
                                fileSizeCache[statsKey] = {
                                    size: totalSize,
                                    unit: unit,
                                    display: displayString,
                                    isFolderTotal: true,
                                };
                                if (panel && !panel.disposed) {
                                    panel.webview.postMessage({
                                        command: "updateSize",
                                        path: itemToRefresh,
                                        type: "folder",
                                        sizeDisplay: displayString,
                                    });
                                }
                            })
                            .catch((e) =>
                                logMessage(
                                    `刷新文件夹大小失败: ${itemToRefresh} - ${e.message}`,
                                    "ERROR",
                                ),
                            )
                            .finally(() => {
                                delete sizeCalculationPromises[itemToRefresh];
                            });
                    } else {
                        // 文件大小计算逻辑
                        getFileSizeDisplayAsync(itemToRefresh, true, currentSizeMode)
                            .then((display) => {
                                if (panel && !panel.disposed) {
                                    panel.webview.postMessage({
                                        command: "updateSize",
                                        path: itemToRefresh,
                                        type: "file",
                                        sizeDisplay: display,
                                    });
                                }
                            })
                            .catch((e) =>
                                logMessage(
                                    `刷新文件大小失败: ${itemToRefresh} - ${e.message}`,
                                    "ERROR",
                                ),
                            );
                    }
                } catch (error) {
                    logMessage(`刷新大小时出错: ${error.message}`, "ERROR");
                }
                break;

            case "calculateFolderSize":
                // 递归计算文件夹总大小
                const folderPath = message.path;
                const statsKey = `${folderPath}:dir`;

                if (sizeCalculationPromises[folderPath]) {
                    break;
                }

                const promise = calculateFolderSizeRecursive(folderPath);
                sizeCalculationPromises[folderPath] = promise;

                promise
                    .then((totalSize) => {
                        const formatted = formatFileSize(totalSize, sizeMode);
                        const { size, unit } = formatted;
                        let spacesToFill = 0;
                        if (unit === "m") spacesToFill = 0;
                        else if (unit === "k") spacesToFill = 3;
                        else if (unit === "b") spacesToFill = 6;
                        const displayString = " ".repeat(spacesToFill) + size + " " + unit;
                        fileSizeCache[statsKey] = {
                            size: totalSize,
                            unit: unit,
                            display: displayString,
                            isFolderTotal: true,
                        };
                        if (panel && !panel.disposed) {
                            panel.webview.postMessage({
                                command: "updateSize",
                                path: folderPath,
                                type: "folder",
                                sizeDisplay: displayString,
                            });
                        }
                    })
                    .catch((e) => {
                        logMessage(
                            `计算文件夹总大小失败: ${folderPath} - ${e.message}`,
                            "ERROR",
                        );
                        fileSizeCache[statsKey] = {
                            size: 0,
                            unit: "",
                            display: "",
                            isFolderTotal: true,
                        };
                        if (panel && !panel.disposed) {
                            panel.webview.postMessage({
                                command: "updateSize",
                                path: folderPath,
                                type: "folder",
                                sizeDisplay: "",
                            });
                        }
                    })
                    .finally(() => {
                        delete sizeCalculationPromises[folderPath];
                    });
                break;

            case "renameItem":
                try {
                    const { oldPath, newName, itemType } = message;
                    const oldDir = path.dirname(oldPath);
                    const newPath = path.join(oldDir, newName);

                    if (fs.existsSync(newPath)) {
                        vscode.window.showErrorMessage(
                            `重命名失败：目标位置已存在同名${itemType === "file" ? "文件" : "文件夹"}。`,
                        );
                        refreshWebview();
                        break;
                    }

                    fs.renameSync(oldPath, newPath);
                    saveRecentDirectory(oldDir);
                    fileSizeCache = {};
                    sizeCalculationPromises = {};
                    setTimeout(() => refreshWebview(), 100);
                } catch (error) {
                    vscode.window.showErrorMessage("重命名失败: " + error.message);
                    logMessage("重命名失败: " + error.message, "ERROR");
                    refreshWebview();
                }
                break;

            case "navigate":
                try {
                    let newPath = message.path;
                    if (process.platform === "win32") {
                        if (newPath.match(/^[A-Z]:$/i)) {
                            newPath = newPath + "\\";
                        }
                    }

                    if (fs.existsSync(newPath) && fs.statSync(newPath).isDirectory()) {
                        currentPath = newPath;
                        refreshWebview();
                    } else {
                        vscode.window.showErrorMessage("无效的目录路径: " + newPath);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("导航失败: " + error.message);
                    logMessage("导航失败: " + error.message, "ERROR");
                }
                break;

            case "navigateUp":
                try {
                    if (
                        currentPath !== "\\" &&
                        currentPath !== currentPath.split("\\")[0] + "\\"
                    ) {
                        currentPath = path.dirname(currentPath);
                        refreshWebview();
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("向上导航失败: " + error.message);
                    logMessage("向上导航失败: " + error.message, "ERROR");
                }
                break;

            case "saveSidebarWidth":
                try {
                    const width = message.width;
                    const config = getConfig();
                    saveConfig(
                        config.recentDirs,
                        config.lineSpacing,
                        width,
                        config.recycleBin,
                        config.isPinned,
                        config.sizeMode,
                    );
                } catch (error) {
                    logMessage(`保存侧边栏宽度失败: ${error}`, "ERROR");
                }
                break;

            case "togglePin":
                try {
                    const isPinned = message.isPinned;
                    const config = getConfig();
                    saveConfig(
                        config.recentDirs,
                        config.lineSpacing,
                        config.sidebarWidth,
                        config.recycleBin,
                        isPinned,
                        config.sizeMode,
                    );
                } catch (error) {
                    logMessage(`保存pin状态失败: ${error}`, "ERROR");
                }
                break;

            case "save":
                const fileName = message.filename;
                const fullFilePath = path.join(currentPath, fileName);
                const isPinned = message.isPinned || false;

                try {
                    saveRecentDirectory(currentPath);
                    fileSizeCache = {};

                    if (fs.existsSync(fullFilePath)) {
                        const stats = fs.statSync(fullFilePath);
                        if (stats.isFile()) {
                            vscode.window
                                .showWarningMessage(
                                    `文件 "${fileName}" 已存在，是否覆盖？`,
                                    { modal: true },
                                    { title: "是", isCloseAffordance: false },
                                    { title: "否", isCloseAffordance: true },
                                )
                                .then((answer) => {
                                    if (answer?.title === "是") {
                                        const content = "\n".repeat(199);
                                        fs.writeFileSync(fullFilePath, content, "utf8");

                                        if (!isPinned) {
                                            panel.dispose();
                                        } else {
                                            refreshWebview();
                                        }

                                        const viewColumn = message.openInCurrentGroup
                                            ? undefined
                                            : vscode.ViewColumn.Beside;
                                        vscode.workspace
                                            .openTextDocument(fullFilePath)
                                            .then((doc) => {
                                                vscode.window.showTextDocument(doc, viewColumn);
                                            });
                                    }
                                });
                        } else {
                            vscode.window.showErrorMessage(
                                `无法创建文件 "${fileName}"，因为同名文件夹已存在`,
                            );
                        }
                    } else {
                        const content = "\n".repeat(199);
                        fs.writeFileSync(fullFilePath, content, "utf8");

                        if (!isPinned) {
                            panel.dispose();
                        }

                        const viewColumn = message.openInCurrentGroup
                            ? undefined
                            : vscode.ViewColumn.Beside;
                        vscode.workspace.openTextDocument(fullFilePath).then((doc) => {
                            vscode.window.showTextDocument(doc, viewColumn);
                            if (isPinned) {
                                setTimeout(() => refreshWebview(), 100);
                            }
                        });
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("创建文件失败: " + error.message);
                    logMessage("创建文件失败: " + error.message, "ERROR");
                }
                break;

            case "createFolder":
                const folderName = message.folderName;
                const newFolderPath = path.join(currentPath, folderName);

                try {
                    if (fs.existsSync(newFolderPath)) {
                        const stats = fs.statSync(newFolderPath);
                        if (stats.isDirectory()) {
                            vscode.window.showErrorMessage(`文件夹 "${folderName}" 已存在`);
                        } else {
                            vscode.window.showErrorMessage(
                                `无法创建文件夹 "${folderName}"，因为同名文件已存在`,
                            );
                        }
                    } else {
                        fs.mkdirSync(newFolderPath);
                        saveRecentDirectory(currentPath);
                        fileSizeCache = {};
                        vscode.window.showInformationMessage(
                            `文件夹 "${folderName}" 创建成功`,
                        );

                        setTimeout(() => refreshWebview(), 100);
                        if (panel && !panel.disposed) {
                            panel.webview.postMessage({ command: "clearFilenameInput" });
                        }
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("创建文件夹失败: " + error.message);
                    logMessage("创建文件夹失败: " + error.message, "ERROR");
                }
                break;

            case "cancel":
                panel.dispose();
                break;

            case "editFile":
                try {
                    const filePath = message.path;
                    const isPinned = message.isPinned || false;

                    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                        saveRecentDirectory(path.dirname(filePath));
                        const viewColumn = message.openInCurrentGroup
                            ? undefined
                            : vscode.ViewColumn.Beside;

                        vscode.workspace.openTextDocument(filePath).then((doc) => {
                            vscode.window.showTextDocument(doc, viewColumn);
                            if (!isPinned) {
                                panel.dispose();
                            } else {
                                refreshWebview();
                            }
                        });
                    } else {
                        vscode.window.showErrorMessage("无效的文件路径: " + filePath);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("打开文件失败: " + error.message);
                    logMessage("打开文件失败: " + error.message, "ERROR");
                }
                break;

            case "openFolderInNewWindow":
                try {
                    const folderPath = message.path;

                    if (
                        fs.existsSync(folderPath) &&
                        fs.statSync(folderPath).isDirectory()
                    ) {
                        saveRecentDirectory(folderPath);
                        vscode.commands.executeCommand(
                            "vscode.openFolder",
                            vscode.Uri.file(folderPath),
                            { forceNewWindow: true },
                        );
                        refreshWebview();
                    } else {
                        vscode.window.showErrorMessage("无效的文件夹路径: " + folderPath);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("打开文件夹失败: " + error.message);
                    logMessage("打开文件夹失败: " + error.message, "ERROR");
                }
                break;

            case "openWithDefaultApp":
                try {
                    const itemPath = message.path;
                    const itemType = message.type;

                    if (fs.existsSync(itemPath)) {
                        const dirToSave =
                            itemType === "folder" ? itemPath : path.dirname(itemPath);
                        saveRecentDirectory(dirToSave);

                        if (process.platform === "win32") {
                            cp.exec(`start "" "${itemPath.replace(/"/g, '""')}"`);
                        } else if (process.platform === "darwin") {
                            cp.exec(`open "${itemPath}"`);
                        } else {
                            cp.exec(`xdg-open "${itemPath}"`);
                        }
                        refreshWebview();
                    } else {
                        vscode.window.showErrorMessage("无效的路径: " + itemPath);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("打开项目失败: " + error.message);
                    logMessage("打开项目失败: " + error.message, "ERROR");
                }
                break;

            case "deleteToRecycleBin":
                try {
                    const itemPath = message.path;

                    if (fs.existsSync(itemPath)) {
                        saveRecentDirectory(currentPath);
                        fileSizeCache = {};
                        sizeCalculationPromises = {};

                        // 使用 withProgress API 显示初始删除进度
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: "正在移至回收站...",
                            cancellable: false
                        }, (progress) => {
                            progress.report({ message: path.basename(itemPath) });

                            return new Promise((resolve, reject) => {
                                const deleteCommand = (platform) => {
                                    if (platform === "win32") {
                                        const psScript = `& { (New-Object -ComObject Shell.Application).Namespace(0).ParseName('${itemPath.replace(/'/g, "''")}').InvokeVerb('delete') }`;
                                        const encodedScript = Buffer.from(psScript, "utf16le").toString("base64");
                                        return `powershell -NoProfile -EncodedCommand ${encodedScript}`;
                                    } else if (platform === "darwin") {
                                        return `trash "${itemPath.replace(/"/g, '\\"')}"`;
                                    } else {
                                        return `gvfs-trash "${itemPath.replace(/"/g, '\\"')}"`;
                                    }
                                };

                                cp.exec(deleteCommand(process.platform), (error) => {
                                    if (error) {
                                        vscode.window.showErrorMessage(
                                            "删除失败，请确保回收站工具已安装: " + error.message,
                                        );
                                        logMessage("删除项目失败: " + error.message, "ERROR");
                                        setTimeout(() => refreshWebview(), 300);
                                        reject(error);
                                    } else {
                                        setTimeout(() => {
                                            refreshWebview();
                                            resolve(); // 解析Promise以关闭第一个通知
                                        }, 300);
                                    }
                                });
                            });
                        }).then(() => {
                            // 第一个通知关闭后，显示第二个限时通知
                            vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: `${itemPath} 已删除`,
                                cancellable: false
                            }, () => {
                                // 这个Promise控制第二个通知的显示时间
                                return new Promise(resolve => {
                                    setTimeout(() => {
                                        resolve();
                                    }, 3000); // 停留3秒
                                });
                            });
                        });
                    } else {
                        vscode.window.showErrorMessage("要删除的项目不存在: " + itemPath);
                        refreshWebview();
                    }
                } catch (error) {
                    vscode.window.showErrorMessage("删除项目失败: " + error.message);
                    logMessage("删除项目失败: " + error.message, "ERROR");
                }
                break;
        }
    });

    // 处理面板关闭
    panel.onDidDispose(() => {
        // 清理资源
    });

    // 首次打开时调用，以填充文件列表
    updateResourceExplorer();
}

// -------- activate (保持不变) --------
function activate(context) {
    // 首次读取配置，设置全局 sizeMode
    getConfig();

    context.subscriptions.push(
        vscode.commands.registerCommand("qqq.kp", executeClipboardCommand),
        vscode.commands.registerCommand("qqq.kp2", () => {
            blockMode = !blockMode;
            const ed = vscode.window.activeTextEditor;
            if (ed) renderImages(ed);
        }),
        vscode.commands.registerCommand("qqq.openFile", (filePath) => {
            if (!fs.existsSync(filePath)) {
                vscode.window.showErrorMessage("文件不存在: " + filePath);
                return;
            }
            try {
                // 使用更可靠的方式打开文件，确保中文路径正确处理
                if (process.platform === "win32") {
                    // Windows平台使用start命令
                    cp.exec(`start "" "${filePath.replace(/"/g, '""')}"`);
                } else if (process.platform === "darwin") {
                    // macOS平台使用open命令
                    cp.exec(`open "${filePath}"`);
                } else {
                    // Linux及其他平台使用xdg-open命令
                    cp.exec(`xdg-open "${filePath}"`);
                }
            } catch (error) {
                // 如果上述方法失败，尝试使用VSCode的openExternal
                vscode.env.openExternal(vscode.Uri.file(filePath));
            }
        }),
        vscode.commands.registerCommand("qqq.saveAsDialog", showSaveAsDialog),
        vscode.languages.registerCodeLensProvider(
            { scheme: "file" },
            new FileCodeLensProvider(),
        ),

        // 切换活动编辑器
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                debounceRender(editor, 100);
            }
        }),

        // 可见编辑器范围改变时
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            debounceRender(event.textEditor, 50);
        }),

        // 文档内容改变时（编辑）
        vscode.workspace.onDidChangeTextDocument((event) => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document === event.document) {
                debounceRender(activeEditor, 260);
            }
        }),
    );

    // 初始化渲染：单次延迟确保编辑器完全加载
    setTimeout(() => {
        renderVisibleEditors(0);
    }, 100);
}

function deactivate() {
    clearDecorations();
}

module.exports = { activate, deactivate };

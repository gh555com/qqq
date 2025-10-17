const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
let sharp;

try {
	sharp = require("sharp");
} catch (e) {
	sharp = null;
	console.log("Sharp库未安装，无法调整图片尺寸");
}

// 公共配置常量
const LOG_PATH = "D:\\view\\p\\kp.log";
const BASE_DIR = "D:\\view\\p\\";

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

// q1 模块变量
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

// Python脚本执行
function runPythonScript(additionalEnv = {}) {
	const scriptPath = path.join(__dirname, "kp.py");
	if (!fs.existsSync(scriptPath)) {
		logMessage("脚本不存在: " + scriptPath, "ERROR");
		vscode.window.showErrorMessage("脚本不存在");
		return;
	}

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
			vscode.window.showInformationMessage("粘贴已取消");
			break;
		default:
			vscode.window.showWarningMessage("未知内容");
	}
}

// 异步处理图片渲染 - 与extension.js完全一致
async function renderImages(editor) {
	if (!editor) return;

	clearDecorations();

	decorationType = vscode.window.createTextEditorDecorationType({});
	const decos = [];
	const regex = /\[([A-Za-z]:[\\\/]view[\\\/]p[\\\/][^\[\]]+)\]/gi;

	const visibleRanges = editor.visibleRanges;
	if (!visibleRanges || visibleRanges.length === 0) return;

	for (const range of visibleRanges) {
		const text = editor.document.getText(range);

		regex.lastIndex = 0;
		let match;

		while ((match = regex.exec(text))) {
			const offsetInVisibleRange =
				editor.document.offsetAt(range.start) + match.index;
			const pos = editor.document.positionAt(offsetInVisibleRange);
			const endPos = pos.translate(0, match[0].length);
			const decoRange = new vscode.Range(pos, endPos);

			const absPath = match[1].replace(/\//g, "\\");

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

			const deco = {
				range: decoRange,
				renderOptions: {},
			};

			if (isImage) {
				try {
					if (sharp) {
						const TARGET_WIDTH = 512;
						const TARGET_HEIGHT = 288;

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

						const buffer = await sharp(absPath)
							.resize(TARGET_WIDTH, TARGET_HEIGHT, {
								fit: "contain",
								position: "center",
								background: { r: 0, g: 0, b: 0, alpha: 0 },
							})
							.toBuffer();

						const base64 = buffer.toString("base64");
						const dataUri = vscode.Uri.parse(
							`data:image/${mime};base64,${base64}`,
						);

						deco.renderOptions.after = {
							contentIconPath: dataUri,
							margin: blockMode ? "4px 0 4px -227px" : "4px 0 4px -227px",
							height: "294px",
							width: "518px",
							padding: "2px",
							border: "1px dashed #888",
							backgroundColor: "#fff3cd",
							display: "block",
							position: "relative",
						};
					} else {
						deco.renderOptions.after = {
							contentIconPath: vscode.Uri.file(absPath),
							margin: blockMode ? "4px 0 4px -227px" : "4px 0 4px -227px",
							height: blockMode ? "auto" : "148px",
							width: "auto",
							border: "1px dashed #888",
							backgroundColor: "rgba(230, 230, 250, 0.2)",
							display: "block",
							position: "relative",
						};
					}
				} catch (error) {
					logMessage("处理图片失败: " + error.message, "WARN");
					deco.renderOptions.after = {
						contentIconPath: vscode.Uri.file(absPath),
						margin: blockMode ? "4px 0 4px -227px" : "4px 0 4px -227px",
						height: blockMode ? "auto" : "148px",
						width: "auto",
						border: "1px dashed #888",
						backgroundColor: "rgba(230, 230, 250, 0.2)",
						display: "block",
						position: "relative",
					};
				}
			} else {
				deco.renderOptions.textDecoration = "underline wavy #888";
				deco.renderOptions.backgroundColor = "rgba(230, 230, 250, 0.1)";
				deco.renderOptions.fontSize = "14px";
				deco.renderOptions.lineHeight = "1.2";
				deco.renderOptions.display = "block";
			}

			decos.push(deco);
		}
	}

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

function openFileCommand(filePath) {
	if (!fs.existsSync(filePath)) {
		vscode.window.showErrorMessage("文件不存在: " + filePath);
		return;
	}
	try {
		if (process.platform === "win32") {
			cp.exec(`start "" "${filePath.replace(/"/g, '""')}"`);
		} else if (process.platform === "darwin") {
			cp.exec(`open "${filePath}"`);
		} else {
			cp.exec(`xdg-open "${filePath}"`);
		}
	} catch (error) {
		vscode.env.openExternal(vscode.Uri.file(filePath));
	}
}

function toggleBlockMode() {
	blockMode = !blockMode;
	const ed = vscode.window.activeTextEditor;
	if (ed) renderImages(ed);
}

// 防抖渲染
function debounceRender(editor, delay = 100) {
	if (debounceRender.isProcessing) {
		return;
	}

	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => {
		if (editor && !editor.document.isClosed) {
			debounceRender.isProcessing = true;

			Promise.resolve()
				.then(() => {
					renderImages(editor);
				})
				.finally(() => {
					setTimeout(() => {
						debounceRender.isProcessing = false;
					}, 50);
				});
		}
	}, delay);
}

debounceRender.isProcessing = false;

function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors;
	if (editors && editors.length) {
		editors.forEach((ed) => {
			debounceRender(ed, delay);
		});
	}
}

// 模块激活
function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.q1", executeClipboardCommand),
		vscode.commands.registerCommand("qqq.toggleBlockMode", toggleBlockMode),
		vscode.commands.registerCommand("qqq.openFile", openFileCommand),
		vscode.languages.registerCodeLensProvider(
			{ scheme: "file" },
			new FileCodeLensProvider(),
		),
	);

	vscode.window.onDidChangeActiveTextEditor((editor) => {
		if (editor) debounceRender(editor);
	});

	vscode.workspace.onDidChangeTextDocument((event) => {
		const editor = vscode.window.activeTextEditor;
		if (editor && event.document === editor.document) {
			debounceRender(editor);
		}
	});

	vscode.window.onDidChangeVisibleTextEditors(() => {
		renderVisibleEditors();
	});

	const editor = vscode.window.activeTextEditor;
	if (editor) renderImages(editor);
}

module.exports = {
	activate
};

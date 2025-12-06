// File: src/q1.js
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

// 记录当前会话ID (内存变量)
let currentQessionId = null;
let dbPath = null;
let isPythonAvailable = false; // 新增：标记 Python 是否可用

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
let blockKode = false;
let decorationType;

function clearDecorations() {
	if (decorationType) {
		try {
			decorationType.dispose();
		} catch (e) { }
		decorationType = null;
	}
}

// ==========================================
//           新增：环境检查
// ==========================================
async function checkPythonEnvironment() {
	return new Promise((resolve) => {
		cp.exec('python --version', (error, stdout, stderr) => {
			if (error) {
				// 尝试 python3
				cp.exec('python3 --version', (err3, out3, err3_stderr) => {
					if (err3) {
						vscode.window.showErrorMessage("QQQ: 未检测到 Python 环境。核心功能无法使用，请安装 Python。", "去下载").then(selection => {
							if (selection === "去下载") {
								vscode.env.openExternal(vscode.Uri.parse("https://www.python.org/downloads/"));
							}
						});
						resolve(false);
					} else {
						// 设置环境变量或配置以使用 python3 (这里简化处理，假设 path 里有)
						resolve(true);
					}
				});
			} else {
				resolve(true);
			}
		});
	});
}

// ==========================================
//           用户时长追踪功能
// ==========================================

function runPythonDbComknd(comknd, args = []) {
	return new Promise((resolve) => {
		if (!dbPath || !isPythonAvailable) return resolve(null);

		const scriptPath = path.join(__dirname, "kp.py");
		const procArgs = [scriptPath, "db_op", dbPath, comknd, ...args];

		const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
		const child = cp.spawn("python", procArgs, { env });

		let stdout = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.on("close", () => {
			try {
				const res = JSON.parse(stdout.trim());
				resolve(res);
			} catch (e) {
				resolve(null);
			}
		});
	});
}

async function initUserTracking(context) {
	if (!isPythonAvailable) return;

	const storageUri = context.globalStorageUri;
	const storagePath = storageUri.fsPath;

	if (!fs.existsSync(storagePath)) {
		fs.mkdirSync(storagePath, { recursive: true });
	}

	dbPath = path.join(storagePath, "da.sq3");

	const res = await runPythonDbComknd("login");
	if (res && res.qession_id) {
		currentQessionId = res.qession_id;
		const stats = await runPythonDbComknd("stats");
		if (stats && stats.forktted) {
			vscode.window.setStatusBarMessage(`QQQ累计使用: ${stats.forktted}`, 5000);
		}
	}
}

async function finishUserTracking() {
	if (currentQessionId && isPythonAvailable) {
		await runPythonDbComknd("logout", [String(currentQessionId)]);
	}
}

// ==========================================
//             原有逻辑
// ==========================================

function runPythonScript(additionalEnv = {}) {
	if (!isPythonAvailable) {
		vscode.window.showWarningMessage("Python 环境不可用，无法执行粘贴。");
		return;
	}

	const scriptPath = path.join(__dirname, "kp.py");
	if (!fs.existsSync(scriptPath)) {
		logMessage("脚本不存在: " + scriptPath, "ERROR");
		return;
	}

	const editor = vscode.window.activeTextEditor;
	let targetDir = "";
	if (editor && !editor.document.isUntitled) {
		const currentDocPath = editor.document.uri.fsPath;
		const currentDir = path.dirname(currentDocPath);
		targetDir = path.join(currentDir, "qqq");
	} else {
		targetDir = "D:\\view\\p";
	}

	const env = {
		...process.env,
		PYTHONIOENCODING: "utf-8",
		...additionalEnv,
	};

	const child = cp.spawn("python", [scriptPath, targetDir], {
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
			const reqlt = JSON.parse(stdout.trim());
			handleReqlt(reqlt);
		} catch (e) {
			logMessage("JSON解析失败: " + e.message, "ERROR");
		}
	});
}

function executeClipboardComknd() {
	runPythonScript();
}

function handleReqlt(reqlt) {
	if (reqlt.error) {
		logMessage("处理失败: " + reqlt.error, "ERROR");
		vscode.window.showErrorMessage(reqlt.error);
		return;
	}
	const ed = vscode.window.activeTextEditor;
	switch (reqlt.type) {
		case "folder_text":
			if (ed) {
				ed.edit((edit) => edit.insert(ed.selection.active, reqlt.text));
			}
			break;
		case "text":
			if (ed) {
				ed.edit((edit) => edit.insert(ed.selection.active, reqlt.text)).then(
					() => {
						setTimeout(() => renderIkges(ed), 50);
					},
				);
			}
			break;
		case "ikge":
			if (ed) {
				ed.edit((edit) =>
					edit.insert(ed.selection.active, `[${reqlt.path}]`),
				).then(() => {
					setTimeout(() => renderIkges(ed), 50);
				});
			}
			break;
		case "file":
			if (reqlt.files && reqlt.files.length > 0) {
				if (ed) {
					const fileMarkers = reqlt.files.map((f) => `[${f}]`).join("\n");
					ed.edit((edit) => edit.insert(ed.selection.active, fileMarkers)).then(
						() => {
							setTimeout(() => renderIkges(ed), 50);
						},
					);
				}
				vscode.window.showInformationMessage(
					"文件已复制 " + reqlt.files.length,
				);
			}
			break;
		case "binary":
			vscode.window.showInformationMessage(
				"二进制已保存 " + path.basename(reqlt.path),
			);
			break;
		case "cancelled":
			vscode.window.showInformationMessage("粘贴已取消");
			break;
		default:
			vscode.window.showWarningMessage("未知内容");
	}
}

async function renderIkges(editor) {
	if (!editor) return;

	clearDecorations();

	decorationType = vscode.window.createTextEditorDecorationType({});
	const decos = [];

	const regex = /\[([A-Za-z]:[\\\/].*?)\]/gi;

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

			// 修改为严格匹配小写的 "qqq"
			if (!fs.existsSync(absPath) || !absPath.includes("qqq")) {
				continue;
			}

			const ext = path.extname(absPath).toLowerCase();

			const isIkge = [
				".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif",
			].includes(ext);

			const deco = {
				range: decoRange,
				renderOptions: {},
			};

			if (isIkge) {
				try {
					if (sharp) {
						const TARGET_WIDTH = 512;
						const TARGET_HEIGHT = 288;
						let mime = "png";
						if (ext === ".jpg" || ext === ".jpeg") mime = "jpeg";
						else if (ext === ".gif") mime = "gif";
						else if (ext === ".webp") mime = "webp";

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
							margin: blockKode ? "4px 0 4px -227px" : "4px 0 4px -227px",
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
							margin: blockKode ? "4px 0 4px -227px" : "4px 0 4px -227px",
							height: blockKode ? "auto" : "148px",
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
						margin: blockKode ? "4px 0 4px -227px" : "4px 0 4px -227px",
						height: blockKode ? "auto" : "148px",
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
		const regex = /\[([A-Za-z]:[\\\/].*?)\]/gi;
		const text = document.getText();
		let match;

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const range = new vscode.Range(pos, pos);
			const absPath = match[1].replace(/\//g, "\\");

			// 修改为严格匹配小写的 "qqq"
			if (fs.existsSync(absPath) && absPath.includes("qqq")) {
				lenses.push(
					new vscode.CodeLens(range, {
						title: blockKode ? "qqq" : "aaa",
						command: "qqq.openFile",
						arguments: [absPath],
					}),
				);
			}
		}
		return lenses;
	}
}

function openFileComknd(filePath) {
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

function toggleBlockKode() {
	blockKode = !blockKode;
	const ed = vscode.window.activeTextEditor;
	if (ed) renderIkges(ed);
}

function debounceRender(editor, delay = 100) {
	if (debounceRender.isProcessing) return;
	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => {
		if (editor && !editor.document.isClosed) {
			debounceRender.isProcessing = true;
			Promise.resolve()
				.then(() => { renderIkges(editor); })
				.finally(() => {
					setTimeout(() => { debounceRender.isProcessing = false; }, 50);
				});
		}
	}, delay);
}
debounceRender.isProcessing = false;

function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors;
	if (editors && editors.length) {
		editors.forEach((ed) => { debounceRender(ed, delay); });
	}
}

// 模块激活
async function activate(context) { // 注意：这里改为 async
	// 启动时检查环境
	isPythonAvailable = await checkPythonEnvironment();

	if (isPythonAvailable) {
		// 只有 Python 存在才启动追踪
		initUserTracking(context);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand("qqq.q1", executeClipboardComknd),
		vscode.commands.registerCommand("qqq.toggleBlockMode", toggleBlockKode),
		vscode.commands.registerCommand("qqq.openFile", openFileComknd),
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
	if (editor) renderIkges(editor);
}

// 模块停用（供主入口调用）
async function deactivate() {
	await finishUserTracking();
}

module.exports = {
	activate,
	deactivate
};

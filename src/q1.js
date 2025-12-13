// File: src/q1.js
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const {
	identifyFile, getFolderInfo, handleClipboardFast, handleClipboardSlow, shouldShowDuration, logMessage,
	QQQ_PATH_REGEX, PENDING_REGEX, ffmpegPath, finishUserTracking, initUserTracking, createPendingToken,
	getPreview, CACHE_CONFIG
} = require("./qqq");

const CORE_INTEGRITY_HASH = "dc10f424bef818e80eea0a5175bbb6cca07cbee34c8510c7b64069ef1661c88e";
let isCoreIntegretyValid = false;

let ffmpegProbePromise = null;
const documentDecorationsMap = new Map();
let currentRenderVersion = 0;
const resolutionCache = new Map();
const MAX_CONCURRENT_TASKS = 8;
const SCROLL_DEBOUNCE_MS = 200;
const PREVIEW_WIDTH = 512;
const PREVIEW_HEIGHT = 288;
const PREVIEW_BORDER = 6;
const PREVIEW_BG_COLOR = "#fef6e3";

const assetsCache = { checked: false, bgExists: false, wmExists: false };
let watermarkBase64 = null;
const WATERMARK_PATH = path.join(__dirname, "..", "assets", "q2.gif");
let decorationType, markerHideType, extensionContext = null;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov"]);
const qqqFolderSizeCache = new Map();
const FOLDER_SIZE_CACHE_MAX_AGE = 10 * 1000;

let enlargeSmallImages = true;
let extremePerformanceMode = false;
let cleanFreakMode = false;
let qualityMode = '1';

const pendingTokens = new Map();

const LOADING_SVG = `data:image/svg+xml;base64,` + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><circle cx="20" cy="20" r="8" fill="#888"><animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" begin="0s"/></circle><circle cx="60" cy="20" r="8" fill="#888"><animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" begin="0.33s"/></circle><circle cx="100" cy="20" r="8" fill="#888"><animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" begin="0.66s"/></circle></svg>`).toString('base64');

function refreshQqqConfig() {
	try {
		const config = vscode.workspace.getConfiguration("qqq");
		enlargeSmallImages = config.get("enlargeSmallImages", config.get("stretchSmallImages", true));
		extremePerformanceMode = config.get("extremePerformance", false);
		cleanFreakMode = config.get("cleanFreak", false);
		const qm = config.get("qualityMode", "性能优先");
		if (qm === "质量优先") qualityMode = '0';
		else if (qm === "极限性能") qualityMode = '9';
		else qualityMode = '1';
	} catch (e) { enlargeSmallImages = true; extremePerformanceMode = false; cleanFreakMode = false; qualityMode = '1'; }
}

function loadWatermarkResource() {
	try { if (fs.existsSync(WATERMARK_PATH)) { const buf = fs.readFileSync(WATERMARK_PATH); watermarkBase64 = "data:image/gif;base64," + buf.toString("base64"); assetsCache.wmExists = true; } }
	catch (e) { watermarkBase64 = null; }
	assetsCache.checked = true;
}

function clearDecorations() {
	if (decorationType) { try { decorationType.dispose(); } catch (e) { } decorationType = null; }
	if (markerHideType) { try { markerHideType.dispose(); } catch (e) { } markerHideType = null; }
	documentDecorationsMap.clear();
}

function verifySystemIntegrity() {
	try { if (!fs.existsSync(WATERMARK_PATH)) return false; const buffer = fs.readFileSync(WATERMARK_PATH); const hash = crypto.createHash("sha256").update(buffer).digest("hex"); return hash === CORE_INTEGRITY_HASH; }
	catch (e) { return false; }
}

function formatBytes(size) { if (size == null || isNaN(size)) return "?"; const units = ["b", "k", "m", "g"]; let unitIndex = 0; let value = size; while (value >= 1024 && unitIndex < units.length - 1) { value = value / 1024; unitIndex++; } return `${Math.round(value)}${units[unitIndex]}`; }
function formatDuration(seconds) { if (seconds == null || isNaN(seconds) || seconds < 0) return "0s"; if (seconds >= 60) { const mins = Math.floor(seconds / 60); const secs = seconds % 60; return `${mins}m + ${secs.toFixed(2)}s`; } else return `${seconds.toFixed(2)}s`; }
function isImageExt(ext) { return IMAGE_EXTS.has(ext.toLowerCase()); }
function isVideoExt(ext) { return VIDEO_EXTS.has(ext.toLowerCase()); }
function isImageOrVideoExt(ext) { const lower = ext.toLowerCase(); return IMAGE_EXTS.has(lower) || VIDEO_EXTS.has(lower); }
function getDocumentEOL(document) { return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"; }

function resolvePathToAbsolute(docUri, rawPath) {
	if (!rawPath) return null;
	let cleanPath = rawPath.trim();
	while (cleanPath.startsWith("\\") || cleanPath.startsWith("/")) cleanPath = cleanPath.slice(1);
	if (path.isAbsolute(cleanPath)) return cleanPath;
	const docDir = path.dirname(docUri.fsPath);
	return path.resolve(docDir, cleanPath);
}

function buildNewRawPath(oldRawPath, newFileName) {
	const lastSlash = Math.max(oldRawPath.lastIndexOf("/"), oldRawPath.lastIndexOf("\\"));
	if (lastSlash === -1) return newFileName;
	return oldRawPath.slice(0, lastSlash + 1) + newFileName;
}

function determineMediaType(codec, ext) {
	if (!codec) { const e = ext.toLowerCase(); if (e === ".gif") return "gif"; if (VIDEO_EXTS.has(e)) return "video"; if (IMAGE_EXTS.has(e)) return "image"; return "unknown"; }
	const c = codec.toLowerCase();
	if (c === "gif") return "gif";
	if (["png", "mjpeg", "webp", "bmp", "tiff", "jpeg", "jpg"].some(x => c.includes(x))) { if (c.includes("mjpeg") && VIDEO_EXTS.has(ext.toLowerCase())) return "video"; return "image"; }
	const videoCodecs = ["h264", "hevc", "vp8", "vp9", "av1", "mpeg4", "mpeg2video", "prores", "wmv", "flv", "theora", "vc1", "rv40"];
	if (videoCodecs.some(x => c.includes(x))) return "video";
	if (VIDEO_EXTS.has(ext.toLowerCase())) return "video";
	if (IMAGE_EXTS.has(ext.toLowerCase())) return "image";
	return "unknown";
}

async function ensureFfmpegAvailable() {
	if (!ffmpegPath) return false;
	if (ffmpegProbePromise) return ffmpegProbePromise;
	ffmpegProbePromise = new Promise((resolve) => {
		const child = cp.spawn(ffmpegPath, ["-version"], { windowsHide: true });
		let handled = false;
		child.on("error", () => { handled = true; resolve(false); });
		child.on("close", (code) => { if (!handled) resolve(code === 0); });
	});
	return ffmpegProbePromise;
}

async function getMediaInfo(filePath, mtimeMs) {
	const cached = resolutionCache.get(filePath);
	if (cached && cached.mtime === mtimeMs) return cached;
	const result = await identifyFile(filePath);
	if (result && !result.error && result.width) {
		const info = { mtime: mtimeMs, res: `${result.width}x${result.height}`, width: result.width, height: result.height, codec: result.codec, codec_long_name: result.codec_long_name, duration: result.duration || 0, type: result.type || "unknown" };
		resolutionCache.set(filePath, info);
		if (resolutionCache.size > 200) resolutionCache.delete(resolutionCache.keys().next().value);
		return info;
	}
	if (!ffmpegPath) return null;
	return new Promise((resolve) => {
		const child = cp.spawn(ffmpegPath, ["-hide_banner", "-i", filePath], { windowsHide: true });
		let stderr = "";
		child.stderr.on("data", d => { if (stderr.length < 50000) stderr += d.toString(); });
		child.on("close", () => {
			const resMatch = /Stream.*Video:.*,\s*(\d+)x(\d+)/i.exec(stderr);
			const codecMatch = /Stream.*Video:\s*(.*?)(?:,|$)/i.exec(stderr);
			const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(stderr);
			let info = { mtime: mtimeMs, res: null, width: null, height: null, codec: null, duration: 0, type: "unknown" };
			if (resMatch) { const w = parseInt(resMatch[1]); const h = parseInt(resMatch[2]); info.res = `${w}x${h}`; info.width = w; info.height = h; }
			if (codecMatch && codecMatch[1]) info.codec = codecMatch[1].trim();
			if (durMatch) { const hours = parseFloat(durMatch[1]), mins = parseFloat(durMatch[2]), secs = parseFloat(durMatch[3]); const rawDuration = hours * 3600 + mins * 60 + secs; if (info.codec && info.codec.toLowerCase().includes('mjpeg') && rawDuration <= 0.1) { info.duration = 0; info.type = 'image'; } else { info.duration = rawDuration; } }
			const ext = path.extname(filePath);
			if (info.type === "unknown") info.type = determineMediaType(info.codec, ext);
			resolutionCache.set(filePath, info);
			if (resolutionCache.size > 200) resolutionCache.delete(resolutionCache.keys().next().value);
			resolve(info.width ? info : null);
		});
		setTimeout(() => { try { child.kill(); } catch { } resolve(null); }, 2000);
	});
}

function computeMarginLeft() { return "100px"; }

function calculateAspectRatioString(w, h) {
	if (!w || !h) return "";
	if (w >= h) { const r = (h / w) * 16; return `16__${parseFloat(r.toFixed(1))}`; }
	else { const r = (w / h) * 16; return `${parseFloat(r.toFixed(1))}__16`; }
}

function createProgressSvg(durationSeconds) {
	if (!durationSeconds || durationSeconds <= 0) return null;
	const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="4" viewBox="0 0 512 4"><rect width="512" height="4" fill="black" /><rect width="0" height="4" fill="#fdf6e3"><animate attributeName="width" from="0" to="512" dur="${durationSeconds.toFixed(3)}s" repeatCount="indefinite" fill="freeze" calcMode="linear" /></rect></svg>`;
	return "data:image/svg+xml;base64," + Buffer.from(svgStr).toString("base64");
}

function invalidateFolderSizeCacheForPath(filePath) { try { const dir = path.dirname(filePath); if (qqqFolderSizeCache.has(dir)) qqqFolderSizeCache.delete(dir); } catch { } }

async function getQqqFolderSize(folderPath) {
	const now = Date.now();
	const cached = qqqFolderSizeCache.get(folderPath);
	if (cached && now - cached.timestamp < FOLDER_SIZE_CACHE_MAX_AGE) return cached.data;
	const result = await getFolderInfo(folderPath);
	if (result && result.success) {
		const parts = []; let totalFiles = 0;
		if (result.ext_stats) for (const [ext, count] of Object.entries(result.ext_stats)) { totalFiles += count; parts.push(`${count}_${ext || '无后缀'}`); }
		const summaryStr = parts.length > 0 ? `${totalFiles}个文件：${parts.join("; ")}` : (result.file_count_root > 0 ? `${result.file_count_root}个文件` : "空文件夹");
		const cachedData = { size: result.total_size, summary: summaryStr };
		qqqFolderSizeCache.set(folderPath, { data: cachedData, timestamp: now });
		return cachedData;
	}
	return null;
}

async function executeClipboardCommand() {
	if (!isCoreIntegretyValid) { vscode.window.showErrorMessage("Integrity check failed."); return; }
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	let targetDir = "D:\\view\\p";
	if (!editor.document.isUntitled) targetDir = path.join(path.dirname(editor.document.uri.fsPath), "qqq");

	const fastResult = await handleClipboardFast();
	if (fastResult && fastResult.type === "text") { await editor.edit(e => e.insert(editor.selection.active, fastResult.text)); return; }

	const token = createPendingToken();
	const eol = getDocumentEOL(editor.document);
	const pendingMarker = `/\\__PENDING__:${token}__\\/`;
	const insertPosition = editor.selection.active;
	await editor.edit(e => e.insert(insertPosition, eol + pendingMarker + eol));
	pendingTokens.set(token, { editor: editor, documentUri: editor.document.uri.toString(), targetDir: targetDir });
	debounceRender(editor, 10);

	setImmediate(async () => {
		try { const result = await handleClipboardSlow(targetDir); await replacePendingMarker(token, result); }
		catch (e) { logMessage(`媒体处理失败: ${e.message}`, "ERROR"); await replacePendingMarker(token, { type: "error", error: e.message }); }
	});
}

async function replacePendingMarker(token, result) {
	const pending = pendingTokens.get(token);
	if (!pending) return;
	pendingTokens.delete(token);
	let editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === pending.documentUri);
	if (!editor) return;

	const doc = editor.document;
	const text = doc.getText();
	const pendingMarker = `/\\__PENDING__:${token}__\\/`;
	const markerIndex = text.indexOf(pendingMarker);
	if (markerIndex === -1) return;

	const startPos = doc.positionAt(markerIndex);
	const endPos = doc.positionAt(markerIndex + pendingMarker.length);
	const markerRange = new vscode.Range(startPos, endPos);

	let replacement = "";
	const eol = getDocumentEOL(doc);
	const docDir = path.dirname(doc.uri.fsPath);

	if (result.type === "unknown" || result.type === "error") { replacement = ""; }
	else if (result.type === "folder_text") { replacement = result.text; }
	else if (result.type === "image" || result.type === "ikge") {
		const filePath = result.path;
		const relPath = path.relative(docDir, filePath).replace(/\//g, "\\");
		const isVidOrImg = isImageOrVideoExt(path.extname(filePath));
		const gapBelow = calculateBlankLinesN(isVidOrImg, true);
		replacement = `/\\${relPath}\\/` + eol.repeat(gapBelow);
		invalidateFolderSizeCacheForPath(filePath);
	} else if (result.type === "file") {
		const files = result.files;
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			const relPath = path.relative(docDir, f).replace(/\//g, "\\");
			const isVidOrImg = isImageOrVideoExt(path.extname(f));
			const isLastItem = (i === files.length - 1);
			if (i > 0) replacement += eol;
			replacement += `/\\${relPath}\\/`;
			const gapBelow = calculateBlankLinesN(isVidOrImg, isLastItem);
			replacement += eol.repeat(gapBelow);
			invalidateFolderSizeCacheForPath(f);
		}
		if (files.length > 1) vscode.window.showInformationMessage("文件已复制 " + files.length);
	} else if (result.type === "text") { replacement = result.text; }

	await editor.edit(editBuilder => { editBuilder.replace(markerRange, replacement); });
	setTimeout(() => renderImages(editor), 50);
}

function calculateBlankLinesN(isFramed, isLastItem = false) {
	try {
		const config = vscode.workspace.getConfiguration('editor');
		const fontSize = config.get('fontSize', 14);
		const lineHeightMultiplier = config.get('lineHeight', 0);
		const effectiveLineHeight = (lineHeightMultiplier === 0) ? 1.35 : lineHeightMultiplier;
		const pixelPerLine = fontSize * effectiveLineHeight;
		const requiredHeight = PREVIEW_HEIGHT;
		let baseN = Math.ceil(requiredHeight / pixelPerLine);
		let extra = 2 + Math.floor((effectiveLineHeight - 1) * 3);
		extra = Math.min(5, Math.max(2, extra));
		let n = baseN + extra;
		n = Math.max(4, n);
		if (isLastItem) { if (isFramed) n = Math.max(8, n); else n = 2; }
		else { if (!isFramed) n = 2; }
		return n;
	} catch (e) { return 15; }
}

function provideCleanlinessEdits(document) {
	const edits = [];
	const text = document.getText();
	const regex = new RegExp(QQQ_PATH_REGEX);
	const eol = getDocumentEOL(document);
	let match;
	const markers = [];
	while ((match = regex.exec(text))) markers.push({ text: match[0], index: match.index });

	for (let i = markers.length - 1; i >= 0; i--) {
		const m = markers[i];
		const startPos = document.positionAt(m.index);
		const endPos = document.positionAt(m.index + m.text.length);
		const markerLine = startPos.line;
		const rawPath = m.text.slice(2, -2).trim();
		if (rawPath.startsWith("__PENDING__:")) continue;
		const absPath = resolvePathToAbsolute(document.uri, rawPath.replace(/\//g, "\\"));
		let isVidOrImg = false;
		if (absPath) isVidOrImg = isImageOrVideoExt(path.extname(absPath));
		const lineObj = document.lineAt(markerLine);
		const lineContent = lineObj.text;
		if (startPos.character > 0) edits.push(vscode.TextEdit.insert(startPos, eol));
		const suffix = lineContent.substring(endPos.character);
		if (suffix.trim().length > 0) edits.push(vscode.TextEdit.insert(endPos, eol));
		let isLastMarkerInDoc = (i === markers.length - 1);
		const neededLines = calculateBlankLinesN(isVidOrImg, isLastMarkerInDoc);
		let existingBlanks = 0;
		for (let lineIdx = markerLine + 1; lineIdx < document.lineCount; lineIdx++) { if (document.lineAt(lineIdx).text.trim() === "") existingBlanks++; else break; }
		if (existingBlanks < neededLines) { const linesToAdd = neededLines - existingBlanks; const lineEndPos = lineObj.range.end; edits.push(vscode.TextEdit.insert(lineEndPos, eol.repeat(linesToAdd))); }
	}
	return edits;
}

async function performGlobalClean(editor, force = false) {
	if (!editor) return;
	if (!force && !cleanFreakMode) return;
	const edits = provideCleanlinessEdits(editor.document);
	if (edits.length > 0) { await editor.edit(editBuilder => { edits.forEach(e => { if (e.newText) editBuilder.insert(e.range.start, e.newText); else editBuilder.replace(e.range, e.newText); }); }); }
}

async function renderImages(editor) {
	if (!editor) return;
	if (!isCoreIntegretyValid) { clearDecorations(); return; }
	const myRenderVersion = ++currentRenderVersion;

	if (!decorationType) decorationType = vscode.window.createTextEditorDecorationType({ isWholeLine: false });
	if (!markerHideType) markerHideType = vscode.window.createTextEditorDecorationType({ textDecoration: 'none; font-size: 11px; color: transparent; opacity: 0;' });

	const docUri = editor.document.uri.toString();
	if (!documentDecorationsMap.has(docUri)) documentDecorationsMap.set(docUri, new Map());
	const currentDocDecos = documentDecorationsMap.get(docUri);
	const currentHideDecos = new Map();
	const visibleRanges = editor.visibleRanges;
	if (!visibleRanges || !visibleRanges.length) return;

	const marginLeft = computeMarginLeft();
	const boxWidth = PREVIEW_WIDTH + PREVIEW_BORDER;
	const boxHeight = PREVIEW_HEIGHT + PREVIEW_BORDER;
	const tasks = [];
	const regex = new RegExp(QQQ_PATH_REGEX);

	for (const range of visibleRanges) {
		const text = editor.document.getText(range);
		regex.lastIndex = 0;
		let match;
		while ((match = regex.exec(text))) {
			const offset = editor.document.offsetAt(range.start) + match.index;
			const pos = editor.document.positionAt(offset);
			const endPos = editor.document.positionAt(offset + match[0].length);
			const uniqueKey = `${pos.line}_${pos.character}`;
			const hideDeco = { range: new vscode.Range(pos, endPos) };
			currentHideDecos.set(uniqueKey, hideDeco);
			const rawPath = match[0].slice(2, -2).trim();

			if (rawPath.startsWith("__PENDING__:")) {
				const targetLine = pos.line;
				if (targetLine >= editor.document.lineCount) continue;
				const anchorRange = new vscode.Range(targetLine, 0, targetLine, 0);
				const loadingDeco = {
					range: anchorRange,
					renderOptions: { after: { contentText: "", position: 'absolute', left: marginLeft, top: '0px', width: `${boxWidth}px`, height: `${boxHeight}px`, padding: "2px", border: "1px dashed #888", backgroundColor: PREVIEW_BG_COLOR, zIndex: -1, textDecoration: `none; pointer-events: none; display: inline-block; background-image: url("${LOADING_SVG}"); background-size: 120px 40px; background-position: center center; background-repeat: no-repeat;` } }
				};
				currentDocDecos.set(uniqueKey, loadingDeco);
				continue;
			}

			if (currentDocDecos.has(uniqueKey)) continue;

			const absPath = resolvePathToAbsolute(editor.document.uri, rawPath.replace(/\//g, "\\"));
			if (!absPath || !fs.existsSync(absPath)) continue;

			const ext = path.extname(absPath).toLowerCase();
			let isImage = isImageExt(ext);
			let isVideo = isVideoExt(ext);
			let isGif = ext === ".gif";
			let mtimeMs = 0;
			try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch { }
			let mediaInfo = null;
			if (!isImage && !isVideo) {
				mediaInfo = await getMediaInfo(absPath, mtimeMs);
				if (mediaInfo && mediaInfo.type === "video") isVideo = true;
				else if (mediaInfo && mediaInfo.type === "image") { isImage = true; if (mediaInfo.codec === "gif") isGif = true; }
				else continue;
			}

			const targetLine = pos.line;
			if (targetLine >= editor.document.lineCount) continue;
			const anchorRange = new vscode.Range(targetLine, 0, targetLine, 0);

			const task = async () => {
				if (currentRenderVersion !== myRenderVersion) return null;
				try {
					const previewResult = await getPreview(absPath, qualityMode);
					if (currentRenderVersion !== myRenderVersion) return null;
					if (!previewResult || !previewResult.base64) return null;

					const deco = { range: anchorRange, renderOptions: {} };
					const contentUrl = `url("${previewResult.base64}")`;
					const actualGifDuration = previewResult.meta?.gifDur || 0;
					const outputSize = previewResult.meta ? { width: previewResult.meta.width, height: previewResult.meta.height } : null;

					let progressBarUrl = null;
					if ((isGif || isVideo || previewResult.meta?.type === 'animated_image') && actualGifDuration > 0) progressBarUrl = `url("${createProgressSvg(actualGifDuration)}")`;

					const gridSize = "20px 20px";
					const gridImage = `conic-gradient(#fdf6e3 0.25turn, #e6e1cf 0.25turn 0.5turn, #fdf6e3 0.5turn 0.75turn, #e6e1cf 0.75turn)`;

					let layers = [], sizes = [], positions = [], repeats = [];
					if (watermarkBase64) { layers.push(`url("${watermarkBase64}")`); sizes.push("contain"); positions.push("center center"); repeats.push("no-repeat"); }
					if (progressBarUrl) { layers.push(progressBarUrl); sizes.push("512px 4px"); positions.push("center bottom"); repeats.push("no-repeat"); }
					layers.push(contentUrl);
					sizes.push("contain");
					positions.push("center center");
					repeats.push("no-repeat");
					layers.push(gridImage); sizes.push(gridSize); positions.push("0 0"); repeats.push("repeat");

					deco.renderOptions.after = { contentText: "", position: 'absolute', left: marginLeft, top: '0px', width: `${boxWidth}px`, height: `${boxHeight}px`, padding: "2px", border: "1px dashed #888", backgroundColor: PREVIEW_BG_COLOR, zIndex: -1, textDecoration: `none; pointer-events: none; display: inline-block; background-image: ${layers.join(", ")}; background-size: ${sizes.join(", ")}; background-position: ${positions.join(", ")}; background-repeat: ${repeats.join(", ")};` };
					deco.hoverMessage = new vscode.MarkdownString(`[打开图片](${vscode.Uri.file(absPath).toString()})`);
					deco.hoverMessage.isTrusted = true;
					return { key: uniqueKey, deco };
				} catch (e) { return null; }
			};
			tasks.push(task);
		}
	}

	if (tasks.length > 0) {
		const results = [];
		for (let i = 0; i < tasks.length; i += MAX_CONCURRENT_TASKS) {
			if (currentRenderVersion !== myRenderVersion) return;
			const chunk = tasks.slice(i, i + MAX_CONCURRENT_TASKS);
			const chunkResults = await Promise.all(chunk.map(t => t()));
			results.push(...chunkResults);
		}
		if (currentRenderVersion !== myRenderVersion) return;
		for (const res of results) { if (res) currentDocDecos.set(res.key, res.deco); }
	}
	editor.setDecorations(decorationType, Array.from(currentDocDecos.values()));
	if (currentHideDecos.size > 0) editor.setDecorations(markerHideType, Array.from(currentHideDecos.values()));
}

class FileCodeLensProvider {
	async provideCodeLenses(document) {
		if (!isCoreIntegretyValid) return [];
		const lenses = [];
		const regex = new RegExp(QQQ_PATH_REGEX);
		const text = document.getText();
		let match;
		const tasks = [];

		while ((match = regex.exec(text))) {
			const pos = document.positionAt(match.index);
			const rawPath = match[0].slice(2, -2).trim();
			if (rawPath.startsWith("__PENDING__:")) continue;
			const absPath = resolvePathToAbsolute(document.uri, rawPath.replace(/\//g, "\\"));
			if (!absPath || !fs.existsSync(absPath)) continue;
			const folder = path.dirname(absPath);
			const ext = path.extname(absPath).toLowerCase();
			const isVidOrImg = isImageOrVideoExt(ext);
			const isVideoExtFlag = isVideoExt(ext);
			const targetLensLine = pos.line;

			tasks.push(async () => {
				let folderData = await getQqqFolderSize(folder);
				const fSize = folderData ? folderData.size : 0;
				const fSizeStr = formatBytes(fSize);
				const folderTooltip = folderData ? folderData.summary : undefined;
				let fileSz = "?"; let tooltipText = ""; let mtimeMs = 0;
				try { const st = fs.statSync(absPath); fileSz = formatBytes(st.size); const bTime = new Date(st.birthtime).toLocaleString(); const mTime = new Date(st.mtime).toLocaleString(); tooltipText = `创建: ${bTime}\n修改: ${mTime}`; mtimeMs = st.mtimeMs; } catch { }
				let titleSuffix = ""; let isRealVideo = false;
				if (isVidOrImg) {
					const info = await getMediaInfo(absPath, mtimeMs);
					if (info && info.width && info.height) {
						let scale = 1;
						const MAX_W = PREVIEW_WIDTH, MAX_H = PREVIEW_HEIGHT;
						if (info.type === "video") isRealVideo = true;
						if (isRealVideo || isVideoExtFlag || enlargeSmallImages) scale = Math.min(MAX_W / info.width, MAX_H / info.height);
						else { if (info.width <= MAX_W && info.height <= MAX_H) scale = 1; else scale = Math.min(MAX_W / info.width, MAX_H / info.height); }
						const pct = Math.round(scale * 100);
						titleSuffix = `   (${pct}%)  ${info.width}x${info.height}`;
						if (info.codec) { tooltipText += `\n编解码器: ${info.codec}`; if (info.codec_long_name) tooltipText += ` (${info.codec_long_name})`; }
						const arStr = calculateAspectRatioString(info.width, info.height);
						if (arStr) tooltipText += `\n宽高比：${arStr}`;
						if (shouldShowDuration(info)) tooltipText += `\n⌛原始时长：${formatDuration(info.duration)}`;
					}
				}
				const iconPart = isRealVideo ? "🎬" : ""; const spacePart = isRealVideo ? " " : "   ";
				const r = new vscode.Range(targetLensLine, 0, targetLensLine, 0);
				return [
					new vscode.CodeLens(r, { title: `✎( ${fSizeStr}) 🗀qqq`, command: "qqq.revealFileInFolder", arguments: [absPath], tooltip: folderTooltip }),
					new vscode.CodeLens(r, { title: "✎rename", command: "qqq.renameFile", arguments: [rawPath, absPath] }),
					new vscode.CodeLens(r, { title: `✎( ${fileSz})${iconPart}${spacePart}${absPath}${titleSuffix}`, command: "qqq.openFile", arguments: [absPath], tooltip: tooltipText })
				];
			});
		}
		const results = await Promise.all(tasks.map(t => t()));
		results.forEach(group => lenses.push(...group));
		return lenses;
	}
}

function openFileCommand(filePath) {
	if (!fs.existsSync(filePath)) return;
	try { if (process.platform === "win32") cp.exec(`start "" "${filePath.replace(/"/g, '""')}"`); else if (process.platform === "darwin") cp.exec(`open "${filePath}"`); else cp.exec(`xdg-open "${filePath}"`); }
	catch { vscode.env.openExternal(vscode.Uri.file(filePath)); }
}

function revealFileInFolder(filePath) {
	if (!fs.existsSync(filePath)) return;
	try { if (process.platform === "win32") cp.exec(`explorer /select,"${filePath.replace(/"/g, '""')}"`); else if (process.platform === "darwin") cp.exec(`open -R "${filePath}"`); else cp.exec(`xdg-open "${path.dirname(filePath)}"`); } catch { }
}

async function renameFileCommand(rawPath, absPath) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const currentName = path.basename(absPath);
	const newName = await vscode.window.showInputBox({ title: "重命名粘贴文件", prompt: "rename  ", value: currentName, ignoreFocusOut: true, validateInput: v => (!v || !v.trim()) ? "文件名不能为空" : null });
	if (!newName || newName.trim() === currentName) return;
	const trimmed = newName.trim();
	const newAbs = path.join(path.dirname(absPath), trimmed);
	try { await fs.promises.rename(absPath, newAbs); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
	const doc = editor.document;
	const regex = new RegExp(QQQ_PATH_REGEX);
	const newRaw = buildNewRawPath(rawPath, trimmed);
	const ranges = [];
	let m;
	const txt = doc.getText();
	while ((m = regex.exec(txt))) { const matchedRaw = m[0].slice(2, -2).trim(); if (matchedRaw === rawPath) { const s = doc.positionAt(m.index); const e = doc.positionAt(m.index + m[0].length); ranges.push(new vscode.Range(s, e)); } }
	if (ranges.length) await editor.edit(b => ranges.forEach(r => b.replace(r, `/\\${newRaw}\\/`)));
	invalidateFolderSizeCacheForPath(newAbs);
	renderVisibleEditors();
}

function debounceRender(editor, delay = SCROLL_DEBOUNCE_MS) {
	clearTimeout(debounceRender.timer);
	debounceRender.timer = setTimeout(() => { if (editor && !editor.document.isClosed) renderImages(editor); }, delay);
}

function renderVisibleEditors(delay = 50) {
	const editors = vscode.window.visibleTextEditors;
	if (editors && editors.length) editors.forEach(e => debounceRender(e, delay));
}

async function activate(context) {
	extensionContext = context;
	isCoreIntegretyValid = verifySystemIntegrity();
	console.log(`[QQQ Q1] Integrity: ${isCoreIntegretyValid ? "PASSED" : "FAILED"}`);
	if (!isCoreIntegretyValid) return;
	loadWatermarkResource();
	refreshQqqConfig();
	initUserTracking(context);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("qqq")) { refreshQqqConfig(); documentDecorationsMap.clear(); renderVisibleEditors(); if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor); }
			if (e.affectsConfiguration("editor.fontSize") || e.affectsConfiguration("editor.lineHeight")) { refreshQqqConfig(); if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor); }
		}),
		vscode.commands.registerCommand("qqq.q1", executeClipboardCommand),
		vscode.commands.registerCommand("qqq.openFile", openFileCommand),
		vscode.commands.registerCommand("qqq.revealFileInFolder", revealFileInFolder),
		vscode.commands.registerCommand("qqq.renameFile", renameFileCommand),
		vscode.commands.registerCommand("qqq.setInOrder", () => { performGlobalClean(vscode.window.activeTextEditor, true); }),
		vscode.languages.registerCodeLensProvider({ scheme: "file" }, new FileCodeLensProvider()),
		vscode.workspace.onWillSaveTextDocument(e => { if (cleanFreakMode && e.document) { const edits = provideCleanlinessEdits(e.document); if (edits.length > 0) e.waitUntil(Promise.resolve(edits)); } }),
		vscode.window.onDidChangeTextEditorVisibleRanges(e => debounceRender(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(e => { if (e) debounceRender(e); }),
		vscode.window.onDidChangeWindowState(e => { if (e.focused) renderVisibleEditors(); }),
		vscode.workspace.onDidChangeTextDocument(e => { const ed = vscode.window.activeTextEditor; if (ed && e.document === ed.document) debounceRender(ed); if (e.document === ed?.document && e.contentChanges.length > 0) documentDecorationsMap.delete(e.document.uri.toString()); }),
		vscode.workspace.onDidCloseTextDocument(doc => { documentDecorationsMap.delete(doc.uri.toString()); }),
		vscode.window.onDidChangeVisibleTextEditors(editors => { renderVisibleEditors(); if (cleanFreakMode) performGlobalClean(vscode.window.activeTextEditor); }),
	);
	const editor = vscode.window.activeTextEditor;
	if (editor) renderImages(editor);
}

async function deactivate() {
	clearDecorations();
	await finishUserTracking(extensionContext);
}

module.exports = { activate, deactivate };

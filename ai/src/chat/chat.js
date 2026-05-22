/* ═══════════════════════════════════════════════════════════════
   chat.js — qqq AI 面板交互逻辑
   从 chat.html 提取，构建时由 esbuild.config.js 内联回单文件
   ═══════════════════════════════════════════════════════════════ */

const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const imageStrip = document.getElementById('image-strip');
const inputEstEl = document.getElementById('input-est');

// ━━━ E-2: 键入框实时 token 预估 + 自动高度（A-1: rAF 节流） ━━━
let _inputRafPending = false;
inputEl.addEventListener('input', () => {
    if (_inputRafPending) return;
    _inputRafPending = true;
    requestAnimationFrame(() => {
        _inputRafPending = false;
        // token 预估
        const len = inputEl.value.length;
        if (len === 0) { inputEstEl.textContent = '— tok'; inputEstEl.className = ''; }
        else {
            const hasCJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(inputEl.value);
            const est = Math.ceil(len / (hasCJK ? 1.5 : 4));
            inputEstEl.textContent = '~' + (est >= 1000 ? (est/1000).toFixed(1)+'K' : est) + ' tok';
            inputEstEl.className = est > 4000 ? 'bad' : est > 1000 ? 'warn' : '';
        }
        // 自动高度
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });
});

let isGenerating = false;
let currentAiMsg = null;
let toolCounter = 0;
let toolIndicator = null;
let _currentTurnBlock = null; // tofu 块当前 wrapper
let _turnBlockIdx = 0; // tofu 块颜色序号 0-3 循环
let totalCostGe = 0; // 窗口级费用累加

// ═══════ 整体缩放 ═══════
const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5];
let _zoomIdx = 2; // default 1.0

function _applyZoom() {
    const level = ZOOM_LEVELS[_zoomIdx];
    if (level === 1.0) {
        document.body.style.transform = '';
        document.body.style.transformOrigin = '';
        document.body.style.width = '';
        document.body.style.height = '';
    } else {
        document.body.style.transform = "scale(" + level + ")";
        document.body.style.transformOrigin = "top left";
        document.body.style.width = (100 / level).toFixed(1) + "%";
        document.body.style.height = (100 / level).toFixed(1) + "%";
    }
    const label = document.getElementById("zoom-label");
    if (label) label.textContent = Math.round(level * 100) + "%";
    try { localStorage.setItem("qqq-ai-zoom", _zoomIdx); } catch(_) {}
}

function _zoomIn() {
    if (_zoomIdx < ZOOM_LEVELS.length - 1) { _zoomIdx++; _applyZoom(); }
}

function _zoomOut() {
    if (_zoomIdx > 0) { _zoomIdx--; _applyZoom(); }
}

// init zoom
(function() {
    try {
        const saved = localStorage.getItem("qqq-ai-zoom");
        if (saved !== null) _zoomIdx = Math.min(Math.max(parseInt(saved), 0), ZOOM_LEVELS.length - 1);
    } catch(_) {}
    _applyZoom();
    document.getElementById("zoom-in").addEventListener("click", _zoomIn);
    document.getElementById("zoom-out").addEventListener("click", _zoomOut);
})();

// ═══════ 轻量 Markdown → HTML ═══════
function renderMarkdown(src) {
    // 安全转义
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // 提取代码块
    const codeBlocks = [];
    let text = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        codeBlocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
        return `\x00CB${codeBlocks.length - 1}\x00`;
    });
    // 行内代码
    text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`);
    // 按行处理
    const lines = text.split('\n');
    const out = [];
    let inList = false, listType = '';
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        // 代码块占位符
        if (/^\x00CB(\d+)\x00$/.test(line)) {
            if (inList) { out.push(`</${listType}>`); inList = false; }
            out.push(codeBlocks[+RegExp.$1]);
            continue;
        }
        // 标题
        const hm = line.match(/^(#{1,3})\s+(.+)/);
        if (hm) {
            if (inList) { out.push(`</${listType}>`); inList = false; }
            const lv = hm[1].length;
            out.push(`<h${lv}>${inline(hm[2])}</h${lv}>`);
            continue;
        }
        // 分割线
        if (/^---+$/.test(line.trim())) { if (inList) { out.push(`</${listType}>`); inList = false; } out.push('<hr>'); continue; }
        // 无序列表
        const ulm = line.match(/^\s*[-*+]\s+(.+)/);
        if (ulm) { if (!inList || listType !== 'ul') { if (inList) out.push(`</${listType}>`); out.push('<ul>'); inList = true; listType = 'ul'; } out.push(`<li>${inline(ulm[1])}</li>`); continue; }
        // 有序列表
        const olm = line.match(/^\s*\d+\.\s+(.+)/);
        if (olm) { if (!inList || listType !== 'ol') { if (inList) out.push(`</${listType}>`); out.push('<ol>'); inList = true; listType = 'ol'; } out.push(`<li>${inline(olm[1])}</li>`); continue; }
        // 引用
        const bq = line.match(/^>\s?(.*)/);
        if (bq) { if (inList) { out.push(`</${listType}>`); inList = false; } out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }
        // 空行 / 普通段落
        if (inList) { out.push(`</${listType}>`); inList = false; }
        if (line.trim() === '') { out.push(''); continue; }
        out.push(`<p>${inline(line)}</p>`);
    }
    if (inList) out.push(`</${listType}>`);
    return out.join('\n');
}
function inline(s) {
    // 安全转义（保留已有 html 标签）
    s = s.replace(/&(?!amp;|lt;|gt;)/g, '&amp;').replace(/<(?!\/?(code|strong|em)>)/g, '&lt;');
    // 加粗
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // 斜体
    s = s.replace(/(?<![*])\*([^*]+)\*(?![*])/g, '<em>$1</em>');
    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    return s;
}

// ═══════ 左侧 ge 进度条 ═══════
const geBarFill = document.getElementById('ge-bar-fill');
const geBarTrack = document.getElementById('ge-bar-track');
function updateGeBar() {
    // 非动画状态时，显示小数部分作为进度（0→1 ge 循环）
    if (!geBarFill.classList.contains('animating')) {
        const frac = totalCostGe % 1;
        // 有消耗时至少显示 5% 确保可见
        const h = totalCostGe > 0 ? Math.max(5, frac * 100) : 0;
        geBarFill.style.height = h + '%';
    }
    geBarTrack.setAttribute('data-tip', totalCostGe.toFixed(4) + ' ge');
}
function startGeBarAnimation() {
    geBarFill.classList.add('animating');
}
function stopGeBarAnimation() {
    geBarFill.classList.remove('animating');
    updateGeBar();
}

// 底边血条 hover 显示 tooltip
const ctxHit = document.getElementById('ctx-bar-hit');
const ctxTooltip = document.getElementById('ctx-bar-tooltip');
ctxHit.addEventListener('mouseenter', () => { ctxTooltip.style.display = 'block'; });
ctxHit.addEventListener('mouseleave', () => { ctxTooltip.style.display = 'none'; });
ctxHit.addEventListener('mousemove', (e) => {
    ctxTooltip.style.left = e.clientX + 'px';
});

// ═══════ 怒气值 K线图 ═══════
const rageHistory = []; // [{value, time}]
const rageCanvas = document.getElementById('rage-chart');
const rageCtx = rageCanvas.getContext('2d');
const MAX_RAGE_POINTS = 50;

function drawRageChart() {
    const dpr = window.devicePixelRatio || 1;
    const w = rageCanvas.width = rageCanvas.offsetWidth * dpr;
    const h = rageCanvas.height = 42 * dpr;
    const padY = 4 * dpr;
    const usableH = h - padY * 2;
    rageCtx.clearRect(0, 0, w, h);
    if (rageHistory.length === 0) {
        const midY = h / 2;
        rageCtx.strokeStyle = 'rgba(255,255,255,0.12)';
        rageCtx.lineWidth = 1 * dpr;
        rageCtx.setLineDash([6 * dpr, 4 * dpr]);
        rageCtx.beginPath();
        rageCtx.moveTo(4 * dpr, midY);
        rageCtx.lineTo(w - 4 * dpr, midY);
        rageCtx.stroke();
        rageCtx.setLineDash([]);
        rageCtx.fillStyle = 'rgba(255,255,255,0.25)';
        rageCtx.font = (10 * dpr) + 'px system-ui';
        rageCtx.textAlign = 'center';
        rageCtx.fillText('等待数据...', w / 2, midY - 6 * dpr);
        return;
    }
    if (rageHistory.length === 1) {
        const x = w / 2;
        const y = padY + usableH * (1 - rageHistory[0].value / 100);
        rageCtx.beginPath();
        rageCtx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
        rageCtx.fillStyle = '#f14c4c';
        rageCtx.fill();
        rageCtx.fillStyle = 'rgba(255,255,255,0.25)';
        rageCtx.font = (9 * dpr) + 'px system-ui';
        rageCtx.textAlign = 'center';
        rageCtx.fillText('首个数据点，等待更多...', w / 2, y - 10 * dpr);
        return;
    }

    const startIdx = Math.max(0, rageHistory.length - MAX_RAGE_POINTS);
    const points = rageHistory.slice(startIdx);
    const step = w / (points.length - 1 || 1);

    // 填充区域
    rageCtx.beginPath();
    rageCtx.moveTo(0, h);
    points.forEach((p, i) => {
        const x = i * step;
        const y = padY + usableH * (1 - p.value / 100);
        if (i === 0) rageCtx.lineTo(x, y);
        else rageCtx.lineTo(x, y);
    });
    rageCtx.lineTo((points.length - 1) * step, h);
    rageCtx.closePath();
    rageCtx.fillStyle = 'rgba(241, 76, 76, 0.15)';
    rageCtx.fill();

    // 折线
    rageCtx.beginPath();
    points.forEach((p, i) => {
        const x = i * step;
        const y = padY + usableH * (1 - p.value / 100);
        if (i === 0) rageCtx.moveTo(x, y);
        else rageCtx.lineTo(x, y);
    });
    rageCtx.strokeStyle = '#f14c4c';
    rageCtx.lineWidth = 1.5 * dpr;
    rageCtx.stroke();

    // 最后一个点的值标注
    const last = points[points.length - 1];
    const lx = (points.length - 1) * step;
    const ly = padY + usableH * (1 - last.value / 100);
    rageCtx.beginPath();
    rageCtx.arc(lx, ly, 3 * dpr, 0, Math.PI * 2);
    rageCtx.fillStyle = last.value >= 75 ? '#f14c4c' : last.value >= 50 ? '#cca700' : '#4ec9b0';
    rageCtx.fill();
}

// ═══════ 多图管理 ═══════
let pendingImages = []; // [{id, base64, dataUrl}]
const MAX_IMAGES = 20;

function addImage(dataUrl, base64) {
    if (pendingImages.length >= MAX_IMAGES) return;
    const id = pendingImages.length + 1;
    pendingImages.push({ id, base64, dataUrl });
    renderImageStrip();
}

function removeImage(idx) {
    pendingImages.splice(idx, 1);
    // 重新编号
    pendingImages.forEach((img, i) => { img.id = i + 1; });
    renderImageStrip();
}

function renderImageStrip() {
    imageStrip.innerHTML = '';
    if (pendingImages.length === 0) {
        imageStrip.style.display = 'none';
        return;
    }
    imageStrip.style.display = 'flex';
    pendingImages.forEach((img, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'img-thumb-wrap';

        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        wrap.appendChild(imgEl);

        const num = document.createElement('span');
        num.className = 'img-thumb-num';
        num.textContent = '#' + img.id;
        num.onclick = (e) => { e.stopPropagation(); openLightbox(img.dataUrl, img.base64); };
        wrap.appendChild(num);

        const del = document.createElement('button');
        del.className = 'img-thumb-del';
        del.textContent = '\u00d7';
        del.onclick = () => removeImage(idx);
        wrap.appendChild(del);

        const embed = document.createElement('button');
        embed.className = 'img-thumb-embed';
        embed.textContent = '\u5d4c\u5165';
        embed.onclick = () => {
            const marker = `[\u56fe#${img.id}]`;
            inputEl.value += marker;
            inputEl.focus();
        };
        wrap.appendChild(embed);

        imageStrip.appendChild(wrap);
    });
}

// 粘贴图片（> 1MB 自动压缩到 1280px 宽度）
inputEl.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataUrl = ev.target.result;
                // 压缩大图片：> 2MB 时缩到 2048px 宽
                if (file.size > 2 * 1024 * 1024) {
                    const img = new Image();
                    img.onload = () => {
                        const MAX_W = 2048;
                        const scale = img.width > MAX_W ? MAX_W / img.width : 1;
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.round(img.width * scale);
                        canvas.height = Math.round(img.height * scale);
                        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                        const compressed = canvas.toDataURL('image/jpeg', 0.85);
                        addImage(compressed, compressed.split(',')[1]);
                    };
                    img.src = dataUrl;
                } else {
                    addImage(dataUrl, dataUrl.split(',')[1]);
                }
            };
            reader.readAsDataURL(file);
            break;
        }
    }
});

// ═══════ 发送消息 ═══════
function send() {
    const text = inputEl.value.trim();
    if ((!text && pendingImages.length === 0) || isGenerating) return;

    const displayText = text || '\ud83d\uddbc\ufe0f [\u56fe\u7247]';
    const msgEl = appendMessage('doer', displayText);

    // 在用户消息中显示缩略图（带可点击角标）
    if (pendingImages.length > 0) {
        const imgRow = document.createElement('div');
        imgRow.style.cssText = 'margin-top:6px;';
        pendingImages.forEach(img => {
            const wrap = document.createElement('span');
            wrap.className = 'msg-img-wrap';
            const imgEl = document.createElement('img');
            imgEl.src = img.dataUrl;
            imgEl.dataset.base64 = img.base64;
            wrap.appendChild(imgEl);
            const badge = document.createElement('span');
            badge.className = 'msg-img-badge';
            badge.textContent = '#' + img.id;
            badge.onclick = () => openLightbox(img.dataUrl, img.base64);
            wrap.appendChild(badge);
            imgRow.appendChild(wrap);
        });
        msgEl.appendChild(imgRow);
    }

    // 构建消息数据
    const images = pendingImages.map(img => ({ id: img.id, base64: img.base64 }));
    vscode.postMessage({ type: 'send', text: text || '', images: images.length > 0 ? images : null });

    // 重置
    inputEl.value = '';
    inputEl.style.height = 'auto';
    pendingImages = [];
    renderImageStrip();
}

sendBtn.addEventListener('click', () => {
    if (isGenerating) {
        // 停止生成
        vscode.postMessage({ type: 'abort' });
        isGenerating = false;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        sendBtn.classList.remove('stop-mode');
        stopGeBarAnimation();
        appendMessage('error', '⬛ 已手动停止');
    } else {
        send();
    }
});
inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
    }
});

// A-1: 自动高度已合并到上方 rAF 节流 input listener

// ═══════ 字符级 Undo/Redo（从 q2 Roam 移植） ═══════
(function initCharUndo(input) {
    const state = { history: [input.value || ''], index: 0, lastValue: input.value || '', isProgrammatic: false };
    input.addEventListener('input', () => {
        if (state.isProgrammatic) { state.isProgrammatic = false; return; }
        const v = input.value;
        if (state.index < state.history.length - 1) state.history = state.history.slice(0, state.index + 1);
        if (v !== state.lastValue) { state.history.push(v); state.index = state.history.length - 1; state.lastValue = v; }
    });
    input.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault(); e.stopPropagation();
            if (state.index > 0) { state.index--; state.isProgrammatic = true; input.value = state.history[state.index]; state.lastValue = input.value; input.dispatchEvent(new Event('input', { bubbles: true })); }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
            e.preventDefault(); e.stopPropagation();
            if (state.index < state.history.length - 1) { state.index++; state.isProgrammatic = true; input.value = state.history[state.index]; state.lastValue = input.value; input.dispatchEvent(new Event('input', { bubbles: true })); }
            return;
        }
    });
})(inputEl);

// ═══════ Lightbox（缩放 / 拖拽 / 双击重置） ═══════
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lbZoomLabel = document.getElementById('lightbox-zoom');
let lightboxBase64 = null;
let lbScale = 1, lbX = 0, lbY = 0; // transform 状态
let lbNatW = 0, lbNatH = 0; // 自然尺寸
let lbDrag = false, lbDragStartX = 0, lbDragStartY = 0, lbDragOriginX = 0, lbDragOriginY = 0;

function lbApply() {
    lightboxImg.style.transform = `translate(${lbX}px,${lbY}px) scale(${lbScale})`;
    lbZoomLabel.textContent = Math.round(lbScale * 100) + '%';
}

function lbFitCenter() {
    const vw = lightbox.clientWidth, vh = lightbox.clientHeight;
    const pad = 40;
    const fitScale = Math.min((vw - pad * 2) / lbNatW, (vh - pad * 2) / lbNatH, 1);
    lbScale = fitScale;
    lbX = (vw - lbNatW * lbScale) / 2;
    lbY = (vh - lbNatH * lbScale) / 2;
    lbApply();
}

function openLightbox(src, base64) {
    lightboxBase64 = base64 || src.split(',')[1] || null;
    lightboxImg.onload = () => {
        lbNatW = lightboxImg.naturalWidth;
        lbNatH = lightboxImg.naturalHeight;
        lightboxImg.style.width = lbNatW + 'px';
        lightboxImg.style.height = lbNatH + 'px';
        lbFitCenter();
    };
    lightboxImg.src = src;
    lightbox.classList.add('active');
}

function closeLightbox() {
    lightbox.classList.remove('active');
    lightbox.classList.remove('dragging');
    lightboxBase64 = null;
    lbDrag = false;
}

// 滚轮缩放（以鼠标指针为中心）
lightbox.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.min(Math.max(lbScale * factor, 0.05), 30);
    // 鼠标相对于 lightbox 容器的坐标
    const mx = e.clientX, my = e.clientY;
    // 以鼠标位置为锚点缩放
    lbX = mx - (mx - lbX) * (newScale / lbScale);
    lbY = my - (my - lbY) * (newScale / lbScale);
    lbScale = newScale;
    lbApply();
}, { passive: false });

// 拖拽平移
let lbDidDrag = false;
lightbox.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    lbDrag = true;
    lbDidDrag = false;
    lbDragStartX = e.clientX; lbDragStartY = e.clientY;
    lbDragOriginX = lbX; lbDragOriginY = lbY;
    lightbox.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
    if (!lbDrag) return;
    lbX = lbDragOriginX + (e.clientX - lbDragStartX);
    lbY = lbDragOriginY + (e.clientY - lbDragStartY);
    if (Math.abs(e.clientX - lbDragStartX) > 3 || Math.abs(e.clientY - lbDragStartY) > 3) lbDidDrag = true;
    lbApply();
});
window.addEventListener('mouseup', () => {
    if (lbDrag) { lbDrag = false; lightbox.classList.remove('dragging'); }
});

// 双击重置居中
lightboxImg.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    lbFitCenter();
});

// 点击空白处关闭（拖拽后不关闭）
lightbox.addEventListener('click', (e) => {
    if (lbDidDrag) { lbDidDrag = false; return; }
    if (e.target === lightbox) closeLightbox();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
});

document.getElementById('lb-download').addEventListener('click', () => {
    if (lightboxBase64) vscode.postMessage({ type: 'downloadImage', base64: lightboxBase64 });
});
document.getElementById('lb-copy').addEventListener('click', () => {
    if (lightboxBase64) vscode.postMessage({ type: 'copyImage', base64: lightboxBase64 });
});

// ═══════ 接收来自扩展的消息 ═══════
window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'start':
            isGenerating = true;
            sendBtn.disabled = false;
            sendBtn.textContent = '■ Stop';
            sendBtn.classList.add('stop-mode');
            toolCounter = 0;
            toolIndicator = null;
            currentAiMsg = appendMessage('ai', '');
            startGeBarAnimation();
            break;

        case 'token':
            if (currentAiMsg) {
                currentAiMsg._rawText = (currentAiMsg._rawText || '') + msg.content;
                currentAiMsg.innerHTML = renderMarkdown(currentAiMsg._rawText);
                scrollToBottom();
            }
            break;

        case 'tool':
            toolCounter++;
            if (!toolIndicator) {
                toolIndicator = document.createElement('div');
                toolIndicator.className = 'msg msg-tool';
                if (_currentTurnBlock) { _currentTurnBlock.appendChild(toolIndicator); }
                else { messagesEl.appendChild(toolIndicator); }
            }
            {
                const toolIcon = { read_file: '📄', search_text: '🔍', list_files: '📂', run_command: '▶', edit_file: '✏️', create_file: '📝', analyze_image: '🖼️', lsp_definitions: '🔗', lsp_references: '🔗', fetch_webpage: '🌐' };
                const ic = toolIcon[msg.name] || '⚙';
                toolIndicator.textContent = ic + ' ' + msg.name + (toolCounter > 1 ? ' (第' + toolCounter + '次调用)' : '');
            }
            scrollToBottom();
            break;

        case 'toolResult':
            {
                const tSummary = _toolSummary(msg.toolName, msg.output);
                const details = document.createElement('details');
                details.className = 'msg-tool-details';
                const sumEl = document.createElement('summary');
                sumEl.textContent = tSummary;
                details.appendChild(sumEl);
                const pre = document.createElement('pre');
                pre.textContent = (msg.output || '').slice(0, 2000);
                details.appendChild(pre);
                if (_currentTurnBlock) { _currentTurnBlock.appendChild(details); }
                else { messagesEl.appendChild(details); }
                scrollToBottom();
            }
            break;

        case 'done':
            isGenerating = false;
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
            sendBtn.classList.remove('stop-mode');
            stopGeBarAnimation();
            if (currentAiMsg && currentAiMsg._rawText) { currentAiMsg.innerHTML = renderMarkdown(currentAiMsg._rawText); }
            currentAiMsg = null;
            break;

        case 'cost':
            {
                const costEl = document.createElement('div');
                costEl.className = 'msg-cost';
                if (msg.estimate === 'free') {
                    costEl.textContent = '\u514d\u8d39\u65f6\u6bb5 \u2728';
                } else {
                    costEl.textContent = '\u672c\u8f6e\u6d88\u8017: ' + msg.estimate + ' ge';
                    const val = parseFloat(msg.estimate) || 0;
                    totalCostGe += val;
                    document.getElementById('cost-label').textContent = totalCostGe < 0.01 ? totalCostGe.toFixed(4) + ' ge' : totalCostGe.toFixed(2) + ' ge';
                    updateGeBar();
                }
                if (_currentTurnBlock) { _currentTurnBlock.appendChild(costEl); }
                else { messagesEl.appendChild(costEl); }
                scrollToBottom();
            }
            break;

        case 'error':
            appendMessage('error', msg.message);
            isGenerating = false;
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
            sendBtn.classList.remove('stop-mode');
            stopGeBarAnimation();
            currentAiMsg = null;
            break;

        case 'cleared':
            messagesEl.innerHTML = '';
            _currentTurnBlock = null;
            totalCostGe = 0;
            document.getElementById('cost-label').textContent = '0 ge';
            updateGeBar();
            break;

        case 'sessionList': _renderTabs(msg.sessions, msg.activeId); break;
        case 'restoreDoer': appendMessage('doer', msg.content); break;
        case 'restoreAssistant':
            { const el = appendMessage('ai', ''); el.innerHTML = renderMarkdown(msg.content); }
            break;

        case 'rage':
            document.getElementById('rage-fill').style.width = msg.value + '%';
            document.getElementById('rage-label').textContent = '\ud83d\udd25 ' + msg.value;
            break;

        case 'rageDot':
            document.getElementById('rage-fill').style.width = msg.rage + '%';
            document.getElementById('rage-label').textContent = '\ud83d\udd25 ' + msg.rage;
            rageHistory.push({ value: msg.rage, time: Date.now() });
            if (rageHistory.length > MAX_RAGE_POINTS * 2) rageHistory.splice(0, rageHistory.length - MAX_RAGE_POINTS);
            drawRageChart();
            break;

        case 'hp':
            {
                const ctxBar = document.getElementById('ctx-bar');
                const w = msg.percent > 0 ? Math.max(3, msg.percent) : 0;
                ctxBar.style.width = w + '%';
                document.getElementById('ctx-bar-tooltip').textContent = msg.percent + '% (~' + Math.round(msg.tokens / 1000) + 'K tokens)';
                const s = getComputedStyle(document.documentElement);
                if (msg.percent > 80) ctxBar.style.background = s.getPropertyValue('--red').trim();
                else if (msg.percent > 50) ctxBar.style.background = s.getPropertyValue('--yellow').trim();
                else ctxBar.style.background = s.getPropertyValue('--green').trim();
            }
            break;

        case 'confirm':
            {
                const box = document.createElement('div');
                box.className = 'msg msg-confirm';
                box.style.cssText = 'border:1px solid var(--border-color);border-radius:4px;padding:8px;margin:4px 0;';
                const label = document.createElement('div');
                label.textContent = msg.message;
                label.style.cssText = 'margin-bottom:6px;font-size:12px;';
                box.appendChild(label);
                const btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;gap:6px;';
                for (const action of msg.actions) {
                    const btn = document.createElement('button');
                    btn.textContent = action;
                    btn.style.cssText = 'padding:3px 10px;font-size:11px;cursor:pointer;border:1px solid var(--border-color);border-radius:3px;background:var(--card-bg);color:var(--text-primary);';
                    btn.onclick = () => { vscode.postMessage({ type: 'confirmResponse', id: msg.id, action }); box.remove(); };
                    btnRow.appendChild(btn);
                }
                box.appendChild(btnRow);
                messagesEl.appendChild(box);
                scrollToBottom();
            }
            break;

        case 'planDraft':
            {
                const planEl = document.createElement('div');
                planEl.className = 'msg plan-card';
                planEl.id = 'plan-' + msg.plan.id;
                planEl.innerHTML = '<div class="plan-header"><span class="plan-icon">📋</span><span class="plan-title">' + msg.plan.title + '</span><span class="plan-badge">DRAFT</span></div>'
                    + '<div class="plan-overview">' + msg.plan.overview + '</div>'
                    + '<div class="plan-tasks">' + msg.plan.tasks.map(t => '<div class="plan-task" data-id="' + t.id + '" data-status="pending"><span class="task-icon">○</span><span class="task-content">' + t.content + '</span></div>').join('') + '</div>'
                    + '<div class="plan-actions"><button class="plan-btn plan-btn-exec" onclick="vscode.postMessage({type:\'planExecute\',planId:\'' + msg.plan.id + '\'})">▉ 执行计划</button><button class="plan-btn plan-btn-cancel" onclick="this.closest(\'.plan-card\').remove()">取消</button></div>'
                    + '<div class="plan-hint" style="font-size:11px;color:var(--base00);margin-top:6px;padding:4px 8px;border-top:1px solid var(--border-color);">💬 继续对话即可修改计划</div>';
                messagesEl.appendChild(planEl);
                scrollToBottom();
            }
            break;

        case 'planRevising':
            {
                const card = document.getElementById('plan-' + msg.planId);
                if (card) {
                    const badge = card.querySelector('.plan-badge');
                    if (badge) { badge.textContent = 'REVISING...'; badge.style.color = '#f0a020'; }
                    const hint = card.querySelector('.plan-hint');
                    if (hint) hint.textContent = '⚙️ 正在根据你的反馈修订计划...';
                }
            }
            break;

        case 'planExecuting':
            {
                const card = document.getElementById('plan-' + msg.planId);
                if (card) {
                    const badge = card.querySelector('.plan-badge');
                    if (badge) { badge.textContent = 'EXECUTING'; badge.className = 'plan-badge executing'; }
                    const actions = card.querySelector('.plan-actions');
                    if (actions) actions.innerHTML = '<button class="plan-btn plan-btn-abort" onclick="vscode.postMessage({type:\'planAbort\'})">⏸ 暂停</button>';
                }
            }
            break;

        case 'planTaskStart':
            {
                const taskEls = document.querySelectorAll('.plan-task[data-id="' + msg.taskId + '"]');
                taskEls.forEach(el => { el.dataset.status = 'in_progress'; el.querySelector('.task-icon').textContent = '\u25d4'; el.classList.add('task-active'); });
                const progressMsg = document.createElement('div');
                progressMsg.className = 'msg msg-plan-progress';
                progressMsg.textContent = '\u25b6 Task ' + (msg.order + 1) + ': ' + msg.content;
                messagesEl.appendChild(progressMsg);
                scrollToBottom();
            }
            break;

        case 'planTaskComplete':
            {
                const taskEls = document.querySelectorAll('.plan-task[data-id="' + msg.taskId + '"]');
                taskEls.forEach(el => { el.dataset.status = 'complete'; el.querySelector('.task-icon').textContent = '\u2713'; el.classList.remove('task-active'); el.classList.add('task-done'); });
            }
            break;

        case 'planTaskFail':
            {
                const taskEls = document.querySelectorAll('.plan-task[data-id="' + msg.taskId + '"]');
                taskEls.forEach(el => { el.dataset.status = 'failed'; el.querySelector('.task-icon').textContent = '\u2717'; el.classList.remove('task-active'); el.classList.add('task-failed'); });
            }
            break;

        case 'planProgress':
            { const pb = document.querySelector('.plan-progress-bar'); if (pb) { pb.style.width = msg.percent + '%'; pb.textContent = msg.complete + '/' + msg.total; } }
            break;

        case 'planComplete':
            {
                const card = document.getElementById('plan-' + msg.planId);
                if (card) {
                    const badge = card.querySelector('.plan-badge');
                    if (badge) { badge.textContent = 'COMPLETE \u2713'; badge.className = 'plan-badge complete'; }
                    const actions = card.querySelector('.plan-actions');
                    if (actions) actions.innerHTML = '<span class="plan-done-text">\u2728 全部完成</span>';
                }
                appendMessage('ai', '✅ 计划「' + msg.title + '」已全部执行完成。');
            }
            break;

        case 'planFail':
            {
                const card = document.getElementById('plan-' + msg.planId);
                if (card) {
                    const badge = card.querySelector('.plan-badge');
                    if (badge) { badge.textContent = 'FAILED'; badge.className = 'plan-badge failed'; }
                    const actions = card.querySelector('.plan-actions');
                    if (actions) actions.innerHTML = '<button class="plan-btn plan-btn-exec" onclick="vscode.postMessage({type:\'planResume\',planId:\'' + msg.planId + '\'})">\u25b6 继续</button><button class="plan-btn plan-btn-rollback" onclick="_showRollbackPicker(\'' + msg.planId + '\')">↩ 回滚</button>';
                }
            }
            break;

        case 'planPaused':
            appendMessage('ai', '⏸ 计划已暂停。发送任何消息继续，或点击回滚撤销上一步。');
            break;

        case 'planRevised':
            {
                const card = document.getElementById('plan-' + msg.planId);
                if (msg.action === 'revise' && msg.plan && card) {
                    const badge = card.querySelector('.plan-badge');
                    if (badge) { badge.textContent = 'DRAFT'; badge.style.color = ''; badge.className = 'plan-badge'; }
                    const titleEl = card.querySelector('.plan-title');
                    if (titleEl) titleEl.textContent = msg.plan.title;
                    const overviewEl = card.querySelector('.plan-overview');
                    if (overviewEl) overviewEl.textContent = msg.plan.overview;
                    const taskList = card.querySelector('.plan-tasks');
                    if (taskList) { taskList.innerHTML = msg.plan.tasks.map(t => '<div class="plan-task" data-id="' + t.id + '" data-status="pending"><span class="task-icon">○</span><span class="task-content">' + t.content + '</span></div>').join(''); }
                    const hint = card.querySelector('.plan-hint');
                    if (hint) hint.textContent = '💬 继续对话即可修改计划';
                } else if (card) {
                    const actionText = msg.action === 'retry' ? '🔄 正在重试失败步骤' : '📝 计划已自动修订';
                    appendMessage('ai', actionText + '：' + msg.analysis);
                    if (msg.tasks) {
                        const taskList = card.querySelector('.plan-tasks');
                        if (taskList) { taskList.innerHTML = msg.tasks.map(t => { const ic = t.status === 'complete' ? '✓' : t.status === 'failed' ? '✗' : '○'; const cl = t.status === 'complete' ? 'complete' : t.status === 'failed' ? 'failed' : ''; return '<div class="plan-task ' + cl + '"><span class="plan-task-icon">' + ic + '</span>' + t.content + '</div>'; }).join(''); }
                        const badge = card.querySelector('.plan-badge');
                        if (badge) { badge.textContent = 'EXECUTING'; badge.className = 'plan-badge executing'; }
                    }
                }
            }
            break;

        case 'metrics': _updateMetrics(msg.metrics); break;

        case 'planRolledBack':
            appendMessage('ai', '↩ 已回滚到 checkpoint (' + (msg.ref ? msg.ref.slice(0,8) : 'unknown') + ')。代码已恢复，可重新执行。');
            break;

        case 'planUpdate':
            {
                const card = document.getElementById('plan-' + msg.plan.id);
                if (card) {
                    const badge = card.querySelector('.plan-badge');
                    if (badge) badge.textContent = msg.plan.status.toUpperCase();
                    msg.plan.tasks.forEach(t => {
                        const el = card.querySelector('.plan-task[data-id="' + t.id + '"]');
                        if (el) { el.dataset.status = t.status; el.querySelector('.task-icon').textContent = t.status === 'complete' ? '\u2713' : t.status === 'failed' ? '\u2717' : '\u25cb'; el.className = 'plan-task' + (t.status === 'complete' ? ' task-done' : t.status === 'failed' ? ' task-failed' : ''); }
                    });
                }
            }
            break;

        case 'setTheme':
            document.documentElement.setAttribute('data-theme', msg.theme);
            break;
    }
});

// ━━ 主题初始化 ━━
(function() {
    if (document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast')) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
})();

function appendMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'msg msg-' + role;
    el.textContent = text;
    if (role === 'doer') {
        _currentTurnBlock = document.createElement('div');
        _currentTurnBlock.className = 'turn-block tb-c' + (_turnBlockIdx % 4);
        _turnBlockIdx++;
        _currentTurnBlock.appendChild(el);
        messagesEl.appendChild(_currentTurnBlock);
    } else {
        if (_currentTurnBlock) { _currentTurnBlock.appendChild(el); }
        else { messagesEl.appendChild(el); }
    }
    if (messagesEl.children.length > 200) { for (let i = 0; i < 50; i++) messagesEl.removeChild(messagesEl.firstChild); }
    scrollToBottom();
    return el;
}

function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function _showRollbackPicker(planId) {
    const card = document.getElementById('plan-' + planId);
    if (!card) return;
    const doneTasks = card.querySelectorAll('.plan-task[data-status="complete"]');
    if (doneTasks.length === 0) { appendMessage('ai', '没有可回滚的 checkpoint。'); return; }
    vscode.postMessage({ type: 'planRollback', planId, taskId: doneTasks[doneTasks.length - 1].dataset.id });
}

function _renderTabs(sessions, activeId) {
    const bar = document.getElementById('tab-bar');
    bar.innerHTML = '';
    sessions.forEach(s => {
        const tab = document.createElement('span');
        tab.className = 'tab-item' + (s.id === activeId ? ' active' : '');
        tab.textContent = s.title || '新对话';
        tab.title = s.title || '新对话';
        tab.onclick = () => vscode.postMessage({ type: 'switchTab', id: s.id });
        const close = document.createElement('span');
        close.className = 'tab-close';
        close.textContent = '\u00d7';
        close.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'closeTab', id: s.id }); };
        tab.appendChild(close);
        bar.appendChild(tab);
    });
    const newBtn = document.createElement('span');
    newBtn.id = 'tab-new';
    newBtn.textContent = '+';
    newBtn.title = '新建会话';
    newBtn.onclick = () => vscode.postMessage({ type: 'newTab' });
    bar.appendChild(newBtn);
}

function _updateMetrics(m) {
    const t = m.turn, s = m.session, e = m.engine;
    const fk = (n) => n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n);
    const fg = (n) => n <= 0 ? '0' : n < 0.001 ? '<0.001' : n < 0.01 ? n.toFixed(4) : n.toFixed(3);
    _mv('mv-in', fk(t.promptTokens));
    _mv('mv-out', fk(t.completionTokens));
    _mv('mv-think', fk(t.reasoningTokens));
    const total = t.cacheHitTokens + t.cacheMissTokens;
    const hitRate = total > 0 ? Math.round(t.cacheHitTokens / total * 100) : 0;
    const cacheEl = _mv('mv-cache', hitRate + '%');
    if (cacheEl) cacheEl.className = 'mc-v' + (hitRate >= 60 ? ' mc-hi' : hitRate >= 20 ? ' mc-warn' : total > 0 ? ' mc-bad' : '');
    _mv('mv-hit', fk(t.cacheHitTokens)); _mv('mv-miss', fk(t.cacheMissTokens));
    _mv('mv-cost', fg(t.costGe)); _mv('mv-tier', t.tier); _mv('mv-tools', String(t.toolCount));
    _mv('mv-time', t.durationMs >= 60000 ? (t.durationMs/60000).toFixed(1)+'m' : t.durationMs >= 1000 ? (t.durationMs/1000).toFixed(1)+'s' : t.durationMs+'ms');
    _mv('mv-tps', t.tokPerSec > 0 ? t.tokPerSec : '—');
    _mv('mv-save', t.cnySaved > 0 ? '¥' + (t.cnySaved < 0.001 ? '<0.001' : t.cnySaved < 0.01 ? t.cnySaved.toFixed(4) : t.cnySaved.toFixed(3)) : '—');
    const retryEl = _mv('mv-retry', t.retries > 0 ? String(t.retries) : '0');
    if (retryEl) retryEl.className = 'mc-v' + (t.retries >= 3 ? ' mc-bad' : t.retries >= 1 ? ' mc-warn' : '');
    _mv('mv-tavg', t.toolAvgMs > 0 ? (t.toolAvgMs >= 1000 ? (t.toolAvgMs/1000).toFixed(1)+'s' : t.toolAvgMs+'ms') : '—');
    const ttftEl = _mv('mv-ttft', t.ttftMs > 0 ? (t.ttftMs >= 1000 ? (t.ttftMs/1000).toFixed(1)+'s' : t.ttftMs+'ms') : '—');
    if (ttftEl) ttftEl.className = 'mc-v' + (t.ttftMs > 3000 ? ' mc-bad' : t.ttftMs > 1500 ? ' mc-warn' : t.ttftMs > 0 ? ' mc-hi' : '');
    _mv('mv-free', t.freeWindow ? '\u2728' : '\u2014');
    _mv('mv-sin', fk(s.promptTokens)); _mv('mv-sout', fk(s.completionTokens));
    _mv('mv-scache', fk(s.cacheHitTokens)); _mv('mv-smiss', fk(s.cacheMissTokens));
    _mv('mv-scost', fg(s.costGe)); _mv('mv-turns', String(s.turns));
    _mv('mv-sretry', String(s.retries || 0));
    _mv('mv-ssave', s.cnySaved > 0 ? '¥' + (s.cnySaved < 0.001 ? '<0.001' : s.cnySaved < 0.01 ? s.cnySaved.toFixed(4) : s.cnySaved.toFixed(3)) : '—');
    const avgTps = s.totalDurationMs > 0 ? Math.round(s.completionTokens / s.totalDurationMs * 1000) : 0;
    _mv('mv-savgtps', avgTps > 0 ? avgTps : '—');
    const avgSave = s.turns > 0 ? s.cnySaved / s.turns : 0;
    _mv('mv-savgsave', avgSave > 0 ? '¥' + (avgSave < 0.001 ? '<0.001' : avgSave < 0.01 ? avgSave.toFixed(4) : avgSave.toFixed(3)) : '—');
    const avgRet = s.turns > 0 ? (s.retries / s.turns) : 0;
    const avgRetEl = _mv('mv-savgretry', s.turns > 0 ? avgRet.toFixed(2) : '—');
    if (avgRetEl) avgRetEl.className = 'mc-v' + (avgRet > 0.5 ? ' mc-bad' : avgRet > 0.1 ? ' mc-warn' : avgRet > 0 ? '' : '');
    _mv('mv-facts', String(e.factsCount)); _mv('mv-narr', fk(e.narrativeLen));
    const ctxEl = _mv('mv-ctx', e.ctxPct + '%');
    if (ctxEl) ctxEl.className = 'mc-v' + (e.ctxPct > 80 ? ' mc-bad' : e.ctxPct > 50 ? ' mc-warn' : e.ctxPct > 0 ? ' mc-hi' : '');
    const warmEl = _mv('mv-warm', e.warmupStatus === 'ok' ? '✅' : e.warmupStatus === 'fail' ? '❌' : e.warmupStatus === 'pending' ? '⏳' : '—');
    if (warmEl) warmEl.className = 'mc-v' + (e.warmupStatus === 'ok' ? ' mc-hi' : e.warmupStatus === 'fail' ? ' mc-bad' : e.warmupStatus === 'pending' ? ' mc-warn' : '');
    _lastCallTs = e.lastCallTs || 0; _renderLastCall();
    const L = m.lifetime;
    if (L) {
        _mv('mv-lturns', String(L.turns || 0)); _mv('mv-lsess', String(L.sessions || 0));
        _mv('mv-lcost', fg(L.costGe || 0));
        _mv('mv-lsave', L.cnySaved > 0 ? '¥' + (L.cnySaved < 0.001 ? '<0.001' : L.cnySaved < 0.01 ? L.cnySaved.toFixed(4) : L.cnySaved.toFixed(3)) : '—');
        _mv('mv-lin', fk(L.promptTokens || 0)); _mv('mv-lout', fk(L.completionTokens || 0));
        _mv('mv-lret', String(L.retries || 0));
        const totalMin = Math.round((L.durationMs || 0) / 60000);
        _mv('mv-ldur', totalMin < 60 ? totalMin + 'm' : (totalMin / 60).toFixed(1) + 'h');
    }
}
let _lastCallTs = 0;
function _renderLastCall() {
    const el = document.getElementById('mv-lastcall');
    if (!el) return;
    if (!_lastCallTs) { el.textContent = '—'; el.className = 'mc-v'; return; }
    const ago = Date.now() - _lastCallTs;
    let txt, cls;
    if (ago < 60000) { txt = Math.round(ago/1000) + 's'; cls = ' mc-hi'; }
    else if (ago < 600000) { txt = Math.round(ago/60000) + 'm'; cls = ago < 300000 ? ' mc-hi' : ' mc-warn'; }
    else { txt = Math.round(ago/60000) + 'm'; cls = ' mc-bad'; }
    el.textContent = txt + ' ago'; el.className = 'mc-v' + cls;
}
let _lastCallTimer = setInterval(_renderLastCall, 5000);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(_lastCallTimer); _lastCallTimer = null; }
    else { _renderLastCall(); _lastCallTimer = setInterval(_renderLastCall, 5000); }
});
function _mv(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; return el; }

function _toolSummary(name, output) {
    if (!output) return name + ' → (empty)';
    const lines = output.split('\n').filter(Boolean);
    const len = output.length;
    switch (name) {
        case 'read_file': { const m = output.match(/File has (\d+) lines/); return m ? '📄 ' + m[1] + ' lines' : '📄 ' + lines.length + ' lines, ' + len + ' chars'; }
        case 'search_text': return output === 'No matches found.' ? '🔍 0 matches' : '🔍 ' + lines.length + ' match' + (lines.length > 1 ? 'es' : '');
        case 'list_files': return '📂 ' + lines.length + ' entries';
        case 'run_command': return output.startsWith('Command failed') ? '⚠ failed' : '▶ ' + lines.length + ' lines output';
        case 'edit_file': return output.includes('✓') ? '✅ applied' : '❌ failed';
        case 'analyze_image': return '🖼️ vision analyzed';
        default: return name + ' → ' + (len > 100 ? len + ' chars' : output.slice(0, 60));
    }
}

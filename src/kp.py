# -*- coding: utf-8 -*-
# ==========================================
#  A组增强版 Daemon - IO 缓存优化 + 惰性文件夹创建 + DIB 严格处理
#  修改：DIB/ DIBV5 一律保存为无损 PNG（母版）
#  关键修复：DIB -> BMP 头严格计算 bfOffBits（header/palette/bitfields）
#
#  ★ 2025-12 更新：支持 HTML/富文本剪贴板（嗅探本地已下载图片/视频）
#    - 读取 CF_HTML（Windows: "HTML Format"）
#    - 解析 <img>/<video>/<source>，按顺序返回 blocks（text + media）
#    - media 若为本地路径/file:// 直接 copy2（原文件字节不改动）
#    - http(s)/data: 可选下载/解码（仍保存原始字节）
# ==========================================

import sys
import os
import json
import time
import platform
import shutil
import ctypes
from ctypes import wintypes
from pathlib import Path
from datetime import datetime
import random
import concurrent.futures
from collections import OrderedDict

import re
import base64
import html as html_lib
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, unquote
from urllib.request import Request, urlopen
import mimetypes
from typing import Union, Tuple

# ==========================================
#              缓存配置
# ==========================================
FOLDER_INFO_CACHE_TTL = 3.0
FOLDER_INFO_CACHE_MAX = 200

# 近似 LRU：OrderedDict {folder_path: (ts, data)}
_folder_cache = OrderedDict()

# 全局线程池复用：避免每次 get_folder_info 都创建线程池
_MAX_WORKERS = min(32, max(4, (os.cpu_count() or 4) * 2))
_folder_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=_MAX_WORKERS)

# ==========================================
#              默认路径配置
# ==========================================
DEFAULT_OUTPUT_DIR = Path("D:/view/p")


def resolve_output_dir(target_dir=None) -> Path:
    """解析输出目录对象，但不创建目录（惰性）"""
    if target_dir:
        return Path(target_dir)
    return DEFAULT_OUTPUT_DIR


def ensure_parent(path_obj: Path):
    """确保父目录存在（在写入前一刻调用）"""
    try:
        if not path_obj.parent.exists():
            path_obj.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


# ==========================================
#              文件签名表
# ==========================================
SIGNATURES = [
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"BM", ".bmp"),
    (b"\x00\x00\x01\x00", ".ico"),
    (b"II*\x00", ".tif"),
    (b"MM\x00*", ".tif"),
    (b"PK\x03\x04", ".zip"),
    (b"Rar!", ".rar"),
    (b"\x1f\x8b\x08", ".gz"),
    (b"7z\xbc\xaf", ".7z"),
    (b"MZ", ".exe"),
    (b"\x7fELF", ".elf"),
    (b"ID3", ".mp3"),
    (b"\xff\xfb", ".mp3"),
    (b"fLaC", ".flac"),
    (b"OggS", ".ogg"),
    (b"\x1aE\xdf\xa3", ".mkv"),
]


def guess_ext_by_magic(data: bytes) -> str:
    """通过 Magic Number 猜测扩展名"""
    if not data or len(data) < 4:
        return ".bin"

    # ftyp (MP4/MOV)
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in (b"heic", b"avif", b"mif1", b"msf1"):
            return ".heic"
        if brand == b"M4A ":
            return ".m4a"
        return ".mp4"

    # WEBP
    if data[:4] == b"RIFF" and len(data) >= 12 and data[8:12] == b"WEBP":
        return ".webp"

    for sig, ext in SIGNATURES:
        if data.startswith(sig):
            return ext

    return ".bin"


# ==========================================
#              Windows API (ctypes)
# ==========================================
if platform.system() == "Windows":
    user32 = ctypes.windll.user32
    shell32 = ctypes.windll.shell32
    kernel32 = ctypes.windll.kernel32

    CF_TEXT = 1
    CF_BITMAP = 2
    CF_DIB = 8
    CF_DIBV5 = 17
    CF_UNICODETEXT = 13
    CF_HDROP = 15

    GlobalLock = kernel32.GlobalLock
    GlobalLock.argtypes = [wintypes.HGLOBAL]
    GlobalLock.restype = ctypes.c_void_p

    GlobalUnlock = kernel32.GlobalUnlock
    GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    GlobalUnlock.restype = wintypes.BOOL

    GlobalSize = kernel32.GlobalSize
    GlobalSize.argtypes = [wintypes.HGLOBAL]
    GlobalSize.restype = ctypes.c_size_t

    DragQueryFileW = shell32.DragQueryFileW
    DragQueryFileW.argtypes = [wintypes.HGLOBAL,
                               wintypes.UINT, ctypes.c_wchar_p, wintypes.UINT]
    DragQueryFileW.restype = wintypes.UINT

    OpenClipboard = user32.OpenClipboard
    OpenClipboard.argtypes = [wintypes.HWND]
    OpenClipboard.restype = wintypes.BOOL

    CloseClipboard = user32.CloseClipboard
    CloseClipboard.argtypes = []
    CloseClipboard.restype = wintypes.BOOL

    GetClipboardData = user32.GetClipboardData
    GetClipboardData.argtypes = [wintypes.UINT]
    GetClipboardData.restype = wintypes.HANDLE

    IsClipboardFormatAvailable = user32.IsClipboardFormatAvailable
    IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
    IsClipboardFormatAvailable.restype = wintypes.BOOL

    RegisterClipboardFormatW = user32.RegisterClipboardFormatW
    RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
    RegisterClipboardFormatW.restype = wintypes.UINT


def read_global_data(h_mem):
    if not h_mem:
        return None
    ptr = GlobalLock(h_mem)
    if not ptr:
        return None
    try:
        size = GlobalSize(h_mem)
        if not size:
            return None
        buf = (ctypes.c_char * size)()
        ctypes.memmove(buf, ptr, size)
        return bytes(buf)
    finally:
        GlobalUnlock(h_mem)


# ==========================================
#              工具函数
# ==========================================
def get_timestamp_filename(ext=".png"):
    now = datetime.now()
    date_part = now.strftime("%Y.%m.%d")
    weekday_number = now.weekday() + 1
    millisecond_part = f"{now.microsecond // 1000:03d}"

    excluded_chars = ["l", "i", "s", "a", "m", "c", "b", "f", "t"]
    valid_chars = [c for c in "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" if c.lower(
    ) not in excluded_chars]
    first_char = random.choice(valid_chars)
    if first_char.lower() == "g":
        valid_chars_without_g = [c for c in valid_chars if c.lower() != "g"]
        second_char = random.choice(valid_chars_without_g)
    else:
        second_char = random.choice(valid_chars)
    random_chars = first_char + second_char

    prefix_code = f"{millisecond_part}{random_chars}"
    time_part = now.strftime("%H.%M.%S")
    filename = f"{prefix_code}.  {date_part} [{weekday_number}] {time_part}{ext}"
    return filename


def is_image_ext(ext):
    image_exts = {".png", ".jpg", ".jpeg", ".gif",
                  ".bmp", ".tif", ".tiff", ".webp", ".ico", ".svg"}
    return ext.lower() in image_exts


def is_video_ext(ext):
    video_exts = {".mp4", ".mkv", ".webm", ".avi", ".mov",
                  ".wmv", ".flv", ".m4v", ".ts", ".mpeg", ".mpg"}
    return ext.lower() in video_exts


def unique_path_in_dir(output_dir: Path, filename: str) -> Path:
    """
    防止极端情况下重名：如果已存在则追加 _n
    """
    base = Path(filename).stem
    ext = Path(filename).suffix
    candidate = output_dir / filename
    if not candidate.exists():
        return candidate
    for i in range(1, 2000):
        p = output_dir / f"{base}_{i}{ext}"
        if not p.exists():
            return p
    # 最后兜底
    return output_dir / f"{base}_{int(time.time()*1000)}{ext}"


def safe_filename(name: str) -> str:
    """
    尽量把文件名变成跨平台可写的安全名字
    """
    if not name:
        return get_timestamp_filename(".bin")
    n = name.strip().replace("\x00", "")
    # Windows 不允许的字符：<>:"/\|?*
    n = re.sub(r'[<>:"/\\\\|?*]+', "_", n)
    # 去掉前后空白点
    n = n.strip(" .\t\r\n")
    if not n:
        return get_timestamp_filename(".bin")
    if len(n) > 180:
        stem = Path(n).stem[:160]
        ext = Path(n).suffix
        n = stem + ext
    return n


def ext_from_mime(mime: str) -> str:
    m = (mime or "").split(";")[0].strip().lower()
    if not m:
        return ""
    # mimetypes 对 jpeg 返回 .jpe，需要修正
    ext = mimetypes.guess_extension(m) or ""
    if ext == ".jpe":
        ext = ".jpg"
    if m == "image/jpeg":
        ext = ".jpg"
    if m == "video/quicktime":
        ext = ".mov"
    return ext or ""


def ext_from_url(url: str) -> str:
    try:
        p = urlparse(url)
        ext = os.path.splitext(p.path)[1]
        if not ext:
            return ""
        ext = ext.lower()
        # 常见别名修正
        if ext == ".jpeg":
            return ".jpg"
        if ext == ".tiff":
            return ".tif"
        return ext
    except Exception:
        return ""


def save_image_as_png(img, path: Path):
    """
    将 PIL Image 保存为无损 PNG（母版）
    自动处理各种颜色模式，尽量保留透明通道
    """
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
    elif img.mode not in ("RGB",):
        img = img.convert("RGB")
    img.save(str(path), format="PNG", compress_level=6)


# ==========================================
#          DIB / DIBV5 严格转 BMP
# ==========================================
def dib_to_bmp_bytes(dib: bytes) -> bytes:
    """
    将 DIB（以 BITMAPINFOHEADER/BITMAPV5HEADER 开头）包装成 BMP 文件字节流。
    关键：bfOffBits 必须考虑：
      - header size (dib[0:4])
      - palette size（bpp<=8）
      - BITFIELDS masks（BI_BITFIELDS/BI_ALPHABITFIELDS, header=40 时 masks 位于 header 之后）
    """
    if not dib or len(dib) < 16:
        raise ValueError("DIB data too small")

    header_size = int.from_bytes(dib[0:4], "little", signed=False)
    if header_size < 12 or header_size > len(dib):
        raise ValueError(f"Invalid DIB header size: {header_size}")

    # BITMAPCOREHEADER (12) / BITMAPINFOHEADER (40) / BITMAPV4HEADER (108) / BITMAPV5HEADER (124) ...
    # 读取 bpp、compression、colorsUsed
    if header_size == 12:
        # COREHEADER: width(2), height(2), planes(2), bpp(2)
        bpp = int.from_bytes(dib[10:12], "little", signed=False)
        compression = 0
        colors_used = 0
        palette_entry_size = 3
    else:
        # INFOHEADER+: width(4), height(4), planes(2), bpp(2), compression(4), ... colorsUsed(4)
        bpp = int.from_bytes(dib[14:16], "little", signed=False)
        compression = int.from_bytes(dib[16:20], "little", signed=False)
        colors_used = int.from_bytes(
            dib[32:36], "little", signed=False) if len(dib) >= 36 else 0
        palette_entry_size = 4

    # 调色板大小
    palette_colors = colors_used if colors_used else (
        1 << bpp if 0 < bpp <= 8 else 0)
    palette_size = palette_colors * palette_entry_size

    # BITFIELDS masks（仅当 header_size==40 且 compression 指示 bitfields 时，masks 位于 header 后）
    bitfields_size = 0
    BI_BITFIELDS = 3
    BI_ALPHABITFIELDS = 6
    if header_size == 40 and compression in (BI_BITFIELDS, BI_ALPHABITFIELDS):
        # RGB masks(3 DWORD) or RGBA masks(4 DWORD)
        bitfields_size = 12 if compression == BI_BITFIELDS else 16

    bf_off_bits = 14 + header_size + bitfields_size + palette_size
    bf_size = 14 + len(dib)

    file_header = b"BM"
    file_header += bf_size.to_bytes(4, "little", signed=False)
    file_header += (0).to_bytes(4, "little", signed=False)  # reserved
    file_header += bf_off_bits.to_bytes(4, "little", signed=False)

    return file_header + dib


def bytes_from_pywin32_blob(blob) -> bytes:
    """
    pywin32 取到的剪贴板数据类型可能是 bytes/bytearray/memoryview/对象，
    这里尽可能稳定地转 bytes。
    """
    if blob is None:
        return b""
    if isinstance(blob, (bytes, bytearray)):
        return bytes(blob)
    try:
        return bytes(memoryview(blob))
    except Exception:
        try:
            return bytes(blob)
        except Exception:
            return b""


# ==========================================
#        ★ HTML / 富文本 解析（blocks）
# ==========================================
HTML_MAX_MEDIA = 80
HTML_REMOTE_MAX_BYTES = 80 * 1024 * 1024  # 远程下载最大字节，防止误触超大文件
HTML_REMOTE_TIMEOUT = 15

# 部分站点会拒绝空 UA
_HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (qqq-html-paste)",
    "Accept": "*/*",
}


def _extract_cf_html_fragment(cf_data) -> Tuple[Union[str, None], Union[str, None]]:
    """
    CF_HTML -> (fragment_html, source_url)
    cf_data: bytes 或 str
    """
    if cf_data is None:
        return None, None

    if isinstance(cf_data, str):
        text = cf_data
        raw_bytes = cf_data.encode("utf-8", "ignore")
    else:
        raw_bytes = bytes(cf_data)
        text = raw_bytes.decode("utf-8", "ignore")

    source_url = None
    m = re.search(r"^SourceURL:(.+)$", text,
                  flags=re.IGNORECASE | re.MULTILINE)
    if m:
        source_url = (m.group(1) or "").strip()

    # 优先：注释标记
    s_mark = "<!--StartFragment-->"
    e_mark = "<!--EndFragment-->"
    i1 = text.find(s_mark)
    i2 = text.find(e_mark)
    if i1 >= 0 and i2 > i1:
        frag = text[i1 + len(s_mark): i2].strip()
        if frag:
            return frag, source_url

    # 次选：字节偏移（如果 clipboard 返回原始 bytes，通常可用）
    m1 = re.search(r"StartFragment:(\d+)", text, flags=re.IGNORECASE)
    m2 = re.search(r"EndFragment:(\d+)", text, flags=re.IGNORECASE)
    if m1 and m2:
        try:
            s = int(m1.group(1))
            e = int(m2.group(1))
            if 0 <= s < e <= len(raw_bytes):
                frag_b = raw_bytes[s:e]
                frag = frag_b.decode("utf-8", "ignore").strip()
                if frag:
                    return frag, source_url
        except Exception:
            pass

    # 再兜底：抓 <html>...</html>
    m3 = re.search(r"<html[\s\S]*?</html>", text, flags=re.IGNORECASE)
    if m3:
        return m3.group(0).strip(), source_url

    # 最后：原样
    text2 = text.strip()
    return (text2 if text2 else None), source_url


def _attr(attrs, name: str) -> str:
    for k, v in (attrs or []):
        if not k:
            continue
        if k.lower() == name.lower():
            return (v or "").strip()
    return ""


def _pick_src(attrs) -> str:
    # 常见懒加载字段
    src = (
        _attr(attrs, "src")
        or _attr(attrs, "data-src")
        or _attr(attrs, "data-original")
        or _attr(attrs, "data-url")
        or _attr(attrs, "data-lazy-src")
    )
    if src:
        return src.strip()
    # srcset 兜底：取第一项
    srcset = _attr(attrs, "srcset")
    if srcset:
        first = srcset.split(",")[0].strip()
        if first:
            return first.split()[0].strip()
    return ""


class _HtmlBlocksParser(HTMLParser):
    """
    把 HTML 转成 tokens，保持顺序：
      - str: 纯文本（含 \n / \t）
      - dict: {"kind":"image"/"video", "src":..., "alt":...}
    """
    _BLOCK_TAGS = {
        "p", "div", "section", "article", "header", "footer",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "blockquote", "pre", "table", "tr", "ul", "ol",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tokens = []
        self._skip_depth = 0
        self._video_stack = []  # list[{src:str, sources:list[str]}]

    def _push_text(self, s: str):
        if not s:
            return
        self.tokens.append(s)

    def _push_nl(self):
        self.tokens.append("\n")

    def _push_tab(self):
        self.tokens.append("\t")

    def handle_starttag(self, tag, attrs):
        t = (tag or "").lower()

        if t in ("script", "style", "noscript", "head"):
            self._skip_depth += 1
            return
        if self._skip_depth > 0:
            return

        if t == "br":
            self._push_nl()
            return

        if t in self._BLOCK_TAGS:
            self._push_nl()
            return

        if t == "li":
            self._push_nl()
            self._push_text("- ")
            return

        if t in ("td", "th"):
            # 单元格间用 tab
            self._push_tab()
            return

        if t == "img":
            src = _pick_src(attrs)
            alt = _attr(attrs, "alt")
            if src:
                self.tokens.append({"kind": "image", "src": src, "alt": alt})
                self._push_nl()
            return

        if t == "video":
            src = _pick_src(attrs) or _attr(attrs, "src")
            self._video_stack.append({"src": src, "sources": []})
            self._push_nl()
            return

        if t == "source":
            if self._video_stack:
                s = _pick_src(attrs) or _attr(attrs, "src")
                if s:
                    self._video_stack[-1]["sources"].append(s)
            return

    def handle_endtag(self, tag):
        t = (tag or "").lower()

        if t in ("script", "style", "noscript", "head"):
            if self._skip_depth > 0:
                self._skip_depth -= 1
            return
        if self._skip_depth > 0:
            return

        if t in self._BLOCK_TAGS or t in ("li", "tr"):
            self._push_nl()
            return

        if t == "video":
            if self._video_stack:
                ctx = self._video_stack.pop()
                src = (ctx.get("src") or "").strip()
                if not src and ctx.get("sources"):
                    src = (ctx["sources"][0] or "").strip()
                if src:
                    self.tokens.append(
                        {"kind": "video", "src": src, "alt": ""})
                    self._push_nl()

    def handle_data(self, data):
        if self._skip_depth > 0:
            return
        if not data:
            return
        # 保留原有换行/空格（轻度清理后再做）
        self._push_text(data)

    def handle_entityref(self, name):
        # convert_charrefs=True 已处理
        pass

    def handle_charref(self, name):
        pass


def html_to_blocks(html_text: str) -> list:
    """
    HTML -> blocks:
      {"type":"text","text":...}
      {"type":"media","kind":"image"/"video","src":...,"alt":...}
    """
    if not html_text:
        return []

    parser = _HtmlBlocksParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        # 最差：按纯文本
        t = html_lib.unescape(re.sub(r"<[^>]+>", "", html_text))
        return [{"type": "text", "text": t}] if t else []

    tokens = parser.tokens
    blocks = []
    buf = ""

    def flush_buf(force=False):
        nonlocal buf
        if not buf:
            return
        # 保留仅换行的段落（用于分隔媒体）
        if force or buf.strip() or ("\n" in buf):
            blocks.append({"type": "text", "text": buf})
        buf = ""

    for tok in tokens:
        if isinstance(tok, dict):
            flush_buf(force=True)
            kind = tok.get("kind") or "image"
            src = (tok.get("src") or "").strip()
            alt = (tok.get("alt") or "").strip()
            if src:
                blocks.append(
                    {"type": "media", "kind": kind, "src": src, "alt": alt})
        else:
            buf += str(tok)

    flush_buf(force=False)

    # 清理 text
    cleaned = []
    for b in blocks:
        if b.get("type") != "text":
            cleaned.append(b)
            continue
        t = b.get("text", "")
        t = t.replace("\r\n", "\n").replace("\r", "\n")
        # 行内：压缩连续空白（但保留 tab）
        t = "\n".join([re.sub(r"[ \f\v]+", " ", line).rstrip()
                      for line in t.split("\n")])
        # 连续空行最多 2
        t = re.sub(r"\n{3,}", "\n\n", t)
        # 解实体（保险）
        t = html_lib.unescape(t)
        if t or ("\n" in t):
            cleaned.append({"type": "text", "text": t})
    return cleaned


def _data_url_to_bytes(data_url: str) -> Tuple[Union[bytes, None], str]:
    """
    data:<mime>;base64,xxxx -> (bytes, mime)
    """
    m = re.match(r"^data:([^;]+);base64,(.*)$",
                 data_url, flags=re.IGNORECASE | re.DOTALL)
    if not m:
        return None, ""
    mime = (m.group(1) or "").strip().lower()
    b64 = (m.group(2) or "").strip()
    try:
        return base64.b64decode(b64, validate=False), mime
    except Exception:
        try:
            return base64.b64decode(b64 + "==="), mime
        except Exception:
            return None, mime


def _file_url_to_path(file_url: str) -> Union[Path, None]:
    try:
        u = urlparse(file_url)
        if u.scheme != "file":
            return None
        p = unquote(u.path or "")
        # Windows: /C:/xxx
        if re.match(r"^/[a-zA-Z]:/", p):
            p = p[1:]
        # Windows UNC: file://server/share/xxx
        if u.netloc and not re.match(r"^[a-zA-Z]:", p):
            p2 = p.replace("/", "\\")
            p = "\\\\" + u.netloc + p2
        return Path(p)
    except Exception:
        return None


def _download_url_to_path(url: str, output_dir: Path, filename_hint: str = "") -> Union[Path, None]:
    """
    远程下载，原始字节保存；流式写入，避免内存爆。
    """
    try:
        req = Request(url, headers=_HTTP_HEADERS)
        with urlopen(req, timeout=HTML_REMOTE_TIMEOUT) as resp:
            ct = resp.headers.get("Content-Type", "") or ""
            cd = resp.headers.get("Content-Disposition", "") or ""

            # filename 先取 hint，再取 URL basename，再取 Content-Disposition
            name = safe_filename(filename_hint) if filename_hint else ""
            if not name:
                try:
                    base = os.path.basename(urlparse(url).path)
                    name = safe_filename(base)
                except Exception:
                    name = ""
            if not name:
                m = re.search(
                    r'filename\\*=UTF-8\\\'\\\'([^;]+)', cd, flags=re.IGNORECASE)
                if m:
                    name = safe_filename(unquote(m.group(1)))
                else:
                    m2 = re.search(
                        r'filename="([^"]+)"', cd, flags=re.IGNORECASE)
                    if m2:
                        name = safe_filename(m2.group(1))
            if not name:
                name = get_timestamp_filename(".bin")

            ext = Path(name).suffix
            if not ext:
                ext = ext_from_mime(ct) or ext_from_url(url) or ".bin"
                name = Path(name).stem + ext

            out_path = unique_path_in_dir(output_dir, name)
            ensure_parent(out_path)

            tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
            total = 0
            with open(tmp_path, "wb") as f:
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > HTML_REMOTE_MAX_BYTES:
                        raise ValueError("remote file too large")
                    f.write(chunk)

            try:
                os.replace(str(tmp_path), str(out_path))
            except Exception:
                try:
                    if out_path.exists():
                        out_path.unlink()
                except Exception:
                    pass
                shutil.move(str(tmp_path), str(out_path))

            # 如果扩展名不可靠，尝试 magic 再修正（只在 .bin 或未知时）
            if out_path.suffix.lower() in (".bin", ""):
                try:
                    with open(out_path, "rb") as f:
                        head = f.read(4096)
                    gext = guess_ext_by_magic(head)
                    if gext and gext != ".bin":
                        new_path = unique_path_in_dir(
                            output_dir, out_path.stem + gext)
                        os.replace(str(out_path), str(new_path))
                        out_path = new_path
                except Exception:
                    pass

            return out_path
    except Exception:
        return None


def save_media_from_src(src: str, output_dir: Path, source_url: Union[str, None], kind_hint: str = "") -> Union[Path, None]:
    """
    src -> 本地文件路径（已复制/已下载） or None
    """
    if not src:
        return None

    s = src.strip()
    if not s:
        return None

    # 1) data url
    if s.lower().startswith("data:"):
        data, mime = _data_url_to_bytes(s)
        if not data:
            return None
        ext = ext_from_mime(mime) or guess_ext_by_magic(data) or ".bin"
        name = get_timestamp_filename(
            ext if ext.startswith(".") else "." + ext)
        name = safe_filename(name)
        out_path = unique_path_in_dir(output_dir, name)
        ensure_parent(out_path)
        try:
            with open(out_path, "wb") as f:
                f.write(data)
            return out_path
        except Exception:
            return None

    # 2) file url
    if s.lower().startswith("file://"):
        p = _file_url_to_path(s)
        if p and p.exists() and p.is_file():
            name = safe_filename(p.name)
            out_path = unique_path_in_dir(output_dir, name)
            ensure_parent(out_path)
            try:
                shutil.copy2(p, out_path)  # 原封不动复制
                return out_path
            except Exception:
                return None
        return None

    # 3) 绝对本地路径（Windows / UNC / POSIX）
    if re.match(r"^[a-zA-Z]:[\\/]", s) or s.startswith("\\\\") or s.startswith("/"):
        p = Path(s)
        if p.exists() and p.is_file():
            name = safe_filename(p.name)
            out_path = unique_path_in_dir(output_dir, name)
            ensure_parent(out_path)
            try:
                shutil.copy2(p, out_path)
                return out_path
            except Exception:
                return None
        return None

    # 4) http(s)
    if s.lower().startswith("http://") or s.lower().startswith("https://"):
        return _download_url_to_path(s, output_dir)

    # 5) 相对 URL：基于 SourceURL 解析
    if source_url:
        try:
            abs_url = urljoin(source_url, s)
            if abs_url.lower().startswith(("http://", "https://", "file://")):
                return save_media_from_src(abs_url, output_dir, source_url, kind_hint=kind_hint)
        except Exception:
            pass

    return None


def materialize_html_blocks(blocks: list, output_dir: Path, source_url: Union[str, None]) -> list:
    """
    把 blocks 中的 media.src 落地成 output_dir 下的文件，并返回最终 blocks：
      {"type":"text","text":...}
      {"type":"media","kind":"image"/"video","path":...}
    """
    if not blocks:
        return []

    ensure_parent(output_dir / "dummy")

    out = []
    media_count = 0
    for b in blocks:
        if media_count >= HTML_MAX_MEDIA:
            alt = (b.get("alt") or "").strip()
            if alt:
                out.append(
                    {"type": "text", "text": f"[{b.get('kind', 'media')}]: {alt} (超限未下载)"})
            continue

        t = b.get("type")
        if t == "text":
            text = b.get("text", "")
            if text is None:
                continue
            out.append({"type": "text", "text": str(text)})
            continue

        if t == "media":
            src = (b.get("src") or "").strip()
            if not src:
                continue

            media_count += 1
            kind = (b.get("kind") or "image").strip().lower()
            p = save_media_from_src(
                src, output_dir, source_url, kind_hint=kind)
            if p and p.exists():
                out.append({"type": "media", "kind": kind, "path": str(p)})
            else:
                alt = (b.get("alt") or "").strip()
                if alt:
                    out.append({"type": "text", "text": f"[{kind}]: {alt}"})

    # 合并相邻文本
    merged = []
    for b in out:
        if b.get("type") == "text" and merged and merged[-1].get("type") == "text":
            merged[-1]["text"] = (merged[-1].get("text")
                                  or "") + "\n" + (b.get("text") or "")
        else:
            merged.append(b)

    # 再做一次 text 清理（防止碎片）
    final = []
    for b in merged:
        if b.get("type") != "text":
            final.append(b)
            continue
        t = b.get("text", "")
        t = str(t).replace("\r\n", "\n").replace("\r", "\n")
        t = re.sub(r"\n{3,}", "\n\n", t)
        t = t.strip("\n")
        if t:
            final.append({"type": "text", "text": t})
    return final


# ==========================================
#              文件夹统计模块
# ==========================================
def get_folder_info(folder_path: str):
    if not folder_path or not isinstance(folder_path, str):
        return {"success": False, "error": "empty path"}

    if not os.path.exists(folder_path) or not os.path.isdir(folder_path):
        return {"success": False, "error": "path not a directory"}

    now_ts = time.time()

    # cache hit
    entry = _folder_cache.get(folder_path)
    if entry:
        ts, data = entry
        if now_ts - ts < FOLDER_INFO_CACHE_TTL:
            # LRU: move to end
            _folder_cache.move_to_end(folder_path, last=True)
            return data

    total_size = 0
    ext_counts = {}
    files = []
    dirs = []

    def calc_size_recursive(p):
        s = 0
        try:
            with os.scandir(p) as it:
                for e in it:
                    try:
                        if e.is_file(follow_symlinks=False):
                            s += e.stat(follow_symlinks=False).st_size
                        elif e.is_dir(follow_symlinks=False):
                            s += calc_size_recursive(e.path)
                    except (OSError, PermissionError):
                        pass
        except (OSError, PermissionError):
            pass
        return s

    try:
        with os.scandir(folder_path) as it:
            for entry2 in it:
                try:
                    st = entry2.stat(follow_symlinks=False)
                    item = {"name": entry2.name,
                            "path": entry2.path, "mtime": st.st_mtime}
                    if entry2.is_file(follow_symlinks=False):
                        item["size"] = st.st_size
                        total_size += st.st_size
                        files.append(item)
                        _, ext = os.path.splitext(entry2.name)
                        key = ext[1:].lower() if ext else ""
                        ext_counts[key] = ext_counts.get(key, 0) + 1
                    elif entry2.is_dir(follow_symlinks=False):
                        dirs.append(item)
                except (OSError, PermissionError):
                    pass

        # 目录递归大小并发计算（复用全局线程池）
        futures = {_folder_executor.submit(
            calc_size_recursive, d["path"]): d for d in dirs}
        for fut in concurrent.futures.as_completed(futures):
            d = futures[fut]
            try:
                dir_size = fut.result(timeout=30)
                total_size += dir_size
                d["size"] = dir_size
            except Exception:
                d["size"] = 0

    except Exception as e:
        return {"success": False, "error": str(e)}

    result_data = {
        "success": True,
        "total_size": total_size,
        "ext_stats": ext_counts,
        "files": files,
        "dirs": dirs,
        "file_count_root": len(files),
    }

    # update cache (LRU)
    _folder_cache[folder_path] = (now_ts, result_data)
    _folder_cache.move_to_end(folder_path, last=True)
    while len(_folder_cache) > FOLDER_INFO_CACHE_MAX:
        _folder_cache.popitem(last=False)

    return result_data


# ==========================================
#              Windows 剪贴板处理
# ==========================================
def handle_windows_pywin32(wcb, wcon, output_dir: Path):
    """
    优先顺序：
      1) CF_HTML（富文本，含多媒体 -> blocks）
      2) CF_HDROP 文件/目录（物理复制，不转码）
      3) CF_DIBV5（如果存在）
      4) CF_DIB
    DIB/DIBV5：严格包装成 BMP 再给 PIL 解码，然后保存 PNG
    """
    try:
        wcb.OpenClipboard()
        try:
            # 1) CF_HTML：保持文字+多图/视频顺序
            try:
                fmt_html = wcb.RegisterClipboardFormat("HTML Format")
                if fmt_html and wcb.IsClipboardFormatAvailable(fmt_html):
                    raw = wcb.GetClipboardData(fmt_html)
                    # pywin32 有时直接给 str
                    if isinstance(raw, str):
                        cf_text = raw
                    else:
                        cf_text = bytes_from_pywin32_blob(
                            raw).decode("utf-8", "ignore")
                    frag, source_url = _extract_cf_html_fragment(cf_text)
                    if frag:
                        blocks0 = html_to_blocks(frag)
                        has_media = any(b.get("type") ==
                                        "media" for b in blocks0)
                        if blocks0:
                            blocks = materialize_html_blocks(
                                blocks0, output_dir, source_url)
                            if blocks and any(b.get("type") == "media" for b in blocks):
                                return {"type": "html_blocks", "blocks": blocks, "source_url": source_url or ""}
                            # 没媒体：退化成纯文本（保留段落结构）
                            if not has_media:
                                texts = [b.get("text", "")
                                         for b in blocks if b.get("type") == "text"]
                                t = "\n\n".join([x for x in texts if x])
                                if t.strip():
                                    return {"type": "text", "text": t}
            except Exception:
                pass

            # 2) 文件/目录（物理复制，不转码）
            if wcb.IsClipboardFormatAvailable(wcon.CF_HDROP):
                files = wcb.GetClipboardData(wcon.CF_HDROP)

                valid_dirs = []
                valid_files = []
                for fp in files:
                    p = Path(fp)
                    if p.exists():
                        if p.is_dir():
                            valid_dirs.append(str(p))
                        elif p.is_file():
                            valid_files.append(p)

                if valid_dirs:
                    return {"type": "folder_text", "text": "\n".join(valid_dirs)}

                if valid_files:
                    ensure_parent(output_dir / "dummy")
                    copied_files = []

                    for src in valid_files:
                        fname = safe_filename(src.name)  # ★ 原名优先
                        dst = unique_path_in_dir(output_dir, fname)
                        try:
                            shutil.copy2(src, dst)  # 原封不动
                            copied_files.append(str(dst))
                        except Exception:
                            pass

                    if len(copied_files) == 1 and is_image_ext(Path(copied_files[0]).suffix):
                        return {"type": "image", "path": copied_files[0]}
                    if copied_files:
                        return {"type": "file", "files": copied_files}
                    return None

            # 3/4) 图片：优先 DIBV5
            dibv5_format = getattr(wcon, "CF_DIBV5", 17)
            dib_formats = []
            if wcb.IsClipboardFormatAvailable(dibv5_format):
                dib_formats.append(dibv5_format)
            if wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
                dib_formats.append(wcon.CF_DIB)

            if dib_formats:
                try:
                    from PIL import Image
                    import io
                except ImportError:
                    return None

                for fmt in dib_formats:
                    try:
                        dib_obj = wcb.GetClipboardData(fmt)
                        dib = bytes_from_pywin32_blob(dib_obj)
                        if not dib:
                            continue
                        bmp = dib_to_bmp_bytes(dib)
                        img = Image.open(io.BytesIO(bmp))

                        fname = get_timestamp_filename(".png")
                        out_path = unique_path_in_dir(output_dir, fname)
                        ensure_parent(out_path)
                        save_image_as_png(img, out_path)

                        return {"type": "image", "path": str(out_path)}
                    except Exception:
                        continue

        finally:
            try:
                wcb.CloseClipboard()
            except Exception:
                pass

    except Exception:
        try:
            wcb.CloseClipboard()
        except Exception:
            pass
    return None


def handle_windows_ctypes(output_dir: Path):
    if not OpenClipboard(None):
        return {"error": "Cannot open clipboard"}

    try:
        # 1) CF_HTML
        try:
            fmt_html = RegisterClipboardFormatW("HTML Format")
            if fmt_html and IsClipboardFormatAvailable(fmt_html):
                h_mem = GetClipboardData(fmt_html)
                if h_mem:
                    raw = read_global_data(h_mem)
                    if raw:
                        frag, source_url = _extract_cf_html_fragment(raw)
                        if frag:
                            blocks0 = html_to_blocks(frag)
                            has_media = any(b.get("type") ==
                                            "media" for b in blocks0)
                            if blocks0:
                                blocks = materialize_html_blocks(
                                    blocks0, output_dir, source_url)
                                if blocks and any(b.get("type") == "media" for b in blocks):
                                    return {"type": "html_blocks", "blocks": blocks, "source_url": source_url or ""}
                                if not has_media:
                                    texts = [b.get("text", "") for b in blocks if b.get(
                                        "type") == "text"]
                                    t = "\n\n".join([x for x in texts if x])
                                    if t.strip():
                                        return {"type": "text", "text": t}
        except Exception:
            pass

        # 2) 文件/目录：CF_HDROP
        if IsClipboardFormatAvailable(CF_HDROP):
            h_drop = GetClipboardData(CF_HDROP)
            if h_drop:
                count = DragQueryFileW(h_drop, 0xFFFFFFFF, None, 0)
                files = []
                buf = ctypes.create_unicode_buffer(4096)
                for i in range(count):
                    DragQueryFileW(h_drop, i, buf, 4096)
                    files.append(buf.value)

                valid_dirs = []
                valid_files = []
                for fp in files:
                    p = Path(fp)
                    if p.exists():
                        if p.is_dir():
                            valid_dirs.append(str(p))
                        elif p.is_file():
                            valid_files.append(p)

                if valid_dirs:
                    return {"type": "folder_text", "text": "\n".join(valid_dirs)}

                if valid_files:
                    ensure_parent(output_dir / "dummy")
                    copied_files = []
                    for src in valid_files:
                        fname = safe_filename(src.name)
                        dst = unique_path_in_dir(output_dir, fname)
                        try:
                            shutil.copy2(src, dst)
                            copied_files.append(str(dst))
                        except Exception:
                            pass

                    if len(copied_files) == 1 and is_image_ext(Path(copied_files[0]).suffix):
                        return {"type": "image", "path": copied_files[0]}
                    if copied_files:
                        return {"type": "file", "files": copied_files}

        # 3) 图片：优先 CF_DIBV5，再 CF_DIB
        dib_format_list = []
        if IsClipboardFormatAvailable(CF_DIBV5):
            dib_format_list.append(CF_DIBV5)
        if IsClipboardFormatAvailable(CF_DIB):
            dib_format_list.append(CF_DIB)

        if dib_format_list:
            try:
                from PIL import Image
                import io
            except ImportError:
                return None

            for fmt in dib_format_list:
                h_mem = GetClipboardData(fmt)
                if not h_mem:
                    continue
                dib = read_global_data(h_mem)
                if not dib:
                    continue
                try:
                    bmp = dib_to_bmp_bytes(dib)
                    img = Image.open(io.BytesIO(bmp))

                    fname = get_timestamp_filename(".png")
                    out_path = unique_path_in_dir(output_dir, fname)
                    ensure_parent(out_path)
                    save_image_as_png(img, out_path)

                    return {"type": "image", "path": str(out_path)}
                except Exception:
                    continue

    finally:
        try:
            CloseClipboard()
        except Exception:
            pass

    return {"type": "unknown"}


def handle_windows(output_dir: Path):
    # pywin32 优先
    try:
        import win32clipboard as wcb
        import win32con as wcon

        res = handle_windows_pywin32(wcb, wcon, output_dir)
        if res:
            return res
    except ImportError as e:
        print(f"Python脚本缺少依赖: {str(e)}", file=sys.stderr)
    except Exception as e:
        print(f"Python脚本处理pywin32时出错: {str(e)}", file=sys.stderr)

    # ctypes fallback
    try:
        res = handle_windows_ctypes(output_dir)
        if res:
            return res
    except Exception as e:
        print(f"Python脚本处理ctypes时出错: {str(e)}", file=sys.stderr)

    return {"type": "unknown"}


def handle_macos(output_dir: Path):
    import subprocess

    # 1) HTML（如果有）
    try:
        html_proc = subprocess.run(
            ["pbpaste", "-Prefer", "html"], capture_output=True, timeout=2)
        if html_proc.stdout and len(html_proc.stdout) > 0:
            html_text = html_proc.stdout.decode("utf-8", "ignore")
            if "<" in html_text and ">" in html_text:
                blocks0 = html_to_blocks(html_text)
                blocks = materialize_html_blocks(blocks0, output_dir, None)
                if blocks and any(b.get("type") == "media" for b in blocks):
                    return {"type": "html_blocks", "blocks": blocks, "source_url": ""}
                # 纯文本
                texts = [b.get("text", "")
                         for b in blocks if b.get("type") == "text"]
                t = "\n\n".join([x for x in texts if x])
                if t.strip():
                    return {"type": "text", "text": t}
    except Exception:
        pass

    # 2) PNG 图片
    fname = get_timestamp_filename(".png")
    out_path = unique_path_in_dir(output_dir, fname)

    try:
        check_proc = subprocess.run(
            ["pbpaste", "-Prefer", "png"], capture_output=True, timeout=2)
        if check_proc.stdout and len(check_proc.stdout) > 0:
            ensure_parent(out_path)
            with open(out_path, "wb") as f:
                f.write(check_proc.stdout)
            if out_path.exists() and out_path.stat().st_size > 0:
                return {"type": "image", "path": str(out_path)}
    except Exception:
        pass

    return {"type": "unknown"}


def handle_linux(output_dir: Path):
    import subprocess

    # 1) HTML（如果有）
    try:
        targets_proc = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        targets = targets_proc.stdout or ""
        if "text/html" in targets:
            html_proc = subprocess.run(
                ["xclip", "-selection", "clipboard", "-t", "text/html", "-o"],
                capture_output=True,
                timeout=3,
            )
            if html_proc.stdout and len(html_proc.stdout) > 0:
                html_text = html_proc.stdout.decode("utf-8", "ignore")
                if "<" in html_text and ">" in html_text:
                    blocks0 = html_to_blocks(html_text)
                    blocks = materialize_html_blocks(blocks0, output_dir, None)
                    if blocks and any(b.get("type") == "media" for b in blocks):
                        return {"type": "html_blocks", "blocks": blocks, "source_url": ""}
                    texts = [b.get("text", "")
                             for b in blocks if b.get("type") == "text"]
                    t = "\n\n".join([x for x in texts if x])
                    if t.strip():
                        return {"type": "text", "text": t}
    except Exception:
        pass

    # 2) PNG 图片
    fname = get_timestamp_filename(".png")
    out_path = unique_path_in_dir(output_dir, fname)

    try:
        targets_proc = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if "image/png" in (targets_proc.stdout or ""):
            ensure_parent(out_path)
            with open(out_path, "wb") as f:
                subprocess.run(
                    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
                    stdout=f,
                    stderr=subprocess.DEVNULL,
                    check=True,
                    timeout=5,
                )
            if out_path.exists() and out_path.stat().st_size > 0:
                return {"type": "image", "path": str(out_path)}
    except Exception:
        pass

    return {"type": "unknown"}


def handle_clipboard(target_dir=None):
    output_dir = resolve_output_dir(target_dir)
    sys_name = platform.system()
    if sys_name == "Windows":
        return handle_windows(output_dir)
    elif sys_name == "Darwin":
        return handle_macos(output_dir)
    elif sys_name == "Linux":
        return handle_linux(output_dir)
    else:
        return {"type": "unknown"}


def handle_clipboard_peek():
    """
    只做“快速嗅探”，不做任何写入：
      - has_html: 是否存在 HTML/富文本
      - has_files: 是否存在文件拖拽列表（多媒体原文件）
      - has_image: 是否存在位图数据（单图）
      - has_text: 是否存在文本
    目的：让上层决定是否走 fast-path（纯文本直接插入）还是 slow-path（媒体落盘）
    """
    result = {"type": "peek", "has_html": False,
              "has_files": False, "has_image": False, "has_text": False}
    sys_name = platform.system()

    if sys_name == "Windows":
        # pywin32 优先
        try:
            import win32clipboard as wcb
            import win32con as wcon

            wcb.OpenClipboard()
            try:
                try:
                    fmt_html = wcb.RegisterClipboardFormat("HTML Format")
                    if fmt_html and wcb.IsClipboardFormatAvailable(fmt_html):
                        result["has_html"] = True
                except Exception as e:
                    print(f"检查HTML格式时出错: {str(e)}", file=sys.stderr)

                try:
                    if wcb.IsClipboardFormatAvailable(wcon.CF_HDROP):
                        result["has_files"] = True
                except Exception as e:
                    print(f"检查文件格式时出错: {str(e)}", file=sys.stderr)

                try:
                    dibv5_format = getattr(wcon, "CF_DIBV5", 17)
                    if wcb.IsClipboardFormatAvailable(dibv5_format) or wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
                        result["has_image"] = True
                except Exception as e:
                    print(f"检查图像格式时出错: {str(e)}", file=sys.stderr)

                try:
                    if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT) or wcb.IsClipboardFormatAvailable(wcon.CF_TEXT):
                        result["has_text"] = True
                except Exception as e:
                    print(f"检查文本格式时出错: {str(e)}", file=sys.stderr)

            finally:
                try:
                    wcb.CloseClipboard()
                except Exception:
                    pass

            return result

        except ImportError as e:
            print(f"Python脚本缺少依赖: {str(e)}", file=sys.stderr)
        except Exception as e:
            print(f"Python脚本处理pywin32时出错: {str(e)}", file=sys.stderr)

        # ctypes fallback
        try:
            if not OpenClipboard(None):
                return result

            try:
                try:
                    fmt_html = RegisterClipboardFormatW("HTML Format")
                    if fmt_html and IsClipboardFormatAvailable(fmt_html):
                        result["has_html"] = True
                except Exception as e:
                    print(f"检查HTML格式(ctypes)时出错: {str(e)}", file=sys.stderr)

                try:
                    if IsClipboardFormatAvailable(CF_HDROP):
                        result["has_files"] = True
                except Exception as e:
                    print(f"检查文件格式(ctypes)时出错: {str(e)}", file=sys.stderr)

                try:
                    if IsClipboardFormatAvailable(CF_DIBV5) or IsClipboardFormatAvailable(CF_DIB):
                        result["has_image"] = True
                except Exception as e:
                    print(f"检查图像格式(ctypes)时出错: {str(e)}", file=sys.stderr)

                try:
                    if IsClipboardFormatAvailable(CF_UNICODETEXT) or IsClipboardFormatAvailable(CF_TEXT):
                        result["has_text"] = True
                except Exception as e:
                    print(f"检查文本格式(ctypes)时出错: {str(e)}", file=sys.stderr)

            finally:
                try:
                    CloseClipboard()
                except Exception:
                    pass

            return result
        except Exception as e:
            print(f"Python脚本处理ctypes时出错: {str(e)}", file=sys.stderr)
            return result

    elif sys_name == "Darwin":
        try:
            import subprocess
            html_proc = subprocess.run(
                ["pbpaste", "-Prefer", "html"], capture_output=True, timeout=1.2)
            if html_proc.stdout and len(html_proc.stdout) > 0 and b"<" in html_proc.stdout:
                result["has_html"] = True
        except Exception as e:
            print(f"MacOS检查HTML时出错: {str(e)}", file=sys.stderr)

        try:
            import subprocess
            txt_proc = subprocess.run(
                ["pbpaste"], capture_output=True, timeout=0.8)
            if txt_proc.stdout and len(txt_proc.stdout) > 0:
                result["has_text"] = True
        except Exception as e:
            print(f"MacOS检查文本时出错: {str(e)}", file=sys.stderr)

        return result

    elif sys_name == "Linux":
        try:
            import subprocess
            targets_proc = subprocess.run(
                ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
                capture_output=True,
                text=True,
                timeout=1.2,
            )
            targets = targets_proc.stdout or ""
            if "text/html" in targets:
                result["has_html"] = True
            if any(x in targets for x in ["image/png", "image/jpeg", "image/bmp", "image/webp", "image/gif"]):
                result["has_image"] = True
            if any(x in targets for x in ["UTF8_STRING", "text/plain", "STRING"]):
                result["has_text"] = True
        except Exception as e:
            print(f"Linux检查剪贴板格式时出错: {str(e)}", file=sys.stderr)

        return result

    return result


# ==========================================
#              Daemon 模式
# ==========================================
def daemon_mode():
    # Windows 下 stdout 行缓冲可能需要
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue

            cmd = json.loads(line)
            action = cmd.get("action")
            request_id = cmd.get("_id", 0)
            result = {"_id": request_id}

            if action == "ping":
                result["status"] = "alive"

            elif action == "clipboard_peek":
                peek = handle_clipboard_peek()
                result.update(peek)

            elif action == "clipboard":
                target_dir = cmd.get("target_dir")
                clipboard_result = handle_clipboard(target_dir)
                if clipboard_result:
                    result.update(clipboard_result)
                else:
                    result["type"] = "unknown"

            elif action == "folder_info":
                folder_path = cmd.get("path", "")
                info_result = get_folder_info(folder_path)
                result.update(info_result)

            else:
                result["success"] = False
                result["error"] = f"unknown action: {action}"

            print(json.dumps(result, ensure_ascii=False), flush=True)

        except json.JSONDecodeError:
            print(json.dumps({"_id": 0, "success": False,
                  "error": "JSON parse error"}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"_id": 0, "success": False,
                  "error": str(e)}, ensure_ascii=False), flush=True)


def main():
    if len(sys.argv) > 1:
        if sys.argv[1] == "--daemon":
            daemon_mode()
            return
        if sys.argv[1] == "folder_info" and len(sys.argv) >= 3:
            res = get_folder_info(sys.argv[2])
            print(json.dumps(res, ensure_ascii=False))
            return
        if sys.argv[1] == "clipboard_peek":
            res = handle_clipboard_peek()
            print(json.dumps(res, ensure_ascii=False))
            return
        if sys.argv[1] == "clipboard":
            target_dir = sys.argv[2] if len(sys.argv) >= 3 else None
            res = handle_clipboard(target_dir)
            print(json.dumps(res, ensure_ascii=False))
            return

    try:
        res = handle_clipboard()
        print(json.dumps(res, ensure_ascii=False))
    except Exception as e:
        print(json.dumps(
            {"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()

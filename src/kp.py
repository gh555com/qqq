# -*- coding: utf-8 -*-

#   - 常见路径极致快：纯文本(手刀) > 文件(手枪) > 文件夹(手枪) > 截图DIB(步枪) > HTML富文本(大炮)
#   - DIB/DIBV5 严格处理：bfOffBits 精确计算，统一保存无损 PNG（母版）
#   - 支持 HTML/富文本剪贴板：解析 <img>/<video>/<source>，按顺序输出 blocks（text + media）
#     * 本地路径 / file:// 直接 copy2（原文件字节不改动）
#     * http(s)/data: 可选下载/解码（仍保存原始字节）
#   - ★ 重要增强：CF_HDROP 中的“文件夹”会被完整复制到输出目录（不能丢！）
#   - 文件夹统计：TTL 缓存 + 全局线程池复用
#   - 兼容两套协议：
#       * A 协议（stdin JSON 行）：{"action": "...", "_id": 1, ...}
#       * Q 协议（stdin JSON 行）：{"cmd": "...", ...}
#   - “没有任何优化空间”在工程上不现实（不同磁盘/网络/用例瓶颈不同），
#     但这份代码把主要热路径都做成了“能不干就不干、必须干就并发干”的上限形态。

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
from typing import Union, Tuple, List, Dict, Any, Optional

# =============================================================================
#  配置
# =============================================================================
# folder_info 缓存
FOLDER_INFO_CACHE_TTL = 3.0
FOLDER_INFO_CACHE_MAX = 200

# HTML 解析与下载
HTML_MAX_MEDIA = 80
HTML_REMOTE_MAX_BYTES = 80 * 1024 * 1024
HTML_REMOTE_TIMEOUT = 15

_HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (qqq-html-paste)",
    "Accept": "*/*",
}

# 线程池（全局复用）
_MAX_WORKERS = min(32, max(4, (os.cpu_count() or 4) * 2))
_IO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=_MAX_WORKERS)
_FOLDER_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=_MAX_WORKERS)

# 近似 LRU：OrderedDict {folder_path: (ts, data)}
_folder_cache = OrderedDict()

# =============================================================================
#  工具：路径/文件名
# =============================================================================


def resolve_output_dir(target_dir: Optional[Union[str, Path]] = None) -> Path:
    if target_dir:
        return Path(target_dir)
    return Path("./qqq")


def ensure_parent(path_obj: Path):
    """确保父目录存在（在写入前一刻调用）"""
    try:
        parent = path_obj.parent
        if not parent.exists():
            parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass


def get_timestamp_filename(ext: str = ".png") -> str:
    now = datetime.now()
    date_part = now.strftime("%Y.%m.%d")
    weekday_number = now.weekday() + 1
    millisecond_part = f"{now.microsecond // 1000:03d}"

    excluded_chars = ["l", "i", "s", "a", "m", "c", "b", "f", "t"]
    valid_chars = [
        c for c in "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        if c.lower() not in excluded_chars
    ]
    first_char = random.choice(valid_chars)
    if first_char.lower() == "g":
        valid_chars_without_g = [c for c in valid_chars if c.lower() != "g"]
        second_char = random.choice(valid_chars_without_g)
    else:
        second_char = random.choice(valid_chars)
    random_chars = first_char + second_char

    prefix_code = f"{millisecond_part}{random_chars}"
    time_part = now.strftime("%H.%M.%S")
    return f"{prefix_code}.  {date_part} [{weekday_number}] {time_part}{ext}"


def safe_filename(name: str) -> str:
    """尽量把文件名变成跨平台可写的安全名字（尽量不改变用户可读性）"""
    if not name:
        return get_timestamp_filename(".bin")
    n = str(name).strip().replace("\x00", "")
    # Windows 不允许的字符：<>:"/\|?*
    n = re.sub(r'[<>:"/\\\\|?*]+', "_", n)
    n = n.strip(" .\t\r\n")
    if not n:
        return get_timestamp_filename(".bin")
    if len(n) > 180:
        stem = Path(n).stem[:160]
        ext = Path(n).suffix
        n = stem + ext
    return n


def compute_file_fingerprint(file_path: Path) -> str:
    """计算文件指纹"""
    import hashlib
    try:
        with open(file_path, 'rb') as f:
            # 读取文件头、中间和末尾的内容来计算指纹
            head = f.read(1024)  # 头1KB
            f.seek(max(0, file_path.stat().st_size - 1024))  # 尾1KB
            tail = f.read(1024)
            # 如果文件较大，再读取中间1KB
            if file_path.stat().st_size > 2048:
                f.seek(file_path.stat().st_size // 2)
                mid = f.read(1024)
            else:
                mid = b''
        return hashlib.md5(head + mid + tail).hexdigest()
    except Exception:
        return ""


def unique_dir_in_dir(output_dir: Path, dirname: str) -> Path:
    return output_dir / dirname


def is_image_ext(ext: str) -> bool:
    return (ext or "").lower() in {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".ico", ".svg"
    }


def is_video_ext(ext: str) -> bool:
    return (ext or "").lower() in {
        ".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".ts", ".mpeg", ".mpg"
    }


# =============================================================================
#  Magic signatures
# =============================================================================
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
    if not data or len(data) < 4:
        return ".bin"

    # ftyp (MP4/MOV/HEIC/AVIF)
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


def ext_from_mime(mime: str) -> str:
    m = (mime or "").split(";")[0].strip().lower()
    if not m:
        return ""
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
        if ext == ".jpeg":
            return ".jpg"
        if ext == ".tiff":
            return ".tif"
        return ext
    except Exception:
        return ""


# =============================================================================
#  Windows API (ctypes)
# =============================================================================
_IS_WINDOWS = platform.system() == "Windows"

if _IS_WINDOWS:
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
    if not _IS_WINDOWS:
        return None
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


def bytes_from_pywin32_blob(blob) -> bytes:
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

# =============================================================================
#  PIL 保存：PNG（母版）
# =============================================================================


def save_image_as_png(img, path: Path):
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
    elif img.mode not in ("RGB",):
        img = img.convert("RGB")
    img.save(str(path), format="PNG", compress_level=6)

# =============================================================================
#  DIB / DIBV5 严格转 BMP
# =============================================================================


def dib_to_bmp_bytes(dib: bytes) -> bytes:
    if not dib or len(dib) < 16:
        raise ValueError("DIB data too small")

    header_size = int.from_bytes(dib[0:4], "little", signed=False)
    if header_size < 12 or header_size > len(dib):
        raise ValueError(f"Invalid DIB header size: {header_size}")

    if header_size == 12:
        # BITMAPCOREHEADER
        bpp = int.from_bytes(dib[10:12], "little", signed=False)
        compression = 0
        colors_used = 0
        palette_entry_size = 3
    else:
        # BITMAPINFOHEADER+
        bpp = int.from_bytes(dib[14:16], "little", signed=False)
        compression = int.from_bytes(dib[16:20], "little", signed=False)
        colors_used = int.from_bytes(
            dib[32:36], "little", signed=False) if len(dib) >= 36 else 0
        palette_entry_size = 4

    palette_colors = colors_used if colors_used else (
        1 << bpp if 0 < bpp <= 8 else 0)
    palette_size = palette_colors * palette_entry_size

    bitfields_size = 0
    BI_BITFIELDS = 3
    BI_ALPHABITFIELDS = 6
    if header_size == 40 and compression in (BI_BITFIELDS, BI_ALPHABITFIELDS):
        bitfields_size = 12 if compression == BI_BITFIELDS else 16

    bf_off_bits = 14 + header_size + bitfields_size + palette_size
    bf_size = 14 + len(dib)

    file_header = b"BM"
    file_header += bf_size.to_bytes(4, "little", signed=False)
    file_header += (0).to_bytes(4, "little", signed=False)  # reserved
    file_header += bf_off_bits.to_bytes(4, "little", signed=False)

    return file_header + dib

# =============================================================================
#  HTML / 富文本 blocks
# =============================================================================


def _extract_cf_html_fragment(cf_data) -> Tuple[Optional[str], Optional[str]]:
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

    s_mark = "<!--StartFragment-->"
    e_mark = "<!--EndFragment-->"
    i1 = text.find(s_mark)
    i2 = text.find(e_mark)
    if i1 >= 0 and i2 > i1:
        frag = text[i1 + len(s_mark): i2].strip()
        if frag:
            return frag, source_url

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

    m3 = re.search(r"<html[\s\S]*?</html>", text, flags=re.IGNORECASE)
    if m3:
        return m3.group(0).strip(), source_url

    text2 = text.strip()
    return (text2 if text2 else None), source_url


def _attr(attrs, name: str) -> str:
    for k, v in (attrs or []):
        if k and k.lower() == name.lower():
            return (v or "").strip()
    return ""


def _pick_src(attrs) -> str:
    src = (
        _attr(attrs, "src")
        or _attr(attrs, "data-src")
        or _attr(attrs, "data-original")
        or _attr(attrs, "data-url")
        or _attr(attrs, "data-lazy-src")
    )
    if src:
        return src.strip()
    srcset = _attr(attrs, "srcset")
    if srcset:
        first = srcset.split(",")[0].strip()
        if first:
            return first.split()[0].strip()
    return ""


class _HtmlBlocksParser(HTMLParser):
    _BLOCK_TAGS = {
        "p", "div", "section", "article", "header", "footer",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "blockquote", "pre", "table", "tr", "ul", "ol",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tokens = []
        self._skip_depth = 0
        self._video_stack = []

    def _push_text(self, s: str):
        if s:
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
        if data:
            self._push_text(data)


def html_to_blocks(html_text: str) -> List[Dict[str, Any]]:
    if not html_text:
        return []

    parser = _HtmlBlocksParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        t = html_lib.unescape(re.sub(r"<[^>]+>", "", html_text))
        return [{"type": "text", "text": t}] if t else []

    tokens = parser.tokens
    blocks = []
    buf = ""

    def flush_buf(force=False):
        nonlocal buf
        if not buf:
            return
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

    cleaned = []
    for b in blocks:
        if b.get("type") != "text":
            cleaned.append(b)
            continue
        t = (b.get("text") or "").replace("\r\n", "\n").replace("\r", "\n")
        t = "\n".join([re.sub(r"[ \f\v]+", " ", line).rstrip()
                      for line in t.split("\n")])
        t = re.sub(r"\n{3,}", "\n\n", t)
        t = html_lib.unescape(t)
        if t or ("\n" in t):
            cleaned.append({"type": "text", "text": t})
    return cleaned


def _data_url_to_bytes(data_url: str) -> Tuple[Optional[bytes], str]:
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


def _file_url_to_path(file_url: str) -> Optional[Path]:
    try:
        u = urlparse(file_url)
        if u.scheme != "file":
            return None
        p = unquote(u.path or "")
        if re.match(r"^/[a-zA-Z]:/", p):
            p = p[1:]
        if u.netloc and not re.match(r"^[a-zA-Z]:", p):
            p2 = p.replace("/", "\\")
            p = "\\\\" + u.netloc + p2
        return Path(p)
    except Exception:
        return None


def _download_url_to_path(url: str, output_dir: Path, filename_hint: str = "") -> Optional[Path]:
    try:
        req = Request(url, headers=_HTTP_HEADERS)
        with urlopen(req, timeout=HTML_REMOTE_TIMEOUT) as resp:
            ct = resp.headers.get("Content-Type", "") or ""
            cd = resp.headers.get("Content-Disposition", "") or ""

            name = safe_filename(filename_hint) if filename_hint else ""
            if not name:
                try:
                    base = os.path.basename(urlparse(url).path)
                    name = safe_filename(base)
                except Exception:
                    name = ""
            if not name:
                m = re.search(
                    r"filename\\*=UTF-8\\\'\\\'([^;]+)", cd, flags=re.IGNORECASE)
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

            out_path = output_dir / name
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

            if out_path.suffix.lower() in (".bin", ""):
                try:
                    with open(out_path, "rb") as f:
                        head = f.read(4096)
                    gext = guess_ext_by_magic(head)
                    if gext and gext != ".bin":
                        new_path = output_dir / (out_path.stem + gext)
                        os.replace(str(out_path), str(new_path))
                        out_path = new_path
                except Exception:
                    pass

            return out_path
    except Exception:
        return None


def save_media_from_src(src: str, output_dir: Path, source_url: Optional[str]) -> Optional[Path]:
    if not src:
        return None
    s = src.strip()
    if not s:
        return None

    # 构建目标目录中现有文件的指纹映射
    existing_fingerprints = {}
    try:
        for entry in os.scandir(output_dir):
            if entry.is_file():
                fp = compute_file_fingerprint(Path(entry.path))
                if fp:
                    existing_fingerprints[fp] = Path(entry.path)
    except Exception:
        pass

    if s.lower().startswith("data:"):
        data, mime = _data_url_to_bytes(s)
        if not data:
            return None

        # 计算数据指纹
        import hashlib
        data_fp = hashlib.md5(data).hexdigest()
        if data_fp in existing_fingerprints:
            return existing_fingerprints[data_fp]

        ext = ext_from_mime(mime) or guess_ext_by_magic(data) or ".bin"
        if not ext.startswith("."):
            ext = "." + ext
        name = safe_filename(get_timestamp_filename(ext))
        out_path = output_dir / name
        ensure_parent(out_path)
        try:
            with open(out_path, "wb") as f:
                f.write(data)
            existing_fingerprints[data_fp] = out_path
            return out_path
        except Exception:
            return None

    if s.lower().startswith("file://"):
        p = _file_url_to_path(s)
        if p and p.exists() and p.is_file():
            # 计算源文件指纹
            src_fp = compute_file_fingerprint(p)
            if src_fp in existing_fingerprints:
                return existing_fingerprints[src_fp]

            name = safe_filename(p.name)
            out_path = output_dir / name
            ensure_parent(out_path)
            try:
                shutil.copy2(p, out_path)
                existing_fingerprints[src_fp] = out_path
                return out_path
            except Exception:
                return None
        return None

    if re.match(r"^[a-zA-Z]:[\\/]", s) or s.startswith("\\\\") or s.startswith("/"):
        p = Path(s)
        if p.exists() and p.is_file():
            # 计算源文件指纹
            src_fp = compute_file_fingerprint(p)
            if src_fp in existing_fingerprints:
                return existing_fingerprints[src_fp]

            name = safe_filename(p.name)
            out_path = output_dir / name
            ensure_parent(out_path)
            try:
                shutil.copy2(p, out_path)
                existing_fingerprints[src_fp] = out_path
                return out_path
            except Exception:
                return None
        return None

    if s.lower().startswith("http://") or s.lower().startswith("https://"):
        # 下载文件
        downloaded_path = _download_url_to_path(s, output_dir)
        if downloaded_path:
            # 计算下载文件的指纹
            dl_fp = compute_file_fingerprint(downloaded_path)
            if dl_fp:
                existing_fingerprints[dl_fp] = downloaded_path
            return downloaded_path
        return None

    if source_url:
        try:
            abs_url = urljoin(source_url, s)
            if abs_url.lower().startswith(("http://", "https://", "file://")):
                return save_media_from_src(abs_url, output_dir, source_url)
        except Exception:
            pass

    return None


def materialize_html_blocks(blocks: List[Dict[str, Any]], output_dir: Path, source_url: Optional[str]) -> List[Dict[str, Any]]:
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
            p = save_media_from_src(src, output_dir, source_url)
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

    final = []
    for b in merged:
        if b.get("type") != "text":
            final.append(b)
            continue
        t = str(b.get("text", "")).replace("\r\n", "\n").replace("\r", "\n")
        t = re.sub(r"\n{3,}", "\n\n", t).strip("\n")
        if t:
            final.append({"type": "text", "text": t})
    return final

# =============================================================================
#  高性能复制：文件 & 文件夹
# =============================================================================


def _wait_some(futs: set, target_inflight: int):
    """控制 in-flight futures 数量，避免爆内存"""
    if len(futs) <= target_inflight:
        return
    done, _ = concurrent.futures.wait(
        futs, return_when=concurrent.futures.FIRST_COMPLETED)
    futs.difference_update(done)


def copy_files_parallel(src_files: List[Path], output_dir: Path) -> List[str]:
    if not src_files:
        return []
    ensure_parent(output_dir / "dummy")

    # 构建目标目录中现有文件的指纹映射
    existing_fingerprints = {}
    try:
        for entry in os.scandir(output_dir):
            if entry.is_file():
                fp = compute_file_fingerprint(Path(entry.path))
                if fp:
                    existing_fingerprints[fp] = Path(entry.path)
    except Exception:
        pass

    results: List[str] = []
    futs: set = set()
    inflight = max(64, _MAX_WORKERS * 16)

    def submit_one(src: Path) -> Optional[Path]:
        try:
            # 计算源文件指纹
            src_fp = compute_file_fingerprint(src)
            if src_fp and src_fp in existing_fingerprints:
                # 指纹已存在，直接返回现有文件路径
                return existing_fingerprints[src_fp]

            fname = safe_filename(src.name)
            dst = output_dir / fname
            ensure_parent(dst)

            # 再次检查目标文件是否已存在
            if not dst.exists():
                shutil.copy2(src, dst)
                # 更新指纹映射
                if src_fp:
                    existing_fingerprints[src_fp] = dst
                return dst
            else:
                # 目标文件已存在，检查指纹
                dst_fp = compute_file_fingerprint(dst)
                if dst_fp == src_fp:
                    return dst
                else:
                    # 文件名相同但指纹不同，使用源文件名
                    return dst
        except Exception:
            return None

    for src in src_files:
        futs.add(_IO_EXECUTOR.submit(submit_one, src))
        _wait_some(futs, inflight)

    for fut in concurrent.futures.as_completed(futs):
        try:
            p = fut.result()
            if p:
                results.append(str(p))
        except Exception:
            pass
    return results


def copytree_parallel(src_dir: Path, output_dir: Path) -> Optional[str]:
    """复制整个文件夹到 output_dir 下，返回目标目录路径"""
    try:
        if not src_dir.exists() or not src_dir.is_dir():
            return None
        ensure_parent(output_dir / "dummy")

        # 使用源目录名作为目标目录名
        dst_dir = output_dir / safe_filename(src_dir.name)
        dst_dir.mkdir(parents=True, exist_ok=True)

        # 构建目标目录中现有文件的指纹映射
        def build_fingerprint_map(target_dir: Path) -> dict:
            fingerprint_map = {}
            try:
                for root, _, files in os.walk(target_dir):
                    for fn in files:
                        fp = compute_file_fingerprint(Path(root) / fn)
                        if fp:
                            fingerprint_map[fp] = Path(root) / fn
            except Exception:
                pass
            return fingerprint_map

        fingerprint_map = build_fingerprint_map(dst_dir)

        futs: set = set()
        inflight = max(128, _MAX_WORKERS * 32)

        def submit_copy(src_path: Path, dst_path: Path):
            try:
                ensure_parent(dst_path)

                # 计算源文件指纹
                src_fp = compute_file_fingerprint(src_path)
                if src_fp and src_fp in fingerprint_map:
                    # 指纹已存在，跳过复制
                    return True

                # 检查目标文件是否已存在
                if not dst_path.exists():
                    shutil.copy2(src_path, dst_path)
                    # 更新指纹映射
                    if src_fp:
                        fingerprint_map[src_fp] = dst_path
                    return True
                else:
                    # 目标文件已存在，检查指纹
                    dst_fp = compute_file_fingerprint(dst_path)
                    if dst_fp == src_fp:
                        return True
                    else:
                        # 文件名相同但指纹不同，覆盖复制
                        shutil.copy2(src_path, dst_path)
                        if src_fp:
                            fingerprint_map[src_fp] = dst_path
                        return True
            except Exception:
                return False

        for root, dirs, files in os.walk(src_dir):
            rel = os.path.relpath(root, src_dir)
            dst_root = dst_dir if rel == "." else (dst_dir / rel)
            try:
                dst_root.mkdir(parents=True, exist_ok=True)
            except Exception:
                pass

            # 创建目录（保持原始结构）
            for d in dirs:
                try:
                    (dst_root / d).mkdir(exist_ok=True)
                except Exception:
                    pass

            for fn in files:
                sp = Path(root) / fn
                dp = dst_root / fn
                futs.add(_IO_EXECUTOR.submit(submit_copy, sp, dp))
                _wait_some(futs, inflight)

        # 等待所有任务完成
        for _ in concurrent.futures.as_completed(futs):
            pass

        return str(dst_dir)
    except Exception:
        return None

# =============================================================================
#  文件夹统计（缓存 + 并发递归目录大小）
# =============================================================================


def get_folder_info(folder_path: str) -> Dict[str, Any]:
    if not folder_path or not isinstance(folder_path, str):
        return {"success": False, "error": "empty path"}
    if not os.path.exists(folder_path) or not os.path.isdir(folder_path):
        return {"success": False, "error": "path not a directory"}

    now_ts = time.time()

    entry = _folder_cache.get(folder_path)
    if entry:
        ts, data = entry
        if now_ts - ts < FOLDER_INFO_CACHE_TTL:
            _folder_cache.move_to_end(folder_path, last=True)
            return data

    total_size = 0
    ext_counts: Dict[str, int] = {}
    files: List[Dict[str, Any]] = []
    dirs: List[Dict[str, Any]] = []

    def calc_size_recursive(p: str) -> int:
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
            for e in it:
                try:
                    st = e.stat(follow_symlinks=False)
                    item = {"name": e.name, "path": e.path,
                            "mtime": st.st_mtime}
                    if e.is_file(follow_symlinks=False):
                        item["size"] = st.st_size
                        total_size += st.st_size
                        files.append(item)
                        _, ext = os.path.splitext(e.name)
                        key = ext[1:].lower() if ext else ""
                        ext_counts[key] = ext_counts.get(key, 0) + 1
                    elif e.is_dir(follow_symlinks=False):
                        dirs.append(item)
                except (OSError, PermissionError):
                    pass

        futures = {_FOLDER_EXECUTOR.submit(
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

    _folder_cache[folder_path] = (now_ts, result_data)
    _folder_cache.move_to_end(folder_path, last=True)
    while len(_folder_cache) > FOLDER_INFO_CACHE_MAX:
        _folder_cache.popitem(last=False)

    return result_data

# =============================================================================
#  Windows clipboard handlers
# =============================================================================


def _html_has_media_hint(fragment_html: str) -> bool:
    if not fragment_html:
        return False
    s = fragment_html.lower()
    return ("<img" in s) or ("<video" in s) or ("<source" in s)


def handle_windows_pywin32(wcb, wcon, output_dir: Path) -> Optional[Dict[str, Any]]:
    """
    优先级：纯文本 > 文件 > 文件夹 > 截图DIB > HTML富文本
    注意：文件夹会被完整复制到 output_dir（重要增强）
    """
    try:
        wcb.OpenClipboard()
        try:
            # 嗅探
            has_files = wcb.IsClipboardFormatAvailable(wcon.CF_HDROP)
            has_text = (
                wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT) or
                wcb.IsClipboardFormatAvailable(wcon.CF_TEXT)
            )

            dibv5_format = getattr(wcon, "CF_DIBV5", 17)
            has_dib = (
                wcb.IsClipboardFormatAvailable(dibv5_format) or
                wcb.IsClipboardFormatAvailable(wcon.CF_DIB)
            )

            fmt_html = None
            has_html = False
            try:
                fmt_html = wcb.RegisterClipboardFormat("HTML Format")
                if fmt_html and wcb.IsClipboardFormatAvailable(fmt_html):
                    has_html = True
            except Exception:
                pass

            # 1) 纯文本（只有文本才走）
            if has_text and (not has_files) and (not has_dib) and (not has_html):
                try:
                    if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT):
                        text = wcb.GetClipboardData(wcon.CF_UNICODETEXT)
                        if isinstance(text, str) and text.strip():
                            return {"type": "text", "text": text}
                    if wcb.IsClipboardFormatAvailable(wcon.CF_TEXT):
                        b = wcb.GetClipboardData(wcon.CF_TEXT)
                        if b:
                            text = bytes_from_pywin32_blob(
                                b).decode("gbk", "ignore")
                            if text.strip():
                                return {"type": "text", "text": text}
                except Exception:
                    pass

            # 2/3) 文件/文件夹（CF_HDROP）
            if has_files:
                paths = wcb.GetClipboardData(wcon.CF_HDROP) or []
                src_dirs: List[Path] = []
                src_files: List[Path] = []
                for fp in paths:
                    try:
                        p = Path(fp)
                        if p.exists():
                            if p.is_dir():
                                src_dirs.append(p)
                            elif p.is_file():
                                src_files.append(p)
                    except Exception:
                        pass

                copied_dirs: List[str] = []
                copied_files: List[str] = []

                if src_dirs:
                    for d in src_dirs:
                        dst = copytree_parallel(d, output_dir)
                        if dst:
                            copied_dirs.append(dst)

                if src_files:
                    copied_files = copy_files_parallel(src_files, output_dir)

                # 返回（尽量兼容旧消费：给 text 也给结构化字段）
                if copied_dirs and not copied_files:
                    return {
                        "type": "folder_text",
                        "text": "\n".join(copied_dirs),
                        "folders": copied_dirs,
                    }

                if copied_files and not copied_dirs:
                    if len(copied_files) == 1 and is_image_ext(Path(copied_files[0]).suffix):
                        return {"type": "image", "path": copied_files[0]}
                    return {"type": "file", "files": copied_files} if len(copied_files) > 1 else {"type": "file", "path": copied_files[0]}

                if copied_dirs or copied_files:
                    return {
                        "type": "file_folder",
                        "folders": copied_dirs,
                        "files": copied_files,
                        "text": "\n".join(copied_dirs) if copied_dirs else "",
                    }

            # 4) DIB 截图（没有 HTML 时优先；有 HTML 时通常来自浏览器，先让 HTML 决定）
            if has_dib and not has_html:
                try:
                    from PIL import Image
                    import io
                except ImportError:
                    pass
                else:
                    dib_formats = []
                    if wcb.IsClipboardFormatAvailable(dibv5_format):
                        dib_formats.append(dibv5_format)
                    if wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
                        dib_formats.append(wcon.CF_DIB)

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

            # 5) HTML 富文本
            if has_html and fmt_html:
                # 先拿 fragment，做 media hint（避免无媒体还去做完整 materialize）
                try:
                    raw = wcb.GetClipboardData(fmt_html)
                    cf_text = raw if isinstance(raw, str) else bytes_from_pywin32_blob(
                        raw).decode("utf-8", "ignore")
                    frag, source_url = _extract_cf_html_fragment(cf_text)
                    if frag:
                        # 如果没有媒体 hint，直接回落到 UNICODETEXT（最快）
                        if not _html_has_media_hint(frag) and has_text:
                            try:
                                if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT):
                                    t = wcb.GetClipboardData(
                                        wcon.CF_UNICODETEXT)
                                    if isinstance(t, str) and t.strip():
                                        return {"type": "text", "text": t}
                            except Exception:
                                pass

                        blocks0 = html_to_blocks(frag)
                        has_media = any(b.get("type") ==
                                        "media" for b in blocks0)

                        if has_media:
                            blocks = materialize_html_blocks(
                                blocks0, output_dir, source_url)
                            if blocks and any(b.get("type") == "media" for b in blocks):
                                return {"type": "html_blocks", "blocks": blocks, "source_url": source_url or ""}

                        # 没媒体（或媒体失败）→ 文本
                        texts = [b.get("text", "")
                                 for b in blocks0 if b.get("type") == "text"]
                        t = "\n\n".join([x for x in texts if x])
                        if t.strip():
                            return {"type": "text", "text": t}
                except Exception:
                    pass

            # 兜底：如果还有 DIB
            if has_dib:
                try:
                    from PIL import Image
                    import io
                except ImportError:
                    return None
                dib_formats = []
                if wcb.IsClipboardFormatAvailable(dibv5_format):
                    dib_formats.append(dibv5_format)
                if wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
                    dib_formats.append(wcon.CF_DIB)

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


def handle_windows_ctypes(output_dir: Path) -> Dict[str, Any]:
    if not OpenClipboard(None):
        return {"error": "Cannot open clipboard"}

    try:
        has_files = IsClipboardFormatAvailable(CF_HDROP)
        has_text = IsClipboardFormatAvailable(
            CF_UNICODETEXT) or IsClipboardFormatAvailable(CF_TEXT)
        has_dib = IsClipboardFormatAvailable(
            CF_DIBV5) or IsClipboardFormatAvailable(CF_DIB)

        fmt_html = None
        has_html = False
        try:
            fmt_html = RegisterClipboardFormatW("HTML Format")
            if fmt_html and IsClipboardFormatAvailable(fmt_html):
                has_html = True
        except Exception:
            pass

        # 1) 纯文本
        if has_text and (not has_files) and (not has_dib) and (not has_html):
            try:
                if IsClipboardFormatAvailable(CF_UNICODETEXT):
                    h_mem = GetClipboardData(CF_UNICODETEXT)
                    if h_mem:
                        ptr = GlobalLock(h_mem)
                        if ptr:
                            try:
                                text = ctypes.wstring_at(ptr)
                                if text and text.strip():
                                    return {"type": "text", "text": text}
                            finally:
                                GlobalUnlock(h_mem)
            except Exception:
                pass

        # 2/3) 文件/文件夹
        if has_files:
            h_drop = GetClipboardData(CF_HDROP)
            if h_drop:
                count = DragQueryFileW(h_drop, 0xFFFFFFFF, None, 0)
                buf = ctypes.create_unicode_buffer(4096)
                paths = []
                for i in range(count):
                    DragQueryFileW(h_drop, i, buf, 4096)
                    paths.append(buf.value)

                src_dirs: List[Path] = []
                src_files: List[Path] = []
                for fp in paths:
                    try:
                        p = Path(fp)
                        if p.exists():
                            if p.is_dir():
                                src_dirs.append(p)
                            elif p.is_file():
                                src_files.append(p)
                    except Exception:
                        pass

                copied_dirs: List[str] = []
                copied_files: List[str] = []

                if src_dirs:
                    for d in src_dirs:
                        dst = copytree_parallel(d, output_dir)
                        if dst:
                            copied_dirs.append(dst)

                if src_files:
                    copied_files = copy_files_parallel(src_files, output_dir)

                if copied_dirs and not copied_files:
                    return {
                        "type": "folder_text",
                        "text": "\n".join(copied_dirs),
                        "folders": copied_dirs,
                    }

                if copied_files and not copied_dirs:
                    if len(copied_files) == 1 and is_image_ext(Path(copied_files[0]).suffix):
                        return {"type": "image", "path": copied_files[0]}
                    return {"type": "file", "files": copied_files} if len(copied_files) > 1 else {"type": "file", "path": copied_files[0]}

                if copied_dirs or copied_files:
                    return {
                        "type": "file_folder",
                        "folders": copied_dirs,
                        "files": copied_files,
                        "text": "\n".join(copied_dirs) if copied_dirs else "",
                    }

        # 4) DIB（没有 HTML 时先处理）
        if has_dib and not has_html:
            try:
                from PIL import Image
                import io
            except ImportError:
                pass
            else:
                dib_formats = []
                if IsClipboardFormatAvailable(CF_DIBV5):
                    dib_formats.append(CF_DIBV5)
                if IsClipboardFormatAvailable(CF_DIB):
                    dib_formats.append(CF_DIB)

                for fmt in dib_formats:
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

        # 5) HTML
        if has_html and fmt_html:
            try:
                h_mem = GetClipboardData(fmt_html)
                if h_mem:
                    raw = read_global_data(h_mem)
                    if raw:
                        frag, source_url = _extract_cf_html_fragment(raw)
                        if frag:
                            if not _html_has_media_hint(frag) and has_text:
                                # 直接回落到 UNICODETEXT
                                try:
                                    if IsClipboardFormatAvailable(CF_UNICODETEXT):
                                        h_mem2 = GetClipboardData(
                                            CF_UNICODETEXT)
                                        if h_mem2:
                                            ptr2 = GlobalLock(h_mem2)
                                            if ptr2:
                                                try:
                                                    text = ctypes.wstring_at(
                                                        ptr2)
                                                    if text and text.strip():
                                                        return {"type": "text", "text": text}
                                                finally:
                                                    GlobalUnlock(h_mem2)
                                except Exception:
                                    pass

                            blocks0 = html_to_blocks(frag)
                            has_media = any(b.get("type") ==
                                            "media" for b in blocks0)

                            if has_media:
                                blocks = materialize_html_blocks(
                                    blocks0, output_dir, source_url)
                                if blocks and any(b.get("type") == "media" for b in blocks):
                                    return {"type": "html_blocks", "blocks": blocks, "source_url": source_url or ""}

                            texts = [b.get("text", "")
                                     for b in blocks0 if b.get("type") == "text"]
                            t = "\n\n".join([x for x in texts if x])
                            if t.strip():
                                return {"type": "text", "text": t}
            except Exception:
                pass

        # 兜底 DIB
        if has_dib:
            try:
                from PIL import Image
                import io
            except ImportError:
                return {"type": "unknown"}

            dib_formats = []
            if IsClipboardFormatAvailable(CF_DIBV5):
                dib_formats.append(CF_DIBV5)
            if IsClipboardFormatAvailable(CF_DIB):
                dib_formats.append(CF_DIB)

            for fmt in dib_formats:
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

        return {"type": "unknown"}

    finally:
        try:
            CloseClipboard()
        except Exception:
            pass


def handle_windows(output_dir: Path) -> Dict[str, Any]:
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

# =============================================================================
#  macOS / Linux (保持原逻辑，尽量快)
# =============================================================================


def handle_macos(output_dir: Path) -> Dict[str, Any]:
    import subprocess

    # HTML（如果有）
    try:
        html_proc = subprocess.run(
            ["pbpaste", "-Prefer", "html"], capture_output=True, timeout=2)
        if html_proc.stdout:
            html_text = html_proc.stdout.decode("utf-8", "ignore")
            if "<" in html_text and ">" in html_text:
                blocks0 = html_to_blocks(html_text)
                has_media = any(b.get("type") == "media" for b in blocks0)
                if has_media:
                    blocks = materialize_html_blocks(blocks0, output_dir, None)
                    if blocks and any(b.get("type") == "media" for b in blocks):
                        return {"type": "html_blocks", "blocks": blocks, "source_url": ""}
                texts = [b.get("text", "")
                         for b in blocks0 if b.get("type") == "text"]
                t = "\n\n".join([x for x in texts if x])
                if t.strip():
                    return {"type": "text", "text": t}
    except Exception:
        pass

    # PNG 图片
    try:
        check_proc = subprocess.run(
            ["pbpaste", "-Prefer", "png"], capture_output=True, timeout=2)
        if check_proc.stdout:
            fname = get_timestamp_filename(".png")
            out_path = unique_path_in_dir(output_dir, fname)
            ensure_parent(out_path)
            with open(out_path, "wb") as f:
                f.write(check_proc.stdout)
            if out_path.exists() and out_path.stat().st_size > 0:
                return {"type": "image", "path": str(out_path)}
    except Exception:
        pass

    # 纯文本
    try:
        txt_proc = subprocess.run(
            ["pbpaste"], capture_output=True, timeout=1.2)
        if txt_proc.stdout:
            t = txt_proc.stdout.decode("utf-8", "ignore")
            if t.strip():
                return {"type": "text", "text": t}
    except Exception:
        pass

    return {"type": "unknown"}


def handle_linux(output_dir: Path) -> Dict[str, Any]:
    import subprocess

    # HTML（如果有）
    try:
        targets_proc = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
            capture_output=True, text=True, timeout=2
        )
        targets = targets_proc.stdout or ""
        if "text/html" in targets:
            html_proc = subprocess.run(
                ["xclip", "-selection", "clipboard", "-t", "text/html", "-o"],
                capture_output=True, timeout=3
            )
            if html_proc.stdout:
                html_text = html_proc.stdout.decode("utf-8", "ignore")
                if "<" in html_text and ">" in html_text:
                    blocks0 = html_to_blocks(html_text)
                    has_media = any(b.get("type") == "media" for b in blocks0)
                    if has_media:
                        blocks = materialize_html_blocks(
                            blocks0, output_dir, None)
                        if blocks and any(b.get("type") == "media" for b in blocks):
                            return {"type": "html_blocks", "blocks": blocks, "source_url": ""}
                    texts = [b.get("text", "")
                             for b in blocks0 if b.get("type") == "text"]
                    t = "\n\n".join([x for x in texts if x])
                    if t.strip():
                        return {"type": "text", "text": t}
    except Exception:
        pass

    # PNG 图片
    try:
        targets_proc = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
            capture_output=True, text=True, timeout=2
        )
        if "image/png" in (targets_proc.stdout or ""):
            fname = get_timestamp_filename(".png")
            out_path = unique_path_in_dir(output_dir, fname)
            ensure_parent(out_path)
            with open(out_path, "wb") as f:
                subprocess.run(
                    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
                    stdout=f, stderr=subprocess.DEVNULL, check=True, timeout=5
                )
            if out_path.exists() and out_path.stat().st_size > 0:
                return {"type": "image", "path": str(out_path)}
    except Exception:
        pass

    # 纯文本
    try:
        text_proc = subprocess.run(
            ["xclip", "-selection", "clipboard", "-o"],
            capture_output=True, text=True, timeout=2
        )
        text = text_proc.stdout or ""
        if text.strip():
            return {"type": "text", "text": text}
    except Exception:
        pass

    return {"type": "unknown"}

# =============================================================================
#  统一入口
# =============================================================================


def handle_clipboard(target_dir: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
    output_dir = resolve_output_dir(target_dir)
    sys_name = platform.system()
    if sys_name == "Windows":
        return handle_windows(output_dir)
    if sys_name == "Darwin":
        return handle_macos(output_dir)
    if sys_name == "Linux":
        return handle_linux(output_dir)
    return {"type": "unknown"}


def handle_clipboard_peek() -> Dict[str, Any]:
    """快速嗅探，不写入"""
    result = {"type": "peek", "has_html": False,
              "has_files": False, "has_image": False, "has_text": False}
    sys_name = platform.system()

    if sys_name == "Windows":
        # pywin32
        try:
            import win32clipboard as wcb
            import win32con as wcon
            wcb.OpenClipboard()
            try:
                try:
                    fmt_html = wcb.RegisterClipboardFormat("HTML Format")
                    if fmt_html and wcb.IsClipboardFormatAvailable(fmt_html):
                        result["has_html"] = True
                except Exception:
                    pass

                try:
                    if wcb.IsClipboardFormatAvailable(wcon.CF_HDROP):
                        result["has_files"] = True
                except Exception:
                    pass

                try:
                    dibv5_format = getattr(wcon, "CF_DIBV5", 17)
                    if wcb.IsClipboardFormatAvailable(dibv5_format) or wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
                        result["has_image"] = True
                except Exception:
                    pass

                try:
                    if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT) or wcb.IsClipboardFormatAvailable(wcon.CF_TEXT):
                        result["has_text"] = True
                except Exception:
                    pass
            finally:
                try:
                    wcb.CloseClipboard()
                except Exception:
                    pass
            return result
        except Exception:
            pass

        # ctypes fallback
        try:
            if not OpenClipboard(None):
                return result
            try:
                try:
                    fmt_html = RegisterClipboardFormatW("HTML Format")
                    if fmt_html and IsClipboardFormatAvailable(fmt_html):
                        result["has_html"] = True
                except Exception:
                    pass
                try:
                    if IsClipboardFormatAvailable(CF_HDROP):
                        result["has_files"] = True
                except Exception:
                    pass
                try:
                    if IsClipboardFormatAvailable(CF_DIBV5) or IsClipboardFormatAvailable(CF_DIB):
                        result["has_image"] = True
                except Exception:
                    pass
                try:
                    if IsClipboardFormatAvailable(CF_UNICODETEXT) or IsClipboardFormatAvailable(CF_TEXT):
                        result["has_text"] = True
                except Exception:
                    pass
            finally:
                try:
                    CloseClipboard()
                except Exception:
                    pass
            return result
        except Exception:
            return result

    if sys_name == "Darwin":
        try:
            import subprocess
            html_proc = subprocess.run(
                ["pbpaste", "-Prefer", "html"], capture_output=True, timeout=1.2)
            if html_proc.stdout and b"<" in html_proc.stdout:
                result["has_html"] = True
        except Exception:
            pass
        try:
            import subprocess
            txt_proc = subprocess.run(
                ["pbpaste"], capture_output=True, timeout=0.8)
            if txt_proc.stdout:
                result["has_text"] = True
        except Exception:
            pass
        return result

    if sys_name == "Linux":
        try:
            import subprocess
            targets_proc = subprocess.run(
                ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
                capture_output=True, text=True, timeout=1.2
            )
            targets = targets_proc.stdout or ""
            if "text/html" in targets:
                result["has_html"] = True
            if any(x in targets for x in ["image/png", "image/jpeg", "image/bmp", "image/webp", "image/gif"]):
                result["has_image"] = True
            if any(x in targets for x in ["UTF8_STRING", "text/plain", "STRING"]):
                result["has_text"] = True
        except Exception:
            pass
        return result

    return result

# =============================================================================
#  Daemon mode (stdin/stdout JSON lines)
# =============================================================================


def _dispatch_action(cmd: Dict[str, Any]) -> Dict[str, Any]:
    """
    兼容 A & Q 两种协议：
      - A: action, _id, target_dir/path...
      - Q: cmd, output_dir/path...
    """
    # 请求 ID
    request_id = cmd.get("_id", cmd.get("id", 0))
    out: Dict[str, Any] = {"_id": request_id}

    action = cmd.get("action")
    if not action:
        action = cmd.get("cmd")  # Q 协议

    # 命令映射
    if action in ("ping",):
        out["status"] = "alive"
        out["pong"] = True
        return out

    if action in ("clipboard_peek", "peek"):
        out.update(handle_clipboard_peek())
        return out

    if action in ("clipboard", "paste"):
        target_dir = cmd.get("target_dir", cmd.get("output_dir"))
        out.update(handle_clipboard(target_dir))
        return out

    if action in ("folder_info", "get_folder_info"):
        folder_path = cmd.get("path", "")
        out.update(get_folder_info(folder_path))
        return out

    out["success"] = False
    out["error"] = f"unknown action: {action}"
    return out


def daemon_mode():
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    for line in sys.stdin:
        line = (line or "").strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"_id": 0, "success": False,
                  "error": "JSON parse error"}, ensure_ascii=False), flush=True)
            continue
        try:
            res = _dispatch_action(cmd)
        except Exception as e:
            res = {"_id": cmd.get("_id", 0), "success": False, "error": str(e)}
        print(json.dumps(res, ensure_ascii=False), flush=True)

# =============================================================================
#  CLI
# =============================================================================


def main():
    # 兼容：
    #   --daemon
    #   daemon
    #   clipboard [target_dir]
    #   paste <output_dir>
    #   clipboard_peek
    #   folder_info <path>
    #   get_folder_info <path>
    if len(sys.argv) > 1:
        cmd = sys.argv[1].strip()

        if cmd in ("--daemon", "daemon"):
            daemon_mode()
            return

        if cmd in ("folder_info", "get_folder_info") and len(sys.argv) >= 3:
            res = get_folder_info(sys.argv[2])
            print(json.dumps(res, ensure_ascii=False), flush=True)
            return

        if cmd in ("clipboard_peek", "peek"):
            res = handle_clipboard_peek()
            print(json.dumps(res, ensure_ascii=False), flush=True)
            return

        if cmd in ("clipboard",):
            target_dir = sys.argv[2] if len(sys.argv) >= 3 else None
            res = handle_clipboard(target_dir)
            print(json.dumps(res, ensure_ascii=False), flush=True)
            return

        if cmd in ("paste",):
            if len(sys.argv) < 3:
                print(json.dumps({"error": "缺少输出目录参数"},
                      ensure_ascii=False), flush=True)
                sys.exit(1)
            res = handle_clipboard(sys.argv[2])
            print(json.dumps(res, ensure_ascii=False), flush=True)
            return

    # 默认：取剪贴板，输出到默认目录
    try:
        res = handle_clipboard()
        print(json.dumps(res, ensure_ascii=False), flush=True)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)},
              ensure_ascii=False), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()

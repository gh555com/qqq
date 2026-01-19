# -*- coding: utf-8 -*-
#   - 极简模式：只负责读取系统剪贴板并保存到指定目录（dumb saver）
#   - 移除所有指纹计算、去重逻辑
#   - 移除 HTML 解析逻辑（由 Node.js 侧处理）
#   - 仅处理：纯文本、文件复制、原生图片保存
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
# =============================================================================
#  配置
# =============================================================================
# 线程池（全局复用）
_MAX_WORKERS = min(32, max(4, (os.cpu_count() or 4) * 2))
_IO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=_MAX_WORKERS)
# =============================================================================
#  工具：路径/文件名
# =============================================================================


def resolve_output_dir(target_dir) -> Path:
    if target_dir:
        return Path(target_dir)
    return Path("./qqq")


def ensure_parent(path_obj: Path):
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
    return f"{prefix_code}_{date_part}__[{weekday_number}]__{time_part}{ext}"


def safe_filename(name: str) -> str:
    if not name:
        return get_timestamp_filename(".bin")
    n = str(name).strip().replace("\x00", "")
    n = re.sub(r'[<>:"/\\\\|?*]+', "_", n)
    n = n.strip(" .\t\r\n")
    if not n:
        return get_timestamp_filename(".bin")
    if len(n) > 180:
        stem = Path(n).stem[:160]
        ext = Path(n).suffix
        n = stem + ext
    return n


def unique_path_in_dir(output_dir: Path, name: str) -> Path:
    # 简单的重命名策略，防止覆盖（虽然 Node 侧会再次处理，但这里防止同一次操作内的冲突）
    base = output_dir / name
    if not base.exists():
        return base
    stem = base.stem
    ext = base.suffix
    for i in range(1, 1000):
        new_name = f"{stem}_{i}{ext}"
        new_path = output_dir / new_name
        if not new_path.exists():
            return new_path
    return base


def is_image_ext(ext: str) -> bool:
    return (ext or "").lower() in {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".ico", ".svg"
    }


# =============================================================================
#  Windows API (ctypes)
# =============================================================================
_IS_WINDOWS = platform.system() == "Windows"
if _IS_WINDOWS:
    user32 = ctypes.windll.user32
    shell32 = ctypes.windll.shell32
    kernel32 = ctypes.windll.kernel32
    gdi32 = ctypes.windll.gdi32
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
    EmptyClipboard = user32.EmptyClipboard
    EmptyClipboard.argtypes = []
    EmptyClipboard.restype = wintypes.BOOL
    SetClipboardData = user32.SetClipboardData
    SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    SetClipboardData.restype = wintypes.HANDLE
    GlobalAlloc = kernel32.GlobalAlloc
    GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    GlobalAlloc.restype = wintypes.HGLOBAL

    class DROPFILES(ctypes.Structure):
        _fields_ = [
            ("pFiles", wintypes.DWORD),
            ("pt", wintypes.POINT),
            ("fNC", wintypes.BOOL),
            ("fWide", wintypes.BOOL),
        ]

    GMEM_MOVEABLE = 0x0002
    GMEM_ZEROINIT = 0x0040

    # For Icon Extraction
    class SHFILEINFOW(ctypes.Structure):
        _fields_ = [
            ("hIcon", wintypes.HICON),
            ("iIcon", ctypes.c_int),
            ("dwAttributes", wintypes.DWORD),
            ("szDisplayName", wintypes.WCHAR * 260),
            ("szTypeName", wintypes.WCHAR * 80),
        ]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [
            ("bmiHeader", BITMAPINFOHEADER),
            ("bmiColors", wintypes.DWORD * 3),
        ]

    DrawIconEx = user32.DrawIconEx
    DrawIconEx.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.HICON,
                           ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.HBRUSH, wintypes.UINT]
    DrawIconEx.restype = wintypes.BOOL

    DestroyIcon = user32.DestroyIcon
    DestroyIcon.argtypes = [wintypes.HICON]
    DestroyIcon.restype = wintypes.BOOL

    GetDC = user32.GetDC
    GetDC.argtypes = [wintypes.HWND]
    GetDC.restype = wintypes.HDC

    ReleaseDC = user32.ReleaseDC
    ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    ReleaseDC.restype = ctypes.c_int

    CreateCompatibleDC = gdi32.CreateCompatibleDC
    CreateCompatibleDC.argtypes = [wintypes.HDC]
    CreateCompatibleDC.restype = wintypes.HDC

    DeleteDC = gdi32.DeleteDC
    DeleteDC.argtypes = [wintypes.HDC]
    DeleteDC.restype = wintypes.BOOL

    DeleteObject = gdi32.DeleteObject
    DeleteObject.argtypes = [wintypes.HGDIOBJ]
    DeleteObject.restype = wintypes.BOOL

    SelectObject = gdi32.SelectObject
    SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    SelectObject.restype = wintypes.HGDIOBJ

    CreateDIBSection = gdi32.CreateDIBSection
    CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p,
                                 wintypes.UINT, ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
    CreateDIBSection.restype = wintypes.HBITMAP


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
#  PIL 保存：PNG
# =============================================================================


def save_image_as_png(img, path: Path):
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
    elif img.mode not in ("RGB",):
        img = img.convert("RGB")
    img.save(str(path), format="PNG", compress_level=6)
# =============================================================================
#  DIB / DIBV5 转 BMP
# =============================================================================


def dib_to_bmp_bytes(dib: bytes) -> bytes:
    if not dib or len(dib) < 16:
        raise ValueError("DIB data too small")
    header_size = int.from_bytes(dib[0:4], "little", signed=False)
    if header_size < 12 or header_size > len(dib):
        raise ValueError(f"Invalid DIB header size: {header_size}")
    if header_size == 12:
        bpp = int.from_bytes(dib[10:12], "little", signed=False)
        compression = 0
        colors_used = 0
        palette_entry_size = 3
    else:
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
    file_header += (0).to_bytes(4, "little", signed=False)
    file_header += bf_off_bits.to_bytes(4, "little", signed=False)
    return file_header + dib
# =============================================================================
#  文件复制 (Dumb Copy)
# =============================================================================


def _wait_some(futs: set, target_inflight: int):
    if len(futs) <= target_inflight:
        return
    done, _ = concurrent.futures.wait(
        futs, return_when=concurrent.futures.FIRST_COMPLETED)
    futs.difference_update(done)


def copy_files_parallel(src_files: list, output_dir: Path) -> list:
    if not src_files:
        return []
    ensure_parent(output_dir / "dummy")
    results = []
    futs = set()
    inflight = max(64, _MAX_WORKERS * 16)

    def submit_one(src: Path) -> Path:
        try:
            fname = safe_filename(src.name)
            dst = unique_path_in_dir(output_dir, fname)
            ensure_parent(dst)
            shutil.copy2(src, dst)
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


def copytree_parallel(src_dir: Path, output_dir: Path) -> str:
    try:
        if not src_dir.exists() or not src_dir.is_dir():
            return None
        ensure_parent(output_dir / "dummy")
        dst_dir = output_dir / safe_filename(src_dir.name)
        # 如果目录存在，生成唯一名
        if dst_dir.exists():
            dst_dir = unique_path_in_dir(
                output_dir, safe_filename(src_dir.name))
        dst_dir.mkdir(parents=True, exist_ok=True)
        futs = set()
        inflight = max(128, _MAX_WORKERS * 32)

        def submit_copy(src_path: Path, dst_path: Path):
            try:
                ensure_parent(dst_path)
                shutil.copy2(src_path, dst_path)
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
        for _ in concurrent.futures.as_completed(futs):
            pass
        return str(dst_dir)
    except Exception:
        return None
# =============================================================================
#  文件夹统计
# =============================================================================


def get_folder_info(folder_path: str):
    if not folder_path or not isinstance(folder_path, str):
        return {"success": False, "error": "empty path"}
    if not os.path.exists(folder_path) or not os.path.isdir(folder_path):
        return {"success": False, "error": "path not a directory"}
    total_size = 0
    file_count = 0
    ext_counts = {}
    try:
        for root, _, files in os.walk(folder_path):
            for f in files:
                try:
                    p = Path(root) / f
                    s = p.stat().st_size
                    total_size += s
                    file_count += 1
                    ext = p.suffix.lower().replace(".", "") or "no_ext"
                    ext_counts[ext] = ext_counts.get(ext, 0) + 1
                except:
                    pass
    except Exception as e:
        return {"success": False, "error": str(e)}
    return {
        "success": True,
        "total_size": total_size,
        "file_count_root": file_count,
        "ext_stats": ext_counts
    }
# =============================================================================
#  Windows clipboard handlers
# =============================================================================


def handle_windows_pywin32(wcb, wcon, output_dir: Path):
    # ★ 阶段 1：只读取数据，必须毫秒级完成，立即释放锁
    data_to_process = None  # {type: 'text'|'files'|'dib', payload: ...}
    try:
        wcb.OpenClipboard()
        try:
            has_files = wcb.IsClipboardFormatAvailable(wcon.CF_HDROP)
            has_text = (wcb.IsClipboardFormatAvailable(
                wcon.CF_UNICODETEXT) or wcb.IsClipboardFormatAvailable(wcon.CF_TEXT))
            dibv5_format = getattr(wcon, "CF_DIBV5", 17)
            has_dib = (wcb.IsClipboardFormatAvailable(dibv5_format)
                       or wcb.IsClipboardFormatAvailable(wcon.CF_DIB))
            # 1) 纯文本
            if has_text and not has_files and not has_dib:
                try:
                    if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT):
                        text = wcb.GetClipboardData(wcon.CF_UNICODETEXT)
                        if isinstance(text, str) and text.strip():
                            data_to_process = {"type": "text", "text": text}
                except Exception:
                    pass
            # 2) 文件/文件夹 (只读取路径，不复制文件！)
            elif has_files:
                try:
                    paths = wcb.GetClipboardData(wcon.CF_HDROP) or []
                    # 确保是列表且非空
                    if paths:
                        data_to_process = {
                            "type": "files", "paths": list(paths)}
                except:
                    pass
            # 3) DIB 截图 (读取 Buffer 到内存，不保存图片！)
            elif has_dib:
                try:
                    dib_formats = []
                    if wcb.IsClipboardFormatAvailable(dibv5_format):
                        dib_formats.append(dibv5_format)
                    if wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
                        dib_formats.append(wcon.CF_DIB)
                    for fmt in dib_formats:
                        dib_obj = wcb.GetClipboardData(fmt)
                        dib = bytes_from_pywin32_blob(dib_obj)
                        if dib:
                            data_to_process = {"type": "dib", "data": dib}
                            break
                except:
                    pass
        finally:
            # ★ 必须立即关闭剪贴板！
            wcb.CloseClipboard()
    except Exception:
        pass
    # ★ 阶段 2：在锁外处理数据 (耗时操作)
    if not data_to_process:
        return None
    try:
        if data_to_process["type"] == "text":
            return {"type": "text", "text": data_to_process["text"]}
        if data_to_process["type"] == "files":
            paths = data_to_process["paths"]
            src_dirs = []
            src_files = []
            for fp in paths:
                try:
                    p = Path(fp)
                    if p.exists():
                        if p.is_dir():
                            src_dirs.append(p)
                        elif p.is_file():
                            src_files.append(p)
                except:
                    pass
            copied_dirs = []
            copied_files = []
            if src_dirs:
                for d in src_dirs:
                    dst = copytree_parallel(d, output_dir)
                    if dst:
                        copied_dirs.append(dst)
            if src_files:
                copied_files = copy_files_parallel(src_files, output_dir)
            if copied_dirs or copied_files:
                return {
                    "type": "file_folder",
                    "folders": copied_dirs,
                    "files": copied_files,
                }
            return None  # 只有空路径或不存在的路径
        if data_to_process["type"] == "dib":
            try:
                from PIL import Image
                import io
                dib = data_to_process["data"]
                bmp = dib_to_bmp_bytes(dib)
                img = Image.open(io.BytesIO(bmp))
                fname = get_timestamp_filename(".png")
                out_path = unique_path_in_dir(output_dir, fname)
                ensure_parent(out_path)
                save_image_as_png(img, out_path)
                return {"type": "image", "path": str(out_path)}
            except Exception:
                return None
    except Exception:
        return None
    return None


def handle_windows_ctypes(output_dir: Path):
    # ★ 阶段 1：只读取数据，必须毫秒级完成，立即释放锁
    data_to_process = None
    if not OpenClipboard(None):
        return {"error": "Cannot open clipboard"}
    try:
        has_files = IsClipboardFormatAvailable(CF_HDROP)
        has_text = IsClipboardFormatAvailable(
            CF_UNICODETEXT) or IsClipboardFormatAvailable(CF_TEXT)
        has_dib = IsClipboardFormatAvailable(
            CF_DIBV5) or IsClipboardFormatAvailable(CF_DIB)
        if has_text and not has_files and not has_dib:
            try:
                if IsClipboardFormatAvailable(CF_UNICODETEXT):
                    h_mem = GetClipboardData(CF_UNICODETEXT)
                    if h_mem:
                        ptr = GlobalLock(h_mem)
                        if ptr:
                            try:
                                text = ctypes.wstring_at(ptr)
                                if text and text.strip():
                                    data_to_process = {
                                        "type": "text", "text": text}
                            finally:
                                GlobalUnlock(h_mem)
            except Exception:
                pass
        elif has_files:
            h_drop = GetClipboardData(CF_HDROP)
            if h_drop:
                count = DragQueryFileW(h_drop, 0xFFFFFFFF, None, 0)
                current_buf_len = 4096
                buf = ctypes.create_unicode_buffer(current_buf_len)
                paths = []
                for i in range(count):
                    needed_len = DragQueryFileW(h_drop, i, None, 0) + 1
                    if needed_len > current_buf_len:
                        current_buf_len = needed_len + 1024
                        buf = ctypes.create_unicode_buffer(current_buf_len)
                    DragQueryFileW(h_drop, i, buf, needed_len)
                    paths.append(buf.value)
                if paths:
                    data_to_process = {"type": "files", "paths": paths}
        elif has_dib:
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
                if dib:
                    data_to_process = {"type": "dib", "data": dib}
                    break
    finally:
        # ★ 必须立即关闭剪贴板！
        CloseClipboard()
    # ★ 阶段 2：在锁外处理数据 (耗时操作)
    if not data_to_process:
        return {"type": "unknown"}
    try:
        if data_to_process["type"] == "text":
            return {"type": "text", "text": data_to_process["text"]}
        if data_to_process["type"] == "files":
            paths = data_to_process["paths"]
            src_dirs = []
            src_files = []
            for fp in paths:
                try:
                    p = Path(fp)
                    if p.exists():
                        if p.is_dir():
                            src_dirs.append(p)
                        elif p.is_file():
                            src_files.append(p)
                except:
                    pass
            copied_dirs = []
            copied_files = []
            if src_dirs:
                for d in src_dirs:
                    dst = copytree_parallel(d, output_dir)
                    if dst:
                        copied_dirs.append(dst)
            if src_files:
                copied_files = copy_files_parallel(src_files, output_dir)
            if copied_dirs or copied_files:
                return {
                    "type": "file_folder",
                    "folders": copied_dirs,
                    "files": copied_files,
                }
            return {"type": "unknown"}
        if data_to_process["type"] == "dib":
            try:
                from PIL import Image
                import io
                dib = data_to_process["data"]
                bmp = dib_to_bmp_bytes(dib)
                img = Image.open(io.BytesIO(bmp))
                fname = get_timestamp_filename(".png")
                out_path = unique_path_in_dir(output_dir, fname)
                ensure_parent(out_path)
                save_image_as_png(img, out_path)
                return {"type": "image", "path": str(out_path)}
            except Exception:
                pass
    except:
        pass
    return {"type": "unknown"}


def handle_clipboard(target_dir=None):
    output_dir = resolve_output_dir(target_dir)
    sys_name = platform.system()
    if sys_name == "Windows":
        try:
            import win32clipboard as wcb
            import win32con as wcon
            res = handle_windows_pywin32(wcb, wcon, output_dir)
            if res:
                return res
        except:
            pass
        try:
            res = handle_windows_ctypes(output_dir)
            if res:
                return res
        except:
            pass
    return {"type": "unknown"}


def get_clipboard_files_only():
    sys_name = platform.system()
    if sys_name == "Windows":
        try:
            # 优先尝试 ctypes
            if OpenClipboard(None):
                try:
                    if IsClipboardFormatAvailable(CF_HDROP):
                        h_drop = GetClipboardData(CF_HDROP)
                        if h_drop:
                            count = DragQueryFileW(h_drop, 0xFFFFFFFF, None, 0)
                            paths = []
                            for i in range(count):
                                n = DragQueryFileW(h_drop, i, None, 0) + 1
                                buf = ctypes.create_unicode_buffer(n)
                                DragQueryFileW(h_drop, i, buf, n)
                                paths.append(buf.value)
                            return {"type": "file_paths", "paths": paths}
                finally:
                    CloseClipboard()
        except:
            pass
        # 备选 pywin32
        try:
            import win32clipboard as wcb
            import win32con as wcon
            wcb.OpenClipboard()
            try:
                if wcb.IsClipboardFormatAvailable(wcon.CF_HDROP):
                    paths = wcb.GetClipboardData(wcon.CF_HDROP) or []
                    return {"type": "file_paths", "paths": list(paths)}
            finally:
                wcb.CloseClipboard()
        except:
            pass
    return {"type": "unknown"}


def set_clipboard_text(text):
    if not _IS_WINDOWS or not text:
        return False
    try:
        if not OpenClipboard(None):
            return False
        EmptyClipboard()
        h_global = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, (len(text) + 1) * ctypes.sizeof(ctypes.c_wchar))
        ptr = GlobalLock(h_global)
        ctypes.memmove(ptr, text, len(text) * ctypes.sizeof(ctypes.c_wchar))
        GlobalUnlock(h_global)
        SetClipboardData(CF_UNICODETEXT, h_global)
        CloseClipboard()
        return True
    except:
        return False


def set_clipboard_files(paths):
    if not _IS_WINDOWS or not paths:
        return False
    try:
        # 构造 DROPFILES 结构
        files_str = "\0".join(paths) + "\0\0"
        files_bytes = files_str.encode("utf-16le")
        
        df = DROPFILES()
        df.pFiles = ctypes.sizeof(DROPFILES)
        df.fWide = True
        
        total_size = ctypes.sizeof(DROPFILES) + len(files_bytes)
        h_global = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_size)
        ptr = GlobalLock(h_global)
        
        ctypes.memmove(ptr, ctypes.byref(df), ctypes.sizeof(DROPFILES))
        ctypes.memmove(ctypes.c_void_p(ptr + ctypes.sizeof(DROPFILES)), files_bytes, len(files_bytes))
        
        GlobalUnlock(h_global)
        
        if not OpenClipboard(None):
            return False
        EmptyClipboard()
        SetClipboardData(CF_HDROP, h_global)
        CloseClipboard()
        return True
    except:
        return False


def set_clipboard_image(img_path):
    if not _IS_WINDOWS or not img_path or not os.path.exists(img_path):
        return False
    try:
        from PIL import Image
        import io
        img = Image.open(img_path)
        # 转换为 DIB
        output = io.BytesIO()
        img.convert("RGB").save(output, format="BMP")
        bmp_data = output.getvalue()
        # BMP 文件头是 14 字节，DIB 是去掉这 14 字节后的内容
        dib_data = bmp_data[14:]
        
        h_global = GlobalAlloc(GMEM_MOVEABLE, len(dib_data))
        ptr = GlobalLock(h_global)
        ctypes.memmove(ptr, dib_data, len(dib_data))
        GlobalUnlock(h_global)
        
        if not OpenClipboard(None):
            return False
        EmptyClipboard()
        SetClipboardData(CF_DIB, h_global)
        CloseClipboard()
        return True
    except Exception as e:
        sys.stderr.write(f"set_clipboard_image error: {e}\n")
        return False
# =============================================================================
#  Daemon / CLI
# =============================================================================


def get_file_icon_base64(file_path: str):
    if not _IS_WINDOWS:
        return None

    try:
        import io
        from PIL import Image

        # Constants for SHGetFileInfo
        SHGFI_ICON = 0x000000100
        SHGFI_SMALLICON = 0x000000001

        shfi = SHFILEINFOW()
        res = shell32.SHGetFileInfoW(
            str(file_path),
            0,
            ctypes.byref(shfi),
            ctypes.sizeof(shfi),
            SHGFI_ICON | SHGFI_SMALLICON
        )

        if not res or not shfi.hIcon:
            return None

        try:
            # We use a memory DC to draw the icon and then get its bits
            hdc_screen = GetDC(0)
            hdc_mem = CreateCompatibleDC(hdc_screen)

            width = 16
            height = 16

            bmi = BITMAPINFO()
            bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bmi.bmiHeader.biWidth = width
            bmi.bmiHeader.biHeight = -height  # Top-down
            bmi.bmiHeader.biPlanes = 1
            bmi.bmiHeader.biBitCount = 32
            bmi.bmiHeader.biCompression = 0  # BI_RGB

            ptr_bits = ctypes.c_void_p()
            hbmp_dib = CreateDIBSection(
                hdc_mem, ctypes.byref(bmi), 0, ctypes.byref(ptr_bits), None, 0)
            hold_bmp = SelectObject(hdc_mem, hbmp_dib)

            # Draw the icon
            DrawIconEx(hdc_mem, 0, 0, shfi.hIcon, width,
                       height, 0, None, 0x0003)  # DI_NORMAL

            # Copy bits to PIL
            size = width * height * 4
            buffer = (ctypes.c_char * size).from_address(ptr_bits.value)
            img = Image.frombuffer(
                "RGBA", (width, height), buffer, "raw", "BGRA", 0, 1)

            # Convert to PNG base64
            output = io.BytesIO()
            img.save(output, format="PNG")
            base64_str = base64.b64encode(output.getvalue()).decode("ascii")

            # Cleanup
            SelectObject(hdc_mem, hold_bmp)
            DeleteObject(hbmp_dib)
            DeleteDC(hdc_mem)
            ReleaseDC(0, hdc_screen)

            return base64_str

        finally:
            DestroyIcon(shfi.hIcon)

    except Exception as e:
        sys.stderr.write(f"extract_icon error: {e}\n")
        return None


def _dispatch_action(cmd):
    request_id = cmd.get("_id", cmd.get("id", 0))
    out = {"_id": request_id}
    action = cmd.get("action") or cmd.get("cmd")
    if action == "ping":
        out["status"] = "alive"
        return out
    if action == "extract_icon":
        path = cmd.get("path")
        if path:
            icon_b64 = get_file_icon_base64(path)
            if icon_b64:
                out["icon"] = icon_b64
                out["status"] = "ok"
            else:
                out["status"] = "error"
                out["message"] = "icon extraction failed"
        else:
            out["status"] = "error"
            out["message"] = "no path provided"
        return out
    if action == "set_clipboard":
        ctype = cmd.get("type")
        success = False
        if ctype == "text":
            success = set_clipboard_text(cmd.get("text"))
        elif ctype == "file" or ctype == "files":
            success = set_clipboard_files(cmd.get("files"))
        elif ctype == "image":
            success = set_clipboard_image(cmd.get("path"))
        out["success"] = success
        return out
    if action == "hasImage":
        out["value"] = IsClipboardFormatAvailable(CF_DIBV5) or IsClipboardFormatAvailable(CF_DIB)
        return out
    if action == "hasFiles":
        out["value"] = IsClipboardFormatAvailable(CF_HDROP)
        return out
    if action == "hasHtml":
        out["value"] = IsClipboardFormatAvailable(CF_HTML)
        return out
    if action == "hasText":
        out["value"] = IsClipboardFormatAvailable(CF_UNICODETEXT) or IsClipboardFormatAvailable(CF_TEXT)
        return out
    if action == "wq":
        # 实现 wq 接口
        out["hasFile"] = IsClipboardFormatAvailable(CF_HDROP)
        out["hasHtml"] = IsClipboardFormatAvailable(CF_HTML)
        out["hasImage"] = IsClipboardFormatAvailable(CF_DIBV5) or IsClipboardFormatAvailable(CF_DIB)
        out["hasText"] = IsClipboardFormatAvailable(CF_UNICODETEXT) or IsClipboardFormatAvailable(CF_TEXT)
        return out
    if action in ("clipboard_peek", "peek"):
        # 简化 peek，只返回基本信息，具体内容由 clipboard 接口处理
        out["type"] = "peek"
        return out
    if action == "get_clipboard_files":
        out.update(get_clipboard_files_only())
        return out
    if action == "get_html":
        out.update(get_clipboard_html())
        return out
    if action == "exit":
        # ★ 优雅退出指令
        out["status"] = "exiting"
        # 先打印响应，再退出
        print(json.dumps(out, ensure_ascii=False), flush=True)
        sys.exit(0)
    if action in ("clipboard", "paste"):
        target_dir = cmd.get("target_dir", cmd.get("output_dir"))
        out.update(handle_clipboard(target_dir))
        return out
    if action in ("folder_info", "get_folder_info"):
        out.update(get_folder_info(cmd.get("path", "")))
        return out
    out["error"] = f"unknown action: {action}"
    return out


def daemon_mode():
    try:
        if hasattr(sys.stdin, 'reconfigure'):
            sys.stdin.reconfigure(encoding='utf-8')
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8')
    except:
        pass

    # Debug: log startup
    sys.stderr.write(f"Daemon started. PID={os.getpid()}\n")
    sys.stderr.flush()

    while True:
        try:
            # Use binary reading to avoid encoding issues on Windows
            line_bytes = sys.stdin.buffer.readline()
            if not line_bytes:
                # EOF reached
                sys.stderr.write("Daemon stdin EOF.\n")
                time.sleep(1)
                continue

            line = line_bytes.decode('utf-8', errors='ignore').strip()
            if not line:
                continue

            try:
                cmd = json.loads(line)
                res = _dispatch_action(cmd)
            except Exception as e:
                res = {"_id": 0, "error": str(e)}

            try:
                print(json.dumps(res, ensure_ascii=True), flush=True)
            except:
                pass
        except KeyboardInterrupt:
            break
        except Exception as e:
            sys.stderr.write(f"Daemon loop error: {e}\n")
            sys.stderr.flush()
            time.sleep(0.05)


def main():
    if len(sys.argv) > 1:
        arg1 = sys.argv[1].strip().lower()
        if arg1 in ("--daemon", "daemon", "-d"):
            daemon_mode()
            return

        if arg1 == "paste" and len(sys.argv) >= 3:
            print(json.dumps(handle_clipboard(
                sys.argv[2]), ensure_ascii=True))
        else:
            print(json.dumps(handle_clipboard(), ensure_ascii=True))
    else:
        print(json.dumps(handle_clipboard(), ensure_ascii=True))


if __name__ == "__main__":
    main()

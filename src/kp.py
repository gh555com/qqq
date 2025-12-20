# src/kp.py
# ==========================================
#  A组增强版 Daemon - IO 缓存优化 + 惰性文件夹创建 + DIB 严格处理
#  修改：DIB/ DIBV5 一律保存为无损 PNG（母版）
#  关键修复：DIB -> BMP 头严格计算 bfOffBits（header/palette/bitfields）
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
      1) CF_HDROP 文件/目录
      2) CF_DIBV5（如果存在）
      3) CF_DIB
    DIB/DIBV5：严格包装成 BMP 再给 PIL 解码，然后保存 PNG
    """
    try:
        wcb.OpenClipboard()
        try:
            # 1) 文件/目录（物理复制，不转码）
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
                        ext = src.suffix
                        fname = get_timestamp_filename(
                            ext) if is_image_ext(ext) else src.name
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
                    return None

            # 2) 图片：优先 DIBV5
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
        # 1) 文件/目录：CF_HDROP
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
                        ext = src.suffix
                        fname = get_timestamp_filename(
                            ext) if is_image_ext(ext) else src.name
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

        # 2) 图片：优先 CF_DIBV5，再 CF_DIB
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
    except ImportError:
        pass
    except Exception:
        pass

    # ctypes fallback
    try:
        res = handle_windows_ctypes(output_dir)
        if res:
            return res
    except Exception:
        pass

    return {"type": "unknown"}


def handle_macos(output_dir: Path):
    import subprocess

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

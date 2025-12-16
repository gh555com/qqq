# src/kp.py
# ==========================================
#  A组增强版 Daemon - IO 缓存优化 + 惰性文件夹创建 + DIB 严格处理
#  修改：DIB 一律保存为无损 PNG（母版）
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

# ==========================================
#              缓存配置
# ==========================================
FOLDER_INFO_CACHE_TTL = 3.0
_folder_cache = {}

# ==========================================
#              默认路径配置
# ==========================================
DEFAULT_OUTPUT_DIR = Path("D:/view/p")


def resolve_output_dir(target_dir=None):
    """解析输出目录对象，但不创建目录（惰性）"""
    if target_dir:
        return Path(target_dir)
    return DEFAULT_OUTPUT_DIR


def ensure_parent(path_obj):
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
    (b'\x89PNG\r\n\x1a\n', '.png'),
    (b'\xff\xd8\xff', '.jpg'),
    (b'GIF87a', '.gif'),
    (b'GIF89a', '.gif'),
    (b'BM', '.bmp'),
    (b'\x00\x00\x01\x00', '.ico'),
    (b'II*\x00', '.tif'),
    (b'MM\x00*', '.tif'),
    (b'PK\x03\x04', '.zip'),
    (b'Rar!', '.rar'),
    (b'\x1f\x8b\x08', '.gz'),
    (b'7z\xbc\xaf', '.7z'),
    (b'MZ', '.exe'),
    (b'\x7fELF', '.elf'),
    (b'ID3', '.mp3'),
    (b'\xff\xfb', '.mp3'),
    (b'fLaC', '.flac'),
    (b'OggS', '.ogg'),
    (b'\x1aE\xdf\xa3', '.mkv'),
]


def guess_ext_by_magic(data: bytes) -> str:
    """通过 Magic Number 猜测扩展名"""
    if not data or len(data) < 4:
        return ".bin"

    # ftyp (MP4/MOV)
    if len(data) >= 12 and data[4:8] == b'ftyp':
        brand = data[8:12]
        if brand in (b'heic', b'avif', b'mif1', b'msf1'):
            return ".heic"
        if brand == b'M4A ':
            return ".m4a"
        return ".mp4"

    # WEBP
    if data[:4] == b'RIFF' and len(data) >= 12 and data[8:12] == b'WEBP':
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

    excluded_chars = ['l', 'i', 's', 'a', 'm', 'c', 'b', 'f', 't']
    valid_chars = [c for c in 'abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
                   if c.lower() not in excluded_chars]
    first_char = random.choice(valid_chars)
    if first_char.lower() == 'g':
        valid_chars_without_g = [c for c in valid_chars if c.lower() != 'g']
        second_char = random.choice(valid_chars_without_g)
    else:
        second_char = random.choice(valid_chars)
    random_chars = first_char + second_char

    prefix_code = f"{millisecond_part}{random_chars}"
    time_part = now.strftime("%H.%M.%S")
    filename = f"{prefix_code}.  {date_part} [{weekday_number}] {time_part}{ext}"
    return filename


def is_image_ext(ext):
    image_exts = {'.png', '.jpg', '.jpeg', '.gif',
                  '.bmp', '.tif', '.tiff', '.webp', '.ico', '.svg'}
    return ext.lower() in image_exts


def save_image_as_png(img, path):
    """
    将 PIL Image 保存为无损 PNG（母版）
    自动处理各种颜色模式，尽量保留透明通道
    """
    # 处理各种颜色模式，统一转换为 RGB 或 RGBA
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        # 有透明通道或调色板透明，转 RGBA 保留透明
        img = img.convert("RGBA")
    elif img.mode not in ("RGB",):
        # L, P, CMYK 等其他模式，转 RGB
        img = img.convert("RGB")
    # RGB 和 RGBA 直接保存
    img.save(path, format="PNG", compress_level=6)


# ==========================================
#              文件夹统计模块
# ==========================================
def get_folder_info(folder_path):
    global _folder_cache
    now_ts = time.time()
    if folder_path in _folder_cache:
        cached_entry = _folder_cache[folder_path]
        if now_ts - cached_entry['ts'] < FOLDER_INFO_CACHE_TTL:
            return cached_entry['data']

    total_size = 0
    ext_counts = {}
    files = []
    dirs = []

    def calc_size_recursive(p):
        s = 0
        try:
            with os.scandir(p) as it:
                for entry in it:
                    try:
                        if entry.is_file(follow_symlinks=False):
                            s += entry.stat(follow_symlinks=False).st_size
                        elif entry.is_dir(follow_symlinks=False):
                            s += calc_size_recursive(entry.path)
                    except (OSError, PermissionError):
                        pass
        except (OSError, PermissionError):
            pass
        return s

    try:
        with os.scandir(folder_path) as it:
            for entry in it:
                try:
                    stat = entry.stat(follow_symlinks=False)
                    item = {'name': entry.name,
                            'path': entry.path, 'mtime': stat.st_mtime}
                    if entry.is_file(follow_symlinks=False):
                        item['size'] = stat.st_size
                        total_size += stat.st_size
                        files.append(item)
                        _, ext = os.path.splitext(entry.name)
                        key = ext[1:].lower() if ext else ''
                        ext_counts[key] = ext_counts.get(key, 0) + 1
                    elif entry.is_dir(follow_symlinks=False):
                        dirs.append(item)
                except (OSError, PermissionError):
                    pass

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(
                calc_size_recursive, d['path']): d for d in dirs}
            for future in concurrent.futures.as_completed(futures):
                try:
                    dir_size = future.result(timeout=30)
                    total_size += dir_size
                    futures[future]['size'] = dir_size
                except Exception:
                    futures[future]['size'] = 0

    except Exception as e:
        return {'error': str(e)}

    result_data = {
        'success': True,
        'total_size': total_size,
        'ext_stats': ext_counts,
        'files': files,
        'dirs': dirs,
        'file_count_root': len(files)
    }

    _folder_cache[folder_path] = {'ts': now_ts, 'data': result_data}
    if len(_folder_cache) > 200:
        _folder_cache.clear()

    return result_data


# ==========================================
#              Windows 剪贴板处理
# ==========================================
def handle_windows_pywin32(wcb, wcon, output_dir):
    try:
        wcb.OpenClipboard()

        # 1. 检查文件 (CF_HDROP) - 物理复制，不转码
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
                wcb.CloseClipboard()
                return {"type": "folder_text", "text": '\n'.join(valid_dirs)}

            if valid_files:
                copied_files = []
                ensure_parent(output_dir / "dummy")

                for src in valid_files:
                    ext = src.suffix
                    fname = get_timestamp_filename(
                        ext) if is_image_ext(ext) else src.name
                    dst = output_dir / fname
                    try:
                        shutil.copy2(src, dst)  # 物理复制，二进制完全一致
                        copied_files.append(str(dst))
                    except:
                        pass

                wcb.CloseClipboard()
                if len(copied_files) == 1 and is_image_ext(Path(copied_files[0]).suffix):
                    return {"type": "image", "path": copied_files[0]}
                if copied_files:
                    return {"type": "file", "files": copied_files}
                return None

        # 2. 检查图片 (CF_DIB) - 保存为无损 PNG（母版）
        if wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
            try:
                from PIL import Image
                import io
            except ImportError:
                wcb.CloseClipboard()
                return None

            dib = wcb.GetClipboardData(wcon.CF_DIB)
            wcb.CloseClipboard()

            try:
                data = bytes(dib)
                bfType = b"BM"
                bfSize = (len(data) + 14).to_bytes(4, "little")
                bfReserved = (0).to_bytes(4, "little")
                bfOffBits = (14 + 40).to_bytes(4, "little")
                bmp = bfType + bfSize + bfReserved + bfOffBits + data

                img = Image.open(io.BytesIO(bmp))

                # ★★★ 关键：DIB 一律保存为无损 PNG（母版）★★★
                fname = get_timestamp_filename(".png")
                path = output_dir / fname
                ensure_parent(path)

                save_image_as_png(img, path)

                return {"type": "image", "path": str(path)}
            except Exception:
                return None

        wcb.CloseClipboard()
    except Exception:
        try:
            wcb.CloseClipboard()
        except:
            pass
    return None


def handle_windows_ctypes(output_dir):
    if not OpenClipboard(None):
        return {"error": "Cannot open clipboard"}

    try:
        # 1. 检查文件 (CF_HDROP) - 物理复制，二进制完全一致
        if IsClipboardFormatAvailable(CF_HDROP):
            h_drop = GetClipboardData(CF_HDROP)
            if h_drop:
                count = DragQueryFileW(h_drop, 0xFFFFFFFF, None, 0)
                files = []
                buf = ctypes.create_unicode_buffer(1024)
                for i in range(count):
                    DragQueryFileW(h_drop, i, buf, 1024)
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
                    CloseClipboard()
                    return {"type": "folder_text", "text": '\n'.join(valid_dirs)}

                if valid_files:
                    ensure_parent(output_dir / "dummy")
                    copied_files = []
                    for src in valid_files:
                        ext = src.suffix
                        fname = get_timestamp_filename(
                            ext) if is_image_ext(ext) else src.name
                        dst = output_dir / fname
                        try:
                            shutil.copy2(src, dst)
                            copied_files.append(str(dst))
                        except:
                            pass

                    CloseClipboard()
                    if len(copied_files) == 1 and is_image_ext(Path(copied_files[0]).suffix):
                        return {"type": "image", "path": copied_files[0]}
                    if copied_files:
                        return {"type": "file", "files": copied_files}

        # 2. 检查图片 (CF_DIB) - 保存为无损 PNG（母版）
        if IsClipboardFormatAvailable(CF_DIB):
            try:
                from PIL import Image
                import io
            except ImportError:
                CloseClipboard()
                return None

            h_mem = GetClipboardData(CF_DIB)
            if h_mem:
                data = read_global_data(h_mem)
                CloseClipboard()
                if data:
                    try:
                        bfType = b"BM"
                        bfSize = (len(data) + 14).to_bytes(4, "little")
                        bfReserved = (0).to_bytes(4, "little")
                        bfOffBits = (14 + 40).to_bytes(4, "little")
                        bmp = bfType + bfSize + bfReserved + bfOffBits + data

                        img = Image.open(io.BytesIO(bmp))

                        fname = get_timestamp_filename(".png")
                        path = output_dir / fname
                        ensure_parent(path)

                        save_image_as_png(img, path)

                        return {"type": "image", "path": str(path)}
                    except:
                        return None

    finally:
        try:
            CloseClipboard()
        except:
            pass

    return {"type": "unknown"}


def handle_windows(output_dir):
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

    try:
        res = handle_windows_ctypes(output_dir)
        if res:
            return res
    except Exception:
        pass

    return {"type": "unknown"}


def handle_macos(output_dir):
    import subprocess
    fname = get_timestamp_filename(".png")
    path = output_dir / fname

    try:
        check_proc = subprocess.run(
            ["pbpaste", "-Prefer", "png"], capture_output=True, timeout=2)
        if check_proc.stdout and len(check_proc.stdout) > 0:
            ensure_parent(path)
            with open(path, "wb") as f:
                f.write(check_proc.stdout)
            if path.exists() and path.stat().st_size > 0:
                return {"type": "image", "path": str(path)}
    except:
        pass

    return {"type": "unknown"}


def handle_linux(output_dir):
    import subprocess
    fname = get_timestamp_filename(".png")
    path = output_dir / fname

    try:
        targets_proc = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
            capture_output=True, text=True, timeout=2
        )
        if "image/png" in targets_proc.stdout:
            ensure_parent(path)
            with open(path, "wb") as f:
                subprocess.run(
                    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
                    stdout=f, stderr=subprocess.DEVNULL, check=True, timeout=5
                )
            if path.exists() and path.stat().st_size > 0:
                return {"type": "image", "path": str(path)}
    except:
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
    sys.stdout.reconfigure(line_buffering=True)
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue

            cmd = json.loads(line)
            action = cmd.get('action')
            request_id = cmd.get('_id', 0)
            result = {'_id': request_id}

            if action == 'ping':
                result['status'] = 'alive'

            elif action == 'clipboard':
                target_dir = cmd.get('target_dir')
                clipboard_result = handle_clipboard(target_dir)
                if clipboard_result:
                    result.update(clipboard_result)
                else:
                    result['type'] = 'unknown'

            elif action == 'folder_info':
                folder_path = cmd.get('path', '')
                info_result = get_folder_info(folder_path)
                result.update(info_result)

            else:
                result['error'] = f'unknown action: {action}'

            print(json.dumps(result, ensure_ascii=False), flush=True)

        except json.JSONDecodeError:
            print(json.dumps(
                {'_id': 0, 'error': 'JSON parse error'}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({'_id': 0, 'error': str(e)},
                  ensure_ascii=False), flush=True)


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
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()

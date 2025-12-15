# src/kp.py
# 精简版 Daemon - 只做 JS 做不好的事：剪贴板 + 文件夹统计
import sys
import os
import json
import platform
import shutil
import ctypes
from ctypes import wintypes
from pathlib import Path
from datetime import datetime
import random
import concurrent.futures

# ==========================================
#              默认路径配置
# ==========================================
DEFAULT_OUTPUT_DIR = Path("D:/view/p")


def resolve_output_dir(target_dir=None):
    if target_dir:
        target = Path(target_dir)
        try:
            target.mkdir(parents=True, exist_ok=True)
            return target
        except Exception:
            return DEFAULT_OUTPUT_DIR
    return DEFAULT_OUTPUT_DIR


# ==========================================
#              文件签名表（浅层识别）
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
]


def guess_ext_by_magic(data: bytes) -> str:
    if not data or len(data) < 4:
        return ".bin"
    if len(data) >= 12 and data[4:8] == b'ftyp':
        brand = data[8:12]
        if brand in (b'heic', b'avif', b'mif1', b'msf1'):
            return ".heic"
        return ".mp4"
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

    CF_DIB = 8
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
    ms = f"{now.microsecond // 1000:03d}"
    excluded = ['l', 'i', 's', 'a', 'm', 'c', 'b', 'f', 't']
    valid = [c for c in 'abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' if c.lower()
             not in excluded]
    c1 = random.choice(valid)
    c2 = random.choice([c for c in valid if c.lower() != 'g']
                       ) if c1.lower() == 'g' else random.choice(valid)
    time_part = now.strftime("%H.%M.%S")
    return f"{ms}{c1}{c2}.  {date_part} [{weekday_number}] {time_part}{ext}"


def is_image_ext(ext):
    return ext.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.ico'}


# ==========================================
#              文件夹统计（os.scandir）
# ==========================================

def get_folder_info(folder_path):
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

    return {
        'success': True,
        'total_size': total_size,
        'ext_stats': ext_counts,
        'files': files,
        'dirs': dirs,
        'file_count_root': len(files)
    }


# ==========================================
#              剪贴板处理
# ==========================================

def handle_windows_pywin32(wcb, wcon, output_dir):
    try:
        wcb.OpenClipboard()
        if wcb.IsClipboardFormatAvailable(wcon.CF_HDROP):
            files = wcb.GetClipboardData(wcon.CF_HDROP)
            folders = [str(Path(f)) for f in files if Path(
                f).exists() and Path(f).is_dir()]
            if folders:
                wcb.CloseClipboard()
                return {"type": "folder_text", "text": '\n'.join(folders)}
            copied = []
            for f in files:
                src = Path(f)
                if src.exists() and src.is_file():
                    ext = src.suffix
                    fname = get_timestamp_filename(
                        ext) if is_image_ext(ext) else src.name
                    dst = output_dir / fname
                    shutil.copy2(src, dst)
                    copied.append(str(dst))
            wcb.CloseClipboard()
            if len(copied) == 1 and is_image_ext(Path(copied[0]).suffix):
                return {"type": "image", "path": copied[0]}
            return {"type": "file", "files": copied}

        if wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
            dib = wcb.GetClipboardData(wcon.CF_DIB)
            wcb.CloseClipboard()
            try:
                from PIL import Image
                import io
                data = bytes(dib)
                bmp = b"BM" + (len(data) + 14).to_bytes(4, "little") + \
                    b"\x00" * 4 + (54).to_bytes(4, "little") + data
                img = Image.open(io.BytesIO(bmp))
                fname = get_timestamp_filename(".png")
                p = output_dir / fname
                img.save(p)
                return {"type": "image", "path": str(p)}
            except:
                ext = guess_ext_by_magic(data)
                fname = get_timestamp_filename(ext)
                p = output_dir / fname
                with open(p, "wb") as f:
                    f.write(data)
                return {"type": "binary", "path": str(p)}
        wcb.CloseClipboard()
    except:
        try:
            wcb.CloseClipboard()
        except:
            pass
    return None


def handle_windows_ctypes(output_dir):
    if not OpenClipboard(None):
        return {"error": "Cannot open clipboard"}
    try:
        if IsClipboardFormatAvailable(CF_HDROP):
            h_drop = GetClipboardData(CF_HDROP)
            if h_drop:
                count = DragQueryFileW(h_drop, 0xFFFFFFFF, None, 0)
                files = []
                buf = ctypes.create_unicode_buffer(1024)
                for i in range(count):
                    DragQueryFileW(h_drop, i, buf, 1024)
                    files.append(buf.value)
                folders = [f for f in files if Path(
                    f).exists() and Path(f).is_dir()]
                if folders:
                    CloseClipboard()
                    return {"type": "folder_text", "text": '\n'.join(folders)}
                copied = []
                for f in files:
                    src = Path(f)
                    if src.exists() and src.is_file():
                        ext = src.suffix
                        fname = get_timestamp_filename(
                            ext) if is_image_ext(ext) else src.name
                        dst = output_dir / fname
                        shutil.copy2(src, dst)
                        copied.append(str(dst))
                CloseClipboard()
                if len(copied) == 1 and is_image_ext(Path(copied[0]).suffix):
                    return {"type": "image", "path": copied[0]}
                return {"type": "file", "files": copied}

        if IsClipboardFormatAvailable(CF_DIB):
            h_mem = GetClipboardData(CF_DIB)
            if h_mem:
                data = read_global_data(h_mem)
                CloseClipboard()
                if data:
                    try:
                        from PIL import Image
                        import io
                        bmp = b"BM" + (len(data) + 14).to_bytes(4, "little") + \
                            b"\x00" * 4 + (54).to_bytes(4, "little") + data
                        img = Image.open(io.BytesIO(bmp))
                        fname = get_timestamp_filename(".png")
                        p = output_dir / fname
                        img.save(p)
                        return {"type": "image", "path": str(p)}
                    except:
                        ext = guess_ext_by_magic(data)
                        fname = get_timestamp_filename(ext)
                        p = output_dir / fname
                        with open(p, "wb") as f:
                            f.write(data)
                        return {"type": "binary", "path": str(p)}
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
    except:
        pass
    return handle_windows_ctypes(output_dir)


def handle_macos(output_dir):
    import subprocess
    fname = get_timestamp_filename(".png")
    p = output_dir / fname
    try:
        subprocess.run(["pngpaste", str(p)], check=True,
                       capture_output=True, timeout=5)
        if p.exists() and p.stat().st_size > 0:
            return {"type": "image", "path": str(p)}
    except:
        pass
    try:
        data = subprocess.check_output(
            ["pbpaste", "-Prefer", "png"], stderr=subprocess.DEVNULL, timeout=5)
        if data:
            with open(p, "wb") as f:
                f.write(data)
            if p.exists() and p.stat().st_size > 0:
                return {"type": "image", "path": str(p)}
    except:
        pass
    if p.exists():
        try:
            p.unlink()
        except:
            pass
    return {"type": "unknown"}


def handle_linux(output_dir):
    import subprocess
    fname = get_timestamp_filename(".png")
    p = output_dir / fname
    try:
        with open(p, "wb") as f:
            subprocess.run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
                           stdout=f, stderr=subprocess.DEVNULL, check=True, timeout=5)
        if p.exists() and p.stat().st_size > 0:
            return {"type": "image", "path": str(p)}
    except:
        pass
    if p.exists():
        try:
            p.unlink()
        except:
            pass
    return {"type": "unknown"}


def handle_clipboard(target_dir=None):
    output_dir = resolve_output_dir(target_dir)
    if not output_dir.exists():
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
        except:
            pass
    sys_name = platform.system()
    if sys_name == "Windows":
        return handle_windows(output_dir)
    elif sys_name == "Darwin":
        return handle_macos(output_dir)
    elif sys_name == "Linux":
        return handle_linux(output_dir)
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
            rid = cmd.get('_id', 0)
            result = {'_id': rid}

            if action == 'ping':
                result['status'] = 'alive'
            elif action == 'clipboard':
                result.update(handle_clipboard(cmd.get('target_dir')))
            elif action == 'folder_info':
                result.update(get_folder_info(cmd.get('path', '')))
            else:
                result['error'] = f'unknown action: {action}'

            print(json.dumps(result, ensure_ascii=False), flush=True)
        except json.JSONDecodeError as e:
            print(json.dumps(
                {'_id': 0, 'error': f'JSON parse error: {e}'}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({'_id': 0, 'error': str(e)},
                  ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        daemon_mode()
    else:
        res = handle_clipboard(sys.argv[1] if len(sys.argv) > 1 else None)
        print(json.dumps(res, ensure_ascii=False))

# -*- coding: utf-8 -*-
#   - Minimal mode: only reads system clipboard and saves to the specified directory (dumb saver)
#   - Removed all fingerprint calculation and deduplication logic
#   - Removed HTML parsing logic (handled on the Node.js side)
#   - Only handles: plain text, file copy, native image save
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
import importlib.util
import threading

# =============================================================================
#  Audio engine (miniaudio_v16)
# =============================================================================
_AUDIO_ENGINE = None
_AUDIO_ENGINE_ERROR = None
_AUDIO_CURRENT_TOKEN = None
_AUDIO_LOCK = None
_AUDIO_MONITOR_THREAD = None
_AUDIO_IS_LOOPING = False  # Flag whether it is infinite loop; infinite loop does not send finished event

def _init_audio_engine():
    """Lazy-load audio engine, return (engine, error_msg)"""
    global _AUDIO_ENGINE, _AUDIO_ENGINE_ERROR, _AUDIO_LOCK
    import threading
    if _AUDIO_LOCK is None:
        _AUDIO_LOCK = threading.Lock()

    with _AUDIO_LOCK:
        if _AUDIO_ENGINE is not None:
            return _AUDIO_ENGINE, None
        if _AUDIO_ENGINE_ERROR is not None:
            return None, _AUDIO_ENGINE_ERROR

        try:
            # Locate miniaudio_v16.py path
            script_dir = os.path.dirname(os.path.abspath(__file__))
            ma_path = os.path.join(script_dir, "miniaudio_v16.py")

            if not os.path.exists(ma_path):
                _AUDIO_ENGINE_ERROR = f"miniaudio_v16.py not found: {ma_path}"
                return None, _AUDIO_ENGINE_ERROR

            # Dynamically import module
            spec = importlib.util.spec_from_file_location("miniaudio_v16", ma_path)
            ma_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(ma_module)

            # Initialize engine (silent=True does not print logs)
            _AUDIO_ENGINE = ma_module.NonBlockingAudioEngine(asset_folder=".", max_workers=8, silent=True)
            return _AUDIO_ENGINE, None
        except Exception as e:
            import traceback
            _AUDIO_ENGINE_ERROR = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
            return None, _AUDIO_ENGINE_ERROR

def _check_audio_engine():
    """Check audio engine status, return detailed info"""
    engine, err = _init_audio_engine()
    if err:
        return {"has_miniaudio": False, "error": err}

    try:
        # Try to get miniaudio version info
        script_dir = os.path.dirname(os.path.abspath(__file__))
        ma_path = os.path.join(script_dir, "miniaudio_v16.py")
        spec = importlib.util.spec_from_file_location("miniaudio_v16", ma_path)
        ma_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ma_module)

        miniaudio_pkg = getattr(ma_module, 'miniaudio', None)
        version = getattr(miniaudio_pkg, '__version__', 'unknown') if miniaudio_pkg else 'unknown'

        return {
            "has_miniaudio": True,
            "miniaudio_version": version,
            "devices": []
        }
    except Exception as e:
        return {"has_miniaudio": True, "miniaudio_version": "unknown", "error": str(e)}

def _play_audio(file_path, count=1):
    """Play audio, return status"""
    global _AUDIO_CURRENT_TOKEN, _AUDIO_MONITOR_THREAD, _AUDIO_IS_LOOPING
    import threading

    engine, err = _init_audio_engine()
    if err:
        return {"status": "error", "error": err}

    if not os.path.exists(file_path):
        return {"status": "error", "error": f"file not found: {file_path}"}

    try:
        # Stop current playback first
        if _AUDIO_CURRENT_TOKEN:
            try:
                _AUDIO_CURRENT_TOKEN.stop()
            except:
                pass
            _AUDIO_CURRENT_TOKEN = None

        # count=0 or count=-1 means infinite loop
        if count == 0 or count == -1:
            # Infinite loop playback
            _AUDIO_CURRENT_TOKEN = engine.play_sound_file(
                file_path=file_path,
                loop=True,
                trim_silence=True  # Do not remove leading/trailing silence
            )
            _AUDIO_IS_LOOPING = True
        elif count == 1:
            # Play once, 2s fade-out, do not remove leading/trailing silence
            _AUDIO_CURRENT_TOKEN = engine.az(file_path, 1, 2.0, True)
            _AUDIO_IS_LOOPING = False
        else:
            # Fixed-count loop playback, last 2s fade-out, do not remove leading/trailing silence
            _AUDIO_CURRENT_TOKEN = engine.az(file_path, count, 2.0, True)
            _AUDIO_IS_LOOPING = False

        # ★ Start background monitor thread, send event after playback completes
        def _monitor_playback():
            global _AUDIO_CURRENT_TOKEN
            token = _AUDIO_CURRENT_TOKEN
            eng = engine  # Closure captures engine reference
            if token is None:
                return
            # Wait for completion: check whether token is stopped, or removed from _active_tokens
            while True:
                # Check manual stop
                if token.stopped:
                    break
                # Check whether token is still in active list (natural completion removes it)
                try:
                    with eng._tokens_lock:
                        if token not in eng._active_tokens:
                            break
                except:
                    break
                time.sleep(0.2)
            # Playback finished, send event (only in non-infinite-loop mode)
            if not _AUDIO_IS_LOOPING and token == _AUDIO_CURRENT_TOKEN:
                _AUDIO_CURRENT_TOKEN = None
                # Send JSON event to stdout
                try:
                    print(json.dumps({"event": "audio_finished"}), flush=True)
                except:
                    pass

        # Start monitor thread (if not infinite loop)
        if not _AUDIO_IS_LOOPING:
            _AUDIO_MONITOR_THREAD = threading.Thread(target=_monitor_playback, daemon=True)
            _AUDIO_MONITOR_THREAD.start()

        return {"status": "ok"}
    except Exception as e:
        import traceback
        return {"status": "error", "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()}

def _stop_audio():
    """Stop audio playback"""
    global _AUDIO_CURRENT_TOKEN, _AUDIO_IS_LOOPING

    if _AUDIO_CURRENT_TOKEN:
        try:
            _AUDIO_CURRENT_TOKEN.stop()
        except:
            pass
        _AUDIO_CURRENT_TOKEN = None

    _AUDIO_IS_LOOPING = False

    # Also try to stop all playback in engine
    engine, _ = _init_audio_engine()
    if engine:
        try:
            engine.stop_all()
        except:
            pass

    return {"status": "stopped"}

def _get_audio_state():
    """Get current playback state"""
    global _AUDIO_CURRENT_TOKEN

    if _AUDIO_CURRENT_TOKEN and not _AUDIO_CURRENT_TOKEN.stopped:
        return {"playing": True}
    return {"playing": False}


# =============================================================================
#  ★ Sound effect system (v16 AudioHub - event-driven + delayed warmup + ultra-fast playback)
# =============================================================================
_AUDIO_HUB = None
_AUDIO_HUB_LOCK = threading.Lock()
_SFX_REGISTRY = {}   # {"kope": [path, ...], "yz": [path, ...], ...}
_SFX_LAST_IDX = {}   # Last played index per category to avoid immediate repeats
_SFX_PRIMED = False  # Warmup completion flag
_SFX_PRIME_DELAY = 5  # Warmup delay seconds (stagger VS Code startup peak)

def _init_sfx_paths():
    """Initialize sound effect path registry"""
    global _SFX_REGISTRY
    if _SFX_REGISTRY:
        return _SFX_REGISTRY

    script_dir = os.path.dirname(os.path.abspath(__file__))
    assets_dir = os.path.join(script_dir, "..", "assets")
    if not os.path.isdir(assets_dir):
        assets_dir = os.path.join(script_dir, "assets")

    # kope SFX (1-7.mp3) - clipboard copy
    kope_dir = os.path.join(assets_dir, "kope")
    if os.path.isdir(kope_dir):
        _SFX_REGISTRY["kope"] = [os.path.join(kope_dir, f"{i}.mp3") for i in range(1, 8)]

    # yz SFX (delete file, CMD, etc.) - all mp3/wav
    yz_dir = os.path.join(assets_dir, "yz")
    if os.path.isdir(yz_dir):
        yz_files = sorted([f for f in os.listdir(yz_dir) if f.endswith((".mp3", ".wav"))])
        _SFX_REGISTRY["yz"] = [os.path.join(yz_dir, f) for f in yz_files]

    return _SFX_REGISTRY

def _background_prime_sfx():
    """后台预热线程：延迟 N 秒后执行，错开 VS Code 启动高峰""" // qq2q
    global _SFX_PRIMED
    time.sleep(_SFX_PRIME_DELAY)

    hub = _AUDIO_HUB
    if not hub:
        return

    try:
        _init_sfx_paths()
        all_paths = []
        for paths in _SFX_REGISTRY.values():
            all_paths.extend([p for p in paths if os.path.isfile(p)])
        if all_paths:
            hub.prime_sfx(all_paths)
        _SFX_PRIMED = True
    except:
        pass

def _get_audio_hub():
    """获取 AudioHub 单例 (懒加载 + 延迟预热)""" // qq2q
    global _AUDIO_HUB
    if _AUDIO_HUB is not None:
        return _AUDIO_HUB

    with _AUDIO_HUB_LOCK:
        if _AUDIO_HUB is not None:
            return _AUDIO_HUB

        try:
            # Dynamically import v16
            script_dir = os.path.dirname(os.path.abspath(__file__))
            v16_path = os.path.join(script_dir, "miniaudio_v16.py")
            spec = importlib.util.spec_from_file_location("miniaudio_v16", v16_path)
            v16 = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(v16)

            # Create AudioHub: sfx_use_music_engine=True reuses music engine to avoid device conflicts
            hub = v16.AudioHub(
                asset_folder=".",
                music_workers=16,
                sfx_workers=24,
                sfx_use_music_engine=True,  # ★ Reuse music engine to avoid separate device issues
                silent=True
            )

            _AUDIO_HUB = hub

            # Start background warmup thread (does not block current request)
            threading.Thread(target=_background_prime_sfx, daemon=True, name="sfx-prime").start()

            return hub
        except Exception as e:
            import traceback
            sys.stderr.write(f"[AudioHub] Init failed: {e}\n{traceback.format_exc()}")
            sys.stderr.flush()
            return None

def _play_sfx(category: str, idx: int = -1, name: str = None):
    """
    播放音效 // qq2q
    category: "kope" / "yz" 等 // qq2q
    idx: -1 = 随机（避免连续重复），>=0 = 指定索引 // qq2q
    name: 指定文件名（如 "kj3.mp3"），优先级最高 // qq2q
    """
    global _SFX_LAST_IDX
    hub = _get_audio_hub()
    if not hub:
        return

    _init_sfx_paths()
    paths = _SFX_REGISTRY.get(category, [])
    if not paths:
        return

    # Filter existing files
    valid_paths = [p for p in paths if os.path.isfile(p)]
    if not valid_paths:
        return

    # ★ Play by specified filename
    if name:
        for p in valid_paths:
            if os.path.basename(p) == name:
                hub.play_sfx(p)
                return
        return  # Specified file not found

    if idx < 0:
        # Random selection, avoid immediate repeats
        last = _SFX_LAST_IDX.get(category, -1)
        if len(valid_paths) > 1:
            choices = [i for i in range(len(valid_paths)) if i != last]
            idx = random.choice(choices)
        else:
            idx = 0
        _SFX_LAST_IDX[category] = idx
        path = valid_paths[idx]
    else:
        path = valid_paths[idx % len(valid_paths)]

    hub.play_sfx(path)

def _start_clipboard_watcher():
    """启动剪切板音效 (事件驱动 - 0ms 检测延迟)""" // qq2q
    hub = _get_audio_hub()
    if not hub:
        return {"status": "error", "error": "AudioHub init failed"}

    _init_sfx_paths()
    kope_paths = [p for p in _SFX_REGISTRY.get("kope", []) if os.path.isfile(p)]
    if not kope_paths:
        return {"status": "error", "error": "No kope sounds found"}

    try:
        hub.bind_clipboard_to_random_sfx(kope_paths, debounce_ms=0, prewarm=True)
        hub.start_clipboard()
        return {"status": "started"}
    except Exception as e:
        return {"status": "error", "error": str(e)}

def _stop_clipboard_watcher():
    """停止剪切板音效""" // qq2q
    hub = _get_audio_hub()
    if hub:
        hub.stop_clipboard()
    return {"status": "stopped"}

# =============================================================================
#  Configuration
# =============================================================================
# Thread pool (global reuse)
_MAX_WORKERS = min(32, max(4, (os.cpu_count() or 4) * 2))
_IO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=_MAX_WORKERS)

# =============================================================================
#  Scan cancel mechanism (used to cancel path_size/folder_info and other expensive ops)
# =============================================================================
import threading
_SCAN_CANCEL_VERSION = 0  # Global cancel version
_SCAN_CANCEL_LOCK = threading.Lock()

def _bump_scan_cancel_version():
    """Increment cancel version so all ongoing scans become invalid"""
    global _SCAN_CANCEL_VERSION
    with _SCAN_CANCEL_LOCK:
        _SCAN_CANCEL_VERSION += 1
        return _SCAN_CANCEL_VERSION

def _get_scan_cancel_version():
    """Get current cancel version"""
    with _SCAN_CANCEL_LOCK:
        return _SCAN_CANCEL_VERSION

def _is_scan_cancelled(my_version):
    """Check whether scan has been cancelled"""
    return _get_scan_cancel_version() != my_version
# =============================================================================
#  Utilities: path/filename
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


def unique_path_in_dir(output_dir: Path, name: str, is_folder: bool = False) -> Path:
    # Simple rename strategy to prevent overwriting
    base = output_dir / name
    if not base.exists():
        return base

    if is_folder:
        stem = name
        ext = ""
    else:
        stem = base.stem
        ext = base.suffix
        # Special case: if no main filename (e.g. .gitignore), treat whole as stem
        if not stem and ext.startswith('.'):
            stem = ext
            ext = ""

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
    RegisterClipboardFormatW = user32.RegisterClipboardFormatW
    RegisterClipboardFormatW.argtypes = [wintypes.LPCWSTR]
    RegisterClipboardFormatW.restype = wintypes.UINT
    CF_HTML = RegisterClipboardFormatW("HTML Format")

    # For Setting Clipboard Files (CF_HDROP)
    class DROPFILES(ctypes.Structure):
        _fields_ = [
            ("pFiles", wintypes.DWORD),
            ("pt", wintypes.POINT),
            ("fNC", wintypes.BOOL),
            ("fWide", wintypes.BOOL),
        ]

    GlobalAlloc = kernel32.GlobalAlloc
    GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    GlobalAlloc.restype = wintypes.HGLOBAL
    GlobalFree = kernel32.GlobalFree
    GlobalFree.argtypes = [wintypes.HGLOBAL]
    GlobalFree.restype = wintypes.HGLOBAL
    EmptyClipboard = user32.EmptyClipboard
    EmptyClipboard.argtypes = []
    EmptyClipboard.restype = wintypes.BOOL
    SetClipboardData = user32.SetClipboardData
    SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    SetClipboardData.restype = wintypes.HANDLE
    GHND = 0x0042  # GMEM_MOVEABLE | GMEM_ZEROINIT

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
#  PIL save: PNG
# =============================================================================


def save_image_as_png(img, path: Path):
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
    elif img.mode not in ("RGB",):
        img = img.convert("RGB")
    img.save(str(path), format="PNG", compress_level=6)
# =============================================================================
#  DIB / DIBV5 to BMP
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
#  File copy (Dumb Copy)
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
            dst = unique_path_in_dir(output_dir, fname, is_folder=False)
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
        # If directory exists, generate unique name
        if dst_dir.exists():
            dst_dir = unique_path_in_dir(
                output_dir, safe_filename(src_dir.name), is_folder=True)
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
#  Folder stats (split: get_folder_info = full info; get_path_size = size only)
#  - Extreme IO: os.scandir + DirEntry cache + explicit stack (no recursion depth risk)
#  - Behavior aligned with original: do not enter symlink dirs; symlink files count target size (Path.stat follows by default)
# =============================================================================

def get_folder_info(folder_path: str, cancel_version: int = None):
    """完整信息版：total_size + file_count_root + ext_stats（极限优化 + 可取消）""" // qq2q
    if not folder_path or not isinstance(folder_path, str):
        return {"success": False, "error": "empty path"}
    if not os.path.isdir(folder_path):
        return {"success": False, "error": "path not a directory"}

    total_size = 0
    file_count = 0
    ext_counts = {}
    check_count = 0  # Cancel checkpoint counter

    try:
        stack = [folder_path]
        scandir = os.scandir
        ext_get = ext_counts.get

        while stack:
            # Check cancel once every 5000 files
            if cancel_version is not None and check_count >= 5000:
                check_count = 0
                if _is_scan_cancelled(cancel_version):
                    return {"success": False, "cancelled": True}

            d = stack.pop()
            try:
                with scandir(d) as it:
                    for e in it:
                        try:
                            # Do not follow symlink directories (align with os.walk(followlinks=False))
                            if e.is_dir(follow_symlinks=False):
                                stack.append(e.path)
                                continue

                            # If it's a symlink to a directory: do not enter and do not count (align with os.walk behavior)
                            if e.is_symlink():
                                try:
                                    if e.is_dir(follow_symlinks=True):
                                        continue
                                except OSError:
                                    continue

                            # File (or symlink file): count target size (align with Path.stat default behavior)
                            try:
                                st = e.stat(follow_symlinks=True)
                            except OSError:
                                continue

                            total_size += st.st_size
                            file_count += 1
                            check_count += 1

                            # Extract extension: align key edge cases with Path.suffix (.gitignore -> no_ext)
                            n = e.name
                            i = n.rfind(".")
                            if 0 < i < (len(n) - 1):
                                ext = n[i + 1 :].lower()
                            else:
                                ext = "no_ext"

                            ext_counts[ext] = ext_get(ext, 0) + 1

                        except OSError:
                            continue
                        except Exception:
                            continue
            except OSError:
                continue
            except Exception:
                continue

    except Exception as e:
        return {"success": False, "error": str(e)}

    return {
        "success": True,
        "total_size": total_size,
        "file_count_root": file_count,
        "ext_stats": ext_counts
    }


def get_disk_free(drive: str = None):
    """获取磁盘剩余空间（单位：字节）""" // qq2q
    if not drive:
        # Default to system drive
        drive = os.environ.get('SystemDrive', 'C:')
    # Ensure correct format: C: -> C:\
    drive = drive.strip()
    if len(drive) == 1 and drive.isalpha():
        drive = drive.upper() + ":\\"
    elif len(drive) == 2 and drive[1] == ':':
        drive = drive.upper() + "\\"
    elif not drive.endswith("\\") and not drive.endswith("/"):
        drive = drive + "\\"

    try:
        usage = shutil.disk_usage(drive)
        return {
            "success": True,
            "free": usage.free,
            "total": usage.total,
            "used": usage.used
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_path_size(path: str, cancel_version: int = None):
    """只获取单文件或目录递归总大小（极限优化 + 可取消，不统计后缀名）""" // qq2q
    if not path or not isinstance(path, str):
        return {"success": False, "error": "empty path"}

    try:
        # File: stat directly (follow symlink, same as original Path.stat default)
        if os.path.isfile(path):
            try:
                return {"success": True, "total_size": os.stat(path, follow_symlinks=True).st_size}
            except Exception as e:
                return {"success": False, "error": str(e)}

        # Directory: recursive sum
        if not os.path.isdir(path):
            return {"success": False, "error": "path not a file or directory"}

        total_size = 0
        check_count = 0  # Cancel checkpoint counter
        stack = [path]
        scandir = os.scandir

        while stack:
            # Check cancel once every 5000 files
            if cancel_version is not None and check_count >= 5000:
                check_count = 0
                if _is_scan_cancelled(cancel_version):
                    return {"success": False, "cancelled": True}

            d = stack.pop()
            try:
                with scandir(d) as it:
                    for e in it:
                        try:
                            if e.is_dir(follow_symlinks=False):
                                stack.append(e.path)
                                continue

                            if e.is_symlink():
                                try:
                                    if e.is_dir(follow_symlinks=True):
                                        continue
                                except OSError:
                                    continue

                            try:
                                st = e.stat(follow_symlinks=True)
                            except OSError:
                                continue
                            total_size += st.st_size
                            check_count += 1

                        except OSError:
                            continue
                        except Exception:
                            continue
            except OSError:
                continue
            except Exception:
                continue

        return {"success": True, "total_size": total_size}

    except Exception as e:
        return {"success": False, "error": str(e)}
# =============================================================================
#  Windows clipboard handlers
# =============================================================================


def handle_windows_pywin32(wcb, wcon, output_dir: Path):
    # ★ Stage 1: only read data; must finish in milliseconds; release lock immediately
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
            # 1) Plain text
            if has_text and not has_files and not has_dib:
                try:
                    if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT):
                        text = wcb.GetClipboardData(wcon.CF_UNICODETEXT)
                        if isinstance(text, str) and text.strip():
                            data_to_process = {"type": "text", "text": text}
                except Exception:
                    pass
            # 2) Files/Folders (only read paths; do not copy files!)
            elif has_files:
                try:
                    paths = wcb.GetClipboardData(wcon.CF_HDROP) or []
                    # Ensure it's a list and non-empty
                    if paths:
                        data_to_process = {
                            "type": "files", "paths": list(paths)}
                except:
                    pass
            # 3) DIB screenshot (read Buffer into memory; do not save image!)
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
            # ★ Must close clipboard immediately!
            wcb.CloseClipboard()
    except Exception:
        pass
    # ★ Stage 2: process data outside the lock (time-consuming ops)
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
            return None  # Only empty/non-existent paths
        if data_to_process["type"] == "dib":
            try:
                from PIL import Image
                import io
                dib = data_to_process["data"]
                bmp = dib_to_bmp_bytes(dib)
                img = Image.open(io.BytesIO(bmp))
                fname = get_timestamp_filename(".png")
                out_path = unique_path_in_dir(
                    output_dir, fname, is_folder=False)
                ensure_parent(out_path)
                save_image_as_png(img, out_path)
                return {"type": "image", "path": str(out_path)}
            except Exception:
                return None
    except Exception:
        return None
    return None


def handle_windows_ctypes(output_dir: Path):
    # ★ Stage 1: only read data; must finish in milliseconds; release lock immediately
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
        # ★ Must close clipboard immediately!
        CloseClipboard()
    # ★ Stage 2: process data outside the lock (time-consuming ops)
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
                out_path = unique_path_in_dir(
                    output_dir, fname, is_folder=False)
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
            # Prefer ctypes
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
        # Fallback: pywin32
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


def get_clipboard_html():
    # ... existing code ...
    return {"type": "unknown"}


def set_clipboard_files(paths):
    if not paths:
        return {"success": False, "error": "no paths"}

    sys_name = platform.system()
    if sys_name == "Windows":
        try:
            # Prefer ctypes (no dependencies)
            if OpenClipboard(None):
                try:
                    EmptyClipboard()
                    # Calculate size
                    # DROPFILES struct + wide chars (null terminated) + final null terminator
                    offset = ctypes.sizeof(DROPFILES)
                    # Join with null, end with double null
                    joined = "\0".join(paths) + "\0\0"
                    content_bytes = joined.encode("utf-16le")
                    total_size = offset + len(content_bytes)

                    h_mem = GlobalAlloc(GHND, total_size)
                    if h_mem:
                        ptr = GlobalLock(h_mem)
                        if ptr:
                            try:
                                df = DROPFILES()
                                df.pFiles = offset
                                df.fWide = True
                                ctypes.memmove(ptr, ctypes.byref(df), offset)
                                ctypes.memmove(
                                    ptr + offset, content_bytes, len(content_bytes))
                            finally:
                                GlobalUnlock(h_mem)
                            SetClipboardData(CF_HDROP, h_mem)
                            return {"success": True}
                        else:
                            GlobalFree(h_mem)
                finally:
                    CloseClipboard()
        except Exception as e:
            return {"success": False, "error": str(e)}

        try:
            # Fallback: pywin32
            import win32clipboard as wcb
            import win32con as wcon
            wcb.OpenClipboard()
            try:
                wcb.EmptyClipboard()
                wcb.SetClipboardData(wcon.CF_HDROP, tuple(paths))
                return {"success": True}
            finally:
                wcb.CloseClipboard()
        except:
            pass

    elif sys_name == "Linux":
        # Linux text/uri-list
        uris = [Path(p).absolute().as_uri() for p in paths]
        content = "\n".join(uris).encode("utf-8")
        # Try wl-copy or xclip
        import subprocess
        try:
            if os.environ.get("WAYLAND_DISPLAY"):
                subprocess.run(
                    ["wl-copy", "--type", "text/uri-list"], input=content, check=True)
                return {"success": True}
        except:
            pass
        try:
            subprocess.run(["xclip", "-selection", "clipboard",
                           "-t", "text/uri-list"], input=content, check=True)
            return {"success": True}
        except:
            pass

    elif sys_name == "Darwin":
        # macOS pbcopy with file urls
        import subprocess
        uris = [Path(p).absolute().as_uri() for p in paths]
        # Use osascript to set clipboard to file list
        script = 'set the clipboard to ' + \
            ' & '.join([f'POSIX file "{p}"' for p in paths])
        try:
            subprocess.run(["osascript", "-e", script], check=True)
            return {"success": True}
        except:
            pass

    return {"success": False, "error": f"unsupported on {sys_name}"}
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
        SHGFI_LARGEICON = 0x000000000

        shfi = SHFILEINFOW()
        res = shell32.SHGetFileInfoW(
            str(file_path),
            0,
            ctypes.byref(shfi),
            ctypes.sizeof(shfi),
            SHGFI_ICON | SHGFI_LARGEICON
        )

        if not res or not shfi.hIcon:
            return None

        try:
            # We use a memory DC to draw the icon and then get its bits
            hdc_screen = GetDC(0)
            hdc_mem = CreateCompatibleDC(hdc_screen)

            width = 32
            height = 32

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


def save_clipboard_image_to_path(dest_path: str):
    if not _IS_WINDOWS:
        return {"success": False, "error": "not_supported_on_platform"}

    try:
        # 1. Try pywin32
        try:
            import win32clipboard as wcb
            import win32con as wcon
            wcb.OpenClipboard()
            try:
                dibv5_format = getattr(wcon, "CF_DIBV5", 17)
                fmt = None
                if wcb.IsClipboardFormatAvailable(dibv5_format):
                    fmt = dibv5_format
                elif wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
                    fmt = wcon.CF_DIB

                if fmt is not None:
                    dib_obj = wcb.GetClipboardData(fmt)
                    dib = bytes_from_pywin32_blob(dib_obj)
                    if dib:
                        from PIL import Image
                        import io
                        bmp = dib_to_bmp_bytes(dib)
                        img = Image.open(io.BytesIO(bmp))
                        out_path = Path(dest_path)
                        ensure_parent(out_path)
                        save_image_as_png(img, out_path)
                        return {"success": True, "path": str(out_path)}
            finally:
                wcb.CloseClipboard()
        except:
            pass

        # 2. Try ctypes
        if OpenClipboard(None):
            try:
                fmt = None
                if IsClipboardFormatAvailable(CF_DIBV5):
                    fmt = CF_DIBV5
                elif IsClipboardFormatAvailable(CF_DIB):
                    fmt = CF_DIB

                if fmt is not None:
                    h_mem = GetClipboardData(fmt)
                    if h_mem:
                        dib = read_global_data(h_mem)
                        if dib:
                            from PIL import Image
                            import io
                            bmp = dib_to_bmp_bytes(dib)
                            img = Image.open(io.BytesIO(bmp))
                            out_path = Path(dest_path)
                            ensure_parent(out_path)
                            save_image_as_png(img, out_path)
                            return {"success": True, "path": str(out_path)}
            finally:
                CloseClipboard()
    except Exception as e:
        return {"success": False, "error": str(e)}

    return {"success": False, "error": "no_image_in_clipboard"}


def trigger_system_paste(target_dir):
    """触发系统原生粘贴（仅 win32com，不依赖 PowerShell）""" // qq2q
    if not target_dir:
        return {"success": False, "error": "目标目录为空"} // qq2q

    if not _IS_WINDOWS:
        # macOS handling (via osascript)
        if platform.system() == "Darwin":
            import subprocess
            try:
                script = f'tell application "Finder" to paste to folder (POSIX file "{target_dir}")'
                subprocess.run(["osascript", "-e", script], check=True)
                return {"success": True}
            except Exception as e:
                return {"success": False, "error": f"osascript failed: {e}"}
        return {"success": False, "error": f"Not supported on {platform.system()}"}

    # Windows: use win32com to trigger system paste
    try:
        import win32com.client
        import pythoncom
    except ImportError:
        return {"success": False, "error": "win32com not available"}

    try:
        clean_path = os.path.abspath(target_dir).rstrip("\\")

        # Check whether target directory exists
        if not os.path.isdir(clean_path):
            return {"success": False, "error": f"Target folder not found: {clean_path}"}

        # Check whether clipboard has files
        files = get_clipboard_files_only()
        if not files or not files.get("paths"):
            return {"success": False, "error": "No files in clipboard"}

        pythoncom.CoInitialize()
        try:
            shell = win32com.client.Dispatch("Shell.Application")

            # Handle special paths: try short path
            folder = shell.NameSpace(clean_path)

            if not folder:
                # Fallback: try using short path (8.3)
                try:
                    import ctypes
                    buf = ctypes.create_unicode_buffer(260)
                    ctypes.windll.kernel32.GetShortPathNameW(clean_path, buf, 260)
                    short_path = buf.value
                    if short_path:
                        folder = shell.NameSpace(short_path)
                except:
                    pass

            if not folder:
                return {"success": False, "error": f"Cannot access folder via Shell: {clean_path}"}

            # Trigger system paste
            folder.Self.InvokeVerb("Paste")
            return {"success": True, "fileCount": len(files["paths"])}
        finally:
            pythoncom.CoUninitialize()
    except Exception as e:
        return {"success": False, "error": str(e)}


def _dispatch_action(cmd, cancel_version: int = None):
    """分发命令处理，cancel_version 用于可取消的耗时操作""" // qq2q
    request_id = cmd.get("_id", cmd.get("id", 0))
    out = {"_id": request_id}
    action = cmd.get("action") or cmd.get("cmd")
    if action == "ping":
        out["status"] = "alive"
        return out
    if action == "cancel_scans":
        # Cancel all ongoing scan operations
        new_ver = _bump_scan_cancel_version()
        out["status"] = "cancelled"
        out["new_version"] = new_ver
        return out
    if action in ("folder_info", "get_folder_info"):
        out.update(get_folder_info(cmd.get("path", ""), cancel_version))
        return out
    if action == "path_size":
        # Extreme optimized version: only get file/dir size, do not count extensions
        out.update(get_path_size(cmd.get("path", ""), cancel_version))
        return out
    if action == "disk_free":
        # Get disk free space
        out.update(get_disk_free(cmd.get("drive", cmd.get("path", ""))))
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
    if action == "hasImage":
        # Check if clipboard contains image format
        try:
            if not OpenClipboard(None):
                out["value"] = False
                return out
            try:
                # CF_DIB (8), CF_DIBV5 (17) or CF_BITMAP (2)
                has_dib = IsClipboardFormatAvailable(
                    8) or IsClipboardFormatAvailable(17) or IsClipboardFormatAvailable(2)
                out["value"] = bool(has_dib)
            finally:
                CloseClipboard()
        except:
            out["value"] = False
        return out
    if action == "saveImage":
        dest_path = cmd.get("path")
        if not dest_path:
            out["success"] = False
            out["error"] = "no path provided"
        else:
            out.update(save_clipboard_image_to_path(dest_path))
        return out
    if action in ("clipboard_peek", "peek"):
        # Simplified peek: only returns basic info; content handled by clipboard interface
        out["type"] = "peek"
        return out
    if action == "get_clipboard_files":
        out.update(get_clipboard_files_only())
        return out
    if action == "set_clipboard_files" or action == "setFiles":
        paths = cmd.get("paths") or cmd.get("file_paths") or []
        out.update(set_clipboard_files(paths))
        return out
    if action == "get_html":
        out.update(get_clipboard_html())
        return out
    if action == "exit":
        # ★ Graceful exit command
        out["status"] = "exiting"
        # Print response first, then exit
        print(json.dumps(out, ensure_ascii=False), flush=True)
        sys.exit(0)
    if action == "trigger_system_paste":
        target_dir = cmd.get("path") or cmd.get("target_dir")
        out.update(trigger_system_paste(target_dir))
        return out
    if action in ("clipboard", "paste"):
        target_dir = cmd.get("target_dir", cmd.get("output_dir"))
        out.update(handle_clipboard(target_dir))
        return out
    # =============================================================================
    #  Audio playback commands
    # =============================================================================
    if action == "check_audio_engine":
        out.update(_check_audio_engine())
        return out
    if action == "play_audio":
        file_path = cmd.get("path", "")
        count = cmd.get("count", 1)
        try:
            count = int(count)
        except:
            count = 1
        out.update(_play_audio(file_path, count))
        return out
    if action == "stop_audio":
        out.update(_stop_audio())
        return out
    if action == "get_audio_state":
        out.update(_get_audio_state())
        return out
    # =============================================================================
    #  Clipboard watcher commands
    # =============================================================================
    if action == "start_clipboard_watcher":
        out.update(_start_clipboard_watcher())
        return out
    if action == "stop_clipboard_watcher":
        out.update(_stop_clipboard_watcher())
        return out
    # =============================================================================
    #  SFX playback commands (play_sfx)
    # =============================================================================
    if action == "play_sfx":
        category = cmd.get("category", "kope")
        idx = cmd.get("idx", -1)  # -1 = random
        name = cmd.get("name")    # Specify filename (highest priority)
        _play_sfx(category, idx, name)
        out["status"] = "played"
        return out
    out["error"] = f"unknown action: {action}"
    return out


def daemon_mode():
    """多线程 daemon 模式：支持取消耗时操作""" // qq2q
    import queue

    try:
        if hasattr(sys.stdin, 'reconfigure'):
            sys.stdin.reconfigure(encoding='utf-8')
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8')
    except:
        pass

    sys.stderr.write(f"Daemon started (multithreaded). PID={os.getpid()}\n")
    sys.stderr.flush()

    # ★ Industrial-grade fix: parent process watchdog
    # When parent process (VS Code) crashes, auto-exit to avoid becoming a zombie process
    parent_pid = os.getppid()
    def parent_watchdog():
        while True:
            time.sleep(6)
            try:
                # Check whether parent process exists (signal 0 checks only; does not kill)
                if platform.system() == "Windows":
                    import ctypes
                    kernel32 = ctypes.windll.kernel32
                    handle = kernel32.OpenProcess(0x1000, False, parent_pid)  # PROCESS_QUERY_LIMITED_INFORMATION
                    if handle == 0:
                        sys.stderr.write(f"Parent process {parent_pid} died, exiting...\n")
                        sys.stderr.flush()
                        os._exit(0)
                    kernel32.CloseHandle(handle)
                else:
                    os.kill(parent_pid, 0)
            except OSError:
                sys.stderr.write(f"Parent process {parent_pid} died, exiting...\n")
                sys.stderr.flush()
                os._exit(0)
            except:
                pass

    watchdog_thread = threading.Thread(target=parent_watchdog, daemon=True)
    watchdog_thread.start()

    # Result queue: thread-safe
    result_queue = queue.Queue()

    # stdout writer thread: take results from result_queue and write to stdout
    def stdout_writer():
        while True:
            try:
                result = result_queue.get()
                if result is None:  # termination signal
                    break
                try:
                    print(json.dumps(result, ensure_ascii=True), flush=True)
                except:
                    pass
            except:
                pass

    writer_thread = threading.Thread(target=stdout_writer, daemon=True)
    writer_thread.start()

    # Slow actions list (need to submit to thread pool)
    SLOW_ACTIONS = {"path_size", "folder_info", "get_folder_info"}

    # Worker function: execute slow actions in thread pool
    def execute_slow_action(cmd, cancel_ver):
        try:
            res = _dispatch_action(cmd, cancel_ver)
        except Exception as e:
            res = {"_id": cmd.get("_id", 0), "error": str(e)}
        result_queue.put(res)

    # Main loop: read stdin and dispatch commands
    while True:
        try:
            line_bytes = sys.stdin.buffer.readline()
            if not line_bytes:
                # ★ Industrial-grade fix: stdin EOF means parent closed; exit immediately
                sys.stderr.write("Daemon stdin EOF, exiting...\n")
                sys.stderr.flush()
                break

            line = line_bytes.decode('utf-8', errors='ignore').strip()
            if not line:
                continue

            try:
                cmd = json.loads(line)
            except Exception as e:
                result_queue.put({"_id": 0, "error": str(e)})
                continue

            action = cmd.get("action") or cmd.get("cmd") or ""

            if action in SLOW_ACTIONS:
                # Slow action: submit to thread pool with current cancel version
                cancel_ver = _get_scan_cancel_version()
                _IO_EXECUTOR.submit(execute_slow_action, cmd, cancel_ver)
            else:
                # Fast action: execute directly (including cancel_scans)
                try:
                    res = _dispatch_action(cmd)
                except Exception as e:
                    res = {"_id": cmd.get("_id", 0), "error": str(e)}
                result_queue.put(res)

        except KeyboardInterrupt:
            break
        except Exception as e:
            sys.stderr.write(f"Daemon loop error: {e}\n")
            sys.stderr.flush()
            time.sleep(0.05)

    # Cleanup
    result_queue.put(None)  # Terminate stdout_writer thread


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

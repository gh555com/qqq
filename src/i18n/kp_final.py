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

# ---- Broker/IPC extras ----
import socket
import tempfile
import queue
import zlib

# =============================================================================
#  Event sink (stdout events)  ★ Broker 模式下必须禁用，避免污染协议/日志
# =============================================================================
_EVENT_SINK_LOCK = threading.Lock()
_EVENT_SINK = None  # callable(obj:dict) -> None

def _set_event_sink(fn):
    global _EVENT_SINK
    with _EVENT_SINK_LOCK:
        _EVENT_SINK = fn

def _emit_event(obj: dict):
    with _EVENT_SINK_LOCK:
        fn = _EVENT_SINK
    if not fn:
        return
    try:
        fn(obj)
    except:
        pass

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
    if _AUDIO_LOCK is None:
        _AUDIO_LOCK = threading.Lock()

    with _AUDIO_LOCK:
        if _AUDIO_ENGINE is not None:
            return _AUDIO_ENGINE, None
        if _AUDIO_ENGINE_ERROR is not None:
            return None, _AUDIO_ENGINE_ERROR

        try:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            ma_path = os.path.join(script_dir, "miniaudio_v16.py")

            if not os.path.exists(ma_path):
                _AUDIO_ENGINE_ERROR = f"miniaudio_v16.py not found: {ma_path}"
                return None, _AUDIO_ENGINE_ERROR

            spec = importlib.util.spec_from_file_location("miniaudio_v16", ma_path)
            ma_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(ma_module)

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

    engine, err = _init_audio_engine()
    if err:
        return {"status": "error", "error": err}

    if not os.path.exists(file_path):
        return {"status": "error", "error": f"file not found: {file_path}"}

    try:
        if _AUDIO_CURRENT_TOKEN:
            try:
                _AUDIO_CURRENT_TOKEN.stop()
            except:
                pass
            _AUDIO_CURRENT_TOKEN = None

        if count == 0 or count == -1:
            _AUDIO_CURRENT_TOKEN = engine.play_sound_file(
                file_path=file_path,
                loop=True,
                trim_silence=True
            )
            _AUDIO_IS_LOOPING = True
        elif count == 1:
            _AUDIO_CURRENT_TOKEN = engine.az(file_path, 1, 2.0, True)
            _AUDIO_IS_LOOPING = False
        else:
            _AUDIO_CURRENT_TOKEN = engine.az(file_path, count, 2.0, True)
            _AUDIO_IS_LOOPING = False

        def _monitor_playback():
            global _AUDIO_CURRENT_TOKEN
            token = _AUDIO_CURRENT_TOKEN
            eng = engine
            if token is None:
                return
            while True:
                if token.stopped:
                    break
                try:
                    with eng._tokens_lock:
                        if token not in eng._active_tokens:
                            break
                except:
                    break
                time.sleep(0.2)
            if not _AUDIO_IS_LOOPING and token == _AUDIO_CURRENT_TOKEN:
                _AUDIO_CURRENT_TOKEN = None
                _emit_event({"event": "audio_finished"})

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
#  ★ Sound effect system (v16 AudioHub)
# =============================================================================
_AUDIO_HUB = None
_AUDIO_HUB_LOCK = threading.Lock()
_SFX_REGISTRY = {}
_SFX_LAST_IDX = {}
_SFX_PRIMED = False
_SFX_PRIME_DELAY = 5

_CLIPBOARD_WATCHER_STARTED = False
_CLIPBOARD_STATE_LOCK = threading.Lock()

def _init_sfx_paths():
    global _SFX_REGISTRY
    if _SFX_REGISTRY:
        return _SFX_REGISTRY

    script_dir = os.path.dirname(os.path.abspath(__file__))
    assets_dir = os.path.join(script_dir, "..", "assets")
    if not os.path.isdir(assets_dir):
        assets_dir = os.path.join(script_dir, "assets")

    kope_dir = os.path.join(assets_dir, "kope")
    if os.path.isdir(kope_dir):
        _SFX_REGISTRY["kope"] = [os.path.join(kope_dir, f"{i}.mp3") for i in range(1, 8)]

    yz_dir = os.path.join(assets_dir, "yz")
    if os.path.isdir(yz_dir):
        yz_files = sorted([f for f in os.listdir(yz_dir) if f.endswith((".mp3", ".wav"))])
        _SFX_REGISTRY["yz"] = [os.path.join(yz_dir, f) for f in yz_files]

    return _SFX_REGISTRY

def _background_prime_sfx():
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
    global _AUDIO_HUB
    if _AUDIO_HUB is not None:
        return _AUDIO_HUB

    with _AUDIO_HUB_LOCK:
        if _AUDIO_HUB is not None:
            return _AUDIO_HUB

        try:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            v16_path = os.path.join(script_dir, "miniaudio_v16.py")
            spec = importlib.util.spec_from_file_location("miniaudio_v16", v16_path)
            v16 = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(v16)

            hub = v16.AudioHub(
                asset_folder=".",
                music_workers=16,
                sfx_workers=24,
                sfx_use_music_engine=True,
                silent=True
            )

            _AUDIO_HUB = hub
            threading.Thread(target=_background_prime_sfx, daemon=True, name="sfx-prime").start()
            return hub
        except Exception as e:
            import traceback
            sys.stderr.write(f"[AudioHub] Init failed: {e}\n{traceback.format_exc()}")
            sys.stderr.flush()
            return None

def _play_sfx(category: str, idx: int = -1, name: str = None):
    global _SFX_LAST_IDX
    hub = _get_audio_hub()
    if not hub:
        return

    _init_sfx_paths()
    paths = _SFX_REGISTRY.get(category, [])
    if not paths:
        return

    valid_paths = [p for p in paths if os.path.isfile(p)]
    if not valid_paths:
        return

    if name:
        for p in valid_paths:
            if os.path.basename(p) == name:
                hub.play_sfx(p)
                return
        return

    if idx < 0:
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
    global _CLIPBOARD_WATCHER_STARTED
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
        with _CLIPBOARD_STATE_LOCK:
            _CLIPBOARD_WATCHER_STARTED = True
        return {"status": "started"}
    except Exception as e:
        return {"status": "error", "error": str(e)}

def _stop_clipboard_watcher():
    global _CLIPBOARD_WATCHER_STARTED
    hub = _get_audio_hub()
    if hub:
        try:
            hub.stop_clipboard()
        except:
            pass
    with _CLIPBOARD_STATE_LOCK:
        _CLIPBOARD_WATCHER_STARTED = False
    return {"status": "stopped"}

def _get_clipboard_watcher_state():
    with _CLIPBOARD_STATE_LOCK:
        return {"started": bool(_CLIPBOARD_WATCHER_STARTED)}

# =============================================================================
#  Configuration
# =============================================================================
_MAX_WORKERS = min(32, max(4, (os.cpu_count() or 4) * 2))
_IO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=_MAX_WORKERS)

# =============================================================================
#  Scan cancel mechanism
# =============================================================================
_SCAN_CANCEL_VERSION = 0
_SCAN_CANCEL_LOCK = threading.Lock()

def _bump_scan_cancel_version():
    global _SCAN_CANCEL_VERSION
    with _SCAN_CANCEL_LOCK:
        _SCAN_CANCEL_VERSION += 1
        return _SCAN_CANCEL_VERSION

def _get_scan_cancel_version():
    with _SCAN_CANCEL_LOCK:
        return _SCAN_CANCEL_VERSION

def _is_scan_cancelled(my_version):
    return _get_scan_cancel_version() != my_version

# =============================================================================
#  Utilities
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
    valid_chars = [c for c in "abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" if c.lower() not in excluded_chars]
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
    base = output_dir / name
    if not base.exists():
        return base

    if is_folder:
        stem = name
        ext = ""
    else:
        stem = base.stem
        ext = base.suffix
        if not stem and ext.startswith('.'):
            stem = ext
            ext = ""

    for i in range(1, 1000):
        new_name = f"{stem}_{i}{ext}"
        new_path = output_dir / new_name
        if not new_path.exists():
            return new_path
    return base

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
    DragQueryFileW.argtypes = [wintypes.HGLOBAL, wintypes.UINT, ctypes.c_wchar_p, wintypes.UINT]
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
        colors_used = int.from_bytes(dib[32:36], "little", signed=False) if len(dib) >= 36 else 0
        palette_entry_size = 4
    palette_colors = colors_used if colors_used else (1 << bpp if 0 < bpp <= 8 else 0)
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
    done, _ = concurrent.futures.wait(futs, return_when=concurrent.futures.FIRST_COMPLETED)
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
        if dst_dir.exists():
            dst_dir = unique_path_in_dir(output_dir, safe_filename(src_dir.name), is_folder=True)
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
#  Folder stats
# =============================================================================
def get_folder_info(folder_path: str, cancel_version: int = None):
    if not folder_path or not isinstance(folder_path, str):
        return {"success": False, "error": "empty path"}
    if not os.path.isdir(folder_path):
        return {"success": False, "error": "path not a directory"}

    total_size = 0
    file_count = 0
    ext_counts = {}
    check_count = 0

    try:
        stack = [folder_path]
        scandir = os.scandir
        ext_get = ext_counts.get

        while stack:
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
                            file_count += 1
                            check_count += 1

                            n = e.name
                            i = n.rfind(".")
                            if 0 < i < (len(n) - 1):
                                ext = n[i + 1:].lower()
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
    if not drive:
        drive = os.environ.get('SystemDrive', 'C:')
    drive = drive.strip()
    if len(drive) == 1 and drive.isalpha():
        drive = drive.upper() + ":\\"
    elif len(drive) == 2 and drive[1] == ':':
        drive = drive.upper() + "\\"
    elif not drive.endswith("\\") and not drive.endswith("/"):
        drive = drive + "\\"

    try:
        usage = shutil.disk_usage(drive)
        return {"success": True, "free": usage.free, "total": usage.total, "used": usage.used}
    except Exception as e:
        return {"success": False, "error": str(e)}

def get_path_size(path: str, cancel_version: int = None):
    if not path or not isinstance(path, str):
        return {"success": False, "error": "empty path"}

    try:
        if os.path.isfile(path):
            try:
                return {"success": True, "total_size": os.stat(path, follow_symlinks=True).st_size}
            except Exception as e:
                return {"success": False, "error": str(e)}

        if not os.path.isdir(path):
            return {"success": False, "error": "path not a file or directory"}

        total_size = 0
        check_count = 0
        stack = [path]
        scandir = os.scandir

        while stack:
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
#  Windows clipboard handlers (same as your version)
# =============================================================================
def handle_windows_pywin32(wcb, wcon, output_dir: Path):
    data_to_process = None
    try:
        wcb.OpenClipboard()
        try:
            has_files = wcb.IsClipboardFormatAvailable(wcon.CF_HDROP)
            has_text = (wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT) or
                        wcb.IsClipboardFormatAvailable(wcon.CF_TEXT))
            dibv5_format = getattr(wcon, "CF_DIBV5", 17)
            has_dib = (wcb.IsClipboardFormatAvailable(dibv5_format) or
                       wcb.IsClipboardFormatAvailable(wcon.CF_DIB))
            if has_text and not has_files and not has_dib:
                try:
                    if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT):
                        text = wcb.GetClipboardData(wcon.CF_UNICODETEXT)
                        if isinstance(text, str) and text.strip():
                            data_to_process = {"type": "text", "text": text}
                except Exception:
                    pass
            elif has_files:
                try:
                    paths = wcb.GetClipboardData(wcon.CF_HDROP) or []
                    if paths:
                        data_to_process = {"type": "files", "paths": list(paths)}
                except:
                    pass
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
            wcb.CloseClipboard()
    except Exception:
        pass

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
                return {"type": "file_folder", "folders": copied_dirs, "files": copied_files}
            return None
        if data_to_process["type"] == "dib":
            try:
                from PIL import Image
                import io
                dib = data_to_process["data"]
                bmp = dib_to_bmp_bytes(dib)
                img = Image.open(io.BytesIO(bmp))
                fname = get_timestamp_filename(".png")
                out_path = unique_path_in_dir(output_dir, fname, is_folder=False)
                ensure_parent(out_path)
                save_image_as_png(img, out_path)
                return {"type": "image", "path": str(out_path)}
            except Exception:
                return None
    except Exception:
        return None
    return None

def handle_windows_ctypes(output_dir: Path):
    data_to_process = None
    if not OpenClipboard(None):
        return {"error": "Cannot open clipboard"}
    try:
        has_files = IsClipboardFormatAvailable(CF_HDROP)
        has_text = IsClipboardFormatAvailable(CF_UNICODETEXT) or IsClipboardFormatAvailable(CF_TEXT)
        has_dib = IsClipboardFormatAvailable(CF_DIBV5) or IsClipboardFormatAvailable(CF_DIB)

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
                                    data_to_process = {"type": "text", "text": text}
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
        CloseClipboard()

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
                return {"type": "file_folder", "folders": copied_dirs, "files": copied_files}
            return {"type": "unknown"}
        if data_to_process["type"] == "dib":
            try:
                from PIL import Image
                import io
                dib = data_to_process["data"]
                bmp = dib_to_bmp_bytes(dib)
                img = Image.open(io.BytesIO(bmp))
                fname = get_timestamp_filename(".png")
                out_path = unique_path_in_dir(output_dir, fname, is_folder=False)
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
    return {"type": "unknown"}

def set_clipboard_files(paths):
    if not paths:
        return {"success": False, "error": "no paths"}

    sys_name = platform.system()
    if sys_name == "Windows":
        try:
            if OpenClipboard(None):
                try:
                    EmptyClipboard()
                    offset = ctypes.sizeof(DROPFILES)
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
                                ctypes.memmove(ptr + offset, content_bytes, len(content_bytes))
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
        uris = [Path(p).absolute().as_uri() for p in paths]
        content = "\n".join(uris).encode("utf-8")
        import subprocess
        try:
            if os.environ.get("WAYLAND_DISPLAY"):
                subprocess.run(["wl-copy", "--type", "text/uri-list"], input=content, check=True)
                return {"success": True}
        except:
            pass
        try:
            subprocess.run(["xclip", "-selection", "clipboard", "-t", "text/uri-list"], input=content, check=True)
            return {"success": True}
        except:
            pass

    elif sys_name == "Darwin":
        import subprocess
        script = 'set the clipboard to ' + ' & '.join([f'POSIX file "{p}"' for p in paths])
        try:
            subprocess.run(["osascript", "-e", script], check=True)
            return {"success": True}
        except:
            pass

    return {"success": False, "error": f"unsupported on {sys_name}"}

# =============================================================================
#  Daemon / CLI helpers (same as your version)
# =============================================================================
def get_file_icon_base64(file_path: str):
    if not _IS_WINDOWS:
        return None

    try:
        import io
        from PIL import Image

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
            hdc_screen = GetDC(0)
            hdc_mem = CreateCompatibleDC(hdc_screen)

            width = 32
            height = 32

            bmi = BITMAPINFO()
            bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bmi.bmiHeader.biWidth = width
            bmi.bmiHeader.biHeight = -height
            bmi.bmiHeader.biPlanes = 1
            bmi.bmiHeader.biBitCount = 32
            bmi.bmiHeader.biCompression = 0

            ptr_bits = ctypes.c_void_p()
            hbmp_dib = CreateDIBSection(hdc_mem, ctypes.byref(bmi), 0, ctypes.byref(ptr_bits), None, 0)
            hold_bmp = SelectObject(hdc_mem, hbmp_dib)

            DrawIconEx(hdc_mem, 0, 0, shfi.hIcon, width, height, 0, None, 0x0003)

            size = width * height * 4
            buffer = (ctypes.c_char * size).from_address(ptr_bits.value)
            img = Image.frombuffer("RGBA", (width, height), buffer, "raw", "BGRA", 0, 1)

            output = io.BytesIO()
            img.save(output, format="PNG")
            base64_str = base64.b64encode(output.getvalue()).decode("ascii")

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
    if not target_dir:
        return {"success": False, "error": "target directory is empty"}

    if not _IS_WINDOWS:
        if platform.system() == "Darwin":
            import subprocess
            try:
                script = f'tell application "Finder" to paste to folder (POSIX file "{target_dir}")'
                subprocess.run(["osascript", "-e", script], check=True)
                return {"success": True}
            except Exception as e:
                return {"success": False, "error": f"osascript failed: {e}"}
        return {"success": False, "error": f"Not supported on {platform.system()}"}

    try:
        import win32com.client
        import pythoncom
    except ImportError:
        return {"success": False, "error": "win32com not available"}

    try:
        clean_path = os.path.abspath(target_dir).rstrip("\\")
        if not os.path.isdir(clean_path):
            return {"success": False, "error": f"Target folder not found: {clean_path}"}

        files = get_clipboard_files_only()
        if not files or not files.get("paths"):
            return {"success": False, "error": "No files in clipboard"}

        pythoncom.CoInitialize()
        try:
            shell = win32com.client.Dispatch("Shell.Application")
            folder = shell.NameSpace(clean_path)

            if not folder:
                try:
                    buf = ctypes.create_unicode_buffer(260)
                    ctypes.windll.kernel32.GetShortPathNameW(clean_path, buf, 260)
                    short_path = buf.value
                    if short_path:
                        folder = shell.NameSpace(short_path)
                except:
                    pass

            if not folder:
                return {"success": False, "error": f"Cannot access folder via Shell: {clean_path}"}

            folder.Self.InvokeVerb("Paste")
            return {"success": True, "fileCount": len(files["paths"])}
        finally:
            pythoncom.CoUninitialize()
    except Exception as e:
        return {"success": False, "error": str(e)}

# =============================================================================
#  Unified dispatch (stdout daemon + broker 都用同一套 action)
#  ★ 关键：exit 不再直接 sys.exit；由上层(mode)决定
# =============================================================================
def _dispatch_action(cmd, cancel_version: int = None, allow_process_exit: bool = True):
    request_id = cmd.get("_id", cmd.get("id", 0))
    out = {"_id": request_id}
    action = cmd.get("action") or cmd.get("cmd")

    if action == "ping":
        out["status"] = "alive"
        return out

    if action == "cancel_scans":
        new_ver = _bump_scan_cancel_version()
        out["status"] = "cancelled"
        out["new_version"] = new_ver
        return out

    if action in ("folder_info", "get_folder_info"):
        out.update(get_folder_info(cmd.get("path", ""), cancel_version))
        return out

    if action == "path_size":
        out.update(get_path_size(cmd.get("path", ""), cancel_version))
        return out

    if action == "disk_free":
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
        try:
            if not OpenClipboard(None):
                out["value"] = False
                return out
            try:
                has_dib = IsClipboardFormatAvailable(8) or IsClipboardFormatAvailable(17) or IsClipboardFormatAvailable(2)
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
        out["status"] = "exiting"
        out["_should_exit_process"] = bool(allow_process_exit)
        return out

    if action == "trigger_system_paste":
        target_dir = cmd.get("path") or cmd.get("target_dir")
        out.update(trigger_system_paste(target_dir))
        return out

    if action in ("clipboard", "paste"):
        target_dir = cmd.get("target_dir", cmd.get("output_dir"))
        out.update(handle_clipboard(target_dir))
        return out

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

    if action == "start_clipboard_watcher":
        out.update(_start_clipboard_watcher())
        return out

    if action == "stop_clipboard_watcher":
        out.update(_stop_clipboard_watcher())
        return out

    if action == "get_clipboard_watcher_state":
        out.update(_get_clipboard_watcher_state())
        return out

    if action == "play_sfx":
        category = cmd.get("category", "kope")
        idx = cmd.get("idx", -1)
        name = cmd.get("name")
        try:
            idx = int(idx)
        except:
            idx = -1
        _play_sfx(category, idx, name)
        out["status"] = "played"
        return out

    out["error"] = f"unknown action: {action}"
    return out

# =============================================================================
#  Legacy stdin/stdout daemon (kept)
# =============================================================================
def daemon_mode():
    import queue as _queue
    _set_event_sink(lambda obj: print(json.dumps(obj, ensure_ascii=False), flush=True))

    try:
        if hasattr(sys.stdin, 'reconfigure'):
            sys.stdin.reconfigure(encoding='utf-8')
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8')
    except:
        pass

    sys.stderr.write(f"Daemon started (multithreaded). PID={os.getpid()}\n")
    sys.stderr.flush()

    parent_pid = os.getppid()
    def parent_watchdog():
        while True:
            time.sleep(6)
            try:
                if platform.system() == "Windows":
                    k32 = ctypes.windll.kernel32
                    handle = k32.OpenProcess(0x1000, False, parent_pid)
                    if handle == 0:
                        sys.stderr.write(f"Parent process {parent_pid} died, exiting...\n")
                        sys.stderr.flush()
                        os._exit(0)
                    k32.CloseHandle(handle)
                else:
                    os.kill(parent_pid, 0)
            except OSError:
                sys.stderr.write(f"Parent process {parent_pid} died, exiting...\n")
                sys.stderr.flush()
                os._exit(0)
            except:
                pass

    threading.Thread(target=parent_watchdog, daemon=True).start()

    result_queue = _queue.Queue()

    def stdout_writer():
        while True:
            try:
                result = result_queue.get()
                if result is None:
                    break
                try:
                    print(json.dumps(result, ensure_ascii=True), flush=True)
                except:
                    pass
            except:
                pass

    threading.Thread(target=stdout_writer, daemon=True).start()

    SLOW_ACTIONS = {"path_size", "folder_info", "get_folder_info"}

    def execute_slow_action(cmd, cancel_ver):
        try:
            res = _dispatch_action(cmd, cancel_ver, allow_process_exit=True)
        except Exception as e:
            res = {"_id": cmd.get("_id", 0), "error": str(e)}
        result_queue.put(res)

    while True:
        try:
            line_bytes = sys.stdin.buffer.readline()
            if not line_bytes:
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
                cancel_ver = _get_scan_cancel_version()
                _IO_EXECUTOR.submit(execute_slow_action, cmd, cancel_ver)
            else:
                try:
                    res = _dispatch_action(cmd, None, allow_process_exit=True)
                except Exception as e:
                    res = {"_id": cmd.get("_id", 0), "error": str(e)}
                result_queue.put(res)

                if (cmd.get("action") or cmd.get("cmd")) == "exit":
                    try:
                        if res.get("_should_exit_process"):
                            break
                    except:
                        break

        except KeyboardInterrupt:
            break
        except Exception as e:
            sys.stderr.write(f"Daemon loop error: {e}\n")
            sys.stderr.flush()
            time.sleep(0.05)

    result_queue.put(None)

# =============================================================================
#  =========================  BROKER SINGLETON LAYER  =========================
# =============================================================================
APP_ID = "vix-broker"
BROKER_PROTOCOL = 1

HEARTBEAT_TTL_SEC = 80
LEASE_SWEEP_INTERVAL_SEC = 5

ENDPOINT_DIRNAME = "vix_audio_broker"
ENDPOINT_FILENAME = "endpoint.json"
TOKEN_FILENAME = "token.txt"

ENABLE_LOCAL_TOKEN = True

def _log(msg: str):
    try:
        sys.stderr.write(f"[{APP_ID}] {msg}\n")
        sys.stderr.flush()
    except:
        pass

def _now_mono() -> float:
    return time.monotonic()

def _get_endpoint_dir() -> Path:
    sysname = platform.system()
    if sysname == "Windows":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or tempfile.gettempdir()
        p = Path(base) / ENDPOINT_DIRNAME
    else:
        base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
        p = Path(base) / ENDPOINT_DIRNAME
    try:
        p.mkdir(parents=True, exist_ok=True)
    except:
        p = Path(tempfile.gettempdir()) / ENDPOINT_DIRNAME
        try:
            p.mkdir(parents=True, exist_ok=True)
        except:
            pass
    return p

def _endpoint_file_path() -> Path:
    return _get_endpoint_dir() / ENDPOINT_FILENAME

def _token_file_path() -> Path:
    return _get_endpoint_dir() / TOKEN_FILENAME

def _load_or_create_local_token() -> str:
    if not ENABLE_LOCAL_TOKEN:
        return ""
    tp = _token_file_path()
    try:
        if tp.exists():
            t = tp.read_text("utf-8", errors="ignore").strip()
            if t:
                return t
    except:
        pass
    try:
        token = base64.b64encode(os.urandom(24)).decode("ascii")
    except:
        token = str(int(time.time())) + "-" + str(random.randint(100000, 999999))
    try:
        tp.write_text(token, "utf-8")
        try:
            if platform.system() != "Windows":
                os.chmod(str(tp), 0o600)
        except:
            pass
    except:
        pass
    return token

def _write_endpoint_file(data: dict):
    fp = _endpoint_file_path()
    try:
        fp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    except:
        pass

def _read_endpoint_file() -> dict:
    fp = _endpoint_file_path()
    try:
        if fp.exists():
            return json.loads(fp.read_text("utf-8", errors="ignore"))
    except:
        pass
    return {}

def _sanitize_id(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return "user"
    return re.sub(r"[^0-9A-Za-z_\-\.]+", "_", s)[:80] or "user"

def _get_unix_socket_path() -> str:
    uid = ""
    try:
        uid = str(os.getuid())
    except:
        uid = _sanitize_id(os.environ.get("USER") or "user")
    name = f"{ENDPOINT_DIRNAME}_{uid}.sock"
    return str(Path(tempfile.gettempdir()) / name)

# ---------------- Windows Named Pipe (rock-solid singleton) -------------------
_PIPE_NAME = None

if _IS_WINDOWS:
    # WinAPI for Named Pipe
    INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

    PIPE_ACCESS_DUPLEX = 0x00000003
    FILE_FLAG_OVERLAPPED = 0x40000000
    FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000

    PIPE_TYPE_BYTE = 0x00000000
    PIPE_READMODE_BYTE = 0x00000000
    PIPE_WAIT = 0x00000000
    PIPE_UNLIMITED_INSTANCES = 255

    ERROR_IO_PENDING = 997
    ERROR_PIPE_CONNECTED = 535
    ERROR_BROKEN_PIPE = 109
    ERROR_NO_DATA = 232
    WAIT_OBJECT_0 = 0
    WAIT_TIMEOUT = 258

    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    OPEN_EXISTING = 3

    kernel32.GetLastError.restype = wintypes.DWORD

    CreateNamedPipeW = kernel32.CreateNamedPipeW
    CreateNamedPipeW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
        wintypes.DWORD, ctypes.c_void_p
    ]
    CreateNamedPipeW.restype = wintypes.HANDLE

    ConnectNamedPipe = kernel32.ConnectNamedPipe
    ConnectNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    ConnectNamedPipe.restype = wintypes.BOOL

    DisconnectNamedPipe = kernel32.DisconnectNamedPipe
    DisconnectNamedPipe.argtypes = [wintypes.HANDLE]
    DisconnectNamedPipe.restype = wintypes.BOOL

    ReadFile = kernel32.ReadFile
    ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    ReadFile.restype = wintypes.BOOL

    WriteFile = kernel32.WriteFile
    WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    WriteFile.restype = wintypes.BOOL

    CloseHandle = kernel32.CloseHandle
    CloseHandle.argtypes = [wintypes.HANDLE]
    CloseHandle.restype = wintypes.BOOL

    CreateFileW = kernel32.CreateFileW
    CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE
    ]
    CreateFileW.restype = wintypes.HANDLE

    WaitNamedPipeW = kernel32.WaitNamedPipeW
    WaitNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
    WaitNamedPipeW.restype = wintypes.BOOL

    CreateEventW = kernel32.CreateEventW
    CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    CreateEventW.restype = wintypes.HANDLE

    WaitForSingleObject = kernel32.WaitForSingleObject
    WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    WaitForSingleObject.restype = wintypes.DWORD

    GetOverlappedResult = kernel32.GetOverlappedResult
    GetOverlappedResult.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL]
    GetOverlappedResult.restype = wintypes.BOOL

    CancelIoEx = getattr(kernel32, "CancelIoEx", None)
    if CancelIoEx:
        CancelIoEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
        CancelIoEx.restype = wintypes.BOOL

    class OVERLAPPED(ctypes.Structure):
        _fields_ = [
            ("Internal", wintypes.ULONG_PTR),
            ("InternalHigh", wintypes.ULONG_PTR),
            ("Offset", wintypes.DWORD),
            ("OffsetHigh", wintypes.DWORD),
            ("hEvent", wintypes.HANDLE),
        ]

def _get_windows_pipe_name() -> str:
    # 尽量保证“同一用户同一会话”唯一，跨会话不互相干扰
    u = _sanitize_id(os.environ.get("USERNAME") or os.environ.get("USER") or "user")
    dom = _sanitize_id(os.environ.get("USERDOMAIN") or "")
    sess = _sanitize_id(os.environ.get("SESSIONNAME") or "")
    base = f"{ENDPOINT_DIRNAME}_{dom}_{u}_{sess}".strip("_")
    return r"\\.\pipe\%s" % base

def _try_connect_unix(sock_path: str, token: str) -> bool:
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.25)
        s.connect(sock_path)
        try:
            req = {"_id": 0, "action": "hello", "client_id": "probe", "token": token}
            s.sendall((json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8"))
            data = s.recv(4096)
            if not data:
                return False
            line = data.split(b"\n", 1)[0].decode("utf-8", errors="ignore").strip()
            if not line:
                return False
            obj = json.loads(line)
            return bool(obj.get("ok")) and obj.get("app_id") == APP_ID
        finally:
            try:
                s.close()
            except:
                pass
    except:
        return False

def _win_pipe_write(h: int, b: bytes) -> bool:
    if not b:
        return True
    sent = wintypes.DWORD(0)
    ok = WriteFile(wintypes.HANDLE(h), ctypes.c_char_p(b), len(b), ctypes.byref(sent), None)
    return bool(ok) and int(sent.value) == len(b)

def _win_pipe_read_some_overlapped(h: int, timeout_ms: int = 500):
    buf = ctypes.create_string_buffer(65536)
    nread = wintypes.DWORD(0)
    ov = OVERLAPPED()
    ov.hEvent = CreateEventW(None, True, False, None)
    if not ov.hEvent:
        return b""
    try:
        ok = ReadFile(wintypes.HANDLE(h), buf, 65536, ctypes.byref(nread), ctypes.byref(ov))
        if ok:
            return buf.raw[:int(nread.value)]
        err = int(kernel32.GetLastError())
        if err == ERROR_BROKEN_PIPE or err == ERROR_NO_DATA:
            return None
        if err != ERROR_IO_PENDING:
            return None

        rc = int(WaitForSingleObject(ov.hEvent, timeout_ms))
        if rc == WAIT_TIMEOUT:
            if CancelIoEx:
                try:
                    CancelIoEx(wintypes.HANDLE(h), ctypes.byref(ov))
                except:
                    pass
            return b""
        if rc != WAIT_OBJECT_0:
            return None

        ok2 = GetOverlappedResult(wintypes.HANDLE(h), ctypes.byref(ov), ctypes.byref(nread), False)
        if not ok2:
            err2 = int(kernel32.GetLastError())
            if err2 == ERROR_BROKEN_PIPE or err2 == ERROR_NO_DATA:
                return None
            return None
        return buf.raw[:int(nread.value)]
    finally:
        try:
            CloseHandle(ov.hEvent)
        except:
            pass

def _try_connect_pipe(pipe_name: str, token: str) -> bool:
    try:
        if not WaitNamedPipeW(pipe_name, 250):
            return False
        h = CreateFileW(pipe_name, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING, 0, None)
        if int(h) == INVALID_HANDLE_VALUE:
            return False
        try:
            req = {"_id": 0, "action": "hello", "client_id": "probe", "token": token}
            if not _win_pipe_write(int(h), (json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8")):
                return False
            # 读一行
            inbuf = bytearray()
            t0 = _now_mono()
            while (_now_mono() - t0) < 0.35:
                chunk = _win_pipe_read_some_overlapped(int(h), timeout_ms=80)
                if chunk is None:
                    return False
                if chunk:
                    inbuf += chunk
                    idx = inbuf.find(b"\n")
                    if idx >= 0:
                        line = bytes(inbuf[:idx]).decode("utf-8", errors="ignore").strip()
                        if not line:
                            return False
                        obj = json.loads(line)
                        return bool(obj.get("ok")) and obj.get("app_id") == APP_ID
            return False
        finally:
            try:
                CloseHandle(h)
            except:
                pass
    except:
        return False

def _create_listen_endpoint(local_token: str):
    sysname = platform.system()

    if sysname != "Windows":
        sock_path = _get_unix_socket_path()
        if os.path.exists(sock_path):
            try:
                if _try_connect_unix(sock_path, local_token):
                    raise RuntimeError("BROKER_ALREADY_RUNNING")
            except RuntimeError:
                raise
            except:
                try:
                    os.unlink(sock_path)
                except:
                    pass

        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(sock_path)
        try:
            os.chmod(sock_path, 0o600)
        except:
            pass
        s.listen(64)
        s.settimeout(0.5)

        info = {
            "app_id": APP_ID,
            "protocol": BROKER_PROTOCOL,
            "family": "unix",
            "path": sock_path,
            "pid": os.getpid(),
            "token_enabled": bool(ENABLE_LOCAL_TOKEN),
        }
        _write_endpoint_file(info)
        return ("unix", s, info)

    # Windows: Named Pipe
    pipe_name = _get_windows_pipe_name()
    global _PIPE_NAME
    _PIPE_NAME = pipe_name

    # 如果能连上并 hello 成功 => 已有 broker
    if _try_connect_pipe(pipe_name, local_token):
        raise RuntimeError("BROKER_ALREADY_RUNNING")

    info = {
        "app_id": APP_ID,
        "protocol": BROKER_PROTOCOL,
        "family": "pipe",
        "name": pipe_name,
        "pid": os.getpid(),
        "token_enabled": bool(ENABLE_LOCAL_TOKEN),
    }
    _write_endpoint_file(info)
    return ("pipe", pipe_name, info)

# ---------------- Lease state (monotonic) ----------------
_BROKER_START_TS = _now_mono()
_CLIENT_LAST_SEEN = {}
_CLIENT_LOCK = threading.Lock()

_SHUTDOWN_FLAG = False
_LOCAL_TOKEN = ""

def _touch_client(client_id: str):
    if not client_id:
        return
    now = _now_mono()
    with _CLIENT_LOCK:
        _CLIENT_LAST_SEEN[client_id] = now

def _get_clients_snapshot():
    now = _now_mono()
    with _CLIENT_LOCK:
        alive = {k: v for k, v in _CLIENT_LAST_SEEN.items() if (now - v) <= HEARTBEAT_TTL_SEC * 4}
        _CLIENT_LAST_SEEN.clear()
        _CLIENT_LAST_SEEN.update(alive)
        return dict(alive)

def _should_auto_exit() -> bool:
    """
    关键修复：
    - 如果还没见过任何 client，不要立刻 exit；至少等 TTL（启动宽限）
    - 用 monotonic，抗回拨/睡眠
    """
    now = _now_mono()
    with _CLIENT_LOCK:
        if not _CLIENT_LAST_SEEN:
            return (now - _BROKER_START_TS) > HEARTBEAT_TTL_SEC
        newest = max(_CLIENT_LAST_SEEN.values())
        return (now - newest) > HEARTBEAT_TTL_SEC

def _lease_watchdog():
    global _SHUTDOWN_FLAG
    while not _SHUTDOWN_FLAG:
        time.sleep(LEASE_SWEEP_INTERVAL_SEC)
        try:
            if _should_auto_exit():
                _log(f"Lease TTL expired ({HEARTBEAT_TTL_SEC}s), auto shutdown.")
                _SHUTDOWN_FLAG = True
                break
        except:
            pass

def _safe_shutdown_cleanup():
    try:
        _stop_clipboard_watcher()
    except:
        pass
    try:
        _stop_audio()
    except:
        pass

def _broker_dispatch(cmd: dict, cancel_version: int = None) -> dict:
    global _SHUTDOWN_FLAG
    req_id = cmd.get("_id", cmd.get("id", 0))
    out = {"_id": req_id, "ok": True}

    if ENABLE_LOCAL_TOKEN:
        if cmd.get("token") != _LOCAL_TOKEN:
            return {"_id": req_id, "ok": False, "error": "unauthorized", "app_id": APP_ID}

    client_id = cmd.get("client_id") or cmd.get("clientId") or cmd.get("cid") or ""
    if client_id:
        _touch_client(str(client_id))

    action = cmd.get("action") or cmd.get("cmd") or ""

    if action == "hello":
        out.update({
            "app_id": APP_ID,
            "protocol": BROKER_PROTOCOL,
            "pid": os.getpid(),
            "uptime_sec": int(_now_mono() - _BROKER_START_TS),
            "ttl_sec": HEARTBEAT_TTL_SEC,
            "token_enabled": bool(ENABLE_LOCAL_TOKEN),
        })
        return out

    if action == "stats":
        snap = _get_clients_snapshot()
        out.update({
            "app_id": APP_ID,
            "pid": os.getpid(),
            "uptime_sec": int(_now_mono() - _BROKER_START_TS),
            "clients_seen": len(snap),
            "clipboard_watcher": _get_clipboard_watcher_state(),
            "audio": _get_audio_state(),
        })
        return out

    if action in ("shutdown",):
        _SHUTDOWN_FLAG = True
        out["status"] = "exiting"
        return out

    res = _dispatch_action(cmd, cancel_version, allow_process_exit=False)
    if action == "exit":
        _SHUTDOWN_FLAG = True
    res["ok"] = True if "error" not in res else False
    return res

# ---------------- POSIX socket server ----------------
def _unix_client_loop(conn: socket.socket):
    try:
        conn.settimeout(0.5)
    except:
        pass
    inbuf = bytearray()
    SLOW_ACTIONS = {"path_size", "folder_info", "get_folder_info"}
    conn_tag = f"conn:{id(conn)}"

    try:
        while not _SHUTDOWN_FLAG:
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except:
                break
            if not chunk:
                break
            inbuf += chunk
            while True:
                idx = inbuf.find(b"\n")
                if idx < 0:
                    break
                line = bytes(inbuf[:idx]).decode("utf-8", errors="ignore").strip()
                del inbuf[:idx + 1]
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                except Exception as e:
                    try:
                        conn.sendall((json.dumps({"_id": 0, "ok": False, "error": f"bad_json: {e}"}, ensure_ascii=False) + "\n").encode("utf-8"))
                    except:
                        pass
                    continue

                # 连接级兜底：客户端没带 client_id 时，用连接标识，避免 TTL 误判
                if not (cmd.get("client_id") or cmd.get("clientId") or cmd.get("cid")):
                    cmd["client_id"] = conn_tag

                action = cmd.get("action") or cmd.get("cmd") or ""
                if action in SLOW_ACTIONS:
                    cancel_ver = _get_scan_cancel_version()
                    fut = _IO_EXECUTOR.submit(_broker_dispatch, cmd, cancel_ver)
                    try:
                        res = fut.result()
                    except Exception as e:
                        res = {"_id": cmd.get("_id", 0), "ok": False, "error": str(e)}
                else:
                    try:
                        res = _broker_dispatch(cmd, None)
                    except Exception as e:
                        res = {"_id": cmd.get("_id", 0), "ok": False, "error": str(e)}

                try:
                    conn.sendall((json.dumps(res, ensure_ascii=False) + "\n").encode("utf-8"))
                except:
                    break
    finally:
        try:
            conn.close()
        except:
            pass

def _unix_accept_loop(listen_sock: socket.socket):
    while not _SHUTDOWN_FLAG:
        try:
            conn, _ = listen_sock.accept()
        except socket.timeout:
            continue
        except:
            break
        try:
            threading.Thread(target=_unix_client_loop, args=(conn,), daemon=True).start()
        except:
            try:
                conn.close()
            except:
                pass

# ---------------- Windows named pipe server ----------------
_ACTIVE_PIPE_HANDLES = set()
_ACTIVE_PIPE_LOCK = threading.Lock()

def _pipe_close_handle(h: int):
    try:
        CloseHandle(wintypes.HANDLE(h))
    except:
        pass

def _pipe_client_loop(hPipe: int):
    inbuf = bytearray()
    SLOW_ACTIONS = {"path_size", "folder_info", "get_folder_info"}
    conn_tag = f"pipe:{hPipe}"
    try:
        while not _SHUTDOWN_FLAG:
            chunk = _win_pipe_read_some_overlapped(hPipe, timeout_ms=300)
            if chunk is None:
                break
            if not chunk:
                continue
            inbuf += chunk
            while True:
                idx = inbuf.find(b"\n")
                if idx < 0:
                    break
                line = bytes(inbuf[:idx]).decode("utf-8", errors="ignore").strip()
                del inbuf[:idx + 1]
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                except Exception as e:
                    _win_pipe_write(hPipe, (json.dumps({"_id": 0, "ok": False, "error": f"bad_json: {e}"}, ensure_ascii=False) + "\n").encode("utf-8"))
                    continue

                # 连接级兜底：客户端没带 client_id 时，用连接标识，避免 TTL 误判
                if not (cmd.get("client_id") or cmd.get("clientId") or cmd.get("cid")):
                    cmd["client_id"] = conn_tag

                action = cmd.get("action") or cmd.get("cmd") or ""
                if action in SLOW_ACTIONS:
                    cancel_ver = _get_scan_cancel_version()
                    fut = _IO_EXECUTOR.submit(_broker_dispatch, cmd, cancel_ver)
                    try:
                        res = fut.result()
                    except Exception as e:
                        res = {"_id": cmd.get("_id", 0), "ok": False, "error": str(e)}
                else:
                    try:
                        res = _broker_dispatch(cmd, None)
                    except Exception as e:
                        res = {"_id": cmd.get("_id", 0), "ok": False, "error": str(e)}

                if not _win_pipe_write(hPipe, (json.dumps(res, ensure_ascii=False) + "\n").encode("utf-8")):
                    return
    finally:
        try:
            DisconnectNamedPipe(wintypes.HANDLE(hPipe))
        except:
            pass
        _pipe_close_handle(hPipe)
        with _ACTIVE_PIPE_LOCK:
            _ACTIVE_PIPE_HANDLES.discard(hPipe)

def _create_named_pipe_instance(pipe_name: str, first_instance: bool) -> int:
    openmode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED
    if first_instance:
        openmode |= FILE_FLAG_FIRST_PIPE_INSTANCE

    pipemode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT
    h = CreateNamedPipeW(
        pipe_name,
        openmode,
        pipemode,
        PIPE_UNLIMITED_INSTANCES,
        65536,
        65536,
        0,
        None
    )
    return int(h)

def _pipe_wait_connect(hPipe: int, timeout_ms: int) -> int:
    """
    返回:
      1 连接成功
      0 超时
     -1 失败/断开
    """
    ov = OVERLAPPED()
    ov.hEvent = CreateEventW(None, True, False, None)
    if not ov.hEvent:
        return -1
    try:
        ok = ConnectNamedPipe(wintypes.HANDLE(hPipe), ctypes.byref(ov))
        if ok:
            return 1
        err = int(kernel32.GetLastError())
        if err == ERROR_PIPE_CONNECTED:
            return 1
        if err != ERROR_IO_PENDING:
            return -1

        rc = int(WaitForSingleObject(ov.hEvent, timeout_ms))
        if rc == WAIT_TIMEOUT:
            return 0
        if rc != WAIT_OBJECT_0:
            return -1

        dummy = wintypes.DWORD(0)
        ok2 = GetOverlappedResult(wintypes.HANDLE(hPipe), ctypes.byref(ov), ctypes.byref(dummy), False)
        return 1 if ok2 else -1
    finally:
        try:
            CloseHandle(ov.hEvent)
        except:
            pass

def _pipe_accept_loop(pipe_name: str):
    first = True
    hPipe = None

    while not _SHUTDOWN_FLAG:
        if hPipe is None:
            hPipe = _create_named_pipe_instance(pipe_name, first_instance=first)
            first = False
            if hPipe == INVALID_HANDLE_VALUE or hPipe <= 0:
                _log("CreateNamedPipe failed.")
                time.sleep(0.5)
                continue

        st = _pipe_wait_connect(hPipe, timeout_ms=300)
        if st == 0:
            continue
        if st < 0:
            try:
                DisconnectNamedPipe(wintypes.HANDLE(hPipe))
            except:
                pass
            _pipe_close_handle(hPipe)
            hPipe = None
            continue

        with _ACTIVE_PIPE_LOCK:
            _ACTIVE_PIPE_HANDLES.add(hPipe)

        try:
            threading.Thread(target=_pipe_client_loop, args=(hPipe,), daemon=True).start()
        except:
            try:
                DisconnectNamedPipe(wintypes.HANDLE(hPipe))
            except:
                pass
            _pipe_close_handle(hPipe)
            with _ACTIVE_PIPE_LOCK:
                _ACTIVE_PIPE_HANDLES.discard(hPipe)

        hPipe = None

    if hPipe is not None:
        try:
            if CancelIoEx:
                CancelIoEx(wintypes.HANDLE(hPipe), None)
        except:
            pass
        try:
            DisconnectNamedPipe(wintypes.HANDLE(hPipe))
        except:
            pass
        _pipe_close_handle(hPipe)

def _close_all_pipe_clients():
    with _ACTIVE_PIPE_LOCK:
        hs = list(_ACTIVE_PIPE_HANDLES)
    for h in hs:
        try:
            _pipe_close_handle(h)
        except:
            pass

# ---------------- Broker main ----------------
def broker_mode():
    global _SHUTDOWN_FLAG, _LOCAL_TOKEN, _BROKER_START_TS

    _set_event_sink(None)

    _BROKER_START_TS = _now_mono()
    _SHUTDOWN_FLAG = False

    _LOCAL_TOKEN = _load_or_create_local_token() if ENABLE_LOCAL_TOKEN else ""
    _log(f"Token enabled={ENABLE_LOCAL_TOKEN}")

    try:
        kind, endpoint_obj, endpoint_info = _create_listen_endpoint(_LOCAL_TOKEN)
    except RuntimeError as e:
        if str(e) == "BROKER_ALREADY_RUNNING":
            _log("Broker already running. Exit current process.")
            return 0
        _log(f"Broker init failed: {e}")
        return 2
    except Exception as e:
        _log(f"Broker init error: {e}")
        return 2

    _log(f"Broker started. PID={os.getpid()} endpoint={endpoint_info}")

    threading.Thread(target=_lease_watchdog, daemon=True, name="lease-watchdog").start()

    accept_thread = None
    listen_sock = None

    try:
        if kind == "unix":
            listen_sock = endpoint_obj
            accept_thread = threading.Thread(target=_unix_accept_loop, args=(listen_sock,), daemon=True, name="unix-accept")
            accept_thread.start()
        else:
            pipe_name = endpoint_obj
            accept_thread = threading.Thread(target=_pipe_accept_loop, args=(pipe_name,), daemon=True, name="pipe-accept")
            accept_thread.start()

        while not _SHUTDOWN_FLAG:
            time.sleep(0.2)

    except KeyboardInterrupt:
        _log("KeyboardInterrupt, exiting...")
        _SHUTDOWN_FLAG = True
    except Exception as e:
        _log(f"Broker loop error: {e}")
        _SHUTDOWN_FLAG = True
    finally:
        _safe_shutdown_cleanup()

        if kind == "unix":
            try:
                if listen_sock:
                    listen_sock.close()
            except:
                pass
            try:
                p = endpoint_info.get("path")
                if p and os.path.exists(p):
                    os.unlink(p)
            except:
                pass
        else:
            try:
                _close_all_pipe_clients()
            except:
                pass

        _log("Broker stopped.")
    return 0

# =============================================================================
#  main
# =============================================================================
def main():
    if len(sys.argv) <= 1:
        return broker_mode()

    arg1 = sys.argv[1].strip().lower()

    if arg1 in ("--broker", "broker"):
        return broker_mode()

    if arg1 in ("--daemon", "daemon", "-d"):
        daemon_mode()
        return 0

    if arg1 == "paste" and len(sys.argv) >= 3:
        print(json.dumps(handle_clipboard(sys.argv[2]), ensure_ascii=True))
        return 0

    print(json.dumps(handle_clipboard(), ensure_ascii=True))
    return 0

if __name__ == "__main__":
    sys.exit(main())

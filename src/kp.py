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
import re
import base64
import importlib.util
import threading

# ---- Broker/IPC extras ----
import socket
import tempfile
import queue
import zlib

# ---- pywin32 for Named Pipe (avoids ctypes daemon-thread deadlock) ----
_HAS_PYWIN32 = False
if platform.system() == "Windows":
    try:
        import win32file
        import win32pipe
        import win32event
        import pywintypes
        import win32api
        _HAS_PYWIN32 = True
    except ImportError:
        pass

# ---- pynput for global keyboard hook ----
_HAS_PYNPUT = False
try:
    from pynput import keyboard as pynput_keyboard
    _HAS_PYNPUT = True
except ImportError:
    pynput_keyboard = None

# =============================================================================
#  Event sink (stdout events)  ★ Broker 模式下必须禁用，避免污染协议/日志
# =============================================================================
_EVENT_SINK_LOCK = threading.Lock()
_EVENT_SINK = None  # callable(obj:dict) -> None

# =============================================================================
#  ★ Broker Broadcast: 跨窗口实时事件推送 (零轮询)
# =============================================================================
_BROADCAST_CLIENTS = {}  # {client_tag: write_func}
_BROADCAST_LOCK = threading.Lock()

def _register_broadcast_client(tag: str, write_func):
    """注册一个客户端用于接收广播事件"""
    with _BROADCAST_LOCK:
        _BROADCAST_CLIENTS[tag] = write_func

def _unregister_broadcast_client(tag: str):
    """注销客户端"""
    with _BROADCAST_LOCK:
        _BROADCAST_CLIENTS.pop(tag, None)

def _broadcast_event(obj: dict):
    """向所有已连接客户端广播事件 (非阻塞)"""
    with _BROADCAST_LOCK:
        clients = list(_BROADCAST_CLIENTS.items())

    if not clients:
        return

    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
    dead_clients = []

    for tag, write_func in clients:
        try:
            write_func(data)
        except:
            dead_clients.append(tag)

    # 清理已断开的客户端
    if dead_clients:
        with _BROADCAST_LOCK:
            for tag in dead_clients:
                _BROADCAST_CLIENTS.pop(tag, None)

def _set_event_sink(fn):
    global _EVENT_SINK
    with _EVENT_SINK_LOCK:
        _EVENT_SINK = fn

def _emit_event(obj: dict):
    # ★ Broker 模式: 广播到所有客户端
    _broadcast_event(obj)

    # ★ Daemon 模式: 通过 stdout sink 发送
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

# ★ 播放状态追踪 (用于跨窗口同步)
_AUDIO_CURRENT_FILE = None
_AUDIO_LOOP_COUNT = 0
_AUDIO_START_TIME = 0

def _on_audio_device_lost():
    """★ 当音乐引擎检测到设备丢失时触发，联动重置 SFX 引擎"""
    _log("[Audio] Device lost detected by music engine, resetting SFX hub...")
    _reset_audio_hub()
    # ★ 埋点：记录当前音频状态，供下次排查
    try:
        import datetime
        _log(f"[Audio] Diagnostic: time={datetime.datetime.now().isoformat()}, "
             f"file={_AUDIO_CURRENT_FILE}, looping={_AUDIO_IS_LOOPING}, "
             f"engine_alive={_AUDIO_ENGINE is not None}")
    except Exception:
        pass


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

            _AUDIO_ENGINE = ma_module.NonBlockingAudioEngine(
                asset_folder=".", max_workers=8, silent=True,
                on_device_lost=_on_audio_device_lost,  # ★ 设备丢失时联动重置 SFX
                on_log=_log  # ★ 关键日志写入 broker.log
            )
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


def _reset_audio_engine():
    """★ 强制重置音频引擎（用于设备丢失后恢复）"""
    global _AUDIO_ENGINE, _AUDIO_ENGINE_ERROR
    if _AUDIO_LOCK is None:
        return
    with _AUDIO_LOCK:
        if _AUDIO_ENGINE is not None:
            try:
                _AUDIO_ENGINE.stop_all()
            except:
                pass
            try:
                _AUDIO_ENGINE.cleanup()
            except:
                pass
        _AUDIO_ENGINE = None
        _AUDIO_ENGINE_ERROR = None
    _log("[Audio] Engine reset complete, will re-initialize on next play")

# ---- Radio (网络电台) ----
# 状态由 JS 侧 stats 轮询搭便车下发，零额外 HTTP 请求
_RADIO_LIVE = False
_RADIO_M3U8 = ""
_RADIO_STREAM = ""  # 直推流 URL（优先使用）

def _set_radio_status(live: bool, m3u8: str, stream: str = ""):
    """由 JS 侧 set_radio_status action 调用，缓存电台状态"""
    global _RADIO_LIVE, _RADIO_M3U8, _RADIO_STREAM
    _RADIO_LIVE = bool(live)
    _RADIO_M3U8 = str(m3u8) if m3u8 else ""
    _RADIO_STREAM = str(stream) if stream else ""
    _log(f"[Radio] status updated: live={_RADIO_LIVE}, stream={_RADIO_STREAM or 'N/A'}, m3u8={_RADIO_M3U8}")

def _play_radio(m3u8_url, timeout_sec=0, stream_url=""):
    """接入电台流播放。优先用直推流（stream_url），fallback 到 HLS（m3u8_url）"""
    global _AUDIO_CURRENT_TOKEN, _AUDIO_IS_LOOPING
    global _AUDIO_CURRENT_FILE, _AUDIO_LOOP_COUNT, _AUDIO_START_TIME

    use_stream = bool(stream_url)
    url_display = stream_url if use_stream else m3u8_url
    _log(f"[Audio] Radio is live, switching to {'stream' if use_stream else 'HLS'}: {url_display}" + (f" (auto-stop in {timeout_sec}s)" if timeout_sec > 0 else ""))

    engine, err = _init_audio_engine()
    if err:
        _log(f"[Audio] Radio: engine init failed: {err}")
        return {"status": "error", "error": err}

    try:
        if _AUDIO_CURRENT_TOKEN:
            try:
                _AUDIO_CURRENT_TOKEN.stop()
            except Exception:
                pass
            _AUDIO_CURRENT_TOKEN = None

        _AUDIO_CURRENT_TOKEN = engine.play_radio_stream(stream_url) if use_stream else engine.play_radio_hls(m3u8_url)
        _AUDIO_IS_LOOPING = True
        _AUDIO_CURRENT_FILE = "Radio"
        _AUDIO_LOOP_COUNT = 0
        _AUDIO_START_TIME = time.time()

        # ★ 普通播放模式：随机时间后自动停止
        if timeout_sec > 0:
            _token_ref = _AUDIO_CURRENT_TOKEN
            def _radio_auto_stop():
                global _AUDIO_CURRENT_TOKEN, _AUDIO_IS_LOOPING, _AUDIO_CURRENT_FILE, _AUDIO_LOOP_COUNT
                if _token_ref and not _token_ref.stopped:
                    _log(f"[Audio] Radio auto-stop after {timeout_sec}s")
                    _token_ref.stop()
                # ★ 重置状态 + 广播停止事件，让 JS 端还原 UI
                _AUDIO_IS_LOOPING = False
                _AUDIO_CURRENT_TOKEN = None
                _AUDIO_CURRENT_FILE = None
                _AUDIO_LOOP_COUNT = 0
                _emit_event({
                    "event": "audio_state_changed",
                    "playing": False, "looping": False,
                    "fileName": None, "loopCount": 0, "startTime": 0
                })
            t = threading.Timer(timeout_sec, _radio_auto_stop)
            t.daemon = True
            t.start()

        _emit_event({
            "event": "audio_state_changed",
            "playing": True,
            "looping": True,
            "fileName": "Radio",
            "loopCount": 0,
            "startTime": _AUDIO_START_TIME,
            "source": "radio"
        })
        return {"status": "ok", "source": "radio"}
    except Exception as e:
        _log(f"[Audio] Radio play failed: {e}")
        return {"status": "error", "error": str(e)}

def _play_audio(file_path, count=1):
    """Play audio, return status. ★ 包含引擎重置重试机制"""
    global _AUDIO_CURRENT_TOKEN, _AUDIO_MONITOR_THREAD, _AUDIO_IS_LOOPING
    global _AUDIO_CURRENT_FILE, _AUDIO_LOOP_COUNT, _AUDIO_START_TIME

    if not os.path.exists(file_path):
        return {"status": "error", "error": f"file not found: {file_path}"}

    # ★ 埋点：记录每次播放请求，方便屏保后对比时间线
    _log(f"[Audio] play_audio: file={os.path.basename(file_path)}, count={count}")

    # ★ 电台接入点：读内存缓存状态（0ms）
    # 循环播放(count=0/-1) → 电台无限播放直到服务器停播
    # 普通播放(count>0) → 电台随机 5~15 分钟后自动停止
    if _RADIO_LIVE and (_RADIO_STREAM or _RADIO_M3U8):
        if count in (0, -1):
            return _play_radio(_RADIO_M3U8, stream_url=_RADIO_STREAM)
        else:
            import random
            timeout = random.randint(300, 900)  # 5~15 分钟
            return _play_radio(_RADIO_M3U8, timeout_sec=timeout, stream_url=_RADIO_STREAM)

    # ★ 尝试最多2次（第一次正常，第二次重置引擎后重试）
    for attempt in range(2):
        engine, err = _init_audio_engine()
        if err:
            if attempt == 0:
                _log(f"[Audio] Engine init failed (attempt 1), resetting and retrying: {err}")
                _reset_audio_engine()
                _reset_audio_hub()  # ★ 联动重置 SFX 引擎
                continue
            return {"status": "error", "error": err}

        try:
            if _AUDIO_CURRENT_TOKEN:
                try:
                    _AUDIO_CURRENT_TOKEN.stop()
                except:
                    pass
                _AUDIO_CURRENT_TOKEN = None

            # ★ 检测是否需要前奏（仅 2.mp3 → 前奏 a2.mp3）
            _intro_path = None
            _basename = os.path.basename(file_path)
            if _basename == "2.mp3":
                _candidate = os.path.join(os.path.dirname(file_path), "a2.mp3")
                if os.path.isfile(_candidate):
                    _intro_path = _candidate

            if count == 0 or count == -1:
                if _intro_path:
                    _AUDIO_CURRENT_TOKEN = engine.play_with_intro(
                        intro_path=_intro_path,
                        main_path=file_path,
                        loop=True,
                        trim_silence=True
                    )
                else:
                    _AUDIO_CURRENT_TOKEN = engine.play_sound_file(
                        file_path=file_path,
                        loop=True,
                        trim_silence=True
                    )
                _AUDIO_IS_LOOPING = True
            elif count == 1:
                if _intro_path:
                    _AUDIO_CURRENT_TOKEN = engine.az_with_intro(_intro_path, file_path, 1, 2.0, True)
                else:
                    _AUDIO_CURRENT_TOKEN = engine.az(file_path, 1, 2.0, True)
                _AUDIO_IS_LOOPING = False
            else:
                if _intro_path:
                    _AUDIO_CURRENT_TOKEN = engine.az_with_intro(_intro_path, file_path, count, 2.0, True)
                else:
                    _AUDIO_CURRENT_TOKEN = engine.az(file_path, count, 2.0, True)
                _AUDIO_IS_LOOPING = False

            # ★ 更新播放状态并广播
            _AUDIO_CURRENT_FILE = os.path.basename(file_path)
            _AUDIO_LOOP_COUNT = count
            _AUDIO_START_TIME = time.time()
            _emit_event({
                "event": "audio_state_changed",
                "playing": True,
                "looping": _AUDIO_IS_LOOPING,
                "fileName": _AUDIO_CURRENT_FILE,
                "loopCount": _AUDIO_LOOP_COUNT,
                "startTime": _AUDIO_START_TIME
            })

            def _monitor_playback():
                global _AUDIO_CURRENT_TOKEN, _AUDIO_CURRENT_FILE, _AUDIO_LOOP_COUNT
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
                    _AUDIO_CURRENT_FILE = None
                    _AUDIO_LOOP_COUNT = 0
                    # ★ 广播播放结束事件
                    _emit_event({
                        "event": "audio_state_changed",
                        "playing": False,
                        "looping": False,
                        "fileName": None,
                        "loopCount": 0,
                        "startTime": 0
                    })
                    _emit_event({"event": "audio_finished"})  # 保持兼容

            if not _AUDIO_IS_LOOPING:
                _AUDIO_MONITOR_THREAD = threading.Thread(target=_monitor_playback, daemon=True)
                _AUDIO_MONITOR_THREAD.start()

            return {"status": "ok"}
        except Exception as e:
            import traceback
            if attempt == 0:
                _log(f"[Audio] Play failed (attempt 1), resetting engine and retrying: {e}")
                _reset_audio_engine()
                _reset_audio_hub()  # ★ 联动重置 SFX 引擎
                continue
            return {"status": "error", "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()}

    return {"status": "error", "error": "play failed after retries"}

def _stop_audio():
    """Stop audio playback"""
    global _AUDIO_CURRENT_TOKEN, _AUDIO_IS_LOOPING, _AUDIO_CURRENT_FILE, _AUDIO_LOOP_COUNT

    if _AUDIO_CURRENT_TOKEN:
        try:
            _AUDIO_CURRENT_TOKEN.stop()
        except:
            pass
        _AUDIO_CURRENT_TOKEN = None

    _AUDIO_IS_LOOPING = False
    _AUDIO_CURRENT_FILE = None
    _AUDIO_LOOP_COUNT = 0

    engine, _ = _init_audio_engine()
    if engine:
        try:
            engine.stop_all()
        except:
            pass

    # ★ 广播停止事件
    _emit_event({
        "event": "audio_state_changed",
        "playing": False,
        "looping": False,
        "fileName": None,
        "loopCount": 0,
        "startTime": 0
    })

    return {"status": "stopped"}

def _get_audio_state():
    """Get current playback state (用于跨窗口同步)"""
    global _AUDIO_CURRENT_TOKEN, _AUDIO_IS_LOOPING, _AUDIO_CURRENT_FILE, _AUDIO_LOOP_COUNT, _AUDIO_START_TIME

    playing = _AUDIO_CURRENT_TOKEN is not None and not _AUDIO_CURRENT_TOKEN.stopped

    return {
        "playing": playing,
        "looping": _AUDIO_IS_LOOPING if playing else False,
        "fileName": _AUDIO_CURRENT_FILE if playing else None,
        "loopCount": _AUDIO_LOOP_COUNT if playing else 0,
        "startTime": _AUDIO_START_TIME if playing else 0
    }

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
    """★ 播放 SFX 音效，带引擎重置重试机制"""
    global _SFX_LAST_IDX

    _init_sfx_paths()
    paths = _SFX_REGISTRY.get(category, [])
    if not paths:
        return

    valid_paths = [p for p in paths if os.path.isfile(p)]
    if not valid_paths:
        return

    # 确定要播放的文件
    if name:
        path = None
        for p in valid_paths:
            if os.path.basename(p) == name:
                path = p
                break
        if not path:
            return
    elif idx < 0:
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

    # ★ 尝试最多2次（第一次正常，第二次重置 hub 后重试）
    for attempt in range(2):
        hub = _get_audio_hub()
        if not hub:
            if attempt == 0:
                _log("[SFX] AudioHub unavailable, resetting and retrying...")
                _reset_audio_hub()
                continue
            return

        try:
            hub.play_sfx(path)
            return
        except Exception as e:
            if attempt == 0:
                _log(f"[SFX] play_sfx failed, resetting hub and retrying: {e}")
                _reset_audio_hub()
                continue
            _log(f"[SFX] play_sfx failed after retry: {e}")

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


def _reset_audio_hub():
    """★ 重置 AudioHub（SFX 音效引擎），用于设备丢失后恢复"""
    global _AUDIO_HUB, _SFX_PRIMED, _CLIPBOARD_WATCHER_STARTED
    with _AUDIO_HUB_LOCK:
        if _AUDIO_HUB is not None:
            try:
                _AUDIO_HUB.close()
            except:
                pass
        _AUDIO_HUB = None
        _SFX_PRIMED = False
    with _CLIPBOARD_STATE_LOCK:
        _CLIPBOARD_WATCHER_STARTED = False
    _log("[Audio] AudioHub (SFX engine) reset complete")


def _reset_all_audio():
    """★ 重置所有音频引擎（音乐 + SFX），并恢复剪贴板监听"""
    global _CLIPBOARD_WATCHER_STARTED

    # 1) 记住剪贴板监听状态
    with _CLIPBOARD_STATE_LOCK:
        was_clipboard_watching = _CLIPBOARD_WATCHER_STARTED

    # 2) 重置音乐引擎
    _reset_audio_engine()

    # 3) 重置 SFX 引擎
    _reset_audio_hub()

    # 4) 如果之前剪贴板监听在运行，重新启动
    if was_clipboard_watching:
        _log("[Audio] Re-starting clipboard watcher after audio reset...")
        try:
            result = _start_clipboard_watcher()
            _log(f"[Audio] Clipboard watcher restart: {result.get('status', 'unknown')}")
        except Exception as e:
            _log(f"[Audio] Clipboard watcher restart failed: {e}")

    return {"status": "ok"}

# =============================================================================
#  ★ Global Keyboard Hook (pynput) - Space+Q to restore q2 visible window
# =============================================================================
_HOTKEY_LISTENER = None
_HOTKEY_PRESSED_KEYS = set()
_HOTKEY_LOCK = threading.Lock()
_HOTKEY_ENABLED = True
_HOTKEY_LAST_TRIGGER = 0
_HOTKEY_DEBOUNCE_MS = 400

def _activate_window(hwnd):
    """Activate window: restore if minimized, then bring to foreground."""
    user32 = ctypes.windll.user32
    if not user32.IsWindow(hwnd):
        return
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.keybd_event(0x12, 0, 0, 0)  # Alt down (bypass foreground lock)
    user32.SetForegroundWindow(hwnd)
    user32.keybd_event(0x12, 0, 2, 0)  # Alt up
    user32.BringWindowToTop(hwnd)

def _test_activate_vscode():
    """
    Find and activate IDE window with visible q2. Returns True if activated.
    Reads hwnd directly from temp file written by JS side.
    """
    if platform.system() != 'Windows':
        return False

    import tempfile
    import json

    tracking_file = os.path.join(tempfile.gettempdir(), 'vix_q2_windows.json')
    user32 = ctypes.windll.user32
    current = user32.GetForegroundWindow()

    # Read tracking file (contains {hwnd: timestamp})
    records = {}
    try:
        if os.path.exists(tracking_file):
            with open(tracking_file, 'r', encoding='utf-8') as f:
                records = json.load(f)
    except Exception as e:
        _log(f"[Hotkey] Failed to read tracking file: {e}")
        return False

    if not records:
        _log("[Hotkey] No q2 windows in tracking file")
        return False

    # Filter for new format and sort by timestamp. Legacy/corrupt entries are ignored.
    valid_items = [item for item in records.items() if isinstance(item[1], dict) and 'ts' in item[1]]
    sorted_hwnds = sorted(valid_items, key=lambda item: item[1]['ts'], reverse=True)
    _log(f"[Hotkey] Tracking file: {sorted_hwnds}, current={current}")

    # Try each hwnd (most recent first), find alive one
    dead_hwnds = []
    for hwnd_str, data in sorted_hwnds:
        try:
            hwnd = int(hwnd_str)
        except:
            continue

        # Check if window still exists
        if not user32.IsWindow(hwnd):
            dead_hwnds.append(hwnd_str)
            continue

        # ★ Verify hwnd belongs to the process name expected by the client
        try:
            import psutil
            expected_proc = data.get('proc')
            if not expected_proc:
                _log(f"[Hotkey] hwnd={hwnd} has no expected process name in tracking file, skipping")
                dead_hwnds.append(hwnd_str)
                continue

            pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value:
                proc = psutil.Process(pid.value)
                actual_proc_name = proc.name().lower()
                if actual_proc_name != expected_proc.lower():
                    dead_hwnds.append(hwnd_str)  # Clean it up (process mismatch = window reused)
                    continue
        except Exception as e:
            _log(f"[Hotkey] hwnd={hwnd} process check failed: {e}, skipping")
            dead_hwnds.append(hwnd_str) # Clean it up
            continue

        if hwnd == current:
            return False  # Already focused

        # Activate the window
        _activate_window(hwnd)
        _log(f"[Hotkey] Activated window hwnd={hwnd}")
        return True

    # Clean up dead windows from tracking file
    if dead_hwnds:
        try:
            for hwnd_str in dead_hwnds:
                records.pop(hwnd_str, None)
            with open(tracking_file, 'w', encoding='utf-8') as f:
                json.dump(records, f)
            _log(f"[Hotkey] Cleaned up dead hwnds: {dead_hwnds}")
        except:
            pass

    _log("[Hotkey] No alive q2 window to activate")
    return False

def _get_foreground_hwnd(cmd: dict):
    """
    Get current foreground window hwnd, but ONLY if it belongs to the expected process.
    This prevents race condition: user switches away before Python responds.
    """
    if platform.system() != 'Windows':
        return {"status": "error", "error": "not windows"}

    expected_proc = cmd.get("expected_proc")
    if not expected_proc:
        return {"status": "error", "error": "expected_proc not provided"}

    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()

    # Validate: only return hwnd if it belongs to the expected process
    try:
        import psutil
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value:
            proc = psutil.Process(pid.value)
            actual_proc_name = proc.name().lower()
            if actual_proc_name != expected_proc.lower():
                # ★ 静默返回错误（process mismatch 是正常行为：用户切走了窗口）
                return {"status": "error", "error": f"process mismatch: expected {expected_proc}, got {actual_proc_name}"}
    except Exception as e:
        return {"status": "error", "error": f"process check failed: {e}"}

    return {"status": "ok", "hwnd": hwnd}

def _hotkey_on_press(key):
    """pynput key press callback"""
    global _HOTKEY_PRESSED_KEYS, _HOTKEY_LAST_TRIGGER
    if not _HOTKEY_ENABLED or not _HAS_PYNPUT:
        return

    with _HOTKEY_LOCK:
        _HOTKEY_PRESSED_KEYS.add(key)

        # Check Space + Q
        space = pynput_keyboard.Key.space in _HOTKEY_PRESSED_KEYS
        q = any(hasattr(k, 'char') and k.char and k.char.lower() == 'q' for k in _HOTKEY_PRESSED_KEYS)

        if space and q:
            now = time.time() * 1000
            if now - _HOTKEY_LAST_TRIGGER < _HOTKEY_DEBOUNCE_MS:
                return
            _HOTKEY_LAST_TRIGGER = now
            # ★ Only play sound if window was actually activated
            if _test_activate_vscode():
                _play_sfx("yz", name="kj3.mp3")

def _hotkey_on_release(key):
    """pynput key release callback"""
    if not _HAS_PYNPUT:
        return
    with _HOTKEY_LOCK:
        _HOTKEY_PRESSED_KEYS.discard(key)

def _start_hotkey_listener():
    """Start global keyboard hook"""
    global _HOTKEY_LISTENER
    if not _HAS_PYNPUT:
        _log("[Hotkey] pynput not available")
        return {"status": "error", "error": "pynput not installed"}
    if _HOTKEY_LISTENER is not None:
        return {"status": "already_running"}
    try:
        _HOTKEY_LISTENER = pynput_keyboard.Listener(on_press=_hotkey_on_press, on_release=_hotkey_on_release)
        _HOTKEY_LISTENER.daemon = True  # ★ Critical: daemon线程不会阻止进程退出
        _HOTKEY_LISTENER.start()
        _log("[Hotkey] Started (Space+Q to restore q2 window)")
        return {"status": "started"}
    except Exception as e:
        _log(f"[Hotkey] Failed: {e}")
        return {"status": "error", "error": str(e)}

def _stop_hotkey_listener():
    """Stop global keyboard hook"""
    global _HOTKEY_LISTENER
    if _HOTKEY_LISTENER:
        try:
            _HOTKEY_LISTENER.stop()
        except:
            pass
        _HOTKEY_LISTENER = None
    with _HOTKEY_LOCK:
        _HOTKEY_PRESSED_KEYS.clear()
    _log("[Hotkey] Stopped")
    return {"status": "stopped"}

def _get_hotkey_state():
    """Get hotkey state"""
    return {
        "running": _HOTKEY_LISTENER is not None and _HOTKEY_LISTENER.is_alive() if _HOTKEY_LISTENER else False,
        "enabled": _HOTKEY_ENABLED,
        "pynput_available": _HAS_PYNPUT
    }

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

# Global cache for disk_free_batch (shared across all windows)
_disk_free_cache = None
_disk_free_cache_time = 0
_DISK_FREE_CACHE_TTL = 30  # 30 seconds cache

def _get_folder_size_fast(folder_path: str, max_depth: int = 50) -> int:
    """Fast folder size calculation with depth limit for safety."""
    total = 0
    try:
        for entry in os.scandir(folder_path):
            try:
                if entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
                elif entry.is_dir(follow_symlinks=False) and max_depth > 0:
                    total += _get_folder_size_fast(entry.path, max_depth - 1)
            except (PermissionError, OSError):
                pass
    except (PermissionError, OSError):
        pass
    return total

def _get_desktop_path() -> str:
    """Get current user's Desktop path."""
    if _IS_WINDOWS:
        # Try USERPROFILE first, fallback to expanduser
        userprofile = os.environ.get('USERPROFILE', '')
        if userprofile:
            desktop = os.path.join(userprofile, 'Desktop')
            if os.path.isdir(desktop):
                return desktop
        # Fallback
        desktop = os.path.expanduser('~/Desktop')
        if os.path.isdir(desktop):
            return desktop
    else:
        desktop = os.path.expanduser('~/Desktop')
        if os.path.isdir(desktop):
            return desktop
    return None

def _get_recycle_bin_size(drives: list = None) -> int:
    """Get total Recycle Bin/Trash size (cross-platform)."""
    total = 0
    if _IS_WINDOWS:
        # Windows: $Recycle.Bin on each drive
        if drives:
            for drive in drives:
                letter = drive.upper().replace(":", "").replace("\\", "").replace("/", "")
                if not letter:
                    continue
                recycle_path = f"{letter}:\\$Recycle.Bin"
                if os.path.isdir(recycle_path):
                    total += _get_folder_size_fast(recycle_path)
    elif platform.system() == "Darwin":
        # macOS: ~/.Trash
        trash_path = os.path.expanduser("~/.Trash")
        if os.path.isdir(trash_path):
            total += _get_folder_size_fast(trash_path)
    else:
        # Linux: ~/.local/share/Trash/files
        trash_path = os.path.expanduser("~/.local/share/Trash/files")
        if os.path.isdir(trash_path):
            total += _get_folder_size_fast(trash_path)
    return total

def get_disk_free_batch(drives: list = None):
    """
    Batch query disk free space for multiple drives + desktop/recycle bin used space.
    Returns: { "C": {free, total}, "D": {free, total}, "DESKTOP": {used}, "RECYCLE": {used}, ... }
    Uses 30-second cache to avoid redundant queries from multiple windows.
    """
    global _disk_free_cache, _disk_free_cache_time

    now = time.time()
    # Return cached result if still valid
    if _disk_free_cache and (now - _disk_free_cache_time) < _DISK_FREE_CACHE_TTL:
        return _disk_free_cache

    # Cache expired or not exists, do real query
    result = {}
    if not drives:
        # Auto-detect drives on Windows
        if _IS_WINDOWS:
            import string
            drives = [f"{d}:" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
        else:
            drives = ["/"]

    for drive in drives:
        letter = drive.upper().replace(":", "").replace("\\", "").replace("/", "") or "X"
        info = get_disk_free(drive)
        if info.get("success"):
            result[letter] = {"free": info["free"], "total": info["total"]}

    # ★ Add Desktop used space
    desktop_path = _get_desktop_path()
    if desktop_path:
        result["DESKTOP"] = {"used": _get_folder_size_fast(desktop_path), "path": desktop_path}

    # ★ Add Recycle Bin/Trash used space (cross-platform)
    result["RECYCLE"] = {"used": _get_recycle_bin_size(drives)}

    # Update cache
    _disk_free_cache = {"success": True, "data": result}
    _disk_free_cache_time = now

    return _disk_free_cache

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

    if action == "disk_free_batch":
        out.update(get_disk_free_batch(cmd.get("drives")))
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

    if action == "get_foreground_hwnd":
        out.update(_get_foreground_hwnd(cmd))
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

    if action == "reset_audio_engine":
        _reset_all_audio()  # ★ 重置所有音频引擎（音乐+SFX+剪贴板监听）
        out["status"] = "ok"
        return out

    if action == "get_audio_state":
        out.update(_get_audio_state())
        return out

    if action == "set_radio_status":
        _set_radio_status(cmd.get("live", False), cmd.get("m3u8", ""), cmd.get("stream", ""))
        out["status"] = "ok"
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

    # ★ Hotkey listener commands
    if action == "start_hotkey_listener":
        out.update(_start_hotkey_listener())
        return out

    if action == "stop_hotkey_listener":
        out.update(_stop_hotkey_listener())
        return out

    if action == "get_hotkey_state":
        out.update(_get_hotkey_state())
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
LOG_FILENAME = "broker.log"
LOG_MAX_SIZE = 1048576  # 1MB max log size

ENABLE_LOCAL_TOKEN = True

# Global log file handle (set in broker mode)
_LOG_FILE = None
_LOG_PATH = None

def _init_log_file():
    """Initialize log file for broker mode (needed for pythonw.exe which has no stderr)"""
    global _LOG_FILE, _LOG_PATH
    try:
        log_dir = _get_endpoint_dir_simple()
        _LOG_PATH = log_dir / LOG_FILENAME
        _LOG_FILE = open(_LOG_PATH, 'a', encoding='utf-8')
    except:
        pass

def _rotate_log_if_needed():
    """Rotate log file if it exceeds LOG_MAX_SIZE (1MB)"""
    global _LOG_FILE, _LOG_PATH
    if not _LOG_PATH or not _LOG_FILE:
        return
    try:
        if _LOG_PATH.exists() and _LOG_PATH.stat().st_size > LOG_MAX_SIZE:
            _LOG_FILE.close()
            _LOG_PATH.unlink()  # Delete old log
            _LOG_FILE = open(_LOG_PATH, 'w', encoding='utf-8')
            _LOG_FILE.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}][{APP_ID}][INFO] Log rotated (exceeded 2MB)\n")
            _LOG_FILE.flush()
    except:
        pass

def _get_endpoint_dir_simple() -> Path:
    """Simple version without logging (to avoid circular call)"""
    sysname = platform.system()
    if sysname == "Windows":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or tempfile.gettempdir()
        p = Path(base) / ENDPOINT_DIRNAME
    else:
        base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
        p = Path(base) / ENDPOINT_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p

def _log(msg: str, level: str = "INFO"):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}][{APP_ID}][{level}] {msg}\n"
    # ★ Always write to stderr for JS capture (WARN logs)
    if level == "WARN":
        try:
            sys.stderr.write(line)
            sys.stderr.flush()
        except:
            pass
    # Write to log file with rotation check
    if _LOG_FILE:
        try:
            _rotate_log_if_needed()  # ★ Check rotation before write
            _LOG_FILE.write(line)
            _LOG_FILE.flush()
            return
        except:
            pass
    # Fallback to stderr
    try:
        sys.stderr.write(line)
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
        _log(f"Endpoint dir ensured: {p}")
    except Exception as e:
        _log(f"Failed to create endpoint dir {p}: {e}")
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
        _log(f"Endpoint file written: {fp}")
    except Exception as e:
        _log(f"Failed to write endpoint file: {fp}, error: {e}")

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

# ---------------- Windows Named Pipe (pywin32 only) -------------------
_PIPE_NAME = None

if _IS_WINDOWS:
    if not _HAS_PYWIN32:
        _log("[FATAL] pywin32 required for Windows Named Pipe IPC")
    # pywin32 constants
    INVALID_HANDLE_VALUE = -1
    ERROR_IO_PENDING = 997
    ERROR_PIPE_CONNECTED = 535
    ERROR_BROKEN_PIPE = 109
    ERROR_NO_DATA = 232
    WAIT_OBJECT_0 = 0
    WAIT_TIMEOUT = 258

def _get_current_user_sid() -> str:
    """
    Get current user's SID (Security Identifier) - unique and immutable
    Falls back to USERNAME if SID cannot be obtained
    """
    try:
        import win32security
        import win32api
        # Get current process token
        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(),
            win32security.TOKEN_QUERY
        )
        # Get user SID from token
        user_sid, _ = win32security.GetTokenInformation(
            token,
            win32security.TokenUser
        )
        # Convert SID to string (e.g., "S-1-5-21-xxx-xxx-xxx-1001")
        sid_str = win32security.ConvertSidToStringSid(user_sid)
        # Use last part of SID (the user RID) for shorter pipe name
        # e.g., "S-1-5-21-123-456-789-1001" -> "1001"
        return sid_str.split('-')[-1]
    except Exception as e:
        _log(f"[SID] Failed to get SID via pywin32: {e}")

    # Ultimate fallback: use USERNAME (less stable but works)
    return _sanitize_id(os.environ.get("USERNAME") or os.environ.get("USER") or "user")

def _get_windows_pipe_name() -> str:
    # ★ Use SID (immutable, unique) instead of USERNAME (can change)
    user_id = _get_current_user_sid()
    base = f"{ENDPOINT_DIRNAME}_{user_id}"
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

def _win_pipe_write(h, b: bytes) -> bool:
    """Write to Named Pipe using pywin32"""
    if not b:
        return True
    try:
        win32file.WriteFile(h, b)
        return True
    except:
        return False

def _win_pipe_read_some_overlapped(h, timeout_ms: int = 500):
    """Read from Named Pipe using pywin32"""
    try:
        # Use PeekNamedPipe to check data availability (non-blocking check)
        try:
            _, avail, _ = win32pipe.PeekNamedPipe(h, 0)
            if avail == 0:
                # No data available, wait a bit and return empty
                time.sleep(timeout_ms / 1000.0)
                _, avail, _ = win32pipe.PeekNamedPipe(h, 0)
                if avail == 0:
                    return b""
        except pywintypes.error as e:
            if e.winerror in (ERROR_BROKEN_PIPE, ERROR_NO_DATA, 6):  # 6=ERROR_INVALID_HANDLE
                return None
            return None

        # Data available, read it
        try:
            hr, data = win32file.ReadFile(h, min(avail, 65536))
            if hr == 0:
                return data
            return None
        except pywintypes.error as e:
            if e.winerror in (ERROR_BROKEN_PIPE, ERROR_NO_DATA):
                return None
            return None
    except:
        return None

def _try_connect_pipe(pipe_name: str, token: str) -> bool:
    """Try to connect to existing Named Pipe broker using pywin32"""
    try:
        try:
            win32pipe.WaitNamedPipe(pipe_name, 250)
        except pywintypes.error:
            return False
        try:
            h = win32file.CreateFile(
                pipe_name,
                win32file.GENERIC_READ | win32file.GENERIC_WRITE,
                0, None,
                win32file.OPEN_EXISTING,
                0, None
            )
        except pywintypes.error:
            return False
        try:
            req = {"_id": 0, "action": "hello", "client_id": "probe", "token": token}
            if not _win_pipe_write(h, (json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8")):
                return False
            inbuf = bytearray()
            t0 = _now_mono()
            while (_now_mono() - t0) < 0.35:
                chunk = _win_pipe_read_some_overlapped(h, timeout_ms=80)
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
                win32api.CloseHandle(h)
            except:
                pass
    except:
        return False

# ---- OS-level singleton mutex ----
_BROKER_MUTEX_HANDLE = None  # Windows: Named Mutex handle
_BROKER_LOCK_FD = None       # Unix: flock file descriptor
_BROKER_MUTEX_NAME = "Global\\VixAudioBrokerSingletonMutex"

def _acquire_broker_mutex() -> bool:
    """
    ★ 操作系统级别单例锁
    Windows: Named Mutex (跨进程、跨会话)
    Unix: flock on cache dir lock file
    Returns True if we got the lock (we are the singleton)
    Returns False if another instance holds it
    """
    global _BROKER_MUTEX_HANDLE, _BROKER_LOCK_FD

    if platform.system() == "Windows":
        # Windows: Named Mutex
        try:
            import win32event
            import win32api
            import winerror
            # CreateMutex: if mutex exists and is owned, we get ERROR_ALREADY_EXISTS
            _BROKER_MUTEX_HANDLE = win32event.CreateMutex(None, True, _BROKER_MUTEX_NAME)
            last_error = win32api.GetLastError()
            if last_error == winerror.ERROR_ALREADY_EXISTS:
                # Another instance owns the mutex
                try:
                    win32api.CloseHandle(_BROKER_MUTEX_HANDLE)
                except:
                    pass
                _BROKER_MUTEX_HANDLE = None
                return False
            return True
        except Exception as e:
            _log(f"[Mutex] pywin32 CreateMutex failed: {e}")
            return True  # Fail open to avoid blocking
    else:
        # Unix: flock
        try:
            import fcntl
            cache_dir = str(_get_endpoint_dir_simple())
            os.makedirs(cache_dir, exist_ok=True)
            lock_path = os.path.join(cache_dir, "broker.lock")
            _BROKER_LOCK_FD = open(lock_path, 'w')
            fcntl.flock(_BROKER_LOCK_FD.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (IOError, OSError):
            # Lock held by another process
            if _BROKER_LOCK_FD:
                try:
                    _BROKER_LOCK_FD.close()
                except:
                    pass
                _BROKER_LOCK_FD = None
            return False
        except Exception as e:
            _log(f"[Mutex] flock failed: {e}")
            return True  # 失败时不阻塞

def _release_broker_mutex():
    """Release OS-level singleton mutex"""
    global _BROKER_MUTEX_HANDLE, _BROKER_LOCK_FD

    if platform.system() == "Windows":
        if _BROKER_MUTEX_HANDLE:
            try:
                import win32api
                win32api.CloseHandle(_BROKER_MUTEX_HANDLE)
            except:
                pass
            _BROKER_MUTEX_HANDLE = None
    else:
        if _BROKER_LOCK_FD:
            try:
                import fcntl
                fcntl.flock(_BROKER_LOCK_FD.fileno(), fcntl.LOCK_UN)
                _BROKER_LOCK_FD.close()
            except:
                pass
            _BROKER_LOCK_FD = None

def _create_listen_endpoint(local_token: str):
    sysname = platform.system()

    # ★ Step 0: 获取 OS 级别单例锁（原子操作，无竞态窗口）
    if not _acquire_broker_mutex():
        _log("[Singleton] Another Broker instance holds the mutex")
        raise RuntimeError("BROKER_ALREADY_RUNNING")

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

    # Windows: Named Pipe first, TCP fallback
    rid = _get_current_user_sid()
    pipe_name = f"\\\\.\\pipe\\{ENDPOINT_DIRNAME}_{rid}"
    global _PIPE_NAME
    _PIPE_NAME = pipe_name

    _log(f"Trying Named Pipe: {pipe_name}")
    # Test create first pipe instance to verify we're the sole owner
    hPipe = _create_named_pipe_instance(pipe_name, first_instance=True)
    if not _is_invalid_handle(hPipe):
        _log(f"Named Pipe created successfully: {pipe_name}")
        # Close the test handle - _pipe_accept_loop will create instances
        _pipe_close_handle(hPipe)

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

    # Named Pipe failed, fallback to TCP
    _log(f"Named Pipe failed, fallback to TCP socket")
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', 0))  # Let OS pick a free port
    tcp_port = s.getsockname()[1]
    s.listen(64)
    s.settimeout(0.5)

    info = {
        "app_id": APP_ID,
        "protocol": BROKER_PROTOCOL,
        "family": "tcp",
        "host": "127.0.0.1",
        "port": tcp_port,
        "pid": os.getpid(),
        "token_enabled": bool(ENABLE_LOCAL_TOKEN),
    }
    _write_endpoint_file(info)
    _log(f"TCP endpoint: 127.0.0.1:{tcp_port}")
    return ("tcp", s, info)

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
    # ★ Release OS-level singleton mutex
    try:
        _release_broker_mutex()
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
_ACTIVE_UNIX_CLIENTS = {}  # {conn_tag: socket} for broadcast
_ACTIVE_UNIX_LOCK = threading.Lock()

def _unix_client_loop(conn: socket.socket):
    try:
        conn.settimeout(0.5)
    except:
        pass
    inbuf = bytearray()
    SLOW_ACTIONS = {"path_size", "folder_info", "get_folder_info"}
    conn_tag = f"unix:{id(conn)}"
    _log(f"[TCP/Unix] Client loop started for {conn_tag}")

    # ★ 注册广播客户端
    def write_func(data: bytes):
        conn.sendall(data)

    _register_broadcast_client(conn_tag, write_func)
    with _ACTIVE_UNIX_LOCK:
        _ACTIVE_UNIX_CLIENTS[conn_tag] = conn

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
                _QUIET_ACTIONS = {'ping', 'disk_free_batch', 'update_window_focus', 'register_q2_window', 'unregister_q2_window'}
                if action not in _QUIET_ACTIONS:
                    _log(f"[TCP/Unix] Recv: action={action}, _id={cmd.get('_id')}")
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

                if action not in _QUIET_ACTIONS:
                    _log(f"[TCP/Unix] Send: _id={res.get('_id')}, ok={res.get('ok')}")
                try:
                    conn.sendall((json.dumps(res, ensure_ascii=False) + "\n").encode("utf-8"))
                except Exception as e:
                    _log(f"[TCP/Unix] Send error: {e}")
                    break
    finally:
        # ★ 注销广播客户端
        _unregister_broadcast_client(conn_tag)
        with _ACTIVE_UNIX_LOCK:
            _ACTIVE_UNIX_CLIENTS.pop(conn_tag, None)
        try:
            conn.close()
        except:
            pass

def _unix_accept_loop(listen_sock: socket.socket):
    _log(f"[TCP/Unix] Accept loop started, socket={listen_sock}")
    while not _SHUTDOWN_FLAG:
        try:
            conn, addr = listen_sock.accept()
            _log(f"[TCP/Unix] Client connected from {addr}")
        except socket.timeout:
            continue
        except Exception as e:
            _log(f"[TCP/Unix] Accept error: {e}")
            break
        try:
            threading.Thread(target=_unix_client_loop, args=(conn,), daemon=True).start()
            _log(f"[TCP/Unix] Client handler thread started")
        except Exception as e:
            _log(f"[TCP/Unix] Thread start error: {e}")
            try:
                conn.close()
            except:
                pass

# ---------------- Windows named pipe server ----------------
_ACTIVE_PIPE_HANDLES = set()
_ACTIVE_PIPE_LOCK = threading.Lock()

def _pipe_close_handle(h):
    """Close pipe handle using pywin32"""
    try:
        win32api.CloseHandle(h)
    except:
        pass

def _disconnect_named_pipe(h):
    """Disconnect Named Pipe using pywin32"""
    try:
        win32pipe.DisconnectNamedPipe(h)
    except:
        pass

def _pipe_client_loop(hPipe):
    _log(f"[Pipe] Client loop started for pipe:{hPipe}")
    inbuf = bytearray()
    SLOW_ACTIONS = {"path_size", "folder_info", "get_folder_info"}
    conn_tag = f"pipe:{hPipe}"

    # ★ 注册广播客户端
    def write_func(data: bytes):
        _win_pipe_write(hPipe, data)

    _register_broadcast_client(conn_tag, write_func)

    try:
        while not _SHUTDOWN_FLAG:
            chunk = _win_pipe_read_some_overlapped(hPipe, timeout_ms=300)
            if chunk is None:
                _log(f"[Pipe] Client disconnected (chunk=None)")
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

                action = cmd.get("action") or cmd.get("cmd") or ""
                _id = cmd.get("_id", 0)
                # ★ Skip logging for high-frequency routine actions
                _QUIET_ACTIONS = {'ping', 'disk_free_batch', 'update_window_focus', 'register_q2_window', 'unregister_q2_window'}
                if action not in _QUIET_ACTIONS:
                    _log(f"[Pipe] Recv: action={action}, _id={_id}")

                # 连接级兜底：客户端没带 client_id 时，用连接标识，避免 TTL 误判
                if not (cmd.get("client_id") or cmd.get("clientId") or cmd.get("cid")):
                    cmd["client_id"] = conn_tag

                if action in SLOW_ACTIONS:
                    cancel_ver = _get_scan_cancel_version()
                    fut = _IO_EXECUTOR.submit(_broker_dispatch, cmd, cancel_ver)
                    try:
                        res = fut.result()
                    except Exception as e:
                        res = {"_id": _id, "ok": False, "error": str(e)}
                else:
                    try:
                        res = _broker_dispatch(cmd, None)
                    except Exception as e:
                        res = {"_id": _id, "ok": False, "error": str(e)}

                if action not in _QUIET_ACTIONS:
                    _log(f"[Pipe] Send: _id={_id}, ok={res.get('ok')}")
                if not _win_pipe_write(hPipe, (json.dumps(res, ensure_ascii=False) + "\n").encode("utf-8")):
                    _log(f"[Pipe] Write failed, closing")
                    return
    except Exception as e:
        _log(f"[Pipe] Client loop error: {e}")
    finally:
        _log(f"[Pipe] Client loop ended for pipe:{hPipe}")
        # ★ 注销广播客户端
        _unregister_broadcast_client(conn_tag)
        _disconnect_named_pipe(hPipe)
        _pipe_close_handle(hPipe)
        with _ACTIVE_PIPE_LOCK:
            _ACTIVE_PIPE_HANDLES.discard(hPipe)

def _create_named_pipe_instance(pipe_name: str, first_instance: bool):
    """Create Named Pipe instance using pywin32"""
    openmode = win32pipe.PIPE_ACCESS_DUPLEX | win32file.FILE_FLAG_OVERLAPPED
    if first_instance:
        openmode |= 0x00080000  # FILE_FLAG_FIRST_PIPE_INSTANCE
    pipemode = win32pipe.PIPE_TYPE_BYTE | win32pipe.PIPE_READMODE_BYTE | win32pipe.PIPE_WAIT
    try:
        h = win32pipe.CreateNamedPipe(
            pipe_name,
            openmode,
            pipemode,
            win32pipe.PIPE_UNLIMITED_INSTANCES,
            65536,
            65536,
            0,
            None
        )
        return h
    except pywintypes.error:
        return INVALID_HANDLE_VALUE

def _pipe_wait_connect(hPipe, timeout_ms: int) -> int:
    """
    Wait for client connection (simplified, no overlapped for stability).
    Returns: 1=connected, 0=timeout, -1=error
    """
    try:
        # Use non-overlapped ConnectNamedPipe with short polling
        start = time.monotonic()
        while (time.monotonic() - start) * 1000 < timeout_ms:
            try:
                win32pipe.ConnectNamedPipe(hPipe, None)
                return 1
            except pywintypes.error as e:
                if e.winerror == ERROR_PIPE_CONNECTED:
                    return 1
                if e.winerror == ERROR_IO_PENDING:
                    # Pipe is in connecting state, wait a bit
                    time.sleep(0.05)
                    continue
                # Other error
                return -1
        return 0  # Timeout
    except:
        return -1

def _is_invalid_handle(h) -> bool:
    """Check if handle is invalid"""
    if h is None:
        return True
    try:
        return int(h) == INVALID_HANDLE_VALUE or int(h) <= 0
    except:
        return True

def _pipe_accept_loop(pipe_name: str):
    _log(f"[Accept] Starting accept loop for {pipe_name}")
    first = True
    hPipe = None

    while not _SHUTDOWN_FLAG:
        if hPipe is None:
            hPipe = _create_named_pipe_instance(pipe_name, first_instance=first)
            first = False
            if _is_invalid_handle(hPipe):
                _log(f"[Accept] Failed to create pipe instance")
                time.sleep(0.5)
                hPipe = None
                continue
            _log(f"[Accept] Pipe instance created: {hPipe}")

        st = _pipe_wait_connect(hPipe, timeout_ms=300)
        # _log(f"[Accept] _pipe_wait_connect returned: {st}")  # Too spammy
        if st == 0:
            continue  # timeout
        if st < 0:
            _log(f"[Accept] Pipe wait failed (st={st}), recreating...")
            _disconnect_named_pipe(hPipe)
            _pipe_close_handle(hPipe)
            hPipe = None
            continue

        _log(f"[Accept] Client connected! hPipe={hPipe}")
        with _ACTIVE_PIPE_LOCK:
            _ACTIVE_PIPE_HANDLES.add(hPipe)

        try:
            threading.Thread(target=_pipe_client_loop, args=(hPipe,), daemon=True).start()
        except:
            _disconnect_named_pipe(hPipe)
            _pipe_close_handle(hPipe)
            with _ACTIVE_PIPE_LOCK:
                _ACTIVE_PIPE_HANDLES.discard(hPipe)

        hPipe = None

    if hPipe is not None:
        try:
            try:
                win32file.CancelIoEx(hPipe, None)
            except:
                pass
        except:
            pass
        _disconnect_named_pipe(hPipe)
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

    # ★ Initialize log file FIRST (for pythonw.exe which has no stderr)
    _init_log_file()

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

    # ★ Auto-start global keyboard hook (Space+Q)
    if _HAS_PYNPUT:
        _start_hotkey_listener()
    else:
        _log("[Hotkey] pynput not available, install with: pip install pynput")

    threading.Thread(target=_lease_watchdog, daemon=True, name="lease-watchdog").start()

    accept_thread = None
    listen_sock = None

    try:
        if kind == "unix" or kind == "tcp":
            # TCP and Unix sockets use the same accept loop (same Python socket API)
            listen_sock = endpoint_obj
            accept_thread = threading.Thread(target=_unix_accept_loop, args=(listen_sock,), daemon=True, name=f"{kind}-accept")
            accept_thread.start()
            _log(f"{kind.upper()} accept thread started")
        else:
            pipe_name = endpoint_obj
            _log(f"Starting pipe accept thread for {pipe_name}")
            accept_thread = threading.Thread(target=_pipe_accept_loop, args=(pipe_name,), daemon=True, name="pipe-accept")
            accept_thread.start()
            _log(f"Pipe accept thread started: {accept_thread.name}, alive={accept_thread.is_alive()}")
            time.sleep(0.5)  # Give thread time to start
            _log(f"After delay, thread alive={accept_thread.is_alive()}")

        while not _SHUTDOWN_FLAG:
            time.sleep(0.2)

    except KeyboardInterrupt:
        _log("KeyboardInterrupt, exiting...")
        _SHUTDOWN_FLAG = True
    except Exception as e:
        _log(f"Broker loop error: {e}")
        _SHUTDOWN_FLAG = True
    finally:
        # ★ Stop hotkey listener on shutdown
        _stop_hotkey_listener()

        _safe_shutdown_cleanup()

        if kind == "unix" or kind == "tcp":
            try:
                if listen_sock:
                    listen_sock.close()
            except:
                pass
            if kind == "unix":
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

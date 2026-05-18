# -*- coding: utf-8 -*-
"""
final_audio_hub_v16_fusion.py
========================================================
的梦专用：v16音乐播放器 + A++并发音效 + 剪切板触发 + 任意事件触发（单文件融合版）

设计目标：
1) 保留你 v16 的核心接口（NonBlockingAudioEngine / az）尽量不改
2) 新增极简高速并发音效接口（play_sfx(path), prime_sfx(paths)）
3) 支持剪切板触发 + 任意条件触发（event bus）
4) 尽量最小侵入；如设备并发冲突，可切换到“复用音乐引擎播放音效”模式

依赖：
    pip install miniaudio
========================================================
"""

import sys
import time
import os
import random
import ctypes
import queue
import threading
if sys.platform == 'win32':
    import ctypes.wintypes as wt
from concurrent.futures import ThreadPoolExecutor

import array
import math
import atexit
from functools import lru_cache
from collections import OrderedDict
import traceback

# =========================
# miniaudio import
# =========================
_MINIAUDIO_IMPORT_ERROR = None
try:
    import miniaudio  # noqa
except Exception as e:
    miniaudio = None  # type: ignore
    _MINIAUDIO_IMPORT_ERROR = e

# =========================
# v16 参数
# =========================
SILENCE_DB = -80.0
TRIM_WINDOW_SECONDS = 30.0
LOUD_RUN_MS = 8.0

LOOP_PREDECODE_MAX_SECONDS = 300.0
LOOP_CROSSFADE_MS_DEFAULT = 12.0

SOURCE_READ_FRAMES_MAX = 16384
EMPTY_READ_RETRIES = 6
EMPTY_READ_SLEEP = 0.0

PCM_CACHE_MAX_ITEMS = 8


def _db_to_int16_threshold(db: float) -> int:
    ratio = 10 ** (db / 20.0)
    return int(32767 * ratio)


SILENCE_THR = _db_to_int16_threshold(SILENCE_DB)


@lru_cache(maxsize=64)
def _cosine_fade_table(fade_frames: int):
    if fade_frames <= 0:
        return None
    n = float(fade_frames)
    return tuple(0.5 * (1.0 + math.cos(math.pi * (i / n))) for i in range(fade_frames + 1))


@lru_cache(maxsize=64)
def _raised_cosine_crossfade_gains(n: int):
    if n <= 0:
        return (), ()
    out_g = []
    in_g = []
    for i in range(n):
        a = 0.5 * (1.0 - math.cos(math.pi * ((i + 1) / float(n))))
        in_g.append(a)
        out_g.append(1.0 - a)
    return tuple(out_g), tuple(in_g)


def _short_exc(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"


def _miniaudio_file_hint() -> str:
    if miniaudio is None:
        return ""
    p = getattr(miniaudio, "__file__", "") or ""
    if not p:
        return "miniaudio.__file__ 为空（异常情况）"
    cwd = os.path.abspath(os.getcwd())
    ap = os.path.abspath(p)
    if ap.startswith(cwd + os.sep) or ap == cwd:
        return (
            "⚠️ 疑似同名遮蔽：当前导入的 miniaudio 来自工作目录/项目目录。\n"
            f"  当前工作目录: {cwd}\n"
            f"  miniaudio.__file__: {ap}\n"
            "  请检查是否存在 miniaudio.py 或 miniaudio/ 目录。"
        )
    return ""


def _miniaudio_diagnostics(verbose_trace=False) -> str:
    lines = []
    lines.append(f"python: {sys.version.splitlines()[0]}")
    lines.append(f"platform: {sys.platform}")
    lines.append(f"cwd: {os.path.abspath(os.getcwd())}")

    if miniaudio is None:
        lines.append("miniaudio: IMPORT FAILED")
        if _MINIAUDIO_IMPORT_ERROR is not None:
            lines.append(f"import error: {_short_exc(_MINIAUDIO_IMPORT_ERROR)}")
            if verbose_trace:
                lines.append(traceback.format_exc())
        return "\n".join(lines)

    mf = getattr(miniaudio, "__file__", None)
    mv = getattr(miniaudio, "__version__", None)
    lines.append(f"miniaudio.__file__: {mf}")
    lines.append(f"miniaudio.__version__: {mv}")

    hint = _miniaudio_file_hint()
    if hint:
        lines.append(hint)

    required = ["PlaybackDevice", "SampleFormat", "stream_file", "get_file_info"]
    missing = [x for x in required if not hasattr(miniaudio, x)]
    lines.append(f"missing symbols: {missing if missing else 'none'}")

    if missing:
        attrs = sorted([a for a in dir(miniaudio) if not a.startswith("_")])
        lines.append("exported attributes (partial): " + ", ".join(attrs[:40]) + (" ..." if len(attrs) > 40 else ""))

    return "\n".join(lines)


class _MiniaudioCompat:
    def __init__(self):
        self.ok = True
        self.reason_lines = []

        if miniaudio is None:
            self.ok = False
            self.reason_lines.append("miniaudio import failed")
            if _MINIAUDIO_IMPORT_ERROR is not None:
                self.reason_lines.append(_short_exc(_MINIAUDIO_IMPORT_ERROR))
            return

        self.PlaybackDevice = getattr(miniaudio, "PlaybackDevice", None)
        if self.PlaybackDevice is None:
            self.ok = False
            self.reason_lines.append("miniaudio.PlaybackDevice not found")

        self.SampleFormat = getattr(miniaudio, "SampleFormat", None)
        self.SIGNED16 = None
        if self.SampleFormat is None:
            self.ok = False
            self.reason_lines.append("miniaudio.SampleFormat not found")
        else:
            self.SIGNED16 = getattr(self.SampleFormat, "SIGNED16", None)
            if self.SIGNED16 is None:
                self.ok = False
                self.reason_lines.append("miniaudio.SampleFormat.SIGNED16 not found")

        self.stream_file = getattr(miniaudio, "stream_file", None)
        if self.stream_file is None:
            self.ok = False
            self.reason_lines.append("miniaudio.stream_file not found")

        self.get_file_info = getattr(miniaudio, "get_file_info", None)
        if self.get_file_info is None:
            self.ok = False
            self.reason_lines.append("miniaudio.get_file_info not found")

    def reason(self, with_diag=True) -> str:
        base = "\n".join(self.reason_lines) if self.reason_lines else ""
        if not with_diag:
            return base or "unknown"
        diag = _miniaudio_diagnostics(verbose_trace=False)
        if base:
            return base + "\n\n--- diagnostics ---\n" + diag
        return "not ok\n\n--- diagnostics ---\n" + diag


def _https_urlopen(url, timeout=30, headers=None):
    """★ 直接用 http.client 发 GET 请求，绕开 urllib.request 的 opener 机制。
    解决嵌入式 Python 中 urllib.request 缓存无 HTTPSHandler 导致
    'unknown url type: https' 的问题。"""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme == 'https':
        import ssl
        ctx = ssl.create_default_context()
        import http.client
        conn = http.client.HTTPSConnection(
            parsed.hostname, parsed.port or 443,
            context=ctx, timeout=timeout,
        )
    else:
        import http.client
        conn = http.client.HTTPConnection(
            parsed.hostname, parsed.port or 80,
            timeout=timeout,
        )
    path = parsed.path or '/'
    if parsed.query:
        path += '?' + parsed.query
    hdrs = {'User-Agent': 'qqq-radio/1'}
    if headers:
        hdrs.update(headers)
    conn.request('GET', path, headers=hdrs)
    resp = conn.getresponse()
    resp._conn = conn  # prevent GC closing connection
    return resp


class _RadioStreamSource(miniaudio.StreamableSource):
    """流式音频源，作为 miniaudio stream_any 的传入。
    后台线程 HTTP 下载 + 内部缓冲区 + Condition 即时唤醒。"""
    BUFFER_SIZE = 131072  # 128KB 内部缓冲 = 20+ 秒 @ 48kbps
    BLOCK_SIZE = 16384    # 16KB 每次网络读取，加速初始填充

    def __init__(self, url):
        self._buf = bytearray()
        self._cond = threading.Condition()
        self._stop = threading.Event()
        self._eof = False
        self._resp = _https_urlopen(url, timeout=30)
        self._thread = threading.Thread(target=self._download, daemon=True)
        self._thread.start()

    def _download(self):
        try:
            while not self._stop.is_set():
                with self._cond:
                    while len(self._buf) >= self.BUFFER_SIZE and not self._stop.is_set():
                        self._cond.wait(timeout=0.1)
                if self._stop.is_set():
                    break
                data = self._resp.read(self.BLOCK_SIZE)
                if not data:
                    self._eof = True
                    with self._cond:
                        self._cond.notify_all()
                    break
                with self._cond:
                    self._buf.extend(data)
                    self._cond.notify_all()  # 立即唤醒 read()
        except Exception:
            self._eof = True
            with self._cond:
                self._cond.notify_all()

    def read(self, num_bytes):
        """解码器调用。数据到达时由 Condition 即时唤醒，零轮询。"""
        with self._cond:
            deadline = time.time() + 10.0
            while not self._buf:
                if self._eof or self._stop.is_set():
                    return b''
                remaining = deadline - time.time()
                if remaining <= 0:
                    return b''
                self._cond.wait(timeout=min(remaining, 0.5))
            n = min(num_bytes, len(self._buf))
            data = bytes(self._buf[:n])
            del self._buf[:n]
            self._cond.notify_all()  # 唤醒 _download 继续填充
            return data

    def seek(self, offset, origin):
        return False

    def close(self):
        self._stop.set()
        with self._cond:
            self._cond.notify_all()
        try: self._resp.close()
        except Exception: pass


class PlaybackToken:
    __slots__ = ("stop_event", "last_data_pull", "_radio_q",)

    def __init__(self):
        self.stop_event = threading.Event()
        self.last_data_pull = time.time()  # ★ 追踪设备最后一次拉取数据的时间
        self._radio_q = None  # ★ 电台段间队列，由 _pcm_once_stream 懒初始化

    def stop(self):
        self.stop_event.set()

    @property
    def stopped(self):
        return self.stop_event.is_set()

    def touch(self):
        """★ 由 stream generator 在 yield 有效数据时调用，证明设备仍在拉取"""
        self.last_data_pull = time.time()

    def device_silent_seconds(self):
        """★ 返回设备停止拉取数据的秒数（0 = 正常工作中）"""
        return time.time() - self.last_data_pull


class NonBlockingAudioEngine:
    def __init__(self, asset_folder="assets", max_workers=32, silent=False, on_device_lost=None, on_log=None):
        self.silent = silent
        self._on_log = on_log  # ★ 外部日志回调（写入 broker.log）
        self._log("非阻塞音频引擎初始化中...")
        self.asset_folder = asset_folder
        self._on_device_lost = on_device_lost  # ★ 设备丢失回调

        self._compat = _MiniaudioCompat()
        if not self._compat.ok:
            raise RuntimeError(self._compat.reason(with_diag=True))

        self.PlaybackDevice = self._compat.PlaybackDevice
        self.REQUESTED_FORMAT = self._compat.SIGNED16
        self.REQUESTED_CHANNELS = 2
        self.REQUESTED_RATE = 44100
        self._frame_bytes = self.REQUESTED_CHANNELS * 2

        self.executor = ThreadPoolExecutor(max_workers=max_workers)

        self._cleaned = False
        self._active_tokens = set()
        self._tokens_lock = threading.Lock()

        self._trim_cache = {}
        self._trim_cache_lock = threading.Lock()

        self._pcm_cache = OrderedDict()
        self._pcm_cache_lock = threading.Lock()

        atexit.register(self.cleanup)
        self._log("非阻塞音频引擎初始化完毕。")

    def _log(self, msg: str):
        if not self.silent:
            print(msg)

    def _log_critical(self, msg: str):
        """设备恢复等关键场景，无论 silent 与否都打印到 broker.log + stdout。"""
        full = f"[Audio] {msg}"
        if self._on_log:
            try:
                self._on_log(full)
            except Exception:
                pass
        print(full)

    @staticmethod
    def _kill_device_async(dev):
        """★ 非阻塞销毁设备 — device.stop() 在设备被系统挂起时可能永久阻塞"""
        def _do():
            try: dev.stop()
            except Exception: pass
            try: dev.close()
            except Exception: pass
        t = threading.Thread(target=_do, daemon=True)
        t.start()

    def _send_primed(self, gen, value):
        try:
            return gen.send(value)
        except TypeError as e:
            if "just-started generator" in str(e):
                try:
                    gen.send(None)
                except StopIteration:
                    return b""
                return gen.send(value)
            raise

    def _read_frames_retry(self, gen, frames: int):
        if frames <= 0:
            return b""
        if frames > SOURCE_READ_FRAMES_MAX:
            frames = SOURCE_READ_FRAMES_MAX
        for _ in range(EMPTY_READ_RETRIES):
            data = self._send_primed(gen, frames)
            if data:
                return bytes(data)
            if EMPTY_READ_SLEEP > 0:
                time.sleep(EMPTY_READ_SLEEP)
        return b""

    def _skip_frames(self, gen, frames_to_skip: int, token: PlaybackToken) -> bool:
        remain = frames_to_skip
        while remain > 0:
            if token.stopped:
                return False
            req = SOURCE_READ_FRAMES_MAX if remain > SOURCE_READ_FRAMES_MAX else remain
            b = self._read_frames_retry(gen, req)
            if not b:
                return False
            got = len(b) // self._frame_bytes
            if got <= 0:
                return False
            remain -= got
        return True

    def _block_peak_over_threshold(self, pcm_bytes: bytes, thr: int) -> bool:
        samples = array.array("h")
        samples.frombytes(pcm_bytes)
        if sys.byteorder != "little":
            samples.byteswap()
        if not samples:
            return False
        mx = max(samples)
        mn = min(samples)
        peak = mx if mx >= -mn else -mn
        return peak > thr

    def _find_first_loud_run_in_block(self, pcm_bytes: bytes, frames_in_block: int, thr: int, need_run: int, carry_run: int):
        samples = array.array("h")
        samples.frombytes(pcm_bytes)
        if sys.byteorder != "little":
            samples.byteswap()
        ch = self.REQUESTED_CHANNELS
        run = carry_run
        for f in range(frames_in_block):
            base = f * ch
            loud = (abs(samples[base]) > thr) or (abs(samples[base + 1]) > thr)
            if loud:
                run += 1
                if run >= need_run:
                    return f - need_run + 1, run
            else:
                run = 0
        return -1, run

    def _find_last_loud_run_end_in_block(self, pcm_bytes: bytes, frames_in_block: int, thr: int, need_run: int, carry_run: int, last_end_global: int, global_offset: int):
        samples = array.array("h")
        samples.frombytes(pcm_bytes)
        if sys.byteorder != "little":
            samples.byteswap()
        ch = self.REQUESTED_CHANNELS
        run = carry_run
        last = last_end_global
        for f in range(frames_in_block):
            base = f * ch
            loud = (abs(samples[base]) > thr) or (abs(samples[base + 1]) > thr)
            if loud:
                run += 1
                if run >= need_run:
                    last = global_offset + f
            else:
                run = 0
        return run, last

    def _trim_silence_edges_uncached(self, file_path: str, start_frame: int, end_frame: int, token: PlaybackToken):
        rate = self.REQUESTED_RATE
        total_frames = end_frame - start_frame
        if total_frames <= 0:
            return start_frame, end_frame

        window_frames = int(TRIM_WINDOW_SECONDS * rate)
        lead_frames = min(window_frames, total_frames)
        tail_frames = min(window_frames, total_frames)
        tail_start_offset = max(0, total_frames - tail_frames)
        need_run = max(1, int((LOUD_RUN_MS / 1000.0) * rate))

        src = miniaudio.stream_file(file_path, output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
        try:
            if start_frame > 0 and (not self._skip_frames(src, start_frame, token)):
                return start_frame, end_frame

            first_loud = None
            carry = 0
            analyzed = 0
            while analyzed < lead_frames:
                if token.stopped:
                    return start_frame, end_frame
                req = min(SOURCE_READ_FRAMES_MAX, lead_frames - analyzed)
                b = self._read_frames_retry(src, req)
                if not b:
                    break
                got = len(b) // self._frame_bytes
                if got <= 0:
                    break
                block = b[: got * self._frame_bytes]
                if self._block_peak_over_threshold(block, SILENCE_THR):
                    idx, carry = self._find_first_loud_run_in_block(block, got, SILENCE_THR, need_run, carry)
                    if idx >= 0:
                        first_loud = analyzed + idx
                        analyzed += got
                        break
                else:
                    carry = 0
                analyzed += got

            if first_loud is None:
                first_loud = lead_frames

            seg_pos = analyzed
            if seg_pos < tail_start_offset:
                if not self._skip_frames(src, tail_start_offset - seg_pos, token):
                    last_loud_end = tail_start_offset - 1
                    new_start = start_frame + min(first_loud, total_frames)
                    new_end = start_frame + max(new_start - start_frame, min(last_loud_end + 1, total_frames))
                    if new_end < new_start:
                        new_end = new_start
                    return new_start, new_end
                seg_pos = tail_start_offset

            carry_tail = 0
            last_loud_end = -1
            while seg_pos < total_frames:
                if token.stopped:
                    return start_frame, end_frame
                req = min(SOURCE_READ_FRAMES_MAX, total_frames - seg_pos)
                b = self._read_frames_retry(src, req)
                if not b:
                    break
                got = len(b) // self._frame_bytes
                if got <= 0:
                    break
                block = b[: got * self._frame_bytes]
                if self._block_peak_over_threshold(block, SILENCE_THR):
                    carry_tail, last_loud_end = self._find_last_loud_run_end_in_block(block, got, SILENCE_THR, need_run, carry_tail, last_loud_end, seg_pos)
                else:
                    carry_tail = 0
                seg_pos += got

            if last_loud_end < 0:
                if first_loud >= total_frames:
                    return start_frame, start_frame
                last_loud_end = tail_start_offset - 1

            new_start = start_frame + max(0, min(first_loud, total_frames))
            new_end = start_frame + max(0, min(last_loud_end + 1, total_frames))
            if new_end < new_start:
                new_end = new_start
            return new_start, new_end
        finally:
            try:
                src.close()
            except Exception:
                pass

    def _trim_silence_edges(self, file_path: str, start_frame: int, end_frame: int, token: PlaybackToken):
        try:
            st = os.stat(file_path)
            mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
            size = st.st_size
        except Exception:
            return self._trim_silence_edges_uncached(file_path, start_frame, end_frame, token)

        key = (file_path, start_frame, end_frame, SILENCE_DB, LOUD_RUN_MS, TRIM_WINDOW_SECONDS, self.REQUESTED_RATE, self.REQUESTED_CHANNELS)
        with self._trim_cache_lock:
            ent = self._trim_cache.get(key)
            if ent and ent[0] == mtime_ns and ent[1] == size:
                return ent[2], ent[3]

        new_start, new_end = self._trim_silence_edges_uncached(file_path, start_frame, end_frame, token)
        with self._trim_cache_lock:
            self._trim_cache[key] = (mtime_ns, size, new_start, new_end)
        return new_start, new_end

    def _apply_fadeout_to_chunk_s16(self, chunk_bytes: bytes, chunk_frames: int, frames_played_before_chunk: int, fade_start_frame: int, fade_frames: int, fade_gains):
        if fade_frames <= 0 or chunk_frames <= 0 or not fade_gains:
            return chunk_bytes
        samples = array.array("h")
        samples.frombytes(chunk_bytes)
        if sys.byteorder != "little":
            samples.byteswap()

        ch = self.REQUESTED_CHANNELS
        for f in range(chunk_frames):
            seg_f = frames_played_before_chunk + f
            if seg_f < fade_start_frame:
                continue
            offset = seg_f - fade_start_frame
            g = 0.0 if offset >= fade_frames else fade_gains[offset]
            base = f * ch
            for c in range(ch):
                v = int(samples[base + c] * g)
                v = 32767 if v > 32767 else -32768 if v < -32768 else v
                samples[base + c] = v

        if sys.byteorder != "little":
            samples.byteswap()
        return samples.tobytes()

    def _segment_stream_from_here(self, source_gen, seg_frames: int, fade_frames: int, token: PlaybackToken):
        if seg_frames <= 0:
            framecount = yield b""
            return
        if fade_frames > seg_frames:
            fade_frames = seg_frames
        fade_start = seg_frames - fade_frames
        fade_gains = _cosine_fade_table(fade_frames) if fade_frames > 0 else None

        played = 0
        framecount = yield b""
        while True:
            if token.stopped:
                return
            if played >= seg_frames:
                return

            want_total = int(framecount) if framecount else 0
            if want_total <= 0:
                framecount = yield b""
                continue

            remain = seg_frames - played
            want = min(want_total, remain)
            data = self._send_primed(source_gen, want)
            if not data:
                return
            audio = bytes(data)
            need_len = want * self._frame_bytes
            if len(audio) < need_len:
                audio += b"\x00" * (need_len - len(audio))
            elif len(audio) > need_len:
                audio = audio[:need_len]

            if fade_frames > 0 and (played + want) > fade_start:
                audio = self._apply_fadeout_to_chunk_s16(audio, want, played, fade_start, fade_frames, fade_gains)

            played += want
            if want < want_total:
                audio += b"\x00" * ((want_total - want) * self._frame_bytes)

            token.touch()  # ★ 证明设备仍在拉取数据
            framecount = yield audio

    def _prepare_pcm_loop_crossfade(self, pcm_bytes: bytes, crossfade_ms: float):
        try:
            xms = float(crossfade_ms or 0.0)
        except Exception:
            xms = 0.0
        if xms <= 0.0:
            return pcm_bytes, 0

        total_frames = len(pcm_bytes) // self._frame_bytes
        if total_frames < 16:
            return pcm_bytes, 0

        xfade_frames = int((xms / 1000.0) * self.REQUESTED_RATE)
        if xfade_frames <= 0:
            return pcm_bytes, 0
        if xfade_frames * 2 >= total_frames:
            xfade_frames = max(1, total_frames // 4)
        if xfade_frames <= 0 or xfade_frames * 2 >= total_frames:
            return pcm_bytes, 0

        out_g, in_g = _raised_cosine_crossfade_gains(xfade_frames)
        if not out_g:
            return pcm_bytes, 0

        samples = array.array("h")
        samples.frombytes(pcm_bytes)
        if sys.byteorder != "little":
            samples.byteswap()

        ch = self.REQUESTED_CHANNELS
        tail_start_frame = total_frames - xfade_frames
        for i in range(xfade_frames):
            og = out_g[i]
            ig = in_g[i]
            tail_f = tail_start_frame + i
            head_f = i
            tail_base = tail_f * ch
            head_base = head_f * ch
            for c in range(ch):
                t = samples[tail_base + c]
                h = samples[head_base + c]
                v = int(t * og + h * ig)
                v = 32767 if v > 32767 else -32768 if v < -32768 else v
                samples[tail_base + c] = v

        if sys.byteorder != "little":
            samples.byteswap()
        return samples.tobytes(), xfade_frames

    def _get_pcm_cached_or_decode(self, file_path: str, start_frame: int, end_frame: int, token: PlaybackToken, crossfade_ms: float):
        try:
            st = os.stat(file_path)
            mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))
            size = st.st_size
        except Exception:
            mtime_ns, size = None, None

        try:
            xms = float(crossfade_ms or 0.0)
        except Exception:
            xms = 0.0
        xms_key = round(xms, 3)

        key = (file_path, start_frame, end_frame, self.REQUESTED_RATE, self.REQUESTED_CHANNELS, xms_key)
        with self._pcm_cache_lock:
            ent = self._pcm_cache.get(key)
            if ent and ent[0] == mtime_ns and ent[1] == size:
                self._pcm_cache.move_to_end(key)
                return ent[2], ent[3]

        total_frames = end_frame - start_frame
        if total_frames <= 0:
            return b"", 0

        src = miniaudio.stream_file(file_path, output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
        try:
            if start_frame > 0 and (not self._skip_frames(src, start_frame, token)):
                return b"", 0
            remain = total_frames
            buf = bytearray()
            while remain > 0 and (not token.stopped):
                req = min(SOURCE_READ_FRAMES_MAX, remain)
                b = self._read_frames_retry(src, req)
                if not b:
                    break
                got = len(b) // self._frame_bytes
                if got <= 0:
                    break
                buf.extend(b[: got * self._frame_bytes])
                remain -= got
            pcm = bytes(buf)
        finally:
            try:
                src.close()
            except Exception:
                pass

        pcm2 = pcm
        xfade_frames = 0
        if xms > 0:
            pcm2, xfade_frames = self._prepare_pcm_loop_crossfade(pcm, xms)

        with self._pcm_cache_lock:
            self._pcm_cache[key] = (mtime_ns, size, pcm2, xfade_frames)
            self._pcm_cache.move_to_end(key)
            while len(self._pcm_cache) > PCM_CACHE_MAX_ITEMS:
                self._pcm_cache.popitem(last=False)

        return pcm2, xfade_frames

    # =========================================================================
    #  ★ intro (前奏) + 主循环 支持
    # =========================================================================

    def _build_xfade_buffer(self, tail_pcm: bytes, tail_total_frames: int,
                            head_pcm: bytes, head_start_frame: int,
                            xfade_frames: int, out_g, in_g) -> bytes:
        """构建交叉淡化缓冲区：tail 尾部 × fadeout  +  head 头部 × fadein"""
        fb = self._frame_bytes
        ch = self.REQUESTED_CHANNELS
        ts = (tail_total_frames - xfade_frames) * fb
        tail_b = tail_pcm[ts: tail_total_frames * fb]
        hs = head_start_frame * fb
        head_b = head_pcm[hs: hs + xfade_frames * fb]
        t_arr = array.array("h"); t_arr.frombytes(tail_b)
        h_arr = array.array("h"); h_arr.frombytes(head_b)
        if sys.byteorder != "little":
            t_arr.byteswap(); h_arr.byteswap()
        mixed = array.array("h", [0] * (xfade_frames * ch))
        for i in range(xfade_frames):
            og = out_g[i]; ig = in_g[i]; base = i * ch
            for c in range(ch):
                v = int(t_arr[base + c] * og + h_arr[base + c] * ig)
                mixed[base + c] = 32767 if v > 32767 else -32768 if v < -32768 else v
        if sys.byteorder != "little":
            mixed.byteswap()
        return mixed.tobytes()

    def _apply_fade_out(self, pcm_bytes: bytes, fade_seconds: float) -> bytes:
        """对 PCM 尾部应用余弦淡出"""
        fb = self._frame_bytes
        ch = self.REQUESTED_CHANNELS
        total_frames = len(pcm_bytes) // fb
        fade_frames = int(min(fade_seconds, total_frames / self.REQUESTED_RATE) * self.REQUESTED_RATE)
        if fade_frames <= 0:
            return pcm_bytes
        fade_gains = _cosine_fade_table(fade_frames)
        if not fade_gains:
            return pcm_bytes
        samples = array.array("h"); samples.frombytes(pcm_bytes)
        if sys.byteorder != "little":
            samples.byteswap()
        fade_start = total_frames - fade_frames
        for i in range(fade_frames):
            g = fade_gains[i]; base = (fade_start + i) * ch
            for c in range(ch):
                samples[base + c] = int(samples[base + c] * g)
        if sys.byteorder != "little":
            samples.byteswap()
        return samples.tobytes()

    def _pcm_intro_loop_stream(self, intro_pcm: bytes, main_pcm: bytes,
                               token: PlaybackToken, xfade_frames: int):
        """★ intro 播放一次 → 无缝交叉淡化 → main 无限循环"""
        fb = self._frame_bytes
        intro_frames = len(intro_pcm) // fb
        main_frames = len(main_pcm) // fb
        if intro_frames <= 0 or main_frames <= 0:
            framecount = yield b""
            return

        xf = min(xfade_frames, intro_frames // 4, main_frames // 4)
        if xf < 1:
            xf = 0

        # 构建交叉淡化缓冲区
        if xf > 0:
            out_g, in_g = _raised_cosine_crossfade_gains(xf)
            i2m = self._build_xfade_buffer(intro_pcm, intro_frames, main_pcm, 0, xf, out_g, in_g)
            m2m = self._build_xfade_buffer(main_pcm, main_frames, main_pcm, 0, xf, out_g, in_g)
        else:
            i2m = b""
            m2m = b""

        # 构建片段序列
        intro_segs = []
        ib = intro_pcm[: (intro_frames - xf) * fb] if xf > 0 else intro_pcm
        if ib:
            intro_segs.append(ib)
        if i2m:
            intro_segs.append(i2m)

        loop_segs = []
        mb = main_pcm[xf * fb: (main_frames - xf) * fb] if xf > 0 else main_pcm
        if mb:
            loop_segs.append(mb)
        if m2m:
            loop_segs.append(m2m)

        if not loop_segs:
            framecount = yield b""
            return

        cur_segs = intro_segs if intro_segs else loop_segs
        in_loop = not intro_segs
        seg_idx = 0
        pos = 0
        framecount = yield b""
        while True:
            if token.stopped:
                return
            want = int(framecount) if framecount else 0
            if want <= 0:
                framecount = yield b""
                continue
            out = bytearray(want * fb)
            filled = 0
            while filled < want:
                if token.stopped:
                    return
                seg = cur_segs[seg_idx]
                sf = len(seg) // fb
                take = min(sf - pos, want - filled)
                s = pos * fb
                out[filled * fb: (filled + take) * fb] = seg[s: s + take * fb]
                filled += take
                pos += take
                if pos >= sf:
                    pos = 0
                    seg_idx += 1
                    if seg_idx >= len(cur_segs):
                        if not in_loop:
                            in_loop = True
                            cur_segs = loop_segs
                        seg_idx = 0
            token.touch()
            framecount = yield bytes(out)

    def _pcm_intro_nloop_stream(self, intro_pcm: bytes, main_pcm: bytes,
                                loop_times: int, token: PlaybackToken,
                                xfade_frames: int, final_fade_seconds: float):
        """★ intro 播放一次 → main 播放 loop_times 次（含交叉淡化和尾部淡出）"""
        fb = self._frame_bytes
        intro_frames = len(intro_pcm) // fb
        main_frames = len(main_pcm) // fb
        if main_frames <= 0 or loop_times <= 0:
            framecount = yield b""
            return

        # intro 为空时跳过前奏
        has_intro = intro_frames > 0

        if has_intro:
            xf = min(xfade_frames, intro_frames // 4, main_frames // 4)
        else:
            xf = min(xfade_frames, main_frames // 4)
        if xf < 1:
            xf = 0

        if xf > 0:
            out_g, in_g = _raised_cosine_crossfade_gains(xf)
            i2m = self._build_xfade_buffer(intro_pcm, intro_frames, main_pcm, 0, xf, out_g, in_g) if has_intro else b""
            m2m = self._build_xfade_buffer(main_pcm, main_frames, main_pcm, 0, xf, out_g, in_g)
        else:
            i2m = b""
            m2m = b""

        # 主循环体（去头去尾 / 去头保尾）
        main_body_short = main_pcm[xf * fb: (main_frames - xf) * fb] if xf > 0 else main_pcm
        main_body_full = main_pcm[xf * fb:] if xf > 0 else main_pcm

        # 最后一段带淡出
        try:
            fos = float(final_fade_seconds or 0)
        except Exception:
            fos = 0.0
        main_body_last = self._apply_fade_out(main_body_full, fos) if fos > 0 else main_body_full

        # 组装完整片段序列
        segments = []
        if has_intro:
            ib = intro_pcm[: (intro_frames - xf) * fb] if xf > 0 else intro_pcm
            if ib:
                segments.append(ib)
            if i2m:
                segments.append(i2m)

        for i in range(loop_times):
            is_last = (i == loop_times - 1)
            if is_last:
                segments.append(main_body_last)
            else:
                segments.append(main_body_short)
                if m2m:
                    segments.append(m2m)

        # 播放
        seg_idx = 0
        pos = 0
        framecount = yield b""
        while seg_idx < len(segments):
            if token.stopped:
                return
            want = int(framecount) if framecount else 0
            if want <= 0:
                framecount = yield b""
                continue
            out = bytearray(want * fb)
            filled = 0
            while filled < want and seg_idx < len(segments):
                if token.stopped:
                    return
                seg = segments[seg_idx]
                sf = len(seg) // fb
                take = min(sf - pos, want - filled)
                s = pos * fb
                out[filled * fb: (filled + take) * fb] = seg[s: s + take * fb]
                filled += take
                pos += take
                if pos >= sf:
                    pos = 0
                    seg_idx += 1
            token.touch()
            framecount = yield bytes(out)

    def _pcm_loop_stream(self, pcm_bytes: bytes, token: PlaybackToken, xfade_frames: int = 0):
        total_frames = len(pcm_bytes) // self._frame_bytes
        if total_frames <= 0:
            framecount = yield b""
            return
        if xfade_frames < 0 or xfade_frames * 2 >= total_frames:
            xfade_frames = 0

        pos = 0
        framecount = yield b""
        while True:
            if token.stopped:
                return
            want = int(framecount) if framecount else 0
            if want <= 0:
                framecount = yield b""
                continue
            out = bytearray(want * self._frame_bytes)
            filled = 0
            while filled < want:
                if token.stopped:
                    return
                remain_seg = total_frames - pos
                take = min(remain_seg, want - filled)
                s = pos * self._frame_bytes
                e = s + take * self._frame_bytes
                out[filled * self._frame_bytes:(filled + take) * self._frame_bytes] = pcm_bytes[s:e]
                filled += take
                pos += take
                if pos >= total_frames:
                    pos = xfade_frames if xfade_frames > 0 else 0
            token.touch()  # ★ 证明设备仍在拉取数据
            framecount = yield bytes(out)

    def _pcm_nloop_stream(self, pcm_bytes: bytes, loop_times: int, token: PlaybackToken, between_loop_crossfade_ms: float, final_fade_seconds: float):
        total_frames = len(pcm_bytes) // self._frame_bytes
        if total_frames <= 0 or loop_times <= 0:
            framecount = yield b""
            return

        try:
            xms = float(between_loop_crossfade_ms or 0.0)
        except Exception:
            xms = 0.0

        xfade_frames = 0
        mixed_xfade_bytes = b""
        if loop_times > 1 and xms > 0.0:
            xfade_frames = int((xms / 1000.0) * self.REQUESTED_RATE)
            if xfade_frames > 0 and xfade_frames * 2 < total_frames:
                out_g, in_g = _raised_cosine_crossfade_gains(xfade_frames)
                if out_g:
                    head_b = pcm_bytes[: xfade_frames * self._frame_bytes]
                    tail_b = pcm_bytes[(total_frames - xfade_frames) * self._frame_bytes : total_frames * self._frame_bytes]
                    head_s = array.array("h"); tail_s = array.array("h")
                    head_s.frombytes(head_b); tail_s.frombytes(tail_b)
                    if sys.byteorder != "little":
                        head_s.byteswap(); tail_s.byteswap()

                    ch = self.REQUESTED_CHANNELS
                    mixed = array.array("h", [0] * (xfade_frames * ch))
                    for i in range(xfade_frames):
                        og = out_g[i]; ig = in_g[i]
                        base = i * ch
                        for c in range(ch):
                            v = int(tail_s[base + c] * og + head_s[base + c] * ig)
                            v = 32767 if v > 32767 else -32768 if v < -32768 else v
                            mixed[base + c] = v
                    if sys.byteorder != "little":
                        mixed.byteswap()
                    mixed_xfade_bytes = mixed.tobytes()
            else:
                xfade_frames = 0

        try:
            fos = float(final_fade_seconds or 0.0)
        except Exception:
            fos = 0.0
        fos = max(0.0, fos)
        fade_frames = int(min(fos, total_frames / self.REQUESTED_RATE) * self.REQUESTED_RATE) if fos > 0 else 0
        fade_start = total_frames - fade_frames
        fade_gains = _cosine_fade_table(fade_frames) if fade_frames > 0 else None

        loops_left = int(loop_times)
        pos = 0
        mix_pos = -1

        framecount = yield b""
        while True:
            if token.stopped:
                return

            want_total = int(framecount) if framecount else 0
            if want_total <= 0:
                framecount = yield b""
                continue

            out = bytearray(want_total * self._frame_bytes)
            filled = 0
            while filled < want_total and loops_left > 0:
                if token.stopped:
                    return

                if mix_pos >= 0:
                    remain_mix = xfade_frames - mix_pos
                    take = min(remain_mix, want_total - filled)
                    sb = mix_pos * self._frame_bytes
                    eb = sb + take * self._frame_bytes
                    out[filled * self._frame_bytes:(filled + take) * self._frame_bytes] = mixed_xfade_bytes[sb:eb]
                    mix_pos += take
                    filled += take
                    if mix_pos >= xfade_frames:
                        loops_left -= 1
                        if loops_left <= 0:
                            break
                        pos = xfade_frames if xfade_frames > 0 else 0
                        mix_pos = -1
                    continue

                is_last_loop = (loops_left == 1)
                normal_end = (total_frames - xfade_frames) if ((not is_last_loop) and (xfade_frames > 0)) else total_frames

                if pos >= normal_end:
                    if (not is_last_loop) and (xfade_frames > 0) and mixed_xfade_bytes:
                        mix_pos = 0
                        continue
                    loops_left -= 1
                    if loops_left <= 0:
                        break
                    pos = 0
                    continue

                take = min(normal_end - pos, want_total - filled)
                sb = pos * self._frame_bytes
                eb = sb + take * self._frame_bytes
                chunk = pcm_bytes[sb:eb]

                if is_last_loop and fade_frames > 0 and (pos + take) > fade_start:
                    chunk = self._apply_fadeout_to_chunk_s16(chunk, take, pos, fade_start, fade_frames, fade_gains)

                out[filled * self._frame_bytes:(filled + take) * self._frame_bytes] = chunk
                pos += take
                filled += take

            if loops_left <= 0 and filled <= 0:
                return

            token.touch()  # ★ 证明设备仍在拉取数据
            framecount = yield bytes(out)

    def _register_token(self, token: PlaybackToken):
        with self._tokens_lock:
            self._active_tokens.add(token)

    def _unregister_token(self, token: PlaybackToken):
        with self._tokens_lock:
            self._active_tokens.discard(token)

    def _play_sound_worker(self, file_path, play_range, fade_out_seconds, loop, trim_silence, token: PlaybackToken, loop_crossfade_ms: float):
        device = None
        decoder = None
        try:
            if not os.path.exists(file_path):
                self._log(f"【!!】 文件不存在: {file_path}")
                return

            info = miniaudio.get_file_info(file_path)
            file_duration = float(info.duration or 0.0)
            if file_duration <= 0:
                return

            if play_range is None:
                start_s, end_s = 0.0, file_duration
            else:
                start_s, end_s = float(play_range[0]), float(play_range[1])

            start_s = max(0.0, start_s)
            end_s = min(file_duration, end_s)
            if end_s <= start_s:
                return

            rate = self.REQUESTED_RATE
            start_frame = int(start_s * rate)
            end_frame = int(end_s * rate)

            if trim_silence and not token.stopped:
                start_frame, end_frame = self._trim_silence_edges(file_path, start_frame, end_frame, token)

            if token.stopped:
                return
            seg_frames = end_frame - start_frame
            if seg_frames <= 0:
                return
            seg_duration = seg_frames / float(rate)

            if loop:
                if seg_duration <= LOOP_PREDECODE_MAX_SECONDS:
                    pcm, xfade_frames = self._get_pcm_cached_or_decode(file_path, start_frame, end_frame, token, loop_crossfade_ms)
                    if token.stopped or not pcm:
                        return
                    stream = self._pcm_loop_stream(pcm, token, xfade_frames=xfade_frames)
                    stream.send(None)
                    device = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                    device.start(stream)
                    token.touch()  # ★ 重置计时器
                    while not token.stopped:
                        time.sleep(0.1)
                        # ★ 检测设备是否已死（屏保/音频设备切换等场景）
                        if token.device_silent_seconds() > 3.0:
                            self._log_critical("【!!】 loop: 音频设备停止响应（>3s无数据拉取），可能因屏保/设备切换")
                            if self._on_device_lost:
                                try: self._on_device_lost()
                                except Exception: pass
                            # ★ 异步销毁旧设备（stop可能阻塞）
                            if device:
                                self._kill_device_async(device)
                            device = None
                            # ★ 渐进退避重试，直到设备恢复或被停止
                            backoff = 0.5
                            recovered = False
                            retry_n = 0
                            while not token.stopped:
                                time.sleep(backoff)
                                if token.stopped:
                                    return
                                retry_n += 1
                                try:
                                    stream = self._pcm_loop_stream(pcm, token, xfade_frames=xfade_frames)
                                    stream.send(None)
                                    device = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                                    device.start(stream)
                                    # 不手动 touch — 让设备真正拉取数据来证明自己
                                    time.sleep(2.0)
                                    silent = token.device_silent_seconds()
                                    if silent < 1.5:
                                        self._log_critical(f"【OK】 loop: 设备恢复成功（第{retry_n}次尝试，退避{backoff:.1f}s，silent={silent:.2f}s）")
                                        recovered = True
                                        break
                                    else:
                                        self._log_critical(f"【??】 loop: 设备已创建但未拉取数据（silent={silent:.2f}s），继续重试")
                                        self._kill_device_async(device)
                                        device = None
                                except Exception as e:
                                    if retry_n <= 2:
                                        self._log_critical(f"【!!】 loop: 恢复第{retry_n}次失败: {e}")
                                backoff = min(backoff * 2, 30.0)
                            if not recovered:
                                return
                    return

                while not token.stopped:
                    decoder = miniaudio.stream_file(file_path, output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                    if start_frame > 0 and (not self._skip_frames(decoder, start_frame, token)):
                        return
                    stream = self._segment_stream_from_here(decoder, seg_frames, fade_frames=0, token=token)
                    stream.send(None)
                    device = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                    device.start(stream)
                    token.touch()  # ★ 重置计时器
                    t_end = time.time() + seg_duration + 0.25
                    device_dead = False
                    while (time.time() < t_end) and (not token.stopped):
                        time.sleep(0.05)
                        # ★ 检测设备是否已死
                        if token.device_silent_seconds() > 3.0:
                            self._log_critical("【!!】 streaming loop: 音频设备停止响应，中断当前段")
                            device_dead = True
                            break
                    # ★ 清理设备：设备死亡时异步销毁（stop可能阻塞），正常结束时同步
                    if device:
                        if device_dead:
                            self._kill_device_async(device)
                        else:
                            try: device.stop()
                            except Exception: pass
                            try: device.close()
                            except Exception: pass
                    device = None
                    try: decoder.close()
                    except Exception: pass
                    decoder = None
                    # ★ 如果设备死了，渐进退避等待系统音频恢复
                    if device_dead:
                        if self._on_device_lost:
                            try: self._on_device_lost()
                            except: pass
                        self._log_critical("【!!】 streaming loop: 设备停止响应，等待恢复")
                        backoff = 0.5
                        retry_n = 0
                        while not token.stopped:
                            time.sleep(backoff)
                            if token.stopped:
                                return
                            # 尝试创建设备验证是否恢复
                            retry_n += 1
                            try:
                                test_dev = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                                test_dev.close()
                                self._log_critical(f"【OK】 streaming loop: 设备恢复（第{retry_n}次，退避{backoff:.1f}s）")
                                break
                            except Exception as e:
                                if retry_n <= 2:
                                    self._log_critical(f"【!!】 streaming loop: 恢复第{retry_n}次失败: {e}")
                            backoff = min(backoff * 2, 30.0)
                        token.touch()  # 重置计时器给下一次循环机会
                return

            fos = max(0.0, min(float(fade_out_seconds or 0.0), seg_duration))
            fade_frames = int(fos * rate)

            decoder = miniaudio.stream_file(file_path, output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
            if start_frame > 0 and (not self._skip_frames(decoder, start_frame, token)):
                return
            stream = self._segment_stream_from_here(decoder, seg_frames, fade_frames=fade_frames, token=token)
            stream.send(None)

            device = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
            device.start(stream)

            token.touch()  # ★ 重置计时器
            t_end = time.time() + seg_duration + 0.25
            while (time.time() < t_end) and (not token.stopped):
                time.sleep(0.05)
                # ★ 检测设备是否已死（单次播放直接退出即可）
                if token.device_silent_seconds() > 3.0:
                    self._log("【!!】 单次播放: 音频设备停止响应，结束播放")
                    break

        except Exception:
            self._log("【!!】 音频播放失败:")
            self._log(traceback.format_exc())
        finally:
            if device:
                self._kill_device_async(device)
            if decoder:
                try: decoder.close()
                except Exception: pass

    def _play_sound_worker_loops(self, file_path, play_range, loop_times: int, final_fade_seconds: float, trim_silence: bool, token: PlaybackToken, between_loop_crossfade_ms: float):
        device = None
        decoder = None
        try:
            if not os.path.exists(file_path):
                return
            info = miniaudio.get_file_info(file_path)
            file_duration = float(info.duration or 0.0)
            if file_duration <= 0:
                return

            if play_range is None:
                start_s, end_s = 0.0, file_duration
            else:
                start_s, end_s = float(play_range[0]), float(play_range[1])

            start_s = max(0.0, start_s)
            end_s = min(file_duration, end_s)
            if end_s <= start_s:
                return

            loop_times = int(loop_times or 1)
            if loop_times <= 0:
                return

            rate = self.REQUESTED_RATE
            start_frame = int(start_s * rate)
            end_frame = int(end_s * rate)

            if trim_silence and not token.stopped:
                start_frame, end_frame = self._trim_silence_edges(file_path, start_frame, end_frame, token)
            if token.stopped:
                return

            seg_frames = end_frame - start_frame
            if seg_frames <= 0:
                return
            seg_duration = seg_frames / float(rate)

            if seg_duration <= LOOP_PREDECODE_MAX_SECONDS:
                pcm, _ = self._get_pcm_cached_or_decode(file_path, start_frame, end_frame, token, crossfade_ms=0.0)
                if token.stopped or not pcm:
                    return

                stream = self._pcm_nloop_stream(
                    pcm_bytes=pcm, loop_times=loop_times, token=token,
                    between_loop_crossfade_ms=between_loop_crossfade_ms,
                    final_fade_seconds=final_fade_seconds
                )
                stream.send(None)
                device = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                device.start(stream)

                xfade_frames = 0
                if loop_times > 1:
                    xms = float(between_loop_crossfade_ms or 0.0)
                    if xms > 0:
                        xfade_frames = int((xms / 1000.0) * rate)
                        if xfade_frames * 2 >= seg_frames:
                            xfade_frames = 0

                total_out_frames = seg_frames + (loop_times - 1) * (seg_frames - xfade_frames) if (loop_times > 1 and xfade_frames > 0) else seg_frames * loop_times
                total_out_sec = total_out_frames / float(rate)
                token.touch()  # ★ 重置计时器
                t_end = time.time() + total_out_sec + 0.25
                while (time.time() < t_end) and (not token.stopped):
                    time.sleep(0.05)
                    # ★ 检测设备是否已死
                    if token.device_silent_seconds() > 3.0:
                        self._log_critical("【!!】 nloop: 音频设备停止响应（>3s无数据拉取）")
                        if self._on_device_lost:
                            try: self._on_device_lost()
                            except Exception: pass
                        # ★ 异步销毁旧设备（stop可能阻塞）
                        if device:
                            self._kill_device_async(device)
                        device = None
                        # ★ 渐进退避重试
                        backoff = 0.5
                        recovered = False
                        retry_n = 0
                        while not token.stopped:
                            time.sleep(backoff)
                            if token.stopped:
                                return
                            remaining_sec = max(0, t_end - time.time())
                            if remaining_sec <= 0.5:
                                return
                            retry_n += 1
                            try:
                                remaining_loops = max(1, int(remaining_sec / seg_duration))
                                new_stream = self._pcm_nloop_stream(
                                    pcm_bytes=pcm, loop_times=remaining_loops, token=token,
                                    between_loop_crossfade_ms=between_loop_crossfade_ms,
                                    final_fade_seconds=final_fade_seconds
                                )
                                new_stream.send(None)
                                device = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                                device.start(new_stream)
                                time.sleep(2.0)
                                silent = token.device_silent_seconds()
                                if silent < 1.5:
                                    t_end = time.time() + remaining_sec
                                    self._log_critical(f"【OK】 nloop: 设备恢复，继续约{remaining_sec:.1f}s（第{retry_n}次，silent={silent:.2f}s）")
                                    recovered = True
                                    break
                                else:
                                    self._log_critical(f"【??】 nloop: 设备已创建但未拉取数据（silent={silent:.2f}s），继续重试")
                                    self._kill_device_async(device)
                                    device = None
                            except Exception as e:
                                if retry_n <= 2:
                                    self._log_critical(f"【!!】 nloop: 恢复第{retry_n}次失败: {e}")
                            backoff = min(backoff * 2, 30.0)
                        if not recovered:
                            return
                return

            for i in range(loop_times):
                if token.stopped:
                    return
                is_last = (i == loop_times - 1)
                fos = float(final_fade_seconds or 0.0) if is_last else 0.0
                fos = max(0.0, min(fos, seg_duration))
                fade_frames = int(fos * rate)

                decoder = miniaudio.stream_file(file_path, output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                if start_frame > 0 and (not self._skip_frames(decoder, start_frame, token)):
                    return

                stream = self._segment_stream_from_here(decoder, seg_frames, fade_frames=fade_frames, token=token)
                stream.send(None)
                device = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                device.start(stream)

                token.touch()  # ★ 重置计时器
                t_end = time.time() + seg_duration + 0.25
                device_dead = False
                while (time.time() < t_end) and (not token.stopped):
                    time.sleep(0.05)
                    # ★ 检测设备是否已死
                    if token.device_silent_seconds() > 3.0:
                        self._log_critical(f"【!!】 streaming循环第{i+1}/{loop_times}: 音频设备停止响应")
                        device_dead = True
                        break

                # ★ 清理设备：设备死亡时异步销毁（stop可能阻塞），正常结束时同步
                if device:
                    if device_dead:
                        self._kill_device_async(device)
                    else:
                        try: device.stop()
                        except Exception: pass
                        try: device.close()
                        except Exception: pass
                device = None
                try: decoder.close()
                except Exception: pass
                decoder = None
                # ★ 如果设备死了，渐进退避等待恢复
                if device_dead:
                    if self._on_device_lost:
                        try: self._on_device_lost()
                        except: pass
                    self._log_critical(f"【!!】 streaming nloop 第{i+1}/{loop_times}: 设备停止响应，等待恢复")
                    backoff = 0.5
                    retry_n = 0
                    while not token.stopped:
                        time.sleep(backoff)
                        if token.stopped:
                            return
                        retry_n += 1
                        try:
                            test_dev = self.PlaybackDevice(output_format=self.REQUESTED_FORMAT, nchannels=self.REQUESTED_CHANNELS, sample_rate=self.REQUESTED_RATE)
                            test_dev.close()
                            self._log_critical(f"【OK】 streaming nloop: 设备恢复（第{retry_n}次，退避{backoff:.1f}s）")
                            break
                        except Exception as e:
                            if retry_n <= 2:
                                self._log_critical(f"【!!】 streaming nloop: 恢复第{retry_n}次失败: {e}")
                        backoff = min(backoff * 2, 30.0)
                    token.touch()

        except Exception:
            self._log("【!!】 音频播放失败:")
            self._log(traceback.format_exc())
        finally:
            if device:
                self._kill_device_async(device)
            if decoder:
                try: decoder.close()
                except Exception: pass

    def _play_wrapper(self, file_path, play_range, fade_out_seconds, loop, trim_silence, token: PlaybackToken, loop_crossfade_ms: float):
        try:
            self._play_sound_worker(file_path, play_range, fade_out_seconds, loop, trim_silence, token, loop_crossfade_ms)
        finally:
            self._unregister_token(token)

    def _play_wrapper_loops(self, file_path, play_range, loop_times, final_fade_seconds, trim_silence, token: PlaybackToken, between_loop_crossfade_ms: float):
        try:
            self._play_sound_worker_loops(file_path, play_range, loop_times, final_fade_seconds, trim_silence, token, between_loop_crossfade_ms)
        finally:
            self._unregister_token(token)

    def play_sound_file(self, file_path, play_range=None, fade_out_seconds=0.0, loop=False, trim_silence=True, loop_crossfade_ms=None):
        if loop_crossfade_ms is None:
            loop_crossfade_ms = LOOP_CROSSFADE_MS_DEFAULT
        token = PlaybackToken()
        self._register_token(token)
        self.executor.submit(self._play_wrapper, file_path, play_range, fade_out_seconds, loop, trim_silence, token, float(loop_crossfade_ms or 0.0))
        return token

    def play_sound_file_loops(self, file_path, loop_times: int, final_fade_seconds: float, play_range=None, trim_silence=True, between_loop_crossfade_ms=None):
        if between_loop_crossfade_ms is None:
            between_loop_crossfade_ms = LOOP_CROSSFADE_MS_DEFAULT
        token = PlaybackToken()
        self._register_token(token)
        self.executor.submit(
            self._play_wrapper_loops,
            file_path, play_range, int(loop_times), float(final_fade_seconds or 0.0),
            bool(trim_silence), token, float(between_loop_crossfade_ms or 0.0),
        )
        return token

    def az(self, file_path: str, loop_times: int, final_fade_seconds: float, trim_silence: bool = True):
        return self.play_sound_file_loops(
            file_path=file_path,
            loop_times=loop_times,
            final_fade_seconds=final_fade_seconds,
            play_range=None,
            trim_silence=bool(trim_silence),
            between_loop_crossfade_ms=LOOP_CROSSFADE_MS_DEFAULT,
        )

    # =========================================================================
    #  ★ play_with_intro: 前奏 + 主文件无缝播放
    # =========================================================================

    def _play_intro_worker(self, intro_path: str, main_path: str, loop: bool,
                           loop_times: int, final_fade_seconds: float,
                           trim_silence: bool, token: PlaybackToken,
                           crossfade_ms: float):
        """★ 播放前奏一次，然后无缝过渡到主文件循环/N次播放"""
        device = None
        try:
            for fp in (intro_path, main_path):
                if not os.path.exists(fp):
                    self._log(f"【!!】 文件不存在: {fp}")
                    return

            rate = self.REQUESTED_RATE

            # 解码 intro
            info_i = miniaudio.get_file_info(intro_path)
            dur_i = float(info_i.duration or 0)
            if dur_i <= 0:
                return
            sf_i, ef_i = 0, int(dur_i * rate)
            if trim_silence and not token.stopped:
                sf_i, ef_i = self._trim_silence_edges(intro_path, sf_i, ef_i, token)
            if token.stopped:
                return
            intro_pcm, _ = self._get_pcm_cached_or_decode(intro_path, sf_i, ef_i, token, crossfade_ms=0.0)
            if token.stopped or not intro_pcm:
                return

            # 解码 main
            info_m = miniaudio.get_file_info(main_path)
            dur_m = float(info_m.duration or 0)
            if dur_m <= 0:
                return
            sf_m, ef_m = 0, int(dur_m * rate)
            if trim_silence and not token.stopped:
                sf_m, ef_m = self._trim_silence_edges(main_path, sf_m, ef_m, token)
            if token.stopped:
                return
            main_pcm, _ = self._get_pcm_cached_or_decode(main_path, sf_m, ef_m, token, crossfade_ms=0.0)
            if token.stopped or not main_pcm:
                return

            # 交叉淡化帧数
            try:
                xms = float(crossfade_ms or 0)
            except Exception:
                xms = 0.0
            xfade_frames = int((xms / 1000.0) * rate) if xms > 0 else 0

            fb = self._frame_bytes

            if loop:
                # ★ 无限循环模式
                stream = self._pcm_intro_loop_stream(intro_pcm, main_pcm, token, xfade_frames)
                stream.send(None)
                device = self.PlaybackDevice(
                    output_format=self.REQUESTED_FORMAT,
                    nchannels=self.REQUESTED_CHANNELS,
                    sample_rate=self.REQUESTED_RATE)
                device.start(stream)
                token.touch()

                while not token.stopped:
                    time.sleep(0.1)
                    if token.device_silent_seconds() > 3.0:
                        self._log_critical("【!!】 intro+loop: 音频设备停止响应")
                        if self._on_device_lost:
                            try:
                                self._on_device_lost()
                            except Exception:
                                pass
                        # ★ 异步销毁旧设备（stop可能阻塞）
                        if device:
                            self._kill_device_async(device)
                        device = None
                        # ★ 渐进退避重试，直到设备恢复或被停止
                        backoff = 0.5
                        recovered = False
                        retry_n = 0
                        while not token.stopped:
                            time.sleep(backoff)
                            if token.stopped:
                                return
                            retry_n += 1
                            try:
                                # ★ 直接复用已解码的 main_pcm + 本地交叉淡化
                                # 不调用 _get_pcm_cached_or_decode — 避免 miniaudio 内部锁死锁
                                main_pcm_xf, mxf = self._prepare_pcm_loop_crossfade(main_pcm, xms)
                                stream = self._pcm_loop_stream(main_pcm_xf, token, xfade_frames=mxf)
                                stream.send(None)
                                device = self.PlaybackDevice(
                                    output_format=self.REQUESTED_FORMAT,
                                    nchannels=self.REQUESTED_CHANNELS,
                                    sample_rate=self.REQUESTED_RATE)
                                device.start(stream)
                                time.sleep(2.0)
                                silent = token.device_silent_seconds()
                                if silent < 1.5:
                                    self._log_critical(f"【OK】 intro+loop: 设备恢复（第{retry_n}次，silent={silent:.2f}s）")
                                    recovered = True
                                    break
                                else:
                                    self._log_critical(f"【??】 intro+loop: 设备已创建但未拉取数据（silent={silent:.2f}s），继续重试")
                                    self._kill_device_async(device)
                                    device = None
                            except Exception as e:
                                if retry_n <= 2:
                                    self._log_critical(f"【!!】 intro+loop: 恢复第{retry_n}次失败: {e}")
                            backoff = min(backoff * 2, 30.0)
                        if not recovered:
                            return
            else:
                # ★ N 次循环模式
                stream = self._pcm_intro_nloop_stream(
                    intro_pcm, main_pcm, loop_times, token, xfade_frames, final_fade_seconds)
                stream.send(None)
                device = self.PlaybackDevice(
                    output_format=self.REQUESTED_FORMAT,
                    nchannels=self.REQUESTED_CHANNELS,
                    sample_rate=self.REQUESTED_RATE)
                device.start(stream)

                # 计算总时长（估算）
                intro_f = len(intro_pcm) // fb
                main_f = len(main_pcm) // fb
                xf = min(xfade_frames, intro_f // 4, main_f // 4) if xfade_frames > 0 else 0
                # intro_body + i2m_xfade + (main_body_short + m2m_xfade)*(N-1) + main_body_last
                if loop_times > 1 and xf > 0:
                    total_f = (intro_f - xf) + xf + (main_f - 2 * xf + xf) * (loop_times - 1) + (main_f - xf)
                else:
                    total_f = intro_f + main_f * loop_times
                total_sec = total_f / float(rate)

                token.touch()
                t_end = time.time() + total_sec + 0.5
                while (time.time() < t_end) and (not token.stopped):
                    time.sleep(0.05)
                    if token.device_silent_seconds() > 3.0:
                        self._log_critical("【!!】 intro+nloop: 音频设备停止响应")
                        if self._on_device_lost:
                            try:
                                self._on_device_lost()
                            except Exception:
                                pass
                        # ★ 异步销毁旧设备（stop可能阻塞）
                        if device:
                            self._kill_device_async(device)
                        device = None
                        # ★ 渐进退避重试
                        backoff = 0.5
                        recovered = False
                        retry_n = 0
                        while not token.stopped:
                            time.sleep(backoff)
                            if token.stopped:
                                return
                            remaining = max(0, t_end - time.time())
                            if remaining <= 0.5:
                                return
                            retry_n += 1
                            try:
                                rem_loops = max(1, int(remaining / (main_f / float(rate))))
                                rs = self._pcm_intro_nloop_stream(
                                    b"", main_pcm, rem_loops, token, xfade_frames, final_fade_seconds)
                                rs.send(None)
                                device = self.PlaybackDevice(
                                    output_format=self.REQUESTED_FORMAT,
                                    nchannels=self.REQUESTED_CHANNELS,
                                    sample_rate=self.REQUESTED_RATE)
                                device.start(rs)
                                time.sleep(2.0)
                                silent = token.device_silent_seconds()
                                if silent < 1.5:
                                    t_end = time.time() + remaining
                                    self._log_critical(f"【OK】 intro+nloop: 设备恢复（第{retry_n}次，silent={silent:.2f}s）")
                                    recovered = True
                                    break
                                else:
                                    self._log_critical(f"【??】 intro+nloop: 设备已创建但未拉取数据（silent={silent:.2f}s），继续重试")
                                    self._kill_device_async(device)
                                    device = None
                            except Exception as e:
                                if retry_n <= 2:
                                    self._log_critical(f"【!!】 intro+nloop: 恢复第{retry_n}次失败: {e}")
                            backoff = min(backoff * 2, 30.0)
                        if not recovered:
                            return
        finally:
            if device:
                self._kill_device_async(device)

    def _play_wrapper_intro(self, intro_path, main_path, loop, loop_times,
                            final_fade_seconds, trim_silence, token, crossfade_ms):
        try:
            self._play_intro_worker(intro_path, main_path, loop, loop_times,
                                    final_fade_seconds, trim_silence, token, crossfade_ms)
        finally:
            self._unregister_token(token)

    def play_with_intro(self, intro_path: str, main_path: str,
                        loop: bool = False, loop_times: int = 1,
                        final_fade_seconds: float = 0.0,
                        trim_silence: bool = True,
                        crossfade_ms: float = None):
        """★ 播放前奏一次，然后无缝过渡到主文件循环/N次播放"""
        if crossfade_ms is None:
            crossfade_ms = LOOP_CROSSFADE_MS_DEFAULT
        token = PlaybackToken()
        self._register_token(token)
        self.executor.submit(
            self._play_wrapper_intro,
            intro_path, main_path, bool(loop), int(loop_times),
            float(final_fade_seconds or 0.0), bool(trim_silence),
            token, float(crossfade_ms or 0.0),
        )
        return token

    def az_with_intro(self, intro_path: str, main_path: str,
                      loop_times: int, final_fade_seconds: float,
                      trim_silence: bool = True):
        """★ 便捷方法：前奏 + 主文件 N 次循环"""
        return self.play_with_intro(
            intro_path=intro_path, main_path=main_path,
            loop=False, loop_times=loop_times,
            final_fade_seconds=final_fade_seconds,
            trim_silence=trim_silence,
            crossfade_ms=LOOP_CROSSFADE_MS_DEFAULT,
        )

    # ================================================================
    #  HLS Radio Playback
    # ================================================================

    def play_radio_hls(self, m3u8_url: str):
        """★ 接入 HLS 网络电台流并播放（非阻塞）"""
        token = PlaybackToken()
        self._register_token(token)
        self.executor.submit(self._radio_hls_wrapper, m3u8_url, token)
        return token

    def play_radio_stream(self, stream_url: str, live_check=None):
        """★ 接入直推流电台（单 HTTP 连接持续接收 MP3 字节，替代 HLS）
        live_check: 可选 callable，返回 bool 表示电台当前是否在线。
            worker 在每次重连前调用，离线时跳过本轮直连尝试，避免死磕已下线滴 URL。"""
        token = PlaybackToken()
        self._register_token(token)
        self.executor.submit(self._radio_stream_wrapper, stream_url, token, live_check)
        return token

    def _radio_stream_wrapper(self, stream_url, token: PlaybackToken, live_check=None):
        try:
            self._radio_stream_worker(stream_url, token, live_check=live_check)
        finally:
            self._unregister_token(token)

    def _radio_stream_worker(self, stream_url, token: PlaybackToken, live_check=None):
        """直推流电台：使用自定义 StreamableSource + stream_any 实现
        单解码器实例连续解码整条 MP3 流，彻底消除段切换卡顿。
        架构：后台线程 HTTP 下载+缓冲 → stream_any 持久解码器 → device 回调消费。
        屏保恢复：原地重建设备，复用同一条 source_stream（零重连延迟）。"""
        device = None
        device_dead = False
        reconnect_delay = 3.0
        _consecutive_device_failures = 0  # ★ Track consecutive device-dead reconnects

        try:
            while not token.stopped:
                # ★ Skip retry when radio is offline (server-side live=False).
                # Avoids burning CPU/network/log on a known-dead URL after the radio
                # stops broadcasting (or after wake-from-sleep when URL may 404).
                if live_check is not None:
                    try:
                        if not live_check():
                            self._log_critical("[Radio] live=False, waiting 30s before recheck")
                            _wait_start = time.time()
                            while not token.stopped and (time.time() - _wait_start) < 30.0:
                                time.sleep(2.0)
                            continue
                    except Exception:
                        pass
                source = None
                try:
                    source = _RadioStreamSource(stream_url)

                    # stream_any：单解码器实例连续解码 MP3→PCM，零段边界
                    source_stream = miniaudio.stream_any(
                        source,
                        source_format=miniaudio.FileFormat.MP3,
                        output_format=self.REQUESTED_FORMAT,
                        nchannels=self.REQUESTED_CHANNELS,
                        sample_rate=self.REQUESTED_RATE,
                    )

                    gen_detach = threading.Event()
                    gen = self._radio_stream_gen(source_stream, token, detach=gen_detach)
                    next(gen)  # prime

                    # ★ Only reset reconnect_delay if last failure was NOT device-dead
                    if _consecutive_device_failures == 0:
                        reconnect_delay = 3.0

                    if device and device_dead:
                        self._kill_device_async(device)
                        device = None
                    device_dead = False

                    # ★ Device creation with timeout: PlaybackDevice() can hang
                    # indefinitely after wake-from-sleep when audio subsystem is
                    # still recovering. Without this guard, worker silently freezes.
                    _dev_result = [None]
                    _dev_error = [None]
                    def _create_main_dev():
                        try:
                            _dev_result[0] = self.PlaybackDevice(
                                output_format=self.REQUESTED_FORMAT,
                                nchannels=self.REQUESTED_CHANNELS,
                                sample_rate=self.REQUESTED_RATE,
                            )
                            _dev_result[0].start(gen)
                        except Exception as e:
                            _dev_error[0] = e
                    _dev_thread = threading.Thread(target=_create_main_dev, daemon=True)
                    _dev_thread.start()
                    _dev_thread.join(timeout=8.0)
                    if _dev_thread.is_alive():
                        self._log_critical("【!!】 Radio: main-path device creation timed out (8s), system likely asleep — reconnect")
                        _consecutive_device_failures += 1
                        device_dead = True
                        # leak the thread; it will finish or die when device finally responds
                        raise RuntimeError("main-path device creation timeout")
                    if _dev_error[0]:
                        raise _dev_error[0]
                    device = _dev_result[0]

                    # ★ Health check: confirm device is actually pulling data within 8s.
                    # Without this, a "zombie" device can be created (no errors) but
                    # never pull data, leaving worker stuck in monitor loop forever.
                    _health_deadline = time.time() + 8.0
                    _device_alive = False
                    while not token.stopped and time.time() < _health_deadline:
                        time.sleep(0.5)
                        if token.device_silent_seconds() < 1.5:
                            _device_alive = True
                            break
                    if not _device_alive and not token.stopped:
                        self._log_critical("【!!】 Radio: device created but no data pull within 8s — reconnect")
                        self._kill_device_async(device)
                        device = None
                        _consecutive_device_failures += 1
                        device_dead = True
                        raise RuntimeError("device zombie (no data)")

                    # 监控循环：检测设备静音/断流
                    _last_recovery_time = 0  # ★ Track rapid recovery cycling (screensaver scenario)
                    _rapid_recovery_count = 0  # ★ How many times we recovered within a short window
                    while not token.stopped:
                        time.sleep(0.5)
                        # ★ Device actively pulling data → it's healthy, reset failure counter
                        if _consecutive_device_failures > 0 and token.device_silent_seconds() < 1.0:
                            _consecutive_device_failures = 0
                        # ★ If device is healthy for >60s after a recovery, reset rapid counter
                        if _rapid_recovery_count > 0 and _last_recovery_time > 0 and (time.time() - _last_recovery_time) > 60:
                            _rapid_recovery_count = 0
                        if device and token.device_silent_seconds() > 5.0:
                            # ★ Anti-storm: if recovering too frequently (screensaver), wait before retrying
                            if _rapid_recovery_count > 0:
                                storm_wait = min(10.0 * _rapid_recovery_count, 120.0)
                                self._log_critical(f"[Radio] Screensaver storm detected (cycle #{_rapid_recovery_count}), waiting {storm_wait:.0f}s before recovery")
                                _storm_start = time.time()
                                while not token.stopped and (time.time() - _storm_start) < storm_wait:
                                    time.sleep(1.0)
                                    # ★ If device resumes pulling on its own (wake from sleep), cancel wait
                                    if token.device_silent_seconds() < 2.0:
                                        self._log_critical("[Radio] Device resumed during wait — system woke up")
                                        break
                                if token.stopped:
                                    break
                                # ★ Re-check: device might have woken up during wait
                                if token.device_silent_seconds() < 2.0:
                                    _rapid_recovery_count = 0
                                    continue
                            if self._on_device_lost:
                                try: self._on_device_lost()
                                except Exception: pass
                            # ★ 先通知旧 gen 脱离 source_stream，避免新旧竞争
                            gen_detach.set()
                            # ★ 异步销毁旧设备（stop 可能阻塞）
                            self._kill_device_async(device)
                            device = None

                            # ★ 判断流是否还活着：EOF = 流断了，直接全量重连
                            if source._eof:
                                self._log_critical("【!!】 Radio: stream EOF, skipping in-place → full-reconnect")
                                device_dead = True
                                break

                            # ★ 流还活着（屏保场景）→ 原地恢复，最多 3 次
                            self._log_critical("【!!】 Radio: device silent >5s, source alive → in-place recovery")
                            backoff = 0.5
                            recovered = False
                            retry_n = 0
                            while not token.stopped and retry_n < 3:
                                time.sleep(backoff)
                                if token.stopped:
                                    break
                                retry_n += 1
                                try:
                                    gen_detach = threading.Event()
                                    gen = self._radio_stream_gen(source_stream, token, already_primed=True, detach=gen_detach)
                                    next(gen)  # prime wrapper
                                    # ★ Device creation with timeout: PlaybackDevice() can hang during screensaver/sleep
                                    _dev_result = [None]
                                    _dev_error = [None]
                                    def _create_dev():
                                        try:
                                            _dev_result[0] = self.PlaybackDevice(
                                                output_format=self.REQUESTED_FORMAT,
                                                nchannels=self.REQUESTED_CHANNELS,
                                                sample_rate=self.REQUESTED_RATE,
                                            )
                                            _dev_result[0].start(gen)
                                        except Exception as e:
                                            _dev_error[0] = e
                                    _dev_thread = threading.Thread(target=_create_dev, daemon=True)
                                    _dev_thread.start()
                                    _dev_thread.join(timeout=8.0)  # ★ 8s timeout: if device creation hangs, skip
                                    if _dev_thread.is_alive():
                                        # Device creation hung (system asleep) — don't wait, skip this retry
                                        self._log_critical(f"【!!】 Radio: device creation timed out (8s), system likely asleep — skipping retry {retry_n}")
                                        device = None
                                        # ★ Wait longer before next attempt (system is clearly suspended)
                                        backoff = min(backoff * 4, 60.0)
                                        continue
                                    if _dev_error[0]:
                                        raise _dev_error[0]
                                    device = _dev_result[0]
                                    # ★ 不手动 touch — 让设备真正拉取数据来证明自己
                                    time.sleep(2.0)
                                    silent = token.device_silent_seconds()
                                    if silent < 1.5:
                                        self._log_critical(f"【OK】 Radio: in-place recovery ok (retry {retry_n}, backoff {backoff:.1f}s, silent={silent:.2f}s)")
                                        recovered = True
                                        break
                                    else:
                                        self._log_critical(f"【??】 Radio: device created but no pull (silent={silent:.2f}s), retrying")
                                        self._kill_device_async(device)
                                        device = None
                                except Exception as e:
                                    if retry_n <= 2:
                                        self._log_critical(f"【!!】 Radio: in-place recovery retry {retry_n} failed: {e}")
                                    device = None
                                backoff = min(backoff * 2, 30.0)

                            if recovered:
                                _consecutive_device_failures = 0  # ★ Device works! Reset failure counter
                                _last_recovery_time = time.time()  # ★ Track for rapid-cycle detection
                                _rapid_recovery_count += 1
                                continue  # ★ 回到监控循环，继续播放
                            else:
                                _consecutive_device_failures += 1
                                if _consecutive_device_failures >= 3:
                                    self._log_critical(f"【!!】 Radio: in-place recovery failed (×{_consecutive_device_failures}), device unavailable — waiting 30s")
                                else:
                                    self._log_critical("【!!】 Radio: in-place recovery failed → full-reconnect")
                                device_dead = True
                                break

                except Exception as e:
                    self._log_critical(f"【!!】 Radio stream error: {e}")
                finally:
                    if source:
                        try: source.close()
                        except Exception: pass

                if not token.stopped:
                    # ★ If device keeps failing, use longer delay (device not ready yet / system asleep)
                    actual_delay = max(reconnect_delay, min(_consecutive_device_failures * 15, 120.0)) if device_dead else reconnect_delay
                    self._log_critical(f"[Radio] Waiting {actual_delay:.0f}s before reconnect (failures={_consecutive_device_failures})")
                    # ★ Sleep in chunks so we can detect system wake-up early
                    _wait_start = time.time()
                    while not token.stopped and (time.time() - _wait_start) < actual_delay:
                        time.sleep(2.0)
                    reconnect_delay = min(reconnect_delay * 1.5, 30.0)

        finally:
            if device:
                if device_dead:
                    self._kill_device_async(device)
                else:
                    try: device.stop()
                    except Exception: pass
                    try: device.close()
                    except Exception: pass

    def _radio_stream_gen(self, source_stream, token: PlaybackToken, already_primed=False, detach=None):
        """包装 stream_any 的 generator，添加 stop 检测和 touch 心跳。
        miniaudio generator 协议：send(required_frames) → yield PCM data。
        already_primed=True 时跳过 next()，用于屏保恢复复用已有解码器。
        detach: threading.Event — 被 set 时立即脱离 source_stream，避免新旧 gen 竞争。"""
        if not already_primed:
            next(source_stream)  # prime the source decoder
        required_frames = yield b''  # prime our wrapper for device
        # ★ 新连接预热：前 800ms 打印静音，让解码器完成 MP3 帧同步 + 稳定化
        # 避免 HTTP 重连时落在帧中间导致的变音/音裂（~1/3 概率）
        # 屏保恢复（already_primed）不需要预热，解码器状态是连续的
        # ★ 150ms 实测不够 — MP3 解码器帧同步后还需要几帧来稳定打印
        FRAME_BYTES = self.REQUESTED_CHANNELS * 2  # 16-bit stereo = 4
        warmup_frames = 0 if already_primed else int(self.REQUESTED_RATE * 0.8)  # 800ms
        # ★ 额外保护：前 N 次 send() 调用完全丢弃（确保解码器内部状态稳定）
        # stream_any 底层 MP3 解码器在 sync 期间可能产出零碎 PCM 片段
        discard_calls = 0 if already_primed else 3
        frames_output = 0
        while not token.stopped:
            # ★ detach 信号：恢复代码创建新 gen 前会 set 此事件，旧 gen 立即退出
            if detach and detach.is_set():
                break
            try:
                data = source_stream.send(required_frames)
                if not data or len(data) == 0:
                    break
                token.touch()
                if discard_calls > 0:
                    # ★ 完全丢弃前几次返回 — 解码器可能还在同步
                    discard_calls -= 1
                    required_frames = yield b'\x00' * len(data)
                elif warmup_frames > 0:
                    # ★ 静音预热：解码器已同步但打印可能不稳定
                    warmup_frames -= len(data) // FRAME_BYTES
                    required_frames = yield b'\x00' * len(data)
                else:
                    required_frames = yield data
            except StopIteration:
                break
            except ValueError:
                # "generator already executing" — 新旧 gen 竞争 source_stream.send()
                # 安全退出，让新 gen 接管
                break

    def _decode_mp3_buffer(self, mp3_bytes):
        """将原始 MP3 字节直接在内存中解码为 PCM，零磁盘 I/O"""
        try:
            decoded = miniaudio.decode(
                mp3_bytes,
                output_format=self.REQUESTED_FORMAT,
                nchannels=self.REQUESTED_CHANNELS,
                sample_rate=self.REQUESTED_RATE,
            )
            return decoded.samples
        except Exception:
            return None

    def _radio_hls_wrapper(self, m3u8_url, token: PlaybackToken):
        try:
            self._radio_hls_worker(m3u8_url, token)
        finally:
            self._unregister_token(token)

    def _radio_hls_worker(self, m3u8_url, token: PlaybackToken):
        """HLS 电台播放：循环拉取 playlist → 下载新段 → 解码 → 无缝播放"""
        import tempfile

        device = None
        device_dead = False
        base_url = m3u8_url.rsplit('/', 1)[0] + '/'
        last_seq = -1
        retry_delay = 1.0
        consecutive_errors = 0
        MAX_CONSECUTIVE_ERRORS = 10

        try:
            while not token.stopped:
                # --- 1. 拉取 m3u8 ---
                segments = self._hls_fetch_playlist(m3u8_url, base_url)
                if segments is None:
                    consecutive_errors += 1
                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                        self._log_critical("【!!】 Radio: too many playlist errors, stopping")
                        break
                    time.sleep(retry_delay)
                    continue
                consecutive_errors = 0

                if not segments:
                    # 空 playlist（可能还没有新段），等待后重试
                    time.sleep(1.0)
                    continue

                # --- 2. 序号跳变保护（服务端重启后序号会跳到远大于 last_seq 的值）---
                min_seq = segments[0][0]
                if last_seq != -1 and min_seq > last_seq + 100:
                    self._log_critical(f"【!!】 Radio: seq jump detected {last_seq} → {min_seq}, resetting")
                    last_seq = min_seq - 1

                # --- 2.5 首次进入：只取最新 1 段，跳过旧段避免高延迟下 404 ---
                if last_seq == -1 and len(segments) > 1:
                    last_seq = segments[-2][0]  # 只播最后一段

                # --- 3. 播放新段 ---
                played_any = False
                for seq, seg_url, duration in segments:
                    if token.stopped:
                        break
                    if seq <= last_seq:
                        continue
                    last_seq = seq

                    # 下载段
                    seg_pcm = self._hls_download_and_decode(seg_url)
                    if seg_pcm is None:
                        continue

                    played_any = True

                    # 创建/重建设备
                    if device is None or device_dead:
                        if device and device_dead:
                            self._kill_device_async(device)
                        device_dead = False
                        try:
                            gen = self._pcm_once_stream(seg_pcm, token)
                            next(gen)  # prime the generator before device.start()
                            device = self.PlaybackDevice(
                                output_format=self.REQUESTED_FORMAT,
                                nchannels=self.REQUESTED_CHANNELS,
                                sample_rate=self.REQUESTED_RATE,
                            )
                            device.start(gen)
                        except Exception as e:
                            self._log_critical(f"【!!】 Radio: device create failed: {e}")
                            device = None
                            time.sleep(2.0)
                            continue
                    else:
                        # 设备存在，直接喂 PCM 到队列
                        self._radio_feed_pcm(token, seg_pcm)

                    # 等待段播完（近似 duration）
                    wait_end = time.monotonic() + max(duration - 0.3, 0.5)
                    while time.monotonic() < wait_end and not token.stopped:
                        # 检测设备静默（屏保保护）
                        if token.device_silent_seconds() > 3.0:
                            self._log_critical("【!!】 Radio: device silent detected")
                            if self._on_device_lost:
                                try: self._on_device_lost()
                                except Exception: pass
                            device_dead = True
                            break
                        time.sleep(0.1)

                    if device_dead:
                        # 设备挂了，销毁并尝试在下一段重建
                        if device:
                            self._kill_device_async(device)
                            device = None
                        time.sleep(1.0)

                if not played_any and not token.stopped:
                    # 没有新段可播，等待 playlist 更新
                    time.sleep(1.0)

        finally:
            if device:
                if device_dead:
                    self._kill_device_async(device)
                else:
                    try: device.stop()
                    except Exception: pass
                    try: device.close()
                    except Exception: pass

    def _hls_fetch_playlist(self, m3u8_url, base_url):
        """拉取 m3u8 并解析，返回 [(seq, url, duration), ...] 或 None（错误）"""
        try:
            resp = _https_urlopen(m3u8_url, timeout=15)
            try:
                text = resp.read().decode('utf-8', errors='replace')
            finally:
                try: resp.close()
                except Exception: pass
        except Exception as e:
            self._log_critical(f"【!!】 Radio playlist fetch error: {e}")
            return None

        # 解析 m3u8
        lines = text.strip().splitlines()
        media_seq = 0
        segments = []
        duration = 3.0
        is_end = False

        for i, line in enumerate(lines):
            line = line.strip()
            if line.startswith('#EXT-X-MEDIA-SEQUENCE:'):
                try:
                    media_seq = int(line.split(':')[1])
                except (ValueError, IndexError):
                    pass
            elif line.startswith('#EXTINF:'):
                try:
                    duration = float(line.split(':')[1].rstrip(','))
                except (ValueError, IndexError):
                    duration = 3.0
            elif line.startswith('#EXT-X-ENDLIST'):
                is_end = True
            elif line and not line.startswith('#'):
                # 段 URL：绝对路径(/开头)用域名根拼接，相对路径用 base_url
                if line.startswith('http'):
                    seg_url = line
                elif line.startswith('/'):
                    # /radio/seg/xxx.mp3 → https://gh555.com/radio/seg/xxx.mp3
                    from urllib.parse import urlparse
                    parsed = urlparse(m3u8_url)
                    seg_url = f"{parsed.scheme}://{parsed.netloc}{line}"
                else:
                    seg_url = base_url + line
                seg_seq = media_seq + len(segments)
                segments.append((seg_seq, seg_url, duration))
                duration = 3.0  # reset for next

        return segments

    def _hls_download_and_decode(self, seg_url):
        """下载一个 HLS 段并解码为 PCM array。
        支持 MP3/FLAC/WAV（miniaudio 原生）+ AAC/fMP4（ffmpeg 兑底）。
        失败返回 None。
        """
        import tempfile
        import subprocess
        tmp_path = None
        try:
            resp = _https_urlopen(seg_url, timeout=20)
            try:
                data = resp.read()
            finally:
                try: resp.close()
                except Exception: pass

            # 根据 URL 后缀决定临时文件后缀
            ext = '.mp3'
            lower = seg_url.lower().split('?')[0]
            if lower.endswith('.m4s') or lower.endswith('.mp4'):
                ext = '.m4s'
            elif lower.endswith('.aac'):
                ext = '.aac'
            elif lower.endswith('.ts'):
                ext = '.ts'

            fd, tmp_path = tempfile.mkstemp(suffix=ext)
            os.write(fd, data)
            os.close(fd)

            # ★ 先尝试 miniaudio 原生解码（MP3/FLAC/WAV/Vorbis）
            try:
                decoded = miniaudio.decode_file(
                    tmp_path,
                    output_format=self.REQUESTED_FORMAT,
                    nchannels=self.REQUESTED_CHANNELS,
                    sample_rate=self.REQUESTED_RATE,
                )
                return decoded.samples
            except Exception:
                pass

            # ★ miniaudio 不支持（AAC/fMP4/TS）→ ffmpeg subprocess 兑底
            wav_path = tmp_path + '.wav'
            try:
                subprocess.run(
                    ['ffmpeg', '-y', '-i', tmp_path,
                     '-f', 'wav', '-acodec', 'pcm_s16le',
                     '-ar', str(self.REQUESTED_RATE),
                     '-ac', str(self.REQUESTED_CHANNELS),
                     wav_path],
                    capture_output=True, timeout=10
                )
                if os.path.exists(wav_path):
                    decoded = miniaudio.decode_file(
                        wav_path,
                        output_format=self.REQUESTED_FORMAT,
                        nchannels=self.REQUESTED_CHANNELS,
                        sample_rate=self.REQUESTED_RATE,
                    )
                    return decoded.samples
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass  # ffmpeg 不可用或超时
            finally:
                try: os.unlink(wav_path)
                except Exception: pass

            self._log_critical(f"【!!】 Radio: unable to decode segment: {seg_url}")
            return None
        except Exception as e:
            self._log_critical(f"【!!】 Radio segment download error: {e}")
            return None
        finally:
            if tmp_path:
                try: os.unlink(tmp_path)
                except Exception: pass

    def _pcm_once_stream(self, pcm_data, token: PlaybackToken):
        """生成器：播放 PCM 数据，支持外部喂入新段。
        miniaudio generator 协议：required 是帧数（frames），不是字节数。
        音频回调线程零阻塞：队列空时立即 yield 静音，不等待。"""
        FRAME_SIZE = self.REQUESTED_CHANNELS * 2  # int16 stereo = 4 bytes/frame
        if token._radio_q is None:
            token._radio_q = queue.Queue(maxsize=8)
        required_frames = yield b''  # prime
        silence = None  # 懒初始化静音缓冲区
        mv = memoryview(pcm_data).cast('B')
        offset = 0
        while not token.stopped:
            if offset < len(mv):
                nbytes = required_frames * FRAME_SIZE
                end = min(offset + nbytes, len(mv))
                chunk = bytes(mv[offset:end])
                offset += len(chunk)
                token.touch()
                required_frames = yield chunk
            else:
                # 当前段播完，非阻塞尝试取下一段
                try:
                    next_pcm = token._radio_q.get_nowait()
                    if next_pcm is None:
                        break
                    mv = memoryview(next_pcm).cast('B')
                    offset = 0
                except queue.Empty:
                    if token.stopped:
                        break
                    # 队列空 → 立即 yield 一帧静音（~23ms@44100Hz），不阻塞音频线程
                    if silence is None or len(silence) != required_frames * FRAME_SIZE:
                        silence = b'\x00' * (required_frames * FRAME_SIZE)
                    token.touch()
                    required_frames = yield silence

    def _radio_feed_pcm(self, token: PlaybackToken, pcm_data):
        """喂入新段 PCM 到播放队列"""
        if token._radio_q is not None:
            try:
                token._radio_q.put(pcm_data, timeout=5.0)
            except queue.Full:
                pass

    def stop_all(self):
        with self._tokens_lock:
            for t in list(self._active_tokens):
                try:
                    t.stop()
                except Exception:
                    pass

    def cleanup(self):
        if getattr(self, "_cleaned", False):
            return
        self._cleaned = True
        self._log("正在关闭非阻塞音频引擎...")
        try:
            self.stop_all()
            if self.executor:
                self.executor.shutdown(wait=True)
        finally:
            self._log("非阻塞音频引擎已关闭。")


_DEFAULT_ENGINE = None
def az(file_path: str, loop_times: int, final_fade_seconds: float, trim_silence: bool = True):
    global _DEFAULT_ENGINE
    if _DEFAULT_ENGINE is None:
        asset_folder = os.path.dirname(os.path.abspath(file_path)) or "."
        _DEFAULT_ENGINE = NonBlockingAudioEngine(asset_folder=asset_folder, max_workers=8)
    return _DEFAULT_ENGINE.az(file_path, loop_times, final_fade_seconds, trim_silence)


# =========================
# SFX
# =========================
_SENTINEL = object()

class UltraFastConcurrentSFX:
    """★ Rewritten to use a SINGLE persistent PlaybackDevice with mixing.
    Old design created a new PlaybackDevice per sound → device handle exhaustion
    when multiple miniaudio instances coexist (e.g. external q3.py + our broker).
    New design: one device, mix all concurrent voices into a single output stream.
    """
    def __init__(self, max_concurrent_voices=24, submit_queue_size=1024, sample_rate=44100, nchannels=2, sample_format=None):
        if miniaudio is None:
            raise RuntimeError("miniaudio not available")
        if sample_format is None:
            sample_format = miniaudio.SampleFormat.SIGNED16

        self.sample_rate = sample_rate
        self.nchannels = nchannels
        self.sample_format = sample_format
        self._max_voices = max_concurrent_voices

        self._submit_q = queue.Queue(maxsize=submit_queue_size)
        self._cache = {}
        self._cache_lock = threading.Lock()

        self._running = threading.Event()
        self._running.set()

        # ★ Single persistent device + mixer
        self._voices_lock = threading.Lock()
        self._voices = []  # list of {"pcm": bytes, "offset": int, "length": int}
        self._device = None
        self._device_lock = threading.Lock()

        self._dispatch_thread = threading.Thread(target=self._dispatch_loop, name="sfx-dispatch", daemon=True)
        self._dispatch_thread.start()

    def play(self, path: str):
        if not path:
            return
        try:
            self._submit_q.put_nowait(path)
        except queue.Full:
            pass

    def prime(self, paths):
        for p in paths:
            self._decode_cache(p)

    def close(self):
        self._running.clear()
        try:
            self._submit_q.put_nowait(_SENTINEL)
        except Exception:
            pass
        self._dispatch_thread.join(timeout=2.0)
        with self._device_lock:
            if self._device:
                try: self._device.close()
                except Exception: pass
                self._device = None

    def _decode_cache(self, path):
        if not os.path.isfile(path):
            return None
        with self._cache_lock:
            if path in self._cache:
                return self._cache[path]
        try:
            decoded = miniaudio.decode_file(path, output_format=self.sample_format, nchannels=self.nchannels, sample_rate=self.sample_rate)
            pcm = decoded.samples
            dur = 0.0
            if getattr(decoded, "sample_rate", 0) and getattr(decoded, "num_frames", 0):
                dur = decoded.num_frames / decoded.sample_rate
            item = (pcm, dur)
            with self._cache_lock:
                self._cache[path] = item
            return item
        except Exception:
            return None

    def _dispatch_loop(self):
        while self._running.is_set():
            item = self._submit_q.get()
            if item is _SENTINEL:
                break
            self._add_voice(item)

    def _add_voice(self, path):
        cached = self._decode_cache(path)
        if not cached:
            return
        pcm_bytes, duration = cached
        voice = {"pcm": pcm_bytes, "offset": 0, "length": len(pcm_bytes)}
        with self._voices_lock:
            # ★ Limit concurrent voices to prevent memory bloat
            if len(self._voices) >= self._max_voices:
                self._voices.pop(0)  # drop oldest
            self._voices.append(voice)
        # ★ Ensure persistent device is running
        self._ensure_device()

    def _ensure_device(self):
        with self._device_lock:
            if self._device is not None:
                return
            try:
                self._device = miniaudio.PlaybackDevice(
                    output_format=self.sample_format,
                    nchannels=self.nchannels,
                    sample_rate=self.sample_rate,
                )
                self._device.start(self._mix_generator())
            except Exception:
                self._device = None

    def _mix_generator(self):
        """★ Single generator that mixes all active voices into one output stream."""
        import array
        bytes_per_sample = 2  # SIGNED16
        frame_size = bytes_per_sample * self.nchannels
        # Yield small chunks (~10ms) for low latency
        chunk_frames = self.sample_rate // 100
        chunk_bytes = chunk_frames * frame_size
        silence_frames = 0
        max_silence = self.sample_rate * 2  # 2s of silence → stop device to save resources

        while self._running.is_set():
            with self._voices_lock:
                active = [v for v in self._voices if v["offset"] < v["length"]]
                # Remove finished voices
                self._voices = active

            if not active:
                silence_frames += chunk_frames
                if silence_frames >= max_silence:
                    # ★ No voices for 2s → stop device to release handle
                    with self._device_lock:
                        if self._device:
                            # Schedule close on another thread to avoid deadlock
                            dev = self._device
                            self._device = None
                            threading.Thread(target=lambda d: (d.close()), args=(dev,), daemon=True).start()
                    return  # exit generator
                # Yield silence
                yield bytes(chunk_bytes)
                continue

            silence_frames = 0
            # Mix voices
            mixed = array.array('h', [0] * (chunk_frames * self.nchannels))
            for v in active:
                pcm = v["pcm"]
                start = v["offset"]
                end = min(start + chunk_bytes, v["length"])
                # Read samples from this voice
                voice_chunk = pcm[start:end]
                v["offset"] = end
                # Mix (additive with clamp)
                num_samples = len(voice_chunk) // bytes_per_sample
                voice_arr = array.array('h')
                voice_arr.frombytes(voice_chunk if isinstance(voice_chunk, bytes) else bytes(voice_chunk))
                for i in range(min(num_samples, len(mixed))):
                    s = mixed[i] + voice_arr[i]
                    # Clamp to int16 range
                    if s > 32767: s = 32767
                    elif s < -32768: s = -32768
                    mixed[i] = s

            yield mixed.tobytes()
        # Generator exit
        return


# =========================
# ClipboardWatcher (Windows-only: Win32 message pump for clipboard changes)
# On Linux/macOS, a no-op stub is used instead.
# =========================
if sys.platform == 'win32':
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    # ★ 兼容修复：某些 Python 版本的 wintypes 没有 LRESULT
    if not hasattr(wt, 'LRESULT'):
        wt.LRESULT = ctypes.c_longlong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_long

    WM_CLIPBOARDUPDATE = 0x031D
    WM_CLOSE = 0x0010
    HWND_MESSAGE = wt.HWND(-3)

    class WNDCLASSEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wt.UINT), ("style", wt.UINT), ("lpfnWndProc", ctypes.c_void_p),
            ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int), ("hInstance", wt.HINSTANCE),
            ("hIcon", wt.HICON), ("hCursor", wt.HANDLE), ("hbrBackground", wt.HBRUSH),
            ("lpszMenuName", wt.LPCWSTR), ("lpszClassName", wt.LPCWSTR), ("hIconSm", wt.HICON),
        ]

    user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
    user32.RegisterClassExW.restype = wt.ATOM
    user32.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
    user32.CreateWindowExW.restype = wt.HWND
    user32.DestroyWindow.argtypes = [wt.HWND]
    user32.DestroyWindow.restype = wt.BOOL
    user32.UnregisterClassW.argtypes = [wt.LPCWSTR, wt.HINSTANCE]
    user32.UnregisterClassW.restype = wt.BOOL
    user32.AddClipboardFormatListener.argtypes = [wt.HWND]
    user32.AddClipboardFormatListener.restype = wt.BOOL
    user32.RemoveClipboardFormatListener.argtypes = [wt.HWND]
    user32.RemoveClipboardFormatListener.restype = wt.BOOL
    user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    user32.PostMessageW.restype = wt.BOOL
    user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT]
    user32.GetMessageW.restype = ctypes.c_int
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wt.MSG)]
    user32.TranslateMessage.restype = wt.BOOL
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wt.MSG)]
    user32.DispatchMessageW.restype = wt.LRESULT
    user32.DefWindowProcW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    user32.DefWindowProcW.restype = wt.LRESULT
    user32.PostQuitMessage.argtypes = [ctypes.c_int]
    user32.PostQuitMessage.restype = None
    kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
    kernel32.GetModuleHandleW.restype = wt.HMODULE
    WNDPROC_T = ctypes.WINFUNCTYPE(wt.LRESULT, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)

    class ClipboardWatcher:
        def __init__(self, callback, debounce_ms=0):
            if not callable(callback):
                raise TypeError("callback must be callable")
            self._callback = callback
            self._debounce_s = max(0.0, debounce_ms / 1000.0)

            self._queue = queue.Queue()
            self._msg_thread = None
            self._work_thread = None
            self._hwnd = None
            self._wndproc_ref = None
            self._cls_name = f"DGS_CB_{id(self):x}"
            self._lock = threading.Lock()
            self._ready = threading.Event()
            self._started_ok = False

        @property
        def alive(self):
            return self._msg_thread is not None and self._msg_thread.is_alive()

        def start(self):
            with self._lock:
                if self.alive:
                    return
                self._ready.clear()
                self._started_ok = False
                self._work_thread = threading.Thread(target=self._worker, name="cb-worker", daemon=True)
                self._work_thread.start()
                self._msg_thread = threading.Thread(target=self._pump, name="cb-pump", daemon=True)
                self._msg_thread.start()
                if not self._ready.wait(timeout=3.0) or not self._started_ok:
                    raise RuntimeError("ClipboardWatcher start failed")

        def stop(self):
            with self._lock:
                if not self.alive:
                    return
                if self._hwnd:
                    user32.PostMessageW(self._hwnd, WM_CLOSE, 0, 0)
                self._msg_thread.join(timeout=3.0)
                self._msg_thread = None
                self._queue.put(_SENTINEL)
                self._work_thread.join(timeout=3.0)
                self._work_thread = None

        def _wndproc(self, hwnd, msg, wp, lp):
            if msg == WM_CLIPBOARDUPDATE:
                try:
                    self._queue.put_nowait(time.perf_counter())
                except Exception:
                    pass
                return 0
            if msg == WM_CLOSE:
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(hwnd, msg, wp, lp)

        def _worker(self):
            last = 0.0
            ds = self._debounce_s
            while True:
                ts = self._queue.get()
                if ts is _SENTINEL:
                    break
                if ds > 0 and (ts - last) < ds:
                    continue
                last = ts
                try:
                    self._callback()
                except Exception:
                    pass

        def _pump(self):
            self._wndproc_ref = WNDPROC_T(self._wndproc)
            hinst = kernel32.GetModuleHandleW(None)

            wc = WNDCLASSEXW()
            wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
            wc.lpfnWndProc = ctypes.cast(self._wndproc_ref, ctypes.c_void_p).value
            wc.hInstance = hinst
            wc.lpszClassName = self._cls_name
            user32.RegisterClassExW(ctypes.byref(wc))

            try:
                self._hwnd = user32.CreateWindowExW(0, self._cls_name, None, 0, 0, 0, 0, 0, HWND_MESSAGE, None, hinst, None)
                if not self._hwnd:
                    self._ready.set()
                    return
                ok = user32.AddClipboardFormatListener(self._hwnd)
                if not ok:
                    self._ready.set()
                    return
                self._started_ok = True
                self._ready.set()

                msg = wt.MSG()
                while True:
                    ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                    if ret <= 0:
                        break
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
            finally:
                if self._hwnd:
                    try: user32.RemoveClipboardFormatListener(self._hwnd)
                    except Exception: pass
                    try: user32.DestroyWindow(self._hwnd)
                    except Exception: pass
                    self._hwnd = None
                try: user32.UnregisterClassW(self._cls_name, hinst)
                except Exception: pass
                self._wndproc_ref = None

else:
    # ★ Linux / macOS: no-op stub (clipboard monitoring handled by Shell bridge / xclip)
    class ClipboardWatcher:
        def __init__(self, callback, debounce_ms=0): pass
        @property
        def alive(self): return False
        def start(self): pass
        def stop(self): pass


class TriggerBus:
    def __init__(self):
        self._handlers = {}
        self._lock = threading.Lock()

    def on(self, event_name: str, fn):
        if not callable(fn):
            raise TypeError("fn must be callable")
        with self._lock:
            self._handlers.setdefault(event_name, []).append(fn)

    def emit(self, event_name: str, *args, **kwargs):
        with self._lock:
            hs = list(self._handlers.get(event_name, []))
        for h in hs:
            try:
                h(*args, **kwargs)
            except Exception:
                pass


class AudioHub:
    def __init__(self, asset_folder="assets", music_workers=16, sfx_workers=24, sfx_use_music_engine=False, silent=False):
        self.music = NonBlockingAudioEngine(asset_folder=asset_folder, max_workers=music_workers, silent=silent)
        self.sfx_use_music_engine = bool(sfx_use_music_engine)

        if not self.sfx_use_music_engine:
            self.sfx = UltraFastConcurrentSFX(max_concurrent_voices=sfx_workers)
        else:
            self.sfx = None

        self.bus = TriggerBus()
        self.clipboard_watcher = None
        self._clipboard_sounds = []
        self._clipboard_lock = threading.Lock()

    def az(self, file_path: str, loop_times: int, final_fade_seconds: float, trim_silence: bool = True):
        return self.music.az(file_path, loop_times, final_fade_seconds, trim_silence)

    def play_music_file(self, file_path, play_range=None, fade_out_seconds=0.0, loop=False, trim_silence=True, loop_crossfade_ms=None):
        return self.music.play_sound_file(file_path, play_range, fade_out_seconds, loop, trim_silence, loop_crossfade_ms)

    def prime_sfx(self, paths):
        if self.sfx_use_music_engine:
            return
        self.sfx.prime(paths)

    def play_sfx(self, path: str):
        if self.sfx_use_music_engine:
            self.music.play_sound_file(path, play_range=None, fade_out_seconds=0.0, loop=False, trim_silence=False, loop_crossfade_ms=0.0)
            return
        self.sfx.play(path)

    def on(self, event_name: str, fn):
        self.bus.on(event_name, fn)

    def trigger(self, event_name: str, *args, **kwargs):
        self.bus.emit(event_name, *args, **kwargs)

    def bind_clipboard_to_random_sfx(self, sound_paths, debounce_ms=0, prewarm=True):
        """
        修正点（你指定）：
        - 如果旧 watcher 存在且 alive，先 stop 再替换，避免残留线程/隐藏窗口
        """
        paths = [p for p in sound_paths if os.path.isfile(p)]
        if not paths:
            raise ValueError("sound_paths 为空或文件不存在")

        with self._clipboard_lock:
            # 关键修正：先停旧 watcher
            old = self.clipboard_watcher
            if old is not None and old.alive:
                try:
                    old.stop()
                except Exception:
                    pass

            self._clipboard_sounds = paths

            if prewarm and (not self.sfx_use_music_engine):
                self.prime_sfx(paths)

            def _on_clip():
                p = random.choice(self._clipboard_sounds)
                self.play_sfx(p)

            self.clipboard_watcher = ClipboardWatcher(_on_clip, debounce_ms=debounce_ms)

    def start_clipboard(self):
        with self._clipboard_lock:
            if self.clipboard_watcher:
                self.clipboard_watcher.start()

    def stop_clipboard(self):
        with self._clipboard_lock:
            if self.clipboard_watcher:
                self.clipboard_watcher.stop()

    def close(self):
        try:
            self.stop_clipboard()
        except Exception:
            pass
        try:
            if self.sfx:
                self.sfx.close()
        except Exception:
            pass
        try:
            self.music.cleanup()
        except Exception:
            pass


if __name__ == "__main__":
    hub = AudioHub(asset_folder="assets", silent=False)
    print("AudioHub ready. Ctrl+C to exit.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        hub.close()


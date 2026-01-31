# 文件名: q1.py
#
# v1.6.3
# - 修改：az(file_path, loop_times, final_fade_seconds, trim_silence=True)
#        trim_silence=True  -> 去除首尾静音 -> 循环固定次数 -> 最后一次末尾按 final_fade_seconds 余弦淡出
#        trim_silence=False -> 不去除首尾静音 -> 循环固定次数 -> 最后一次末尾按 final_fade_seconds 余弦淡出
# - 其余行为保持不变
#
# ⚠️ 注意：工程目录里不要存在 miniaudio.py / miniaudio/ 目录，否则会遮蔽 pip 的 miniaudio 包

import time
import os
import random
from concurrent.futures import ThreadPoolExecutor
import array
import sys
import math
import atexit
import threading
from functools import lru_cache
from collections import OrderedDict
import traceback

# ------------------ 可选：miniaudio 导入（可能失败/被遮蔽） ------------------
_MINIAUDIO_IMPORT_ERROR = None
try:
    import miniaudio  # noqa
except Exception as e:
    miniaudio = None  # type: ignore
    _MINIAUDIO_IMPORT_ERROR = e


# ===================== 可调参数（你想更“狠”就调这里） =====================
SILENCE_DB = -45.0                  # 静音阈值（更“狠”就改 -40.0；更“松”就改 -50.0）
TRIM_WINDOW_SECONDS = 30.0          # 只精确检测首尾各多少秒用于剪裁（性能折中）
LOUD_RUN_MS = 8.0                   # 必须连续多少毫秒超阈才算“真正有声”（更干净）

LOOP_PREDECODE_MAX_SECONDS = 300.0  # 循环时：片段<=该秒数才预解码到内存保证更稳
LOOP_CROSSFADE_MS_DEFAULT = 12.0    # 循环“尾->头” crossfade 时长（ms）。设 0 表示关闭

SOURCE_READ_FRAMES_MAX = 16384      # 关键：对 miniaudio.stream_file 的 send(framecount) 不得超过该值
EMPTY_READ_RETRIES = 6              # 空读重试次数（防止偶发空供被误判 EOF）
EMPTY_READ_SLEEP = 0.0              # 是否在空读之间 sleep（一般 0 就行）

PCM_CACHE_MAX_ITEMS = 8             # PCM 缓存个数
# ==========================================================================


def _db_to_int16_threshold(db: float) -> int:
    ratio = 10 ** (db / 20.0)
    return int(32767 * ratio)


SILENCE_THR = _db_to_int16_threshold(SILENCE_DB)


@lru_cache(maxsize=64)
def _cosine_fade_table(fade_frames: int):
    # 返回长度 fade_frames+1 的余弦淡出增益表：从 1 -> 0
    if fade_frames <= 0:
        return None
    n = float(fade_frames)
    return tuple(0.5 * (1.0 + math.cos(math.pi * (i / n))) for i in range(fade_frames + 1))


@lru_cache(maxsize=64)
def _raised_cosine_crossfade_gains(n: int):
    """
    返回 (out_gains, in_gains) 长度 n
    i 从 0..n-1：
      in = 0.5 * (1 - cos(pi*(i+1)/n)) 从接近0到1
      out = 1 - in
    """
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
    """
    给出“是否被同名文件/目录遮蔽”的提示（高概率是你现在的情况）。
    """
    if miniaudio is None:
        return ""
    p = getattr(miniaudio, "__file__", "") or ""
    if not p:
        return "miniaudio.__file__ 为空（异常情况，可能是被奇怪的模块遮蔽）"
    cwd = os.path.abspath(os.getcwd())
    ap = os.path.abspath(p)
    if ap.startswith(cwd + os.sep) or ap == cwd:
        return (
            "⚠️ 疑似同名遮蔽：当前导入的 miniaudio 来自工作目录/项目目录。\n"
            f"  当前工作目录: {cwd}\n"
            f"  miniaudio.__file__: {ap}\n"
            "  请检查是否存在 miniaudio.py 或 miniaudio/ 目录，导致覆盖了 site-packages 的 miniaudio。"
        )
    return ""


def _miniaudio_diagnostics(verbose_trace=False) -> str:
    """
    输出一份尽量完整的环境诊断（用于 validate not ok 时打印）
    """
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
    """
    把 miniaudio 的关键 API 取出来。
    若不满足，给出详细原因。
    """
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


class PlaybackToken:
    __slots__ = ("stop_event",)

    def __init__(self):
        self.stop_event = threading.Event()

    def stop(self):
        self.stop_event.set()

    @property
    def stopped(self):
        return self.stop_event.is_set()


class NonBlockingAudioEngine:
    def __init__(self, asset_folder="assets", max_workers=32, silent=False):
        self.silent = silent
        self._log("非阻塞音频引擎 (NonBlockingAudioEngine) 正在初始化...")
        self.asset_folder = asset_folder

        self._compat = _MiniaudioCompat()
        if not self._compat.ok:
            raise RuntimeError(self._compat.reason(with_diag=True))

        self.PlaybackDevice = self._compat.PlaybackDevice
        self.REQUESTED_FORMAT = self._compat.SIGNED16
        self.REQUESTED_CHANNELS = 2
        self.REQUESTED_RATE = 44100
        self._frame_bytes = self.REQUESTED_CHANNELS * 2

        self.executor = ThreadPoolExecutor(max_workers=max_workers)

        self.main_sounds = []
        self.q_sounds = []
        self.z_sounds = []
        self.last_played_main = -1
        self.last_played_q = -1
        self.last_played_z = -1

        self._cleaned = False
        self._active_tokens = set()
        self._tokens_lock = threading.Lock()

        self._trim_cache = {}
        self._trim_cache_lock = threading.Lock()

        self._pcm_cache = OrderedDict()
        self._pcm_cache_lock = threading.Lock()

        atexit.register(self.cleanup)

        self._load_sound_files()
        self._log(
            f"非阻塞音频引擎初始化完毕，共加载 {len(self.main_sounds)} 个主音效，"
            f"{len(self.q_sounds)} 个q音效，{len(self.z_sounds)} 个z音效"
        )

    def _log(self, msg: str):
        if not self.silent:
            print(msg)

    # ---------- 音效加载 ----------
    def _load_sound_files(self):
        try:
            if not os.path.isdir(self.asset_folder):
                self._log(f"提示：找不到资源文件夹 '{self.asset_folder}'，将跳过内置音效加载。")
                return

            for i in range(1, 9):
                wav_file = os.path.join(self.asset_folder, f"{i}.wav")
                mp3_file = os.path.join(self.asset_folder, f"{i}.mp3")
                if os.path.exists(wav_file):
                    self.main_sounds.append(wav_file)
                elif os.path.exists(mp3_file):
                    self.main_sounds.append(mp3_file)

            for i in range(1, 10):
                wav_file = os.path.join(self.asset_folder, f"q{i}.wav")
                mp3_file = os.path.join(self.asset_folder, f"q{i}.mp3")
                if os.path.exists(wav_file):
                    self.q_sounds.append(wav_file)
                elif os.path.exists(mp3_file):
                    self.q_sounds.append(mp3_file)

            for i in range(1, 7):
                wav_file = os.path.join(self.asset_folder, f"z{i}.wav")
                mp3_file = os.path.join(self.asset_folder, f"z{i}.mp3")
                if os.path.exists(wav_file):
                    self.z_sounds.append(wav_file)
                elif os.path.exists(mp3_file):
                    self.z_sounds.append(mp3_file)
        except Exception as e:
            self._log(f"加载音效文件时出错: {e}")

    def _get_random_sound(self, sound_list, last_played_index):
        if not sound_list:
            return None
        if len(sound_list) == 1:
            return sound_list[0]
        new_index = last_played_index
        while new_index == last_played_index:
            new_index = random.randint(0, len(sound_list) - 1)
        return sound_list[new_index]

    # ---------- generator send 适配 ----------
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

    # ---------- 静音剪裁 ----------
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

    def _find_first_loud_run_in_block(self, pcm_bytes: bytes, frames_in_block: int,
                                      thr: int, need_run: int, carry_run: int):
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

    def _find_last_loud_run_end_in_block(self, pcm_bytes: bytes, frames_in_block: int,
                                         thr: int, need_run: int,
                                         carry_run: int, last_end_global: int, global_offset: int):
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

        src = miniaudio.stream_file(
            file_path,
            output_format=self.REQUESTED_FORMAT,
            nchannels=self.REQUESTED_CHANNELS,
            sample_rate=self.REQUESTED_RATE
        )

        try:
            if start_frame > 0:
                if not self._skip_frames(src, start_frame, token):
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
                    carry_tail, last_loud_end = self._find_last_loud_run_end_in_block(
                        block, got, SILENCE_THR, need_run, carry_tail, last_loud_end, seg_pos
                    )
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

        key = (file_path, start_frame, end_frame, SILENCE_DB, LOUD_RUN_MS, TRIM_WINDOW_SECONDS,
               self.REQUESTED_RATE, self.REQUESTED_CHANNELS)

        with self._trim_cache_lock:
            ent = self._trim_cache.get(key)
            if ent and ent[0] == mtime_ns and ent[1] == size:
                return ent[2], ent[3]

        new_start, new_end = self._trim_silence_edges_uncached(file_path, start_frame, end_frame, token)
        with self._trim_cache_lock:
            self._trim_cache[key] = (mtime_ns, size, new_start, new_end)
        return new_start, new_end

    # ---------- 余弦淡出（对 chunk） ----------
    def _apply_fadeout_to_chunk_s16(self, chunk_bytes: bytes, chunk_frames: int,
                                   frames_played_before_chunk: int,
                                   fade_start_frame: int, fade_frames: int, fade_gains) -> bytes:
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
                if v > 32767:
                    v = 32767
                elif v < -32768:
                    v = -32768
                samples[base + c] = v

        if sys.byteorder != "little":
            samples.byteswap()
        return samples.tobytes()

    # ---------- 回调流：从“当前位置”开始输出 seg_frames ----------
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
            want = want_total if want_total <= remain else remain

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
                audio = self._apply_fadeout_to_chunk_s16(
                    chunk_bytes=audio,
                    chunk_frames=want,
                    frames_played_before_chunk=played,
                    fade_start_frame=fade_start,
                    fade_frames=fade_frames,
                    fade_gains=fade_gains
                )

            played += want

            if want < want_total:
                audio += b"\x00" * ((want_total - want) * self._frame_bytes)

            framecount = yield audio

    # ---------- PCM 解码并缓存 ----------
    def _get_pcm_cached_or_decode(self, file_path: str, start_frame: int, end_frame: int,
                                  token: PlaybackToken, crossfade_ms: float):
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

        src = miniaudio.stream_file(
            file_path,
            output_format=self.REQUESTED_FORMAT,
            nchannels=self.REQUESTED_CHANNELS,
            sample_rate=self.REQUESTED_RATE
        )
        try:
            if start_frame > 0:
                if not self._skip_frames(src, start_frame, token):
                    return b"", 0

            remain = total_frames
            buf = bytearray()
            while remain > 0 and (not token.stopped):
                req = SOURCE_READ_FRAMES_MAX if remain > SOURCE_READ_FRAMES_MAX else remain
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

        # 这里 crossfade_ms=0 时不做任何改动（用于 az 的 PCM 基础数据）
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

    # ---------- 循环 crossfade：预处理 PCM（一次性）（保留原功能） ----------
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
                if v > 32767:
                    v = 32767
                elif v < -32768:
                    v = -32768
                samples[tail_base + c] = v

        if sys.byteorder != "little":
            samples.byteswap()

        return samples.tobytes(), xfade_frames

    # ---------- PCM 无限循环（原逻辑保留） ----------
    def _pcm_loop_stream(self, pcm_bytes: bytes, token: PlaybackToken, xfade_frames: int = 0):
        total_frames = len(pcm_bytes) // self._frame_bytes
        if total_frames <= 0:
            framecount = yield b""
            return

        if xfade_frames < 0:
            xfade_frames = 0
        if xfade_frames * 2 >= total_frames:
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
                take = remain_seg if remain_seg < (want - filled) else (want - filled)

                s = pos * self._frame_bytes
                e = s + take * self._frame_bytes
                out[filled * self._frame_bytes: (filled + take) * self._frame_bytes] = pcm_bytes[s:e]

                filled += take
                pos += take

                if pos >= total_frames:
                    pos = xfade_frames if xfade_frames > 0 else 0

            framecount = yield bytes(out)

    # ---------- PCM 固定循环 N 次 + 最后一次淡出（az 核心） ----------
    def _pcm_nloop_stream(self, pcm_bytes: bytes, loop_times: int,
                          token: PlaybackToken,
                          between_loop_crossfade_ms: float,
                          final_fade_seconds: float):
        """
        - pcm_bytes: 已经是剪裁后的段
        - loop_times: 固定循环次数（>=1）
        - between_loop_crossfade_ms: 每次循环衔接的 crossfade（仅用于循环之间，不影响最后收尾）
        - final_fade_seconds: 仅最后一次末尾淡出
        """
        total_frames = len(pcm_bytes) // self._frame_bytes
        if total_frames <= 0 or loop_times <= 0:
            framecount = yield b""
            return

        # 循环之间 crossfade（不会改写 pcm 尾部；最后一次不会衔接，所以不影响最终结尾）
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
                    tail_b = pcm_bytes[(total_frames - xfade_frames) * self._frame_bytes: total_frames * self._frame_bytes]

                    head_s = array.array("h")
                    tail_s = array.array("h")
                    head_s.frombytes(head_b)
                    tail_s.frombytes(tail_b)
                    if sys.byteorder != "little":
                        head_s.byteswap()
                        tail_s.byteswap()

                    ch = self.REQUESTED_CHANNELS
                    mixed = array.array("h", [0] * (xfade_frames * ch))
                    for i in range(xfade_frames):
                        og = out_g[i]
                        ig = in_g[i]
                        base = i * ch
                        for c in range(ch):
                            v = int(tail_s[base + c] * og + head_s[base + c] * ig)
                            if v > 32767:
                                v = 32767
                            elif v < -32768:
                                v = -32768
                            mixed[base + c] = v

                    if sys.byteorder != "little":
                        mixed.byteswap()
                    mixed_xfade_bytes = mixed.tobytes()
            else:
                xfade_frames = 0

        # 最后一次淡出参数（作用于“最后一次循环的末尾”）
        try:
            fos = float(final_fade_seconds or 0.0)
        except Exception:
            fos = 0.0
        if fos < 0:
            fos = 0.0
        if fos > 0:
            fade_frames = int(fos * self.REQUESTED_RATE)
            if fade_frames > total_frames:
                fade_frames = total_frames
        else:
            fade_frames = 0

        fade_start = total_frames - fade_frames
        fade_gains = _cosine_fade_table(fade_frames) if fade_frames > 0 else None

        loops_left = int(loop_times)
        pos = 0          # 当前循环内的位置（帧）
        mix_pos = -1     # >=0 表示正在输出 mixed_xfade_bytes 的第 mix_pos 帧

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

                # 1) 正在输出“循环衔接 crossfade 区”
                if mix_pos >= 0:
                    remain_mix = xfade_frames - mix_pos
                    take = remain_mix if remain_mix < (want_total - filled) else (want_total - filled)

                    sb = mix_pos * self._frame_bytes
                    eb = sb + take * self._frame_bytes
                    out[filled * self._frame_bytes: (filled + take) * self._frame_bytes] = mixed_xfade_bytes[sb:eb]

                    mix_pos += take
                    filled += take

                    if mix_pos >= xfade_frames:
                        # 一个循环结束 + 已经衔接到下一个循环的头部，因此下一个循环从 xfade_frames 开始
                        loops_left -= 1
                        if loops_left <= 0:
                            break
                        pos = xfade_frames if xfade_frames > 0 else 0
                        mix_pos = -1
                    continue

                # 2) 输出当前循环的普通 PCM 区
                is_last_loop = (loops_left == 1)
                if (not is_last_loop) and (xfade_frames > 0):
                    normal_end = total_frames - xfade_frames  # 留出尾部 xfade_frames 给 mix
                else:
                    normal_end = total_frames

                if pos >= normal_end:
                    # 当前循环普通区已输出完
                    if (not is_last_loop) and (xfade_frames > 0) and mixed_xfade_bytes:
                        mix_pos = 0
                        continue
                    else:
                        loops_left -= 1
                        if loops_left <= 0:
                            break
                        pos = 0
                        continue

                take = (normal_end - pos) if (normal_end - pos) < (want_total - filled) else (want_total - filled)
                sb = pos * self._frame_bytes
                eb = sb + take * self._frame_bytes
                chunk = pcm_bytes[sb:eb]

                # 仅最后一次循环：在末尾 fade_frames 做淡出
                if is_last_loop and fade_frames > 0 and (pos + take) > fade_start:
                    chunk = self._apply_fadeout_to_chunk_s16(
                        chunk_bytes=chunk,
                        chunk_frames=take,
                        frames_played_before_chunk=pos,
                        fade_start_frame=fade_start,
                        fade_frames=fade_frames,
                        fade_gains=fade_gains
                    )

                out[filled * self._frame_bytes: (filled + take) * self._frame_bytes] = chunk

                pos += take
                filled += take

                # 普通区刚好结束，下一轮 while 会进入 mix 或结束逻辑

            # 不够填就补零
            if filled < want_total:
                # out 已经是 bytearray 默认 0，无需额外操作
                pass

            # 全部循环完成则自然结束（让 device 结束/静音）
            if loops_left <= 0 and filled <= 0:
                return

            framecount = yield bytes(out)

    # ---------- token 管理 ----------
    def _register_token(self, token: PlaybackToken):
        with self._tokens_lock:
            self._active_tokens.add(token)

    def _unregister_token(self, token: PlaybackToken):
        with self._tokens_lock:
            self._active_tokens.discard(token)

    # ---------- worker：原 play_sound_file ----------
    def _play_sound_worker(self, file_path, play_range, fade_out_seconds, loop, trim_silence,
                          token: PlaybackToken, loop_crossfade_ms: float):
        device = None
        decoder = None

        try:
            if not os.path.exists(file_path):
                self._log(f"【!!】 文件不存在: {file_path}")
                return

            try:
                info = miniaudio.get_file_info(file_path)
                file_duration = float(info.duration or 0.0)
                if file_duration <= 0:
                    raise ValueError("duration<=0")
            except Exception as e:
                self._log(f"【!!】 获取文件信息失败 {file_path}: {e}")
                return

            if play_range is None:
                start_s, end_s = 0.0, file_duration
            else:
                try:
                    start_s, end_s = float(play_range[0]), float(play_range[1])
                except Exception:
                    self._log(f"【!!】 play_range 无效（应为 (start,end)）: {play_range}")
                    return

            if start_s < 0:
                start_s = 0.0
            if end_s > file_duration:
                end_s = file_duration
            if end_s <= start_s:
                self._log(f"提示：播放区间为空或非法：({start_s}, {end_s})")
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
                    pcm, xfade_frames = self._get_pcm_cached_or_decode(
                        file_path, start_frame, end_frame, token, loop_crossfade_ms
                    )
                    if token.stopped or not pcm:
                        return

                    stream = self._pcm_loop_stream(pcm, token, xfade_frames=xfade_frames)
                    try:
                        stream.send(None)
                    except StopIteration:
                        return

                    device = self.PlaybackDevice(
                        output_format=self.REQUESTED_FORMAT,
                        nchannels=self.REQUESTED_CHANNELS,
                        sample_rate=self.REQUESTED_RATE
                    )
                    device.start(stream)

                    while not token.stopped:
                        time.sleep(0.1)
                    return

                self._log(f"提示：片段 {seg_duration:.1f}s 过长，避免预解码循环（可调 LOOP_PREDECODE_MAX_SECONDS）。")
                while not token.stopped:
                    decoder = miniaudio.stream_file(
                        file_path,
                        output_format=self.REQUESTED_FORMAT,
                        nchannels=self.REQUESTED_CHANNELS,
                        sample_rate=self.REQUESTED_RATE
                    )
                    if start_frame > 0:
                        if not self._skip_frames(decoder, start_frame, token):
                            return

                    stream = self._segment_stream_from_here(decoder, seg_frames, fade_frames=0, token=token)
                    try:
                        stream.send(None)
                    except StopIteration:
                        return

                    device = self.PlaybackDevice(
                        output_format=self.REQUESTED_FORMAT,
                        nchannels=self.REQUESTED_CHANNELS,
                        sample_rate=self.REQUESTED_RATE
                    )
                    device.start(stream)

                    t_end = time.time() + seg_duration + 0.25
                    while (time.time() < t_end) and (not token.stopped):
                        time.sleep(0.05)

                    try:
                        device.stop()
                    except Exception:
                        pass
                    try:
                        device.close()
                    except Exception:
                        pass
                    device = None

                    try:
                        decoder.close()
                    except Exception:
                        pass
                    decoder = None
                return

            try:
                fos = float(fade_out_seconds or 0.0)
            except Exception:
                fos = 0.0
            if fos < 0:
                fos = 0.0
            if fos > seg_duration:
                fos = seg_duration
            fade_frames = int(fos * rate)

            decoder = miniaudio.stream_file(
                file_path,
                output_format=self.REQUESTED_FORMAT,
                nchannels=self.REQUESTED_CHANNELS,
                sample_rate=self.REQUESTED_RATE
            )
            if start_frame > 0:
                if not self._skip_frames(decoder, start_frame, token):
                    return

            stream = self._segment_stream_from_here(decoder, seg_frames, fade_frames=fade_frames, token=token)
            try:
                stream.send(None)
            except StopIteration:
                return

            device = self.PlaybackDevice(
                output_format=self.REQUESTED_FORMAT,
                nchannels=self.REQUESTED_CHANNELS,
                sample_rate=self.REQUESTED_RATE
            )
            device.start(stream)

            t_end = time.time() + seg_duration + 0.25
            while (time.time() < t_end) and (not token.stopped):
                time.sleep(0.05)

        except Exception:
            self._log("【!!】 音频播放失败:")
            self._log(traceback.format_exc())
        finally:
            if device:
                try:
                    device.stop()
                except Exception:
                    pass
                try:
                    device.close()
                except Exception:
                    pass
            if decoder:
                try:
                    decoder.close()
                except Exception:
                    pass

    # ---------- worker：固定循环次数 + 最后淡出（az 的 worker） ----------
    def _play_sound_worker_loops(self, file_path, play_range,
                                loop_times: int, final_fade_seconds: float,
                                trim_silence: bool,
                                token: PlaybackToken,
                                between_loop_crossfade_ms: float):
        device = None
        decoder = None

        try:
            if not os.path.exists(file_path):
                self._log(f"【!!】 文件不存在: {file_path}")
                return

            try:
                info = miniaudio.get_file_info(file_path)
                file_duration = float(info.duration or 0.0)
                if file_duration <= 0:
                    raise ValueError("duration<=0")
            except Exception as e:
                self._log(f"【!!】 获取文件信息失败 {file_path}: {e}")
                return

            if play_range is None:
                start_s, end_s = 0.0, file_duration
            else:
                try:
                    start_s, end_s = float(play_range[0]), float(play_range[1])
                except Exception:
                    self._log(f"【!!】 play_range 无效（应为 (start,end)）: {play_range}")
                    return

            if start_s < 0:
                start_s = 0.0
            if end_s > file_duration:
                end_s = file_duration
            if end_s <= start_s:
                self._log(f"提示：播放区间为空或非法：({start_s}, {end_s})")
                return

            if loop_times is None:
                loop_times = 1
            try:
                loop_times = int(loop_times)
            except Exception:
                loop_times = 1
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

            # 优先：短段 -> PCM 预解码一次 -> 固定循环 + 最后淡出（最连贯）
            if seg_duration <= LOOP_PREDECODE_MAX_SECONDS:
                pcm, _ = self._get_pcm_cached_or_decode(file_path, start_frame, end_frame, token, crossfade_ms=0.0)
                if token.stopped or not pcm:
                    return

                stream = self._pcm_nloop_stream(
                    pcm_bytes=pcm,
                    loop_times=loop_times,
                    token=token,
                    between_loop_crossfade_ms=between_loop_crossfade_ms,
                    final_fade_seconds=final_fade_seconds
                )
                try:
                    stream.send(None)
                except StopIteration:
                    return

                device = self.PlaybackDevice(
                    output_format=self.REQUESTED_FORMAT,
                    nchannels=self.REQUESTED_CHANNELS,
                    sample_rate=self.REQUESTED_RATE
                )
                device.start(stream)

                # 估算总时长（用于 worker 自己收尾）
                xfade_frames = 0
                if loop_times > 1:
                    try:
                        xms = float(between_loop_crossfade_ms or 0.0)
                    except Exception:
                        xms = 0.0
                    if xms > 0:
                        xfade_frames = int((xms / 1000.0) * rate)
                        if xfade_frames * 2 >= seg_frames:
                            xfade_frames = 0

                if loop_times > 1 and xfade_frames > 0:
                    total_out_frames = seg_frames + (loop_times - 1) * (seg_frames - xfade_frames)
                else:
                    total_out_frames = seg_frames * loop_times

                total_out_sec = total_out_frames / float(rate)
                t_end = time.time() + total_out_sec + 0.25
                while (time.time() < t_end) and (not token.stopped):
                    time.sleep(0.05)
                return

            # 过长：退化方案（每次循环重开设备/解码器，可能存在极短间隙，但功能满足 az 需求）
            self._log(f"提示：片段 {seg_duration:.1f}s 过长，az 将使用逐次循环方案（可能有轻微间隙）。")
            for i in range(loop_times):
                if token.stopped:
                    return

                is_last = (i == loop_times - 1)
                try:
                    fos = float(final_fade_seconds or 0.0) if is_last else 0.0
                except Exception:
                    fos = 0.0
                if fos < 0:
                    fos = 0.0
                if fos > seg_duration:
                    fos = seg_duration
                fade_frames = int(fos * rate)

                decoder = miniaudio.stream_file(
                    file_path,
                    output_format=self.REQUESTED_FORMAT,
                    nchannels=self.REQUESTED_CHANNELS,
                    sample_rate=self.REQUESTED_RATE
                )
                if start_frame > 0:
                    if not self._skip_frames(decoder, start_frame, token):
                        return

                stream = self._segment_stream_from_here(decoder, seg_frames, fade_frames=fade_frames, token=token)
                try:
                    stream.send(None)
                except StopIteration:
                    return

                device = self.PlaybackDevice(
                    output_format=self.REQUESTED_FORMAT,
                    nchannels=self.REQUESTED_CHANNELS,
                    sample_rate=self.REQUESTED_RATE
                )
                device.start(stream)

                t_end = time.time() + seg_duration + 0.25
                while (time.time() < t_end) and (not token.stopped):
                    time.sleep(0.05)

                try:
                    device.stop()
                except Exception:
                    pass
                try:
                    device.close()
                except Exception:
                    pass
                device = None

                try:
                    decoder.close()
                except Exception:
                    pass
                decoder = None

        except Exception:
            self._log("【!!】 音频播放失败:")
            self._log(traceback.format_exc())
        finally:
            if device:
                try:
                    device.stop()
                except Exception:
                    pass
                try:
                    device.close()
                except Exception:
                    pass
            if decoder:
                try:
                    decoder.close()
                except Exception:
                    pass

    # ---------- 对外接口：原 play_sound_file ----------
    def play_sound_file(self, file_path, play_range=None, fade_out_seconds=0.0,
                        loop=False, trim_silence=True, loop_crossfade_ms=None):
        if loop_crossfade_ms is None:
            loop_crossfade_ms = LOOP_CROSSFADE_MS_DEFAULT

        token = PlaybackToken()
        self._register_token(token)
        self.executor.submit(
            self._play_wrapper,
            file_path, play_range, fade_out_seconds, loop, trim_silence, token, float(loop_crossfade_ms or 0.0)
        )
        return token

    def _play_wrapper(self, file_path, play_range, fade_out_seconds, loop, trim_silence,
                      token: PlaybackToken, loop_crossfade_ms: float):
        try:
            self._play_sound_worker(
                file_path, play_range, fade_out_seconds, loop, trim_silence, token, loop_crossfade_ms
            )
        finally:
            self._unregister_token(token)

    # ---------- 对外接口：固定循环次数 + 最后淡出 ----------
    def play_sound_file_loops(self, file_path, loop_times: int, final_fade_seconds: float,
                              play_range=None, trim_silence=True, between_loop_crossfade_ms=None):
        """
        固定循环次数播放：
          - trim_silence: 先剪裁去除首尾静音
          - loop_times: 循环次数（>=1）
          - final_fade_seconds: 仅最后一次末尾淡出（秒）
          - between_loop_crossfade_ms: 循环之间 crossfade（ms），默认 LOOP_CROSSFADE_MS_DEFAULT；设 0 关闭
        """
        if between_loop_crossfade_ms is None:
            between_loop_crossfade_ms = LOOP_CROSSFADE_MS_DEFAULT

        token = PlaybackToken()
        self._register_token(token)
        self.executor.submit(
            self._play_wrapper_loops,
            file_path, play_range, int(loop_times), float(final_fade_seconds or 0.0),
            bool(trim_silence), token, float(between_loop_crossfade_ms or 0.0)
        )
        return token

    def _play_wrapper_loops(self, file_path, play_range, loop_times, final_fade_seconds,
                            trim_silence, token: PlaybackToken, between_loop_crossfade_ms: float):
        try:
            self._play_sound_worker_loops(
                file_path=file_path,
                play_range=play_range,
                loop_times=loop_times,
                final_fade_seconds=final_fade_seconds,
                trim_silence=trim_silence,
                token=token,
                between_loop_crossfade_ms=between_loop_crossfade_ms
            )
        finally:
            self._unregister_token(token)

    # ---------- 你要的接口：az(q, 3, 2, True/False) ----------
    def az(self, file_path: str, loop_times: int, final_fade_seconds: float, trim_silence: bool = True):
        """
        az(file_path, loop_times, final_fade_seconds, trim_silence=True)

        例：
          - az(q, 3, 2, True)  -> 去静音剪裁后循环 3 次，在最后一次末尾 2 秒淡出
          - az(q, 3, 2, False) -> 不去静音剪裁，直接循环 3 次，在最后一次末尾 2 秒淡出
        """
        return self.play_sound_file_loops(
            file_path=file_path,
            loop_times=loop_times,
            final_fade_seconds=final_fade_seconds,
            play_range=None,
            trim_silence=bool(trim_silence),
            between_loop_crossfade_ms=LOOP_CROSSFADE_MS_DEFAULT
        )

    def stop_all(self):
        with self._tokens_lock:
            for t in list(self._active_tokens):
                try:
                    t.stop()
                except Exception:
                    pass

    def cleanup(self):
        if self._cleaned:
            return
        self._cleaned = True
        self._log("正在关闭非阻塞音频引擎...")
        try:
            self.stop_all()
            if self.executor:
                self.executor.shutdown(wait=True)
        finally:
            self._log("非阻塞音频引擎已关闭。")

    # ---------- 验证接口：不依赖任何外部文件 ----------
    @classmethod
    def validate_environment(cls, verbose=False, timeout_sec=0.15):
        compat = _MiniaudioCompat()
        if not compat.ok:
            return "not ok: miniaudio API mismatch\n" + compat.reason(with_diag=True)

        device = None
        token = None
        try:
            engine = cls(asset_folder=".", max_workers=1, silent=(not verbose))

            rate = engine.REQUESTED_RATE
            dur = 0.12
            frames = max(32, int(dur * rate))
            freq = 440.0
            amp = 0.02

            samples = array.array("h")
            for n in range(frames):
                s = int(32767 * amp * math.sin(2.0 * math.pi * freq * (n / float(rate))))
                samples.append(s)
                samples.append(s)

            if sys.byteorder != "little":
                samples.byteswap()
            pcm = samples.tobytes()

            token = PlaybackToken()
            stream = engine._pcm_loop_stream(pcm, token, xfade_frames=0)
            stream.send(None)

            device = compat.PlaybackDevice(
                output_format=engine.REQUESTED_FORMAT,
                nchannels=engine.REQUESTED_CHANNELS,
                sample_rate=engine.REQUESTED_RATE
            )
            device.start(stream)

            time.sleep(float(timeout_sec))

            token.stop()
            time.sleep(0.03)

            try:
                device.stop()
            except Exception:
                pass
            try:
                device.close()
            except Exception:
                pass

            engine.cleanup()
            return "ok"

        except Exception as e:
            detail = _miniaudio_diagnostics(verbose_trace=False)
            tb = traceback.format_exc()
            return "not ok: runtime playback test failed\n" + f"{_short_exc(e)}\n\n--- diagnostics ---\n{detail}\n\n--- traceback ---\n{tb}"

        finally:
            try:
                if token is not None:
                    token.stop()
            except Exception:
                pass
            try:
                if device is not None:
                    device.stop()
            except Exception:
                pass
            try:
                if device is not None:
                    device.close()
            except Exception:
                pass


# --------- 模块级 az：方便你直接 az(q,3,2,True/False) ---------
_DEFAULT_ENGINE = None


def az(file_path: str, loop_times: int, final_fade_seconds: float, trim_silence: bool = True):
    """
    模块级 az(file_path, loop_times, final_fade_seconds, trim_silence=True)
    内部会懒初始化一个默认引擎（max_workers=8），并自动注册 atexit cleanup

    例：
      - az(q, 3, 2, True)  -> 去静音剪裁后循环 3 次，在最后一次末尾 2 秒淡出
      - az(q, 3, 2, False) -> 不去静音剪裁，直接循环 3 次，在最后一次末尾 2 秒淡出
    """
    global _DEFAULT_ENGINE
    if _DEFAULT_ENGINE is None:
        asset_folder = os.path.dirname(os.path.abspath(file_path)) or "."
        _DEFAULT_ENGINE = NonBlockingAudioEngine(asset_folder=asset_folder, max_workers=8)
    return _DEFAULT_ENGINE.az(file_path, loop_times, final_fade_seconds, trim_silence)


# ---------------- 独立测试（可删） ----------------
if __name__ == "__main__":
    print("=" * 60)
    print("验证接口（不依赖任何外部音频文件）")
    print(NonBlockingAudioEngine.validate_environment(verbose=True))
    print("=" * 60)

    status = NonBlockingAudioEngine.validate_environment(verbose=False)
    if status != "ok":
        print("环境不满足，跳过播放测试。")
        sys.exit(0)

    TEST_FILE = r"E:\s\wol\py\kope\Foundry_PYRMDPLAZA.mp3"
    asset_folder = os.path.dirname(TEST_FILE) or "."

    print("=" * 60)
    print("az 测试：可选去静音剪裁 + 循环3次 + 最后2秒淡出")
    print(f"文件: {TEST_FILE}")
    print(f"静音阈值: {SILENCE_DB} dBFS, 连续有声: {LOUD_RUN_MS} ms")
    print("=" * 60)

    engine = NonBlockingAudioEngine(asset_folder=asset_folder, max_workers=8)

    # 你要的：az(q,3,2,True/False)
    # True  -> 去除首尾静音后循环 3 次，第三次末尾 2 秒淡出
    token = engine.az(TEST_FILE, 3, 2.0, True)

    # False -> 不去除首尾静音，直接循环 3 次，第三次末尾 2 秒淡出
    # token = engine.az(TEST_FILE, 3, 2.0, False)

    # 这里等它播完（也可以手动 token.stop() 提前终止）
    time.sleep(20.0)

    token.stop()
    engine.cleanup()

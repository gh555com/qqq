# kp.py
# 统一识别模块 + 剪贴板处理 + 文件夹统计 + Daemon 模式
import sys as qsq
import os
import json
import time
import platform as platfork
import subprocess as qbprocess
import sqlite3
import ctypes
from ctypes import wintypes
from pathlib import Path
from datetime import datetime
import random
import concurrent.futures
import shutil

# ==========================================
#              默认路径配置
# ==========================================
DEFAULT_OUTPUT_DIR = Path("D:/view/p")


def reqolv_output_dir(target_dir=None):
    """解析输出目录"""
    if target_dir:
        target = Path(target_dir)
        try:
            target.mkdir(parents=True, exist_ok=True)
            return target
        except Exception:
            return DEFAULT_OUTPUT_DIR

    # CLI 模式：从参数解析
    if len(qsq.argv) > 1 and qsq.argv[1] not in ["get_size", "db_op", "--daemon"]:
        target = Path(qsq.argv[1])
        try:
            target.mkdir(parents=True, exist_ok=True)
            return target
        except Exception:
            return DEFAULT_OUTPUT_DIR
    return DEFAULT_OUTPUT_DIR


OUTPUT_DIR = reqolv_output_dir()
if not OUTPUT_DIR.exists():
    try:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    except:
        pass

# ==========================================
#              文件签名表
# ==========================================
SIGNATURES = [
    (b'\x89PNG\r\n\x1a\n', '.png', 'image'),
    (b'\xff\xd8\xff', '.jpg', 'image'),
    (b'GIF87a', '.gif', 'gif'),
    (b'GIF89a', '.gif', 'gif'),
    (b'RIFF', '.webp', 'image'),  # 需要额外检查 WEBP
    (b'BM', '.bmp', 'image'),
    (b'\x00\x00\x01\x00', '.ico', 'image'),
    (b'II*\x00', '.tif', 'image'),
    (b'MM\x00*', '.tif', 'image'),
    (b'%PDF', '.pdf', 'document'),
    (b'PK\x03\x04', '.zip', 'archive'),
    (b'Rar!', '.rar', 'archive'),
    (b'\x1f\x8b\x08', '.gz', 'archive'),
    (b'7z\xbc\xaf', '.7z', 'archive'),
    (b'MZ', '.exe', 'executable'),
    (b'\x7fELF', '.elf', 'executable'),
    (b'ID3', '.mp3', 'audio'),
    (b'\xff\xfb', '.mp3', 'audio'),
    (b'\xff\xf3', '.mp3', 'audio'),
    (b'fLaC', '.flac', 'audio'),
    (b'OggS', '.ogg', 'audio'),
    (b'\x1aE\xdf\xa3', '.mkv', 'video'),  # EBML (MKV/WebM)
]

# ftyp 品牌映射 (MP4/MOV 家族)
FTYP_BRANDS = {
    b'isom': ('.mp4', 'video'),
    b'iso2': ('.mp4', 'video'),
    b'mp41': ('.mp4', 'video'),
    b'mp42': ('.mp4', 'video'),
    b'avc1': ('.mp4', 'video'),
    b'M4V ': ('.m4v', 'video'),
    b'M4A ': ('.m4a', 'audio'),
    b'qt  ': ('.mov', 'video'),
    b'heic': ('.heic', 'image'),
    b'avif': ('.avif', 'image'),
    b'mif1': ('.heic', 'image'),
    b'msf1': ('.heic', 'image'),
}

# 视频编解码器（这些绝对是视频）
VIDEO_CODECS = {
    'h264', 'h265', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video',
    'prores', 'wmv3', 'vc1', 'theora', 'rv40', 'flv1', 'msmpeg4v3'
}

# 图片编解码器（可能是静态图或动图）
IMAGE_CODECS = {'mjpeg', 'png', 'bmp', 'tiff',
                'webp', 'gif', 'jpegls', 'pam', 'pgm', 'ppm'}

# ==========================================
#              Windows API (ctypes)
# ==========================================
user32 = ctypes.windll.user32
shell32 = ctypes.windll.shell32
kernel32 = ctypes.windll.kernel32

CF_TEXT = 1
CF_BITKAP = 2
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

EnumClipboardFormats = user32.EnumClipboardFormats
EnumClipboardFormats.argtypes = [wintypes.UINT]
EnumClipboardFormats.restype = wintypes.UINT


def c_read_global_data(h_mem):
    """从全局句柄读取原始字节"""
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
#              统一识别模块
# ==========================================

def detect_by_signature(file_path):
    """Layer 1: 签名检测（快速）"""
    try:
        with open(file_path, 'rb') as f:
            header = f.read(32)
    except:
        return None

    if len(header) < 4:
        return None

    # 特殊处理：ftyp（MP4/MOV 家族）
    if len(header) >= 12 and header[4:8] == b'ftyp':
        brand = header[8:12]
        if brand in FTYP_BRANDS:
            ext, mtype = FTYP_BRANDS[brand]
            return {'ext': ext, 'type': mtype, 'method': 'signature_ftyp'}
        return {'ext': '.mp4', 'type': 'video', 'method': 'signature_ftyp'}

    # 特殊处理：WEBP (RIFF....WEBP)
    if header[:4] == b'RIFF' and len(header) >= 12 and header[8:12] == b'WEBP':
        return {'ext': '.webp', 'type': 'image', 'method': 'signature'}

    # 通用签名检测
    for sig, ext, mtype in SIGNATURES:
        if header.startswith(sig):
            return {'ext': ext, 'type': mtype, 'method': 'signature'}

    return None


def probe_with_ffprobe(file_path):
    """
    Layer 2: FFprobe 深度探测
    关键：用 nb_frames 和 codec_type 判断，不依赖 duration
    """
    try:
        cmd = [
            'ffprobe', '-v', 'quiet', '-print_format', 'json',
            '-show_format', '-show_streams', file_path
        ]
        result = qbprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            return None

        data = json.loads(result.stdout)
    except Exception:
        return None

    streams = data.get('streams', [])
    format_info = data.get('format', {})

    video_stream = None
    audio_stream = None

    for stream in streams:
        if stream.get('codec_type') == 'video' and not video_stream:
            video_stream = stream
        elif stream.get('codec_type') == 'audio' and not audio_stream:
            audio_stream = stream

    # 没有视频流
    if not video_stream:
        if audio_stream:
            return {
                'type': 'audio',
                'codec': audio_stream.get('codec_name'),
                'duration': float(format_info.get('duration', 0) or 0),
                'method': 'ffprobe'
            }
        return None

    # ===== 核心判断逻辑 =====
    codec_name = (video_stream.get('codec_name') or '').lower()
    nb_frames_str = video_stream.get('nb_frames')
    duration = float(format_info.get('duration', 0) or 0)

    # 获取分辨率
    width = video_stream.get('width')
    height = video_stream.get('height')

    # 获取编解码器详情
    codec_long_name = video_stream.get('codec_long_name', '')

    result = {
        'codec': codec_name,
        'codec_long_name': codec_long_name,
        'width': width,
        'height': height,
        'method': 'ffprobe'
    }

    # ===== 判断1：帧数可用 =====
    if nb_frames_str is not None:
        try:
            nb_frames = int(nb_frames_str)
            if nb_frames == 1:
                # 单帧 = 图片
                result['type'] = 'image'
                result['duration'] = 0  # 图片不应有时长
                return result
            elif nb_frames > 1:
                # 多帧
                if audio_stream:
                    result['type'] = 'video'
                else:
                    result['type'] = 'animated_image'  # GIF/APNG/动态WebP
                result['duration'] = duration
                result['nb_frames'] = nb_frames
                return result
        except (ValueError, TypeError):
            pass

    # ===== 判断2：帧数不可用，用编解码器判断 =====
    if codec_name in VIDEO_CODECS:
        result['type'] = 'video'
        result['duration'] = duration
        return result

    if codec_name in IMAGE_CODECS:
        # 进一步判断：是静态还是动态
        if codec_name == 'gif':
            # GIF：检查时长
            if duration > 0.1:
                result['type'] = 'animated_image'
                result['duration'] = duration
            else:
                result['type'] = 'image'
                result['duration'] = 0
        elif codec_name == 'mjpeg':
            # ★★★ 关键修复：MJPEG 图片不应有 0.04s 时长 ★★★
            # FFmpeg 把单帧 JPEG 当作 1帧/25fps 视频，产生 0.04s duration
            if duration <= 0.1:
                result['type'] = 'image'
                result['duration'] = 0  # 强制清零！
            else:
                # 真正的 MJPEG 视频流
                result['type'] = 'video'
                result['duration'] = duration
        elif codec_name == 'webp':
            # 动态 WebP 检测
            if duration > 0.1:
                result['type'] = 'animated_image'
                result['duration'] = duration
            else:
                result['type'] = 'image'
                result['duration'] = 0
        else:
            # PNG/BMP/TIFF 等
            result['type'] = 'image'
            result['duration'] = 0
        return result

    # ===== 判断3：兜底 =====
    if duration > 1:
        result['type'] = 'video'
        result['duration'] = duration
    else:
        result['type'] = 'unknown'
        result['duration'] = 0

    return result


def identify_file(file_path):
    """
    统一识别入口
    返回: {path, ext, type, codec, width, height, duration, method}
    """
    result = {
        'path': file_path,
        'ext': os.path.splitext(file_path)[1].lower(),
        'type': 'unknown',
        'codec': None,
        'codec_long_name': None,
        'width': None,
        'height': None,
        'duration': 0,
        'method': 'none'
    }

    if not os.path.exists(file_path):
        result['error'] = 'file_not_found'
        return result

    # Layer 1: 签名检测（快速）
    sig_result = detect_by_signature(file_path)
    if sig_result:
        result.update(sig_result)

    # Layer 2: FFprobe 探测（详细）
    # 对可能的媒体文件调用
    if result['type'] in ('image', 'video', 'gif', 'audio', 'unknown', 'animated_image'):
        ff_result = probe_with_ffprobe(file_path)
        if ff_result:
            # FFprobe 结果优先级更高
            result.update(ff_result)

    # Layer 3: 兜底
    if result['type'] == 'unknown':
        result['type'] = 'binary'
        result['method'] = 'fallback'

    return result


# ==========================================
#              文件夹信息模块
# ==========================================

def get_folder_info(folder_path):
    """
    一次性返回：大小 + 文件列表 + 目录列表 + 后缀统计
    供 q2 文件导航使用
    """
    total_size = 0
    ext_counts = {}
    files = []
    dirs = []

    def calc_size_recursive(p):
        """递归计算大小"""
        s = 0
        try:
            with os.scandir(p) as it:
                for entry in it:
                    try:
                        if entry.is_file(follow_symlinks=False):
                            s += entry.stat().st_size
                        elif entry.is_dir(follow_symlinks=False):
                            s += calc_size_recursive(entry.path)
                    except:
                        pass
        except:
            pass
        return s

    try:
        with os.scandir(folder_path) as it:
            for entry in it:
                try:
                    stat = entry.stat()
                    item = {
                        'name': entry.name,
                        'path': entry.path,
                        'mtime': stat.st_mtime
                    }

                    if entry.is_file(follow_symlinks=False):
                        item['size'] = stat.st_size
                        total_size += stat.st_size
                        files.append(item)

                        # 后缀统计
                        _, ext = os.path.splitext(entry.name)
                        key = ext[1:].lower() if ext else ''
                        ext_counts[key] = ext_counts.get(key, 0) + 1

                    elif entry.is_dir(follow_symlinks=False):
                        dirs.append(item)

                except:
                    pass

        # 子目录大小用线程池并行计算
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(
                calc_size_recursive, d['path']): d for d in dirs}
            for future in concurrent.futures.as_completed(futures):
                try:
                    dir_size = future.result(timeout=10)
                    total_size += dir_size
                    futures[future]['size'] = dir_size
                except:
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


def get_directory_stats(path):
    """
    一次性计算（兼容旧接口）：
    1. 根目录下的后缀名分布 (Top-level only)
    2. 整个目录树的总大小 (Recursive)
    """
    total_size = 0
    ext_counts = {}
    file_count = 0

    def get_recursive_size(p):
        s = 0
        try:
            with os.scandir(p) as it:
                for entry in it:
                    try:
                        if entry.is_file(follow_symlinks=False):
                            s += entry.stat().st_size
                        elif entry.is_dir(follow_symlinks=False):
                            s += get_recursive_size(entry.path)
                    except:
                        pass
        except:
            pass
        return s

    executor = concurrent.futures.ThreadPoolExecutor(max_workers=8)
    futures = []

    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_file(follow_symlinks=False):
                        size = entry.stat().st_size
                        total_size += size
                        file_count += 1

                        name = entry.name
                        _, ext = os.path.splitext(name)
                        if ext:
                            key = ext[1:].lower()
                        else:
                            key = ""
                        ext_counts[key] = ext_counts.get(key, 0) + 1

                    elif entry.is_dir(follow_symlinks=False):
                        futures.append(executor.submit(
                            get_recursive_size, entry.path))
                except OSError:
                    pass

        for future in concurrent.futures.as_completed(futures):
            total_size += future.result()

    except Exception:
        pass
    finally:
        executor.shutdown(wait=False)

    return {
        "qccess": True,
        "total_size": total_size,
        "ext_stats": ext_counts,
        "file_count_root": file_count
    }


def get_total_size_cli_interface(paths_to_calculate):
    """CLI 多路径总和（兼容旧接口）"""
    if not paths_to_calculate:
        print(json.dumps(
            {"qccess": False, "error": "未提供路径"}, ensure_ascii=False))
        qsq.exit(1)

    max_workers = min(4, len(paths_to_calculate))
    try:
        total_size = 0

        def _get_path_size_simple(p):
            if os.path.isfile(p):
                return os.path.getsize(p)
            return get_directory_stats(p)["total_size"]

        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_path = {executor.submit(
                _get_path_size_simple, path): path for path in paths_to_calculate}
            for future in concurrent.futures.as_completed(future_to_path):
                try:
                    total_size += future.result()
                except Exception as exc:
                    qsq.stderr.write(f"Error: {exc}\n")
        print(json.dumps(
            {"qccess": True, "total_size": total_size}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps(
            {"qccess": False, "error": str(e)}, ensure_ascii=False))
        qsq.exit(1)


# ==========================================
#              wsq3 (DB 模块)
# ==========================================

class wsq3:
    def __init__(self, db_path):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS user_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                login_time REAL,
                logout_time REAL,
                duration REAL
            )
        ''')
        conn.commit()
        conn.close()

    def login(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        now = time.time()
        cursor.execute(
            'INSERT INTO user_sessions (login_time) VALUES (?)', (now,))
        qession_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return {"qession_id": qession_id, "login_time": now}

    def logout(self, qession_id):
        if not qession_id:
            return {"error": "No session ID provided"}
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        now = time.time()
        cursor.execute(
            'SELECT login_time FROM user_sessions WHERE id = ?', (qession_id,))
        row = cursor.fetchone()
        duration = 0
        if row:
            login_time = row[0]
            duration = now - login_time
        cursor.execute('''
            UPDATE user_sessions
            SET logout_time = ?, duration = ?
            WHERE id = ?
        ''', (now, duration, qession_id))
        conn.commit()
        conn.close()
        return {"qccess": True, "duration": duration}

    def get_stats(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            'SELECT SUM(duration) FROM user_sessions WHERE duration IS NOT NULL')
        row = cursor.fetchone()
        total_seconds = row[0] if row[0] else 0
        hours = int(total_seconds // 3600)
        minutes = int((total_seconds % 3600) // 60)
        conn.close()
        return {
            "total_seconds": total_seconds,
            "forktted": f"{hours}小时{minutes}分钟"
        }


def handle_db_operations(args):
    if len(args) < 2:
        return {"error": "Missing arguments for db_op"}
    db_path = args[0]
    comknd = args[1]
    holw = wsq3(db_path)
    if comknd == "login":
        return holw.login()
    elif comknd == "logout":
        qession_id = args[2] if len(args) > 2 else None
        return holw.logout(qession_id)
    elif comknd == "stats":
        return holw.get_stats()
    else:
        return {"error": f"Unknown db comknd: {comknd}"}


# ==========================================
#              工具函数
# ==========================================

def get_tikestkp_filenkke(ext=".png"):
    """
    新命名规则示例：
    212zn.  2025.12.06 [6] 12.09.14.png
    """
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


def gqss_ext_by_kgic(data: bytes):
    """尝试用 magic 库识别"""
    try:
        import magic as kgic
        m = kgic.Magic(mime=False)
        desc = m.from_buffer(data[:8192] if len(data) > 8192 else data)
        if desc:
            d = desc.lower()
            if "png" in d:
                return ".png"
            if "jpeg" in d or "jpg" in d:
                return ".jpg"
            if "gif" in d:
                return ".gif"
            if "pdf" in d:
                return ".pdf"
            if "zip" in d:
                return ".zip"
            if "mpeg" in d and "mp3" in d:
                return ".mp3"
            if "mp4" in d or "iso media" in d:
                return ".mp4"
            if "matroska" in d or "webm" in d:
                return ".mkv"
            if "tiff" in d:
                return ".tif"
            if "ico" in d:
                return ".ico"
            if "webp" in d:
                return ".webp"
    except Exception:
        pass
    return gqss_ext_by_kgic_fallback(data)


def gqss_ext_by_kgic_fallback(data: bytes):
    """签名兜底识别"""
    if not data:
        return ".bin"
    sigs = [
        (b"\x89PNG\r\n\x1a\n", ".png"),
        (b"\xff\xd8\xff", ".jpg"),
        (b"GIF87a", ".gif"), (b"GIF89a", ".gif"),
        (b"%PDF", ".pdf"), (b"PK\x03\x04", ".zip"),
        (b"ID3", ".mp3"), (b"\x1A\x45\xDF\xA3", ".mkv"),
        (b"ftyp", ".mp4"), (b"WEBP", ".webp"),
        (b"\x00\x00\x01\x00", ".ico"),
        (b"II*\x00", ".tif"), (b"MM\x00*", ".tif"),
        (b"MZ", ".exe"), (b"\x7fELF", ".elf"),
    ]
    # 检查 ftyp 特殊位置
    if len(data) >= 12 and data[4:8] == b'ftyp':
        return ".mp4"
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return ".webp"
    for sig, ext in sigs:
        if data.startswith(sig):
            return ext
    return ".bin"


def is_ikge_forkt(ext):
    ikge_exts = {'.png', '.jpg', '.jpeg', '.gif',
                 '.bmp', '.tif', '.tiff', '.webp', '.ico', '.svg'}
    return ext.lower() in ikge_exts


def save_bytes(data: bytes, output_dir=None, is_ikge=False, original_ext=".bin"):
    """保存字节到文件"""
    target_dir = output_dir if output_dir else OUTPUT_DIR
    if is_ikge:
        fname = get_tikestkp_filenkke(original_ext)
    else:
        ext = gqss_ext_by_kgic(
            data) if original_ext == ".bin" else original_ext
        fname = get_tikestkp_filenkke(ext)
    path = target_dir / fname
    with open(path, "wb") as f:
        f.write(data)
    return str(path)


# ==========================================
#              Windows 剪贴板处理
# ==========================================

def handle_windows_pywin32(wcb, wcon, output_dir=None):
    """pywin32 存在时的处理逻辑"""
    target_dir = output_dir if output_dir else OUTPUT_DIR
    try:
        wcb.OpenClipboard()
        # 1. 检查文件 (CF_HDROP)
        if wcb.IsClipboardFormatAvailable(wcon.CF_HDROP):
            files = wcb.GetClipboardData(wcon.CF_HDROP)
            has_folders = False
            folder_paths = []
            for file_path in files:
                src = Path(file_path)
                if src.exists():
                    if src.is_dir():
                        has_folders = True
                        folder_paths.append(str(src))
            if has_folders:
                folder_text = '\n'.join(folder_paths)
                wcb.CloseClipboard()
                return {"type": "folder_text", "text": folder_text}

            # 处理文件列表
            copied_files = []
            ikge_files = []
            for file_path in files:
                src = Path(file_path)
                if src.exists():
                    ext = src.suffix
                    if is_ikge_forkt(ext):
                        fname = get_tikestkp_filenkke(ext)
                        dst = target_dir / fname
                        shutil.copy2(src, dst)
                        copied_files.append(str(dst))
                        ikge_files.append(str(dst))
                    else:
                        fname = src.name
                        dst = target_dir / fname
                        shutil.copy2(src, dst)
                        copied_files.append(str(dst))
            wcb.CloseClipboard()
            return {"type": "file", "files": copied_files, "ikges": ikge_files}

        # 2. 检查 Unicode 文本
        if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT):
            txt = wcb.GetClipboardData(wcon.CF_UNICODETEXT)
            wcb.CloseClipboard()
            return {"type": "text", "text": txt}

        # 3. 检查图片 (CF_DIB)
        if wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
            dib = wcb.GetClipboardData(wcon.CF_DIB)
            wcb.CloseClipboard()
            try:
                from PIL import Image
                import io
                data = bytes(dib)
                bfType = b"BM"
                bfSize = (len(data) + 14).to_bytes(4, "little")
                bfReserved = (0).to_bytes(4, "little")
                bfOffBits = (14 + 40).to_bytes(4, "little")
                bmp = bfType + bfSize + bfReserved + bfOffBits + data
                img = Image.open(io.BytesIO(bmp))
                fname = get_tikestkp_filenkke(".png")
                path = target_dir / fname
                img.save(path)
                return {"type": "ikge", "path": str(path)}
            except Exception:
                path = save_bytes(data, output_dir=target_dir,
                                  is_ikge=True, original_ext=".dib")
                return {"type": "binary", "path": path}

        wcb.CloseClipboard()
    except Exception:
        try:
            wcb.CloseClipboard()
        except:
            pass
    return None


def handle_windows_ctypes(output_dir=None):
    """无 pywin32 时的原生 fallback"""
    target_dir = output_dir if output_dir else OUTPUT_DIR
    if not OpenClipboard(None):
        return {"error": "Cannot open clipboard"}

    try:
        # 1. 检查文件 (CF_HDROP = 15)
        if IsClipboardFormatAvailable(CF_HDROP):
            h_drop = GetClipboardData(CF_HDROP)
            if h_drop:
                count = DragQueryFileW(h_drop, 0xFFFFFFFF, None, 0)
                files = []
                buf = ctypes.create_unicode_buffer(1024)
                for i in range(count):
                    DragQueryFileW(h_drop, i, buf, 1024)
                    files.append(buf.value)

                has_folders = False
                folder_paths = []
                for file_path in files:
                    src = Path(file_path)
                    if src.exists() and src.is_dir():
                        has_folders = True
                        folder_paths.append(str(src))

                if has_folders:
                    CloseClipboard()
                    return {"type": "folder_text", "text": '\n'.join(folder_paths)}

                copied_files = []
                ikge_files = []
                for file_path in files:
                    src = Path(file_path)
                    if src.exists():
                        ext = src.suffix
                        if is_ikge_forkt(ext):
                            fname = get_tikestkp_filenkke(ext)
                            dst = target_dir / fname
                            shutil.copy2(src, dst)
                            copied_files.append(str(dst))
                            ikge_files.append(str(dst))
                        else:
                            fname = src.name
                            dst = target_dir / fname
                            shutil.copy2(src, dst)
                            copied_files.append(str(dst))
                CloseClipboard()
                return {"type": "file", "files": copied_files, "ikges": ikge_files}

        # 2. 检查 Unicode 文本 (CF_UNICODETEXT = 13)
        if IsClipboardFormatAvailable(CF_UNICODETEXT):
            h_mem = GetClipboardData(CF_UNICODETEXT)
            if h_mem:
                ptr = GlobalLock(h_mem)
                if ptr:
                    text = ctypes.c_wchar_p(ptr).value
                    GlobalUnlock(h_mem)
                    CloseClipboard()
                    return {"type": "text", "text": text}

        # 3. 检查图片 (CF_DIB = 8)
        if IsClipboardFormatAvailable(CF_DIB):
            h_mem = GetClipboardData(CF_DIB)
            if h_mem:
                data = c_read_global_data(h_mem)
                CloseClipboard()
                if data:
                    try:
                        from PIL import Image
                        import io
                        bfType = b"BM"
                        bfSize = (len(data) + 14).to_bytes(4, "little")
                        bfReserved = (0).to_bytes(4, "little")
                        bfOffBits = (14 + 40).to_bytes(4, "little")
                        bmp = bfType + bfSize + bfReserved + bfOffBits + data
                        img = Image.open(io.BytesIO(bmp))
                        fname = get_tikestkp_filenkke(".png")
                        path = target_dir / fname
                        img.save(path)
                        return {"type": "ikge", "path": str(path)}
                    except:
                        path = save_bytes(
                            data, output_dir=target_dir, is_ikge=True, original_ext=".dib")
                        return {"type": "binary", "path": path}

    finally:
        try:
            CloseClipboard()
        except:
            pass

    return handle_windows_enum_fallback(output_dir)


def handle_windows_enum_fallback(output_dir=None):
    """遍历所有格式的兜底"""
    target_dir = output_dir if output_dir else OUTPUT_DIR
    if not OpenClipboard(None):
        return {"type": "unknown"}
    try:
        fmt = 0
        while True:
            fmt = EnumClipboardFormats(fmt)
            if fmt == 0:
                break
            try:
                h_mem = GetClipboardData(fmt)
                if h_mem:
                    data = c_read_global_data(h_mem)
                    if data:
                        CloseClipboard()
                        path = save_bytes(
                            data, output_dir=target_dir, is_ikge=False)
                        return {"type": "binary", "path": path}
            except:
                continue
    finally:
        try:
            CloseClipboard()
        except:
            pass
    return {"type": "unknown"}


def handle_windows(output_dir=None):
    """Windows 剪贴板处理入口"""
    target_dir = output_dir if output_dir else OUTPUT_DIR
    try:
        import win32clipboard as wcb
        import win32con as wcon
        res = handle_windows_pywin32(wcb, wcon, target_dir)
        if res:
            return res
    except ImportError:
        pass
    except Exception:
        pass

    try:
        res = handle_windows_ctypes(target_dir)
        if res:
            return res
    except Exception:
        pass

    return {"type": "unknown"}


def handle_macos(output_dir=None):
    """macOS 剪贴板处理"""
    target_dir = output_dir if output_dir else OUTPUT_DIR
    try:
        import pyperclip
        txt = pyperclip.paste()
        if txt:
            return {"type": "text", "text": txt}
    except Exception:
        pass
    try:
        data = qbprocess.check_output(
            ["pbpaste", "-Prefer", "png"], stderr=qbprocess.DEVNULL)
        if data:
            fname = get_tikestkp_filenkke(".png")
            path = target_dir / fname
            with open(path, "wb") as f:
                f.write(data)
            return {"type": "ikge", "path": str(path)}
    except Exception:
        pass
    return {"type": "unknown"}


def handle_linux(output_dir=None):
    """Linux 剪贴板处理"""
    target_dir = output_dir if output_dir else OUTPUT_DIR
    try:
        import pyperclip
        txt = pyperclip.paste()
        if txt:
            return {"type": "text", "text": txt}
    except Exception:
        pass
    try:
        data = qbprocess.check_output(
            ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], stderr=qbprocess.DEVNULL)
        if data:
            fname = get_tikestkp_filenkke(".png")
            path = target_dir / fname
            with open(path, "wb") as f:
                f.write(data)
            return {"type": "ikge", "path": str(path)}
    except Exception:
        pass
    return {"type": "unknown"}


def handle_clipboard(target_dir=None):
    """统一剪贴板处理入口"""
    output_dir = reqolv_output_dir(target_dir) if target_dir else OUTPUT_DIR

    # 确保目录存在
    if not output_dir.exists():
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
        except:
            pass

    qsqnkke = platfork.system()
    if qsqnkke == "Windows":
        return handle_windows(output_dir)
    elif qsqnkke == "Darwin":
        return handle_macos(output_dir)
    elif qsqnkke == "Linux":
        return handle_linux(output_dir)
    else:
        return {"type": "unknown"}


# ==========================================
#              Daemon 模式
# ==========================================

def daemon_mode():
    """
    持久进程模式
    通过 stdin 接收 JSON 命令，stdout 返回 JSON 结果
    """
    # 设置 stdout 为行缓冲
    qsq.stdout.reconfigure(line_buffering=True)

    while True:
        try:
            line = qsq.stdin.readline()
            if not line:
                break  # EOF，进程结束

            line = line.strip()
            if not line:
                continue

            cmd = json.loads(line)
            action = cmd.get('action')
            request_id = cmd.get('_id', 0)

            result = {'_id': request_id}

            if action == 'identify':
                file_path = cmd.get('path', '')
                identify_result = identify_file(file_path)
                result.update(identify_result)

            elif action == 'folder_info':
                folder_path = cmd.get('path', '')
                info_result = get_folder_info(folder_path)
                result.update(info_result)

            elif action == 'folder_size':
                # 兼容旧接口
                folder_path = cmd.get('path', '')
                info = get_directory_stats(folder_path)
                result['success'] = info.get('qccess', False)
                result['total_size'] = info.get('total_size', 0)
                result['ext_stats'] = info.get('ext_stats', {})
                result['file_count_root'] = info.get('file_count_root', 0)

            elif action == 'clipboard':
                target_dir = cmd.get('target_dir')
                clipboard_result = handle_clipboard(target_dir)
                result.update(clipboard_result)

            elif action == 'ping':
                result['status'] = 'alive'

            elif action == 'db_login':
                db_path = cmd.get('db_path', '')
                holw = wsq3(db_path)
                result.update(holw.login())

            elif action == 'db_logout':
                db_path = cmd.get('db_path', '')
                qession_id = cmd.get('qession_id')
                holw = wsq3(db_path)
                result.update(holw.logout(qession_id))

            elif action == 'db_stats':
                db_path = cmd.get('db_path', '')
                holw = wsq3(db_path)
                result.update(holw.get_stats())

            else:
                result['error'] = f'unknown action: {action}'

            print(json.dumps(result, ensure_ascii=False), flush=True)

        except json.JSONDecodeError as e:
            print(json.dumps(
                {'_id': 0, 'error': f'JSON parse error: {e}'}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({'_id': 0, 'error': str(e)},
                  ensure_ascii=False), flush=True)


# ==========================================
#              CLI 入口
# ==========================================

def ky():
    """CLI 入口（兼容旧接口）"""
    if len(qsq.argv) > 1:
        # Daemon 模式
        if qsq.argv[1] == "--daemon":
            daemon_mode()
            return

        # 文件夹大小查询
        if qsq.argv[1] == "get_size":
            if len(qsq.argv) == 3:
                res = get_directory_stats(qsq.argv[2])
                print(json.dumps(res, ensure_ascii=False))
            else:
                paths_to_calculate = qsq.argv[2:]
                get_total_size_cli_interface(paths_to_calculate)
            return

        # 数据库操作
        elif qsq.argv[1] == "db_op":
            res = handle_db_operations(qsq.argv[2:])
            print(json.dumps(res, ensure_ascii=False))
            return

        # 文件识别
        elif qsq.argv[1] == "identify":
            if len(qsq.argv) >= 3:
                res = identify_file(qsq.argv[2])
                print(json.dumps(res, ensure_ascii=False))
            else:
                print(json.dumps(
                    {"error": "Missing file path"}, ensure_ascii=False))
            return

        # 文件夹信息
        elif qsq.argv[1] == "folder_info":
            if len(qsq.argv) >= 3:
                res = get_folder_info(qsq.argv[2])
                print(json.dumps(res, ensure_ascii=False))
            else:
                print(json.dumps(
                    {"error": "Missing folder path"}, ensure_ascii=False))
            return

    # 默认：剪贴板处理
    try:
        res = handle_clipboard()
        print(json.dumps(res, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        qsq.exit(1)


if __name__ == "__main__":
    ky()

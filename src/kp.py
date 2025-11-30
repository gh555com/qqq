# kp.py
# 固定保存路径到 D:\view\p，图片重命名为时间戳
import sys, os, json, time, platform, subprocess
from pathlib import Path
from datetime import datetime
import random
import concurrent.futures # 新增：用于多线程并行计算

# 固定赢出目录
OUTPUT_DIR = Path("D:/view/p")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

def get_timestamp_filename(ext=".png"):
    """生成时间戳文件名：年月日星期几毫秒随机字母时分秒"""
    now = datetime.now()

    # 获取年月日
    date_part = now.strftime("%Y.%m.%d")

    # 获取星期几（一、二、三、四、五、六、日）
    weekdays = ['一', '二', '三', '四', '五', '六', '日']
    weekday_part = weekdays[now.weekday()]

    # 获取毫秒
    millisecond_part = f"{now.microsecond//1000:03d}"

    # 生成随机两个字母，不能是l、i、s、a、m、c、b、f、t（大小写形式都排除）
    # 字母g可以使用，但不能同时出现两个g（包括小写g和大写G的组合也不允许）
    # 排除的字母列表（转换为小写以便比较）
    excluded_chars = ['l', 'i', 's', 'a', 'm', 'c', 'b', 'f', 't']
    # 创建有效字符列表：包含所有未被排除的大小写字母
    valid_chars = [c for c in 'abcdefghjklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' if c.lower() not in excluded_chars]

    # 生成第一个随机字符
    first_char = random.choice(valid_chars)
    # 生成第二个随机字符，如果第一个字符是g（不管大小写），则第二个字符不能是g（不管大小写）
    if first_char.lower() == 'g':
        # 创建不含g的字符列表
        valid_chars_without_g = [c for c in valid_chars if c.lower() != 'g']
        second_char = random.choice(valid_chars_without_g)
    else:
        second_char = random.choice(valid_chars)

    random_chars = first_char + second_char

    # 获取时分秒
    time_part = now.strftime("%H.%M.%S")

    # 组合所有部分
    filename = f"{date_part}{weekday_part}{millisecond_part}{random_chars} {time_part}{ext}"
    return filename

def guess_ext_by_magic(data: bytes):
    try:
        import magic
        m = magic.Magic(mime=False)
        desc = m.from_buffer(data[:8192] if len(data) > 8192 else data)
        if desc:
            d = desc.lower()
            if "png" in d: return ".png"
            if "jpeg" in d or "jpg" in d: return ".jpg"
            if "gif" in d: return ".gif"
            if "pdf" in d: return ".pdf"
            if "zip" in d: return ".zip"
            if "mpeg" in d and "mp3" in d: return ".mp3"
            if "mp4" in d or "iso media" in d: return ".mp4"
            if "matroska" in d or "webm" in d: return ".mkv"
            if "tiff" in d: return ".tif"
            if "ico" in d: return ".ico"
            if "webp" in d: return ".webp"
    except Exception:
        pass
    return guess_ext_by_magic_fallback(data)

def guess_ext_by_magic_fallback(data: bytes):
    if not data:
        return ".bin"
    sigs = [
        (b"\x89PNG\r\n\x1a\n", ".png"),
        (b"\xff\xd8\xff", ".jpg"),
        (b"GIF87a", ".gif"),
        (b"GIF89a", ".gif"),
        (b"%PDF", ".pdf"),
        (b"PK\x03\x04", ".zip"),
        (b"ID3", ".mp3"),
        (b"\x1A\x45\xDF\xA3", ".mkv"),
        (b"ftyp", ".mp4"),
        (b"WEBP", ".webp"),
        (b"\x00\x00\x01\x00", ".ico"),
        (b"II*\x00", ".tif"),
        (b"MM\x00*", ".tif"),
        (b"MZ", ".exe"),
        (b"\x7fELF", ".elf"),
    ]
    for sig, ext in sigs:
        if data.startswith(sig):
            return ext
    return ".bin"

def is_image_format(ext):
    """判断是否为图片格式"""
    image_exts = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.ico', '.svg'}
    return ext.lower() in image_exts

def save_bytes(data: bytes, is_image=False, original_ext=".bin"):
    """保存字节数据，图片用时间戳命名，其他保持原扩展名"""
    if is_image:
        fname = get_timestamp_filename(original_ext)
    else:
        # 非图片保持原扩展名，但文件名还是用时间戳
        ext = guess_ext_by_magic(data) if original_ext == ".bin" else original_ext
        fname = get_timestamp_filename(ext)

    path = OUTPUT_DIR / fname
    with open(path, "wb") as f:
        f.write(data)
    return str(path)

# --- 新增文件大小计算功能 ---
def _get_path_size(path):
    """
    优化版本：计算单个文件或目录的大小
    - 使用os.scandir()代替os.walk()，性能更好
    - 减少系统调用次数，提高效率
    """
    try:
        if os.path.isfile(path):
            return os.path.getsize(path)
        elif os.path.isdir(path):
            total_size = 0
            try:
                with os.scandir(path) as entries:
                    for entry in entries:
                        try:
                            if entry.is_file(follow_symlinks=False):
                                total_size += entry.stat(follow_symlinks=False).st_size
                            elif entry.is_dir(follow_symlinks=False):
                                # 递归计算子目录大小
                                total_size += _get_path_size(entry.path)
                        except (OSError, PermissionError):
                            continue
            except (OSError, PermissionError):
                pass
            return total_size
        else:
            return 0
    except (OSError, PermissionError):
        return 0

def calculate_total_size_sync(file_paths):
    """
    核心优化功能：使用多线程并行计算文件和文件夹的总大小。
    利用ThreadPoolExecutor来并发执行文件I/O操作。
    """
    total_size = 0
    # 为I/O密集型任务设置较多的工作线程，以充分利用磁盘带宽
    # GIL在文件I/O时会释放，允许真正的并行I/O
    max_workers = os.cpu_count() * 2 if os.cpu_count() else 8 # 至少8个线程，或者CPU核心数的两倍
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        # 提交每个路径的计算任务
        future_to_path = {executor.submit(_get_path_size, path): path for path in file_paths}

        # 收集结果
        for future in concurrent.futures.as_completed(future_to_path):
            try:
                total_size += future.result()
            except Exception as exc:
                # 可以选择记录异常，但在这里为了稳健性选择忽略单个文件/目录的计算错误
                sys.stderr.write(f"在计算路径 '{future_to_path[future]}' 大小时发生错误: {exc}\n")
    return total_size

def get_total_size_cli_interface(paths_to_calculate):
    """
    CLI 接口：从外部（如 Node.js）调用以计算给定路径的总大小。
    结果通过标准赢出 JSON 格式返回。
    优化：减少计算时间，限制最大工作线程数避免过多竞争。
    """
    if not paths_to_calculate:
        print(json.dumps({"success": False, "error": "未提供路径"}, ensure_ascii=False))
        sys.exit(1)

    # 限制最大工作线程数，避免过多线程竞争
    max_workers = min(4, len(paths_to_calculate))  # 最多4个线程

    try:
        # 优化：直接使用并行计算，而不是包装在另一个函数中
        total_size = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            # 提交每个路径的计算任务
            future_to_path = {executor.submit(_get_path_size, path): path for path in paths_to_calculate}

            # 收集结果
            for future in concurrent.futures.as_completed(future_to_path):
                try:
                    total_size += future.result()
                except Exception as exc:
                    sys.stderr.write(f"在计算路径 '{future_to_path[future]}' 大小时发生错误: {exc}\n")

        print(json.dumps({"success": True, "total_size": total_size}, ensure_ascii=False))
    except Exception as e:
        # 如果是计算总大小过程中出现未捕获的全局性错误
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1) # 以非零状态码退出表示失败
# --- 文件大小计算功能结束 ---

def handle_windows():
    try:
        import win32clipboard as wcb
        import win32con as wcon
    except Exception as e:
        return {"error": "pywin32 not installed. pip install pywin32"}

    try:
        wcb.OpenClipboard()

        # 文件路径 (CF_HDROP)
        try:
            if wcb.IsClipboardFormatAvailable(wcon.CF_HDROP):
                files = wcb.GetClipboardData(wcon.CF_HDROP)
                # 检查是否有文件夹
                has_folders = False
                folder_paths = []

                for file_path in files:
                    src = Path(file_path)
                    if src.exists():
                        # 检查是否为文件夹
                        if src.is_dir():
                            has_folders = True
                            folder_paths.append(str(src))

                # 如果包含文件夹，直接返回文件夹路径，不进行复制操作
                if has_folders:
                    # 如果有多个文件夹，用换行符连接路径字符串
                    folder_text = '\n'.join(folder_paths)
                    return {"type": "folder_text", "text": folder_text}

                # 检查是否有重复文件名
                existing_files_check = []

                for file_path in files:
                    src = Path(file_path)
                    if src.exists():
                        ext = src.suffix
                        if is_image_format(ext):
                            # 图片文件：使用时间戳命名，不会有冲突
                            fname = get_timestamp_filename(ext)
                            dst = OUTPUT_DIR / fname
                        else:
                            # 非图片：检查目标文件是否存在
                            fname = src.name
                            dst = OUTPUT_DIR / fname
                            # 如果文件已存在，添加到检查列表
                            if dst.exists():
                                existing_files_check.append({
                                    'src': str(src),
                                    'dst': str(dst),
                                    'name': fname
                                })

                # 如果有文件已存在，使用Python的tkinter实现跨平台弹窗
                if existing_files_check:
                    import tkinter as tk
                    import sys
                    import os

                    # 设置中文显示
                    if sys.platform == 'darwin':  # macOS
                        pass  # macOS上tkinter默认支持中文
                    elif sys.platform == 'win32':  # Windows
                        pass  # Windows上tkinter默认支持中文
                    else:  # Linux等其他平台
                        # 设置字体支持中文
                        import tkinter.font as tkfont
                        default_font = tkfont.nametofont("TkDefaultFont")
                        default_font.configure(family="SimHei", size=10)
                        text_font = tkfont.nametofont("TkTextFont")
                        text_font.configure(family="SimHei", size=10)

                    # 优化创建方式，避免白框闪烁
                    # 创建主窗口但不显示
                    root = tk.Tk()
                    root.overrideredirect(True)  # 隐藏窗口装饰
                    root.attributes('-alpha', 0)  # 完全透明
                    root.geometry('0x0+0+0')  # 最小尺寸和位置

                    # 准备消息内容
                    existing_count = len(existing_files_check)
                    if existing_count == 1:
                        # 显示第一个冲突文件的完整路径
                        conflict_path = existing_files_check[0]['dst']
                        message = f"{conflict_path} 已存在"
                    else:
                        # 显示文件数量
                        message = f"目标文件夹中已存在 {existing_count} 个同名文件"

                    # 创建自定义对话框
                    dialog = tk.Toplevel(root)
                    dialog.title("文件覆盖确认")
                    dialog.geometry("400x150")
                    dialog.resizable(False, False)

                    # 居中显示
                    dialog.update_idletasks()
                    width = dialog.winfo_width()
                    height = dialog.winfo_height()
                    x = (dialog.winfo_screenwidth() // 2) - (width // 2)
                    y = (dialog.winfo_screenheight() // 2) - (height // 2)
                    dialog.geometry(f"{width}x{height}+{x}+{y}")

                    # 结果变量
                    result_var = tk.StringVar(value="cancel")

                    # 点击文本区域的彩蛋功能
                    def on_label_click(event):
                        # 设置特殊结果类型，用于插入引用
                        result_var.set("insert_reference")
                        dialog.destroy()

                    # 添加消息标签并设置为可点击
                    label = tk.Label(dialog, text=message, wraplength=380, padx=20, pady=10)
                    label.pack()
                    label.bind("<Button-1>", on_label_click)  # 绑定左键点击事件

                    # 按钮点击事件处理
                    def on_open_folder():
                        result_var.set("open_folder")
                        dialog.destroy()

                    def on_overwrite():
                        result_var.set("overwrite")
                        dialog.destroy()

                    def on_cancel():
                        result_var.set("cancel")
                        dialog.destroy()

                    # 添加按钮
                    button_frame = tk.Frame(dialog)
                    button_frame.pack(pady=10)

                    # 设置相同宽度的按钮，并增加间距
                    button_width = 10
                    tk.Button(button_frame, text="打开文件夹", width=button_width, command=on_open_folder).pack(side=tk.LEFT, padx=10)
                    tk.Button(button_frame, text="谨慎 !盖之", width=button_width, command=on_overwrite).pack(side=tk.LEFT, padx=10)
                    tk.Button(button_frame, text="取消", width=button_width, command=on_cancel).pack(side=tk.LEFT, padx=10)

                    # 设置对话框模态
                    dialog.transient(root)
                    dialog.grab_set()
                    root.wait_window(dialog)

                    # 根据用户选择执行操作
                    result = result_var.get()
                    if result == "cancel":
                        return {"type": "cancelled", "message": "用户取消了粘贴操作"}
                    elif result == "insert_reference":
                        # 彩蛋功能：返回引用文本而不执行覆盖
                        # 确保existing_files_check不为空
                        if existing_files_check and len(existing_files_check) > 0:
                            # 获取第一个冲突文件的完整路径
                            reference_path = existing_files_check[0]['dst']
                            # 返回引用类型和内容
                            return {"type": "text", "text": f"[{reference_path}]"}
                        # 如果没有冲突文件，仍然返回成功
                        return {"type": "cancelled", "message": "引用已插入"}
                    elif result == "open_folder":
                        # 打开文件夹并选中文件
                        if existing_count == 1:
                            # 有单个冲突文件，打开并选中它
                            conflict_path = existing_files_check[0]['dst']
                            folder_path = str(OUTPUT_DIR)
                            file_name = os.path.basename(conflict_path)
                        else:
                            # 多个冲突文件，只打开文件夹
                            folder_path = str(OUTPUT_DIR)
                            file_name = None

                        if sys.platform == 'win32':
                            if file_name:
                                # Windows资源管理器打开并选中文件
                                subprocess.Popen(['explorer.exe', '/select,', conflict_path])
                            else:
                                os.startfile(folder_path)
                        elif sys.platform == 'darwin':
                            if file_name:
                                # macOS Finder打开并选中文件
                                subprocess.Popen(['open', '-R', conflict_path])
                            else:
                                subprocess.Popen(['open', folder_path])
                        else:
                            # Linux等其他平台
                            if file_name:
                                # 尝试使用xdg-open打开文件夹（无法选中文件）
                                subprocess.Popen(['xdg-open', folder_path])
                            else:
                                subprocess.Popen(['xdg-open', folder_path])
                        return {"type": "cancelled", "message": "用户打开了文件夹"}
                    # 如果是overwrite或其他情况，继续执行覆盖操作

                # 没有冲突或用户已确认覆盖，直接复制所有文件
                copied_files = []
                image_files = []

                for file_path in files:
                    src = Path(file_path)
                    if src.exists():
                        ext = src.suffix
                        if is_image_format(ext):
                            # 图片文件：重命名并记录为图片
                            fname = get_timestamp_filename(ext)
                            dst = OUTPUT_DIR / fname
                            import shutil
                            shutil.copy2(src, dst)
                            copied_files.append(str(dst))
                            image_files.append(str(dst))
                        else:
                            # 非图片：保持原文件名
                            fname = src.name
                            dst = OUTPUT_DIR / fname
                            import shutil
                            shutil.copy2(src, dst)
                            copied_files.append(str(dst))

                # 如果有图片文件，优先返回为 file 类型（这样 js 端会处理图片标识符插入）
                return {"type": "file", "files": copied_files, "images": image_files}
        except Exception:
            pass

        # Unicode 文本
        try:
            if wcb.IsClipboardFormatAvailable(wcon.CF_UNICODETEXT):
                txt = wcb.GetClipboardData(wcon.CF_UNICODETEXT)
                return {"type": "text", "text": txt}
        except Exception:
            pass

        # 图片截图 (CF_DIB)
        try:
            if wcb.IsClipboardFormatAvailable(wcon.CF_DIB):
                dib = wcb.GetClipboardData(wcon.CF_DIB)
                if isinstance(dib, (bytes, bytearray)):
                    data = bytes(dib)
                else:
                    # 尝试 GlobalLock 读取
                    data = read_hglobal_from_handle(dib)

                if data:
                    try:
                        from PIL import Image
                        import io
                        # DIB 转 BMP
                        bfType = b"BM"
                        bfSize = (len(data) + 14).to_bytes(4, "little")
                        bfReserved = (0).to_bytes(4, "little")
                        bfOffBits = (14 + 40).to_bytes(4, "little")
                        bmp = bfType + bfSize + bfReserved + bfOffBits + data
                        img = Image.open(io.BytesIO(bmp))

                        # 截图保存为 PNG，使用时间戳命名
                        fname = get_timestamp_filename(".png")
                        path = OUTPUT_DIR / fname
                        img.save(path)
                        return {"type": "image", "path": str(path)}
                    except Exception:
                        # 无法转换，直接保存原始数据
                        path = save_bytes(data, is_image=True, original_ext=".dib")
                        return {"type": "binary", "path": path}
        except Exception:
            pass

        # 其他格式兜底
        try:
            res = enum_and_try_read_hglobal()
            if res:
                fmt_read, data = res
                path = save_bytes(data, is_image=False)
                return {"type": "binary", "path": path}
        except Exception:
            pass

    finally:
        try:
            wcb.CloseClipboard()
        except Exception:
            pass

    return {"type": "unknown"}

def read_hglobal_from_handle(handle):
    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32

        GlobalLock = kernel32.GlobalLock
        GlobalLock.argtypes = [wintypes.HGLOBAL]
        GlobalLock.restype = ctypes.c_void_p

        GlobalUnlock = kernel32.GlobalUnlock
        GlobalUnlock.argtypes = [wintypes.HGLOBAL]
        GlobalUnlock.restype = wintypes.BOOL

        GlobalSize = kernel32.GlobalSize
        GlobalSize.argtypes = [wintypes.HGLOBAL]
        GlobalSize.restype = ctypes.c_size_t

        if not handle:
            return None
        ptr = GlobalLock(handle)
        if not ptr:
            return None
        try:
            size = GlobalSize(handle)
            if not size or size <= 0:
                return None
            buf = (ctypes.c_char * size)()
            ctypes.memmove(buf, ptr, size)
            data = bytes(buf[:size])
            return data
        finally:
            try:
                GlobalUnlock(handle)
            except Exception:
                pass
    except Exception:
        return None

def enum_and_try_read_hglobal():
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32

        EnumClipboardFormats = user32.EnumClipboardFormats
        EnumClipboardFormats.argtypes = [wintypes.UINT]
        EnumClipboardFormats.restype = wintypes.UINT

        GetClipboardData = user32.GetClipboardData
        GetClipboardData.argtypes = [wintypes.UINT]
        GetClipboardData.restype = wintypes.HANDLE

        fmt = 0
        while True:
            fmt = EnumClipboardFormats(fmt)
            if fmt == 0:
                break
            try:
                h = GetClipboardData(fmt)
                if h:
                    data = read_hglobal_from_handle(h)
                    if data:
                        return fmt, data
            except Exception:
                continue
    except Exception:
        return None
    return None

def handle_macos():
    try:
        import pyperclip
        txt = pyperclip.paste()
        if txt:
            return {"type": "text", "text": txt}
    except Exception:
        pass

    try:
        data = subprocess.check_output(["pbpaste", "-Prefer", "png"], stderr=subprocess.DEVNULL)
        if data:
            fname = get_timestamp_filename(".png")
            path = OUTPUT_DIR / fname
            with open(path, "wb") as f:
                f.write(data)
            return {"type": "image", "path": str(path)}
    except Exception:
        pass
    return {"type": "unknown"}

def handle_linux():
    try:
        import pyperclip
        txt = pyperclip.paste()
        if txt:
            return {"type": "text", "text": txt}
    except Exception:
        pass

    try:
        data = subprocess.check_output(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], stderr=subprocess.DEVNULL)
        if data:
            fname = get_timestamp_filename(".png")
            path = OUTPUT_DIR / fname
            with open(path, "wb") as f:
                f.write(data)
            return {"type": "image", "path": str(path)}
    except Exception:
        pass
    return {"type": "unknown"}

def main():
    # 检查第一个命令行参数是否为 "get_size"
    if len(sys.argv) > 1 and sys.argv[1] == "get_size":
        # 如果是，则将后续参数作为路径列表传递给文件大小计算接口
        paths_to_calculate = sys.argv[2:]
        get_total_size_cli_interface(paths_to_calculate)
    else:
        # 否则，执行原有的剪贴板处理逻辑
        try:
            sysname = platform.system()
            if sysname == "Windows":
                res = handle_windows()
            elif sysname == "Darwin":
                res = handle_macos()
            elif sysname == "Linux":
                res = handle_linux()
            else:
                res = {"type": "unknown"}
            print(json.dumps(res, ensure_ascii=False))
        except Exception as e:
            # 捕获剪贴板处理过程中的全局错误
            print(json.dumps({"error": str(e)}, ensure_ascii=False))
            sys.exit(1) # 以非零状态码退出表示失败

if __name__ == "__main__":
    main()

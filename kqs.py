import os
import sys
import time
import subprocess
import re
import signal
import atexit
import logging
from PyQt5.QtWidgets import QApplication, QWidget
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QPainter, QColor, QFont
import win32gui
import win32api
import win32con
import pywintypes
import datetime
import ctypes
from ctypes import wintypes
import shutil
from threading import Thread
import win32process
import threading
import urllib.parse
import socket
import struct
from datetime import timezone, timedelta
from email.utils import parsedate_to_datetime
import urllib.request
from pynput.keyboard import Listener, Key, Controller
from pynput.mouse import Controller as MouseController, Button

# 创建光标 控制器实例
mouse_controller = MouseController()

# 配置日志 - 只记录错误和重要信息
log_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kqs.log')

logger = logging.getLogger()
logger.setLevel(logging.WARNING)  # 只记录警告和错误

file_handler = logging.FileHandler(log_file, mode='a', encoding='utf-8')
file_handler.setLevel(logging.WARNING)  # 只记录警告和错误
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
file_handler.setFormatter(formatter)
logger.addHandler(file_handler)


def simulate_left_click():
    try:
        mouse_controller.click(Button.left, 1)
        return True
    except Exception as e:
        logger.error(f"Error simulating left click: {e}", exc_info=True)
        return False


# 全局变量
q73 = 48
q74 = q73 + 2
q75 = 200
q76 = 15
q77 = 3

# 时间设置选项开关
# 0: 使用北京时间
# 1: 使用赫尔辛基时间
TIME_ZONE_MODE = 1  # 默认使用赫尔辛基时间

# 颜色配置参数 - 可以在这里修改
TIME_PROGRESS_COLOR = (255, 255,  1)  # 时间进度条颜色 (黄色)
WEEK_PROGRESS_COLOR = (1, 255, 212)  # 周进度条颜色 (青色)

# 面板位置控制参数
# True: 靠左侧显示, False: 靠右侧显示
PANEL_ON_LEFT_SIDE = True


# 下区进度条显示模式
# 0: 隐藏
# 1: 按周显示
# 3: 按月显示
progress_mode = 3  # 默认为3


# 进度条显示模式控制变量
# 0: 新方式（黑色表示已过时间，彩色表示剩余时间）
# 1: 原来方式（彩色表示已过时间，黑色表示剩余时间）
PROGRESS_BAR_MODE = 1
PROGRESS_BAR_MODE = 0

q1 = 0
q2 = 1
q3 = 49
q44 = True

# F7组合相关配置
F7_COMBO_THRESHOLD = 1.99  # F7组合的时间窗口（秒）
F7_COOLDOWN_TIME = 1.99    # F7组合的冷却时间（秒）

# F7组合路径配置
F7_PATHS = {
    '4': r'explorer.exe shell:MyComputerFolder',  # 我的电脑
    '2': r'explorer.exe "F:\q"',                 # F:\q
    '3': r'explorer.exe "E:\s\wol\py"',        # E:\s\wor\py
    '1': r'explorer.exe "E:\s"',                 # E:\s
    'a': r'"E:\s\d\ksolo\q.vbs"',              # E:\s\d\ksolo\q.vbs
    's': r'explorer.exe "E:\s\wol\py\wq\q.pyw"',                     # E:\r\1.2
    'd': r'"d:\1.exe"',                         # d:\1.exe
    'q': r'"E:\s\d\qoder\q.vbs"'              # E:\s\wol\py\kqs.py
}

# 双击空格检测
last_space_release_time = 0

# 按键状态跟踪变量
last_key_release_time = {}  # 记录每个键的最后释放时间
last_key_press_time = {}    # 记录每个键的最后按下时间
f7_last_used_time = 0       # 记录F7组合的最后使用时间
cooling_down_keys = set()   # 处于冷却状态的键

# 窗口类名黑名单 - 这些类的窗口将被忽略
WINDOW_CLASS_BLACKLIST = {
    "IME",  # 赢入法窗口
    "MSCTFIME UI",  # 赢入法相关
    "_WMPOCXEvents",  # Windows Media Player控件
    "RichEdit20W",  # 富文本编辑控件
    "Edit",  # 编辑框
    "Button",  # 按钮
    "Static",  # 静态文本
    "ComboBox",  # 下拉框
    "ListBox",  # 列表框
    "ScrollBar",  # 滚动条
    "ToolbarWindow32",  # 工具栏
    "ReBarWindow32",  # 重排栏
    "ComboBoxEx32",  # 增强下拉框
    "SysTabControl32",  # 选项卡控件
    "#32770",  # 对话框
    "#32768",  # 菜单
    "#32769",  # 桌面窗口
    "WorkerW",  # 桌面工作窗口
    "Progman"  # 程序管理器
}

# 滚动功能变量
last_shift_release_time = 0
last_alt_release_time = 0
KEY_THRESHOLD = 0.5

# 缓存变量
cached_guid = None
cached_screen_width = None
cached_screen_height = None
cached_processor_state = None
cached_power_mode = None
cached_time_str = None
cached_disk_space = None
last_cache_time = 0
CACHE_INTERVAL = 6

# 全局定时器管理
reset_timer = None
reset_timer_lock = threading.Lock()

# 全局窗口引用 - 用于退出时清理
app_instance = None
info_window = None
cursor_window = None
time_window = None

# 清理保护
cleanup_in_progress = False
cleanup_lock = threading.Lock()

# 键盘和光标 控制器
kb_controller = Controller()
mouse_controller = MouseController()

# pynput 监听器全局引用
keyboard_listener = None
pressed_keys = set()  # 用于跟踪按下的键


def cleanup_and_exit():
    """清理所有资源并退出"""
    global app_instance, info_window, cursor_window, time_window, reset_timer, keyboard_listener
    global cleanup_in_progress, pressed_keys, file_handler

    # 防止重复清理
    with cleanup_lock:
        if cleanup_in_progress:
            logger.warning("Cleanup already in progress")
            return
        cleanup_in_progress = True

    # 清理键盘监听器
    try:
        if keyboard_listener:
            keyboard_listener.stop()
            keyboard_listener = None
    except Exception as e:
        logger.error(f"Error stopping keyboard listener: {e}")

    # 清理定时器
    try:
        with reset_timer_lock:
            if reset_timer:
                reset_timer.cancel()
                reset_timer = None
    except Exception as e:
        logger.error(f"Error canceling timer: {e}")

    # 清理窗口资源
    windows_to_close = []
    if cursor_window:
        windows_to_close.append(cursor_window)
    if time_window:
        windows_to_close.append(time_window)
    if info_window:
        windows_to_close.append(info_window)

    cursor_window = None
    time_window = None
    info_window = None

    # 清空按键集合
    pressed_keys.clear()

    # 关闭所有窗口
    for window in windows_to_close:
        try:
            window.close()
        except Exception as e:
            logger.error(f"Error closing window: {e}")

    # 关闭并移除所有日志处理器，确保释放文件句柄
    try:
        # 获取所有日志处理器的副本以避免迭代过程中修改列表
        handlers = logger.handlers.copy()
        for handler in handlers:
            try:
                handler.close()
                logger.removeHandler(handler)
            except Exception as e:
                # 使用print避免递归调用logger
                print(f"Error closing logger handler: {e}")
        # 显式设置file_handler为None
        file_handler = None
    except Exception as e:
        print(f"Error during logger cleanup: {e}")  # 使用print避免递归调用logger

    # 退出应用程序
    try:
        if app_instance:
            app_instance.quit()
    except Exception as e:
        print(f"Error quitting app: {e}")  # 使用print避免递归调用logger

    # 强制退出系统
    try:
        sys.exit(0)
    except:
        # 如果sys.exit失败，使用os._exit作为最终手段
        os._exit(0)


def signal_handler(signum, frame):
    cleanup_and_exit()


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)
atexit.register(cleanup_and_exit)

# 以管理员身份运行


def q15():
    if ctypes.windll.shell32.IsUserAnAdmin() == 0:
        ctypes.windll.shell32.ShellExecuteW(
            None, "runas", sys.executable, f'"{sys.argv[0]}"', None, 1)
        os._exit(0)


def perform_tail_operations():
    """执行F7操作的尾部操作：先按空格键，再按两次退格键"""
    try:
        # 检查当前焦点窗口是否为资源管理器或桌面窗口
        is_explorer_window = False
        is_desktop_window = False
        window_title = "Unknown"
        process_name = "Unknown"
        window_class = "Unknown"

        try:
            hwnd = win32gui.GetForegroundWindow()
            window_title = win32gui.GetWindowText(hwnd) or "Untitled"
            window_class = win32gui.GetClassName(hwnd) or "Unknown"
            _, pid = win32process.GetWindowThreadProcessId(hwnd)

            # 检测是否为桌面窗口类名
            desktop_classes = ['Shell_TrayWnd', 'Progman', 'Afx:400000:0',
                               'DummyDWMListenerWindow', 'EdgeUiInputTopWndClass']
            if window_class in desktop_classes:
                is_desktop_window = True

            # 检测是否为资源管理器进程
            PROCESS_QUERY_INFORMATION = 0x0400
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_INFORMATION, False, pid)
            if handle:
                buffer = ctypes.create_unicode_buffer(260)
                size = wintypes.DWORD(260)
                if ctypes.windll.psapi.GetModuleFileNameExW(handle, None, buffer, size):
                    process_path = buffer.value
                    process_name = os.path.basename(
                        process_path) if process_path else "Unknown"
                    if process_path and 'explorer.exe' in process_path.lower():
                        is_explorer_window = True
                ctypes.windll.kernel32.CloseHandle(handle)
        except Exception as ex:
            logger.warning(f"Error checking window properties: {ex}")

        # 如果既不是资源管理器窗口也不是桌面窗口，执行操作
        if not is_explorer_window and not is_desktop_window:
            # 使用pynput的键盘控制器模拟按键：先按空格，再按两次退格
            kb_controller.tap(Key.space)
            time.sleep(0.05)  # 短暂延迟确保按键生效
            kb_controller.tap(Key.backspace)
            kb_controller.tap(Key.backspace)  # 两次退格键之间不添加延迟
            time.sleep(0.05)  # 短暂延迟确保按键生效
            logger.debug(
                f"Tail operations performed: space + two backspaces. Window: '{window_title}', Class: '{window_class}', Process: '{process_name}'")
        else:
            # 在资源管理器窗口或桌面窗口中不执行任何按键操作
            reason = "explorer window detected" if is_explorer_window else "desktop window detected"
            logger.debug(
                f"No tail operations performed ({reason}). Window: '{window_title}', Class: '{window_class}', Process: '{process_name}'")
    except Exception as e:
        logger.error(f"Error in perform_tail_operations: {e}", exc_info=True)


def execute_f7_action(action_key):
    """执行F7组合操作"""
    global f7_last_used_time, cooling_down_keys
    current_time = time.time()

    # 检查键是否在冷却中
    if action_key in cooling_down_keys:
        logger.debug(
            f"Key '{action_key}' is still cooling down, skipping F7 action")
        return False

    # 执行尾部操作
    perform_tail_operations()
    time.sleep(0.1)  # 短暂延迟确保尾部操作完成

    # 执行对应的操作
    try:
        if action_key == 'w':
            logger.info(
                "Executing w+F7 action: opening admin PowerShell at cursor window path")
            open_admin_powershell()
        elif action_key == 'x':
            logger.info(
                "Executing x+F7 action: opening admin Command Prompt at cursor window path")
            open_admin_cmd()

        elif action_key == 'z':
            logger.info(
                "Executing z+F7 action: opening Explorer at cursor window path")
            # 获取当前光标位置根窗口的路径
            window_path = get_focus_window_path()  # 这个函数已经被修改为使用根窗口
            logger.info(f"Opening Explorer at path: {window_path}")
            try:
                # 使用ShellExecuteW以普通权限打开资源管理器
                # 先检查路径是否存在
                if not os.path.exists(window_path):
                    logger.warning(
                        f"Path does not exist: {window_path}, using Desktop")
                    window_path = os.path.expanduser('~\\Desktop')

                # 构建参数，确保正确处理带空格的路径
                params = f"/e,\"{window_path}\""
                logger.debug(f"Explorer params: {params}")

                result = ctypes.windll.shell32.ShellExecuteW(
                    None, "open", "explorer.exe", params, None, 1)
                if result > 32:
                    logger.info(
                        f"Successfully opened Explorer at {window_path}")
                else:
                    logger.error(
                        f"ShellExecuteW returned error code: {result}")
                    raise Exception(f"ShellExecuteW failed with code {result}")
            except Exception as shell_ex:
                logger.error(f"ShellExecuteW failed for Explorer: {shell_ex}")
                # 尝试直接打开路径
                try:
                    if os.path.isdir(window_path):
                        subprocess.Popen(["explorer.exe", window_path])
                    else:
                        # 如果路径是文件，打开其所在目录
                        parent_dir = os.path.dirname(window_path)
                        subprocess.Popen(["explorer.exe", parent_dir])
                    logger.info(
                        f"Successfully opened Explorer via subprocess at {window_path}")
                except Exception as sub_ex:
                    logger.error(f"Subprocess failed for Explorer: {sub_ex}")
        elif action_key in F7_PATHS:
            logger.info(
                f"Executing {action_key}+F7 action: opening {F7_PATHS[action_key]}")
            # 使用ShellExecuteW来更好地处理Windows环境下的程序和文件打开
            try:
                # 获取路径配置
                path_config = F7_PATHS[action_key]
                logger.debug(f"Path config for {action_key}: {path_config}")

                # 先处理带引号的路径
                actual_path = path_config
                if path_config.startswith('"') and path_config.endswith('"'):
                    actual_path = path_config[1:-1]  # 去掉引号
                    logger.debug(f"Removed quotes, actual path: {actual_path}")

                # 提取工作目录
                working_dir = os.path.dirname(actual_path)
                logger.debug(f"Working directory set to: {working_dir}")

                # 根据文件类型采用不同的打开方式
                if path_config.startswith('explorer.exe'):
                    # 处理显式指定的explorer.exe命令
                    space_pos = path_config.find(' ')
                    if space_pos != -1:
                        params = path_config[space_pos+1:].strip()
                        logger.debug(
                            f"Executing explorer.exe with params: {params}")
                        ctypes.windll.shell32.ShellExecuteW(
                            None, "open", "explorer.exe", params, None, 1)
                    else:
                        logger.debug(f"Executing explorer.exe without params")
                        ctypes.windll.shell32.ShellExecuteW(
                            None, "open", "explorer.exe", None, None, 1)
                elif actual_path.endswith('.bat') or actual_path.endswith('.cmd'):
                    # 使用cmd.exe /k打开批处理文件，保持窗口打开
                    logger.debug(
                        f"Opening batch file with cmd.exe: {actual_path}")
                    # 如果路径包含空格，加上引号
                    if ' ' in actual_path:
                        cmd_param = f"/k \"{actual_path}\""
                        logger.debug(
                            f"Path contains spaces, using quoted param: {cmd_param}")
                    else:
                        cmd_param = f"/k {actual_path}"
                    ctypes.windll.shell32.ShellExecuteW(
                        None, "open", "cmd.exe", cmd_param, working_dir, 1)
                else:
                    # 默认处理方式，适用于.exe, .vbs, .txt等所有其他文件类型
                    logger.debug(f"Opening with default method: {actual_path}")
                    ctypes.windll.shell32.ShellExecuteW(
                        None, "open", actual_path, None, working_dir, 1)
            except Exception as shell_ex:
                logger.warning(
                    f"ShellExecuteW failed, falling back to subprocess: {shell_ex}")
                # 如果ShellExecuteW失败，回退到subprocess
                subprocess.Popen(actual_path, shell=True)

        # 更新最后使用时间并设置冷却
        f7_last_used_time = current_time
        cooling_down_keys.add(action_key)

        # 设置冷却定时器
        def reset_cooling_down():
            cooling_down_keys.discard(action_key)

        cooling_timer = threading.Timer(F7_COOLDOWN_TIME, reset_cooling_down)
        cooling_timer.daemon = True
        cooling_timer.start()

        return True
    except Exception as e:
        logger.error(
            f"Error executing F7 action for key '{action_key}': {e}", exc_info=True)
        return False

# 修复GetSystemMetrics函数


def q5(nIndex):
    try:
        return win32api.GetSystemMetrics(nIndex)
    except (AttributeError, ImportError):
        return ctypes.windll.user32.GetSystemMetrics(nIndex)


q6 = r"C:\a"


def q7():
    _, _, free = shutil.disk_usage("C:\\")
    return round(free / (1024**3), 2)


def q65():
    q66 = datetime.datetime.utcnow()
    q67 = q66.month >= 3 and q66.month <= 10
    if q67:
        if q66.month == 3:
            q68 = 31 - ((5 * q66.year // 4 + 4) % 7)
            q67 = q66.day >= q68
        elif q66.month == 10:
            q69 = 31 - ((5 * q66.year // 4 + 1) % 7)
            q67 = q66.day < q69
    return 3 if q67 else 2


def get_helsinki_time():
    """获取赫尔辛基时间，自动处理夏令时"""
    utc_now = datetime.datetime.utcnow()
    # 计算赫尔辛基的时区偏移（包括夏令时）
    helsinki_offset = q65()  # q65() 函数已经实现了计算赫尔辛基时区偏移的逻辑
    helsinki_time = utc_now + datetime.timedelta(hours=helsinki_offset)
    return helsinki_time


def get_beijing_time():
    """获取北京时间"""
    utc_now = datetime.datetime.utcnow()
    beijing_time = utc_now + datetime.timedelta(hours=8)  # 北京时间是UTC+8
    return beijing_time


def q11():
    q66 = datetime.datetime.utcnow()
    q70 = q65()
    q46 = q66 + datetime.timedelta(hours=q70)
    q12 = q46.timetuple()
    q13 = ['一', '二', '三', '四', '五', '六', '日']
    q14 = q13[q12.tm_wday]
    return q46.strftime(f'%y.%m.%d{q14}%H:%M:%S')


def q47():
    q78 = time.localtime()
    return time.strftime('%H:%M', q78)


def get_power_status():
    try:
        class SYSTEM_POWER_STATUS(ctypes.Structure):
            _fields_ = [
                ('ACLineStatus', ctypes.c_ubyte),
                ('BatteryFlag', ctypes.c_ubyte),
                ('BatteryLifePercent', ctypes.c_ubyte),
                ('SystemStatusFlag', ctypes.c_ubyte),
                ('BatteryLifeTime', ctypes.c_ulong),
                ('BatteryFullLifeTime', ctypes.c_ulong),
            ]

        power_status = SYSTEM_POWER_STATUS()
        ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(power_status))
        return 'AC' if power_status.ACLineStatus == 1 else 'DC'
    except Exception as e:
        logger.error(f"Error getting power status: {e}", exc_info=True)
        return 'AC'


def get_active_power_plan_guid():
    try:
        hide_window_flag = subprocess.CREATE_NO_WINDOW if hasattr(
            subprocess, 'CREATE_NO_WINDOW') else 0
        result = subprocess.run(
            ['powercfg', '/list'],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',  # 替换无法解码的字符
            creationflags=hide_window_flag,
            timeout=10
        )

        # 检查命令执行是否成功
        if result.returncode != 0:
            logger.error(
                f"powercfg command failed with return code: {result.returncode}")
            return None

        # 检查赢出是否为空
        if not result.stdout:
            logger.error("powercfg command returned empty output")
            return None

        # 检查是否有活动的电源计划
        if '*' not in result.stdout:
            logger.error("No active power plan found in output")
            return None

        # 尝试使用主要正则表达式提取GUID
        match = re.search(
            r'电源方案 GUID:\s+([0-9a-fA-F\-]+)\s+\([^)]+\)\s*\*', result.stdout)

        if not match:
            # 备用方法：逐行检查
            lines = result.stdout.split('\n')
            for line in lines:
                if line and '*' in line:
                    guid_match = re.search(r'([0-9a-fA-F\-]{36})', line)
                    if guid_match:
                        return guid_match.group(1)

        # 返回找到的GUID或None
        if match:
            return match.group(1)
        else:
            logger.error("Failed to extract GUID from powercfg output")
            return None
    except subprocess.TimeoutExpired:
        logger.error("powercfg command timed out after 10 seconds")
        return None
    except Exception as e:
        logger.error(f"Error getting power plan GUID: {e}", exc_info=True)
        return None


def get_cached_guid():
    """获取缓存的电源计划GUID，如果缓存失效则重新获取"""
    global cached_guid
    # 如果缓存为空，尝试获取新的GUID
    if not cached_guid:
        cached_guid = get_active_power_plan_guid()
        # 如果仍然获取不到GUID，添加额外的重试逻辑
        retry_count = 0
        max_retries = 2
        while not cached_guid and retry_count < max_retries:
            retry_count += 1
            logger.warning(
                f"Retry {retry_count}/{max_retries}: Failed to get power plan GUID, trying again...")
            time.sleep(0.5)  # 短暂延迟后重试
            cached_guid = get_active_power_plan_guid()
    return cached_guid


def get_cached_screen_size():
    global cached_screen_width, cached_screen_height
    if cached_screen_width is None or cached_screen_height is None:
        cached_screen_width = q5(q1)
        cached_screen_height = q5(q2)
    return cached_screen_width, cached_screen_height


def should_update_cache():
    global last_cache_time
    current_time = time.time()
    if current_time - last_cache_time >= CACHE_INTERVAL:
        last_cache_time = current_time
        return True
    return False


def update_cached_data():
    """更新所有缓存的数据，带错误隔离处理"""
    global cached_processor_state, cached_power_mode, cached_time_str, cached_disk_space

    # 单独处理每个缓存项，确保一个项的失败不会影响其他项
    try:
        guid = get_cached_guid()
        if guid:
            # 先尝试更新处理器状态
            try:
                cached_processor_state = get_processor_max_state(guid)
            except Exception as e:
                logger.error(
                    f"Error updating cached processor state: {e}", exc_info=True)
                cached_processor_state = None  # 标记为需要重新获取
        else:
            logger.warning(
                "Cannot update processor state cache: No GUID available")
    except Exception as e:
        logger.error(
            f"Error in GUID processing during cache update: {e}", exc_info=True)

    # 更新电源模式
    try:
        cached_power_mode = get_power_status()
    except Exception as e:
        logger.error(f"Error updating cached power mode: {e}", exc_info=True)

    # 更新时间字符串
    try:
        cached_time_str = q11()
    except Exception as e:
        logger.error(f"Error updating cached time: {e}", exc_info=True)
        try:
            # 备用时间获取方法
            cached_time_str = datetime.datetime.now().strftime('%y.%m.%d%H:%M:%S')
        except:
            cached_time_str = "时间获取失败"

    # 更新磁盘空间
    try:
        cached_disk_space = q7()
    except Exception as e:
        logger.error(f"Error updating cached disk space: {e}", exc_info=True)
        cached_disk_space = -1.0  # 用特殊值表示获取失败


def get_cached_processor_state():
    global cached_processor_state
    if cached_processor_state is None or should_update_cache():
        update_cached_data()
    return cached_processor_state or 100


def get_cached_time_and_disk():
    global cached_time_str, cached_disk_space
    if cached_time_str is None or should_update_cache():
        update_cached_data()
    return cached_time_str or q11(), cached_disk_space or 0.0


def get_processor_max_state(guid):
    """获取处理器最大状态，增强版带多重错误处理"""
    if not guid or len(guid) != 36:
        logger.warning("Invalid or missing GUID when getting processor state")
        return 100

    try:
        power_mode = get_power_status()
        hide_window_flag = subprocess.CREATE_NO_WINDOW if hasattr(
            subprocess, 'CREATE_NO_WINDOW') else 0

        # 增加超时重试逻辑
        max_retries = 2
        for retry in range(max_retries + 1):
            try:
                result = subprocess.run(
                    ['powercfg', '/q', guid, 'SUB_PROCESSOR', 'PROCTHROTTLEMAX'],
                    capture_output=True, text=True, encoding='gbk',
                    errors='replace',  # 替换无法解码的字符
                    creationflags=hide_window_flag, timeout=10
                )

                # 检查命令执行是否成功
                if result.returncode != 0:
                    if retry < max_retries:
                        logger.warning(
                            f"powercfg query failed (code: {result.returncode}), retrying... ({retry+1}/{max_retries})")
                        time.sleep(0.5)
                        continue
                    logger.error(
                        f"Failed to query processor state after {max_retries+1} attempts")
                    return 100

                # 根据电源模式选择正则表达式
                if power_mode == 'AC':
                    patterns = [
                        r'当前交流电源设置索引:\s*0x([0-9a-fA-F]+)',
                        r'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)',
                        r'AC设置索引:\s*0x([0-9a-fA-F]+)',
                        r'交流电源.*?0x([0-9a-fA-F]+)'
                    ]
                else:
                    patterns = [
                        r'当前直流电源设置索引:\s*0x([0-9a-fA-F]+)',
                        r'Current DC Power Setting Index:\s*0x([0-9a-fA-F]+)',
                        r'DC设置索引:\s*0x([0-9a-fA-F]+)',
                        r'直流电源.*?0x([0-9a-fA-F]+)'
                    ]

                # 尝试匹配任何一个模式
                for pattern in patterns:
                    match = re.search(pattern, result.stdout, re.IGNORECASE)
                    if match:
                        try:
                            hex_value = match.group(1)
                            value = int(hex_value, 16)
                            # 验证值是否在有效范围内
                            if 0 <= value <= 100:
                                return value
                            else:
                                logger.warning(
                                    f"Processor state value {value} out of range, returning 100")
                                return 100
                        except ValueError as ve:
                            logger.error(
                                f"Failed to convert hex value '{match.group(1)}' to integer: {ve}")
                            continue

                # 如果没有匹配到任何模式，尝试直接解析赢出
                logger.warning(
                    "No pattern matched in powercfg output, trying fallback parsing")
                if '0x' in result.stdout:
                    # 尝试提取所有十六进制值并找到合适的一个
                    hex_values = re.findall(r'0x([0-9a-fA-F]+)', result.stdout)
                    for hex_val in hex_values:
                        try:
                            value = int(hex_val, 16)
                            if 0 <= value <= 100:
                                logger.info(
                                    f"Found valid processor state value {value} using fallback parsing")
                                return value
                        except ValueError:
                            continue

                # 如果所有尝试都失败
                logger.error(
                    "Failed to parse processor state from powercfg output")
                return 100
            except subprocess.TimeoutExpired:
                if retry < max_retries:
                    logger.warning(
                        f"powercfg query timed out, retrying... ({retry+1}/{max_retries})")
                    time.sleep(0.5)
                    continue
                logger.error(
                    f"powercfg query timed out after {max_retries+1} attempts")
                return 100

    except Exception as e:
        logger.error(f"Error getting processor state: {e}", exc_info=True)
        return 100


def set_processor_max_state(guid, value):
    """设置处理器最大状态，增强版带多重错误处理和重试机制"""
    if not guid or len(guid) != 36:
        logger.warning("Invalid or missing GUID when setting processor state")
        return False, "无效的电源计划GUID"

    if not (0 <= value <= 100):
        logger.warning(
            f"Invalid processor state value: {value} (must be 0-100)")
        return False, "值必须在0-100之间"

    try:
        power_mode = get_power_status()
        hide_window_flag = subprocess.CREATE_NO_WINDOW if hasattr(
            subprocess, 'CREATE_NO_WINDOW') else 0

        # 构建命令
        if power_mode == 'AC':
            cmd = ['powercfg', '/setacvalueindex', guid,
                   'SUB_PROCESSOR', 'PROCTHROTTLEMAX', str(value)]
        else:
            cmd = ['powercfg', '/setdcvalueindex', guid,
                   'SUB_PROCESSOR', 'PROCTHROTTLEMAX', str(value)]

        # 增加超时重试逻辑
        max_retries = 2
        for retry in range(max_retries + 1):
            try:
                result = subprocess.run(
                    cmd, capture_output=True, text=True, encoding='utf-8',
                    errors='replace',  # 替换无法解码的字符
                    creationflags=hide_window_flag, timeout=10
                )

                # 检查命令执行是否成功
                if result.returncode == 0:
                    # 清除缓存，以便下次获取时重新读取
                    global cached_processor_state, last_cache_time
                    cached_processor_state = None
                    last_cache_time = 0
                    logger.info(
                        f"Successfully set processor state to {value}%")
                    return True, f'处理器状态已设置为: {value}%'
                else:
                    error_msg = result.stderr.strip(
                    ) if result.stderr else f'设置失败，返回码: {result.returncode}'
                    if retry < max_retries:
                        logger.warning(
                            f"Failed to set processor state (attempt {retry+1}/{max_retries+1}): {error_msg}, retrying...")
                        time.sleep(0.5)
                        continue
                    logger.error(
                        f"Failed to set processor state after {max_retries+1} attempts: {error_msg}")
                    return False, error_msg
            except subprocess.TimeoutExpired:
                if retry < max_retries:
                    logger.warning(
                        f"powercfg command timed out (attempt {retry+1}/{max_retries+1}), retrying...")
                    time.sleep(0.5)
                    continue
                logger.error(
                    f"powercfg command timed out after {max_retries+1} attempts")
                return False, '设置超时'

    except Exception as e:
        logger.error(f"Error setting processor state: {e}", exc_info=True)
        return False, f'设置失败: {str(e)}'


# 时间同步功能
NTP_DELTA = 2208988800


class SYSTEMTIME(ctypes.Structure):
    _fields_ = [
        ("wYear", wintypes.WORD),
        ("wMonth", wintypes.WORD),
        ("wDayOfWeek", wintypes.WORD),
        ("wDay", wintypes.WORD),
        ("wHour", wintypes.WORD),
        ("wMinute", wintypes.WORD),
        ("wSecond", wintypes.WORD),
        ("wMilliseconds", wintypes.WORD),
    ]


def get_ntp_utc(host, timeout=3.0):
    pkt = b"\x1b" + 47 * b"\0"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        t0 = time.perf_counter()
        s.sendto(pkt, (host, 123))
        data, _ = s.recvfrom(48)
        t1 = time.perf_counter()
    if len(data) < 48:
        raise RuntimeError("NTP响应长度异常")
    unpacked = struct.unpack("!12I", data)
    tx = unpacked[10] + unpacked[11] / 2**32
    unix = tx - NTP_DELTA
    rtt_half = (t1 - t0) / 2.0
    corrected = unix + rtt_half
    return datetime.datetime.fromtimestamp(corrected, tz=timezone.utc)


def get_httpdate_utc(url, timeout=4.0):
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        ds = resp.headers.get("Date")
    if not ds:
        raise RuntimeError("无Date头")
    dt = parsedate_to_datetime(ds)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt


def get_network_time_utc():
    ntp_hosts = [
        "time.windows.com",
        "ntp.aliyun.com",
        "pool.ntp.org",
        "time.google.com",
    ]
    for h in ntp_hosts:
        try:
            return get_ntp_utc(h)
        except Exception:
            continue
    http_urls = [
        "https://www.microsoft.com",
        "https://www.cloudflare.com",
        "https://www.baidu.com",
    ]
    for u in http_urls:
        try:
            return get_httpdate_utc(u)
        except Exception:
            continue
    raise RuntimeError("网络时间获取失败")


def set_system_time_utc(dt_utc):
    if dt_utc.tzinfo is None:
        raise ValueError("需要UTC时间")
    dt_utc = dt_utc.astimezone(timezone.utc)
    st = SYSTEMTIME()
    st.wYear = dt_utc.year
    st.wMonth = dt_utc.month
    st.wDay = dt_utc.day
    st.wHour = dt_utc.hour
    st.wMinute = dt_utc.minute
    st.wSecond = dt_utc.second
    st.wMilliseconds = int(dt_utc.microsecond / 1000)
    st.wDayOfWeek = dt_utc.isoweekday() % 7
    ok = ctypes.windll.kernel32.SetSystemTime(ctypes.byref(st))
    if not ok:
        raise OSError(ctypes.get_last_error(), "SetSystemTime失败，需管理员权限")


def try_w32tm_resync():
    try:
        out = subprocess.check_output(
            ["w32tm", "/resync", "/force"],
            stderr=subprocess.STDOUT,
            timeout=10,
            shell=False,
        )
        return True, out.decode(errors="ignore")
    except Exception:
        return False, "w32tm同步失败"


def sync_system_time():
    try:
        server_utc = get_network_time_utc()
        t_ref = time.perf_counter()
        target_utc = server_utc + \
            timedelta(seconds=(time.perf_counter() - t_ref))

        try:
            set_system_time_utc(target_utc)
        except Exception:
            try_w32tm_resync()
    except Exception:
        pass


def start_hourly_time_sync():
    """异步启动时间同步，不阻塞程序启动"""
    def sync_timer():
        try:
            sync_system_time()
        except Exception:
            pass

        t = threading.Timer(3600.0, sync_timer)
        t.daemon = True
        t.start()

    t = threading.Timer(5.0, sync_timer)
    t.daemon = True
    t.start()


def q55():
    """安全地关闭显示器，增强错误处理和稳定性"""
    try:
        # 获取当前线程ID，确保在正确的线程上下文中执行
        current_thread_id = ctypes.windll.kernel32.GetCurrentThreadId()
        logger.debug(f"在线程 {current_thread_id} 中执行显示器关闭操作")

        # 使用 SendMessageTimeout 替代 SendMessageW，增加超时保护
        # 参数: (hwnd, msg, wParam, lParam, fuFlags, uTimeout, lpdwResult)
        result = ctypes.c_ulong()
        success = ctypes.windll.user32.SendMessageTimeoutW(
            0xFFFF,  # HWND_BROADCAST
            0x0112,  # WM_SYSCOMMAND
            0xF170,  # SC_MONITORPOWER
            2,       # 2 = 关闭显示器
            0x0002,  # SMTO_ABORTIFHUNG - 如果目标窗口挂起则终止
            1000,    # 1秒超时
            ctypes.byref(result)
        )

        if success:
            logger.debug(f"显示器关闭消息发送成功，结果: {result.value}")
        else:
            logger.warning(f"显示器关闭消息发送超时或失败，错误码: {ctypes.GetLastError()}")

    except Exception as e:
        logger.error(f"执行显示器关闭操作时发生异常: {e}", exc_info=True)
        # 尝试备用方法
        try:
            # 备用方法：使用更简单的方式发送消息
            ctypes.windll.user32.SendMessageW(0xFFFF, 0x0112, 0xF170, 2)
            logger.info("使用备用方法成功关闭显示器")
        except Exception as e2:
            logger.critical(f"备用显示器关闭方法也失败: {e2}", exc_info=True)


def q17():
    """处理按键精灵和重启资源管理器"""
    # 处理按键精灵
    for attempt in range(3):
        try:
            subprocess.run("taskkill /F /IM 按键精灵9.exe /T", shell=True,
                           capture_output=True, text=True, timeout=5)
        except Exception as e:
            logger.error(
                f"Kill KQJ process error (attempt {attempt+1}): {e}", exc_info=True)
        time.sleep(1)

    time.sleep(3)  # 等待3秒

    # 重启资源管理器
    try:
        subprocess.run("taskkill /F /IM explorer.exe", shell=True,
                       capture_output=True, text=True, timeout=5)
    except Exception as e:
        logger.error(f"Kill explorer error: {e}", exc_info=True)

    try:
        # 使用较短的超时，因为explorer启动后会在后台运行
        subprocess.run("explorer.exe", shell=True, timeout=2)
    except subprocess.TimeoutExpired:
        # 这是预期的，因为explorer会在后台运行
        pass
    except Exception as e:
        logger.error(f"Start explorer error: {e}", exc_info=True)

    time.sleep(3)  # 等待3秒以确保稳定性


def q18():
    q19 = time.localtime()
    return q19.tm_hour * 3600 + q19.tm_min * 60 + q19.tm_sec


def q20():
    """当需要时重启资源管理器并重新初始化监听器"""
    restart_explorer_and_reinit()

# 创建独立的重启资源管理器函数，移到全局作用域


def restart_explorer_and_reinit():
    """重启资源管理器并重新初始化监听器"""
    try:
        # 先创建文件夹a
        manage_flag_directory()

        # 调用q17处理按键精灵和重启资源管理器
        q17()

        time.sleep(5)  # 增加等待时间以确保 explorer 稳定

        # 重新初始化监听器
        logger.debug("Reinitializing listener")
        reinitialize_listener()
        logger.debug("Listener reinitialized")

        logger.info(
            "Explorer restarted and listener reinitialized successfully")
    except Exception as e:
        logger.error(f"Error in restarting explorer: {e}", exc_info=True)

# 创建统一的文件夹管理函数


def manage_flag_directory():
    """管理C:\a标记文件夹，包含检查和创建逻辑"""
    try:
        if not os.path.exists(q6):
            os.makedirs(q6)
            logger.info(f"Directory created: {q6}")
            return True  # 文件夹已创建
        return False  # 文件夹已存在
    except Exception as e:
        logger.error(f"Error managing directory {q6}: {e}", exc_info=True)
        return False

# 创建统一的文件夹删除函数


def remove_flag_directory():
    """删除C:\a标记文件夹"""
    try:
        # 直接尝试删除，忽略错误
        shutil.rmtree(q6, ignore_errors=True)
        logger.info(f"Directory removed: {q6}")
    except Exception as e:
        logger.error(f"Error removing directory {q6}: {e}", exc_info=True)

# 创建整合轮询函数，基于6秒间隔


def integrated_polling():
    """整合的6秒轮询函数，包含缓存更新和文件夹检查"""
    global last_cache_time
    # 跟踪文件夹状态变化，用于更及时地检测删除操作
    previous_dir_state = None

    while True:
        try:
            current_time = time.time()

            # 始终检查文件夹状态，不仅限于缓存更新周期
            try:
                current_dir_state = os.path.exists(q6)

                # 如果检测到文件夹状态变化（从存在变为不存在）
                if previous_dir_state is True and current_dir_state is False:
                    q20()
                    # 重置缓存时间，确保下次检查时不会错过任何变化
                    last_cache_time = current_time - CACHE_INTERVAL

                # 更新状态跟踪
                previous_dir_state = current_dir_state

            except Exception as e:
                logger.error(f"Error checking directory state: {e}")

            # 检查是否需要更新缓存
            if current_time - last_cache_time >= CACHE_INTERVAL:
                # 先保存当前时间，无论后面是否发生异常都能保证下次轮询正常进行
                last_cache_time = current_time

                try:
                    # 更新缓存数据
                    update_cached_data()
                except Exception as e:
                    logger.error(f"Error updating cached data: {e}")

                # 即使在缓存更新周期内，也再次检查文件夹状态作为额外保障
                try:
                    if not os.path.exists(q6):
                        q20()
                except Exception as e:
                    logger.error(
                        f"Error in folder check during cache update: {e}")
        except Exception as e:
            logger.error(f"Error in integrated polling: {e}")
            # 发生异常时，重置缓存时间以确保下次检查尽快进行
            last_cache_time = current_time - CACHE_INTERVAL

        # 等待6秒后再次检查
        time.sleep(CACHE_INTERVAL)


def q24():
    """删除C盘文件夹a"""
    logger.info(
        "Alt+n pressed, executing q24() - Attempting to remove directory")
    # 调用统一的文件夹删除函数
    remove_flag_directory()
    logger.info("q24() execution completed")


def q56():
    global q44
    q44 = not q44


def handle_processor_increase():
    try:
        guid = get_cached_guid()
        if guid:
            current_value = get_processor_max_state(guid)
            new_value = min(100, current_value + 1)
            success, message = set_processor_max_state(guid, new_value)
            if not success:
                logger.error(f"Failed to increase processor state: {message}")
        else:
            logger.warning(
                "Cannot increase processor state: No active power plan GUID found")
            # 尝试重新获取GUID
            global cached_guid
            cached_guid = None
            guid = get_cached_guid()
            if guid:
                handle_processor_increase()  # 递归调用一次
    except Exception as e:
        logger.error(f"Error increasing processor: {e}", exc_info=True)


def handle_processor_decrease():
    try:
        guid = get_cached_guid()
        if guid:
            current_value = get_processor_max_state(guid)
            new_value = max(0, current_value - 1)
            success, message = set_processor_max_state(guid, new_value)
            if not success:
                logger.error(f"Failed to decrease processor state: {message}")
        else:
            logger.warning(
                "Cannot decrease processor state: No active power plan GUID found")
            # 尝试重新获取GUID
            global cached_guid
            cached_guid = None
            guid = get_cached_guid()
            if guid:
                handle_processor_decrease()  # 递归调用一次
    except Exception as e:
        logger.error(f"Error decreasing processor: {e}", exc_info=True)


def handle_alt_p():
    try:
        ku_lnk_path = os.path.join(
            os.path.expanduser('~\\Desktop'), 'ku       .lnk')
        if not os.path.exists(ku_lnk_path):
            ku_lnk_path = os.path.join(os.path.dirname(
                os.path.abspath(__file__)), 'ku       .lnk')
        if os.path.exists(ku_lnk_path):
            os.startfile(ku_lnk_path)
    except Exception as e:
        logger.error(f"Error opening ku link: {e}", exc_info=True)

# 滚动功能 - 基于Shift/Alt双击检测


def get_cursor_window():
    """获取光标所在的窗口句柄 - 增强版带超时处理"""
    try:
        # 设置操作超时时间
        timeout = 1.0  # 1秒超时
        start_time = time.time()

        while time.time() - start_time < timeout:
            try:
                x, y = win32api.GetCursorPos()
                hwnd = win32gui.WindowFromPoint((x, y))

                # 验证窗口句柄是否有效
                if hwnd and win32gui.IsWindow(hwnd):
                    return hwnd
                # 短暂暂停后重试
                time.sleep(0.01)
            except Exception:
                # 忽略单次获取失败，继续尝试
                time.sleep(0.01)
                continue

        # 超时后记录错误
        logger.error("Timeout getting cursor window after 1 second")
        return None
    except Exception as e:
        logger.error(f"Error getting cursor window: {e}", exc_info=True)
        return None


def get_root_window_from_cursor():
    """直接获取光标下方的根窗口句柄，不使用缓存"""
    try:
        # 获取光标位置
        pos = win32gui.GetCursorPos()
        # 获取光标位置的窗口句柄
        hwnd = win32gui.WindowFromPoint(pos)
        # 获取该窗口的根窗口
        root_hwnd = win32gui.GetAncestor(hwnd, win32con.GA_ROOT)
        return root_hwnd
    except Exception as e:
        logger.warning(f"Error getting root window from cursor: {e}")
        return None

        # 向上查找根窗口
        # 保存原始句柄用于日志
        original_hwnd = hwnd

        # 尝试获取窗口的类名
        try:
            class_name = win32gui.GetClassName(hwnd)
            logger.debug(f"Initial window class: {class_name}")

            # 检查是否是黑名单类
            if class_name in WINDOW_CLASS_BLACKLIST:
                logger.debug(
                    f"Window class {class_name} is in blacklist, finding parent")
                parent = win32gui.GetParent(hwnd)
                if parent and win32gui.IsWindow(parent):
                    hwnd = parent
                    logger.debug(f"Moved to parent window: {hwnd}")
        except Exception as e_class:
            logger.warning(f"Error getting window class: {e_class}")

        # 持续向上查找，直到找不到父窗口或达到最大深度
        max_depth = 10  # 防止无限循环
        depth = 0
        while depth < max_depth:
            parent = win32gui.GetParent(hwnd)
            if not parent or parent == hwnd or not win32gui.IsWindow(parent):
                # 没有父窗口或父窗口无效，当前就是根窗口
                break

            # 检查父窗口类名
            try:
                parent_class = win32gui.GetClassName(parent)
                # 如果父窗口是桌面窗口，停止查找
                if parent_class == "#32769" or parent_class == "Progman" or parent_class == "WorkerW":
                    break
                logger.debug(
                    f"Moving to parent window {parent} with class {parent_class}")
            except Exception as e_parent:
                logger.warning(
                    f"Error getting parent window class: {e_parent}")

            hwnd = parent
            depth += 1

        # 如果深度达到最大值，记录警告
        if depth >= max_depth:
            logger.warning(
                f"Reached max depth {max_depth} when finding root window")

        # 获取最终窗口的标题和类名用于日志
        try:
            window_title = win32gui.GetWindowText(hwnd) or "Untitled"
            window_class = win32gui.GetClassName(hwnd)
            logger.info(
                f"Found root window: hwnd={hwnd}, title={window_title}, class={window_class}")
        except Exception as e_info:
            logger.warning(f"Error getting root window info: {e_info}")

        # 更新缓存
        last_root_window_hwnd = hwnd
        last_root_window_time = current_time

        return hwnd
    except Exception as e:
        logger.error(
            f"Error getting root window from cursor: {e}", exc_info=True)
        return None


def activate_window(hwnd):
    """激活窗口并确保其获得焦点 - 增强版带错误处理"""
    if not hwnd:
        return False

    try:
        # 检查窗口是否可见
        if not win32gui.IsWindowVisible(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
            time.sleep(0.05)

        # 尝试第一种方法: SetForegroundWindow
        try:
            # 先获取当前线程ID和窗口线程ID
            current_thread_id = win32api.GetCurrentThreadId()
            window_thread_id = win32process.GetWindowThreadProcessId(hwnd)[0]

            # 附加线程赢入
            if current_thread_id != window_thread_id:
                win32process.AttachThreadInput(
                    current_thread_id, window_thread_id, True)

            # 设置窗口为前景
            result = win32gui.SetForegroundWindow(hwnd)
            if result:
                win32gui.BringWindowToTop(hwnd)
                win32gui.SetActiveWindow(hwnd)
                time.sleep(0.05)
                return True
        except Exception as e_inner:
            # 忽略内部异常，继续尝试其他方法
            pass
        finally:
            try:
                # 分离线程赢入
                win32process.AttachThreadInput(
                    current_thread_id, window_thread_id, False)
            except:
                pass

        # 尝试第二种方法: 使用Alt+Tab模拟（更可靠但有视觉效果）
        try:
            # 先最小化再恢复窗口（有时能解决问题）
            win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
            time.sleep(0.02)
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            time.sleep(0.05)
            return True
        except Exception as e_inner:
            # 记录详细错误信息但不中断流程
            logger.error(
                f"Error activating window with fallback methods: {e_inner}", exc_info=True)

        return False
    except Exception as e:
        logger.error(f"Error activating window: {e}", exc_info=True)
        return False


def scroll_using_standard_shortcuts(to_bottom):
    """使用标准快捷键组合滚动 - 增强版带错误处理"""
    try:
        hwnd = get_cursor_window()
        if not hwnd:
            logger.warning("No window handle found for scrolling")
            return False

        # 尝试激活窗口，但不强制要求成功
        activate_window(hwnd)

        # 使用键盘控制器时添加额外的错误处理
        try:
            with kb_controller.pressed(Key.ctrl):
                if to_bottom:
                    kb_controller.tap(Key.end)
                else:
                    kb_controller.tap(Key.home)
            return True
        except Exception as e_inner:
            logger.error(
                f"Keyboard controller error in standard shortcuts: {e_inner}")
            return False
    except Exception as e:
        logger.error(f"Error in standard shortcuts: {e}", exc_info=True)
        return False


def scroll_using_browser_shortcuts(to_bottom):
    """使用浏览器特定快捷键滚动 - 增强版带错误处理"""
    try:
        hwnd = get_cursor_window()
        if not hwnd:
            logger.warning("No window handle found for scrolling")
            return False

        # 尝试激活窗口，但不强制要求成功
        activate_window(hwnd)

        # 使用键盘控制器时添加额外的错误处理
        try:
            if to_bottom:
                kb_controller.tap(Key.end)
            else:
                kb_controller.tap(Key.home)
            return True
        except Exception as e_inner:
            logger.error(
                f"Keyboard controller error in browser shortcuts: {e_inner}")
            return False
    except Exception as e:
        logger.error(f"Error in browser shortcuts: {e}", exc_info=True)
        return False


def scroll_using_mouse_wheel(to_bottom):
    """使用光标 滚轮模拟滚动 - 增强版带错误处理"""
    try:
        hwnd = get_cursor_window()
        if not hwnd:
            logger.warning("No window handle found for scrolling")
            return False

        # 获取窗口位置时添加额外检查
        try:
            rect = win32gui.GetWindowRect(hwnd)
            if rect[0] == rect[1] == rect[2] == rect[3] == 0:
                logger.warning("Invalid window rect for scrolling")
                return False

            center_x = (rect[0] + rect[2]) // 2
            center_y = (rect[1] + rect[3]) // 2
        except Exception as e_inner:
            logger.error(f"Error getting window rect: {e_inner}")
            return False

        # 保存和恢复光标 位置时添加额外的错误处理
        try:
            current_x, current_y = mouse_controller.position
            mouse_controller.position = (center_x, center_y)
            time.sleep(0.05)
        except Exception as e_inner:
            logger.error(f"Mouse controller error: {e_inner}")
            return False

        # 执行滚动操作时添加额外的错误处理
        try:
            scroll_amount = 100 if to_bottom else -100
            scroll_count = 0
            max_scroll = 30  # 最大滚动次数

            for _ in range(max_scroll):
                try:
                    win32api.mouse_event(
                        win32con.MOUSEEVENTF_WHEEL, 0, 0, scroll_amount, 0)
                    scroll_count += 1
                    time.sleep(0.01)
                except Exception as e_scroll:
                    logger.warning(f"Mouse scroll event error: {e_scroll}")
                    break  # 如果单次滚动失败，停止继续尝试
        except Exception as e_inner:
            logger.error(f"Scroll operation error: {e_inner}")
        finally:
            # 无论如何都尝试恢复光标 位置
            try:
                mouse_controller.position = (current_x, current_y)
            except Exception as e_inner:
                logger.error(f"Failed to restore mouse position: {e_inner}")

        # 如果至少执行了一次滚动，就认为成功
        return scroll_count > 0
    except Exception as e:
        logger.error(f"Error in mouse wheel scroll: {e}", exc_info=True)
        return False


def scroll_using_text_commands(hwnd, to_bottom):
    """对文本控件使用专用命令"""
    if not hwnd:
        return False

    try:
        class_name = win32gui.GetClassName(hwnd)
        if class_name in ["Edit", "RichEdit", "RichEdit20A", "RichEdit20W", "TEdit"]:
            win32gui.SendMessage(hwnd, win32con.EM_SCROLL,
                                 win32con.SB_BOTTOM if to_bottom else win32con.SB_TOP, 0)
            return True
        return False
    except Exception as e:
        logger.error(f"Error in text commands: {e}", exc_info=True)
        return False


def is_qq_main_window(hwnd):
    """检测是否为QQ主面板窗口"""
    try:
        window_title = win32gui.GetWindowText(hwnd)
        class_name = win32gui.GetClassName(hwnd)
        # QQ主面板的类名通常包含"TXGuiFoundation"和标题包含"QQ"但不是聊天窗口
        if "TXGuiFoundation" in class_name and "QQ" in window_title and not "聊天中" in window_title:
            return True
        return False
    except Exception:
        return False


def is_chrome_browser(hwnd):
    """检测是否为Chrome浏览器窗口"""
    try:
        window_title = win32gui.GetWindowText(hwnd)
        class_name = win32gui.GetClassName(hwnd)
        # Chrome浏览器的类名通常为"Chrome_WidgetWin_1"
        if "Chrome_WidgetWin_1" in class_name:
            return True
        return False
    except Exception:
        return False


def scroll_using_page_up_down(to_bottom):
    """使用Windows API从底层模拟Page Up/Down键滚动 - 不受系统键映射影响"""
    try:
        # 直接使用Windows API模拟按键，绕过系统键映射
        import ctypes
        from ctypes import wintypes

        # 定义Windows API常量
        KEYEVENTF_KEYUP = 0x0002
        VK_PRIOR = 0x21  # Page Up键
        VK_NEXT = 0x22   # Page Down键

        # 选择按键类型
        vk_code = VK_NEXT if to_bottom else VK_PRIOR
        key_name = "Page Down" if to_bottom else "Page Up"

        logger.debug(
            f"Starting low-level {key_name} simulation, {99} presses to {'bottom' if to_bottom else 'top'}")

        # 定义keybd_event函数
        user32 = ctypes.windll.user32
        keybd_event = user32.keybd_event
        # 修复: 使用WPARAM替代ULONG_PTR，因为在某些Python版本中ULONG_PTR可能不存在
        keybd_event.argtypes = [wintypes.BYTE,
                                wintypes.BYTE, wintypes.DWORD, wintypes.WPARAM]
        keybd_event.restype = None

        # 模拟按键函数
        def simulate_key_press(vk):
            # 按下键
            keybd_event(vk, 0, 0, 0)
            # 释放键
            keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)

        # 先快速按几次，然后逐渐减慢速度
        # 前30次快速按
        for i in range(30):
            simulate_key_press(vk_code)
            time.sleep(0.01)  # 非常短暂的延迟

        # 中间30次中等速度
        for i in range(30):
            simulate_key_press(vk_code)
            time.sleep(0.02)  # 中等延迟

        # 最后39次稍微慢一点
        for i in range(39):
            simulate_key_press(vk_code)
            time.sleep(0.03)  # 稍微长一点的延迟

        logger.debug(f"Completed {99} low-level {key_name} presses")
        return True

    except Exception as e:
        logger.error(
            f"Error in low-level page up/down scroll: {e}", exc_info=True)
        # 如果底层方法失败，尝试使用pynput作为备选方案
        try:
            hwnd = get_cursor_window()
            if not hwnd:
                logger.warning("No window handle found for scrolling")
                return False

            logger.debug(
                f"Falling back to pynput for {99} page up/down presses")
            scroll_key = Key.page_down if to_bottom else Key.page_up

            for _ in range(99):
                kb_controller.tap(scroll_key)
                time.sleep(0.02)

            return True
        except Exception as e_fallback:
            logger.error(f"Fallback to pynput failed: {e_fallback}")
            return False


def scroll_using_js_injection(hwnd, to_bottom):
    """尝试使用JavaScript注入方式（针对现代浏览器）"""
    if not is_chrome_browser(hwnd):
        return False

    try:
        logger.debug("Attempting JavaScript injection for Chrome")
        # 注意：这种方法在某些环境下可能不工作，因为需要与浏览器进程交互
        # 但我们可以尝试更安全的替代方法

        # 对于Chrome，我们使用特定的快捷键组合
        with kb_controller.pressed(Key.shift):
            if to_bottom:
                kb_controller.tap(Key.end)
            else:
                kb_controller.tap(Key.home)
        return True
    except Exception as e:
        logger.error(f"Error in JS injection method: {e}", exc_info=True)
        return False


def scroll_window(hwnd, to_bottom):
    """简化的滚动策略 - 适用于所有应用程序，保持高效简洁"""
    if not hwnd:
        logger.warning("Cannot scroll window: No window handle provided")
        return

    try:
        # 记录滚动尝试开始
        window_title = win32gui.GetWindowText(hwnd) or "Unknown"
        logger.debug(
            f"Attempting to scroll window '{window_title}' to {'bottom' if to_bottom else 'top'}")

        # 1. 对传统文本控件使用专用命令
        if scroll_using_text_commands(hwnd, to_bottom):
            logger.debug("Scroll successful using text commands")
            return

        # 2. 尝试标准Ctrl+Home/End快捷键
        if scroll_using_standard_shortcuts(to_bottom):
            logger.debug("Scroll successful using standard shortcuts")
            return

        # 3. 尝试仅使用Home/End键
        if scroll_using_browser_shortcuts(to_bottom):
            logger.debug("Scroll successful using browser shortcuts")
            return

        # 4. 尝试Page Up/Down键滚动
        if scroll_using_page_up_down(to_bottom):
            logger.debug("Scroll successful using page up/down")
            return

        # 5. 尝试光标 滚轮模拟（作为最后的选择）
        if scroll_using_mouse_wheel(to_bottom):
            logger.debug("Scroll successful using mouse wheel")
            return

        # 所有方法都失败时记录警告
        logger.warning(
            f"All scroll methods failed for window '{window_title}'")

    except Exception as e:
        logger.error(f"Error in scroll_window: {e}", exc_info=True)


# 黄色跟随圆形窗口 - 增强版置顶功能
class q25(QWidget):
    def __init__(self):
        super().__init__()

        # 增强窗口置顶性的标志组合
        self.setWindowFlags(
            Qt.FramelessWindowHint |
            Qt.WindowStaysOnTopHint |
            Qt.Tool |
            Qt.WindowTransparentForInput |
            Qt.X11BypassWindowManagerHint  # 增加绕过窗口管理器的标志以增强置顶性
        )

        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_NoSystemBackground, True)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)  # 额外确保光标 事件穿透

        self.resize(30, 30)
        self.show()

        try:
            self.hwnd = int(self.winId())
            # 初始化设置为最顶层窗口
            win32gui.SetWindowPos(self.hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                                  win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOACTIVATE)
        except Exception as e:
            logger.error(f"Error setting topmost: {e}", exc_info=True)

        # 增加置顶刷新频率（从5秒改为1秒）
        self.topmost_timer = QTimer(self)
        self.topmost_timer.timeout.connect(self.refresh_topmost)
        self.topmost_timer.start(1000)  # 每秒刷新一次

        QTimer.singleShot(0, self.q26)

    def refresh_topmost(self):
        try:
            # 使用更多标志来增强置顶性
            win32gui.SetWindowPos(self.hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                                  win32con.SWP_NOMOVE | win32con.SWP_NOSIZE |
                                  win32con.SWP_NOACTIVATE | win32con.SWP_SHOWWINDOW)
            # 添加额外的尝试，确保窗口总是在最顶层
            if hasattr(win32con, 'SWP_NOOWNERZORDER'):
                win32gui.SetWindowPos(self.hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                                      win32con.SWP_NOMOVE | win32con.SWP_NOSIZE |
                                      win32con.SWP_NOACTIVATE | win32con.SWP_NOOWNERZORDER)
        except Exception as e:
            logger.warning(f"Error refreshing topmost: {e}")

    def q26(self):
        try:
            x, y = win32gui.GetCursorPos()
            self.move(x - 15, y - 15)
            # 窗口移动后立即刷新置顶状态，确保始终在最上层
            self.refresh_topmost()
            QTimer.singleShot(50, self.q26)
        except pywintypes.error as e:
            if e.winerror == 5:  # 权限错误，静默处理，避免日志刷屏
                QTimer.singleShot(50, self.q26)
            else:
                logger.error(f"Error in cursor follow: {e}", exc_info=True)
                QTimer.singleShot(50, self.q26)
        except Exception as e:
            logger.error(f"Error in cursor follow: {e}", exc_info=True)
            QTimer.singleShot(50, self.q26)

    def paintEvent(self, event):
        try:
            painter = QPainter(self)
            painter.setRenderHint(QPainter.Antialiasing)

            painter.fillRect(self.rect(), QColor(0, 0, 0, 0))

            painter.setPen(Qt.NoPen)
            painter.setBrush(QColor(255, 255, 0, 191))
            painter.drawEllipse(0, 0, 30, 30)
        except Exception as e:
            logger.error(f"Error in paint event: {e}", exc_info=True)

    def closeEvent(self, event):
        try:
            self.topmost_timer.stop()
        except Exception as e:
            logger.error(f"Error stopping timer: {e}", exc_info=True)
        cleanup_and_exit()


# 全局标志变量，控制显示器关闭功能的执行状态
display_off_in_progress = False

# 全局变量：记录上次显示器关闭操作的时间
schedule_display_off_last_time = 0

# 冷却时间设置（秒）
DISPLAY_OFF_COOLDOWN_SECONDS = 60


def schedule_display_off():
    """安排20秒、40秒和60秒后分别关闭显示器，增强稳定性，并添加60秒冷却时间"""
    global display_off_in_progress, schedule_display_off_last_time

    # 检查是否在冷却时间内
    current_time = time.time()
    if current_time - schedule_display_off_last_time < DISPLAY_OFF_COOLDOWN_SECONDS:
        remaining_time = int(DISPLAY_OFF_COOLDOWN_SECONDS -
                             (current_time - schedule_display_off_last_time))
        logger.debug(f"显示器关闭操作处于冷却中，还需等待{remaining_time}秒")
        return

    if display_off_in_progress:
        logger.debug("显示器关闭操作已在进行中，忽略重复请求")
        return

    display_off_in_progress = True
    schedule_display_off_last_time = current_time
    logger.info("显示器将在20秒后首次关闭...")

    def turn_off_display(count):
        global display_off_in_progress
        try:
            # 保存当前窗口状态
            logger.debug("保存窗口状态...")

            # 使用更健壮的方式关闭显示器
            q55()
            logger.info(f"第{count}次关闭显示器")

            # 添加一个短暂延迟，确保系统状态稳定
            QTimer.singleShot(1000, lambda: logger.debug(
                f"第{count}次显示器关闭操作完成，等待唤醒..."))
        except Exception as e:
            logger.error(f"关闭显示器时出错: {e}", exc_info=True)
        finally:
            # 只有在三次操作都完成后才重置标志
            if count >= 3:
                try:
                    display_off_in_progress = False
                    logger.debug("显示器关闭标志已重置")
                except:
                    pass

    # 创建三次定时器，分别在20秒、40秒和60秒后执行
    try:
        # 第1次：20秒后
        QTimer.singleShot(20000, lambda: turn_off_display(1))
        # 第2次：40秒后
        QTimer.singleShot(40000, lambda: turn_off_display(2))
        # 第3次：60秒后
        QTimer.singleShot(60000, lambda: turn_off_display(3))
    except Exception as e:
        logger.error(f"创建显示器关闭定时器失败: {e}", exc_info=True)
        display_off_in_progress = False


class q71(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.FramelessWindowHint |
                            Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_NoSystemBackground, True)
        q30 = q5(q3)
        self.resize(q75, q74)
        self.q31 = QTimer(self)
        self.q31.timeout.connect(self.q32)
        self.q31.timeout.connect(self.update)
        self.q31.start(6000)
        self.show()

    def mousePressEvent(self, event):
        # 处理光标 左键单击事件 - 5秒后关闭显示器
        if event.button() == Qt.LeftButton:
            schedule_display_off()
        super().mousePressEvent(event)

    def closeEvent(self, event):
        cleanup_and_exit()

    def q32(self):
        try:
            screen_width, screen_height = get_cached_screen_size()
            q30 = q5(q3)
            if q44:
                if PANEL_ON_LEFT_SIDE:
                    self.move(5, q5(q2) - q30 - 40 + 4 - q74)  # 靠左侧显示
                else:
                    self.move(screen_width - self.width() - 5,
                              q5(q2) - q30 - 40 + 4 - q74)  # 靠右侧显示
            else:
                if PANEL_ON_LEFT_SIDE:
                    self.move(5, q5(q2) - q30 - 40 + 4)  # 靠左侧显示
                else:
                    self.move(screen_width - self.width() - 5,
                              q5(q2) - q30 - 40 + 4)  # 靠右侧显示
        except Exception as e:
            logger.error(f"Error in q71 positioning: {e}", exc_info=True)

    def paintEvent(self, event):
        try:
            q62 = q47()
            q37 = QPainter(self)
            q37.setRenderHint(QPainter.Antialiasing)
            if q44:
                r, g, b = TIME_PROGRESS_COLOR

                # 根据时区模式选择时间和计算进度条
                if TIME_ZONE_MODE == 0:
                    # 北京时间模式：正常的一天计算
                    now = get_beijing_time()
                    seconds_in_day = (now.hour * 3600) + \
                        (now.minute * 60) + now.second
                    elapsed_ratio = seconds_in_day / (24 * 3600)  # 已过时间比例
                else:
                    # 赫尔辛基时间模式：起点零点，终点零点
                    now = get_helsinki_time()
                    # 计算从当天零点到现在的秒数
                    midnight = now.replace(
                        hour=0, minute=0, second=0, microsecond=0)
                    # 计算从零点到现在的秒数
                    seconds_since_midnight = (now - midnight).total_seconds()
                    # 设定总周期为24小时（零点到零点）
                    total_period_seconds = 24 * 3600
                    elapsed_ratio = seconds_since_midnight / total_period_seconds

                remaining_ratio = 1 - elapsed_ratio  # 剩余时间比例
                elapsed_width = int(self.width() * elapsed_ratio)
                remaining_width = self.width() - elapsed_width

                if PROGRESS_BAR_MODE == 1:
                    # 原来的方式：彩色表示已过时间，黑色表示剩余时间
                    # 绘制黑色背景
                    q37.fillRect(0, 0, self.width(), q74, QColor(0, 0, 0, 255))
                    # 绘制已过时间进度条
                    if PANEL_ON_LEFT_SIDE:
                        # 靠左侧显示时，进度从右向左填充（起点在右边，终点在左边）
                        q37.fillRect(self.width() - elapsed_width, 0, elapsed_width, q74,
                                     QColor(r, g, b, 100))
                    else:
                        # 靠右侧显示时，进度从左向右填充
                        q37.fillRect(0, 0, elapsed_width, q74,
                                     QColor(r, g, b, 100))
                else:
                    # 新的方式：黑色表示已过时间，彩色表示剩余时间
                    # 绘制背景色为时间进度条颜色
                    q37.fillRect(0, 0, self.width(), q74, QColor(r, g, b, 100))
                    # 绘制已过时间（黑色）
                    if PANEL_ON_LEFT_SIDE:
                        # 靠左侧显示时，已过时间从右向左填充（起点在右边，终点在左边）
                        q37.fillRect(self.width() - elapsed_width, 0, elapsed_width, q74,
                                     QColor(0, 0, 0, 255))
                    else:
                        # 靠右侧显示时，已过时间从左向右填充
                        q37.fillRect(0, 0, elapsed_width, q74,
                                     QColor(0, 0, 0, 255))

                # 绘制时间文本
                q37.setPen(QColor(255, 255, 255))
                q37.setFont(QFont("Ink Free", q73, QFont.Bold))
                q79 = q37.fontMetrics()
                q80 = (self.width() - q79.horizontalAdvance(q62)) // 2 - q77
                q81 = 1 - q76
                q37.drawText(q80, q81 + q79.ascent(), q62)
        except Exception as e:
            logger.error(f"Error in q71 paint: {e}", exc_info=True)


class q29(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.FramelessWindowHint |
                            Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_NoSystemBackground, True)
        q30 = q5(q3)
        self.resize(200, q30)
        self.q31 = QTimer(self)
        self.q31.timeout.connect(self.q32)
        self.q31.timeout.connect(self.update)
        self.q31.start(6000)
        self.show()

    def mousePressEvent(self, event):
        # 处理光标 左键单击事件 - 切换上面显示框的显示/隐藏
        if event.button() == Qt.LeftButton:
            global q44
            q44 = not q44
            logger.info(f"切换上面显示框显示状态: {'显示' if q44 else '隐藏'}")
        super().mousePressEvent(event)

    def closeEvent(self, event):
        cleanup_and_exit()

    def q32(self):
        try:
            screen_width, screen_height = get_cached_screen_size()
            q30 = q5(q3)
            if PANEL_ON_LEFT_SIDE:
                self.move(5, q5(q2) - q30 - 40 + 4)  # 靠左侧显示
            else:
                self.move(screen_width - self.width() - 5,
                          q5(q2) - q30 - 40 + 4)  # 靠右侧显示
        except Exception as e:
            logger.error(f"Error in q29 positioning: {e}", exc_info=True)

    def paintEvent(self, event):
        try:
            q34, q35 = get_cached_time_and_disk()
            processor_state = get_cached_processor_state()

            q36 = f"{q34} {q35:.2f} {processor_state}"
            q37 = QPainter(self)
            q37.setRenderHint(QPainter.Antialiasing)

            # 根据时区模式选择时间
            if TIME_ZONE_MODE == 0:
                # 北京时间模式
                now = get_beijing_time()
            else:
                # 赫尔辛基时间模式
                now = get_helsinki_time()

            if progress_mode == 0:
                # 不显示进度条
                elapsed_ratio = 0
            elif progress_mode == 1:
                # 计算周进度：起点是周六0点，终点是下周六0点
                if now.weekday() == 5:  # 如果是周六
                    days_since_saturday = 0
                elif now.weekday() == 6:  # 如果是周日
                    days_since_saturday = 1
                else:  # 工作日
                    days_since_saturday = now.weekday() + 2

                saturday_midnight = now.replace(
                    hour=0, minute=0, second=0, microsecond=0) - datetime.timedelta(days=days_since_saturday)
                seconds_since_saturday = (
                    now - saturday_midnight).total_seconds()
                total_week_seconds = 7 * 24 * 3600
                elapsed_ratio = seconds_since_saturday / total_week_seconds
            elif progress_mode == 3:
                # 计算月进度
                first_day_of_month = now.replace(
                    day=1, hour=0, minute=0, second=0, microsecond=0)

                # 计算下个月的第一天
                if now.month == 12:
                    first_day_of_next_month = first_day_of_month.replace(
                        year=now.year + 1, month=1)
                else:
                    first_day_of_next_month = first_day_of_month.replace(
                        month=now.month + 1)

                total_seconds_in_month = (
                    first_day_of_next_month - first_day_of_month).total_seconds()
                seconds_since_month_start = (
                    now - first_day_of_month).total_seconds()
                elapsed_ratio = seconds_since_month_start / total_seconds_in_month

            # 限制进度在0-1之间
            elapsed_ratio = max(0, min(1, elapsed_ratio))
            # 计算已过时间宽度
            elapsed_width = int(self.width() * elapsed_ratio)
            r, g, b = WEEK_PROGRESS_COLOR

            if PROGRESS_BAR_MODE == 1:
                # 原来的方式：彩色表示已过时间，黑色表示剩余时间
                # 绘制黑色背景
                q37.fillRect(self.rect(), QColor(0, 0, 0, 222))
                # 绘制已过时间进度条
                if PANEL_ON_LEFT_SIDE:
                    # 靠左侧显示时，进度从右向左填充（起点在右边，终点在左边）
                    q37.fillRect(self.width() - elapsed_width, 0, elapsed_width, self.height(),
                                 QColor(r, g, b, 100))
                else:
                    # 靠右侧显示时，进度从左向右填充
                    q37.fillRect(0, 0, elapsed_width, self.height(),
                                 QColor(r, g, b, 100))
            else:
                # 新的方式：黑色表示已过时间，彩色表示剩余时间
                # 绘制背景色为周进度条颜色
                q37.fillRect(self.rect(), QColor(r, g, b, 100))
                # 绘制已过时间（黑色）
                if PANEL_ON_LEFT_SIDE:
                    # 靠左侧显示时，已过时间从右向左填充（起点在右边，终点在左边）
                    q37.fillRect(self.width() - elapsed_width, 0, elapsed_width, self.height(),
                                 QColor(0, 0, 0, 222))
                else:
                    # 靠右侧显示时，已过时间从左向右填充
                    q37.fillRect(0, 0, elapsed_width, self.height(),
                                 QColor(0, 0, 0, 222))

            # 绘制文本
            if q35 < 0.6:
                q37.setPen(QColor(255, 0, 0))
            else:
                q37.setPen(QColor(255, 255, 255))
            q37.setFont(QFont("Microsoft YaHei", 10, QFont.Bold))
            q37.drawText(self.rect(), Qt.AlignCenter, q36)
        except Exception as e:
            logger.error(f"Error in q29 paint: {e}", exc_info=True)


def get_window_path_by_hwnd(hwnd):
    """根据窗口句柄获取窗口对应的路径"""
    # 默认返回桌面路径，确保即使出现问题也不会使用系统路径
    default_path = os.path.expanduser('~\\Desktop')

    if not hwnd or not win32gui.IsWindow(hwnd):
        logger.warning("Invalid window handle provided, using Desktop path")
        return default_path

    try:
        # 增强的桌面窗口检测
        window_class = win32gui.GetClassName(hwnd)
        window_title = win32gui.GetWindowText(hwnd) or ""

        # 扩展桌面窗口类列表
        desktop_classes = ["#32769", "Progman", "WorkerW", "Shell_TrayWnd",
                           "Afx:400000:0", "DummyDWMListenerWindow", "EdgeUiInputTopWndClass"]

        if window_class in desktop_classes:
            logger.debug(
                f"Window is desktop ({window_class}), returning Desktop path")
            return default_path

        # 检查是否是explorer.exe进程，但不是资源管理器窗口
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            PROCESS_QUERY_INFORMATION = 0x0400
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_INFORMATION, False, pid)
            if handle:
                buffer = ctypes.create_unicode_buffer(260)
                size = wintypes.DWORD(260)
                if ctypes.windll.psapi.GetModuleFileNameExW(handle, None, buffer, size):
                    process_path = buffer.value
                    ctypes.windll.kernel32.CloseHandle(handle)
                    # 如果是explorer.exe进程，但不是有效的资源管理器窗口路径，返回桌面路径
                    if process_path and 'explorer.exe' in process_path.lower():
                        # 尝试作为资源管理器窗口处理
                        shell = None
                        try:
                            import win32com.client
                            shell = win32com.client.Dispatch(
                                "Shell.Application")
                            is_valid_explorer_window = False
                            for window in shell.Windows():
                                try:
                                    if window.HWND == hwnd:
                                        is_valid_explorer_window = True
                                        break
                                except Exception:
                                    continue
                            # 如果不是有效的资源管理器窗口，返回桌面路径
                            if not is_valid_explorer_window:
                                logger.debug(
                                    f"Explorer.exe process but not valid explorer window, returning Desktop path")
                                return default_path
                        except Exception:
                            pass
                        finally:
                            if shell:
                                try:
                                    del shell
                                except Exception:
                                    pass
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"Error checking if window is desktop: {e}")
        return default_path

    try:
        shell = None
        try:
            import win32com.client
            shell = win32com.client.Dispatch("Shell.Application")

            for window in shell.Windows():
                try:
                    if window.HWND == hwnd:
                        location = window.LocationURL
                        if location and location.startswith('file:///'):
                            path = location.replace(
                                'file:///', '').replace('/', '\\')
                            path = urllib.parse.unquote(path)
                            if os.path.exists(path):
                                logger.debug(
                                    f"Found explorer window path: {path}")
                                return path
                except Exception:
                    continue
        except ImportError:
            pass
        finally:
            if shell:
                try:
                    del shell
                except Exception:
                    pass

        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)

            PROCESS_QUERY_INFORMATION = 0x0400
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_INFORMATION, False, pid)
            if handle:
                buffer = ctypes.create_unicode_buffer(260)
                size = wintypes.DWORD(260)
                if ctypes.windll.psapi.GetModuleFileNameExW(handle, None, buffer, size):
                    process_path = buffer.value
                    ctypes.windll.kernel32.CloseHandle(handle)
                    if process_path:
                        exe_dir = os.path.dirname(process_path)
                        # 检查是否为系统路径，如果是则返回桌面路径
                        system_paths = [os.environ.get('SYSTEMROOT', 'C:\\Windows'),
                                        os.environ.get(
                                            'WINDIR', 'C:\\Windows'),
                                        os.path.join(os.environ.get(
                                            'SYSTEMROOT', 'C:\\Windows'), 'System32'),
                                        os.path.join(os.environ.get('SYSTEMROOT', 'C:\\Windows'), 'SysWOW64')]
                        is_system_path = False
                        for sys_path in system_paths:
                            if sys_path and exe_dir.lower().startswith(sys_path.lower()):
                                is_system_path = True
                                break

                        if is_system_path:
                            logger.debug(
                                f"Process directory is system path: {exe_dir}, returning Desktop path")
                            return default_path

                        logger.debug(f"Found process directory: {exe_dir}")
                        return exe_dir
                ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:
            pass

        # 尝试获取窗口标题并查找可能的路径
        try:
            window_title = win32gui.GetWindowText(hwnd)
            if window_title and '\\' in window_title:
                # 检查窗口标题中是否包含有效的路径
                path_candidate = window_title
                # 处理类似"文件名 - 应用程序"的格式
                if ' - ' in window_title:
                    path_candidate = window_title.split(' - ')[0]
                # 处理类似"应用程序 - 文件名"的格式
                elif ' - ' in window_title[::-1]:  # 从后往前找
                    path_candidate = window_title.rsplit(' - ', 1)[1]

                if os.path.exists(path_candidate):
                    logger.debug(
                        f"Found path in window title: {path_candidate}")
                    return path_candidate
                elif os.path.exists(os.path.dirname(path_candidate)):
                    logger.debug(
                        f"Found parent path in window title: {os.path.dirname(path_candidate)}")
                    return os.path.dirname(path_candidate)
        except Exception:
            pass

        logger.warning(
            "Could not determine path from window handle, using Desktop")
        return default_path
    except Exception as e:
        logger.error(f"Error getting window path: {e}", exc_info=True)
        return default_path


def get_focus_window_path():
    """获取焦点窗口的路径 - 保留原有接口但内部实现改为使用根窗口"""
    # 默认返回桌面路径
    default_path = os.path.expanduser('~\\Desktop')

    # 优先使用光标位置的根窗口
    hwnd = get_root_window_from_cursor()
    if hwnd:
        return get_window_path_by_hwnd(hwnd)

    # 如果无法获取根窗口，回退到原有方式
    try:
        hwnd = win32gui.GetForegroundWindow()
        return get_window_path_by_hwnd(hwnd)
    except Exception as e:
        logger.error(f"Error getting foreground window path: {e}")
        return default_path


def open_admin_powershell(path=None):
    try:
        # 获取路径，如果未指定则使用焦点窗口路径
        if path is None:
            path = get_focus_window_path()
            logger.debug(f"get_focus_window_path returned: {path}")

        # 确保路径有效，如果无效则使用桌面路径
        default_path = os.path.expanduser('~\\Desktop')
        if not path or not os.path.exists(path):
            logger.warning(
                f"Path '{path}' is invalid, using Desktop path: {default_path}")
            path = default_path
        logger.info(f"Opening admin PowerShell at path: {path}")

        # 特别处理桌面环境下的路径设置
        if path == default_path:
            logger.info(f"Using Desktop path as working directory")

        # 使用绝对路径和更安全的参数格式
        abs_path = os.path.abspath(path)
        logger.debug(f"Absolute path: {abs_path}")

        # 使用更简单可靠的参数格式，避免过多的引号嵌套
        command = f'-NoExit -Command cd "{abs_path}"'  # 简化为直接使用cd命令
        logger.debug(f"PowerShell command: {command}")

        ctypes.windll.shell32.ShellExecuteW(
            None, "runas", "powershell.exe",
            command,
            None, 1  # 不指定工作目录，通过命令内部设置
        )
        return True
    except Exception as e:
        logger.error(f"Error opening admin powershell: {e}", exc_info=True)
        return False


def open_admin_cmd(path=None):
    try:
        # 获取路径，如果未指定则使用焦点窗口路径
        if path is None:
            path = get_focus_window_path()
            logger.debug(f"get_focus_window_path returned: {path}")

        # 确保路径有效，如果无效则使用桌面路径
        default_path = os.path.expanduser('~\\Desktop')
        if not path or not os.path.exists(path):
            logger.warning(
                f"Path '{path}' is invalid, using Desktop path: {default_path}")
            path = default_path
        logger.info(f"Opening admin Command Prompt at path: {path}")

        # 特别处理桌面环境下的路径设置
        if path == default_path:
            logger.info(f"Using Desktop path as working directory")

        # 使用绝对路径和更安全的参数格式
        abs_path = os.path.abspath(path)
        logger.debug(f"Absolute path: {abs_path}")

        # 使用更简单可靠的参数格式，避免过多的引号嵌套
        command = f'/k "cd /d \"{abs_path}\""'
        logger.debug(f"Command Prompt command: {command}")

        ctypes.windll.shell32.ShellExecuteW(
            None, "runas", "cmd.exe",
            command,
            None, 1  # 不指定工作目录，通过命令内部设置
        )
        return True
    except Exception as e:
        logger.error(f"Error opening admin cmd: {e}", exc_info=True)
        return False


def handle_f7_key_release():
    """处理F7键释放事件，执行时间窗口内最后一个按键的动作"""
    global last_key_press_time
    current_time = time.time()

    latest_key = None
    latest_time = 0

    # 寻找在时间窗口内最后一个被按下的键
    for key, press_time in list(last_key_press_time.items()):
        time_diff = current_time - press_time
        if 0 < time_diff < F7_COMBO_THRESHOLD:
            if press_time > latest_time:
                latest_time = press_time
                latest_key = key

    # 如果找到了符合条件的键，则执行动作
    if latest_key:
        logger.info(
            f"F7 combo detected with latest key '{latest_key}' ({current_time - latest_time:.3f}s within threshold)")
        execute_f7_action(latest_key)
        # 清除所有在时间窗口内的键，避免重复触发
        keys_to_remove = [k for k, t in last_key_press_time.items(
        ) if current_time - t < F7_COMBO_THRESHOLD]
        for k in keys_to_remove:
            del last_key_press_time[k]


def on_press(key):
    global pressed_keys, last_key_press_time
    try:
        pressed_keys.add(key)

        # 记录F7组合键的按下时间
        if hasattr(key, 'char') and key.char:
            char = key.char.lower()
            if char in ['z', 'w', 'x', '1', '2', '3', '4', 'a', 's', 'd', 'q']:
                current_time = time.time()
                last_key_press_time[char] = current_time
                logger.debug(f"Key '{char}' pressed at {current_time}")

        # 检测热键组合 - 支持左/右Alt
        alt_pressed = Key.alt_l in pressed_keys or Key.alt_r in pressed_keys
        if alt_pressed:
            if hasattr(key, 'char') and key.char and key.char.lower() == 'n':
                # 按下Alt+n时，只删除文件夹a，重启操作将在下一次轮询时执行
                q24()  # 删除文件夹a
            # Alt+K热键已空闲出来，不再执行任何操作
            elif hasattr(key, 'char') and key.char and key.char.lower() == 'l':
                handle_processor_increase()
            elif hasattr(key, 'char') and key.char and key.char.lower() == 'j':
                handle_processor_decrease()
            elif hasattr(key, 'char') and key.char and key.char.lower() == 'p':
                handle_alt_p()

    except Exception as e:
        logger.error(f"Error in on_press: {e}", exc_info=True)


def on_release(key):
    """统一的按键释放处理器，处理所有释放事件"""
    global pressed_keys, last_key_release_time, last_space_release_time, last_shift_release_time, last_alt_release_time

    try:
        if key == Key.f4:
            simulate_left_click()
            return

        # 从按键集合中移除
        if key in pressed_keys:
            pressed_keys.remove(key)

        # === 2. F7组合键逻辑（保持原样）===
        if key == Key.f7:
            handle_f7_key_release()
            return

        # === 3. 记录普通键释放时间（F7 组合用）===
        if hasattr(key, 'char') and key.char:
            char = key.char.lower()
            if char in ['z', 'w', 'x', '1', '2', '3', '4', 'a', 's', 'd', 'q']:
                current_time = time.time()
                last_key_release_time[char] = current_time
                if char in ['z', 'w', 'x']:
                    logger.debug(f"Key '{char}' released at {current_time}")
                return

        # === 4. 双击 Shift / Alt 滚动（保持原样）===
        current_time = time.time()
        if key in (Key.shift_l, Key.shift_r):
            if current_time - last_shift_release_time < KEY_THRESHOLD:
                logger.info("双击 Shift 触发 → 滚动到顶部")
                hwnd = get_cursor_window()
                if hwnd:
                    scroll_window(hwnd, to_bottom=False)
                last_shift_release_time = 0
            else:
                last_shift_release_time = current_time

        elif key in (Key.alt_l, Key.alt_r):
            if current_time - last_alt_release_time < KEY_THRESHOLD:
                logger.info("双击 Alt 触发 → 滚动到底部")
                hwnd = get_cursor_window()
                if hwnd:
                    scroll_window(hwnd, to_bottom=True)
                last_alt_release_time = 0
            else:
                last_alt_release_time = current_time

    except Exception as e:
        logger.error(f"Error in on_release: {e}", exc_info=True)


def start_keyboard_listener():
    global keyboard_listener
    if keyboard_listener:
        try:
            keyboard_listener.stop()
        except Exception as e:
            logger.error(f"Error stopping old listener: {e}", exc_info=True)
    keyboard_listener = Listener(on_press=on_press, on_release=on_release)
    keyboard_listener.daemon = True
    keyboard_listener.start()


def reinitialize_listener():
    """在 explorer 重启后重新初始化监听器"""
    try:
        start_keyboard_listener()
    except Exception as e:
        logger.error(f"Error reinitializing listener: {e}", exc_info=True)


if __name__ == '__main__':
    q15()
    """主程序入口点 - 增强版带全面异常处理和显示器状态监控"""
    try:
        # 配置全局异常处理
        def handle_uncaught_exception(exc_type, exc_value, exc_traceback):
            """处理未捕获的异常"""
            if issubclass(exc_type, KeyboardInterrupt):
                # 处理用户中断（Ctrl+C）
                sys.__excepthook__(exc_type, exc_value, exc_traceback)
                return

            # 记录异常信息
            logger.error("Uncaught exception", exc_info=(
                exc_type, exc_value, exc_traceback))

            # 在控制台打印异常信息
            import traceback
            traceback.print_exception(exc_type, exc_value, exc_traceback)

        # 设置全局异常钩子
        sys.excepthook = handle_uncaught_exception

        logger.info("Application started")

        # 尝试以管理员身份运行
        try:
            q15()
        except SystemExit:
            logger.info("Restarting as administrator")
            pass

        # 创建应用程序实例
        app_instance = QApplication(sys.argv)
        logger.info("Application instance created")

        # 文件夹管理已移至轮询线程中统一处理
        # 启动轮询线程后会自动检查和创建文件夹
        logger.info("Directory management moved to polling thread")

        # 创建窗口
        try:
            info_window = q29()
            cursor_window = q25()
            time_window = q71()
            logger.info("All windows created successfully")
        except Exception as e:
            logger.error(f"Error creating windows: {e}", exc_info=True)

        # 启动时间同步
        try:
            start_hourly_time_sync()
            logger.info("Time synchronization started")
        except Exception as e:
            logger.error(f"Error starting time sync: {e}", exc_info=True)

        # 启动键盘监听器
        try:
            start_keyboard_listener()
            logger.info("Keyboard listener started")
        except Exception as e:
            logger.error(
                f"Error starting keyboard listener: {e}", exc_info=True)

        # restart_explorer_and_reinit函数已移至全局作用域

        # 启动整合轮询线程
        try:
            # 重置缓存时间，确保轮询线程立即检查文件夹
            last_cache_time = 0

            # 启动轮询线程
            polling_thread = Thread(target=integrated_polling, daemon=True)
            polling_thread.start()
        except Exception as e:
            logger.error(f"Error starting integrated polling thread: {e}")

        # 运行应用程序主循环
        try:
            sys.exit(app_instance.exec_())
        except Exception as e:
            logger.error(f"Error in main app execution: {e}")
            cleanup_and_exit()
    except Exception as e:
        # 捕获主程序块中的所有异常
        logger.error(f"Fatal error in main application: {e}")
        try:
            # 即使在最严重的错误情况下也尝试清理资源
            cleanup_and_exit()
        except:
            # 如果清理也失败，强制退出
            os._exit(1)

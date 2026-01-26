# q3.py (v5.1.0 - Two Strategy, No FastClear)
# -*- coding: utf-8 -*-

"""
v5.1.0

变更要点：
1. 移除 Fast Clear 逻辑（不再根据 formats() 为空就立刻弹清空），避免误伤全屏截图。
2. 保留两种清空策略，但都基于“轮询次数 + 时间兜底”：
   - CLEAR_STRATEGY_MODE = 0：快速模式（轮询次数少，硬超时短，更灵敏但更容易把“很慢才出数据”的情况认定为清空）。
   - CLEAR_STRATEGY_MODE = 1：严格模式（轮询次数多，硬超时长，更偏向“等一等，也许是慢截图”）。
3. 纯文本路径：只用 mime_data.text() + Python 计算字节数，减少底层 text/plain 调用。
4. 未知类型（如 REAPERMedia）保持原有能力：抓 payload、算大小、显示“未知内容，类型: xxx”。
5. 所有可调参数集中在顶部 CONFIG 区。
"""

import sys
import os
import signal
import concurrent.futures

from PySide2.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout,
    QTextEdit, QScrollBar, QStyleOptionSlider, QStyle,
    QPushButton
)
from PySide2.QtCore import (
    Qt, QTimer, QPoint, QPropertyAnimation, Signal, QBuffer,
    QIODevice, QParallelAnimationGroup, QAbstractAnimation,
    QEvent, QTime, QRect
)
from PySide2.QtGui import (
    QFont, QPainter, QColor, QPen, QCursor,
    QTextOption, QKeySequence, QPalette, QPixmap,
    QImage
)

# ==================== CONFIG：统一可调参数 ====================

# 版本号
VERSION = "5.1.0"

# 颜色方案模式：
#   1 = 黑色
#   2 = 白色
#   3 = 交替：黑 / 白
#   4 = 交替：黑+白底部 / 白+黑底部
COLOR_SCHEME_MODE = 4

# 冷却时间（毫秒）
COOLDOWN_TIME_MS = 100

# 弹窗尺寸、布局相关
POPUP_WIDTH = 222
POPUP_HEIGHT = 222
CONTENT_AREA_MAX_HEIGHT = 177
BOTTOM_AREA_MIN_HEIGHT = 15

# 弹窗动画 & 生命周期
SLIDE_IN_DURATION = 88
SLIDE_OUT_DURATION = 88
LIFECYCLE_SECONDS = 119

# 滚动条尺寸
SCROLLBAR_WIDTH = 11
SCROLLBAR_MARGIN_RIGHT = 2

# 字体配置
FONT_FAMILY = "Consolas"
FONT_SIZE = 11
FONT_FALLBACKS = [
    "Consolas", "monospace", "LXGW WenKai GB Screen",
    "SF Pro", "Segoe UI", "Aptos", "Roboto", "Arial"
]

# 清空判断策略模式：
#   0 = 快速模式（轮询次数少、超时短；响应快但对“超慢截图”更苛刻）
#   1 = 严格模式（轮询次数多、超时长；更偏向等一等）
CLEAR_STRATEGY_MODE = 1

# 快速模式的捕获轮询参数
CAPTURE_POLL_INTERVAL_MS_FAST = 15
CAPTURE_MAX_ATTEMPTS_FAST = 60          # 正常 ~0.9s
CAPTURE_HARD_TIMEOUT_MS_FAST = 3000     # 硬上限 ~3s

# 严格模式的捕获轮询参数
CAPTURE_POLL_INTERVAL_MS_STRICT = 15
CAPTURE_MAX_ATTEMPTS_STRICT = 150       # 正常 ~2.25s
CAPTURE_HARD_TIMEOUT_MS_STRICT = 7000   # 硬上限 ~7s

# 颜色配置
BLACK_BG = QColor(0, 0, 0, 240)
BLACK_TEXT = Qt.white
BLACK_BORDER = Qt.white
BLACK_GOLD_HEX = "#cd853f"
BLACK_SCROLL_HANDLE = "rgba(205, 133, 63, 204)"
BLACK_HIGHLIGHT = QColor(BLACK_GOLD_HEX)

WHITE_BG = QColor(253, 246, 227, 250)
WHITE_BORDER = QColor(55, 45, 15)
WHITE_TEXT_QCOLOR = QColor(3, 2, 1)
WHITE_GOLD_HEX = "#8B4513"
WHITE_SCROLL_HANDLE = "rgba(139, 69, 19, 204)"
WHITE_HIGHLIGHT = QColor(139, 69, 19, 191)

Qaqqlication = QApplication

# ==================== 音频引擎 ====================

try:
    from miniaudio_nonblocking_v15 import NonBlockingAudioEngine
except ImportError:
    print("=" * 60)
    print("【!!】 错误：未找到 miniaudio_nonblocking_v15 库。")
    print("【!!】 请先在环境中安装 miniaudio_nonblocking_v15 模块。")
    print("=" * 60)
    sys.exit(1)

# =============== 工具函数 ===============

def _get_path_size(path):
    try:
        if os.path.isfile(path):
            return os.path.getsize(path)
        elif os.path.isdir(path):
            total_size = 0
            with os.scandir(path) as entries:
                for entry in entries:
                    try:
                        if entry.is_file(follow_symlinks=False):
                            total_size += entry.stat(follow_symlinks=False).st_size
                        elif entry.is_dir(follow_symlinks=False):
                            total_size += _get_path_size(entry.path)
                    except (OSError, PermissionError):
                        continue
            return total_size
        else:
            return 0
    except (OSError, PermissionError):
        return 0

# =============== 控件类 ===============

class StickyTextEdit(QTextEdit):
    internal_copy_triggered = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.popup = None
        self.setAcceptDrops(True)

    def insertFromMimeData(self, source):
        if source.hasText():
            text = source.text()
            if text:
                self.textCursor().insertText(text)

    def keyPressEvent(self, event):
        if event.matches(QKeySequence.Copy):
            if self.popup and self.popup.is_sticky and self.textCursor().hasSelection():
                self.internal_copy_triggered.emit()
                self.popup.monitor.set_cooldown()
        super().keyPressEvent(event)

    def mousePressEvent(self, event):
        if self.popup and self.popup.is_sticky:
            self.setCursorWidth(1)
        super().mousePressEvent(event)


class ClickJumpScrollBar(QScrollBar):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.press_pos = QPoint()

    def mousePressEvent(self, event):
        if event.button() != Qt.LeftButton:
            self.press_pos = QPoint()
            super().mousePressEvent(event)
            return
        opt = QStyleOptionSlider()
        self.initStyleOption(opt)
        handle_rect = self.style().subControlRect(
            QStyle.CC_ScrollBar, opt, QStyle.SC_ScrollBarSlider, self
        )
        if handle_rect.contains(event.pos()):
            self.press_pos = QPoint()
            super().mousePressEvent(event)
        else:
            self.press_pos = event.pos()

    def mouseReleaseEvent(self, event):
        if event.button() != Qt.LeftButton or self.press_pos.isNull():
            super().mouseReleaseEvent(event)
            return
        moved = (event.pos() - self.press_pos).manhattanLength() > Qaqqlication.startDragDistance()
        click_pos = self.press_pos
        self.press_pos = QPoint()
        if moved:
            super().mouseReleaseEvent(event)
            return
        opt = QStyleOptionSlider()
        self.initStyleOption(opt)
        handle_rect = self.style().subControlRect(
            QStyle.CC_ScrollBar, opt, QStyle.SC_ScrollBarSlider, self
        )
        track_rect = self.style().subControlRect(
            QStyle.CC_ScrollBar, opt, QStyle.SC_ScrollBarGroove, self
        )
        if not track_rect.isValid() or track_rect.isEmpty():
            super().mouseReleaseEvent(event)
            return
        if self.orientation() == Qt.Vertical:
            movable_range = track_rect.height() - handle_rect.height()
            if movable_range <= 0:
                super().mouseReleaseEvent(event)
                return
            ratio = (
                (click_pos.y() - track_rect.top() - handle_rect.height() / 2.0)
                / movable_range
            )
        else:
            movable_range = track_rect.width() - handle_rect.width()
            if movable_range <= 0:
                super().mouseReleaseEvent(event)
                return
            ratio = (
                (click_pos.x() - track_rect.left() - handle_rect.width() / 2.0)
                / movable_range
            )
        ratio = max(0.0, min(1.0, ratio))
        new_value = self.minimum() + round(ratio * (self.maximum() - self.minimum()))
        self.setValue(int(new_value))
        super().mouseReleaseEvent(event)

# =============== ClipboardMonitor ===============

class ClipboardMonitor(Qaqqlication):
    calculation_done = Signal(str, QWidget)

    def __init__(self, argv):
        super().__init__(argv)

        self.COLOR_SCHEME_MODE = COLOR_SCHEME_MODE
        self.current_color_mode = 0
        self.COOLDOWN_TIME_MS = COOLDOWN_TIME_MS

        # 音频引擎
        self.audio_engine = None
        try:
            self.audio_engine = NonBlockingAudioEngine()
            print("音频引擎初始化成功")
        except Exception as e:
            print(f"音频引擎初始化失败: {e}")
            print("将以无音效模式运行")

        self.active_popups = []
        self.is_on_cooldown = False
        self.calculation_done.connect(self.on_calculation_finished)

        try:
            self.setup_clipboard_monitor()
        except Exception as e:
            print(f"设置剪贴板监控异常: {e}")

        self.executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=os.cpu_count() or 8
        )
        self.setup_sound_files()

        # 捕获任务状态（Attempts-Based）
        self._capture_timer = QTimer(self)
        self._capture_timer.setSingleShot(False)

        if CLEAR_STRATEGY_MODE == 0:
            poll_interval = CAPTURE_POLL_INTERVAL_MS_FAST
            self._capture_max_attempts = CAPTURE_MAX_ATTEMPTS_FAST
            self._capture_hard_timeout_ms = CAPTURE_HARD_TIMEOUT_MS_FAST
        else:
            poll_interval = CAPTURE_POLL_INTERVAL_MS_STRICT
            self._capture_max_attempts = CAPTURE_MAX_ATTEMPTS_STRICT
            self._capture_hard_timeout_ms = CAPTURE_HARD_TIMEOUT_MS_STRICT

        self._capture_timer.setInterval(poll_interval)
        self._capture_timer.timeout.connect(self._poll_clipboard)

        self._capture_active = False
        self._capture_start_time = None
        self._capture_seen_clear = False
        self._capture_attempts = 0

    # --- 音效相关 ---

    def setup_sound_files(self):
        if self.audio_engine:
            try:
                print(f"加载主音效: {len(self.audio_engine.main_sounds)} 个")
                print(f"加载 q 音效: {len(self.audio_engine.q_sounds)} 个")
                print(f"加载 z 音效: {len(self.audio_engine.z_sounds)} 个")
            except Exception as e:
                print(f"获取音效信息失败: {e}")
        else:
            print("音频引擎未初始化，音效不可用")

    def play_random_sound(self):
        if self.audio_engine:
            try:
                self.audio_engine.play_random_sound()
            except Exception as e:
                print(f"播放随机音效失败: {e}")

    def play_q_sound(self):
        if self.audio_engine:
            try:
                self.audio_engine.play_q_sound()
            except Exception as e:
                print(f"播放 q 音效失败: {e}")

    def play_z_sound(self):
        if self.audio_engine:
            try:
                self.audio_engine.play_z_sound()
            except Exception as e:
                print(f"播放 z 音效失败: {e}")

    def play_clear_sound(self):
        if self.audio_engine:
            try:
                self.audio_engine.play_sound_index('main', 8)
            except Exception as e:
                print(f"播放清空音效失败: {e}")

    # --- 剪贴板监控 ---

    def setup_clipboard_monitor(self):
        try:
            self.clipboard().dataChanged.connect(self.on_clipboard_changed)
            print("剪贴板监控已连接")
        except Exception as e:
            print(f"剪贴板监控连接失败: {e}")

    # === 数据解析 ===

    def process_clipboard_data(self, mime_data):
        """
        统一把 mime_data 转成内部结构：
            - type: clear / text / image / file / other
        纯文本只用 text() + Python 计算字节数。
        未知类型仍然抓 payload、算大小、显示类型。
        """
        if not mime_data or not mime_data.formats():
            return {
                "type": "clear",
                "top_text": "",
                "top_text_snippet": "",
                "bottom_text": self.format_size(0),
            }

        all_formats = mime_data.formats()

        # 1. 图片
        if mime_data.hasImage():
            pixmap = self.clipboard().pixmap()
            if not pixmap.isNull():
                buffer = QBuffer()
                buffer.open(QIODevice.WriteOnly)
                pixmap.save(buffer, "PNG")
                img_text = f"{pixmap.width()}×{pixmap.height()}"
                return {
                    "type": "image",
                    "top_text": img_text,
                    "top_text_snippet": img_text,
                    "bottom_text": f"截图: {self.format_size(len(buffer.data()))}",
                }

            image = self.clipboard().image()
            if not image.isNull():
                pixmap = QPixmap.fromImage(image)
                buffer = QBuffer()
                buffer.open(QIODevice.WriteOnly)
                pixmap.save(buffer, "PNG")
                img_text = f"{pixmap.width()}×{pixmap.height()}"
                return {
                    "type": "image",
                    "top_text": img_text,
                    "top_text_snippet": img_text,
                    "bottom_text": f"截图: {self.format_size(len(buffer.data()))}",
                }

            image_data = mime_data.data("image/png") if "image/png" in all_formats else b""
            if len(image_data) > 0:
                try:
                    img = QImage.fromData(image_data, "PNG")
                    if not img.isNull():
                        pixmap = QPixmap.fromImage(img)
                        img_text = f"{pixmap.width()}×{pixmap.height()}"
                        bottom_text = f"截图: {self.format_size(len(image_data))}"
                    else:
                        img_text = "未知尺寸"
                        bottom_text = f"截图: {self.format_size(len(image_data))}"
                    return {
                        "type": "image",
                        "top_text": img_text,
                        "top_text_snippet": img_text,
                        "bottom_text": bottom_text,
                    }
                except Exception:
                    pass

            # hasImage=True 但暂时读不到 → 当成 clear，让轮询继续
            return {
                "type": "clear",
                "top_text": "",
                "top_text_snippet": "",
                "bottom_text": self.format_size(0),
            }

        # 2. 文件/路径
        if mime_data.hasUrls():
            urls = mime_data.urls()
            if not urls:
                return None
            local_paths = [
                url.toLocalFile()
                for url in urls
                if url.isLocalFile() and os.path.exists(url.toLocalFile())
            ]
            if not local_paths:
                # 远程 URL，当文本处理
                remote_urls = [url for url in urls if not url.isLocalFile()]
                if remote_urls:
                    url_texts = [url.toString() for url in remote_urls]
                    full_text = "\n".join(url_texts)
                    total_size = sum(
                        len(u.toString().encode("utf-8", "replace")) for u in remote_urls
                    )
                    return {
                        "type": "text",
                        "full_text": full_text,
                        "bottom_text": self.format_size(total_size),
                    }
                return None

            count = len(local_paths)
            num_files = sum(1 for p in local_paths if os.path.isfile(p))
            num_folders = sum(1 for p in local_paths if os.path.isdir(p))
            top_text = "\n".join(os.path.basename(p) for p in local_paths)

            if count == 1:
                bottom_template = "文件夹: {}" if num_folders == 1 else "文件: {}"
            else:
                if num_files and num_folders:
                    bottom_template = f"{count} 个项目: {{}}"
                elif num_folders:
                    bottom_template = f"{count} 个文件夹: {{}}"
                else:
                    bottom_template = f"{count} 个文件: {{}}"

            return {
                "type": "file",
                "full_text": top_text,
                "bottom_template": bottom_template,
                "paths": local_paths,
            }

        # 3. 纯文本
        if mime_data.hasText():
            text = mime_data.text()
            if not text:
                return {
                    "type": "clear",
                    "top_text": "",
                    "top_text_snippet": "",
                    "bottom_text": self.format_size(0),
                }
            try:
                data_size = len(text.encode("utf-8", "replace"))
            except Exception:
                data_size = 0
            bottom_text = self.format_size(data_size)
            return {
                "type": "text",
                "full_text": text,
                "bottom_text": bottom_text,
            }

        # 4. 其他未知类型
        if all_formats:
            filtered_formats = [
                f
                for f in all_formats
                if not f.startswith("application/x-qt-")
                and f
                not in (
                    "text/plain",
                    "text/plain;charset=utf-8",
                    "text/uri-list",
                    "UTF8_STRING",
                    "COMPOUND_TEXT",
                    "TEXT",
                    "STRING",
                    "image/png",
                )
            ]
            primary_type = filtered_formats[0] if filtered_formats else all_formats[0]

            if primary_type:
                try:
                    byte_data = mime_data.data(primary_type)
                    data_size = byte_data.size() if byte_data else 0
                    try:
                        text_data = byte_data.data().decode("utf-8", errors="replace")
                        if 0 < len(text_data) < 200:
                            return {
                                "type": "text",
                                "full_text": text_data,
                                "bottom_text": self.format_size(data_size),
                            }
                    except Exception:
                        pass
                    unknown_text = f"未知内容，类型: {primary_type}"
                    return {
                        "type": "other",
                        "top_text": unknown_text,
                        "top_text_snippet": unknown_text,
                        "bottom_text": self.format_size(data_size),
                    }
                except Exception:
                    unknown_text = f"未知内容，类型: {primary_type}"
                    return {
                        "type": "other",
                        "top_text": unknown_text,
                        "top_text_snippet": unknown_text,
                        "bottom_text": "大小未知",
                    }

        return {
            "type": "clear",
            "top_text": "",
            "top_text_snippet": "",
            "bottom_text": self.format_size(0),
        }

    # --- 文件大小计算 ---

    def calculate_total_size_async(self, file_paths, popup, template):
        futures = [self.executor.submit(_get_path_size, path) for path in file_paths]

        def aggregate_and_emit(futs):
            total_size = sum(
                future.result() for future in futs if not future.exception()
            )
            self.calculation_done.emit(
                template.format(self.format_size(total_size)), popup
            )

        self.executor.submit(aggregate_and_emit, futures)

    def on_calculation_finished(self, final_text, popup):
        if popup in self.active_popups:
            popup.update_bottom_text(final_text)

    # --- 工具函数 ---

    def format_size(self, size_bytes):
        if size_bytes < 0:
            return "未知大小"
        if size_bytes < 1024:
            return f"{size_bytes}b"
        if size_bytes < 1024 * 1024:
            return f"{size_bytes:,}b"
        mb = size_bytes / (1024 * 1024)
        return f"{mb:,.0f}M"

    def set_cooldown(self):
        self.is_on_cooldown = True
        QTimer.singleShot(
            self.COOLDOWN_TIME_MS, lambda: setattr(self, "is_on_cooldown", False)
        )

    # ========= Attempts-Based Capture（两种模式共用） =========

    def on_clipboard_changed(self):
        """
        剪贴板一有变动就进这里：
        - 不做 Fast Clear，全部走“轮询确认”；
        - 模式 0/1 的区别只在 _capture_max_attempts 和 _capture_hard_timeout_ms。
        """
        if self.is_on_cooldown and not self._capture_active:
            # 冷却期内不新开 capture，避免刷屏
            return

        now = QTime.currentTime()

        if not self._capture_active:
            # 启动新的 capture
            self._capture_active = True
            self._capture_attempts = 0
            self._capture_seen_clear = False
            self._capture_start_time = now
        else:
            # 当前已有 capture，在此基础上刷新计数和时间
            self._capture_attempts = 0
            self._capture_seen_clear = False
            self._capture_start_time = now

        if not self._capture_timer.isActive():
            self._capture_timer.start()

        # 立刻跑一轮
        self._poll_clipboard()

    def _poll_clipboard(self):
        """
        轮询读取剪贴板：
        - 非空数据：立即结束 capture 并弹窗；
        - 空数据：记录 clear，继续轮询；
        - attempts 达到上限 或 elapsed 超过 hard timeout：结束 capture。
        """
        if not self._capture_active:
            return

        self._capture_attempts += 1

        clipboard = self.clipboard()
        if not clipboard:
            data = None
        else:
            try:
                mime_data = clipboard.mimeData()
            except Exception as e:
                print(f"读取 mimeData 异常: {e}")
                mime_data = None

            if mime_data:
                try:
                    data = self.process_clipboard_data(mime_data)
                except Exception as e:
                    print(f"处理剪贴板数据异常: {e}")
                    data = None
            else:
                data = None

        # 判定非空 / 空
        if data and data.get("type") != "clear":
            self._finish_capture(data)
            return
        else:
            if data and data.get("type") == "clear":
                self._capture_seen_clear = True

        # 检查 attempts + hard timeout
        now = QTime.currentTime()
        elapsed = self._capture_start_time.msecsTo(now) if self._capture_start_time else 0

        if (self._capture_attempts >= self._capture_max_attempts) or (
            elapsed >= self._capture_hard_timeout_ms
        ):
            if self._capture_seen_clear:
                clear_data = {
                    "type": "clear",
                    "top_text": "",
                    "top_text_snippet": "",
                    "bottom_text": self.format_size(0),
                }
                self._finish_capture(clear_data)
            else:
                self._finish_capture(None)
            return

    def _finish_capture(self, data):
        """
        结束本次 capture：
        - 停止轮询；
        - data 为 None：不弹窗；
        - data 有内容：统一走 _show_popup。
        """
        self._capture_active = False
        if self._capture_timer.isActive():
            self._capture_timer.stop()

        if not data:
            return

        self._show_popup(data)

    def _show_popup(self, data):
        """
        统一弹窗逻辑。
        """
        try:
            if data.get("type") == "clear":
                self.play_clear_sound()
            else:
                self.play_random_sound()

            # 如果有粘住的弹窗，就不再新增
            sticky_popups = [p for p in self.active_popups if p.is_sticky]
            if sticky_popups:
                self.set_cooldown()
                return

            # 让最近一个非 sticky 且未 slide_out 的弹窗先滑走
            stationary_popup = next(
                (
                    p
                    for p in reversed(self.active_popups)
                    if (not p.is_sticky) and (not getattr(p, "is_sliding_out", False))
                ),
                None,
            )
            if stationary_popup:
                stationary_popup.slide_out()

            # 颜色模式切换
            if self.COLOR_SCHEME_MODE in (3, 4):
                self.current_color_mode = 1 - self.current_color_mode
            elif self.COLOR_SCHEME_MODE == 2:
                self.current_color_mode = 1
            else:
                self.current_color_mode = 0

            new_popup = TransparentPopup(
                data, self, self.current_color_mode, self.COLOR_SCHEME_MODE
            )
            new_popup.raise_()
            self.active_popups.append(new_popup)

            self.set_cooldown()

            if data.get("type") == "file" and "paths" in data:
                new_popup.update_bottom_text(data["bottom_template"].format("●"))
                self.calculate_total_size_async(
                    data["paths"], new_popup, data["bottom_template"]
                )

        except Exception as e:
            print(f"创建或初始化弹窗时出错: {e}")
            self.set_cooldown()

    # --- 弹窗关闭 & 清理 ---

    def close_popup(self, popup):
        if popup in self.active_popups:
            self.active_popups.remove(popup)

        if hasattr(popup, "anim_group") and popup.anim_group is not None:
            if popup.anim_group.state() == QAbstractAnimation.Running:
                popup.anim_group.stop()
            popup.anim_group.deleteLater()
            popup.anim_group = None

        if hasattr(popup, "slide_anim") and popup.slide_anim is not None:
            if popup.slide_anim.state() == QAbstractAnimation.Running:
                popup.slide_anim.stop()
            popup.slide_anim.deleteLater()
            popup.slide_anim = None

        for timer_name in ["lifecycle_timer", "border_animation_timer"]:
            timer = getattr(popup, timer_name, None)
            if timer:
                timer.stop()
                timer.deleteLater()
                setattr(popup, timer_name, None)

        popup.disconnect_scrollbar_signals()
        popup.deleteLater()

    def __del__(self):
        if hasattr(self, "audio_engine") and self.audio_engine is not None:
            try:
                self.audio_engine.cleanup()
            except Exception as e:
                print(f"清理音频引擎错误: {e}")
        if hasattr(self, "executor"):
            try:
                self.executor.shutdown(wait=False)
            except Exception as e:
                print(f"关闭线程池错误: {e}")

        try:
            try:
                self.calculation_done.disconnect()
            except Exception:
                pass

            if hasattr(self, "active_popups"):
                for popup in self.active_popups:
                    try:
                        popup.close()
                        popup.deleteLater()
                    except Exception:
                        pass
                self.active_popups.clear()

            try:
                clipboard = self.clipboard()
                if clipboard:
                    clipboard.dataChanged.disconnect(self.on_clipboard_changed)
            except Exception:
                pass

        except Exception as e:
            print(f"清理 Qt 对象错误: {e}")

# =============== TransparentPopup ===============

class TransparentPopup(QWidget):
    SLIDE_IN_DURATION = SLIDE_IN_DURATION
    SLIDE_OUT_DURATION = SLIDE_OUT_DURATION
    LIFECYCLE_SECONDS = LIFECYCLE_SECONDS
    SCROLLBAR_WIDTH = SCROLLBAR_WIDTH
    SCROLLBAR_MARGIN_RIGHT = SCROLLBAR_MARGIN_RIGHT
    CONTENT_AREA_MAX_HEIGHT = CONTENT_AREA_MAX_HEIGHT
    BOTTOM_AREA_MIN_HEIGHT = BOTTOM_AREA_MIN_HEIGHT

    OVERLAY_SCROLLBAR_STYLE_SHEET = """
        QScrollBar:vertical {{
            border: none; background: transparent; width: {width}px; margin: 0; padding: 0px;
        }}
        QScrollBar::groove:vertical {{
            border: none; background: transparent; margin: 0px; padding: 0px;
        }}
        QScrollBar::handle:vertical {{
            background: {handle_color}; border-radius: 0px; min-height: 20px; margin: 0px;
        }}
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
            border: none; background: none; height: 0px; margin: 0px; padding: 0px;
        }}
        QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{
            background: none; margin: 0px; padding: 0px;
        }}
    """

    def get_current_screen_geometry(self):
        return (Qaqqlication.screenAt(QCursor.pos()) or Qaqqlication.primaryScreen()).availableGeometry()

    def __init__(self, data, monitor, color_mode=0, scheme_mode=4):
        super().__init__()
        self.monitor = monitor
        self.color_mode = color_mode
        self.scheme_mode = scheme_mode
        self.original_data = data

        self.is_sticky = False
        self.border_thickness = 1
        self.border_dash_offset = 0

        self.lifecycle_remaining = self.LIFECYCLE_SECONDS * 1000
        self.lifecycle_start_time = None

        self.full_text_to_load = self.original_data.get("full_text")

        self.slide_anim = None
        self.anim_group = None
        self.border_animation_timer = None

        self.setWindowFlags(
            Qt.WindowStaysOnTopHint | Qt.FramelessWindowHint | Qt.Tool
        )
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)

        self.setFixedSize(POPUP_WIDTH, POPUP_HEIGHT)

        self.overlay_scrollbar = ClickJumpScrollBar(self)
        self.overlay_scrollbar.setOrientation(Qt.Vertical)
        self.overlay_scrollbar.hide()
        self.is_scrollbar_connected = False

        self.interaction_shield = None
        self.sticky_toggle_task_id = None

        self.lifecycle_timer = QTimer(self)
        self.lifecycle_timer.setSingleShot(True)

        self.target_screen_geom = self.get_current_screen_geometry()

        self.setup_ui()
        self.setup_colors_and_styles()
        self.move_to_initial_position()
        self.show()
        self.slide_in()
        self.start_lifecycle()

    def setup_colors_and_styles(self):
        common_bottom_style = "padding-top: 8px;"

        bg_0 = BLACK_BG
        text_0 = BLACK_TEXT
        border_0 = BLACK_BORDER
        gold_0_hex = BLACK_GOLD_HEX
        bottom_style_0 = (
            f"color: {gold_0_hex}; {common_bottom_style} background-color: transparent;"
        )
        top_style_0 = "color: #ffffff;"
        scroll_handle_0 = BLACK_SCROLL_HANDLE
        highlight_0 = BLACK_HIGHLIGHT

        bg_1 = WHITE_BG
        border_1 = WHITE_BORDER
        text_1_qcolor = WHITE_TEXT_QCOLOR
        gold_1_hex = WHITE_GOLD_HEX
        bottom_style_1 = (
            f"color: {gold_1_hex}; font-weight: bold; "
            f"{common_bottom_style} background-color: transparent;"
        )
        top_style_1 = (
            f"color: rgb({text_1_qcolor.red()}, {text_1_qcolor.green()}, {text_1_qcolor.blue()});"
        )
        scroll_handle_1 = WHITE_SCROLL_HANDLE
        highlight_1 = WHITE_HIGHLIGHT

        if self.scheme_mode == 4:
            main_palette_index = self.color_mode
            bottom_palette_index = 1 - self.color_mode
        elif self.scheme_mode == 3:
            main_palette_index = bottom_palette_index = self.color_mode
        elif self.scheme_mode == 2:
            main_palette_index = bottom_palette_index = 1
        else:
            main_palette_index = bottom_palette_index = 0

        if main_palette_index == 0:
            self.background_color = bg_0
            self.border_color = border_0
            top_text_style = top_style_0
            self.scrollbar_handle_color = scroll_handle_0
            highlight_bg_color = highlight_0
        else:
            self.background_color = bg_1
            self.border_color = border_1
            top_text_style = top_style_1
            self.scrollbar_handle_color = scroll_handle_1
            highlight_bg_color = highlight_1

        if bottom_palette_index == 0:
            self.bottom_background_color = bg_0
            self.bottom_text_style = bottom_style_0
        else:
            self.bottom_background_color = bg_1
            self.bottom_text_style = bottom_style_1

        self.bottom_message_label.setStyleSheet(self.bottom_text_style)

        self.top_content.setStyleSheet(
            f"QTextEdit {{ border: none; background-color: transparent; padding: 0; {top_text_style} }}"
        )

        self.overlay_scrollbar.setStyleSheet(
            self.OVERLAY_SCROLLBAR_STYLE_SHEET.format(
                width=self.SCROLLBAR_WIDTH,
                handle_color=self.scrollbar_handle_color,
            )
        )

        palette = self.top_content.palette()
        palette.setColor(QPalette.Highlight, highlight_bg_color)
        palette.setColor(QPalette.HighlightedText, Qt.white)
        self.top_content.setPalette(palette)

    def setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 5, 10, 10)
        layout.setSpacing(0)

        font = QFont(FONT_FAMILY, FONT_SIZE)
        font.setFamilies(FONT_FALLBACKS)

        self.top_content = StickyTextEdit(self)
        self.top_content.popup = self

        initial_text = self.full_text_to_load
        if initial_text is None:
            initial_text = self.original_data.get("top_text_snippet", "")
        self.top_content.setPlainText(initial_text)
        self.top_content.setReadOnly(False)
        self.top_content.setTextInteractionFlags(Qt.TextEditorInteraction)
        self.top_content.textChanged.connect(self.update_overlay_scrollbar)
        self.top_content.setFont(font)
        self.top_content.setWordWrapMode(QTextOption.WrapAnywhere)
        self.top_content.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.top_content.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.top_content.internal_copy_triggered.connect(self.monitor.play_random_sound)
        self.top_content.setCursorWidth(0)
        self.top_content.setMaximumHeight(CONTENT_AREA_MAX_HEIGHT)

        self.bottom_message_label = QLabel(self.original_data.get("bottom_text", ""))
        self.bottom_message_label.setFont(font)
        self.bottom_message_label.setAlignment(Qt.AlignBottom | Qt.AlignLeft)
        self.bottom_message_label.setMinimumHeight(BOTTOM_AREA_MIN_HEIGHT)

        layout.addWidget(self.top_content)
        layout.addWidget(self.bottom_message_label)
        layout.setStretch(0, 1)
        layout.setStretch(1, 0)

        self.interaction_shield = QWidget(self)
        self.interaction_shield.setStyleSheet("background-color: transparent;")
        self.interaction_shield.setGeometry(self.top_content.geometry())
        self.interaction_shield.installEventFilter(self)
        self.interaction_shield.show()

        self.z_button = QPushButton("Z", self)
        self.z_button.setStyleSheet(
            """
            QPushButton {
                background-color: transparent;
                border: none;
                color: transparent;
            }
        """
        )
        self.z_button.clicked.connect(self.toggle_sticky_mode)
        self.z_button.show()

    def update_scrollbar_geometry(self):
        try:
            x = self.width() - SCROLLBAR_WIDTH - SCROLLBAR_MARGIN_RIGHT
            y_start = int(self.border_thickness / 2.0)
            y_end = self.bottom_message_label.y()
            height = y_end - y_start
            self.overlay_scrollbar.setGeometry(
                int(x), int(y_start), int(SCROLLBAR_WIDTH), int(height)
            )
        except Exception:
            pass

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.update_scrollbar_geometry()

        if hasattr(self, "interaction_shield") and self.interaction_shield is not None:
            self.interaction_shield.setGeometry(self.top_content.geometry())

        if hasattr(self, "bottom_message_label") and self.bottom_message_label is not None:
            split_y = self.bottom_message_label.y()
            z_zone_rect = QRect(0, split_y, self.width(), self.height() - split_y)
            if hasattr(self, "z_button") and self.z_button is not None:
                self.z_button.setGeometry(
                    z_zone_rect.x(),
                    z_zone_rect.y(),
                    z_zone_rect.width(),
                    z_zone_rect.height(),
                )

    def update_overlay_scrollbar(self):
        doc_height = self.top_content.document().size().height()
        viewport_height = self.top_content.height()
        if doc_height > viewport_height and self.is_sticky:
            v_scrollbar = self.top_content.verticalScrollBar()
            self.overlay_scrollbar.setRange(v_scrollbar.minimum(), v_scrollbar.maximum())
            self.overlay_scrollbar.setPageStep(int(viewport_height))
            v_scrollbar.setPageStep(int(viewport_height))
            self.overlay_scrollbar.setValue(v_scrollbar.value())
            self.connect_scrollbar_signals()
            self.overlay_scrollbar.show()
        else:
            self.overlay_scrollbar.hide()
            self.disconnect_scrollbar_signals()

    def connect_scrollbar_signals(self):
        if not self.is_scrollbar_connected:
            try:
                self.overlay_scrollbar.valueChanged.connect(
                    self.top_content.verticalScrollBar().setValue
                )
                self.top_content.verticalScrollBar().valueChanged.connect(
                    self.overlay_scrollbar.setValue
                )
                self.top_content.verticalScrollBar().rangeChanged.connect(
                    self.overlay_scrollbar.setRange
                )
                self.is_scrollbar_connected = True
            except RuntimeError:
                pass

    def disconnect_scrollbar_signals(self):
        if self.is_scrollbar_connected:
            try:
                self.overlay_scrollbar.valueChanged.disconnect()
                self.top_content.verticalScrollBar().valueChanged.disconnect()
                self.top_content.verticalScrollBar().rangeChanged.disconnect()
            except (TypeError, RuntimeError):
                pass
            finally:
                self.is_scrollbar_connected = False

    def eventFilter(self, obj, event):
        if event.type() == QEvent.MouseButtonPress and event.button() == Qt.LeftButton:
            if obj == self.interaction_shield:
                if not self.is_sticky:
                    self.monitor.play_q_sound()
                    self.slide_out()
                return True
        if obj == self.interaction_shield and event.type() == QEvent.Wheel:
            Qaqqlication.sendEvent(self.top_content.viewport(), event)
            self.top_content.viewport().update()
            return True
        return super().eventFilter(obj, event)

    def play_z_sound_only(self):
        self.monitor.play_z_sound()

    def mousePressEvent(self, event):
        super().mousePressEvent(event)

    def start_lifecycle(self):
        self.lifecycle_timer = QTimer(self)
        self.lifecycle_timer.setSingleShot(True)
        self.lifecycle_timer.timeout.connect(self.slide_out)
        if not self.is_sticky:
            self.lifecycle_start_time = QTime.currentTime()
            self.lifecycle_timer.start(self.lifecycle_remaining)

    def toggle_sticky_mode(self):
        self.monitor.play_z_sound()
        self.is_sticky = not self.is_sticky
        if self.is_sticky:
            self.activate_sticky_mode()
        else:
            self.deactivate_sticky_mode()

    def activate_sticky_mode(self):
        if self.lifecycle_timer.isActive():
            self.lifecycle_timer.stop()
            self.lifecycle_remaining = max(
                0, self.lifecycle_remaining - self.lifecycle_start_time.msecsTo(QTime.currentTime())
            )
        self.border_thickness = 2
        self.update_scrollbar_geometry()
        if not self.border_animation_timer:
            self.border_animation_timer = QTimer(self)
            self.border_animation_timer.timeout.connect(self.animate_border)
        self.border_animation_timer.start(51)
        self.interaction_shield.hide()
        QTimer.singleShot(0, self.update_overlay_scrollbar)
        self.top_content.setFocus(Qt.MouseFocusReason)
        self.update()

    def deactivate_sticky_mode(self):
        saved_v_scroll = self.top_content.verticalScrollBar().value()
        if self.lifecycle_remaining > 0:
            self.start_lifecycle()
        if self.border_animation_timer and self.border_animation_timer.isActive():
            self.border_animation_timer.stop()
        self.border_dash_offset = 0
        self.border_thickness = 1
        self.update_scrollbar_geometry()
        self.top_content.setCursorWidth(0)
        cursor = self.top_content.textCursor()
        cursor.clearSelection()
        self.top_content.setTextCursor(cursor)
        self.top_content.clearFocus()
        self.setFocus()
        self.overlay_scrollbar.hide()
        self.disconnect_scrollbar_signals()
        self.interaction_shield.show()
        self.interaction_shield.raise_()
        self.sticky_toggle_task_id = None
        QTimer.singleShot(
            0, lambda: self.top_content.verticalScrollBar().setValue(saved_v_scroll)
        )
        self.update()

    def animate_border(self):
        self.border_dash_offset = (self.border_dash_offset - 1) % -10
        self.update()

    def slide_out(self):
        for timer in [self.lifecycle_timer, self.border_animation_timer]:
            if timer and timer.isActive():
                timer.stop()
        if getattr(self, "is_sliding_out", False):
            return
        self.is_sliding_out = True
        self.anim_group = QParallelAnimationGroup(self)
        opacity_anim = QPropertyAnimation(self, b"windowOpacity")
        opacity_anim.setDuration(SLIDE_OUT_DURATION)
        opacity_anim.setEndValue(0.0)
        pos_anim = QPropertyAnimation(self, b"pos")
        pos_anim.setDuration(SLIDE_OUT_DURATION)
        pos_anim.setEndValue(QPoint(self.x() - 80, self.y()))
        self.anim_group.addAnimation(opacity_anim)
        self.anim_group.addAnimation(pos_anim)
        self.anim_group.finished.connect(lambda: self.monitor.close_popup(self))
        self.anim_group.start()

    def move_to_initial_position(self):
        self.move(
            self.target_screen_geom.right(),
            self.target_screen_geom.bottom() - self.height() - 40,
        )

    def slide_in(self):
        end_pos = QPoint(
            self.target_screen_geom.right() - self.width() - 40,
            self.y(),
        )
        self.slide_anim = QPropertyAnimation(self, b"pos")
        self.slide_anim.setDuration(SLIDE_IN_DURATION)
        self.slide_anim.setEndValue(end_pos)
        self.slide_anim.start()

    def update_bottom_text(self, text):
        self.bottom_message_label.setText(text)
        if hasattr(self, "bottom_message_label") and self.bottom_message_label is not None:
            split_y = self.bottom_message_label.y()
            z_zone_rect = QRect(0, split_y, self.width(), self.height() - split_y)
            if hasattr(self, "z_button") and self.z_button is not None:
                self.z_button.setGeometry(
                    z_zone_rect.x(),
                    z_zone_rect.y(),
                    z_zone_rect.width(),
                    z_zone_rect.height(),
                )

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        split_y = self.bottom_message_label.y()
        painter.fillRect(QRect(0, 0, self.width(), split_y), self.background_color)
        painter.fillRect(
            QRect(0, split_y, self.width(), self.height() - split_y),
            self.bottom_background_color,
        )
        pen = QPen(self.border_color, self.border_thickness, Qt.DashLine)
        if self.is_sticky:
            pen.setDashOffset(self.border_dash_offset)
        painter.setPen(pen)
        adj = self.border_thickness / 2.0
        painter.drawRect(
            self.rect().adjusted(int(adj), int(adj), -int(adj), -int(adj))
        )

# =============== main ===============

if __name__ == "__main__":
    def handle_exception(exc_type, exc_value, exc_traceback):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_traceback)
            return
        print(f"未捕获异常: {exc_type.__name__}: {exc_value}")
        import traceback
        traceback.print_tb(exc_traceback)

    sys.excepthook = handle_exception

    Qaqqlication.setAttribute(Qt.AA_EnableHighDpiScaling)
    Qaqqlication.setAttribute(Qt.AA_UseHighDpiPixmaps)

    mode_text = "快速模式(0)" if CLEAR_STRATEGY_MODE == 0 else "严格模式(1)"
    print(f"剪贴板监控工具版本: {VERSION}，清空策略: {mode_text}")

    try:
        app = ClipboardMonitor(sys.argv)
        signal.signal(signal.SIGINT, lambda sig, frame: Qaqqlication.quit())
        timer = QTimer()
        timer.start(500)
        timer.timeout.connect(lambda: None)
        sys.exit(app.exec_())
    except Exception as e:
        print(f"程序启动出错: {e}")
        import traceback
        traceback.print_exc()
        try:
            app = ClipboardMonitor(sys.argv)
            signal.signal(signal.SIGINT, lambda sig, frame: Qaqqlication.quit())
            timer = QTimer()
            timer.start(500)
            timer.timeout.connect(lambda: None)
            app.exec_()
        except Exception as e2:
            print(f"重试启动也失败: {e2}")
            print("程序无法启动，请检查环境和依赖。")

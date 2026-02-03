import sys
import os
import time
import re
import signal
import html
from pathlib import Path
from PySide2.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout,
                               QPushButton, QTextEdit, QPlainTextEdit, QFileDialog, QCheckBox,
                               QComboBox, QLabel, QCompleter, QMenu,
                               QTreeWidget, QTreeWidgetItem, QSplitter, QSplitterHandle,
                               QFrame, QSizePolicy, QProgressBar, QAbstractItemView,
                               QStyledItemDelegate, QStyle, QGraphicsOpacityEffect)
from PySide2.QtCore import (Qt, QThread, Signal, QSettings, QDir, QPoint, QRect,
                            QObject, QEvent, QTimer, QPropertyAnimation, QEasingCurve,
                            QVariantAnimation)
from PySide2.QtGui import (QFont, QColor, QBrush, QMouseEvent, QPainter, QPen,
                           QTextDocument, QCursor, QSyntaxHighlighter, QTextCharFormat)

# --- 配色常量 ---
SOLAR_BG = "#fdf6e3"
SOLAR_HL_BG = "#eee8d5"
SOLAR_TEXT = "#657b83"
SOLAR_EMPHASIS = "#586e75"
SOLAR_YELLOW = "#b58900"
SOLAR_ORANGE = "#cb4b16"
SOLAR_RED = "#dc322f"
SOLAR_q = "#2aa198"
SOLAR_GREEN = "#859900"

# 1. 核心 Hover 颜色 (沙金色)
UNIFIED_HOVER_COLOR = "#DFCA88"

# 状态常量
STATE_FOLDER = 1

# 2. 核心 选中文字背景色 (深褐金)
UNIFIED_SELECTION_BG = "#B49471"
# 3. 核心 选中文字前景色 (纯白)
UNIFIED_SELECTION_TEXT = "#ffffff"

# 分割线颜色
SPLITTER_NORMAL_COLOR = "#d0d0d0"
SPLITTER_HOVER_COLOR = "#909090"

EDGE_NONE = 0
EDGE_LEFT = 1
EDGE_TOP = 2
EDGE_RIGHT = 4
EDGE_BOTTOM = 8

# --- 滚动条点击跳转过滤器 ---


class ScrollbarJumpFilter(QObject):
    def eventFilter(self, source, event):
        if event.type() == QEvent.MouseButtonPress and event.button() == Qt.LeftButton:
            click_y = event.y()
            total_h = source.height()
            if total_h > 0:
                ratio = click_y / total_h
                target_val = source.minimum() + ratio * (source.maximum() - source.minimum())
                source.setValue(int(target_val))
                return True
        return False

# --- 数据结构 ---


class TreeItemData:
    def __init__(self, path, name, size_bytes, mtime_epoch, ctime_epoch, is_dir, depth):
        self.path = path
        self.name = name
        self.size_bytes = size_bytes
        self.mtime_epoch = mtime_epoch
        self.ctime_epoch = ctime_epoch
        self.is_dir = is_dir
        self.depth = depth

# --- 扫描线程 ---


class TreeScannerThread(QThread):
    finished_data_signal = Signal(list)
    error_signal = Signal(str)

    def __init__(self, path):
        super().__init__()
        self.path = path

    def run(self):
        try:
            root_path = Path(self.path)
            data_output = []
            try:
                root_stat = root_path.stat()
                root_size = self._get_folder_size(root_path)
                root_mtime = root_stat.st_mtime
                root_ctime = root_stat.st_ctime
            except:
                root_size, root_mtime, root_ctime = 0, 0, 0

            data_output.append(TreeItemData(
                str(root_path), root_path.name, root_size, root_mtime, root_ctime, True, 0
            ))
            self._scan_recursive(root_path, data_output, current_depth=1)
            self.finished_data_signal.emit(data_output)
        except Exception as e:
            self.error_signal.emit(str(e))

    def _get_folder_size(self, folder_path):
        total_size = 0
        try:
            with os.scandir(folder_path) as it:
                for entry in it:
                    if entry.is_file(follow_symlinks=False):
                        total_size += entry.stat().st_size
                    elif entry.is_dir(follow_symlinks=False):
                        total_size += self._get_folder_size(entry.path)
        except:
            pass
        return total_size

    def _scan_recursive(self, directory, data_output, current_depth):
        try:
            contents = list(directory.iterdir())
            contents.sort(key=lambda x: (not x.is_dir(), x.name.lower()))
            for path in contents:
                s_bytes, m_time, c_time = 0, 0, 0
                try:
                    stat = path.stat()
                    if path.is_file():
                        s_bytes = stat.st_size
                    else:
                        s_bytes = self._get_folder_size(path)
                    m_time = stat.st_mtime
                    c_time = stat.st_ctime
                except:
                    pass

                data_output.append(TreeItemData(
                    str(path), path.name, s_bytes, m_time, c_time, path.is_dir(
                    ), current_depth
                ))
                if path.is_dir():
                    self._scan_recursive(path, data_output, current_depth + 1)
        except PermissionError:
            pass

# --- 自定义 TreeWidget ---


class ModernTreeWidget(QTreeWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMouseTracking(True)
        self._hovered_item = None
        self.setSelectionMode(QAbstractItemView.NoSelection)
        self.setFocusPolicy(Qt.NoFocus)

    def mouseMoveEvent(self, event: QMouseEvent):
        item = self.itemAt(event.pos())
        if item != self._hovered_item:
            self._hovered_item = item
            self.viewport().update()
        super().mouseMoveEvent(event)

    def leaveEvent(self, event):
        self._hovered_item = None
        self.viewport().update()
        super().leaveEvent(event)

    def drawRow(self, painter, option, index):
        item = self.itemFromIndex(index)
        if item and item == self._hovered_item:
            painter.save()
            painter.setPen(Qt.NoPen)
            painter.setBrush(QColor(UNIFIED_HOVER_COLOR))
            full_rect = QRect(0, option.rect.y(),
                              self.viewport().width(), option.rect.height())
            painter.drawRect(full_rect)
            painter.restore()
        super().drawRow(painter, option, index)

# --- 自定义 Splitter Handle (7px 固定厚度，仅变色，强制箭头光标) ---


class ModernSplitterHandle(QSplitterHandle):
    def __init__(self, orientation, parent):
        super().__init__(orientation, parent)
        self.setMouseTracking(True)
        # 初始颜色
        self._current_color = QColor(SPLITTER_NORMAL_COLOR)

        # 颜色动画
        self._color_anim = QVariantAnimation(self)
        self._color_anim.setDuration(150)  # 稍微放慢一点点，显得稳重
        self._color_anim.valueChanged.connect(self._on_color_anim_changed)

        # 强制初始光标为箭头
        self.setCursor(Qt.ArrowCursor)

    def _on_color_anim_changed(self, color):
        self._current_color = color
        self.update()

    def enterEvent(self, event):
        # 悬停：只触发颜色变化
        self._color_anim.stop()
        self._color_anim.setStartValue(self._current_color)
        self._color_anim.setEndValue(QColor(SPLITTER_HOVER_COLOR))
        self._color_anim.start()

        # 强制重置光标
        self.setCursor(Qt.ArrowCursor)
        super().enterEvent(event)

    def leaveEvent(self, event):
        # 离开：恢复颜色
        self._color_anim.stop()
        self._color_anim.setStartValue(self._current_color)
        self._color_anim.setEndValue(QColor(SPLITTER_NORMAL_COLOR))
        self._color_anim.start()

        self.setCursor(Qt.ArrowCursor)
        super().leaveEvent(event)

    def mouseMoveEvent(self, event):
        # 无论如何移动，强制光标为箭头，不让系统接管
        self.setCursor(Qt.ArrowCursor)
        super().mouseMoveEvent(event)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)

        # 1. 绘制矩形：直接填满整个 Handle 区域
        # 这样就是实打实的 7px 粗线条，没有缩放动画
        painter.setPen(Qt.NoPen)
        painter.setBrush(self._current_color)
        painter.drawRect(self.rect())


class ModernSplitter(QSplitter):
    def __init__(self, orientation, parent=None):
        super().__init__(orientation, parent)
        # --- 关键修改：把手宽度改为 7px ---
        self.setHandleWidth(7)
        self.setChildrenCollapsible(False)

    def createHandle(self):
        return ModernSplitterHandle(self.orientation(), self)

# --- 自定义智能文本编辑框 ---


class FolderHighlighter(QSyntaxHighlighter):
    def __init__(self, doc):
        super().__init__(doc)
        self.format = QTextCharFormat()
        self.format.setForeground(QColor(SOLAR_q))
        # 辅助功能优化：增加斜体，并加大字号（10 -> 11）
        self.format.setFontItalic(True)
        # self.format.setFontPointSize(11)

    def highlightBlock(self, text):
        # 性能优化：优先检查块状态 (O(1) 性能)
        # 这同时也解决了编辑模式下删除 '/' 颜色丢失的问题，因为状态是随块绑定的
        if self.currentBlock().userState() == STATE_FOLDER:
            self.setFormat(0, len(text), self.format)
        # 备选逻辑：如果用户手动输入了符合文件夹特征的行（例如以 / 结尾），也让它变红
        elif text.strip().endswith('/') or '/' in text and '[' in text:
            self.setFormat(0, len(text), self.format)


class SmartTextEdit(QPlainTextEdit):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setLineWrapMode(QPlainTextEdit.NoWrap)
        self.setFont(QFont("Consolas", 10))
        # 集成高亮器，使文件夹行显示为青绿色
        self.highlighter = FolderHighlighter(self.document())
        self.reset_to_readonly()

    def reset_to_readonly(self):
        self.setReadOnly(True)
        self.is_editing_mode = False
        self.setStyleSheet(f"background-color: {SOLAR_HL_BG};")

    def enable_editing(self):
        self.setReadOnly(False)
        self.is_editing_mode = True
        self.setStyleSheet("background-color: #ffffff;")

    def contextMenuEvent(self, event):
        # 统一使用 QMenu，样式由全局 QSS 控制
        if not self.is_editing_mode:
            menu = QMenu(self)
            action_copy_all = menu.addAction("Copy All")
            action_copy_all.triggered.connect(self.copy_all)
            menu.addSeparator()
            action_edit = menu.addAction("Edit")
            action_edit.triggered.connect(self.enable_editing)
            menu.exec_(event.globalPos())
        else:
            menu = self.createStandardContextMenu()
            menu.exec_(event.globalPos())

    def copy_all(self):
        self.selectAll()
        self.copy()
        cursor = self.textCursor()
        cursor.clearSelection()
        self.setTextCursor(cursor)


# --- 自定义无边框窗口基类 ---
class FramelessWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.FramelessWindowHint)
        self._is_dragging = False
        self._drag_position = QPoint()
        self._edge_margin = 6
        self._resizing = False
        self._resize_edges = EDGE_NONE
        self._resize_start_rect = None
        self._resize_start_pos = QPoint()
        self.setMouseTracking(True)
        self.min_width = 100
        self.min_height = 100

    def mousePressEvent(self, event: QMouseEvent):
        if event.button() == Qt.LeftButton:
            edge = self._hit_test_edges(event.pos())
            if edge != EDGE_NONE:
                self._resizing = True
                self._resize_edges = edge
                self._resize_start_pos = event.globalPos()
                self._resize_start_rect = self.geometry()
                event.accept()
                return
            if event.y() < 40:
                self._is_dragging = True
                self._drag_position = event.globalPos() - self.frameGeometry().topLeft()
                event.accept()
                return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent):
        if self._resizing and (event.buttons() & Qt.LeftButton):
            self._perform_resize(event.globalPos())
            event.accept()
            return
        if self._is_dragging and (event.buttons() & Qt.LeftButton):
            self.move(event.globalPos() - self._drag_position)
            event.accept()
            return
        if not event.buttons():
            edge = self._hit_test_edges(event.pos())
            cursor = Qt.ArrowCursor
            if edge in (EDGE_LEFT, EDGE_RIGHT):
                cursor = Qt.SizeHorCursor
            elif edge in (EDGE_TOP, EDGE_BOTTOM):
                cursor = Qt.SizeVerCursor
            elif edge in (EDGE_TOP | EDGE_LEFT, EDGE_BOTTOM | EDGE_RIGHT):
                cursor = Qt.SizeFDiagCursor
            elif edge in (EDGE_TOP | EDGE_RIGHT, EDGE_BOTTOM | EDGE_LEFT):
                cursor = Qt.SizeBDiagCursor
            self.setCursor(cursor)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent):
        if event.button() == Qt.LeftButton:
            self._is_dragging = False
            self._resizing = False
            self._resize_edges = EDGE_NONE
        super().mouseReleaseEvent(event)

    def _hit_test_edges(self, pos: QPoint):
        rect = self.rect()
        x, y = pos.x(), pos.y()
        w, h = rect.width(), rect.height()
        edge = EDGE_NONE
        if x <= self._edge_margin:
            edge |= EDGE_LEFT
        elif x >= w - self._edge_margin:
            edge |= EDGE_RIGHT
        if y <= self._edge_margin:
            edge |= EDGE_TOP
        elif y >= h - self._edge_margin:
            edge |= EDGE_BOTTOM
        return edge

    def _perform_resize(self, global_pos: QPoint):
        if not self._resize_start_rect:
            return
        dx = global_pos.x() - self._resize_start_pos.x()
        dy = global_pos.y() - self._resize_start_pos.y()
        r = self._resize_start_rect
        left, top, right, bottom = r.left(), r.top(), r.right(), r.bottom()
        if self._resize_edges & EDGE_LEFT:
            left += dx
        if self._resize_edges & EDGE_RIGHT:
            right += dx
        if self._resize_edges & EDGE_TOP:
            top += dy
        if self._resize_edges & EDGE_BOTTOM:
            bottom += dy
        new_w = right - left + 1
        new_h = bottom - top + 1
        if new_w < self.min_width:
            if self._resize_edges & EDGE_LEFT:
                left = right - self.min_width + 1
            else:
                right = left + self.min_width - 1
        if new_h < self.min_height:
            if self._resize_edges & EDGE_TOP:
                top = bottom - self.min_height + 1
            else:
                bottom = top + self.min_height - 1
        self.setGeometry(QRect(QPoint(left, top), QPoint(right, bottom)))

# --- 拖动块 ---


class ResizeGrip(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(36, 36)
        self.setCursor(Qt.SizeFDiagCursor)
        self._resizing = False
        self._start_pos = QPoint()
        self._start_geom = None

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        pen = QPen(QColor(SOLAR_YELLOW))
        pen.setWidth(2)
        pen.setCapStyle(Qt.RoundCap)
        painter.setPen(pen)
        w, h = self.width(), self.height()
        painter.drawLine(w - 6, h - 28, w - 28, h - 6)
        painter.drawLine(w - 6, h - 16, w - 16, h - 6)

    def mousePressEvent(self, event: QMouseEvent):
        if event.button() == Qt.LeftButton:
            self._resizing = True
            self._start_pos = event.globalPos()
            self._start_geom = self.window().geometry()
            event.accept()
        else:
            super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent):
        if self._resizing and (event.buttons() & Qt.LeftButton) and self._start_geom is not None:
            delta = event.globalPos() - self._start_pos
            geom = QRect(self._start_geom)
            new_w = max(geom.width() + delta.x(), self.window().min_width)
            new_h = max(geom.height() + delta.y(), self.window().min_height)
            geom.setWidth(new_w)
            geom.setHeight(new_h)
            self.window().setGeometry(geom)
            event.accept()
        else:
            super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent):
        if event.button() == Qt.LeftButton:
            self._resizing = False
        super().mouseReleaseEvent(event)

# --- 主程序 ---


class ModernWindow(FramelessWindow):
    def __init__(self):
        super().__init__()
        self.setObjectName("RootWindow")
        self.MIN_WIDTH = 1100
        self.MIN_HEIGHT = 800
        self.min_width = self.MIN_WIDTH
        self.min_height = self.MIN_HEIGHT
        self.resize(self.MIN_WIDTH, self.MIN_HEIGHT)

        ini_path = os.path.join(os.getcwd(), "config.ini")
        self.settings = QSettings(ini_path, QSettings.IniFormat)

        self.scan_root_path = ""
        self.current_crumb_parts = []

        self.apply_styles()
        self.setup_ui()
        self.load_history()

        self.resize_grip = ResizeGrip(self)

        self.lbl_notify = QLabel(self)
        self.lbl_notify.setStyleSheet(
            f"color: #000000; font-family: 'Consolas'; font-size: 12px; background: transparent;")
        self.lbl_notify.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.lbl_notify.hide()

        self.notify_opacity = QGraphicsOpacityEffect(self.lbl_notify)
        self.lbl_notify.setGraphicsEffect(self.notify_opacity)

        self.notify_timer = QTimer(self)
        self.notify_timer.setSingleShot(True)
        self.notify_timer.timeout.connect(self.start_notify_fade)

        self.notify_anim = QPropertyAnimation(self.notify_opacity, b"opacity")
        self.notify_anim.setDuration(1000)
        self.notify_anim.setStartValue(1.0)
        self.notify_anim.setEndValue(0.0)
        self.notify_anim.finished.connect(self.lbl_notify.hide)

        self._adjust_breadcrumb_height()

    def resizeEvent(self, event):
        if self.width() < self.MIN_WIDTH or self.height() < self.MIN_HEIGHT:
            self.resize(max(self.width(), self.MIN_WIDTH),
                        max(self.height(), self.MIN_HEIGHT))
        super().resizeEvent(event)

        if hasattr(self, "resize_grip"):
            self.resize_grip.move(self.width() - self.resize_grip.width(),
                                  self.height() - self.resize_grip.height())

            label_w = 300
            label_h = 20
            grip_w = self.resize_grip.width()
            x = self.width() - grip_w - label_w - 5
            y = self.height() - label_h - 8
            self.lbl_notify.setGeometry(x, y, label_w, label_h)

        if hasattr(self, "_adjust_breadcrumb_height"):
            self._adjust_breadcrumb_height()

    def apply_styles(self):
        qss = f"""
            QWidget {{
                background-color: {SOLAR_BG};
                color: {SOLAR_TEXT};
                font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
                font-size: 13px;
                border: none;
            }}
            QWidget#RootWindow {{
                border: 3px dashed rgba(0, 0, 0, 80);
            }}
            QFrame#TopZone {{
                background-color: {SOLAR_BG};
                border-bottom: 1px solid {SOLAR_HL_BG};
            }}
            QProgressBar {{
                border: none;
                background-color: {SOLAR_HL_BG};
                height: 2px;
                text-align: center;
            }}
            QProgressBar::chunk {{ background-color: {SOLAR_ORANGE}; }}

            QLineEdit, QTextEdit, QPlainTextEdit {{
                border: none;
                border-radius: 2px;
                padding: 0px; margin: 0px;
                color: {SOLAR_EMPHASIS};
                selection-background-color: {UNIFIED_SELECTION_BG};
                selection-color: {UNIFIED_SELECTION_TEXT};
            }}

            QComboBox {{
                background-color: {SOLAR_HL_BG};
                border: 1px solid #d0d0d0;
                border-radius: 2px;
                color: {SOLAR_EMPHASIS};
                padding-top: 0px;
                padding-bottom: 0px;
                padding-left: 4px;
                padding-right: 60px;
            }}
            QComboBox QLineEdit {{
                background-color: transparent;
                border: none;
                margin-top: -12px;
                padding-bottom: 20px;
            }}
            QComboBox::drop-down {{
                subcontrol-origin: padding;
                subcontrol-position: top right;
                width: 60px;
                border-left: 1px solid #d0d0d0;
                background-color: {SOLAR_HL_BG};
            }}
            QComboBox::down-arrow {{
                width: 12px; height: 12px;
                border-left: 6px solid transparent;
                border-right: 6px solid transparent;
                border-top: 7px solid {SOLAR_EMPHASIS};
            }}
            QComboBox QAbstractItemView {{
                selection-background-color: {UNIFIED_HOVER_COLOR};
                selection-color: #000000;
            }}

            /* --- 右键菜单 QMenu 全局样式 --- */
            QMenu {{
                background-color: {SOLAR_HL_BG};
                border: 1px solid #d0d0d0;
                padding: 0px;
                margin: 0px;
            }}
            QMenu::item {{
                background: transparent;
                padding: 5px 20px;
                margin: 0px;
                border: none;
                color: {SOLAR_TEXT};
            }}
            /* 菜单项 Hover 状态：沙金色拉通背景，黑色文字 */
            QMenu::item:selected {{
                background-color: {UNIFIED_HOVER_COLOR};
                color: #000000;
            }}
            QMenu::separator {{
                height: 1px;
                background: #d0d0d0;
                margin: 4px 0px;
            }}

            QPushButton {{
                background-color: {SOLAR_HL_BG};
                border: none; border-radius: 2px;
                padding: 2px 8px; color: {SOLAR_EMPHASIS};
                font-weight: bold;
            }}
            QPushButton:hover {{ background-color: #e0e0e0; }}
            QPushButton#BtnBrowse {{ border: 1px solid #d0d0d0; }}
            QPushButton#BtnRun {{ background-color: {SOLAR_GREEN}; color: {SOLAR_BG}; }}
            QPushButton#BtnRun:hover {{ background-color: #718200; }}
            QPushButton#BtnGen {{ background-color: {SOLAR_q}; color: {SOLAR_BG}; }}
            QPushButton#BtnGen:hover {{ background-color: #1d746d; }}
            QPushButton#BtnWinCtrl {{ background-color: transparent; color: {SOLAR_TEXT}; font-size: 14px; padding: 4px 10px; font-family: "Arial"; }}
            QPushButton#BtnWinCtrl:hover {{ background-color: #e0e0e0; }}
            QPushButton#BtnClose:hover {{ background-color: {SOLAR_RED}; color: white; }}

            QTreeWidget {{
                border: none;
                background-color: {SOLAR_HL_BG};
                padding: 0px; margin: 0px;
            }}
            QTreeWidget::item {{
                border: none;
                padding: 2px;
                height: 20px;
            }}
            QTreeWidget::item:selected {{
                background-color: transparent;
                color: {SOLAR_q};
            }}

            QLabel#Breadcrumb {{
                background-color: transparent;
                border: none;
                font-family: "Consolas";
                font-weight: normal;
                color: #000000;
                font-size: 15px;
                padding: 0px 4px 0px 4px;
                margin: 0px;
            }}

            QScrollBar:vertical {{
                background: {SOLAR_HL_BG};
                width: 8px;
                margin: 0px;
                border: none;
            }}
            QScrollBar::handle:vertical {{ background: {SOLAR_ORANGE}; border-radius: 4px; min-height: 5px; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0px; }}

            QSplitter {{
                border: none;
                spacing: 0px;
                background-color: transparent;
            }}
            QSplitter::handle {{
                background: transparent;
                border: none;
            }}
        """
        self.setStyleSheet(qss)

    def setup_ui(self):
        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # 1. 上区
        top_zone = QFrame()
        top_zone.setObjectName("TopZone")
        top_zone.setFixedHeight(32)
        top_layout = QHBoxLayout(top_zone)
        top_layout.setContentsMargins(8, 0, 5, 0)
        top_layout.setSpacing(4)

        # --- 标题修改：DirE (D和E大写) ---
        lbl_title = QLabel("DirE")
        lbl_title.setStyleSheet(f"color: {SOLAR_YELLOW}; font-weight: bold;")
        top_layout.addWidget(lbl_title)

        self.combo_path = QComboBox()
        self.combo_path.setEditable(True)
        self.combo_path.setInsertPolicy(QComboBox.NoInsert)
        self.combo_path.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.combo_path.setFixedHeight(22)
        completer = QCompleter(QDir.root().entryList(
            QDir.Dirs | QDir.NoDotAndDotDot))
        self.combo_path.setCompleter(completer)
        self.combo_path.lineEdit().returnPressed.connect(self.start_scan)
        self.combo_path.currentIndexChanged.connect(self.on_combo_changed)

        btn_browse = QPushButton("...")
        btn_browse.setObjectName("BtnBrowse")
        btn_browse.setFixedWidth(40)
        btn_browse.setFixedHeight(22)
        btn_browse.clicked.connect(self.browse_folder)
        top_layout.addWidget(self.combo_path)
        top_layout.addWidget(btn_browse)

        self.chk_size = QCheckBox("Size")
        self.chk_mtime = QCheckBox("ModTime")
        self.chk_ctime = QCheckBox("CreTime")
        self.chk_size.setChecked(
            self.settings.value("show_size", True, type=bool))
        self.chk_mtime.setChecked(
            self.settings.value("show_mtime", False, type=bool))
        self.chk_ctime.setChecked(
            self.settings.value("show_ctime", False, type=bool))
        top_layout.addWidget(self.chk_size)
        top_layout.addWidget(self.chk_mtime)
        top_layout.addWidget(self.chk_ctime)

        btn_scan = QPushButton("扫描")
        btn_scan.setObjectName("BtnRun")
        btn_scan.setFixedHeight(22)
        btn_scan.clicked.connect(self.start_scan)
        btn_collapse = QPushButton("折叠")
        btn_collapse.setFixedHeight(22)
        btn_collapse.clicked.connect(self.collapse_all)
        btn_gen = QPushButton("生成文本")
        btn_gen.setObjectName("BtnGen")
        btn_gen.setFixedHeight(22)
        btn_gen.clicked.connect(self.generate_text)
        top_layout.addWidget(btn_scan)
        top_layout.addWidget(btn_collapse)
        top_layout.addWidget(btn_gen)

        line = QFrame()
        line.setFrameShape(QFrame.VLine)
        line.setFrameShadow(QFrame.Sunken)
        top_layout.addWidget(line)

        lbl_drag = QLabel(" ✥ ")
        lbl_drag.setStyleSheet(
            f"color: {SOLAR_TEXT}; font-weight: bold; font-size: 14px;")
        lbl_drag.setAttribute(Qt.WA_TransparentForMouseEvents)
        top_layout.addWidget(lbl_drag)

        btn_min = QPushButton("─")
        btn_min.setObjectName("BtnWinCtrl")
        btn_min.clicked.connect(self.showMinimized)
        self.btn_max = QPushButton("☐")
        self.btn_max.setObjectName("BtnWinCtrl")
        self.btn_max.clicked.connect(self.toggle_maximize)
        btn_close = QPushButton("✕")
        btn_close.setObjectName("BtnClose")
        btn_close.clicked.connect(self.close)
        top_layout.addWidget(btn_min)
        top_layout.addWidget(self.btn_max)
        top_layout.addWidget(btn_close)
        main_layout.addWidget(top_zone)

        self.progress_bar = QProgressBar()
        self.progress_bar.setTextVisible(False)
        self.progress_bar.setRange(0, 0)
        self.progress_bar.hide()
        main_layout.addWidget(self.progress_bar)

        bc_layout = QHBoxLayout()
        bc_layout.setContentsMargins(10, 1, 10, 5)
        self.lbl_breadcrumb = QLabel()
        self.lbl_breadcrumb.setObjectName("Breadcrumb")
        self.lbl_breadcrumb.setWordWrap(True)
        self.lbl_breadcrumb.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.lbl_breadcrumb.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        self.lbl_breadcrumb.setContextMenuPolicy(Qt.CustomContextMenu)
        self.lbl_breadcrumb.customContextMenuRequested.connect(
            self.on_breadcrumb_context_menu)
        bc_layout.addWidget(self.lbl_breadcrumb)
        main_layout.addLayout(bc_layout)
        self.set_breadcrumb_message("Ready.")

        # 使用自定义的 ModernSplitter
        splitter = ModernSplitter(Qt.Horizontal)

        self.tree = ModernTreeWidget()
        self.tree.setHeaderHidden(True)
        self.tree.setIndentation(15)
        self.tree.setContextMenuPolicy(Qt.CustomContextMenu)
        self.tree.customContextMenuRequested.connect(self.on_tree_context_menu)
        self.tree.itemClicked.connect(self.on_tree_item_clicked)
        self.tree_jump_filter = ScrollbarJumpFilter(
            self.tree.verticalScrollBar())
        self.tree.verticalScrollBar().installEventFilter(self.tree_jump_filter)

        self.text_area = SmartTextEdit()
        self.text_area.verticalScrollBar().valueChanged.connect(self.update_breadcrumb)
        self.text_jump_filter = ScrollbarJumpFilter(
            self.text_area.verticalScrollBar())
        self.text_area.verticalScrollBar().installEventFilter(self.text_jump_filter)

        splitter.addWidget(self.tree)
        splitter.addWidget(self.text_area)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 7)
        main_layout.addWidget(splitter)
        self.setLayout(main_layout)

    def toggle_maximize(self):
        if self.isMaximized():
            self.showNormal()
            self.btn_max.setText("☐")
        else:
            self.showMaximized()
            self.btn_max.setText("❐")

    def browse_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "选择目录")
        if folder:
            self.combo_path.setEditText(folder)
            self.start_scan()

    def on_combo_changed(self, index):
        if self.combo_path.hasFocus() and index != -1:
            self.start_scan()

    def _path_exists(self, path):
        """检查路径是否存在（支持点结尾路径）"""
        if os.path.exists(path):
            return True
        # 点结尾路径需要使用 \\?\ 前缀
        if path.endswith('.') or '.\\' in path or './' in path:
            check_path = '\\\\?\\' + os.path.abspath(path)
            try:
                return os.path.exists(check_path)
            except:
                pass
        return False

    def start_scan(self):
        path = self.combo_path.currentText().strip()
        if not path:
            return
        if not self._path_exists(path):
            self.set_breadcrumb_message(f"❌ 路径不存在: {path}")
            return

        self.scan_root_path = os.path.normpath(os.path.abspath(path))

        self.tree.clear()
        self.text_area.clear()
        self.set_breadcrumb_message(f"⏳ 正在扫描: {path} ...")
        self.progress_bar.show()
        self.setEnabled(False)
        self.update_history(path)
        self.thread = TreeScannerThread(path)
        self.thread.finished_data_signal.connect(self.on_scan_finished)
        self.thread.error_signal.connect(self.on_error)
        self.thread.start()

    def on_scan_finished(self, data_list):
        self.progress_bar.hide()
        self.setEnabled(True)
        if not data_list:
            return
        stack = {}
        root_data = data_list[0]
        root_item = QTreeWidgetItem(self.tree)
        root_item.setText(0, root_data.name)
        root_item.setData(0, Qt.UserRole, root_data)
        font = root_item.font(0)
        font.setBold(True)
        root_item.setFont(0, font)
        root_item.setExpanded(True)
        stack[0] = root_item

        for i in range(1, len(data_list)):
            data = data_list[i]
            parent = stack.get(data.depth - 1)
            if parent:
                item = QTreeWidgetItem(parent)
                item.setText(0, data.name)
                item.setData(0, Qt.UserRole, data)
                if data.is_dir:
                    item.setForeground(0, QBrush(QColor(SOLAR_q)))
                    stack[data.depth] = item
                else:
                    item.setFlags(item.flags() & ~Qt.ItemIsSelectable)

        self.tree.expandAll()
        self.set_breadcrumb_message(f"✅ 扫描完成。请点击 [生成文本]")

    def on_tree_item_clicked(self, item, column):
        data = item.data(0, Qt.UserRole)
        if data and data.is_dir:
            item.setExpanded(not item.isExpanded())

    def on_tree_context_menu(self, pos):
        item = self.tree.itemAt(pos)
        if not item:
            return
        data = item.data(0, Qt.UserRole)
        if data:
            self.copy_path_and_notify(data.path)

    def on_breadcrumb_context_menu(self, pos):
        if not self.scan_root_path or not self.current_crumb_parts:
            return
        try:
            root_path_obj = Path(self.scan_root_path)
            base_dir = root_path_obj.parent
            full_rel_path = os.path.join(*self.current_crumb_parts)
            target_path = base_dir / full_rel_path
            self.copy_path_and_notify(str(target_path))
        except Exception:
            pass

    def copy_path_and_notify(self, raw_path):
        norm_path = os.path.normpath(os.path.abspath(raw_path))
        clipboard = QApplication.clipboard()
        clipboard.setText(norm_path)
        full_msg = f"已复制 {norm_path}"
        display_msg = full_msg
        if len(full_msg) > 33:
            display_msg = full_msg[:30] + "..."
        self.show_notification(display_msg)

    def show_notification(self, text):
        self.lbl_notify.setText(text)
        self.lbl_notify.show()
        self.notify_opacity.setOpacity(1.0)
        self.notify_anim.stop()
        self.notify_timer.start(1000)

    def start_notify_fade(self):
        self.notify_anim.start()

    def on_error(self, msg):
        self.progress_bar.hide()
        self.setEnabled(True)
        self.set_breadcrumb_message(f"❌ 错误: {msg}")

    def generate_text(self):
        self.text_area.reset_to_readonly()

        if self.tree.topLevelItemCount() == 0:
            return
        show_s = self.chk_size.isChecked()
        show_m = self.chk_mtime.isChecked()
        show_c = self.chk_ctime.isChecked()
        self.settings.setValue("show_size", show_s)
        self.settings.setValue("show_mtime", show_m)
        self.settings.setValue("show_ctime", show_c)

        output = []
        folder_line_indices = set()

        def traverse(item, prefix):
            data = item.data(0, Qt.UserRole)
            meta_parts = []
            if data:
                if show_s:
                    meta_parts.append(f"[{self._fmt_size(data.size_bytes)}]")
                if show_m:
                    meta_parts.append(
                        f"[修:{self._fmt_time(data.mtime_epoch)}]")
                if show_c:
                    meta_parts.append(
                        f"[创:{self._fmt_time(data.ctime_epoch)}]")
            meta_str = " " + " ".join(meta_parts) if meta_parts else ""

            # 记录根目录行的索引
            if not prefix:
                folder_line_indices.add(len(output))
                output.append(f"{item.text(0)}/{meta_str}")

            child_count = item.childCount()
            for i in range(child_count):
                child = item.child(i)
                is_last = (i == child_count - 1)
                pointer = "└── " if is_last else "├── "
                ext = "    " if is_last else "│   "
                c_data = child.data(0, Qt.UserRole)
                c_meta_parts = []
                if c_data:
                    if show_s:
                        c_meta_parts.append(
                            f"[{self._fmt_size(c_data.size_bytes)}]")
                    if show_m:
                        c_meta_parts.append(
                            f"[修:{self._fmt_time(c_data.mtime_epoch)}]")
                    if show_c:
                        c_meta_parts.append(
                            f"[创:{self._fmt_time(c_data.ctime_epoch)}]")
                c_meta_str = " " + \
                    " ".join(c_meta_parts) if c_meta_parts else ""

                line = f"{prefix}{pointer}{child.text(0)}{c_meta_str}"
                if c_data and c_data.is_dir:
                    line += "/"
                    folder_line_indices.add(len(output))

                output.append(line)
                if child.isExpanded() and child.childCount() > 0:
                    traverse(child, prefix + ext)

        traverse(self.tree.topLevelItem(0), "")
        self.text_area.setPlainText("\n".join(output))

        # --- 高效设置块状态 ---
        doc = self.text_area.document()
        block = doc.begin()
        idx = 0
        while block.isValid():
            if idx in folder_line_indices:
                block.setUserState(STATE_FOLDER)
            block = block.next()
            idx += 1

        # 强制触发一次高亮重绘
        self.text_area.highlighter.rehighlight()
        self.update_breadcrumb()

    def collapse_all(self):
        self.tree.collapseAll()
        if self.tree.topLevelItemCount() > 0:
            self.tree.topLevelItem(0).setExpanded(True)

    def update_history(self, path):
        path = str(Path(path)).replace('\\', '/')
        current = [self.combo_path.itemText(i)
                   for i in range(self.combo_path.count())]
        self.combo_path.blockSignals(True)
        if path in current:
            self.combo_path.removeItem(self.combo_path.findText(path))
        self.combo_path.insertItem(0, path)
        self.combo_path.setCurrentIndex(0)
        self.combo_path.blockSignals(False)
        self.settings.setValue("history", [self.combo_path.itemText(
            i) for i in range(self.combo_path.count())])

    def load_history(self):
        history = self.settings.value("history", [])
        if isinstance(history, str):
            history = [history]
        self.combo_path.addItems(history)

    def _fmt_size(self, size):
        for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
            if size < 1024:
                return f"{size}B" if unit == 'B' else f"{size:.1f}{unit}"
            size /= 1024
        return f"{size:.1f}PB"

    def _fmt_time(self, ts):
        if not ts:
            return ""
        return time.strftime('%Y-%m-%d %H:%M', time.localtime(ts))

    def set_breadcrumb_message(self, text):
        if not hasattr(self, "lbl_breadcrumb"):
            return
        wrapped = f'<div style="position: relative; top: -2px;">{text}</div>'
        self.lbl_breadcrumb.setText(wrapped)
        self._adjust_breadcrumb_height()

    def _adjust_breadcrumb_height(self):
        if not hasattr(self, "lbl_breadcrumb"):
            return
        available_width = self.width() - 20
        if available_width <= 50:
            return
        doc = QTextDocument()
        doc.setDefaultFont(self.lbl_breadcrumb.font())
        doc.setHtml(self.lbl_breadcrumb.text())
        doc.setTextWidth(available_width)
        doc.setDocumentMargin(0)
        perfect_height = doc.size().height()
        target_height = int(perfect_height + 4)
        if abs(self.lbl_breadcrumb.height() - target_height) > 2:
            self.lbl_breadcrumb.setFixedHeight(target_height)

    def update_breadcrumb(self):
        try:
            cursor = self.text_area.cursorForPosition(
                self.text_area.rect().topLeft())
            block = cursor.block()
            if not block.isValid():
                return
            parts = []
            current_indent = self._calc_indent(block.text())
            name = self._clean_name(block.text())
            if name:
                parts.insert(0, name)
            prev = block.previous()
            while prev.isValid():
                txt = prev.text()
                ind = self._calc_indent(txt)
                if ind < current_indent:
                    name = self._clean_name(txt)
                    if name:
                        parts.insert(0, name)
                    current_indent = ind
                if ind == 0:
                    break
                prev = prev.previous()
            if len(parts) > 1:
                parts.pop()

            self.current_crumb_parts = parts

            if parts:
                safe_parts = [html.escape(p) for p in parts]
                sep = ' <span style="font-size:9pt;">📂</span> '
                html_text = sep.join(safe_parts)
                self.set_breadcrumb_message(html_text)
            else:
                self.set_breadcrumb_message("Ready.")
        except:
            pass

    def _calc_indent(self, text):
        match = re.match(r'^([│├└─\s]+)', text)
        return len(match.group(1)) if match else 0

    def _clean_name(self, text):
        if "─ " in text:
            content = text.split("─ ", 1)[1]
        else:
            content = text
        content = re.sub(r'\s*\[.*?\]\s*/?$', '', content)
        content = content.rstrip('/')
        return content.strip()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    app = QApplication(sys.argv)
    window = ModernWindow()
    window.show()
    sys.exit(app.exec_())

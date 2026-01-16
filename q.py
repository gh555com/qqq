import sys
import os
import hashlib
import hmac
import struct
import zlib

from PySide2.QtCore import QSettings
from PySide2.QtWidgets import (
    QApplication,
    QWidget,
    QPushButton,
    QLabel,
    QComboBox,
    QFileDialog,
    QLineEdit,
    QHBoxLayout,
    QVBoxLayout,
    QMessageBox,
)

# ---------- 通用常量 ----------

PNG_SIG = b'\x89PNG\r\n\x1a\n'
DGS_CHUNK_TYPE = b'dGs0'

GIF_HEADER_87A = b'GIF87a'
GIF_HEADER_89A = b'GIF89a'
GIF_TRAILER = 0x3B

# GIF Application Extension 标识
GIF_APP_ID = b'DGSIGN00'          # 8 字节
GIF_APP_AUTH = b'\x00\x01\x00'    # 3 字节

# ！！！实际使用请改成你自己的随机 key，且不要公开！！！
SECRET_KEY = b"change-this-to-your-own-random-secret-key"


def compute_sha256(path: str) -> str:
    """对文件计算 SHA-256（全文件）"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


# ---------- PNG 相关 ----------

def is_png(data: bytes) -> bool:
    return data.startswith(PNG_SIG)


def find_dgs_chunk_range_png(data: bytes):
    """返回 PNG 中 dGs0 chunk 的 (start_offset, end_offset) 或 None"""
    if not is_png(data):
        return None
    offset = len(PNG_SIG)
    length_data = len(data)
    while offset + 8 <= length_data:
        length = int.from_bytes(data[offset:offset+4], "big")
        ctype = data[offset+4:offset+8]
        data_start = offset + 8
        data_end = data_start + length
        crc_end = data_end + 4
        if crc_end > length_data:
            break
        if ctype == DGS_CHUNK_TYPE:
            return offset, crc_end
        offset = crc_end
    return None


def has_dgs_chunk_png(data: bytes) -> bool:
    return find_dgs_chunk_range_png(data) is not None


def hmac_for_png(data: bytes) -> bytes:
    """对 PNG 文件计算 HMAC，如果已有 dGs0，则先去掉该 chunk"""
    rng = find_dgs_chunk_range_png(data)
    if rng is not None:
        start, end = rng
        unsigned = data[:start] + data[end:]
    else:
        unsigned = data
    return hmac.new(SECRET_KEY, unsigned, hashlib.sha256).digest()


def insert_dgs_chunk_png(original: bytes, digest: bytes,
                         version: int = 1, alg: int = 1) -> bytes:
    """在 PNG 中插入 dGs0 chunk，data = version(1)+alg(1)+digest(32)"""
    if not is_png(original):
        raise ValueError("不是合法 PNG 文件")
    if len(digest) != 32:
        raise ValueError("HMAC 长度不是 32 字节")

    data = bytes([version & 0xFF, alg & 0xFF]) + digest
    length = len(data)
    chunk_type = DGS_CHUNK_TYPE
    crc_input = chunk_type + data
    crc = zlib.crc32(crc_input) & 0xFFFFFFFF

    chunk = struct.pack(">I", length) + chunk_type + \
        data + struct.pack(">I", crc)

    # 插在 IHDR 后面
    offset = len(PNG_SIG)
    length_data = len(original)
    insert_pos = None
    while offset + 8 <= length_data:
        clen = int.from_bytes(original[offset:offset+4], "big")
        ctype = original[offset+4:offset+8]
        data_start = offset + 8
        data_end = data_start + clen
        crc_end = data_end + 4
        if crc_end > length_data:
            break
        if ctype == b"IHDR":
            insert_pos = crc_end
            break
        offset = crc_end

    if insert_pos is None:
        raise ValueError("PNG 中没有找到 IHDR chunk")

    return original[:insert_pos] + chunk + original[insert_pos:]


# ---------- GIF 相关 ----------

def is_gif(data: bytes) -> bool:
    return data.startswith(GIF_HEADER_87A) or data.startswith(GIF_HEADER_89A)


def _gif_skip_sub_blocks(data: bytes, offset: int) -> int:
    """从 offset 开始跳过一组 sub-block，返回结束位置（指向 0x00 之后）"""
    length_data = len(data)
    while offset < length_data:
        block_size = data[offset]
        offset += 1
        if block_size == 0:
            break
        offset += block_size
    return offset


def find_dgs_app_ext_range_gif(data: bytes):
    """返回 GIF 中 DGS Application Extension 的 (start, end) 或 None"""
    if not is_gif(data):
        return None
    length_data = len(data)
    if length_data < 13:
        return None

    # 跳过 header(6) + LSD(7)
    offset = 13
    # 处理全局颜色表
    packed = data[10]
    if packed & 0x80:
        gct_size = 3 * (2 ** ((packed & 0x07) + 1))
        offset += gct_size
        if offset > length_data:
            return None

    while offset < length_data:
        introducer = data[offset]
        if introducer == GIF_TRAILER:
            break
        if introducer == 0x21:  # 扩展块
            if offset + 2 > length_data:
                break
            label = data[offset + 1]
            if label == 0xFF:  # Application Extension
                if offset + 3 + 11 > length_data:
                    break
                block_size = data[offset + 2]
                if block_size != 0x0B:
                    # 非标准，跳过
                    offset = _gif_skip_sub_blocks(
                        data, offset + 3 + block_size)
                    continue
                app_id = data[offset + 3:offset + 11]
                auth = data[offset + 11:offset + 14]
                sub_offset = offset + 3 + block_size
                sub_offset = _gif_skip_sub_blocks(data, sub_offset)
                ext_end = sub_offset
                if app_id == GIF_APP_ID and auth == GIF_APP_AUTH:
                    return offset, ext_end
                offset = ext_end
            else:
                # 其他扩展：直接跳过 sub-blocks
                offset = _gif_skip_sub_blocks(data, offset + 2)
        elif introducer == 0x2C:  # 图像描述符
            if offset + 10 > length_data:
                break
            packed2 = data[offset + 9]
            offset += 10
            if packed2 & 0x80:
                lct_size = 3 * (2 ** ((packed2 & 0x07) + 1))
                offset += lct_size
                if offset > length_data:
                    break
            # LZW 最小码长
            if offset >= length_data:
                break
            offset += 1
            # 图像数据 blocks
            offset = _gif_skip_sub_blocks(data, offset)
        else:
            # 异常字节，为安全起见终止
            break
    return None


def has_dgs_app_ext_gif(data: bytes) -> bool:
    return find_dgs_app_ext_range_gif(data) is not None


def hmac_for_gif(data: bytes) -> bytes:
    """对 GIF 文件计算 HMAC，如果已有 DGS 扩展，则先去掉再算"""
    rng = find_dgs_app_ext_range_gif(data)
    if rng is not None:
        start, end = rng
        unsigned = data[:start] + data[end:]
    else:
        unsigned = data
    return hmac.new(SECRET_KEY, unsigned, hashlib.sha256).digest()


def insert_dgs_app_ext_gif(original: bytes, digest: bytes,
                           version: int = 1, alg: int = 1) -> bytes:
    """在 GIF 中插入 DGS Application Extension"""
    if not is_gif(original):
        raise ValueError("不是合法 GIF 文件")
    if len(digest) != 32:
        raise ValueError("HMAC 长度不是 32 字节")

    ext_data = bytes([version & 0xFF, alg & 0xFF]) + digest
    if len(ext_data) > 255:
        raise ValueError("扩展数据太长")

    # Application Extension 头：0x21, 0xFF, 0x0B, app_id(8), auth(3)
    header = bytes([0x21, 0xFF, 0x0B]) + GIF_APP_ID + GIF_APP_AUTH
    # sub-block = size + data + terminator(0)
    sub_block = bytes([len(ext_data)]) + ext_data + b'\x00'
    ext = header + sub_block

    # 插在 trailer (0x3B) 前
    trailer_pos = original.rfind(bytes([GIF_TRAILER]))
    if trailer_pos == -1:
        raise ValueError("GIF 文件缺少 trailer")

    return original[:trailer_pos] + ext + original[trailer_pos:]


# ---------- 通用 HMAC ----------

def detect_file_type(data: bytes) -> str:
    if is_png(data):
        return "png"
    if is_gif(data):
        return "gif"
    return "other"


def compute_hmac_for_data(data: bytes, ftype: str) -> bytes:
    if ftype == "png":
        return hmac_for_png(data)
    elif ftype == "gif":
        return hmac_for_gif(data)
    else:
        # 其他文件：直接对全文件做 HMAC
        return hmac.new(SECRET_KEY, data, hashlib.sha256).digest()


# ---------- GUI 部分 ----------

class WatermarkSigner(QWidget):
    def __init__(self):
        super().__init__()

        self.settings = QSettings("DreamGoods", "WatermarkSignerMulti")
        self.history = self.load_history()
        self.current_file = self.settings.value("lastFile", "", type=str)
        self.current_type = "other"

        self.init_ui()

        if self.current_file and os.path.isfile(self.current_file):
            self.set_current_file(self.current_file)

    def init_ui(self):
        self.setWindowTitle("水印签名器（PNG / GIF + 通用 SHA-256）")
        self.resize(820, 280)

        # 左侧控件
        self.btn_choose = QPushButton("选择文件")
        self.btn_choose.clicked.connect(self.on_choose_file)

        self.lbl_file = QLabel("当前文件：<未选择>")
        self.lbl_file.setWordWrap(True)

        self.lbl_type = QLabel("文件类型：未知")

        self.btn_calc_sha = QPushButton("生成 SHA-256")
        self.btn_calc_sha.setEnabled(False)
        self.btn_calc_sha.clicked.connect(self.on_calc_sha)

        self.edit_sha = QLineEdit()
        self.edit_sha.setReadOnly(True)
        self.edit_sha.setPlaceholderText("这里显示 SHA-256")

        self.btn_sign = QPushButton("签名并另存为（PNG / GIF）")
        self.btn_sign.setEnabled(False)
        self.btn_sign.clicked.connect(self.on_sign)

        # 右侧：历史
        self.lbl_history = QLabel("历史文件：")
        self.combo_history = QComboBox()
        self.combo_history.setEditable(False)
        self.combo_history.setMaxVisibleItems(20)
        self.combo_history.setInsertPolicy(QComboBox.NoInsert)
        self.combo_history.addItems(self.history)
        self.combo_history.activated[str].connect(self.on_history_selected)

        # 布局
        left = QVBoxLayout()
        left.addWidget(self.btn_choose)
        left.addWidget(self.lbl_file)
        left.addWidget(self.lbl_type)
        left.addWidget(self.btn_calc_sha)
        left.addWidget(QLabel("SHA-256："))
        left.addWidget(self.edit_sha)
        left.addWidget(self.btn_sign)
        left.addStretch(1)

        right = QVBoxLayout()
        right.addWidget(self.lbl_history)
        right.addWidget(self.combo_history)
        right.addStretch(1)

        main = QHBoxLayout()
        main.addLayout(left, 3)
        main.addLayout(right, 2)
        self.setLayout(main)

    # ---------- 事件 ----------

    def on_choose_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self,
            "选择文件",
            "",
            "所有文件 (*.*)"
        )
        if path:
            self.set_current_file(path)

    def on_history_selected(self, path: str):
        if path and os.path.isfile(path):
            self.set_current_file(path)
        elif path:
            QMessageBox.warning(self, "文件不存在", f"历史中的文件不存在：\n{path}")
            self.remove_from_history(path)

    def on_calc_sha(self):
        if not self.current_file:
            QMessageBox.warning(self, "提示", "请先选择文件")
            return
        try:
            sha = compute_sha256(self.current_file)
        except Exception as e:
            QMessageBox.critical(self, "错误", f"计算 SHA-256 失败：\n{e}")
            return
        self.edit_sha.setText(sha)

    def on_sign(self):
        if not self.current_file:
            QMessageBox.warning(self, "提示", "请先选择文件")
            return
        if self.current_type not in ("png", "gif"):
            QMessageBox.information(
                self,
                "暂不支持",
                "当前示例的“嵌入式签名”仅支持 PNG 和 GIF。\n"
                "其他类型目前只支持计算 SHA-256。"
            )
            return
        if not os.path.isfile(self.current_file):
            QMessageBox.warning(self, "错误", f"文件不存在：\n{self.current_file}")
            return

        # 读文件
        try:
            with open(self.current_file, "rb") as f:
                data = f.read()
        except Exception as e:
            QMessageBox.critical(self, "错误", f"读取文件失败：\n{e}")
            return

        ftype = detect_file_type(data)
        if ftype != self.current_type:
            # 扩展名和文件头不一致，提示一下
            QMessageBox.warning(
                self,
                "类型不一致",
                "文件扩展名与实际内容类型不一致，已按内容类型处理。"
            )
            self.current_type = ftype

        # 检查是否已有签名块
        if ftype == "png" and has_dgs_chunk_png(data):
            QMessageBox.information(
                self,
                "已经签名",
                "该 PNG 已包含 dGs0 chunk（可能已签名）。\n"
                "当前示例工具暂不支持覆盖签名，请使用未签名原始文件。"
            )
            return
        if ftype == "gif" and has_dgs_app_ext_gif(data):
            QMessageBox.information(
                self,
                "已经签名",
                "该 GIF 已包含 DGS Application Extension（可能已签名）。\n"
                "当前示例工具暂不支持覆盖签名，请使用未签名原始文件。"
            )
            return

        # 计算 HMAC
        try:
            digest = compute_hmac_for_data(data, ftype)
        except Exception as e:
            QMessageBox.critical(self, "错误", f"计算 HMAC 失败：\n{e}")
            return

        # 插入签名
        try:
            if ftype == "png":
                signed = insert_dgs_chunk_png(data, digest, version=1, alg=1)
                default_ext = ".signed.png"
            elif ftype == "gif":
                signed = insert_dgs_app_ext_gif(data, digest, version=1, alg=1)
                default_ext = ".signed.gif"
            else:
                QMessageBox.information(
                    self,
                    "暂不支持",
                    "当前示例仅支持 PNG / GIF 的嵌入签名。"
                )
                return
        except Exception as e:
            QMessageBox.critical(self, "错误", f"插入签名数据失败：\n{e}")
            return

        base, ext = os.path.splitext(self.current_file)
        default_out = base + default_ext

        out_path, _ = QFileDialog.getSaveFileName(
            self,
            "保存签名后的文件",
            default_out,
            "所有文件 (*.*)"
        )
        if not out_path:
            return

        try:
            with open(out_path, "wb") as f:
                f.write(signed)
        except Exception as e:
            QMessageBox.critical(self, "错误", f"写入文件失败：\n{e}")
            return

        QMessageBox.information(
            self,
            "完成",
            f"签名完成！\n\n原始文件：\n{self.current_file}\n\n已保存为：\n{out_path}",
        )

    # ---------- 公共逻辑 ----------

    def set_current_file(self, path: str):
        self.current_file = path
        self.lbl_file.setText(f"当前文件：{path}")
        self.btn_calc_sha.setEnabled(True)
        self.append_history(path)
        self.settings.setValue("lastFile", path)

        # 探测类型（看文件头，不看扩展名）
        ftype = "other"
        try:
            with open(path, "rb") as f:
                header = f.read(16)
            ftype = detect_file_type(header)
        except Exception:
            ftype = "other"

        self.current_type = ftype

        if ftype == "png":
            self.lbl_type.setText("文件类型：PNG（支持嵌入 dGs0 签名）")
            self.btn_sign.setEnabled(True)
        elif ftype == "gif":
            self.lbl_type.setText("文件类型：GIF（支持嵌入 Application Extension 签名）")
            self.btn_sign.setEnabled(True)
        else:
            self.lbl_type.setText("文件类型：其他（仅支持 SHA-256 计算）")
            self.btn_sign.setEnabled(False)

    def load_history(self):
        value = self.settings.value("history", [])
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        try:
            return list(value)
        except TypeError:
            return []

    def save_history(self):
        self.settings.setValue("history", self.history)

    def append_history(self, path: str):
        if path in self.history:
            self.history.remove(path)
        self.history.insert(0, path)
        self.history = self.history[:50]
        self.refresh_history_combo()
        self.save_history()

    def remove_from_history(self, path: str):
        if path in self.history:
            self.history.remove(path)
            self.refresh_history_combo()
            self.save_history()

    def refresh_history_combo(self):
        self.combo_history.blockSignals(True)
        self.combo_history.clear()
        self.combo_history.addItems(self.history)
        self.combo_history.blockSignals(False)


def main():
    app = QApplication(sys.argv)
    w = WatermarkSigner()
    w.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()

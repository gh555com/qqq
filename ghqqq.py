# -*- coding: utf-8 -*-
"""
ghqqq.py — qqq IDE 热更推送 & 服务端操控中心
功能：热更 JSON 管理 / gaea 模块 bundle+推送 / 服务端部署 / 端点健康检查 / 日志
风格仿 qide.py，PySide6 单文件。
"""
import sys
import os
import json
import time
import subprocess
import shutil
import hashlib
import tempfile
from pathlib import Path
from datetime import datetime

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QPlainTextEdit, QLabel, QGroupBox, QGridLayout,
    QStatusBar, QTabWidget, QTextEdit, QComboBox, QSplitter,
    QMessageBox, QFileDialog
)
from PySide6.QtCore import Qt, QThread, Signal, QTimer
from PySide6.QtGui import QFont, QTextCursor

# ===================== 路径常量 =====================
GAEA_ROOT   = Path("E:/s/wol/py/gaea")
KY_PY       = GAEA_ROOT / "cf" / "ky.py"
HOT_DIR     = GAEA_ROOT / "web" / "qqq-hot"       # 服务端热更 JSON 源
Q3          = Path("E:/s/wol/py/q3")
MODULES     = Path("E:/s/wol/py/qqq-modules")     # gaea 模块开发根
OUT_DIR     = Path("E:/s/wol/py/VSCode-win32-x64")
F_M_DIR     = OUT_DIR / "f" / "m"                  # 运行时 gaea 模块目录
PYTHON_EXE  = r"E:\s\d\python3810\python.exe"
GIT_BASH    = r"E:\s\d\git\bin\bash.exe"

# 远程服务器
SERVER_MAIN = "q@47.105.67.5"    # 阿里云主力
SERVER_US   = "q@74.48.182.213"  # 美国节点
BASE_URL    = "https://gh555.com"

# 热更 JSON 文件列表
HOT_FILES = ["menu.json", "settings.json", "about.json"]


# ===================== 工作线程 =====================
class CmdWorker(QThread):
    line_ready = Signal(str)
    finished_ok = Signal(int, float)

    def __init__(self, cmd: str, cwd: Path = None, shell="cmd", parent=None):
        super().__init__(parent)
        self.cmd = cmd
        self.cwd = str(cwd) if cwd else None
        self.shell = shell
        self._proc = None
        self._stop = False

    def stop(self):
        self._stop = True
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.terminate()
            except Exception:
                pass

    def run(self):
        t0 = time.time()
        bat_file = None
        try:
            if self.shell == "bash":
                args = [GIT_BASH, "-c", self.cmd]
            else:
                bat_file = self._write_bat(self.cmd)
                args = ["cmd.exe", "/c", bat_file]
            self.line_ready.emit(f"[CMD] {self.cmd}")
            if self.cwd:
                self.line_ready.emit(f"[CWD] {self.cwd}")
            self._proc = subprocess.Popen(
                args,
                cwd=self.cwd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=1,
                universal_newlines=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            for line in iter(self._proc.stdout.readline, ""):
                if self._stop:
                    break
                self.line_ready.emit(line.rstrip("\n"))
            self._proc.stdout.close()
            code = self._proc.wait()
        except Exception as e:
            self.line_ready.emit(f"[ERR] {e}")
            code = -1
        finally:
            if bat_file:
                try:
                    os.unlink(bat_file)
                except Exception:
                    pass
        dt = time.time() - t0
        self.finished_ok.emit(code, dt)

    @staticmethod
    def _write_bat(cmd: str) -> str:
        f = tempfile.NamedTemporaryFile(mode='w', suffix='.bat', delete=False,
                                         encoding='gbk', errors='replace')
        f.write('@echo off\r\nchcp 65001 >nul\r\n')
        f.write(cmd + '\r\n')
        f.write('exit /b %ERRORLEVEL%\r\n')
        f.close()
        return f.name


# ===================== 主窗口 =====================
class GhqqqWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("ghqqq — qqq IDE 热更推送 & 服务端控制台")
        self.resize(1400, 900)
        self.worker: CmdWorker = None
        self._build_ui()
        self._apply_dark_theme()

        self.status_timer = QTimer(self)
        self.status_timer.timeout.connect(self.refresh_status)
        self.status_timer.start(3000)
        self.refresh_status()

    # --------- UI 构造 ---------
    def _build_ui(self):
        central = QWidget()
        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)

        # ---- 顶部状态条 ----
        self.lbl_status = QLabel("loading…")
        self.lbl_status.setStyleSheet(
            "padding:6px;background:#222;color:#9cdcfe;border-radius:4px;font-family:Consolas;")
        root.addWidget(self.lbl_status)

        # ---- 主体：Splitter (左=tabs, 右=log) ----
        splitter = QSplitter(Qt.Horizontal)

        # 左侧 Tab
        self.tabs = QTabWidget()
        self.tabs.addTab(self._tab_hot_json(), "① 热更 JSON")
        self.tabs.addTab(self._tab_deploy(), "② 部署")
        self.tabs.addTab(self._tab_gaea_modules(), "③ Gaea 模块")
        self.tabs.addTab(self._tab_monitor(), "④ 监控")
        splitter.addWidget(self.tabs)

        # 右侧日志
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setFont(QFont("Consolas", 10))
        self.log.setStyleSheet("background:#1e1e1e;color:#d4d4d4;")
        splitter.addWidget(self.log)

        splitter.setStretchFactor(0, 2)
        splitter.setStretchFactor(1, 3)
        root.addWidget(splitter, 1)

        # ---- 底部操作栏 ----
        bot = QHBoxLayout()
        self.btn_stop = QPushButton("⛔ 中止")
        self.btn_stop.clicked.connect(self.stop_current)
        self.btn_clear = QPushButton("🧹 清空日志")
        self.btn_clear.clicked.connect(lambda: self.log.clear())
        bot.addWidget(self.btn_stop)
        bot.addWidget(self.btn_clear)
        bot.addStretch()
        root.addLayout(bot)

        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar())

    # =============== Tab ①: 热更 JSON ===============
    def _tab_hot_json(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)

        # 文件选择
        h = QHBoxLayout()
        h.addWidget(QLabel("文件："))
        self.combo_hot = QComboBox()
        self.combo_hot.addItems(HOT_FILES)
        self.combo_hot.currentTextChanged.connect(self._load_hot_file)
        h.addWidget(self.combo_hot, 1)
        btn_reload = QPushButton("🔄 重新加载")
        btn_reload.clicked.connect(lambda: self._load_hot_file(self.combo_hot.currentText()))
        h.addWidget(btn_reload)
        v.addLayout(h)

        # 编辑器
        self.editor_hot = QTextEdit()
        self.editor_hot.setFont(QFont("Consolas", 11))
        self.editor_hot.setStyleSheet("background:#1e1e1e;color:#d4d4d4;")
        v.addWidget(self.editor_hot, 1)

        # 操作按钮
        btn_row = QHBoxLayout()
        btn_save = QPushButton("💾 保存本地")
        btn_save.clicked.connect(self.act_hot_save_local)
        btn_validate = QPushButton("✅ 校验 JSON")
        btn_validate.clicked.connect(self.act_hot_validate)
        btn_push = QPushButton("🚀 推送到服务器 (scp)")
        btn_push.clicked.connect(self.act_hot_push_file)
        btn_push_all = QPushButton("🚀🚀 推送全部 JSON")
        btn_push_all.clicked.connect(self.act_hot_push_all)
        btn_row.addWidget(btn_save)
        btn_row.addWidget(btn_validate)
        btn_row.addWidget(btn_push)
        btn_row.addWidget(btn_push_all)
        v.addLayout(btn_row)

        # 首次加载
        QTimer.singleShot(100, lambda: self._load_hot_file("menu.json"))
        return w

    # =============== Tab ②: 部署 ===============
    def _tab_deploy(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)

        g1 = QGroupBox("一键部署 (ky.py)")
        g1v = QVBoxLayout(g1)
        btn_deploy = QPushButton("🚀 执行 ky.py 全量部署")
        btn_deploy.clicked.connect(self.act_deploy_full)
        btn_deploy.setToolTip("python ky.py — 编译/同步/翻译/重启")
        g1v.addWidget(btn_deploy)
        btn_sync_only = QPushButton("📤 仅同步代码 (rsync)")
        btn_sync_only.clicked.connect(self.act_deploy_sync_only)
        g1v.addWidget(btn_sync_only)
        btn_restart = QPushButton("🔄 重启 dgs 服务")
        btn_restart.clicked.connect(self.act_deploy_restart)
        g1v.addWidget(btn_restart)
        v.addWidget(g1)

        g2 = QGroupBox("健康检查")
        g2v = QVBoxLayout(g2)
        btn_health = QPushButton("🩺 检查所有端点")
        btn_health.clicked.connect(self.act_health_check_all)
        g2v.addWidget(btn_health)
        btn_hot_check = QPushButton("🩺 检查热更 JSON 端点")
        btn_hot_check.clicked.connect(self.act_health_check_hot)
        g2v.addWidget(btn_hot_check)
        btn_version = QPushButton("📋 查服务端版本")
        btn_version.clicked.connect(self.act_check_version)
        g2v.addWidget(btn_version)
        v.addWidget(g2)

        g3 = QGroupBox("SSH 快捷")
        g3v = QVBoxLayout(g3)
        btn_log = QPushButton("📜 tail 主力日志 (最近 50 行)")
        btn_log.clicked.connect(self.act_ssh_tail_log)
        g3v.addWidget(btn_log)
        btn_status = QPushButton("📊 systemctl status dgs")
        btn_status.clicked.connect(self.act_ssh_status)
        g3v.addWidget(btn_status)
        btn_disk = QPushButton("💽 磁盘/内存")
        btn_disk.clicked.connect(self.act_ssh_disk)
        g3v.addWidget(btn_disk)
        v.addWidget(g3)

        v.addStretch()
        return w

    # =============== Tab ③: Gaea 模块 ===============
    def _tab_gaea_modules(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)

        g1 = QGroupBox("本地 Bundle + Sync")
        g1v = QVBoxLayout(g1)
        btn_b_ai = QPushButton("🔨 Bundle ai 模块")
        btn_b_ai.clicked.connect(self.act_mod_bundle_ai)
        g1v.addWidget(btn_b_ai)
        btn_b_core = QPushButton("🔨 Bundle core 模块")
        btn_b_core.clicked.connect(self.act_mod_bundle_core)
        g1v.addWidget(btn_b_core)
        btn_sync = QPushButton("📤 Sync → f/m/ (本地 portable)")
        btn_sync.clicked.connect(self.act_mod_sync_local)
        g1v.addWidget(btn_sync)
        btn_all = QPushButton("⚡ Bundle All + Sync (一键)")
        btn_all.clicked.connect(self.act_mod_bundle_all)
        g1v.addWidget(btn_all)
        v.addWidget(g1)

        g2 = QGroupBox("远程推送")
        g2v = QVBoxLayout(g2)
        btn_upload = QPushButton("🚀 上传 gaea 模块 → 服务器")
        btn_upload.clicked.connect(self.act_mod_upload)
        btn_upload.setToolTip("scp bundle + gaea.json → 远程 web/qqq-hot/modules/")
        g2v.addWidget(btn_upload)
        v.addWidget(g2)

        v.addStretch()
        return w

    # =============== Tab ④: 监控 ===============
    def _tab_monitor(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)

        g1 = QGroupBox("远程端点内容预览")
        g1v = QVBoxLayout(g1)
        btn_preview_menu = QPushButton("📋 预览远程 menu.json")
        btn_preview_menu.clicked.connect(lambda: self.act_preview_remote("menu.json"))
        g1v.addWidget(btn_preview_menu)
        btn_preview_set = QPushButton("📋 预览远程 settings.json")
        btn_preview_set.clicked.connect(lambda: self.act_preview_remote("settings.json"))
        g1v.addWidget(btn_preview_set)
        btn_preview_about = QPushButton("📋 预览远程 about.json")
        btn_preview_about.clicked.connect(lambda: self.act_preview_remote("about.json"))
        g1v.addWidget(btn_preview_about)
        v.addWidget(g1)

        g2 = QGroupBox("数据库快查 (psql)")
        g2v = QVBoxLayout(g2)
        btn_doer_count = QPushButton("👤 用户总数")
        btn_doer_count.clicked.connect(lambda: self.act_psql("SELECT count(*) FROM doers;"))
        g2v.addWidget(btn_doer_count)
        btn_device_count = QPushButton("📱 设备总数")
        btn_device_count.clicked.connect(lambda: self.act_psql("SELECT count(*) FROM ide_devices;"))
        g2v.addWidget(btn_device_count)
        btn_recent = QPushButton("🕐 最近 10 个注册用户")
        btn_recent.clicked.connect(lambda: self.act_psql(
            "SELECT id, alias, created_at FROM doers ORDER BY created_at DESC LIMIT 10;"))
        g2v.addWidget(btn_recent)
        v.addWidget(g2)

        g3 = QGroupBox("Cloudflare 缓存")
        g3v = QVBoxLayout(g3)
        btn_purge = QPushButton("🗑️ Purge 热更 JSON 缓存")
        btn_purge.clicked.connect(self.act_cf_purge_hot)
        btn_purge.setToolTip("通过 Cloudflare API 清除 menu/settings/about.json 边缘缓存")
        g3v.addWidget(btn_purge)
        v.addWidget(g3)

        v.addStretch()
        return w

    # --------- 公共方法 ---------
    def run_cmd(self, cmd: str, cwd: Path = None, shell="cmd", banner: str = ""):
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 已有任务运行中，先中止再来。")
            return
        if banner:
            self.append_log(f"\n{'='*10} {banner} {'='*10}")
        self.worker = CmdWorker(cmd, cwd, shell)
        self.worker.line_ready.connect(self.append_log)
        self.worker.finished_ok.connect(self.on_cmd_done)
        self.worker.start()

    def run_ssh(self, remote_cmd: str, server: str = None, banner: str = ""):
        srv = server or SERVER_MAIN
        cmd = f'ssh {srv} "{remote_cmd}"'
        self.run_cmd(cmd, shell="bash", banner=banner or f"SSH → {srv}")

    def append_log(self, line: str):
        self.log.appendPlainText(line)
        self.log.moveCursor(QTextCursor.MoveOperation.End)

    def on_cmd_done(self, code: int, secs: float):
        flag = "✅ OK" if code == 0 else f"❌ FAIL ({code})"
        self.append_log(f"[DONE {flag}] elapsed {secs:.1f}s\n")

    def stop_current(self):
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.append_log("🛑 stop signal 已发…")

    def _apply_dark_theme(self):
        self.setStyleSheet("""
            QMainWindow { background: #2d2d30; }
            QGroupBox { color: #d4d4d4; border: 1px solid #3e3e42; border-radius: 4px;
                        margin-top: 14px; padding: 6px; font-weight: bold; }
            QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: #9cdcfe; }
            QPushButton { background: #3c3c3c; color: #d4d4d4; border: 1px solid #555; border-radius: 3px;
                          padding: 5px 8px; text-align: left; }
            QPushButton:hover { background: #4a4a4f; border-color: #007acc; }
            QPushButton:pressed { background: #007acc; }
            QLabel { color: #d4d4d4; }
            QTabWidget::pane { border: 1px solid #3e3e42; }
            QTabBar::tab { background: #2d2d30; color: #d4d4d4; padding: 6px 12px; border: 1px solid #3e3e42;
                           border-bottom: none; border-top-left-radius: 4px; border-top-right-radius: 4px; }
            QTabBar::tab:selected { background: #1e1e1e; color: #9cdcfe; }
            QComboBox { background: #3c3c3c; color: #d4d4d4; border: 1px solid #555; padding: 4px; }
            QTextEdit { border: 1px solid #3e3e42; }
        """)

    # --------- 顶部状态刷新 ---------
    def refresh_status(self):
        try:
            hot_ok = all((HOT_DIR / f).exists() for f in HOT_FILES)
            modules_ok = MODULES.exists()
            ky_ok = KY_PY.exists()
            running = "▶ running" if (self.worker and self.worker.isRunning()) else "idle"
            txt = (f" hot-json: {'✅' if hot_ok else '❌'}   "
                   f"qqq-modules: {'✅' if modules_ok else '—'}   "
                   f"ky.py: {'✅' if ky_ok else '❌'}   "
                   f"server: {SERVER_MAIN}   "
                   f"|  worker: {running}")
            self.lbl_status.setText(txt)
        except Exception as e:
            self.lbl_status.setText(f"status err: {e}")

    # ============== ① 热更 JSON ==============
    def _load_hot_file(self, filename: str):
        fp = HOT_DIR / filename
        if fp.exists():
            try:
                text = fp.read_text(encoding="utf-8")
                self.editor_hot.setPlainText(text)
                self.append_log(f"📂 已加载 {fp}")
            except Exception as e:
                self.editor_hot.setPlainText(f"// 读取失败：{e}")
        else:
            self.editor_hot.setPlainText(f"// 文件不存在：{fp}\n// 点击保存创建")

    def act_hot_validate(self):
        text = self.editor_hot.toPlainText()
        try:
            obj = json.loads(text)
            self.append_log(f"✅ JSON 校验通过 — keys: {list(obj.keys())}")
        except json.JSONDecodeError as e:
            self.append_log(f"❌ JSON 语法错误：{e}")

    def act_hot_save_local(self):
        filename = self.combo_hot.currentText()
        text = self.editor_hot.toPlainText()
        # 先校验
        try:
            json.loads(text)
        except json.JSONDecodeError as e:
            self.append_log(f"❌ JSON 无效，拒绝保存：{e}")
            return
        fp = HOT_DIR / filename
        HOT_DIR.mkdir(parents=True, exist_ok=True)
        fp.write_text(text, encoding="utf-8")
        self.append_log(f"💾 已保存 → {fp}")

    def act_hot_push_file(self):
        filename = self.combo_hot.currentText()
        fp = HOT_DIR / filename
        if not fp.exists():
            self.append_log(f"❌ 本地文件不存在：{fp}")
            return
        remote_path = f"/opt/dgs/web/qqq-hot/{filename}"
        cmd = f"scp {fp} {SERVER_MAIN}:{remote_path}"
        self.run_cmd(cmd, shell="bash", banner=f"Push {filename} → {SERVER_MAIN}")

    def act_hot_push_all(self):
        """推送全部热更 JSON 到服务器"""
        missing = [f for f in HOT_FILES if not (HOT_DIR / f).exists()]
        if missing:
            self.append_log(f"❌ 缺少文件：{missing}")
            return
        files_str = " ".join(str(HOT_DIR / f) for f in HOT_FILES)
        remote_path = f"{SERVER_MAIN}:/opt/dgs/web/qqq-hot/"
        cmd = f"scp {files_str} {remote_path}"
        self.run_cmd(cmd, shell="bash", banner="Push ALL hot JSON → server")

    # ============== ② 部署 ==============
    def act_deploy_full(self):
        cmd = f'"{PYTHON_EXE}" "{KY_PY}"'
        self.run_cmd(cmd, GAEA_ROOT / "cf", banner="ky.py 全量部署")

    def act_deploy_sync_only(self):
        self.run_ssh(
            "cd /opt/dgs && git pull origin main",
            banner="git pull (同步代码)")

    def act_deploy_restart(self):
        self.run_ssh("systemctl restart dgs", banner="restart dgs")

    def act_health_check_all(self):
        endpoints = [
            "/api/version",
            "/api/time",
            "/__lbprobe",
            "/gaea/d/qqq/menu.json",
            "/gaea/d/qqq/settings.json",
            "/gaea/d/qqq/about.json",
        ]
        # 用 curl 逐个检查（bash 脚本）
        checks = " && ".join(
            f'echo "→ {ep}" && curl -sS -o /dev/null -w "%{{http_code}} %{{time_total}}s\\n" "{BASE_URL}{ep}"'
            for ep in endpoints
        )
        self.run_cmd(checks, shell="bash", banner="Health Check ALL endpoints")

    def act_health_check_hot(self):
        checks = " && ".join(
            f'echo "→ {f}" && curl -sS -w "HTTP %{{http_code}} | ETag: " -o /dev/null -D - "{BASE_URL}/gaea/d/qqq/{f}" 2>&1 | grep -i etag'
            for f in HOT_FILES
        )
        self.run_cmd(checks, shell="bash", banner="Hot JSON ETag Check")

    def act_check_version(self):
        cmd = f'curl -sS "{BASE_URL}/api/version"'
        self.run_cmd(cmd, shell="bash", banner="Server Version")

    # ============== ② SSH 快捷 ==============
    def act_ssh_tail_log(self):
        self.run_ssh("journalctl -u dgs --no-pager -n 50", banner="tail dgs log")

    def act_ssh_status(self):
        self.run_ssh("systemctl status dgs --no-pager", banner="dgs status")

    def act_ssh_disk(self):
        self.run_ssh("df -h / && echo '---' && free -h", banner="disk+memory")

    # ============== ③ Gaea 模块 ==============
    def act_mod_bundle_ai(self):
        if not (MODULES / "ai").exists():
            self.append_log(f"❌ {MODULES / 'ai'} 不存在")
            return
        self.run_cmd("node esbuild.config.js", MODULES / "ai", banner="Bundle gaea/ai")

    def act_mod_bundle_core(self):
        if not (MODULES / "core").exists():
            self.append_log(f"❌ {MODULES / 'core'} 不存在")
            return
        self.run_cmd("node esbuild.config.js", MODULES / "core", banner="Bundle gaea/core")

    def act_mod_sync_local(self):
        """Sync bundles → f/m/ (本地 portable 目录)"""
        try:
            for mod in ("ai", "core"):
                mod_dir = MODULES / mod
                if not mod_dir.exists():
                    self.append_log(f"⚠️ 跳过不存在的模块: {mod}")
                    continue
                dist_dir = mod_dir / "dist"
                dst_dir = F_M_DIR / mod
                dst_dir.mkdir(parents=True, exist_ok=True)
                if dist_dir.exists():
                    for fn in dist_dir.iterdir():
                        shutil.copy2(fn, dst_dir / fn.name)
                        self.append_log(f"📤 {fn.name} → {dst_dir}")
                gj = mod_dir / "gaea.json"
                if gj.exists():
                    shutil.copy2(gj, dst_dir / "gaea.json")
                    self.append_log(f"📤 gaea.json → {dst_dir}")
            self.append_log("[DONE ✅] gaea sync → f/m/ 完成\n")
        except Exception as e:
            self.append_log(f"❌ sync 失败：{e}")

    def act_mod_bundle_all(self):
        """Bundle all modules + sync local"""
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 任务进行中")
            return
        self.append_log("\n========== Gaea Bundle All + Sync ==========")
        # Chain: ai → core → sync
        self.worker = CmdWorker("node esbuild.config.js", MODULES / "ai")
        self.worker.line_ready.connect(self.append_log)

        def after_ai(code, secs):
            self.append_log(f"[ai {code=} {secs:.1f}s]")
            if code != 0:
                self.append_log("❌ ai bundle 失败")
                return
            self.worker = CmdWorker("node esbuild.config.js", MODULES / "core")
            self.worker.line_ready.connect(self.append_log)

            def after_core(code2, secs2):
                self.append_log(f"[core {code2=} {secs2:.1f}s]")
                if code2 == 0:
                    self.act_mod_sync_local()
                else:
                    self.append_log("❌ core bundle 失败")
            self.worker.finished_ok.connect(after_core)
            self.worker.start()

        self.worker.finished_ok.connect(after_ai)
        self.worker.start()

    def act_mod_upload(self):
        """上传 gaea 模块到服务器"""
        files = []
        for mod in ("ai", "core"):
            dist = MODULES / mod / "dist"
            gj = MODULES / mod / "gaea.json"
            if dist.exists():
                for f in dist.iterdir():
                    files.append(str(f))
            if gj.exists():
                files.append(str(gj))
        if not files:
            self.append_log("❌ 没有找到可上传的模块文件")
            return
        # 创建远程目录并上传
        mkdir_cmd = f"ssh {SERVER_MAIN} 'mkdir -p /opt/dgs/web/qqq-hot/modules/ai /opt/dgs/web/qqq-hot/modules/core'"
        upload_cmds = []
        for mod in ("ai", "core"):
            dist = MODULES / mod / "dist"
            if dist.exists():
                upload_cmds.append(
                    f"scp {dist}/* {SERVER_MAIN}:/opt/dgs/web/qqq-hot/modules/{mod}/")
            gj = MODULES / mod / "gaea.json"
            if gj.exists():
                upload_cmds.append(
                    f"scp {gj} {SERVER_MAIN}:/opt/dgs/web/qqq-hot/modules/{mod}/gaea.json")
        cmd = mkdir_cmd + " && " + " && ".join(upload_cmds)
        self.run_cmd(cmd, shell="bash", banner="Upload gaea modules → server")

    # ============== ④ 监控 ==============
    def act_preview_remote(self, filename: str):
        cmd = f'curl -sS "{BASE_URL}/gaea/d/qqq/{filename}"'
        self.run_cmd(cmd, shell="bash", banner=f"Preview remote {filename}")

    def act_psql(self, query: str):
        # 通过 SSH 执行 psql
        safe_q = query.replace("'", "'\\''")
        cmd = f"ssh {SERVER_MAIN} \"psql -U gaea -d gaea -c '{safe_q}'\""
        self.run_cmd(cmd, shell="bash", banner=f"psql: {query[:60]}")

    def act_cf_purge_hot(self):
        """通过 Cloudflare API 清除热更 JSON 缓存"""
        import requests as rq
        self.append_log("\n========== CF Purge hot JSON cache ==========")
        try:
            headers = {
                "X-Auth-Email": "a15802858204@gmail.com",
                "X-Auth-Key": "e9e1a4e4fdf2175c29877b87f182e0baa3f1a",
                "Content-Type": "application/json",
            }
            # 获取 zone_id
            r = rq.get("https://api.cloudflare.com/client/v4/zones?name=gh555.com",
                       headers=headers, timeout=10)
            zone_id = r.json()["result"][0]["id"]
            self.append_log(f"Zone ID: {zone_id}")

            # Purge
            urls = [f"{BASE_URL}/gaea/d/qqq/{f}" for f in HOT_FILES]
            r2 = rq.post(
                f"https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache",
                headers=headers, json={"files": urls}, timeout=10)
            data = r2.json()
            if data.get("success"):
                self.append_log(f"✅ Purged {len(urls)} URLs")
            else:
                self.append_log(f"❌ Purge 失败: {data.get('errors')}")
        except Exception as e:
            self.append_log(f"❌ CF Purge 异常: {e}")


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    w = GhqqqWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

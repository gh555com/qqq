# -*- coding: utf-8 -*-
"""
qide.py — qqq IDE 项目控制台
一站式：bundle ai / 编译 IDE / 出 portable 包 / dev 启动 / git commit+push / 清理 / 修复

风格仿 e:/s/wol/py/gaea/cf/ky.py 但更轻量，单文件即跑。
依赖：PySide6（已装在 E:/s/d/python3810）。
"""
import sys
import os
import subprocess
import shutil
import time
from pathlib import Path
from datetime import datetime

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QPlainTextEdit, QLabel, QGroupBox, QGridLayout,
    QStatusBar, QMessageBox
)
from PySide6.QtCore import Qt, QThread, Signal, QTimer
from PySide6.QtGui import QFont, QTextCursor, QColor, QPalette

# ===================== 路径常量（项目铁律） =====================
Q3      = Path("E:/s/wol/py/q3")
AI_DIR  = Q3 / "ai"
IDE_SRC = Path("E:/s/wol/py/qqq-ide-src")
IDE_EXT = IDE_SRC / "extensions" / "qqq-ai"
OUT_DIR = Path("E:/s/wol/py/VSCode-win32-x64")
QQQ_EXE = OUT_DIR / "qqq.exe"
MODULES = Path("E:/s/wol/py/qqq-modules")  # gaea 模块开发根
F_M_DIR = OUT_DIR / "f" / "m"                # 运行时 gaea 模块目录

GIT_BASH    = r"E:\s\d\git\bin\bash.exe"
ACTIVATE    = r"E:\s\d\activate.cmd"
VCVARS      = r"E:\s\d\vcvars_portable.cmd"
NODE_GYP_C  = Path("E:/s/d/.node-gyp-cache")
PYTHON_EXE  = r"E:\s\d\python3810\python.exe"

# 节点环境组合命令（call activate + vcvars + 实际命令）
def env_cmd(cmd: str) -> str:
    return f'call "{ACTIVATE}" && call "{VCVARS}" && set NODE_OPTIONS=--max_old_space_size=8192 && {cmd}'


# 把命令落地到 .bat 文件再让 cmd /c 执行，避免 subprocess 多层 shell 引号转义吞掉 "…\…"
import tempfile
def _write_bat(cmd: str) -> str:
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.bat', delete=False, encoding='gbk', errors='replace')
    f.write('@echo off\r\nchcp 65001 >nul\r\n')
    f.write(cmd + '\r\n')
    f.write('exit /b %ERRORLEVEL%\r\n')
    f.close()
    return f.name


# ===================== 工作线程：流式跑 shell 命令 =====================
class CmdWorker(QThread):
    line_ready = Signal(str)
    finished_ok = Signal(int, float)  # exit_code, seconds

    def __init__(self, cmd: str, cwd: Path = None, shell="cmd", parent=None):
        super().__init__(parent)
        self.cmd = cmd
        self.cwd = str(cwd) if cwd else None
        self.shell = shell  # "cmd" or "bash"
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
                # qqq: 写到临时 .bat 让 cmd /c 直接 call 文件，避免 "…\…" 引号被多层 shell 吞掉
                bat_file = _write_bat(self.cmd)
                args = ["cmd.exe", "/c", bat_file]
            self.line_ready.emit(f"[CMD] {self.cmd}")
            if self.cwd:
                self.line_ready.emit(f"[CWD] {self.cwd}")
            self._proc = subprocess.Popen(
                args,
                cwd=self.cwd,
                stdin=subprocess.DEVNULL,  # qqq: 修 EBADF (yarn watch stdin 报错)
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


# ===================== 主窗口 =====================
class QideWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("qide — qqq IDE 控制台")
        self.resize(1200, 800)
        self.worker: CmdWorker = None

        self._build_ui()
        self._apply_dark_theme()

        # 1 秒一次刷新顶部状态
        self.status_timer = QTimer(self)
        self.status_timer.timeout.connect(self.refresh_status)
        self.status_timer.start(1500)
        self.refresh_status()

    # --------- UI 构造 ---------
    def _build_ui(self):
        central = QWidget()
        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)

        # ---- 顶部状态条 ----
        self.lbl_status = QLabel("loading…")
        self.lbl_status.setStyleSheet("padding:6px;background:#222;color:#9cdcfe;border-radius:4px;font-family:Consolas;")
        root.addWidget(self.lbl_status)

        # ---- 按钮区（grid + groups） ----
        btn_row = QHBoxLayout()
        root.addLayout(btn_row)

        btn_row.addWidget(self._group_ai())
        btn_row.addWidget(self._group_gaea())
        btn_row.addWidget(self._group_build())
        btn_row.addWidget(self._group_run())
        btn_row.addWidget(self._group_git())
        btn_row.addWidget(self._group_misc())

        # ---- 日志区 ----
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setFont(QFont("Consolas", 10))
        self.log.setStyleSheet("background:#1e1e1e;color:#d4d4d4;")
        root.addWidget(self.log, 1)

        # ---- 底部操作栏 ----
        bot = QHBoxLayout()
        self.btn_stop = QPushButton("⛔ 中止当前任务")
        self.btn_stop.clicked.connect(self.stop_current)
        self.btn_clear = QPushButton("🧹 清空日志")
        self.btn_clear.clicked.connect(lambda: self.log.clear())
        bot.addWidget(self.btn_stop)
        bot.addWidget(self.btn_clear)
        bot.addStretch()
        root.addLayout(bot)

        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar())

    def _make_btn(self, text: str, slot, tip: str = "") -> QPushButton:
        b = QPushButton(text)
        b.clicked.connect(slot)
        if tip:
            b.setToolTip(tip)
        b.setMinimumHeight(34)
        return b

    def _group_ai(self) -> QGroupBox:
        g = QGroupBox("① AI 扩展")
        v = QVBoxLayout(g)
        v.addWidget(self._make_btn("🔨 Bundle ai (esbuild)",
                                   self.act_bundle_ai,
                                   "node esbuild.config.js — 把 ai/src/* 打成 ai/dist/extension.js"))
        v.addWidget(self._make_btn("📤 Sync ai → IDE 扩展目录",
                                   self.act_sync_ai_to_ide,
                                   "把 ai/dist/* 复制到 qqq-ide-src/extensions/qqq-ai/dist/"))
        v.addWidget(self._make_btn("⚡ Bundle + Sync (一键)",
                                   self.act_bundle_and_sync,
                                   "前两步连起来"))
        v.addStretch()
        return g

    def _group_gaea(self) -> QGroupBox:
        g = QGroupBox("② Gaea 模块")
        v = QVBoxLayout(g)
        v.addWidget(self._make_btn("🔨 Bundle ai (gaea)",
                                   self.act_gaea_bundle_ai,
                                   "esbuild qqq-modules/ai → dist/bundle.js"))
        v.addWidget(self._make_btn("🔨 Bundle core (gaea)",
                                   self.act_gaea_bundle_core,
                                   "esbuild qqq-modules/core → dist/bundle.js"))
        v.addWidget(self._make_btn("📤 Sync → f/m/",
                                   self.act_gaea_sync,
                                   "复制 bundle + gaea.json 到 portable f/m/ 目录"))
        v.addWidget(self._make_btn("⚡ Bundle All + Sync",
                                   self.act_gaea_bundle_all,
                                   "两个模块 bundle + sync 全流程"))
        v.addStretch()
        return g

    def _group_build(self) -> QGroupBox:
        g = QGroupBox("③ IDE 构建")
        v = QVBoxLayout(g)
        v.addWidget(self._make_btn("⚙️ yarn install",
                                   self.act_yarn_install,
                                   "首次或 deps 变更时跑（带 VS2017 + node-gyp 缓存）"))
        v.addWidget(self._make_btn("🔧 yarn compile (dev)",
                                   self.act_yarn_compile,
                                   "增量编译 src/ → out/  (~3 分钟)"))
        v.addWidget(self._make_btn("👀 yarn watch (后台)",
                                   self.act_yarn_watch,
                                   "后台监听 src/ 变化自动重编（开发用）"))
        v.addWidget(self._make_btn("📤 增量同步 out/ → portable",
                                   self.act_sync_out_to_portable,
                                   "拷 out/* 到 VSCode-win32-x64/resources/app/out/（秒级，开发循环用）"))
        v.addWidget(self._make_btn("⚡ yarn compile + 同步 (一键)",
                                   self.act_compile_and_sync,
                                   "先 yarn compile (~3min) 再拷 out/→portable"))
        v.addWidget(self._make_btn("📦 出 portable 包 (11 分钟)",
                                   self.act_gulp_min,
                                   "yarn gulp vscode-win32-x64-min — 完整发布包"))
        v.addStretch()
        return g

    def _group_run(self) -> QGroupBox:
        g = QGroupBox("④ 运行 / 预览")
        v = QVBoxLayout(g)
        v.addWidget(self._make_btn("▶️ scripts/code.bat (dev)",
                                   self.act_dev_launch,
                                   "直跑源码不打包（改完 watch 完 Ctrl+R 重载）"))
        v.addWidget(self._make_btn("🚀 启动 portable qqq.exe",
                                   self.act_portable_launch,
                                   f"双击 {QQQ_EXE}"))
        v.addWidget(self._make_btn("📁 打开 portable 目录",
                                   lambda: self.open_path(OUT_DIR)))
        v.addWidget(self._make_btn("🩺 检查 portable 产出",
                                   self.act_check_portable))
        v.addStretch()
        return g

    def _group_git(self) -> QGroupBox:
        g = QGroupBox("⑤ Git 提交")
        v = QVBoxLayout(g)
        v.addWidget(self._make_btn("💾 commit + push q3",
                                   self.act_commit_q3,
                                   "时间戳 message 一键提交+推送 origin/qq"))
        v.addWidget(self._make_btn("💾 commit + push qqq-ide-src",
                                   self.act_commit_ide,
                                   "时间戳 message 一键提交+推送 origin/qqq-main"))
        v.addWidget(self._make_btn("🔄 双仓 commit + push",
                                   self.act_commit_both,
                                   "上面两个连起来"))
        v.addWidget(self._make_btn("📊 双仓 git status",
                                   self.act_status_both))
        v.addStretch()
        return g

    def _group_misc(self) -> QGroupBox:
        g = QGroupBox("⑥ 维护 / 应急")
        v = QVBoxLayout(g)
        v.addWidget(self._make_btn("🛑 kill 所有 node/cl/link",
                                   self.act_kill_build_proc))
        v.addWidget(self._make_btn("🩻 修 node-gyp cache",
                                   self.act_fix_node_gyp))
        v.addWidget(self._make_btn("🗑️ 清 .build / VSCode-win32-x64",
                                   self.act_clean_build))
        v.addWidget(self._make_btn("📂 打开 ai/",
                                   lambda: self.open_path(AI_DIR)))
        v.addWidget(self._make_btn("📂 打开 qqq-ide-src/",
                                   lambda: self.open_path(IDE_SRC)))
        v.addStretch()
        return g

    def _apply_dark_theme(self):
        self.setStyleSheet("""
            QMainWindow { background: #2d2d30; }
            QGroupBox { color: #d4d4d4; border: 1px solid #3e3e42; border-radius: 4px;
                        margin-top: 14px; padding: 6px; font-weight: bold; }
            QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: #9cdcfe; }
            QPushButton { background: #3c3c3c; color: #d4d4d4; border: 1px solid #555; border-radius: 3px;
                          padding: 4px 6px; text-align: left; }
            QPushButton:hover { background: #4a4a4f; border-color: #007acc; }
            QPushButton:pressed { background: #007acc; }
            QLabel { color: #d4d4d4; }
        """)

    # --------- 公共：执行命令 ---------
    def run_cmd(self, cmd: str, cwd: Path = None, shell="cmd", banner: str = ""):
        if self.worker and self.worker.isRunning():
            self.append_log(f"⚠️ 已有任务运行中，先点中止再来。\n")
            return
        if banner:
            self.append_log(f"\n========== {banner} ==========")
        self.worker = CmdWorker(cmd, cwd, shell)
        self.worker.line_ready.connect(self.append_log)
        self.worker.finished_ok.connect(self.on_cmd_done)
        self.worker.start()

    def append_log(self, line: str):
        self.log.appendPlainText(line)
        self.log.moveCursor(QTextCursor.End)

    def on_cmd_done(self, code: int, secs: float):
        flag = "✅ OK" if code == 0 else f"❌ FAIL ({code})"
        self.append_log(f"[DONE {flag}] elapsed {secs:.1f}s\n")

    def stop_current(self):
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.append_log("🛑 stop signal 已发，请等进程退出…")

    def open_path(self, p: Path):
        if not p.exists():
            self.append_log(f"⚠️ 路径不存在：{p}")
            return
        os.startfile(str(p))

    # --------- 顶部状态刷新 ---------
    def refresh_status(self):
        try:
            br_q3 = self._git_branch(Q3) or "—"
            br_ide = self._git_branch(IDE_SRC) or "—"
            dirty_q3 = self._git_dirty(Q3)
            dirty_ide = self._git_dirty(IDE_SRC)
            ai_size = self._size_kb(AI_DIR / "dist" / "extension.js")
            ext_size = self._size_kb(IDE_EXT / "dist" / "extension.js")
            sync_ok = "✅" if (ai_size and ext_size and ai_size == ext_size) else "❌"
            qqq_ok = "✅" if QQQ_EXE.exists() else "—"
            f_dir = "✅" if (OUT_DIR / "f").exists() else "—"

            running = "▶ running" if (self.worker and self.worker.isRunning()) else "idle"

            txt = (f" q3:[{br_q3}{'*' if dirty_q3 else ''}]   "
                   f"qqq-ide-src:[{br_ide}{'*' if dirty_ide else ''}]   "
                   f"ai bundle:{ai_size or '—'}KB   "
                   f"sync→IDE:{sync_ok}   "
                   f"portable qqq.exe:{qqq_ok}   "
                   f"f/ 目录:{f_dir}   "
                   f"|  worker: {running}")
            self.lbl_status.setText(txt)
        except Exception as e:
            self.lbl_status.setText(f"status err: {e}")

    @staticmethod
    def _git_branch(repo: Path):
        try:
            r = subprocess.run(["git", "-C", str(repo), "rev-parse", "--abbrev-ref", "HEAD"],
                               capture_output=True, text=True, timeout=2)
            return r.stdout.strip() if r.returncode == 0 else None
        except Exception:
            return None

    @staticmethod
    def _git_dirty(repo: Path) -> bool:
        try:
            r = subprocess.run(["git", "-C", str(repo), "status", "--porcelain"],
                               capture_output=True, text=True, timeout=2)
            return bool(r.stdout.strip())
        except Exception:
            return False

    @staticmethod
    def _size_kb(p: Path):
        try:
            return p.stat().st_size // 1024 if p.exists() else None
        except Exception:
            return None

    # ============== 各按钮动作 ==============
    # ② Gaea 模块
    def act_gaea_bundle_ai(self):
        self.run_cmd("node esbuild.config.js", MODULES / "ai", banner="Gaea Bundle: ai")

    def act_gaea_bundle_core(self):
        self.run_cmd("node esbuild.config.js", MODULES / "core", banner="Gaea Bundle: core")

    def act_gaea_sync(self):
        try:
            for mod in ("ai", "core"):
                src_dist = MODULES / mod / "dist"
                dst_root = F_M_DIR / mod
                dst_dist = dst_root / "dist"        # 保留 dist/ 子目录, 匹配 gaea.json 的 entry: "dist/bundle.js"
                dst_dist.mkdir(parents=True, exist_ok=True)
                # 复制 dist/* → f/m/{mod}/dist/*
                if src_dist.exists():
                    for fn in src_dist.iterdir():
                        if fn.is_file():
                            shutil.copy2(fn, dst_dist / fn.name)
                            self.append_log(f"📤 {fn} → {dst_dist / fn.name}")
                # gaea.json 在模块根, 不在 dist/ 内
                gj = MODULES / mod / "gaea.json"
                if gj.exists():
                    shutil.copy2(gj, dst_root / "gaea.json")
                    self.append_log(f"📤 {gj} → {dst_root / 'gaea.json'}")
            self.append_log("[DONE ✅] gaea sync → f/m/ 完成\n")
        except Exception as e:
            self.append_log(f"❌ gaea sync 失败：{e}")

    def act_gaea_bundle_all(self):
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 任务进行中"); return
        self.append_log("\n========== Gaea Bundle All + Sync ===========")
        self.worker = CmdWorker("node esbuild.config.js", MODULES / "ai")
        self.worker.line_ready.connect(self.append_log)

        def after_ai(code, secs):
            self.append_log(f"[ai bundle {code=} {secs:.1f}s]")
            if code != 0:
                self.append_log("❌ ai bundle 失败"); return
            # chain → core bundle
            self.worker = CmdWorker("node esbuild.config.js", MODULES / "core")
            self.worker.line_ready.connect(self.append_log)

            def after_core(code2, secs2):
                self.append_log(f"[core bundle {code2=} {secs2:.1f}s]")
                if code2 == 0:
                    self.act_gaea_sync()
                else:
                    self.append_log("❌ core bundle 失败")
            self.worker.finished_ok.connect(after_core)
            self.worker.start()

        self.worker.finished_ok.connect(after_ai)
        self.worker.start()

    # ① AI (legacy extension)
    def act_bundle_ai(self):
        self.run_cmd("node esbuild.config.js", AI_DIR, banner="Bundle ai (esbuild)")

    def act_sync_ai_to_ide(self):
        try:
            target = IDE_EXT / "dist"
            target.mkdir(parents=True, exist_ok=True)
            for fn in ("extension.js", "chat.html"):
                src = AI_DIR / "dist" / fn
                dst = target / fn
                if src.exists():
                    shutil.copy2(src, dst)
                    self.append_log(f"📤 {src} → {dst}")
            # package.json + res/icon.png 也同步（首次）
            for relpath in ("package.json", "res/icon.png"):
                src = AI_DIR / relpath
                dst = IDE_EXT / relpath
                if src.exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
                    self.append_log(f"📤 {src} → {dst}")
            self.append_log("[DONE ✅] sync 完成\n")
        except Exception as e:
            self.append_log(f"❌ sync 失败：{e}")

    def act_bundle_and_sync(self):
        # 跑完 esbuild 再 sync。用 finished signal chain
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 任务进行中"); return
        self.append_log("\n========== Bundle + Sync (chain) ==========")
        self.worker = CmdWorker("node esbuild.config.js", AI_DIR)
        self.worker.line_ready.connect(self.append_log)

        def after(code, secs):
            self.append_log(f"[bundle DONE code={code} {secs:.1f}s]")
            if code == 0:
                self.act_sync_ai_to_ide()
            else:
                self.append_log("❌ bundle 失败，跳过 sync")
        self.worker.finished_ok.connect(after)
        self.worker.start()

    # ② IDE 构建
    def act_yarn_install(self):
        self.run_cmd(env_cmd("yarn --frozen-lockfile --network-timeout 600000"),
                     IDE_SRC, banner="yarn install")

    def act_yarn_compile(self):
        self.run_cmd(env_cmd("yarn compile"), IDE_SRC, banner="yarn compile")

    def act_yarn_watch(self):
        self.run_cmd(env_cmd("yarn watch"), IDE_SRC, banner="yarn watch (background, Ctrl+C 止)")

    def act_gulp_min(self):
        # 编译完后自动重建 f/ 目录 + 同步 gaea 模块
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 任务进行中"); return
        self.append_log("\n========== yarn gulp vscode-win32-x64-min (~11 min) ==========")
        cmd = env_cmd("yarn gulp vscode-win32-x64-min")
        self.worker = CmdWorker(cmd, IDE_SRC)
        self.worker.line_ready.connect(self.append_log)

        def after_build(code, secs):
            self.append_log(f"[build DONE code={code} {secs:.1f}s]")
            if code == 0:
                # 编译成功后自动重建 f/ 目录（被 gulp 覆盖了）
                try:
                    F_M_DIR.mkdir(parents=True, exist_ok=True)
                    self.append_log(f"✅ 重建 {F_M_DIR}")
                except Exception as e:
                    self.append_log(f"❌ 重建 f/m/ 失败：{e}")
                # 自动同步 gaea 模块
                self.act_gaea_sync()
            else:
                self.append_log("❌ 编译失败")
        self.worker.finished_ok.connect(after_build)
        self.worker.start()

    def act_sync_out_to_portable(self):
        """拷 qqq-ide-src/out/* → VSCode-win32-x64/resources/app/out/* 实现开发期秒级热更"""
        try:
            src = IDE_SRC / "out"
            dst = OUT_DIR / "resources" / "app" / "out"
            if not src.exists():
                self.append_log(f"❌ {src} 不存在，先 yarn compile"); return
            if not dst.parent.exists():
                self.append_log(f"❌ {dst.parent} 不存在，先出过一次 portable 包"); return
            self.append_log(f"\n========== 增量同步 {src} → {dst} ==========")
            t0 = time.time()
            # robocopy /MIR 严重，改用 /E /XO（只拷新文件、不删目标多余物）；/NFL /NDL 静默
            cmd = f'robocopy "{src}" "{dst}" /E /XO /NFL /NDL /NJH /NJS /NP /R:1 /W:1'
            r = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='gbk', errors='replace')
            # robocopy 退出码 0~7 都是成功 (0=无变动 1=拷了 2=多余 3=1+2 …)
            ok = r.returncode <= 7
            dt = time.time() - t0
            for line in (r.stdout or '').splitlines():
                if line.strip(): self.append_log(line)
            self.append_log(f"[DONE {'✅' if ok else '❌'}] robocopy rc={r.returncode} elapsed {dt:.1f}s\n")
        except Exception as e:
            self.append_log(f"❌ 同步失败：{e}")

    def act_compile_and_sync(self):
        """yarn compile 成功后自动 robocopy out/→portable"""
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 任务进行中"); return
        self.append_log("\n========== yarn compile + 增量同步 ==========")
        self.worker = CmdWorker(env_cmd("yarn compile"), IDE_SRC)
        self.worker.line_ready.connect(self.append_log)

        def after(code, secs):
            self.append_log(f"[compile DONE code={code} {secs:.1f}s]")
            if code == 0:
                self.act_sync_out_to_portable()
            else:
                self.append_log("❌ compile 失败，跳过同步")
        self.worker.finished_ok.connect(after)
        self.worker.start()

    # ③ 运行
    def act_dev_launch(self):
        bat = IDE_SRC / "scripts" / "code.bat"
        if not bat.exists():
            self.append_log(f"❌ {bat} 不存在")
            return
        # 不阻塞 UI，子进程独立窗口
        subprocess.Popen([str(bat)], cwd=str(IDE_SRC),
                         creationflags=subprocess.CREATE_NEW_CONSOLE)
        self.append_log(f"▶️ 已启动 {bat}（独立控制台窗口）")

    def act_portable_launch(self):
        if not QQQ_EXE.exists():
            self.append_log(f"❌ {QQQ_EXE} 不存在，先出 portable 包")
            return
        # ShellExecuteW: 明确指定工作目录 + SW_SHOWNORMAL
        # os.startfile 不能设 CWD，Electron 可能因 CWD 不对而崩
        import ctypes
        ret = ctypes.windll.shell32.ShellExecuteW(
            None, "open", str(QQQ_EXE), None, str(QQQ_EXE.parent), 1  # SW_SHOWNORMAL=1
        )
        if ret > 32:
            self.append_log(f"🚀 启动 {QQQ_EXE}")
        else:
            self.append_log(f"❌ ShellExecuteW 返回 {ret}，启动失败")

    def act_check_portable(self):
        items = [
            ("qqq.exe", QQQ_EXE),
            ("resources/app/", OUT_DIR / "resources" / "app"),
            ("resources/app/extensions/qqq-ai", OUT_DIR / "resources" / "app" / "extensions" / "qqq-ai"),
            ("resources/app/product.json", OUT_DIR / "resources" / "app" / "product.json"),
            ("f/ (portable trigger)", OUT_DIR / "f"),
        ]
        self.append_log("\n========== Portable 产出体检 ==========")
        for label, p in items:
            tag = "✅" if p.exists() else "❌"
            sz = ""
            if p.exists() and p.is_file():
                sz = f" ({p.stat().st_size // 1024}KB)"
            self.append_log(f"  {tag} {label}{sz}  → {p}")
        # product.json 关键字段
        prod = OUT_DIR / "resources" / "app" / "product.json"
        if prod.exists():
            try:
                import json
                d = json.loads(prod.read_text(encoding="utf-8"))
                self.append_log(f"  ▸ portable={d.get('portable')!r}  "
                                f"applicationName={d.get('applicationName')!r}  "
                                f"nameLong={d.get('nameLong')!r}")
            except Exception as e:
                self.append_log(f"  product.json 解析失败：{e}")
        self.append_log("")

    # ④ Git
    def act_commit_q3(self):
        self._git_commit_push(Q3, "qq", "q3")

    def act_commit_ide(self):
        self._git_commit_push(IDE_SRC, "qqq-main", "qqq-ide-src")

    def act_commit_both(self):
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 任务进行中"); return
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        msg = f"qide snapshot {ts}"
        cmd = (f'cd /d "{Q3}" && git add -A && git commit --no-verify -m "{msg}" ; git push origin qq && '
               f'cd /d "{IDE_SRC}" && git add -A && git commit --no-verify -m "{msg}" ; git push origin qqq-main')
        self.run_cmd(cmd, banner=f"双仓 commit+push ({ts})")

    def _git_commit_push(self, repo: Path, branch: str, label: str):
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 任务进行中"); return
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        msg = f"qide snapshot {ts}"
        cmd = f'git add -A && git commit --no-verify -m "{msg}" ; git push origin {branch}'
        self.run_cmd(cmd, repo, banner=f"{label} commit+push → {branch}")

    def act_status_both(self):
        if self.worker and self.worker.isRunning():
            self.append_log("⚠️ 任务进行中"); return
        cmd = (f'cd /d "{Q3}" && echo === q3 === && git status -s && git log --oneline -3 && '
               f'cd /d "{IDE_SRC}" && echo === qqq-ide-src === && git status -s && git log --oneline -3')
        self.run_cmd(cmd, banner="双仓 git status")

    # ⑤ 维护
    def act_kill_build_proc(self):
        cmd = ("taskkill /F /IM node.exe /T 2>nul & "
               "taskkill /F /IM cl.exe /T 2>nul & "
               "taskkill /F /IM link.exe /T 2>nul & "
               "echo done")
        self.run_cmd(cmd, banner="kill node/cl/link")

    def act_fix_node_gyp(self):
        ans = QMessageBox.question(self, "确认",
                                   f"将删除 {NODE_GYP_C} 并重新预热（~30 秒）。继续？",
                                   QMessageBox.Yes | QMessageBox.No)
        if ans != QMessageBox.Yes:
            return
        try:
            if NODE_GYP_C.exists():
                shutil.rmtree(NODE_GYP_C, ignore_errors=True)
                self.append_log(f"🗑️ 删 {NODE_GYP_C}")
            NODE_GYP_C.mkdir(parents=True, exist_ok=True)
            cmd = env_cmd(f'set npm_config_devdir={NODE_GYP_C} && node-gyp install 16.14.2')
            self.run_cmd(cmd, IDE_SRC, banner="node-gyp install 16.14.2 (预热)")
        except Exception as e:
            self.append_log(f"❌ {e}")

    def act_clean_build(self):
        ans = QMessageBox.question(self, "确认",
                                   f"将删除：\n  {OUT_DIR}\n  {IDE_SRC}/.build\n  {IDE_SRC}/out\n继续？",
                                   QMessageBox.Yes | QMessageBox.No)
        if ans != QMessageBox.Yes:
            return
        for p in (OUT_DIR, IDE_SRC / ".build", IDE_SRC / "out"):
            if p.exists():
                self.append_log(f"🗑️ 删 {p} …")
                shutil.rmtree(p, ignore_errors=True)
                self.append_log(f"   ✅ 清完")
        self.append_log("[DONE]\n")


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    w = QideWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

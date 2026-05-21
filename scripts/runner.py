#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qqq runner.py — 反卡死任务执行器（ghrun spawn 的 Python 兜底）

对齐文档：
  ignore/qqq 拓扑/arc/铁律 §12              进程执行铁律（硬约束）
  ignore/qqq 拓扑/arc/我们到底要做什吗 §2.5  ghrun spawn 设计动机
  ignore/qqq 拓扑/arc/spawn-protocol         协议字段唯一真理源（机器可校验）
  schema/spawn-protocol.schema.json          JSON Schema（draft 2020-12）

定位：
  ghrun.exe 未就绪期间（开发期 / CI / 本地构建），所有外部进程调用经此脚本启动，
  从 OS 底层避免被任何子进程卡死。与 ghrun spawn 同协议，未来 ghrun 上线后扩展
  调用点零改动切换。

CLI（与 ghrun spawn 同协议）：
  python runner.py spawn  --task <id> [--deadline 600] [--stall 30] [--log <path>]
                          [--cwd <dir>] [--env KEY=VAL ...] [--shell] -- <cmd> [args...]
  python runner.py kill   <task_id>
  python runner.py list
  python runner.py reap                   # 扫 lock 清孤儿

退出码：
  0    子进程正常退出 0
  1..N 子进程退出码 N
  124  deadline 绝对超时
  125  output-stall 卡死（日志 mtime > stall 秒无变化）
  130  收到 Ctrl+C / SIGINT
  201  启动失败（命令不存在 / cwd 错误 / 参数错误）

输出：
  stdout 最末一行打印 JSON 摘要：
    {"task_id","pid","status","exit_code","reason","duration_ms","log","lock"}
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

IS_WIN = sys.platform.startswith("win")
IS_POSIX = not IS_WIN

# ─────────────────────────────────────────────────────────────────────────
# QDIR 协议路径解析（→「做什吗」§3）
# ─────────────────────────────────────────────────────────────────────────

def _qdir_tmp() -> Path:
    p = os.environ.get("QDIR_TMP")
    if p:
        return Path(p)
    qdir = os.environ.get("QDIR")
    if qdir:
        return Path(qdir) / "f" / "tmp"
    return Path(tempfile.gettempdir()) / "qqq-spawn"

def _qdir_logs() -> Path:
    p = os.environ.get("QDIR_LOGS")
    if p:
        return Path(p)
    qdir = os.environ.get("QDIR")
    if qdir:
        return Path(qdir) / "f" / "logs"
    return Path(tempfile.gettempdir()) / "qqq-spawn" / "logs"

def _lock_dir() -> Path:
    d = _qdir_tmp() / "spawn-locks"
    d.mkdir(parents=True, exist_ok=True)
    return d

def _lock_path(task_id: str) -> Path:
    return _lock_dir() / f"spawn-{task_id}.lock"

def _write_lock(task_id: str, info: dict) -> Path:
    p = _lock_path(task_id)
    tmp = p.with_suffix(".lock.tmp")
    tmp.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(str(tmp), str(p))
    return p

def _clear_lock(task_id: str) -> None:
    p = _lock_path(task_id)
    try:
        p.unlink()
    except FileNotFoundError:
        pass

def _read_lock(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None

def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if IS_WIN:
        try:
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            h = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid
            )
            if not h:
                return False
            code = ctypes.c_ulong(0)
            ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(h)
            return code.value == STILL_ACTIVE
        except Exception:
            return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError as e:
            return e.errno == errno.EPERM

# ─────────────────────────────────────────────────────────────────────────
# Windows Job Object 集成（pywin32 优先，ctypes fallback）
# ─────────────────────────────────────────────────────────────────────────

class _WinJob:
    """
    Windows Job Object 封装。
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：本对象引用计数为 0 时整树灭。
    JOB_OBJECT_LIMIT_BREAKAWAY_OK：允许子进程显式 breakaway（一般不需要）。
    """
    def __init__(self, deadline_sec: int | None, mem_mb: int | None):
        self.handle = None
        self.kernel32 = None
        self._build(deadline_sec, mem_mb)

    def _build(self, deadline_sec, mem_mb):
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel32 = k32
        h = k32.CreateJobObjectW(None, None)
        if not h:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        self.handle = h

        # 配置 ExtendedLimitInformation
        JobObjectExtendedLimitInformation = 9
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
        JOB_OBJECT_LIMIT_PROCESS_TIME = 0x00000002
        JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [("ReadOperationCount", ctypes.c_ulonglong),
                        ("WriteOperationCount", ctypes.c_ulonglong),
                        ("OtherOperationCount", ctypes.c_ulonglong),
                        ("ReadTransferCount", ctypes.c_ulonglong),
                        ("WriteTransferCount", ctypes.c_ulonglong),
                        ("OtherTransferCount", ctypes.c_ulonglong)]

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                        ("PerJobUserTimeLimit", ctypes.c_longlong),
                        ("LimitFlags", wintypes.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t),
                        ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                        ("IoInfo", IO_COUNTERS),
                        ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        if deadline_sec and deadline_sec > 0:
            info.BasicLimitInformation.PerJobUserTimeLimit = int(deadline_sec) * 10_000_000
            flags |= JOB_OBJECT_LIMIT_PROCESS_TIME
        if mem_mb and mem_mb > 0:
            info.JobMemoryLimit = int(mem_mb) * 1024 * 1024
            flags |= JOB_OBJECT_LIMIT_JOB_MEMORY
        info.BasicLimitInformation.LimitFlags = flags

        ok = k32.SetInformationJobObject(
            h, JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info)
        )
        if not ok:
            err = ctypes.get_last_error()
            self.close()
            raise OSError(err, "SetInformationJobObject failed")

    def attach(self, pid: int) -> None:
        import ctypes
        PROCESS_TERMINATE = 0x0001
        PROCESS_SET_QUOTA = 0x0100
        h = self.kernel32.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, False, pid)
        if not h:
            raise OSError(ctypes.get_last_error(), f"OpenProcess pid={pid} failed")
        try:
            ok = self.kernel32.AssignProcessToJobObject(self.handle, h)
            if not ok:
                raise OSError(ctypes.get_last_error(),
                              f"AssignProcessToJobObject pid={pid} failed")
        finally:
            self.kernel32.CloseHandle(h)

    def terminate(self, exit_code: int = 1) -> None:
        if self.handle:
            self.kernel32.TerminateJobObject(self.handle, exit_code)

    def close(self) -> None:
        if self.handle and self.kernel32:
            self.kernel32.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

# ─────────────────────────────────────────────────────────────────────────
# 看门狗
# ─────────────────────────────────────────────────────────────────────────

class _Watchdog:
    """
    deadline + output-stall 双看门狗。任一触发即调 on_kill(reason)。
    """
    def __init__(self, deadline_sec: int, stall_sec: int,
                 log_path: Path, on_kill):
        self.deadline = deadline_sec
        self.stall = stall_sec
        self.log_path = log_path
        self.on_kill = on_kill
        self.start_at = time.monotonic()
        self.fired = False
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._th = threading.Thread(target=self._loop, daemon=True)

    def start(self):
        self._th.start()

    def stop(self):
        self._stop.set()

    def _fire(self, reason: str):
        with self._lock:
            if self.fired:
                return
            self.fired = True
        try:
            self.on_kill(reason)
        except Exception:
            pass

    def _loop(self):
        last_mtime = self._mtime()
        last_change = time.monotonic()
        while not self._stop.is_set():
            now = time.monotonic()
            if self.deadline > 0 and (now - self.start_at) > self.deadline:
                self._fire("deadline")
                return
            mt = self._mtime()
            if mt != last_mtime:
                last_mtime = mt
                last_change = now
            elif self.stall > 0 and (now - last_change) > self.stall:
                self._fire("stall")
                return
            self._stop.wait(1.0)

    def _mtime(self) -> float:
        try:
            return self.log_path.stat().st_mtime
        except FileNotFoundError:
            return 0.0
        except Exception:
            return 0.0

# ─────────────────────────────────────────────────────────────────────────
# spawn 主流程
# ─────────────────────────────────────────────────────────────────────────

def _open_log(log_path: Path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # 二进制追加，避免编码问题
    return open(log_path, "ab", buffering=0)

def _build_env(extra_env: list[str]) -> dict:
    env = os.environ.copy()
    for kv in extra_env or []:
        if "=" not in kv:
            continue
        k, v = kv.split("=", 1)
        env[k] = v
    return env

def _do_spawn(args) -> int:
    task_id = args.task
    deadline = max(0, int(args.deadline))
    stall = max(0, int(args.stall))
    cmd = list(args.cmd or [])
    if not cmd:
        _emit_brief(task_id, 0, "error", 201, "no_cmd", 0, None, None)
        return 201

    log_path = Path(args.log) if args.log else (_qdir_logs() / f"spawn-{task_id}.log")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # 触碰一下，给 stall 看门狗一个初始 mtime
    log_path.touch(exist_ok=True)

    cwd = args.cwd or os.getcwd()
    env = _build_env(args.env)

    # 启动子进程 — Windows 用 Job Object，POSIX 用 setsid
    started_at = time.time()
    t0 = time.monotonic()
    proc = None
    job = None
    job_handle_repr = None
    creationflags = 0
    preexec = None

    if IS_WIN:
        # CREATE_NEW_PROCESS_GROUP 让 CTRL_BREAK 可定向投递。
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
        # CREATE_SUSPENDED + ResumeThread 路径这里暂不走（subprocess.Popen 不直接暴露）。
        # 现阶段采用 spawn 后立即 attach 路径，竞争窗口极小；
        # 后续如要彻底零窗口，改走 ctypes CreateProcessW 中间态启动。
    else:
        preexec = os.setsid

    log_fp = _open_log(log_path)

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            shell=bool(args.shell),
            creationflags=creationflags if IS_WIN else 0,
            preexec_fn=preexec if IS_POSIX else None,
            close_fds=True,
        )
    except FileNotFoundError as e:
        log_fp.close()
        msg = f"[runner] FileNotFoundError: {e}\n".encode("utf-8")
        with open(log_path, "ab") as f:
            f.write(msg)
        _emit_brief(task_id, 0, "error", 201, "spawn_fail", 0, str(log_path), None)
        return 201
    except Exception as e:
        log_fp.close()
        msg = f"[runner] spawn error: {e!r}\n".encode("utf-8")
        with open(log_path, "ab") as f:
            f.write(msg)
        _emit_brief(task_id, 0, "error", 201, "spawn_fail", 0, str(log_path), None)
        return 201

    pid = proc.pid

    # Windows: 立即 attach 到 Job Object
    if IS_WIN:
        try:
            job = _WinJob(deadline_sec=None, mem_mb=None)
            job.attach(pid)
            job_handle_repr = f"job#{job.handle}"
        except Exception as e:
            # Job 失败不阻断；记录 warn，仍走看门狗 + Popen.terminate
            with open(log_path, "ab") as f:
                f.write(f"[runner] WARN Job Object failed: {e!r}\n".encode("utf-8"))
            job = None

    # 写 lock
    lock_path = _write_lock(task_id, {
        "task_id": task_id,
        "pid": pid,
        "job_handle": job_handle_repr,
        "deadline": deadline,
        "stall": stall,
        "log_path": str(log_path),
        "started_at": started_at,
        "cmd": cmd,
        "cwd": cwd,
        "platform": sys.platform,
    })

    # 看门狗
    kill_reason = {"why": None}

    def _kill(reason: str):
        kill_reason["why"] = reason
        with open(log_path, "ab") as f:
            f.write(f"\n[runner] watchdog FIRE: {reason}\n".encode("utf-8"))
        # 1) 先尝试软杀
        try:
            if IS_WIN:
                try:
                    proc.send_signal(signal.CTRL_BREAK_EVENT)
                except Exception:
                    pass
            else:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGTERM)
                except Exception:
                    pass
        except Exception:
            pass
        # 2) 等 3 秒
        for _ in range(30):
            if proc.poll() is not None:
                return
            time.sleep(0.1)
        # 3) 强杀 — 整树灭
        try:
            if IS_WIN:
                if job:
                    job.terminate(1)
                else:
                    proc.kill()
            else:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except Exception:
                    proc.kill()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    wd = _Watchdog(deadline, stall, log_path, _kill) if (deadline or stall) else None
    if wd:
        wd.start()

    # 父进程 SIGINT → 整树灭
    def _on_sigint(signum, frame):
        kill_reason["why"] = kill_reason["why"] or "sigint"
        _kill("sigint")

    prev_sigint = signal.getsignal(signal.SIGINT)
    try:
        signal.signal(signal.SIGINT, _on_sigint)
    except Exception:
        pass

    # 等待结束
    exit_code = None
    try:
        exit_code = proc.wait()
    except KeyboardInterrupt:
        _kill("sigint")
        try:
            exit_code = proc.wait(timeout=5)
        except Exception:
            exit_code = 130
    finally:
        if wd:
            wd.stop()
        try:
            signal.signal(signal.SIGINT, prev_sigint)
        except Exception:
            pass
        try:
            log_fp.close()
        except Exception:
            pass
        if job:
            try:
                job.close()
            except Exception:
                pass
        _clear_lock(task_id)

    duration_ms = int((time.monotonic() - t0) * 1000)
    reason = kill_reason["why"] or ("exit" if exit_code == 0 else "exit_nonzero")
    if reason == "deadline":
        report_code = 124
    elif reason == "stall":
        report_code = 125
    elif reason == "sigint":
        report_code = 130
    else:
        report_code = exit_code if exit_code is not None else 1

    status = "ok" if report_code == 0 else "killed" if reason in ("deadline", "stall", "sigint") else "fail"
    _emit_brief(task_id, pid, status, report_code, reason, duration_ms, str(log_path), str(lock_path))
    return report_code

def _emit_brief(task_id, pid, status, exit_code, reason, duration_ms, log, lock):
    brief = {
        "task_id": task_id,
        "pid": pid,
        "status": status,
        "exit_code": exit_code,
        "reason": reason,
        "duration_ms": duration_ms,
        "log": log,
        "lock": lock,
    }
    sys.stdout.write(json.dumps(brief, ensure_ascii=False) + "\n")
    sys.stdout.flush()

# ─────────────────────────────────────────────────────────────────────────
# kill / list / reap
# ─────────────────────────────────────────────────────────────────────────

def _do_kill(args) -> int:
    task_id = args.task_id
    p = _lock_path(task_id)
    info = _read_lock(p)
    if not info:
        sys.stderr.write(f"[runner] no lock: {p}\n")
        return 2
    pid = int(info.get("pid", 0))
    if pid <= 0 or not _pid_alive(pid):
        _clear_lock(task_id)
        sys.stderr.write(f"[runner] pid {pid} not alive, lock cleared\n")
        return 0
    if IS_WIN:
        # 没有 Job 句柄回收路径（句柄随原 runner 进程消亡）；
        # 兜底用 taskkill /T 杀整棵子树。
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
            time.sleep(2)
            if _pid_alive(pid):
                os.killpg(os.getpgid(pid), signal.SIGKILL)
        except Exception as e:
            sys.stderr.write(f"[runner] killpg error: {e!r}\n")
            return 3
    _clear_lock(task_id)
    return 0

def _do_list(args) -> int:
    items = []
    for f in sorted(_lock_dir().glob("spawn-*.lock")):
        info = _read_lock(f) or {}
        pid = int(info.get("pid", 0))
        info["alive"] = _pid_alive(pid)
        info["lock"] = str(f)
        items.append(info)
    sys.stdout.write(json.dumps(items, ensure_ascii=False, indent=2) + "\n")
    return 0

def _do_reap(args) -> int:
    cleaned = 0
    for f in _lock_dir().glob("spawn-*.lock"):
        info = _read_lock(f) or {}
        pid = int(info.get("pid", 0))
        if not _pid_alive(pid):
            try:
                f.unlink()
                cleaned += 1
            except Exception:
                pass
    sys.stdout.write(json.dumps({"cleaned": cleaned}, ensure_ascii=False) + "\n")
    return 0

# ─────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="runner",
        description="qqq runner — 反卡死任务执行器（ghrun spawn 兜底）",
    )
    ops = ap.add_subparsers(dest="op", required=True)

    sp = ops.add_parser("spawn", help="启动一个受控子进程")
    sp.add_argument("--task", required=True, help="任务 id（lock 文件名用）")
    sp.add_argument("--deadline", type=int, default=600, help="绝对超时秒（默认 600）")
    sp.add_argument("--stall", type=int, default=30, help="日志静默卡死阈值秒（默认 30）")
    sp.add_argument("--log", default=None, help="日志路径（默认 QDIR_LOGS/spawn-<id>.log）")
    sp.add_argument("--cwd", default=None, help="工作目录（默认当前）")
    sp.add_argument("--env", action="append", default=[], help="额外环境变量 KEY=VAL，可多次")
    sp.add_argument("--shell", action="store_true", help="允许 shell 解析（一般不要开）")
    sp.add_argument("cmd", nargs=argparse.REMAINDER, help="-- 后跟命令及参数")

    kp = ops.add_parser("kill", help="按 task_id 终止")
    kp.add_argument("task_id")

    ops.add_parser("list", help="列出所有活动 lock")
    ops.add_parser("reap", help="清理 pid 已死的孤儿 lock")

    return ap

def _normalize_cmd(cmd: list[str]) -> list[str]:
    """REMAINDER 收到的第一个 token 若是 '--' 则去掉。"""
    if cmd and cmd[0] == "--":
        return cmd[1:]
    return cmd

def main(argv: list[str] | None = None) -> int:
    ap = _build_parser()
    ns = ap.parse_args(argv)
    if ns.op == "spawn":
        ns.cmd = _normalize_cmd(ns.cmd or [])
        return _do_spawn(ns)
    if ns.op == "kill":
        return _do_kill(ns)
    if ns.op == "list":
        return _do_list(ns)
    if ns.op == "reap":
        return _do_reap(ns)
    ap.print_help()
    return 2

if __name__ == "__main__":
    try:
        rc = main()
    except KeyboardInterrupt:
        rc = 130
    sys.exit(rc)

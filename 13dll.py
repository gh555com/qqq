# 13dll.py
# 直接在电脑上找你要的 13 个 DLL，按架构分拷贝到：
#   ./runtimes/x64/
#   ./runtimes/x86/
#
# 运行：
#   python 13dll.py
# 可选：只扫指定盘（更快）
#   python 13dll.py C:\ D:\

import os
import sys
import shutil
import struct
from pathlib import Path

MACHINE_X86 = 0x014C
MACHINE_X64 = 0x8664

# 你要的“最终 13 个”
TARGETS_X64 = [
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "concrt140.dll",
    "vccorlib140.dll",
]

TARGETS_X86 = [
    "vcruntime140.dll",
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "concrt140.dll",
    "vccorlib140.dll",
]

EXCLUDE_DIR_NAMES = {
    "System Volume Information",
    "$RECYCLE.BIN",
    "node_modules",
    ".git",
    ".svn",
}

def list_existing_drives():
    drives = []
    for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        d = f"{c}:\\"
        if os.path.exists(d):
            drives.append(d)
    return drives

def detect_pe_arch(path):
    """返回 'x64' / 'x86' / None"""
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
        if len(head) < 64:
            return None
        if head[0:2] != b"MZ":
            return None
        e_lfanew = struct.unpack_from("<I", head, 0x3C)[0]

        # PE 签名不在前 4096 就再读一次
        if e_lfanew + 6 > len(head):
            with open(path, "rb") as f:
                f.seek(e_lfanew)
                pe = f.read(8)
            if len(pe) < 8 or pe[0:4] != b"PE\x00\x00":
                return None
            machine = struct.unpack_from("<H", pe, 4)[0]
        else:
            if head[e_lfanew:e_lfanew+4] != b"PE\x00\x00":
                return None
            machine = struct.unpack_from("<H", head, e_lfanew + 4)[0]

        if machine == MACHINE_X64:
            return "x64"
        if machine == MACHINE_X86:
            return "x86"
        return None
    except Exception:
        return None

def win_path_score(p, arch):
    """优先挑系统目录里的那份（更靠谱）"""
    pl = p.lower().replace("/", "\\")
    score = 0
    if "\\windows\\system32\\" in pl and arch == "x64":
        score += 100
    if "\\windows\\syswow64\\" in pl and arch == "x86":
        score += 100
    if "\\windows\\winsxs\\" in pl:
        score += 50
    return score

def safe_walk(root):
    """os.walk 的安全版本：权限问题就跳过"""
    for dirpath, dirnames, filenames in os.walk(root):
        # 排除一些无意义/巨大的目录
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIR_NAMES]
        yield dirpath, dirnames, filenames

def find_candidates(roots, wanted_set_lower):
    hits = {name: [] for name in wanted_set_lower}
    for root in roots:
        if not os.path.exists(root):
            continue
        for dirpath, _, filenames in safe_walk(root):
            for fn in filenames:
                key = fn.lower()
                if key in hits:
                    hits[key].append(os.path.join(dirpath, fn))
    return hits

def pick_best(paths, arch):
    best = None
    best_key = None
    for p in paths:
        a = detect_pe_arch(p)
        if a != arch:
            continue
        try:
            mtime = os.path.getmtime(p)
        except Exception:
            mtime = 0
        score = win_path_score(p, arch)
        key = (score, mtime)
        if best is None or key > best_key:
            best = p
            best_key = key
    return best

def main():
    # roots：不传参就扫所有盘；传参就按参扫
    roots = sys.argv[1:] if len(sys.argv) > 1 else list_existing_drives()

    script_dir = Path(__file__).resolve().parent
    out_x64 = script_dir / "runtimes" / "x64"
    out_x86 = script_dir / "runtimes" / "x86"
    out_x64.mkdir(parents=True, exist_ok=True)
    out_x86.mkdir(parents=True, exist_ok=True)

    wanted_all = sorted(set([x.lower() for x in (TARGETS_X64 + TARGETS_X86)]))
    print("将要搜的 DLL（去重后）:", wanted_all)
    print("扫描 roots:", roots)
    print("打印目录:", str(out_x64), "和", str(out_x86))

    hits = find_candidates(roots, set(wanted_all))

    missing_x64 = []
    missing_x86 = []

    # x64
    for dll in TARGETS_X64:
        paths = hits.get(dll.lower(), [])
        best = pick_best(paths, "x64")
        if not best:
            missing_x64.append(dll)
            continue
        shutil.copy2(best, out_x64 / dll)
        print("[x64] 复制:", dll, "<-", best)

    # x86
    for dll in TARGETS_X86:
        paths = hits.get(dll.lower(), [])
        best = pick_best(paths, "x86")
        if not best:
            missing_x86.append(dll)
            continue
        shutil.copy2(best, out_x86 / dll)
        print("[x86] 复制:", dll, "<-", best)

    print("\n=== 总结 ===")
    if missing_x64:
        print("x64 缺少:", missing_x64)
    else:
        print("x64 全齐")

    if missing_x86:
        print("x86 缺少:", missing_x86)
    else:
        print("x86 全齐")

    print("\n已放入：")
    print(" -", out_x64)
    print(" -", out_x86)

if __name__ == "__main__":
    main()

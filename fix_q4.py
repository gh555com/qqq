#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_q4.py - 一键修复 Q4.js（专治 Webview 语法过敏 + 模板注入残缺 + 文件尾部污染）

用法：
  python3 fix_q4.py /path/to/Q4.js
输出：
  同目录生成 Q4.fixed.js（不会覆盖原文件）

做了什么：
1) 截断：确保文件在 module.exports = {...}; 后立刻结束（移除你粘贴在文件末尾的“说明文字”，避免 Node 解析报错）
2) CSP：移除 style-src 中的 'unsafe-inline'（保留 nonce 机制）
3) Webview 脚本：
   - 注入 closest/matches polyfill（老 Webview 也能跑）
   - 强制替换 isValidUrl() 为纯正则 + 无 try/catch + 无 new URL()
"""

import io
import os
import re
import sys

POLYFILL = r"""
            // ---- ES5/老环境兜底：closest/matches polyfill ----
            if (!Element.prototype.matches) {
                Element.prototype.matches = Element.prototype.msMatchesSelector || Element.prototype.webkitMatchesSelector;
            }
            if (!Element.prototype.closest) {
                Element.prototype.closest = function(sel) {
                    var el0 = this;
                    while (el0 && el0.nodeType === 1) {
                        if (el0.matches && el0.matches(sel)) return el0;
                        el0 = el0.parentElement || el0.parentNode;
                    }
                    return null;
                };
            }
            // --------------------------------------------------
"""

IS_VALID_URL_FUNC = r"""
            function isValidUrl(s) {
                if (!s) return false;
                var val = ('' + s).replace(/^\s+|\s+$/g, '');
                if (!val) return false;
                // 禁止空格
                if (/\s/.test(val)) return false;

                // 允许 localhost / 127.0.0.1 / ::1（可带端口与路径）
                if (/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(val)) return true;

                // 纯正则：不使用 new URL()，不使用 try/catch
                // 说明：故意放宽（兼容更多实际 URL），但避免明显垃圾输入
                var pattern = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(\/[^\s]*)?$/i;
                return pattern.test(val);
            }
"""

def die(msg: str, code: int = 1) -> None:
    sys.stderr.write(msg + "\n")
    raise SystemExit(code)

def read_text(p: str) -> str:
    with io.open(p, "r", encoding="utf-8", errors="replace") as f:
        return f.read()

def write_text(p: str, s: str) -> None:
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)

def truncate_after_module_exports(src: str) -> str:
    # 找到最后一个 module.exports = { ... }; 并截断到该语句结尾
    idx = src.rfind("module.exports")
    if idx < 0:
        return src
    tail = src[idx:]
    # 找到从 module.exports 起的第一个 "};"（通常就是文件末尾导出块结束）
    m = re.search(r"\};", tail)
    if not m:
        return src
    end = idx + m.end()
    return src[:end] + "\n"

def remove_unsafe_inline_in_csp(src: str) -> str:
    # 仅移除 style-src 中的 'unsafe-inline'，避免与“全 nonce”目标冲突
    src2 = src.replace("`style-src ${this._view.webview.cspSource} 'nonce-${nonce}' 'unsafe-inline'`",
                       "`style-src ${this._view.webview.cspSource} 'nonce-${nonce}'`")
    src2 = src2.replace("`style-src ${this._view.webview.cspSource} 'nonce-${nonce}'  'unsafe-inline'`",
                        "`style-src ${this._view.webview.cspSource} 'nonce-${nonce}'`")
    return src2

def inject_polyfill(src: str) -> str:
    # 在 <script nonce="${nonce}"> 里的 (function() { 之后插入 polyfill
    marker = "(function() {"
    pos = src.find(marker)
    if pos < 0:
        return src
    # 只注入一次：避免重复运行
    if "closest/matches polyfill" in src:
        return src
    insert_at = pos + len(marker)
    return src[:insert_at] + POLYFILL + src[insert_at:]

def replace_is_valid_url(src: str) -> str:
    # 替换 Webview 内的 function isValidUrl(s) { ... } 为安全版本
    # 采用“从 function isValidUrl 到下一个 }”的近似匹配（靠缩进/关键字兜底）
    # 尽量只替换第一次出现的 Webview 版本
    pattern = re.compile(r"\n\s*function\s+isValidUrl\s*\(\s*s\s*\)\s*\{[\s\S]*?\n\s*\}\n", re.M)
    m = pattern.search(src)
    if not m:
        return src
    return src[:m.start()] + "\n" + IS_VALID_URL_FUNC + "\n" + src[m.end():]

def main():
    if len(sys.argv) < 2:
        die("用法：python3 fix_q4.py /path/to/Q4.js")

    in_path = sys.argv[1]
    if not os.path.isfile(in_path):
        die("找不到文件：" + in_path)

    src = read_text(in_path)

    # 1) 截断尾部污染
    src = truncate_after_module_exports(src)

    # 2) CSP 去 unsafe-inline（可选但推荐）
    src = remove_unsafe_inline_in_csp(src)

    # 3) Webview 脚本注入 polyfill
    src = inject_polyfill(src)

    # 4) 强制替换 isValidUrl
    src = replace_is_valid_url(src)

    out_path = os.path.join(os.path.dirname(in_path), "Q4.fixed.js")
    write_text(out_path, src)

    sys.stdout.write("✅ 已生成：" + out_path + "\n")

if __name__ == "__main__":
    main()

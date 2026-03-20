import re
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# 基础配置
BASE = "https://registry.npmmirror.com/-/binary/chromium-browser-snapshots"
PLAT = "Win_x64"
TARGET = 1070094  # 109 stable 对应的 position

# 创建带重试机制的 requests 会话（解决网络波动问题）
session = requests.Session()
# 禁用代理（解决你之前的 ProxyError 问题）
session.proxies = {"http": None, "https": None}
# 设置重试策略
retry_strategy = Retry(
    total=3,  # 总重试次数
    backoff_factor=1,  # 重试间隔（1s, 2s, 4s...）
    status_forcelist=[429, 500, 502, 503, 504],  # 触发重试的状态码
)
adapter = HTTPAdapter(max_retries=retry_strategy)
session.mount("https://", adapter)
session.mount("http://", adapter)

try:
    # 1. 获取所有版本目录列表
    print(f"正在获取 {PLAT} 下的版本列表...")
    dirs_response = session.get(f"{BASE}/{PLAT}/", timeout=30, verify=False)
    dirs_response.raise_for_status()  # 主动抛出 HTTP 错误
    dirs = dirs_response.json()

    # 2. 筛选并排序符合条件的版本号（<= TARGET 的数字目录）
    nums = []
    for x in dirs:
        name = x.get("name", "")
        # 匹配纯数字目录（如 "1070094/"）
        if x.get("type") == "dir" and re.fullmatch(r"\d+/", name):
            try:
                rev_num = int(name[:-1])
                if rev_num <= TARGET:
                    nums.append(rev_num)
            except ValueError:
                continue  # 跳过非数字目录（理论上不会出现）

    if not nums:
        print("未找到符合条件的版本目录")
        exit(1)

    # 按版本号升序排序
    nums_sorted = sorted(nums)
    print(f"共找到 {len(nums_sorted)} 个 <= {TARGET} 的版本，开始扫描最近 300 个...")

    # 3. 从离 TARGET 最近的版本往回找，直到找到包含 chrome-win.zip 的版本
    # 只扫描最后 300 个候选版本，兼顾速度和准确性
    candidates = nums_sorted[-300:]
    found_rev = None
    download_url = None

    for rev in reversed(candidates):
        try:
            # 获取该版本下的文件列表
            files_response = session.get(f"{BASE}/{PLAT}/{rev}/", timeout=30, verify=False)
            files_response.raise_for_status()
            files = files_response.json()

            # 检查是否包含 chrome-win.zip
            if any(f.get("name") == "chrome-win.zip" for f in files):
                found_rev = rev
                download_url = f"{BASE}/{PLAT}/{rev}/chrome-win.zip"
                break
        except requests.exceptions.RequestException as e:
            print(f"检查版本 {rev} 时出错: {str(e)}，跳过")
            continue

    # 4. 打印结果
    if found_rev:
        print(f"\n✅ 找到符合条件的版本: {found_rev}")
        print(f"📥 下载链接: {download_url}")
    else:
        print(f"\n❌ 在最近 300 个版本（<= {TARGET}）中未找到包含 chrome-win.zip 的构建")

except requests.exceptions.RequestException as e:
    print(f"\n❌ 网络请求失败: {str(e)}")
except Exception as e:
    print(f"\n❌ 程序运行出错: {str(e)}")
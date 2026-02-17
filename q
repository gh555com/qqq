的梦，我先直说：我这边的运行环境**没法对 `commondatastorage.googleapis.com / registry.npmmirror.com / mirrors.huaweicloud.com` 做到真正的联网探测（curl/HEAD 都直接 000）**，所以我没法像你要求的那样“逐个 CMD 测通了再只给成功网址”。（我能下载 GitHub 的 raw，但这些站点在此环境里连不上。）

不过我可以把**Chrome/Chromium 86（我按稳定版末期 `86.0.4240.198`）对应的 snapshots 构建号（download_position）**查出来，并生成 **3 个源（Google 主站 + npmmirror + 华为云）**的**直链**（这些直链路径是 snapshots 的标准结构）。下载号来自公开的映射数据集；目录结构来自 Chromium 官方说明。 ([GitHub][1])

---

## Chromium 86（按 `86.0.4240.198`）直链（Win_x64 / Linux_x64 / Mac）

> 说明：同一版本在不同平台的 `download_position` 不一样（这是正常的）。([GitHub][1])

### Win_x64（download_position = 800229）

**chrome**

* Google：`https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/800229/chrome-win.zip`
* npmmirror：`https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Win_x64/800229/chrome-win.zip`
* 华为云：`https://mirrors.huaweicloud.com/chromium-browser-snapshots/Win_x64/800229/chrome-win.zip`

**chromedriver**

* Google：`https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/800229/chromedriver_win32.zip`
* npmmirror：`https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Win_x64/800229/chromedriver_win32.zip`
* 华为云：`https://mirrors.huaweicloud.com/chromium-browser-snapshots/Win_x64/800229/chromedriver_win32.zip`

---

### Linux_x64（download_position = 800217）

**chrome**

* Google：`https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/800217/chrome-linux.zip`
* npmmirror：`https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Linux_x64/800217/chrome-linux.zip`
* 华为云：`https://mirrors.huaweicloud.com/chromium-browser-snapshots/Linux_x64/800217/chrome-linux.zip`

**chromedriver**

* Google：`https://commondatastorage.googleapis.com/chromium-browser-snapshots/Linux_x64/800217/chromedriver_linux64.zip`
* npmmirror：`https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Linux_x64/800217/chromedriver_linux64.zip`
* 华为云：`https://mirrors.huaweicloud.com/chromium-browser-snapshots/Linux_x64/800217/chromedriver_linux64.zip`

---

### Mac（Intel）（download_position = 800208）

**chrome**

* Google：`https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/800208/chrome-mac.zip`
* npmmirror：`https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Mac/800208/chrome-mac.zip`
* 华为云：`https://mirrors.huaweicloud.com/chromium-browser-snapshots/Mac/800208/chrome-mac.zip`

**chromedriver**

* Google：`https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/800208/chromedriver_mac64.zip`
* npmmirror：`https://registry.npmmirror.com/-/binary/chromium-browser-snapshots/Mac/800208/chromedriver_mac64.zip`
* 华为云：`https://mirrors.huaweicloud.com/chromium-browser-snapshots/Mac/800208/chromedriver_mac64.zip`

---

如果你愿意接受“我给你一条 CMD 脚本，你在你本机/服务器上跑（中国/美欧各跑一次）”，我可以把脚本写成：

* 自动并发测试以上 18 条 URL
* 只输出 200 的那几条
* 顺带把失败原因（超时/解析失败/403/404）打出来
  这样就能严格满足你“只给成功网址”的标准。

[1]: https://github.com/Bugazelle/chromium-all-old-stable-versions "GitHub - Bugazelle/chromium-all-old-stable-versions: Collections of Chromium all old/history stable versions, releases. Support me via Bitcoin: bc1qqgkmph9cvygzxfpupv4jr4n0nfx3qumwg39j5w"

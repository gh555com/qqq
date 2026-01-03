







## Video Downloader Security Policy Tiers: Trade-off  & Quantification （下方有中文版）


### Tier 0: All Security Policies Disabled — Most Permissive

### Tier 2: All Security Policies Enabled — Most Strict

### Tier 1:

|  # | Switch                                                                                            | Tier 1  | Benefits of Enabling (Security Gains)                                                                                                               | Cost of Enabling (Compatibility/Overhead)                                                                                                                                                 | Quantified Trade-off (Security:Cost) + Conclusion/Recommendation                                                                                                                                          |
| -: | ------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|  1 | SSRF Default Block (private/localhost/reserved IP ranges)                                         | **OFF** | Blocks internal network probing / localhost attacks / cloud metadata (169.254.169.254) abuse; confines downloader to "pure downloader" role         | Internal/NAS/dev environment/corporate intranet domains blocked by default; extra DNS resolution overhead (all:true); conservative rules may false-positive on .local/IPv6 special ranges | **10:7** Conclusion: Huge security gain but significant false positives. Recommendation: Enable by default for untrusted public URLs; use allowlist or temporarily disable for internal downloads.        |
|  2 | Allow Only http/https + Block URL Credentials                                                     | **ON**  | Eliminates dangerous protocols like file/data/ftp/gopher; prevents user:pass@ leakage / proxy quirks                                                | Legacy systems relying on "credentials in URL" will break; reduced feature surface                                                                                                        | **9:2** Conclusion: Benefits far outweigh costs. Recommendation: Keep enabled long-term; use headers/config for basic-auth if needed.                                                                     |
|  3 | Redirect Protocol Restriction (redirects only to http/https)                                      | **ON**  | Prevents 30x redirects to file/data and other dangerous protocols; blocks "looks normal, redirects malicious" attacks                               | Rare custom schemes / unusual redirects will fail                                                                                                                                         | **8:1** Conclusion: Almost pure upside. Recommendation: Enable by default; whitelist rare edge-case sites individually.                                                                                   |
|  4 | baseDir Path Traversal Protection (destPath must be within baseDir)                               | **OFF** | Blocks ../../ and absolute paths from writing to sensitive system locations; enforces clear write boundaries                                        | Must define a download root directory; Windows/UNC/symlinked directories more prone to false positives; reduced flexibility (can't write to arbitrary directories)                        | **9:5** Conclusion: Clearly stronger security but moderate integration cost. Recommendation: Enable if destPath has any external input risk; disable for purely internal fixed paths.                     |
|  5 | Download Lock (destPath.lock) to Prevent Concurrent Trampling                                     | **ON**  | Prevents concurrent writes corrupting files / rename conflicts; reduces rare corrupted files and mysterious failures (stability ≈ part of security) | Concurrent writes to same destPath become serialized; extra I/O; abnormal exits may leave stale locks (needs cleanup mechanism)                                                           | **7:3** Conclusion: Benefits outweigh costs. Recommendation: Enable for almost all concurrent download scenarios; provide lockStaleMs fallback.                                                           |
|  6 | Header Injection Sanitization (CRLF / illegal headers)                                            | **ON**  | Prevents CRLF injection to forge additional headers; avoids undefined behavior from illegal headers                                                 | Rare "technically invalid but somehow works" headers will fail; may cause debugging confusion                                                                                             | **8:1** Conclusion: Enable without hesitation. Recommendation: Enable by default; log sanitized headers for troubleshooting.                                                                              |
|  7 | content-length / content-range Pre-check (reject if declared size exceeds limit / range mismatch) | **OFF** | Early rejection of oversized responses saves bandwidth and time; early detection of range mismatches during resume reduces silent corruption        | False positives when servers report incorrect length; reduced benefit for chunked responses without length; more complex logic branches                                                   | **7:4** Conclusion: Benefits slightly outweigh costs. Recommendation: More advisable for untrusted sources / high-concurrency crawling; disable for sites with frequently inaccurate lengths.             |
|  8 | Strict Resume (206 required + no Range+compression + strict matching)                             | **OFF** | Maximally avoids resume offset errors / compression-induced offset errors / silent file corruption                                                  | Resume success rate drops significantly; more scenarios trigger full re-download (increased bandwidth cost)                                                                               | **6:5** Conclusion: Only worthwhile for "correctness purists". Recommendation: Enable if you'd rather re-download than risk potential corruption; otherwise keep disabled and re-download when uncertain. |
|  9 | Symlink Protection (reject symlinks / non-regular file objects)                                   | **OFF** | Prevents pre-planted symlinks from redirecting writes to sensitive paths; avoids writing to directories/device files/non-regular objects            | Users who intentionally want to write to symlink targets will fail; TOCTOU theoretical edge cases remain (not kernel-level)                                                               | **8:4** Conclusion: Significant security gain, moderate compatibility cost. Recommendation: Enable for multi-user/shared directories/untrusted environments; disable for single-user local tools.         |
| 10 | yt-dlp Probe Output Limit (stdout/stderr limits)                                                  | **OFF** | Prevents massive playlists / huge JSON from exhausting memory or freezing UI; avoids being overwhelmed by "output-based attacks/accidents"          | Probe may fail due to output limit exceeded; information may be truncated (e.g., only partial entries returned)                                                                           | **7:3** Conclusion: Benefits usually outweigh costs. Recommendation: Enable whenever probe is exposed to untrusted URLs; disable if you only probe a few trusted links.                                   |
| 11 | Fail-fast (reject on suspicious / uncertain conditions)                                           | **OFF** | Clear boundaries: DNS failure/missing baseDir/illegal headers result in immediate rejection, reducing security gray areas from "fuzzy degradation"  | Increased failure rate; UI/callers need to explain more errors; users may complain "browser can download but qqq can't"                                                                   | **8:6** Conclusion: Stronger security but harder UX. Recommendation: Enable for security-critical scenarios; disable for general users who prioritize "just make it work".                                |


 (end)






//===================================================================================






## 视频下载器安全策略分级：取舍与量化


### 0 档：安全策略全关闭，最宽松

### 2 档：安全策略全打开，最严格

### 1 档：

|  项 | 开关                                               | 1 档   | 打开得到的（安全好处）                                                       | 打开付出的代价（成本/兼容性）                                                                  | 量化取舍（安全:代价）+ 结论/建议                                                  |
| -: | ------------------------------------------------ | ------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
|  1 | SSRF 默认拦截（内网/本机/保留网段）                            | **OFF** | 阻断内网探测/打本机/打云 metadata（169.254.169.254）等高危滥用面；把下载器从“网络探针”拉回“纯下载器” | 内网/NAS/开发环境/公司内网域名默认无法下载；对 hostname 额外 DNS 解析（all:true）；保守规则可能误伤 .local/IPv6 特殊段 | **10:7** 结论：安全收益巨大但误杀也大。建议：公网不可信 URL 默认开；需要内网下载时做 allowlist 或临时关。   |
|  2 | 仅允许 http/https + 禁止 URL credentials              | **ON**  | 直接砍掉 file/data/ftp/gopher 等危险协议；避免 user:pass@ 泄露/代理怪行为            | 依赖“URL 内写账号密码”的旧系统会挂；功能面收缩                                                       | **9:2** 结论：收益远大于代价。建议：长期保持开启；若必须 basic-auth 用 header/配置传。           |
|  3 | 重定向协议限制（redirect 只能到 http/https）                 | **ON**  | 防止 30x 跳到 file/data 等危险协议；避免“表面正常、跳转恶意”                           | 极少数自定义 scheme/奇怪跳转会失败                                                            | **8:1** 结论：几乎稳赚。建议：默认开启；真遇到少数站点再单点放开。                               |
|  4 | baseDir 路径越界防护（destPath 必须在 baseDir 内）           | **OFF** | 阻止 ../../、绝对路径把文件写到系统敏感位置；明确写入边界                                  | 必须选定一个下载根目录；Windows/UNC/软链目录更容易触发误判；灵活性下降（不能随便写任意目录）                             | **9:5** 结论：安全明显更强但集成成本中等。建议：只要 destPath 有外部输入风险就开；纯内部固定路径可关。        |
|  5 | 下载锁（destPath.lock）避免并发踩踏                         | **ON**  | 防并发写坏文件/rename 冲突；减少偶现坏文件与诡异失败（稳定性≈安全性的一部分）                       | 同 destPath 并发变串行；额外 I/O；异常退出可能留锁（需 stale 清理）                                     | **7:3** 结论：收益大于代价。建议：并发下载几乎都该开；提供 lockStaleMs 兜底。                   |
|  6 | Header 注入清洗（CRLF/非法 header）                      | **ON**  | 防 CRLF 注入伪造额外 header；避免非法 header 触发不确定行为                          | 极少数“不合法但碰巧可用”的 header 会失效；调试时可能困惑                                                | **8:1** 结论：几乎无脑开。建议：默认开启；日志里提示被清洗的 header 方便排查。                     |
|  7 | content-length / content-range 预检（声明超限/范围不符提前拒绝） | **OFF** | 提前拒绝超大响应，省带宽省时间；续传时提前发现范围不匹配，减少 silent corruption                 | 服务端 length 写错会误杀；chunked 无 length 时收益下降；逻辑分支更复杂                                  | **7:4** 结论：收益略大于代价。建议：面向不可信来源/高并发抓取更建议开；对“长度经常不准”的站点可关。             |
|  8 | 严格断点续传（206 必须 + 禁止 Range+压缩 + 严格匹配）              | **OFF** | 最大化避免续传错位/压缩导致 offset 错误/最终文件悄悄损坏                                 | 续传成功率明显下降；更多场景会重下（带宽成本上升）                                                        | **6:5** 结论：偏“正确性洁癖”才值得。建议：你如果宁可重下也不接受潜在损坏→开；否则保持关并在不确定时重下。          |
|  9 | 符号链接防护（拒绝 symlink/非常规对象）                         | **OFF** | 防止被预置 symlink 把写入导向敏感路径；避免写入目录/设备文件等非常规对象                         | 用户确实想写到 symlink 指向处会失败；仍存在 TOCTOU 理论边界（非内核级）                                     | **8:4** 结论：安全收益较大、兼容性代价中等。建议：多用户/共享目录/不可信环境开；单用户本地工具可关。             |
| 10 | yt-dlp probe 输出限制（stdout/stderr 限制）              | **OFF** | 防止超大 playlist/巨量 JSON 把内存撑爆或 UI 卡死；避免被“输出型攻击/意外”拖垮                | probe 可能因输出超限而失败；信息可能被截断（例如只给部分 entries）                                         | **7:3** 结论：收益通常大于代价。建议：只要 probe 会暴露给不可信 URL，就开；若你只对少量可信链接 probe，可关。 |
| 11 | Fail-fast（可疑/不确定即失败）                             | **OFF** | 边界清晰：DNS 失败/缺 baseDir/非法 header 等直接拒绝，减少“模糊降级”带来的安全灰区             | 失败率上升；需要 UI/调用方解释更多错误；你会觉得“浏览器能下 qqq却不能”                                           | **8:6** 结论：安全更强但体验更硬。建议：安全红线场景开；面向普通用户“能下就行”建议关。                 |



 (end)








# A Chronicle of Neglect: The VS Marketplace Support Case (rep:34d03ee3)  （下方有中文版）

## Executive Summary

This document records the complete interaction between an independent developer (gh555) and the VS Marketplace Support Team regarding the qqq extension review. The facts speak for themselves: **systematic neglect, zero substantive engagement, and a pattern of bureaucratic incompetence**.

---

## The Numbers Don't Lie

| Metric | Developer (gh555) | Microsoft |
|--------|-------------------|-----------|
| **Average Response Time** | **~5.4 hours** | **~72 hours (3 days)** |
| **Total Emails Sent** | 5 | 3 |
| **Substantive Responses** | 5/5 (100%) | 1/3 (33%) |
| **Evidence Provided** | GitHub links, source code, detailed explanations | Template phrases |

---

## Complete Timeline with Evidence Chain

### Day 0 - February 20, 2026, 01:20 AM
**Microsoft's First Email** - Extension locked without warning

> *"We have observed that the extension currently includes several unrelated tags. Additionally, we would like clarification on the purpose and functionality of the extension, including the use of these tags and the bundled q_engine.exe file."*

**Deadline given:** March 5, 2026

---

### Day 0 - February 20, 2026, 10:46 AM (+9h 26m)
**Developer's 1st Response**

Immediately provided documentation link:
- https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE%20v16.md

**Historical snapshot (Feb 20, 2026):** [View at that commit](https://github.com/gh555com/qqq/commits/qq/docs/IO_ENGINE_v16.md)

---

### Day 0 - February 20, 2026, 10:56 AM (+10 min later)
**Developer's 2nd Response**

Provided comprehensive explanation:
> *"The entire qqq extension source code, including all distributed binaries, is fully open and publicly auditable."*
> *"Simply put, my plugin supports directly pasting and displaying images inside VS Code. The core implementation is based on Decorations and CodeLens."*

Links provided:
- New IO Engine: https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE_v16.md
- Old IO Engine: https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE.md

---

### Day 0 - February 20, 2026, 02:15 PM (+3h 19m later)
**Developer's 3rd Response**

Provided direct source code link for q_engine.exe:
- Release: https://github.com/gh555com/qqq/releases/tag/v15.73.71
- **Source code**: https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs

Also expressed the reality of being an independent developer:
> *"I am an independent developer with very limited time and resources."*

---

### ⚠️ SILENCE: February 20-24 (4 DAYS)
**Microsoft's Response: NOTHING**

Three detailed emails with source code, documentation, and explanations. Zero acknowledgment for **4 full days**.

---

### Day 4 - February 24, 2026, 01:04 AM
**Developer's 4th Response** (Proactive follow-up after 4 days of silence)

Comprehensive update addressing BOTH issues:
- **Tags fixed**: https://github.com/gh555com/qqq/blob/qq/package.json
- **README updated**: https://github.com/gh555com/qqq/blob/qq/README.md

**Detailed q_engine.exe explanation provided:**
> q_engine.exe is essentially a clipboard daemon/utility designed with a minimalist dumb saver architecture:
> 1. Plain text: Reads and records text content from the system clipboard
> 2. Files/Folders: Copies files/folders from the clipboard to a designated directory
> 3. Images: Extracts screenshots in CF_DIB/CF_DIBV5 format and saves as PNG
> 4. HTML content: Reads HTML-formatted content from clipboard

**Historical Evidence - package.json at Feb 24, 2026:**
The tags were already reduced to only 3 relevant ones:
```json
"keywords": [
  "paste images",
  "Rich Note",
  "navigate"
]
```

---

### Day 4 - February 24, 2026, 09:04 PM (+20h later)
**Microsoft's 2nd Response** - A meaningless template

> *"Thank you for the response. We will review the provided details and get back to you with an update."*

**Analysis:** After 4 days of silence and receiving 4 detailed emails with complete source code links and explanations, Microsoft's response was a **15-word template message** that provided zero substantive feedback.

---

### ⚠️ ANOTHER SILENCE: February 24-26 (2 MORE DAYS)

---

### Day 6 - February 26, 2026, 04:31 PM
**Microsoft's 3rd Response** - THE INSULT

> *"We have reviewed your response, but we could not find any clarification regarding the several unrelated tags and the bundled q_engine.exe file. Could you please provide clarification on these points?"*

### THIS IS THE CORE PROBLEM

**Microsoft claimed they "could not find any clarification" despite:**

1. **Tags Issue** - Already addressed on Feb 20 AND explicitly linked on Feb 24:
   - package.json link provided: ✅
   - Only 3 relevant tags remaining: ✅
   - "paste images", "Rich Note", "navigate" - all directly related to functionality: ✅

2. **q_engine.exe Issue** - Explained in excruciating detail:
   - Source code link (kp_win.rs): ✅ Provided Feb 20
   - Functional summary: ✅ Provided Feb 24
   - Architecture explanation: ✅ Provided Feb 20

**Evidence that everything was provided BEFORE this response:**
| Item | First Provided | Days Before Microsoft's "Cannot Find" Response |
|------|----------------|------------------------------------------------|
| Source code link (kp_win.rs) | Feb 20, 02:15 PM | **6 days** |
| package.json link | Feb 24, 01:04 AM | **2 days** |
| README.md link | Feb 24, 01:04 AM | **2 days** |
| Detailed functional summary | Feb 24, 01:04 AM | **2 days** |

---

### Day 6 - February 26, 2026, 05:58 PM (+1h 27m)
**Developer's 5th Response**

Patiently re-explained everything AGAIN:

**On Tags (with evidence):**
> *"If you open the file, you'll see we're currently using only 3 tabs: "paste images", "Rich Note", "navigate"."*

**On q_engine.exe:**
Asked two critical questions:
> 1. *"Have you already or can you access https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs to view the source code?"*
> 2. *"Can you understand the description I provide below, and based on that description, are there any issues?"*

---

### Day 7+ - February 27, 2026 and Beyond
**Microsoft's Response: SILENCE AGAIN**

As of this writing, no response has been received.

---

## The Source Code Proves Everything

### q_engine.exe (kp_win.rs) - First 50 Lines

```rust
// -*- coding: utf-8 -*-
// Rust port of the given Python "dumb saver" clipboard daemon.
// - 极简模式：只负责读取系统剪切板并保存到指定目录（dumb saver）
// - 移除所有指纹计算、去重逻辑
// - 移除 HTML 解析逻辑（由 Node.js 侧处理）
// - 仅处理：纯文本、文件复制、原生图片保存
//
// 目标：按用户贴出的 Python 版本"行为等同"：
// - daemon 协议：stdin JSON line -> stdout JSON line
// - JSON dumps：默认 separators (", ", ": ")；ensure_ascii 默认 True
// - actions: ping / extract_icon / clipboard_peek(peek) /
//            get_clipboard_files / get_html / exit / clipboard(paste) /
//            folder_info(get_folder_info)
// - Windows：文本、CF_HDROP 文件/文件夹复制、CF_DIB/CF_DIBV5 截图保存
```

**This is a clipboard utility. Nothing more, nothing less.**
- No network access
- No data collection
- No malicious behavior
- 100% open source

---

## Response Time Analysis

### Developer Response Times (to Microsoft emails)

| Microsoft Email | Developer Response | Time Elapsed |
|-----------------|-------------------|--------------|
| Feb 20, 01:20 AM | Feb 20, 10:46 AM | **9h 26m** |
| Feb 20, 01:20 AM | Feb 20, 10:56 AM | **9h 36m** |
| Feb 20, 01:20 AM | Feb 20, 02:15 PM | **12h 55m** |
| Feb 26, 04:31 PM | Feb 26, 05:58 PM | **1h 27m** |

**Average: ~8.4 hours** (or **~1.4 hours** for direct responses to new queries)

### Microsoft Response Times (to Developer emails)

| Developer Email(s) | Microsoft Response | Time Elapsed |
|-------------------|-------------------|--------------|
| Feb 20 (3 emails) | Feb 24, 09:04 PM | **~4 days 8h** |
| Feb 24, 01:04 AM | Feb 26, 04:31 PM | **~2 days 15h** |
| Feb 26, 05:58 PM | ??? | **1+ days and counting** |

**Average: ~72+ hours (3+ days)**

---

## The Pattern of Neglect

```
Developer                              Microsoft
    │                                      │
    │◄──────── LOCK EXTENSION ─────────────│ Day 0, 01:20
    │                                      │
    ├─── Response #1 (10:46) ────────────►│ +9h
    ├─── Response #2 (10:56) ────────────►│ +10m
    ├─── Response #3 (14:15) ────────────►│ +3h
    │                                      │
    │         [4 DAYS OF SILENCE]          │
    │                                      │
    ├─── Response #4 (01:04) ────────────►│ Day 4
    │                                      │
    │◄───── "Thank you" (21:04) ───────────│ +20h
    │                                      │
    │         [2 DAYS OF SILENCE]          │
    │                                      │
    │◄── "Cannot find clarification" ──────│ Day 6, 16:31
    │                                      │
    ├─── Response #5 (17:58) ────────────►│ +1h 27m
    │                                      │
    │         [SILENCE CONTINUES...]       │
    │                                      │
```

---

## What This Means

1. **Microsoft locked my extension** before even asking questions
2. **I responded within hours** with complete documentation and source code
3. **Microsoft ignored 4 detailed emails** for 4 days
4. **When they finally responded**, it was to say they "couldn't find" information that was clearly provided multiple times
5. **The deadline (March 5) keeps approaching** while Microsoft plays bureaucratic games

---

## Evidence Links Summary

All evidence is publicly available and auditable:

| Resource | URL | Purpose |
|----------|-----|---------|
| Full Repository | https://github.com/gh555com/qqq | All source code |
| q_engine.exe Source | https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs | Proves no malicious code |
| package.json | https://github.com/gh555com/qqq/blob/qq/package.json | Shows only 3 relevant tags |
| IO Engine v16 Docs | https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE_v16.md | Architecture explanation |
| README | https://github.com/gh555com/qqq/blob/qq/README.md | Extension description |

To view historical versions at specific dates, use GitHub's commit history:
- https://github.com/gh555com/qqq/commits/qq/package.json
- https://github.com/gh555com/qqq/commits/qq/README.md

---

## Conclusion

This is not about a few "unrelated tags" or a clipboard utility. This is about:

1. **A trillion-dollar company** unable to click GitHub links provided multiple times
2. **A support team** that responds with template phrases instead of reading developer responses
3. **An independent developer** being punished for Microsoft's internal incompetence
4. **An extension** that remains locked despite full transparency and rapid compliance

The question is not what I did wrong. The question is: **Did anyone at Microsoft actually read any of my emails?**

---

*Document created: February 27, 2026*
*Case reference: rep:34d03ee3*
*All timestamps verified from original email headers*



 (end)













//===================================================================================














---

# 一份关于失职的纪实：VS Marketplace 支持案例（rep:34d03ee3）

## 执行摘要

本文完整记录了一名独立开发者（gh555）与 VS Marketplace 支持团队之间关于 qqq 扩展审核的全部互动过程。事实本身已经说明一切：

**系统性忽视、零实质性沟通，以及一种官僚主义式的低效与失职模式。**

---

## 数据不会说谎

| 指标          | 开发者（gh555）         | Microsoft        |
| ----------- | ------------------ | ---------------- |
| **平均响应时间**  | **约 5.4 小时**       | **约 72 小时（3 天）** |
| **发送邮件总数**  | 5                  | 3                |
| **实质性回复比例** | 5/5（100%）          | 1/3（33%）         |
| **提供证据情况**  | GitHub 链接、源代码、详细解释 | 模板式套话            |

---

## 完整时间线与证据链

### 第 0 天 - 2026 年 2 月 20 日 01:20 AM

**Microsoft 第一封邮件** —— 在没有任何预警的情况下锁定扩展

> “我们观察到该扩展当前包含多个不相关的标签。此外，我们希望澄清该扩展的用途与功能，包括这些标签的使用，以及捆绑的 q_engine.exe 文件。”

**给定截止日期：** 2026 年 3 月 5 日

---

### 第 0 天 - 2026 年 2 月 20 日 10:46 AM（+9 小时 26 分）

**开发者第 1 次回复**

立即提供文档链接：

* [https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE%20v16.md](https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE%20v16.md)

**历史版本快照（2026-02-20）：**
[查看该提交版本](https://github.com/gh555com/qqq/commits/qq/docs/IO_ENGINE_v16.md)

---

### 第 0 天 - 2026 年 2 月 20 日 10:56 AM（+10 分钟）

**开发者第 2 次回复**

提供完整说明：

> “整个 qqq 扩展的源代码，包括所有分发的二进制文件，都是完全开源并可公开审计的。”
> “简单来说，我的插件支持在 VS Code 内直接粘贴并显示图片。核心实现基于 Decorations 和 CodeLens。”

提供链接：

* 新 IO Engine: [https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE_v16.md](https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE_v16.md)
* 旧 IO Engine: [https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE.md](https://github.com/gh555com/qqq/blob/qq/docs/IO_ENGINE.md)

---

### 第 0 天 - 2026 年 2 月 20 日 02:15 PM（+3 小时 19 分）

**开发者第 3 次回复**

提供 q_engine.exe 的直接源代码链接：

* Release: [https://github.com/gh555com/qqq/releases/tag/v15.73.71](https://github.com/gh555com/qqq/releases/tag/v15.73.71)
* **源代码：** [https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs](https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs)

同时说明自己是独立开发者的现实情况：

> “我是一个独立开发者，时间和资源都非常有限。”

---

### ⚠️ 沉默期：2 月 20 日 - 2 月 24 日（4 天）

**Microsoft 的回应：无**

三封详细邮件，包含源代码、文档、完整解释。
**整整 4 天没有任何确认或回应。**

---

### 第 4 天 - 2026 年 2 月 24 日 01:04 AM

**开发者第 4 次回复（主动跟进）**

全面更新并同时解决两个问题：

* **标签已修正：** [https://github.com/gh555com/qqq/blob/qq/package.json](https://github.com/gh555com/qqq/blob/qq/package.json)
* **README 已更新：** [https://github.com/gh555com/qqq/blob/qq/README.md](https://github.com/gh555com/qqq/blob/qq/README.md)

**详细解释 q_engine.exe：**

> q_engine.exe 本质上是一个剪贴板守护/工具程序，采用极简 dumb saver 架构：

1. 纯文本：读取并记录系统剪贴板中的文本内容
2. 文件/文件夹：将剪贴板中的文件/文件夹复制到指定目录
3. 图片：提取 CF_DIB / CF_DIBV5 格式截图并保存为 PNG
4. HTML 内容：读取剪贴板中的 HTML 格式数据

**历史证据 - 2026 年 2 月 24 日的 package.json：**

标签已经减少为仅 3 个相关项：

```json
"keywords": [
  "paste images",
  "Rich Note",
  "navigate"
]
```

---

### 第 4 天 - 2026 年 2 月 24 日 09:04 PM（+20 小时）

**Microsoft 第二次回复 —— 毫无意义的模板回复**

> “感谢您的回复。我们将审查您提供的细节，并在有更新时回复您。”

**分析：**

在 4 天沉默之后，收到 4 封包含完整源代码与解释的邮件后，
Microsoft 的回复仅是一句 15 个单词的模板话术，没有任何实质反馈。

---

### ⚠️ 再次沉默：2 月 24 日 - 2 月 26 日（又 2 天）

---

### 第 6 天 - 2026 年 2 月 26 日 04:31 PM

**Microsoft 第 3 次回复 —— 侮辱性回应**

> “我们已审查您的回复，但未能找到关于多个不相关标签以及捆绑 q_engine.exe 文件的任何澄清。请您提供说明。”

---

## 这才是核心问题

Microsoft 声称“未能找到任何澄清”，但事实上：

### 1️⃣ 标签问题 —— 已在 2 月 20 日说明，并在 2 月 24 日明确提供链接

* package.json 链接：✅
* 仅剩 3 个相关标签：✅
* "paste images"、"Rich Note"、"navigate" —— 全部与功能直接相关：✅

---

### 2️⃣ q_engine.exe 问题 —— 已详细说明

* 源代码链接（kp_win.rs）：✅ 2 月 20 日提供
* 功能总结：✅ 2 月 24 日提供
* 架构说明：✅ 2 月 20 日提供

---

### 证据时间对比

| 项目               | 首次提供时间         | 距 Microsoft “找不到” 回复间隔 |
| ---------------- | -------------- | ---------------------- |
| 源代码链接（kp_win.rs） | 2 月 20 日 14:15 | **6 天前**               |
| package.json 链接  | 2 月 24 日 01:04 | **2 天前**               |
| README.md 链接     | 2 月 24 日 01:04 | **2 天前**               |
| 功能详细说明           | 2 月 24 日 01:04 | **2 天前**               |

---

### 第 6 天 - 2026 年 2 月 26 日 05:58 PM（+1 小时 27 分）

**开发者第 5 次回复**

再次耐心解释：

**关于标签：**

> “如果您打开该文件，可以看到我们当前仅使用 3 个标签：‘paste images’、‘Rich Note’、‘navigate’。”

**关于 q_engine.exe：**

提出两个关键问题：

> 1. “您是否已经或能够访问 [https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs](https://github.com/gh555com/qqq/blob/qq/rust/kp_win.rs) 查看源代码？”
> 2. “您是否理解我提供的描述？基于该描述，是否存在任何问题？”

---

### 第 7 天及之后 - 2026 年 2 月 27 日

**Microsoft 的回应：再次沉默**

截至撰写本文时，仍无回复。

---

## 源代码本身说明一切

### q_engine.exe（kp_win.rs）—— 前 50 行节选

```rust
// -*- coding: utf-8 -*-
// Rust port of the given Python "dumb saver" clipboard daemon.
// - 极简模式：只负责读取系统剪切板并保存到指定目录（dumb saver）
// - 移除所有指纹计算、去重逻辑
// - 移除 HTML 解析逻辑（由 Node.js 侧处理）
// - 仅处理：纯文本、文件复制、原生图片保存
//
// 目标：按用户贴出的 Python 版本"行为等同"：
// - daemon 协议：stdin JSON line -> stdout JSON line
// - JSON dumps：默认 separators (", ", ": ")；ensure_ascii 默认 True
// - actions: ping / extract_icon / clipboard_peek(peek) /
//            get_clipboard_files / get_html / exit / clipboard(paste) /
//            folder_info(get_folder_info)
// - Windows：文本、CF_HDROP 文件/文件夹复制、CF_DIB/CF_DIBV5 截图保存
```

**这只是一个剪贴板工具，仅此而已。**

* 无网络访问
* 无数据收集
* 无恶意行为
* 100% 开源

---

## 响应时间分析

### 开发者响应时间

平均约 **8.4 小时**
针对新问题的直接回复平均约 **1.4 小时**

---

### Microsoft 响应时间

平均约 **72+ 小时（3 天以上）**

---

## 忽视模式图

```
开发者                              Microsoft
    │                                      │
    │◄──────── 锁定扩展 ────────────────│ 第 0 天
    │                                      │
    ├── 回复 #1 ────────────────────────►│
    ├── 回复 #2 ────────────────────────►│
    ├── 回复 #3 ────────────────────────►│
    │                                      │
    │        [4 天沉默]                    │
    │                                      │
    ├── 回复 #4 ────────────────────────►│
    │                                      │
    │◄── 模板回复 ───────────────────────│
    │                                      │
    │        [2 天沉默]                    │
    │                                      │
    │◄── “找不到澄清” ───────────────────│
    │                                      │
    ├── 回复 #5 ────────────────────────►│
    │                                      │
    │        [沉默持续中...]                │
```

---

## 这意味着什么

1. Microsoft 在未沟通的情况下锁定了我的扩展
2. 我在数小时内提供了完整文档与源代码
3. Microsoft 忽视了 4 封详细邮件达 4 天
4. 最终回复却声称“找不到”早已多次提供的信息
5. 截止日期（3 月 5 日）不断逼近，而 Microsoft 在官僚式拖延

---

## 结论

这不只是几个“无关标签”或一个剪贴板工具的问题。

这是关于：

1. 一家万亿美元公司是否有人真正点击并阅读 GitHub 链接
2. 支持团队是否真正阅读开发者邮件
3. 一个独立开发者是否被内部低效流程牺牲
4. 一个完全透明、完全开源的扩展为何被持续锁定

真正的问题不是我做错了什么。

真正的问题是：

**Microsoft 是否真的有人阅读过我的任何一封邮件？**

---

*文档创建时间：2026 年 2 月 27 日*
*案例编号：rep:34d03ee3*
*所有时间戳均来自原始邮件头部验证*




 (end)









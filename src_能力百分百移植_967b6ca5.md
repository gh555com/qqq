# src 能力百分百移植 + ghrun 大一统底层

## 现状摸底（已读）

- **架构铁律**（`ignore/qqq 拓扑/arc/我们到底要做什吗` v3.1 + `qqq IDE 架构`）：
  - 三层：壳（Code-OSS）/ ghrun（Rust 唯一 runtime）/ 载荷（gaea 模块 + 扩展）
  - QDIR 协议派生所有路径；任何 spawn 走 `qdirSpawn` → ghrun → runner.py 兜底
  - 缺陷分级 critical/severe/warn/info
- **qqq-shell-v2 现状**：
  - Monaco 三件套已经搭好骨架但极简陋：[qqq-codelens.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/qqq-codelens.js)、[qqq-decoration.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/qqq-decoration.js)、[qqq-paste.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/qqq-paste.js)、[qqq-video.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/qqq-video.js)
  - 但全部都 **没被任何模块 init 调用**（看 [shell.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/shell.js) 和 [editor.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/editor.js) 都没引用 `qqqCodeLens.init/qqqPaste.init/qqqDecoration.init`）
  - 磁盘剩余 RPC 已实现 [main.ts diskFree handler](file:///e:/s/wol/py/qqq-shell-v2/shell/main.ts#L494-L519) + [q2-roam updateDriveDisplay](file:///e:/s/wol/py/qqq-shell-v2/server-app/qoods/file-explorer/q2-roam.html#L610-L643)，**但 rpc forwarder 把数组参数当 spread args 处理导致只取到第一个盘符**
  - 没有 cache/fingerprint/ffmpeg/keyboard-hook 子系统
- **src/ 能力点定位**：
  - 盘符剩余：[kp.py get_disk_free_batch](file:///e:/s/wol/py/q3/src/kp.py#L1551) (30s 缓存 + Desktop/Recycle 汇总)
  - 指纹去重：[h.js](file:///e:/s/wol/py/q3/src/h.js) (120KB，xxhash+sha256 + ContentID 协议)
  - 下载缓存：[dow.js](file:///e:/s/wol/py/q3/src/dow.js) (128KB，SmartHttpDownloader)
  - 粘贴一切：[q1.js](file:///e:/s/wol/py/q3/src/q1.js) (129KB, CodeLens + Decoration + 隐藏标记 + decoration 1px gutter icon = 相框)
  - 视频转译：[qvideo.js](file:///e:/s/wol/py/q3/src/qvideo.js) (129KB, ffmpeg 调用)
  - Python 环境：[qvenv.js](file:///e:/s/wol/py/q3/src/qvenv.js)
  - Roam 主体：[q2.html](file:///e:/s/wol/py/q3/src/q2.html) + [q2.js](file:///e:/s/wol/py/q3/src/q2.js)（Tab=Roam / Space=size / 1=top / 2=bottom / Q=open / W=media）

## 决策（无选择题）

| 项 | 终值 | 理由 |
|---|---|---|
| spawn 大一统 | 单入口 `bridge.qz.spawn` → ghrun.exe → runner.py → node child_process | 三层兜底；对齐我们到底要做什吗 §2.5；无 ghrun 也能跑 |
| 盘符空间 | Node `statfsSync` 主力 + Python `kp.py:get_disk_free_batch` 降级（含 Desktop/Recycle）| Node 18+ 全平台原生；Python 给出 Desktop/Recycle 完整数据 |
| 键盘钩子 | 单一 `KeyHookService`，四层：`globalShortcut` / BrowserWindow `before-input-event` / 渲染层 capture dispatcher / iframe 内部 dispatcher | JSON-driven 注册表；一处改全生效；能用一万年 |
| 缓存 | `$QDIR/f/cache/` (现 `cache/`)；KV+文件双轨；按内容 hash 分桶 | 对齐 QDIR 协议 |
| 指纹 | xxhash64 (快) + sha256 (强一致)；先 xxh 命中后再校 sha；缓存到 `$QDIR/f/cache/hash/` | 抄 h.js 算法 |
| ffmpeg | 走 `bridge.qz.spawn`；二进制位于 `engines/ffmpeg/`（无则首启 doctor 拉）| 不在主进程内嵌，让 ghrun 接管 |
| q1 三件套 | Monaco CodeLens + Decoration + **ViewZone**（相框）+ Content Widget（图标框）| ViewZone = q1 在 vscode 滴 1px gutter icon trick 滴 Monaco 等价物 |
| 相框 vs 图标框 | 路径独占一行（行内无其他内容）→ 相框；inline 出现 → 图标框 | 抄 q1 行为 |
| 粘贴一切 | hijack `editor.onDidPaste` + DOM paste capture；image/file blob → hash 去重 → 落到 `cache/paste/` → 插入 `/\ path \/` token | 抄 q1 + 加 hash 去重 |
| Roam 快捷键 | iframe 内 `q2-roam.html` 注册 + 父窗口 dispatcher 转发；Space+Q 走 globalShortcut | 兼容键盘钩子统一架构 |
| 字符串禁忌 | 严格遵守 q.md：禁 `su`/`root`/`set` 组合（变量名层面） | 铁律 |

## 执行清单

### Task 1: qz 大一统 spawn 子系统

文件：
- 新建 `shell/qz-spawn.ts`（主进程统一 spawn 入口，三层兜底）
- 新建 `engines/runner.py`（Python stdlib-only 兜底进程启动器，符合 spawn-protocol 字段）
- 改 [shell/main.ts](file:///e:/s/wol/py/qqq-shell-v2/shell/main.ts)：加 ipcMain handler `qqq:qz:spawn`；把 `qqq:ghrun:exec` / `qqq:engine:invoke` 的 spawn 分支转发到 qzSpawn
- 改 [shell/preload.ts](file:///e:/s/wol/py/qqq-shell-v2/shell/preload.ts)：新增 `qz.spawn(brief)` / `qz.which(cmd)` / `qz.ghrunAlive()`

`qzSpawn(brief)` 接口（对齐 spawn-protocol）：
```
{cmd, args, cwd, env, timeout, captureOutput, killOnDisconnect}
→ {exitCode, stdout, stderr, killReason}
```
内部实现序：① 探测 `process.env.QDIR_GHRUN` → 调 ghrun spawn 子命令；② 探测 `engines/runner.py` + portable Python → 调 runner.py spawn；③ Node `child_process.spawn`。三层都带 Job Object（Windows）/ setsid + 进程组（POSIX）反卡死兜底。

### Task 2: 缓存 + 指纹子系统

文件：
- 新建 `shell/cache-store.ts`：KV (json) + 文件（按 hash 分桶 `cache/h/<aa>/<full>`）
- 新建 `shell/hash-service.ts`：xxhash64 主，sha256 完整校；优先用 node 原生 `crypto`，xxh 用纯 JS 实现（h.js 同款）
- 改 main.ts：加 ipcMain handlers `qqq:cache:get/put/delete/has`、`qqq:hash:file/buffer`
- 改 preload.ts：新增 `cache.*` / `hash.*` 命名空间

接口：
```
hash.file(path) → {xxh64, sha256, size, mtimeMs}     // 内置 hash 缓存
cache.put(key, value, opts)                          // value: string|Buffer
cache.get(key) → value|null
cache.has(key) → bool
cache.path(key) → 'cache/h/aa/aabb...'              // 给 ffmpeg 输出复用
```

### Task 3: ffmpeg 媒体服务

文件：
- 新建 `shell/media-service.ts`：thumbnail / transcode / probe（全部走 qzSpawn）
- 改 main.ts：加 `qqq:media:thumb/transcode/probe`
- 改 preload.ts：`media.thumb({src, w, h}) → outPath` / `media.transcode({src, dst, format})` / `media.probe(src) → {duration, width, height, codec}`
- ffmpeg 二进制路径解析：优先 `engines/ffmpeg/ffmpeg.exe`，回退 `$QDIR/f/components/ffmpeg/`，再回退系统 PATH
- 所有输出按内容 hash 落到 `cache/media/` —— 同源同参数永远不重算

### Task 4: KeyHookService 键盘钩子大一统

文件：
- 新建 `server-app/core/key-hook.js`：JSON-driven 注册表 + 单一 dispatcher
- 新建 `server-app/core/key-bindings.json`：默认绑定（File menu / Roam shortcuts / 全局 Space+Q / 缩放 / DevTools）
- 改 [shell/main.ts](file:///e:/s/wol/py/qqq-shell-v2/shell/main.ts)：加 globalShortcut 注册（仅 Space+Q 一条用 globalShortcut）+ `qqq:key:globalRegister` IPC
- 改 [shell/preload.ts](file:///e:/s/wol/py/qqq-shell-v2/shell/preload.ts)：`key.registerGlobal(accel, id)` / `key.onGlobal(cb)`
- 改 [shell.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/shell.js)：boot 时 `keyHook.init(bindings)`，document keydown capture 路由
- 改 iframe（`q2-roam.html`）：注册 Roam 私有绑定 → 通过 postMessage 上抛 `qqq-key` 事件

注册表 schema：
```json
{
  "id": "roam.openInIde",
  "accel": "Q",
  "scope": "iframe:roam",          // global / window / iframe:<name>
  "when": "noEditing && itemSelected",
  "cmd": "roam.openInIde"
}
```

绑定预置（覆盖 README 中提到的所有 Roam 快捷键 + 现有 menu/zoom/devtools）：
- `Tab` (scope=window, when=noEditing) → focusRoamIframe
- `Q` (scope=iframe:roam) → roam.openInIde
- `W` (scope=iframe:roam) → roam.openMedia
- `Space` (scope=iframe:roam, when=itemSelected) → roam.requestSize
- `1` / `2` (scope=iframe:roam) → roam.scrollTop/Bottom
- `Space+Q` (scope=global) → window.activateRoam（用 globalShortcut，离开窗口也能触发）
- `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (scope=window) → zoom.in/out/reset（迁移现有零散代码到统一注册表）
- `F12` (scope=window) → tools.toggleDevTools

### Task 5: Roam 盘符剩余空间修复

文件：
- 改 [shell.js bootRpcForwarder](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/shell.js#L483-L514)：把 `params` 是数组时不再自动 spread；改成 `(params) => fn(params)`，要 spread 显式用 `{__spread: true, args: [...]}`。这一改修掉 `diskFree` 当前 bug
- 改 [main.ts qqq:fs:diskFree](file:///e:/s/wol/py/qqq-shell-v2/shell/main.ts#L494)：先调 Python `engineHost.invoke('disk_free_batch', {drives})` 拿数据（Desktop/Recycle 完整），engine 不在时 fallback 现 `statfsSync` 实现
- 改 [q2-roam.html updateDriveDisplay](file:///e:/s/wol/py/qqq-shell-v2/server-app/qoods/file-explorer/q2-roam.html#L610-L643)：30s 轮询保留 + 首次启动 setTimeout 200ms 后立即调一次（rpc forwarder bug 修了后立刻生效）
- 移植 [kp.py L1483-1610](file:///e:/s/wol/py/q3/src/kp.py#L1483) `get_disk_free_batch` + 30s 缓存到 `engines/kp_bridge.py`（新增），通过 broker 协议曝光

### Task 6: q1 WYSIWYG 三件套强化（Monaco 等价 vscode UX）

文件：
- 改 [editor.js build()](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/editor.js#L106) 和 [openInPane()](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/editor.js#L193)：编辑器创建完后 hook `window.qqqCodeLens.attach(ed)` / `qqqDecoration.attach(ed)` / `qqqPaste.attach(ed)` / `qqqViewZone.attach(ed)`（改成多实例支持，不再依赖单一 `_editorRef`）
- 新建 `server-app/core/qqq-viewzone.js`：核心新增模块。扫描 `/\ path \/` token：
  - 若 token 单独占一行（前后只有空白）→ 用 `editor.changeViewZones` 插入 view zone 显示完整图片/视频播放器（相框）
  - 否则 → 在 token 处插入 content widget 显示 16x16 缩略图（图标框）
  - thumbnail 通过 `bridge.media.thumb` 异步生成，hash 缓存
  - 视频用 `<video controls>` 直接 src 指向 `qqq-asset:` 协议代理过的本地文件（main.ts 已有 protocol，扩展支持本地任意路径需加白名单）
- 改 [main.ts protocol handler](file:///e:/s/wol/py/qqq-shell-v2/shell/main.ts#L313)：加 `qqq-asset://file/<encoded-abs-path>` 资源类型，支持读任意本地文件（带路径白名单 = 用户工作目录 + cache 目录）
- 改 [qqq-paste.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/qqq-paste.js)：
  - 图片粘贴：blob → `hash.buffer` → 若 cache 命中 → 直接用现有路径；否则按 hash 命名落到当前文件目录或 `cache/paste/`
  - 文件粘贴：同上，按 mime 分类
  - 文本粘贴：HTML rich text 也走 sniff → 抽取图片下载 + 内联（抄 q1 的 sniff 算法）
  - 任何路径粘贴：直接生成 `/\ path \/` token，不复制文件
- 改 [qqq-codelens.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/qqq-codelens.js)：保留 open/folder/copy 三个 lens；新增视频 URL 时 lens "download"（合并 qqq-video.js 进来）；新增 "transcode" lens（对视频/音频）
- 改 [qqq-decoration.js](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/qqq-decoration.js)：保留高亮逻辑，去除 inline 高亮当 token 在 view zone 模式下（避免重叠）

### Task 7: 模块装配 + boot 时序

文件：
- 改 [server-app/index.html](file:///e:/s/wol/py/qqq-shell-v2/server-app/index.html)：新增 script 引入顺序：
  ```
  core/key-hook.js
  core/cache-shim.js       (renderer 端的 bridge.cache 薄包装)
  core/qqq-viewzone.js
  ```
- 改 [shell.js main()](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/shell.js#L528)：
  - boot 时 fetch `core/key-bindings.json` → `keyHook.init(bindings)`
  - `keyHook.onCmd((cmd) => handleMenuCmd(cmd))` 同一 dispatcher
  - 移除 [shell.js L457-479](file:///e:/s/wol/py/qqq-shell-v2/server-app/core/shell.js#L457) Ctrl+\ 的硬编码 keydown，迁移到 key-bindings.json

### Task 8: 验证清单（必跑）

- [ ] 启动后 Roam 盘符显示 `C:\ 0.79 GB` / `D:\ 19.2 GB` 等真实剩余空间，30s 后再次刷新
- [ ] Desktop 行显示已用 MB，Recycle Bin 显示已用 MB（kp.py 算法）
- [ ] 在 Roam iframe 中按 Q / W / 1 / 2 / Space 全部生效
- [ ] Tab 键焦点跳到 Roam，Space+Q 即便焦点在编辑器也能弹出 Roam（globalShortcut）
- [ ] 在编辑器中粘贴 `Win+Shift+S` 截图 → 自动落地 `paste_xxx.png` 并显示相框
- [ ] 粘贴 `E:\s\wol\py\q3\assets\q.gif` → 显示 gif 相框
- [ ] 粘贴 `F:\q\unifont_upper-17.0.04.otf` → 显示图标框 + 文件名
- [ ] CodeLens "open" / "folder" / "copy" / "download video" 全部点击有效
- [ ] 同一图片粘贴两次 → 第二次走 cache 命中，磁盘只一份
- [ ] 视频缩略图 ffmpeg 生成成功并缓存
- [ ] DevTools 通过菜单或 F12 在独立窗口打开

## 不在本轮范围（明确）

- ghrun.exe 本体编译（先用 runner.py 兜底，等 Rust 工程拉起来再切）
- QDIR 环境变量全面注入（先用 `portable.root` 派生，等 manifest.json 远端拉取上线再统一）
- gaea 商城 verify / snapshot / vsix 安装
- vscode-loc 13 语言合并（i18n 后续轮次）

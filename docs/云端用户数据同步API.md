# 云端用户数据同步 API 规范

## 概述

客户端（VS Code 扩展）需要两个 API：上传（Push）和下载（Pull）用户偏好数据。
客户端在上传前会先 Pull 一次做本地合并，所以**云端不需要做任何合并逻辑**——云端只管存取。

---

## 基础信息

| 项目 | 值 |
|------|-----|
| Base URL | `https://gh555.com/api` |
| Content-Type | `application/json` |
| 鉴权方式 | 浏览器登录换取永久 token，请求体携带 `token` + `device_name` |

---

## 认证体系

### 流程概述

IDE 端首次上传/下载时，**自动打开浏览器**（无需用户确认）跳转到 gh555.com 登录页，用户在浏览器中完成登录（复用现有的 200+ 国家区号选择、验证码 UI），登录成功后 IDE 通过轮询自动获取 token，全程零额外点击。

token 仅在以下情况失效：
- 用户换绑手机号
- 用户在网页端主动将该设备下线

### 完整流程

```
IDE端                         浏览器                       服务器
 │                              │                            │
 │  1. 生成 session_id           │                            │
 │  2. 打开浏览器:              │                            │
 │     gh555.com/login?         │                            │
 │     from=ide&session=xxx     │                            │
 │     &device_name=cursor_Win_x64                            │
 │──────────────────────────►│                            │
 │                              │── 用户正常登录 ────────►│
 │                              │◄─ 登录成功, 写入临时缓存 ─│
 │                              │   (session_id → token)     │
 │                              │                            │
 │  3. 每2秒轮询:              │                            │
 │──── GET /auth/poll?session=xxx ─────────────────────►│
 │◄── {ok:false} (pending)       │                            │
 │──── GET /auth/poll?session=xxx ─────────────────────►│
 │◄── {ok:true, token:"xxx", phone:"138..."}              │
 │                              │                            │
 │  4. 存储 token 到 ~/.qqq/auth.json                          │
 │  5. 后续请求携带 token                                    │
```

### API A1: 登录页入口（前端页面）

IDE 打开的 URL 格式：

```
https://gh555.com/login?from=ide&session={session_id}&device_name={device_name}
```

| 参数 | 说明 |
|------|------|
| `from` | 固定值 `ide`，服务器以此识别 IDE 登录 |
| `session` | IDE 生成的 32 位随机 hex，唯一标识本次登录会话 |
| `device_name` | `{IDE品类}_{OS}_{arch}`，如 `cursor_Win_x64` |

登录页识别 `from=ide` 后，服务器应根据用户是否已登录走不同路径：

**快速路径（浏览器已登录，通过 cookie 识别）：**
1. 跳过登录表单，直接生成永久 token
2. 将 `(session_id → {token, phone, device_name})` 写入临时缓存（Redis/内存，5分钟过期）
3. 同时将 `(token, device_name, phone)` 插入设备表（同现有 PC/Android 设备逻辑）
4. 页面显示“已授权 IDE 设备，可关闭此页面”

**常规路径（浏览器未登录）：**
1. 显示正常登录表单（200+ 国家区号、验证码等）
2. 登录成功后同上述快速路径步骤 1-4

> 注：只管默认浏览器。多浏览器多账号场景不处理，用户默认浏览器里登的哪个号就关联哪个号。没有浏览器的用户不支持该功能。

### IDE 端浏览器选择策略（服务器无需关心）

IDE 端打开浏览器时采用 3 级降级：

| 优先级 | 方式 | 说明 |
|--------|------|------|
| Tier 1 | `vscode.env.openExternal()` | 系统默认浏览器，99% 场景 |
| Tier 2 | 内置 Chrome | 视频增强流程已下载维护的 Chrome，无外部浏览器时自动启用 |
| Tier 3 | 拒绝 | Tier 1 + Tier 2 都失败，提示用户安装浏览器 |

### API A2: 轮询 token

#### `GET /api/gaea/qqq/auth/poll?session={session_id}`

IDE 每 2 秒调用一次，超时 3 分钟放弃。

#### 未登录（继续轮询）

```json
{ "ok": false }
```

#### 登录成功

```json
{
  "ok": true,
  "token": "a3f8e2d1-b4c5-6789-...",
  "phone": "13800138000"
}
```

- token 为 UUID 或任意不可预测字符串，由服务器生成并持久化
- **该 token 永不自动过期**，但可被用户在网页端手动注销
- 返回 token 后，服务器应立即删除该 session_id 的临时缓存（一次性）

#### session 不存在或已过期

```json
{ "ok": false, "error": "session_expired" }
```

### 设备管理集成

验证成功时，服务器应将该 `device_name` + `token` 作为一条在线设备记录，
与现有的 PC/Android 设备列表统一管理：

- **显示名称**：直接用 `device_name`（如 `cursor_Win_x64`）替代浏览器端的 `Win10_20260429_2052__3840x2160__...` 风格字符串
- **设备类型**：新增 `ide` 类型，与 `pc` / `android` 并列
- **下线能力**：用户在网页端点击"下线"时，服务器将该 token 标记为失效；IDE 下次请求会收到 `auth_failed`，自动清除本地 token 并重新要求验证
- **最后活跃时间**：每次 push/pull 请求时更新该设备的 `last_active_at`

---

## 数据模型

每个用户（以 `phone` 为主键）存储 **3 个 blob**：

| blob key | 描述 | 配额上限 | 存储格式 |
|----------|------|---------|----------|
| `roam_config` | Roam 文件管理器偏好（pin 目录、qq 区列表等） | 50 KB | JSON |
| `roam_folder_prefs` | 每个文件夹的显示偏好（排序、显示模式） | 500 KB | JSON |
| `clipboard_history` | 剪贴板历史（二进制 msgpack+gzip） | 5 MB | Base64 编码的 gzip 二进制 |

### 存储结构（参考）

```
user_data 表:
  phone         VARCHAR(20) PRIMARY KEY
  roam_config   JSON / TEXT      -- 存原样 JSON
  roam_folder_prefs  JSON / TEXT -- 存原样 JSON
  clipboard_history  LONGTEXT    -- 存 base64 字符串
  updated_at    BIGINT           -- 最后更新时间戳(秒)
```

---

## API 1: 上传（Push）

### `POST /api/gaea/qqq/user-data`

客户端已在本地完成合并（Pull-Merge-Push），推送最终结果给云端。
**云端直接覆盖写入即可，无需合并。**

#### 请求体

```json
{
  "token": "a3f8e2d1-b4c5-6789-...",
  "device_name": "cursor_Win_x64",
  "blobs": {
    "roam_config": {
      "v": 1,
      "ts": 1714900000,
      "data": {
        "pinnedDirs": ["/home/user/projects", "/tmp/work"],
        "qqiq": [{"path": "/home/user/projects", "label": "Projects"}],
        "lineSpacing": 1.4,
        "sidebarWidth": 260,
        "sidebarRatio": 0.35,
        "isPinned": true
      }
    },
    "roam_folder_prefs": {
      "v": 1,
      "ts": 1714900000,
      "data": {
        "/home/user/projects": {"szMode": "compact", "sortBy": "name", "ts": 1714899000},
        "/tmp/work": {"szMode": "detail", "sortBy": "mtime", "ts": 1714898000}
      }
    },
    "clipboard_history": {
      "v": 1,
      "ts": 1714900000,
      "data_b64gz": "H4sIAAAAAAAAA6tWKkktLlGyUlAqS..."
    }
  }
}
```

#### 成功响应 `200`

```json
{
  "ok": true
}
```

#### 失败响应 `200`（业务错误用 ok:false，HTTP 始终 200）

```json
{
  "ok": false,
  "error": "not_purchased"
}
```

#### 错误码

| error 值 | 含义 | 触发条件 |
|----------|------|---------|
| `not_purchased` | 未激活云同步 | 用户未购买/未激活正版 |
| `phone_not_registered` | 手机号未注册 | phone 不在系统中 |
| `auth_failed` | token 无效或已注销 | token 过期/被网页端下线/不存在 |
| `rate_limit` | 频率限制 | 同一用户短时间内请求过多（建议 ≤ 1次/分钟） |
| `quota_exceeded` | 超出配额 | 某个 blob 超过配额上限 |

---

## API 2: 下载（Pull）

### `POST /api/gaea/qqq/user-data/pull`

客户端请求拉取云端已存储的数据。

#### 请求体

```json
{
  "token": "a3f8e2d1-b4c5-6789-...",
  "device_name": "cursor_Win_x64",
  "keys": ["roam_config", "roam_folder_prefs", "clipboard_history"]
}
```

- `keys`：指定要拉取哪些 blob。客户端目前固定传全部 3 个。

#### 成功响应 `200`（有数据）

```json
{
  "ok": true,
  "blobs": {
    "roam_config": {
      "v": 1,
      "ts": 1714900000,
      "data": { ... }
    },
    "roam_folder_prefs": {
      "v": 1,
      "ts": 1714900000,
      "data": { ... }
    },
    "clipboard_history": {
      "v": 1,
      "ts": 1714900000,
      "data_b64gz": "H4sIAAAAAAAAA6tWKkktLlGyUlAqS..."
    }
  }
}
```

#### 成功响应 `200`（无数据）

用户从未上传过：

```json
{
  "ok": true,
  "blobs": {}
}
```

#### 失败响应

同上传的错误码格式一致。

---

## 云端实现要点

### 1. 核心逻辑极简

云端只是一个 **KV 存储**：
- Push = 按 phone 写入 3 个字段
- Pull = 按 phone 读出 3 个字段

**不需要做任何合并、diff、冲突处理**——客户端已经处理完了。

### 2. 配额校验

上传时检查每个 blob 的大小：
- `roam_config`: JSON.stringify(data) ≤ 50KB
- `roam_folder_prefs`: JSON.stringify(data) ≤ 500KB
- `clipboard_history`: Base64 解码后 ≤ 5MB（base64 字符串本身约 6.67MB）

超出返回 `{"ok": false, "error": "quota_exceeded"}`。

### 3. 权限校验

- 根据请求体中的 `token` 查找对应用户
- token 无效或已被注销 → `auth_failed`
- 用户未激活 → `not_purchased`
- 验证通过后按 token 对应的 phone 读写数据

### 4. 频率限制

建议：同一 phone，每分钟最多 2 次 push、5 次 pull。超出返回 `rate_limit`。

### 5. 存储建议

| 方案 | 适用场景 |
|------|---------|
| MySQL/PostgreSQL + LONGTEXT/JSONB | 用户量 < 10万，简单直接 |
| Redis + 持久化 | 需要极低延迟 |
| 对象存储 (S3/OSS) | clipboard_history 较大时，JSON 字段存 MySQL，binary 存 OSS |

**推荐起步方案**：单表 MySQL，3 个 TEXT 列 + updated_at。够用到 10 万用户无压力。

### 6. device_name 与设备管理

- `device_name` 由 IDE 端生成，格式固定为 `{IDE品类}_{OS}_{arch}`
- 验证码验证成功时，将 (token, device_name, phone) 作为一条设备记录插入
- 在"已登录设备"列表中，IDE 设备直接显示 `device_name`（如 `cursor_Win_x64`）
- 设备类型标记为 `ide`，与现有 `pc` / `android` 并列
- 用户点击"下线"时，将该 token 标记失效
- 每次收到 push/pull 请求时更新该设备的 `last_active_at`

---

## 完整时序图

```
客户端(IDE)                           云端
  │                                  │
  │  [首次: 无本地token]              │
  │── 打开浏览器 gh555.com/login ──►│  (用户在浏览器完成登录)
  │                                  │
  │──── GET /auth/poll?session=xxx ──►│  (每2秒轮询)
  │◄─── {ok:true, token:"xxx"} ─────│
  │                                  │
  │  [存储 token 到本地]              │
  │                                  │
  │──── POST /user-data/pull ───────►│  (携带 token + device_name)
  │◄─── {ok:true, blobs:{...}} ─────│
  │                                  │
  │  [本地合并: local ∪ cloud]        │
  │                                  │
  │──── POST /user-data ────────────►│  (推送合并后的结果)
  │◄─── {ok:true} ──────────────────│
  │                                  │
```

---

## 测试用例建议

1. **首次上传**：Pull 返回空 blobs → 客户端直接 Push 本地数据
2. **正常合并**：Pull 返回有数据 → 客户端合并后 Push（验证 blobs 变大或不变，不会变小）
3. **未注册用户**：返回 `phone_not_registered`
4. **未激活用户**：返回 `not_purchased`
5. **超配额**：Push 一个 6MB 的 clipboard_history → 返回 `quota_exceeded`
6. **频率限制**：连续 Push 3 次 → 第 3 次返回 `rate_limit`
7. **部分 keys**：Pull 时 keys 只传 `["roam_config"]` → 只返回该 blob
8. **认证流程**：IDE 打开浏览器 → 用户登录 → poll 返回 token → 后续 push/pull 携带 token
9. **token 失效**：网页端下线设备后，IDE 请求返回 `auth_failed` → 客户端清除本地 token 并重新打开浏览器登录
10. **设备显示**：IDE 设备在"已登录设备"列表中显示为 `cursor_Win_x64` 等格式

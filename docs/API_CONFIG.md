# QQQ 配置同步 API 规范 v1.0

> 本文档定义客户端与服务器之间的配置同步协议，双方严格遵守此规范。

---

## 1. 接口概览

| 项目 | 值 |
|------|-----|
| Endpoint | `POST /api/gaea/qqq/config` |
| Content-Type | `application/json` |
| 用途 | 客户端拉取用户云端配置 |

---

## 2. 请求格式

```json
{
  "phone": "13800138000",
  "device_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| phone | string | ✅ | 用户手机号 |
| device_id | string | ✅ | 设备唯一标识 (UUID) |

---

## 3. 响应格式

### 3.1 成功响应

```json
{
  "ok": true,
  "phone": "+86138****5678",
  "settings": { ... },
  "v": 1
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| ok | boolean | 固定 `true` |
| phone | string | 脱敏手机号（带国家码，中间4位用*，如 `+86138****5678`） |
| settings | object | 配置项，见第4节 |
| v | integer | Schema 版本号，当前固定 `1` |

### 3.2 失败响应

```json
{
  "ok": false,
  "phone": "+86138****5678",
  "error": "not_purchased"
}
```

### 3.3 错误码

| error | 含义 | 客户端提示 |
|-------|------|-----------|
| `phone_not_registered` | 手机号未注册 | "该手机号未注册" |
| `not_purchased` | 已注册但未购买 | "该账号未激活云同步" |
| `invalid_phone` | 手机号格式错误 | "手机号格式错误" |
| `rate_limit` | 请求太频繁（合并 min/hour） | "请求太频繁，请稍后再试" |
| `too_many_accounts` | 今日切换账号过多 | "今日切换账号太多，请明天再试" |

---

## 4. Settings 字段完整定义

### 4.1 默认模板（22项）

服务器对**未付费用户**或**用户从未保存过配置**时，返回此默认模板：

```json
{
  "ok": true,
  "settings": {
    "theme": "auto",
    "language": "中文",
    "performanceMode": "optmum",
    "ioEngine": "v16  auto",
    "transactionLevel": "half",
    "szDisplayMode": "nothing",
    "sortBy": "name",
    "autoWatchChanges": false,
    "roamAsStartPage": true,
    "roamName": "的梦gaea",
    "frameSizeMode": "fix",
    "cleanFreak": "add",
    "enlargeSmallImages": false,
    "textSlideColorScheme": "light",
    "textSlideFontSize": 14,
    "codelensLevel": "3",
    "takeOverCodelensStyle": true,
    "downloadSecurityLevel": "1: 平衡",
    "forceTextFlowScheme": false,
    "autoDownload": true,
    "docExportImageResolution": "original",
    "docExportIncludeCipher": true
  },
  "v": 1
}
```

### 4.2 字段 Schema

| 字段 | 类型 | 合法值 | 默认值 |
|------|------|--------|--------|
| `theme` | string | `"auto"` `"dark"` `"solarize light"` | `"auto"` |
| `language` | string | `"中文"` `"繁體中文"` `"English"` `"日本語"` `"Deutsch"` `"Русский"` `"العربية"` `"한국어"` `"Español"` `"Français"` `"Português BR"` | `"中文"` |
| `performanceMode` | string | `"extreme"` `"accelerated"` `"optmum"` | `"optmum"` |
| `ioEngine` | string | `"v16  auto"` `"Exclude Python"` | `"v16  auto"` |
| `transactionLevel` | string | `"full"` `"half"` | `"half"` |
| `szDisplayMode` | string | `"nothing"` `"size"` `"ctime"` `"mtime"` | `"nothing"` |
| `sortBy` | string | `"name"` `"size"` `"ctime"` `"mtime"` | `"name"` |
| `autoWatchChanges` | boolean | `true` `false` | `false` |
| `roamAsStartPage` | boolean | `true` `false` | `true` |
| `roamName` | string | 任意字符串 | `"的梦gaea"` |
| `frameSizeMode` | string | `"large"` `"small"` `"fix"` | `"fix"` |
| `cleanFreak` | string | `"never"` `"add"` `"add & remove"` | `"add"` |
| `enlargeSmallImages` | boolean | `true` `false` | `false` |
| `textSlideColorScheme` | string | `"light"` `"dark"` | `"light"` |
| `textSlideFontSize` | integer | `1` ~ `218` | `14` |
| `codelensLevel` | string | `"0"` `"1"` `"3"` | `"3"` |
| `takeOverCodelensStyle` | boolean | `true` `false` | `true` |
| `downloadSecurityLevel` | string | `"0: 最宽松"` `"1: 平衡"` `"2: 最严格"` | `"1: 平衡"` |
| `forceTextFlowScheme` | boolean | `true` `false` | `false` |
| `autoDownload` | boolean | `true` `false` | `true` |
| `docExportImageResolution` | string | `"original"` `"frame"` | `"original"` |
| `docExportIncludeCipher` | boolean | `true` `false` | `true` |

---

## 5. 兼容性约定

### 5.1 客户端行为

| 场景 | 客户端处理 |
|------|-----------|
| 响应包含**未知字段** | **忽略**（向前兼容，服务器可先行添加新字段） |
| 响应**缺少某字段** | 使用 package.json 中定义的默认值 |
| 字段值**不在合法范围** | 使用默认值，不报错 |

### 5.2 服务器行为

| 场景 | 服务器处理 |
|------|-----------|
| 用户从未保存配置 | 返回 `ok: true` + 默认模板 |
| 用户已保存配置 | 返回 `ok: true` + 用户配置 |
| 用户未注册 | 返回 `ok: false` + `error: "phone_not_registered"` |
| 用户未购买 | 返回 `ok: false` + `error: "not_purchased"` |
| 存储时收到未知字段 | **丢弃**（只存已定义的 22 个字段） |

### 5.3 版本升级

当客户端新增配置项时：
1. 客户端代码添加新字段及默认值
2. 更新本文档
3. 服务器按需添加新字段到数据库
4. **无需**同步发版，因为客户端对缺失字段自动用默认值

---

## 6. 验证规则（客户端实现）

客户端仅做**轻量验证**，不阻断流程：

```
对每个字段:
  if 类型错误 → 用默认值
  if enum型且值不在列表 → 用默认值
  if number型且超出范围 → 用默认值
  if 字段缺失 → 用默认值
```

**不报错、不弹窗**，静默降级。

---

## 7. 通信优化

| 优化点 | 说明 |
|--------|------|
| **无增量同步** | 每次拉取完整配置，避免复杂的 diff 逻辑 |
| **无压缩** | 22 字段 JSON 约 800 字节，无需 gzip |
| **无签名** | 配置非敏感数据，无需加密/签名 |
| **单向拉取** | 客户端只拉不推（推送由其他接口处理） |

---

## 8. 示例：完整交互流程

```
┌─────────┐                         ┌─────────┐
│ Client  │                         │ Server  │
└────┬────┘                         └────┬────┘
     │  POST /api/gaea/qqq/config        │
     │  {"phone":"138...","device_id":"x"}│
     │ ─────────────────────────────────►│
     │                                    │
     │    {"ok":true,"phone":"+86138****5678","settings":{...},"v":1}
     │ ◄─────────────────────────────────│
     │                                    │
     │  [客户端验证 settings]             │
     │  [应用到 globalState]              │
     │  [静默成功 / 失败弹窗]             │
```

---

## 9. Checklist

服务器实现时确认：

- [ ] 返回 `Content-Type: application/json`
- [ ] `ok` 字段为布尔型
- [ ] `phone` 字段为脱敏手机号（带国家码，中间4位用`*`替换，如 `+86138****5678`）
- [ ] `settings` 字段包含全部 22 项（可选：只返回用户修改过的项）
- [ ] `v` 字段为整数（当前固定返回 `1`）
- [ ] 错误时 `error` 字段为上述错误码之一
- [ ] 用户未注册返回 `phone_not_registered`，未购买返回 `not_purchased`
- [ ] 已购买但从未保存配置时返回默认模板（而非 404）

---

**文档版本**: 1.1
**最后更新**: 2026-05-05
**维护者**: QQQ 客户端 & 服务端

---

## 附录 A：v1.1 变更 — 新增 `theme` 字段

### A.1 背景

客户端 v16.x 新增了面板主题色选择功能（`qqq.theme`），允许用户选择面板配色方案。该配置项属于正版用户云同步配置，需要服务端在 `settings` 中新增 `theme` 字段的存储与下发。

### A.2 新增字段

| 字段 | 类型 | 合法值 | 默认值 | 说明 |
|------|------|--------|--------|------|
| `theme` | string | `"auto"` `"dark"` `"solarize light"` | `"auto"` | 面板主题色 |

### A.3 各枚举值含义

| 值 | 行为 |
|----|------|
| `"auto"` | 跟随 VS Code 当前配色方案自动切换明暗 |
| `"dark"` | 强制暗色面板（暖色调，无蓝色元素） |
| `"solarize light"` | 强制亮色面板（经典暖色调） |

### A.4 i18n 展示文案（中文，与客户端 package.nls.zh-cn.json 一致）

| 位置 | 文案 |
|------|------|
| 设置分类标题 | 👁️ 观察 |
| 配置项描述 | 👁️ 面板主题： |
| 枚举：auto | 自动：跟随 VS Code 配色方案 |
| 枚举：dark | 暗色：暖色调暗色面板（无蓝色元素） |
| 枚举：solarize light | Solarize Light：经典暖色亮色面板 |

### A.5 服务端所需操作

1. **数据库**：在用户配置表中新增 `theme` 列（`VARCHAR(20) DEFAULT 'auto'`）
2. **写入**：客户端修改 theme 后会通过现有配置保存接口上传，服务端校验值在 `["auto", "dark", "solarize light"]` 白名单内，否则忽略
3. **读取**：`POST /api/gaea/qqq/config` 响应的 `settings` 对象中始终包含 `theme` 字段（用户从未设置过则返回默认值 `"auto"`）
4. **兼容**：老客户端收到 `theme` 字段会自动忽略（未知字段走默认值逻辑），无破坏性

### A.6 ALTER TABLE 参考

```sql
ALTER TABLE <配置表>
  ADD COLUMN IF NOT EXISTS theme VARCHAR(20) NOT NULL DEFAULT 'auto';
```

### A.7 校验规则

| 检查项 | 规则 |
|--------|------|
| 类型 | string |
| 合法值白名单 | `auto`, `dark`, `solarize light` |
| 非法值处理 | 丢弃，使用默认值 `"auto"` |

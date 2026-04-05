# 履历（Resume）上报协议 — 服务端接入文档

> 客户端：qqq VS Code 扩展
> 服务端：Go + PostgreSQL + Redis
> 版本：v1.0 draft

---

## 一、概述

客户端本地已持久化记录大量功能使用统计（音乐播放、粘贴、下载、漫游等），现需上报至服务端，构建用户"履历"用于展示和排行。

**设计原则：**
- 搭便车：复用现有 `POST /api/wq/ping` 通道，新增可选字段 `resume`，无需额外定时器
- 幂等覆盖：每次上报的是**全量快照**（非增量），服务端直接覆盖，无需合并逻辑
- 极简：客户端只管把 globalState 里的原始数值塞进去，所有派生计算（日均、排名）由服务端完成

---

## 二、通信格式

### 2.1 请求（客户端 → 服务端）

在现有 ping 请求体中新增可选字段 `resume`：

```jsonc
POST /api/wq/ping
Content-Type: application/json

{
  // ── 现有字段（不变）──
  "good_slg":      "qqq",
  "device_id":     "550e8400-e29b-41d4-a716-446655440000",
  "total_seconds": 360000,
  "event_time":    1712345678,
  "ide_family":    "qoder",
  "client_ver":    "16.0.11",
  "doer_id":       "15802858204",       // 可选

  // ── 新增字段 ──
  "resume": {
    "savor":    { "n": 42,  "ms": 9120000, "t0": 1710000000 },
    "paste":    { "n": 318, "b": 209715200, "t0": 1709500000 },
    "video":    { "n": 12,  "b": 3221225472, "t0": 1710200000 },
    "roam":     { "n": 67,  "fc": 435, "t0": 1709800000 },
    "weave":    { "n": 5,   "t0": 1711000000 },
    "export_doc": { "n": 3, "t0": 1711200000 },
    "export_zip": { "n": 1, "t0": 1712000000 },
    "pure":     { "n": 8,   "t0": 1711500000 },
    "copy":     { "n": 12450 },
    "cache":    { "hit": 28300, "miss": 1720 }
  }
}
```

### 2.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `resume` | object | 否 | 整个对象可选。客户端只在有统计数据时才附带 |

`resume` 内部每个 key 代表一个功能模块，value 的通用字段：

| 缩写 | 全称 | 类型 | 说明 |
|------|------|------|------|
| `n` | count | int | 累计使用次数 |
| `ms` | milliseconds | int64 | 累计时长（毫秒），仅 savor 有 |
| `b` | bytes | int64 | 累计字节数，paste/video 有 |
| `fc` | files_created | int | 创建文件数，仅 roam 有 |
| `t0` | first_use_at | int64 | 首次使用的 Unix 时间戳（秒） |
| `hit` | cache_hits | int | 缓存命中总次数，仅 cache 有 |
| `miss` | cache_misses | int | 缓存未命中总次数，仅 cache 有 |

### 2.3 各功能模块字段矩阵

| 模块 key | `n` | `ms` | `b` | `fc` | `t0` | `hit` | `miss` | 说明 |
|----------|-----|------|-----|------|------|-------|--------|------|
| `savor` | ✓ | ✓ | | | ✓ | | | 音乐播放器 |
| `paste` | ✓ | | ✓ | | ✓ | | | 无缝粘贴 |
| `video` | ✓ | | ✓ | | ✓ | | | 视频下载 |
| `roam` | ✓ | | | ✓ | ✓ | | | q2 文件漫游 |
| `weave` | ✓ | | | | ✓ | | | 编织功能 |
| `export_doc` | ✓ | | | | ✓ | | | 导出文档 |
| `export_zip` | ✓ | | | | ✓ | | | 导出 Zip |
| `pure` | ✓ | | | | ✓ | | | Pure 功能 |
| `copy` | ✓ | | | | | | | 复制总次数（无 t0） |
| `cache` | | | | | | ✓ | ✓ | 缓存命中统计 |

### 2.4 不建议上报的数据

| 数据 | 原因 |
|------|------|
| 性能指标（avg_save_ms 等） | 会话级瞬态值，每次重启归零，噪声大、对履历无意义 |
| quarantined_files | 内部实现细节，用户无感知 |
| allSettings 打开次数 | 属于 UI 操作噪声，不构成"履历"价值 |
| 剪贴板当前条数 | 瞬态值，非累计量 |
| 音频播放状态 | 实时状态，非统计量 |

---

## 三、响应格式

服务端无需为 resume 返回额外数据，沿用现有 ping 响应即可：

```jsonc
{
  "ok": true,
  "min_next_ping_at": 1712389078,
  "delta_seconds": 43200,
  "accepted_total_seconds": 360000,
  // ... 其他现有字段
}
```

若未来需要服务端返回履历排名等信息，可在响应中新增 `resume_rank` 字段，但初期不需要。

---

## 四、服务端处理逻辑

### 4.1 处理流程（在现有 ping handler 中扩展）

```
收到 POST /api/wq/ping
  ├── 现有逻辑：限流 → 事务写入 device_state/ping_log → 返回
  │
  └── 新增：if body.resume != nil {
         upsertDeviceResume(device_id, doer_id, resume)
      }
```

### 4.2 写入时机

- resume 数据写入与 ping_log 写入在**同一事务**中完成
- 限流命中时（60s 去重），**同样跳过** resume 写入（避免无意义写入）
- resume 写入是幂等的 UPSERT（INSERT ON CONFLICT UPDATE）

---

## 五、PostgreSQL 表设计

### 5.1 主表：`wq.device_resume`

```sql
CREATE TABLE wq.device_resume (
    device_id    UUID        NOT NULL,
    good_int     BIGINT      NOT NULL DEFAULT 1,  -- good_slg 的整数映射

    -- 音乐播放
    savor_n      INT         NOT NULL DEFAULT 0,
    savor_ms     BIGINT      NOT NULL DEFAULT 0,
    savor_t0     BIGINT,                           -- Unix 秒，NULL = 从未使用

    -- 粘贴
    paste_n      INT         NOT NULL DEFAULT 0,
    paste_b      BIGINT      NOT NULL DEFAULT 0,
    paste_t0     BIGINT,

    -- 视频下载
    video_n      INT         NOT NULL DEFAULT 0,
    video_b      BIGINT      NOT NULL DEFAULT 0,
    video_t0     BIGINT,

    -- 漫游
    roam_n       INT         NOT NULL DEFAULT 0,
    roam_fc      INT         NOT NULL DEFAULT 0,
    roam_t0      BIGINT,

    -- 编织
    weave_n      INT         NOT NULL DEFAULT 0,
    weave_t0     BIGINT,

    -- 导出
    export_doc_n INT         NOT NULL DEFAULT 0,
    export_doc_t0 BIGINT,
    export_zip_n INT         NOT NULL DEFAULT 0,
    export_zip_t0 BIGINT,

    -- Pure
    pure_n       INT         NOT NULL DEFAULT 0,
    pure_t0      BIGINT,

    -- 复制
    copy_n       INT         NOT NULL DEFAULT 0,

    -- 缓存
    cache_hit    INT         NOT NULL DEFAULT 0,
    cache_miss   INT         NOT NULL DEFAULT 0,

    -- 元数据
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (good_int, device_id)
);
```

**为什么用扁平列而不用 JSONB：**
- 方便聚合查询（SUM、AVG、排行榜）
- 索引友好
- 数据量固定，列数可控（~20 列）
- 类型安全，避免运行时类型错误

### 5.2 索引

```sql
-- 按用户查履历（通过 device_state 表的 doer_id 关联）
-- 不在 wq.device_resume 中冗余 doer_id，通过 JOIN device_state 获取

-- 排行榜查询优化（按需建立）
CREATE INDEX idx_resume_savor_n ON wq.device_resume (good_int, savor_n DESC) WHERE savor_n > 0;
CREATE INDEX idx_resume_paste_n ON wq.device_resume (good_int, paste_n DESC) WHERE paste_n > 0;
CREATE INDEX idx_resume_video_n ON wq.device_resume (good_int, video_n DESC) WHERE video_n > 0;
```

### 5.3 UPSERT 语句

```sql
INSERT INTO wq.device_resume (
    good_int, device_id,
    savor_n, savor_ms, savor_t0,
    paste_n, paste_b, paste_t0,
    video_n, video_b, video_t0,
    roam_n, roam_fc, roam_t0,
    weave_n, weave_t0,
    export_doc_n, export_doc_t0,
    export_zip_n, export_zip_t0,
    pure_n, pure_t0,
    copy_n,
    cache_hit, cache_miss
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
ON CONFLICT (good_int, device_id) DO UPDATE SET
    savor_n      = EXCLUDED.savor_n,
    savor_ms     = EXCLUDED.savor_ms,
    savor_t0     = COALESCE(wq.device_resume.savor_t0, EXCLUDED.savor_t0),  -- 保留最早的 t0
    paste_n      = EXCLUDED.paste_n,
    paste_b      = EXCLUDED.paste_b,
    paste_t0     = COALESCE(wq.device_resume.paste_t0, EXCLUDED.paste_t0),
    video_n      = EXCLUDED.video_n,
    video_b      = EXCLUDED.video_b,
    video_t0     = COALESCE(wq.device_resume.video_t0, EXCLUDED.video_t0),
    roam_n       = EXCLUDED.roam_n,
    roam_fc      = EXCLUDED.roam_fc,
    roam_t0      = COALESCE(wq.device_resume.roam_t0, EXCLUDED.roam_t0),
    weave_n      = EXCLUDED.weave_n,
    weave_t0     = COALESCE(wq.device_resume.weave_t0, EXCLUDED.weave_t0),
    export_doc_n = EXCLUDED.export_doc_n,
    export_doc_t0= COALESCE(wq.device_resume.export_doc_t0, EXCLUDED.export_doc_t0),
    export_zip_n = EXCLUDED.export_zip_n,
    export_zip_t0= COALESCE(wq.device_resume.export_zip_t0, EXCLUDED.export_zip_t0),
    pure_n       = EXCLUDED.pure_n,
    pure_t0      = COALESCE(wq.device_resume.pure_t0, EXCLUDED.pure_t0),
    copy_n       = EXCLUDED.copy_n,
    cache_hit    = EXCLUDED.cache_hit,
    cache_miss   = EXCLUDED.cache_miss,
    updated_at   = NOW();
```

> **`COALESCE(旧值, 新值)` 保护 t0**：首次使用时间戳只写入一次，防止客户端清除 globalState 后丢失历史 t0。

---

## 六、Redis 缓存策略

### 6.1 用途

Redis 只用于两个场景：

**场景 A：限流去重（复用现有）**
```
Key:    wq:rl:{good_int}:{device_id}
TTL:    60s
```
现有 ping 限流机制已覆盖，resume 搭便车，无需额外 Redis 逻辑。

**场景 B：排行榜缓存**
采用与现有 `countryOnlineCache` 相同的模式：
- 定时任务（如每 5 分钟）从 PG 聚合查询排行数据
- 结果缓存在 Go 进程内存中（sync.Map 或普通 map + RWMutex）
- API 请求直接读内存缓存，不查 PG
- 不引入 Redis 新复杂度

---

## 七、Go 结构体参考

```go
// ResumeFeature 通用功能统计
type ResumeFeature struct {
    N    int    `json:"n"`              // 次数
    Ms   *int64 `json:"ms,omitempty"`   // 时长(毫秒)，仅 savor
    B    *int64 `json:"b,omitempty"`    // 字节数，paste/video
    Fc   *int   `json:"fc,omitempty"`   // 文件数，仅 roam
    T0   *int64 `json:"t0,omitempty"`   // 首次使用 Unix 秒
}

// ResumeCopyStats 复制统计
type ResumeCopyStats struct {
    N int `json:"n"`
}

// ResumeCacheStats 缓存统计
type ResumeCacheStats struct {
    Hit  int `json:"hit"`
    Miss int `json:"miss"`
}

// Resume 履历快照
type Resume struct {
    Savor     *ResumeFeature   `json:"savor,omitempty"`
    Paste     *ResumeFeature   `json:"paste,omitempty"`
    Video     *ResumeFeature   `json:"video,omitempty"`
    Roam      *ResumeFeature   `json:"roam,omitempty"`
    Weave     *ResumeFeature   `json:"weave,omitempty"`
    ExportDoc *ResumeFeature   `json:"export_doc,omitempty"`
    ExportZip *ResumeFeature   `json:"export_zip,omitempty"`
    Pure      *ResumeFeature   `json:"pure,omitempty"`
    Copy      *ResumeCopyStats `json:"copy,omitempty"`
    Cache     *ResumeCacheStats `json:"cache,omitempty"`
}

// PingRequest 扩展后的 ping 请求体
type PingRequest struct {
    GoodSlg      string  `json:"good_slg"`
    DeviceID     string  `json:"device_id"`
    TotalSeconds int64   `json:"total_seconds"`
    EventTime    int64   `json:"event_time"`
    IdeFamily    string  `json:"ide_family"`
    ClientVer    string  `json:"client_ver"`
    DoerID       string  `json:"doer_id,omitempty"`
    Resume       *Resume `json:"resume,omitempty"`   // ★ 新增
}
```

---

## 八、客户端 globalState KEY 对照表

客户端 JS 代码中的 KEY 名 → 上报字段映射：

| globalState KEY | resume 字段 | 说明 |
|-----------------|-------------|------|
| `qqq_savor_count` | `resume.savor.n` | 播放次数 |
| `qqq_savor_total_ms` | `resume.savor.ms` | 播放总时长 |
| `qqq_savor_first_use` | `resume.savor.t0` | 首次播放时间 |
| `qqq_paste_stats.count` | `resume.paste.n` | 粘贴次数 |
| `qqq_paste_stats.totalSize` | `resume.paste.b` | 粘贴总字节 |
| `qqq_paste_stats.firstUse` | `resume.paste.t0` | 首次粘贴时间 |
| `qqq_video_stats.count` | `resume.video.n` | 下载次数 |
| `qqq_video_stats.totalSize` | `resume.video.b` | 下载总字节 |
| `qqq_video_stats.firstUse` | `resume.video.t0` | 首次下载时间 |
| `qqq_roam_stats.count` | `resume.roam.n` | 漫游次数 |
| `qqq_roam_stats.filesCreated` | `resume.roam.fc` | 创建文件数 |
| `qqq_roam_stats.firstUse` | `resume.roam.t0` | 首次漫游时间 |
| `qqq_weave_stats.count` | `resume.weave.n` | 编织次数 |
| `qqq_weave_stats.firstUse` | `resume.weave.t0` | 首次编织时间 |
| `qqq_exportDoc_stats.count` | `resume.export_doc.n` | 导出 Doc 次数 |
| `qqq_exportDoc_stats.firstUse` | `resume.export_doc.t0` | 首次导出 Doc 时间 |
| `qqq_exportZip_stats.count` | `resume.export_zip.n` | 导出 Zip 次数 |
| `qqq_exportZip_stats.firstUse` | `resume.export_zip.t0` | 首次导出 Zip 时间 |
| `qqq_pure_stats.count` | `resume.pure.n` | Pure 次数 |
| `qqq_pure_stats.firstUse` | `resume.pure.t0` | 首次 Pure 时间 |
| `qqq_copy_total_count` | `resume.copy.n` | 复制总次数 |
| `qqq_stats_cache_hit_total` | `resume.cache.hit` | 缓存命中总次数 |
| `qqq_stats_cache_miss_total` | `resume.cache.miss` | 缓存未命中总次数 |

---

## 九、查询 API（展示履历用）

### 9.1 获取单设备履历

```
GET /api/goods/qqq/resume?device_id={uuid}
```

响应：
```jsonc
{
  "ok": true,
  "device_id": "550e8400-...",
  "doer_id": "158****8204",           // 脱敏
  "total_seconds": 360000,
  "ide_family": "qoder",
  "resume": {
    "savor":  { "n": 42, "ms": 9120000, "t0": 1710000000 },
    "paste":  { "n": 318, "b": 209715200, "t0": 1709500000 },
    "video":  { "n": 12, "b": 3221225472, "t0": 1710200000 },
    "roam":   { "n": 67, "fc": 435, "t0": 1709800000 },
    "weave":  { "n": 5, "t0": 1711000000 },
    "copy":   { "n": 12450 },
    "cache":  { "hit": 28300, "miss": 1720 }
  },
  "updated_at": "2026-04-05T14:00:00Z"
}
```

### 9.2 获取用户名下所有设备履历（按 doer_id 聚合）

```
GET /api/goods/qqq/resume?doer_id={phone}
```

响应：返回该手机号关联的所有 device 的 resume 数组，以及合并后的总计。

---

## 十、带宽与存储估算

| 指标 | 值 |
|------|-----|
| resume JSON 体积 | ~300-500 字节（压缩后 ~200 字节） |
| 每设备每天 ping 次数 | ~2 次 |
| 每设备每天新增存储 | 0（UPSERT 覆盖，不增行） |
| wq.device_resume 单行大小 | ~200 字节 |
| 10 万设备总表大小 | ~20 MB |
| 100 万设备总表大小 | ~200 MB |

**结论：存储和带宽开销极低。**

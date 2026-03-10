# qqq VS Code 扩展接入规范

## 〇、设计根源（必读）

### 对接了什么数据？

| 数据 | 方向 | 说明 |
|------|:----:|------|
| **陪伴时长** | 客户端→服务端 | 设备累计使用秒数 |
| **安装设备数** | 服务端统计 | 新设备首次上报 +1 |
| **在线设备数** | 服务端统计 | 12h 内有上报的设备数 |
| **用户偏好** | 服务端→客户端 | 21 项配置，存在 `user_settings` 表（JSONB） |

### 免密码设计：为什么用户只填手机号？

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  核心理念：社交成本代替技术验证                                             │
│                                                                              │
│  传统做法：发短信验证码 → 用户验证 → 登录成功                               │
│  我们的做法：用户填手机号 → 直接拉取该号码的偏好 → 结束                     │
│                                                                              │
│  不验证真伪？                                                               │
│    是的。如果你填别人的手机号，你会看到别人的配置。                         │
│    但这是你自己的问题——你为什么要填别人的号？                              │
│    社交层面的「不合理」自然阻止了滥用，无需技术强制。                       │
│                                                                              │
│  为什么这样设计？                                                           │
│    1. VS Code 扩展不适合弹浏览器验证（打断工作流）                          │
│    2. 偏好配置不是敏感数据，泄露风险极低                                    │
│    3. 真正需要验证的场景（支付/登录 Gaea）走正规流程                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 服务端如何存储用户偏好？

```sql
-- dgs 主库
CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY,    -- 手机号
    settings JSONB NOT NULL,     -- 21 项配置
    updated_at TIMESTAMPTZ
);

-- 客户端请求 POST /api/gaea/qqq/config { phone: "138xxx" }
-- 服务端返回 { ok: true, settings: {...} }
```

### 客户端不需要知道什么？

客户端**不需要知道**服务端的验证逻辑、限流策略、数据库结构。
客户端**只需要**：填手机号 → 调 API → 拿配置。

---

## 一、核心概念

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  统计主体 = device_id（IDE 实例，不是机器）                                  │
│                                                                              │
│  关键定义：                                                                  │
│    device_id = 每个 IDE 实例独立生成的 UUID，存在 globalState               │
│    user_id   = 用户手机号（可选，填了就带上）                               │
│                                                                              │
│  为什么不用 machineId？                                                      │
│    用户可能同时开 VS Code + Cursor + Trae（都是 VS Code 内核）              │
│    它们共享 machineId，但 globalState 是隔离的                              │
│    如果用 machineId，就无法区分「哪个 IDE 的时长」「哪个 IDE 的账号」        │
│                                                                              │
│  所以：每个 IDE 实例 = 一个独立的「设备」                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 场景覆盖（全部清晰）

| 场景 | device_id | 结果 |
|------|-----------|------|
| **一个 IDE，不登录** | uuid-A | 设备独立统计，商品总量正常 |
| **一个 IDE，一个账号** | uuid-A | 设备时长归到该账号 |
| **一台机器，多个 IDE，同一账号** | uuid-A, uuid-B, uuid-C | 各自独立统计，user_stats 聚合总时长 |
| **一台机器，多个 IDE，不同账号** | uuid-A, uuid-B, uuid-C | 各归各的账号，互不干扰 |
| **一个账号，多台机器** | 每台机器的每个 IDE 各一个 | 各自独立统计，user_stats 聚合总时长 |
| **重装 IDE** | 新 UUID | 视为新设备（可接受） |
| **清除扩展数据** | 新 UUID | 视为新设备（可接受） |

### 1.2 数据流

```
VS Code / Cursor / Trae（任意 VS Code 内核 IDE）
    │
    ├── 首次激活：生成 device_id = crypto.randomUUID()，存入 globalState
    │
    ├── 定时上报 ─────────────────────────────────────────────►
    │   POST /api/wq/ping                                       服务端
    │   {                                                       │
    │     good_slg: "qqq",                                      │ 单调裁决
    │     device_id: globalState UUID,                          │ accepted = max(old, incoming)
    │     user_id: 手机号 (可选),                               │
    │     total_seconds: 本地累计秒数                           │ 写入 device_state
    │   }                                                       │ 记录 binding
    │                                                           │
    │ ◄─────────────────────────────────────────────────────────
    │   {
    │     ok: true,
    │     server_total_seconds: 服务端记录值,
    │     force_reset: true/false
    │   }
    │
    └── 若 force_reset=true → 用 server_total_seconds 覆盖本地
```

---

## 二、API 接口

### 2.1 上报统计 POST /api/wq/ping

**请求体**：
```typescript
interface PingRequest {
  good_slg: string;       // 必填，商品标识，如 "qqq"
  device_id: string;      // 必填，IDE 实例的 UUID（从 globalState 获取）
  user_id?: string;       // 可选，用户手机号
  total_seconds: number;  // 必填，客户端累计总秒数
  event_time?: number;    // 可选，客户端时间戳（秒）
  ide_family?: string;    // 可选，IDE 类型（如 "vscode", "cursor", "trae"）
  client_ver?: string;    // 可选，插件版本
}
```

**响应体**：
```typescript
interface PingResponse {
  ok: boolean;
  server_total_seconds: number;   // 服务端记录的累计秒数
  accepted_total_seconds: number; // 本次接受的累计秒数
  delta_seconds: number;          // 本次增量
  force_reset?: boolean;          // 是否需要客户端重置
  server_now: number;             // 服务器时间戳
  min_next_ping_at: number;       // 建议的下次 ping 最早时间
}
```

**限速规则**：
- 同 (good_slg, device_id) 每 60 秒只接受一次写入
- 限速命中时返回 200 但不记录增量

### 2.2 查询商品统计 GET /api/goods/:slg/stats

**响应体**：
```typescript
interface GoodStatsResponse {
  ok: boolean;
  total_installations: number;     // 累计安装数（= 设备数）
  total_companion_seconds: number; // 累计陪伴时长（秒）
  active_12h: number;              // 12小时内活跃设备数
  updated_at: string;              // 最后更新时间
}
```

### 2.3 查询用户统计 GET /api/wq/user/:user_id/stats

**可选参数**：`?good_slg=qqq` 限定商品

**响应体**：
```typescript
// 不带 good_slg 时返回所有商品汇总
interface UserStatsResponse {
  ok: boolean;
  total_companion_seconds: number; // 该用户总贡献时长
  total_devices: number;           // 该用户绑定的设备数
  goods: Array<{
    good_slg: string;
    seconds: number;
    device_count: number;
    last_seen_at: string;
  }>;
}
```

### 2.4 免密码配置同步 POST /api/gaea/qqq/config

**请求体**：
```typescript
interface ConfigRequest {
  phone: string;      // 手机号（支持 +8613812345678 / 13812345678）
  device_id: string;  // IDE 实例的 UUID
}
```

**响应体**：
```typescript
interface ConfigResponse {
  ok: boolean;
  settings?: Record<string, any>;  // 21项配置（仅 ok=true 时）
  source?: "cloud" | "default";    // 配置来源
  error?: string;                  // 错误码（仅 ok=false 时）
}
```

---

## 三、客户端实现指南

### 3.1 device_id 获取（最重要！）

```typescript
import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * 获取 device_id：IDE 实例级别的唯一标识
 *
 * 为什么不用 vscode.env.machineId？
 *   - machineId 是机器级别的，多个 IDE（VS Code/Cursor/Trae）共享同一个值
 *   - 但每个 IDE 的 globalState 是隔离的，时长/账号各自独立
 *   - 如果用 machineId，就会出现「3个IDE 争抢 1个 device_id」的混乱
 *
 * 正确做法：每个 IDE 实例生成独立的 UUID，存在自己的 globalState
 */
function getDeviceId(context: vscode.ExtensionContext): string {
  const KEY = 'qqq_device_id';

  // 尝试从 globalState 读取已有的
  let deviceId = context.globalState.get<string>(KEY);

  if (!deviceId) {
    // 首次运行，生成新的 UUID
    deviceId = crypto.randomUUID();
    context.globalState.update(KEY, deviceId);
    console.log('[qqq] Generated new device_id:', deviceId);
  }

  return deviceId;
}
```

### 3.2 user_id 获取（免密码登录）

**设计理念**：用户在 VS Code settings UI 填入手机号，手机号即 user_id。不验证真伪，社交成本代替技术验证。

```typescript
// 从 settings 读取用户手机号
function getUserId(): string | undefined {
  const phone = vscode.workspace.getConfiguration('qqq').get<string>('phone');
  if (!phone || phone.trim() === '') {
    return undefined;  // 未填则为匿名
  }
  return phone.trim();
}
```

### 3.3 累计时长计算

**策略：开着就算**，不做活跃检测。用户打开 VS Code 并启用插件就是"陪伴"。

```typescript
class UsageTracker {
  private totalSeconds: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly KEY = 'qqq_stats_total_seconds';

  constructor(private context: vscode.ExtensionContext) {
    // 从持久存储恢复
    this.totalSeconds = context.globalState.get(this.KEY, 0) || 0;
    this.startTracking();
  }

  private startTracking() {
    // 每 60 秒无条件 +60（开着就算）
    this.timer = setInterval(() => {
      this.totalSeconds += 60;
      this.context.globalState.update(this.KEY, this.totalSeconds);
    }, 60 * 1000);
  }

  getTotalSeconds(): number {
    return this.totalSeconds;
  }

  // 服务端纠正时调用
  forceReset(serverTotal: number) {
    this.totalSeconds = serverTotal;
    this.context.globalState.update(this.KEY, this.totalSeconds);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }
}
```

### 3.4 上报策略

```typescript
class WqReporter {
  private readonly API_BASE = 'https://gh555.com/api';
  private readonly GOOD_SLG = 'qqq';
  private retryDelay = 60 * 1000;
  private deviceId: string;

  constructor(
    private tracker: UsageTracker,
    private context: vscode.ExtensionContext
  ) {
    this.deviceId = getDeviceId(context);
  }

  async start() {
    // 1. 启动后随机抖动 30~120 秒发一次
    const initialDelay = 30000 + Math.random() * 90000;
    setTimeout(() => this.ping(), initialDelay);

    // 2. 每 12 小时兜底发一次
    setInterval(() => this.ping(), 12 * 60 * 60 * 1000);
  }

  private async ping() {
    try {
      const userId = getUserId();
      const totalSeconds = this.tracker.getTotalSeconds();

      const response = await fetch(`${this.API_BASE}/wq/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          good_slg: this.GOOD_SLG,
          device_id: this.deviceId,
          user_id: userId || undefined,
          total_seconds: totalSeconds,
          event_time: Math.floor(Date.now() / 1000),
          ide_family: this.getIDEFamily(),
          client_ver: this.getClientVersion()
        })
      });

      const data = await response.json();

      if (data.ok) {
        this.retryDelay = 60 * 1000; // 重置重试延迟

        if (data.force_reset) {
          this.tracker.forceReset(data.server_total_seconds);
          console.log('[wq] Force reset to', data.server_total_seconds);
        }
      }
    } catch (error) {
      console.error('[wq] Ping failed, retrying in', this.retryDelay / 1000, 's');
      setTimeout(() => this.ping(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 60 * 60 * 1000);
    }
  }

  private getIDEFamily(): string {
    // 尝试识别 IDE 类型
    const appName = vscode.env.appName.toLowerCase();
    if (appName.includes('cursor')) return 'cursor';
    if (appName.includes('trae')) return 'trae';
    if (appName.includes('insiders')) return 'vscode-insiders';
    return 'vscode';
  }

  private getClientVersion(): string {
    return vscode.extensions.getExtension('gh555.qqq')?.packageJSON.version || 'unknown';
  }
}
```

### 3.5 完整初始化

```typescript
// extension.ts
export function activate(context: vscode.ExtensionContext) {
  const tracker = new UsageTracker(context);
  const reporter = new WqReporter(tracker, context);

  reporter.start();

  // 注册显示统计命令
  context.subscriptions.push(
    vscode.commands.registerCommand('qqq.showStats', () => {
      const totalSeconds = tracker.getTotalSeconds();
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      vscode.window.showInformationMessage(`已陪伴你 ${hours} 小时 ${minutes} 分钟`);
    })
  );

  context.subscriptions.push({ dispose: () => tracker.dispose() });
}
```

### 3.6 配置同步（免密码登录）

```typescript
class ConfigSync {
  private readonly API_BASE = 'https://gh555.com/api';

  async syncConfig(phone: string, deviceId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.API_BASE}/gaea/qqq/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, device_id: deviceId })
      });

      const data = await response.json();

      if (data.ok && data.settings) {
        for (const [key, value] of Object.entries(data.settings)) {
          await vscode.workspace.getConfiguration('qqq').update(key, value, true);
        }
        vscode.window.showInformationMessage('✅ 配置已同步');
        return true;
      } else if (data.error === 'too_many_accounts') {
        vscode.window.showWarningMessage('今日切换的账号太多，请明天再试');
      } else if (data.error?.startsWith('rate_limit')) {
        vscode.window.showWarningMessage('请求太频繁，请稍后重试');
      } else {
        vscode.window.showInformationMessage('未找到配置，请先购买并在网站设置');
      }
      return false;
    } catch {
      vscode.window.showErrorMessage('网络错误，请重试');
      return false;
    }
  }
}
```

---

## 四、数据模型说明

### 4.1 设备维度（device_state）

| 字段 | 类型 | 说明 |
|------|------|------|
| good_int | BIGINT | 商品内部ID |
| device_id | TEXT | IDE 实例的 UUID（每个 IDE 独立） |
| user_id | TEXT | 当前绑定的用户手机号（可空=匿名） |
| total_seconds_server | BIGINT | 服务端记录的累计秒数（真理源） |
| first_seen_at | TIMESTAMPTZ | 首次上报时间 |
| last_seen_at | TIMESTAMPTZ | 最后上报时间 |

### 4.2 用户绑定历史（device_user_binding）

| 字段 | 类型 | 说明 |
|------|------|------|
| device_id | TEXT | IDE 实例的 UUID |
| user_id | TEXT | 用户手机号（可空=匿名期） |
| bound_at | TIMESTAMPTZ | 绑定时间 |
| unbound_at | TIMESTAMPTZ | 解绑时间（NULL=当前绑定） |
| seconds_at_bind | BIGINT | 绑定时设备累计秒数 |
| seconds_contributed | BIGINT | 本次绑定期间贡献的秒数 |

### 4.3 统计含义（清晰定义）

| 指标 | 含义 |
|------|------|
| total_installations | qqq 插件实例数（每个 IDE 算一个） |
| total_companion_seconds | 所有实例的累计时长之和 |
| user_stats.total_companion_seconds | 该用户名下所有设备的累计时长 |
| active_12h | 12小时内有上报的设备数 |

---

## 五、多 IDE 场景详解

### 5.1 同一机器，多个 IDE，同一账号

```
用户在一台机器上同时开着：
- VS Code    → device_id = "uuid-aaa" → user_id = "138xxx" → total = 1000
- Cursor     → device_id = "uuid-bbb" → user_id = "138xxx" → total = 800
- Trae       → device_id = "uuid-ccc" → user_id = "138xxx" → total = 500

查询用户统计：
GET /api/wq/user/138xxx/stats
→ { total_companion_seconds: 2300, device_count: 3 }

结果：三个 IDE 各自独立统计，用户总时长 = 1000 + 800 + 500 = 2300
```

### 5.2 同一机器，多个 IDE，不同账号

```
用户在一台机器上：
- VS Code    → device_id = "uuid-aaa" → user_id = "138xxx" → total = 1000
- Cursor     → device_id = "uuid-bbb" → user_id = "139yyy" → total = 800
- Trae       → device_id = "uuid-ccc" → user_id = NULL     → total = 500

查询用户 138xxx 统计：
→ { total_companion_seconds: 1000, device_count: 1 }

查询用户 139yyy 统计：
→ { total_companion_seconds: 800, device_count: 1 }

Trae 的 500 秒：归属到匿名设备维度，无用户归属

结果：各归各的，互不干扰，逻辑清晰
```

### 5.3 账号切换

```
时间线：
T1: 用户 A 在 VS Code 使用，设备累计 0→100
    → device_id = "uuid-aaa", user_id = "user_A"
    → binding: { user_id: "user_A", seconds_at_bind: 0 }

T2: 用户 A 退出，用户 B 登录，设备累计 100→200
    → device_id = "uuid-aaa", user_id = "user_B"
    → 关闭 A 的 binding: { seconds_contributed: 100 }
    → 新建 B 的 binding: { seconds_at_bind: 100 }

结果：
  - 设备 uuid-aaa 总累计：200 秒
  - 用户 A 贡献：100 秒
  - 用户 B 贡献：100 秒
```

---

## 六、最佳实践

### 6.1 上报频率

```
┌─────────────────────────────────────────────────────────────────────┐
│  推荐策略：                                                          │
│    1. 启动后 30~120 秒（随机抖动）发一次                             │
│    2. 每 12 小时兜底发一次                                           │
│    3. 失败后指数退避重试（1m → 2m → 4m → ... → max 1h）              │
│                                                                      │
│  不要：                                                              │
│    ✗ 每秒/每分钟频繁上报（会被限速）                                 │
│    ✗ 严格定时上报（会造成流量尖峰）                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.2 globalState 存储键

```typescript
// 推荐的键名（保持一致）
const KEYS = {
  DEVICE_ID: 'qqq_device_id',           // IDE 实例的 UUID
  TOTAL_SECONDS: 'qqq_stats_total_seconds',  // 累计时长
};
```

### 6.3 服务端纠正处理

```typescript
// 服务端返回 force_reset=true 时，必须用服务端值覆盖本地
if (response.force_reset) {
  this.totalSeconds = response.server_total_seconds;
  this.persist();  // 立即持久化
}
```

---

## 七、调试与排障

### 7.1 查看设备状态

```sql
-- 在 analytics 库执行
SELECT device_id, user_id, total_seconds_server, last_seen_at
FROM wq.device_state
WHERE good_int = (SELECT good_int FROM wq.goods_snapshot WHERE good_slg = 'qqq')
ORDER BY last_seen_at DESC
LIMIT 20;
```

### 7.2 查看用户绑定历史

```sql
SELECT device_id, user_id, bound_at, unbound_at, seconds_at_bind, seconds_contributed
FROM wq.device_user_binding
WHERE good_int = (SELECT good_int FROM wq.goods_snapshot WHERE good_slg = 'qqq')
  AND user_id = '目标用户手机号'
ORDER BY bound_at DESC;
```

### 7.3 查看用户统计

```sql
SELECT * FROM wq.user_stats
WHERE good_int = (SELECT good_int FROM wq.goods_snapshot WHERE good_slg = 'qqq')
ORDER BY total_companion_seconds DESC
LIMIT 20;
```

---

## 八、FAQ

### Q1: 为什么不用 vscode.env.machineId？

A: 因为 machineId 是机器级别的，多个 IDE（VS Code、Cursor、Trae）共享同一个值。但每个 IDE 的 globalState 是隔离的，时长/账号各自独立。如果用 machineId，就会出现「3个 IDE 争抢 1个 device_id」的混乱。

### Q2: 重装 IDE 后时长会丢失吗？

A: 本地时长会丢失（因为 globalState 被清空了）。但服务端有记录，下次 ping 时会返回 `force_reset=true`，客户端会用服务端值覆盖本地。

### Q3: 同时开多个 IDE 会重复计算时长吗？

A: 每个 IDE 各自累计自己的时长，它们是独立的「设备」。这是正确的行为——用户确实在多个地方使用了插件。

### Q4: 装机量会虚增吗？

A: 同一机器开 3 个 IDE = 3 个「设备」。这其实是正确的语义——你的插件确实被「安装」了 3 次。如果需要真实机器数，可以另外统计 unique machineId。

---

## 九、更新日志

| 版本 | 日期 | 变更 |
|------|------|------|
| v2.0 | 2026-03-10 | **重大更新**：device_id 从 machineId 改为 globalState UUID，解决多 IDE 场景 |
| v1.2 | 2026-03-10 | 新增免密码配置同步 API + 独立限流 |
| v1.1 | 2026-03-10 | 修正时长统计为"开着就算"，移除活跃检测 |
| v1.0 | 2026-03-10 | 初版：设备统计 + 用户关联 |

---

**维护者**: q
**最后更新**: 2026-03-10

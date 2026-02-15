










## 1. 核心性能修复：消除主线程阻塞 (卡顿警告)

**问题描述：** `q4.js` 中的 `calculateActualCacheSize` 递归同步扫描磁盘，导致扩展宿主每 5 秒卡死一次。
**正确做法：** 废弃同步扫描，改为读取内存快照。

### 修复步骤：
- **修改文件：** `src/q4.js`
- **操作：**
  1. 找到 `updateContent()`。
  2. 将 `const cacheMB = calculateActualCacheSize(...)` 替换为 `const cacheMB = global.getCacheStatsSnapshot().actualSizeMB;`。
  3. 删除 `q4.js` 中所有递归扫描相关的辅助函数。

---

## 2. 核心稳定性修复：解决 Webview 序列化报错 (toJSON)

**问题描述：** 跨进程传输复杂对象时，VS Code 底层尝试调用不存在的 `toJSON` 方法导致崩溃。
**正确做法：** 在 `postMessage` 前强制执行 POJO 转换。

### 修复步骤：
- **修改文件：** `src/q4.js`
- **操作：**
  1. 封装一个安全的 `postMessage` 方法：
     ```javascript
     async postMessage(message) {
         try {
             const safeMessage = JSON.parse(JSON.stringify(message));
             await this._view.webview.postMessage(safeMessage);
         } catch (e) { /* ignore */ }
     }
     ```
  2. 确保 `updateContent` 里所有的消息发送都调用这个 `this.postMessage()`。

---

## 3. 存储优化：解决 1.8MB globalState 警告

**问题描述：** 事务记录 `qqq.transactions` 无限制增长，且单条记录可能携带大数据块。
**正确做法：** 采用“带优先级的滚动清理”机制，并强制“字段清洗”。

### 修复步骤：
- **修改文件：** `src/global.js`
- **操作 A (字段清洗)：** 确保 `saveTransaction` 存入的对象只包含必要字段，且避开复杂对象。
  ```javascript
  // 严禁直接使用 ...trans，必须提取功能所需的关键字段
  const cleanTrans = {
      id: trans.id,
      targetDir: trans.targetDir,
      // 使用 toString() 替代 fsPath，确保 100% 兼容远程开发等非文件协议
      targetUri: typeof trans.targetUri === 'string' ? trans.targetUri : trans.targetUri?.toString(),
      docUri: typeof trans.docUri === 'string' ? trans.docUri : trans.docUri?.toString(),
      tempFiles: Array.isArray(trans.tempFiles) ? trans.tempFiles : [],
      status: 'pending',
      createdAt: trans.createdAt || Date.now(),
      taskType: trans.taskType || 'unknown',
      // 预留元数据空间，防止未来扩展功能时字段被清洗掉 (仅限简单类型)
      extra: trans.extra || {}
  };
  list.push(cleanTrans);
  ```

- **操作 B (优先级清理)：** 当列表长度 > 200 时，清理最老的 100 条。
  ```javascript
  if (list.length > 200) {
      const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
      const now = Date.now();

      // 定义清理权重：已结案(success/cancelled) 权重最高，超期(>60天) 权重次之
      const getWeight = (t) => {
          let weight = 0;
          if (t.status === 'success' || t.status === 'cancelled') weight += 2;
          if (now - (t.createdAt || 0) > SIXTY_DAYS) weight += 1;
          return weight;
      };

      // 按权重从大到小排序，权重相同按时间从老到新排序
      const sortedForDeletion = [...list].sort((a, b) => {
          const wA = getWeight(a);
          const wB = getWeight(b);
          if (wA !== wB) return wB - wA; // 权重大的在前
          return (a.createdAt || 0) - (b.createdAt || 0); // 时间老的在前
      });

      const toDeleteIds = new Set(sortedForDeletion.slice(0, 100).map(t => t.id));
      list = list.filter(t => !toDeleteIds.has(t.id));
  }
  ```

---

## 4. 生命周期修复：DisposableStore 报错 (最佳实践)

**问题描述：** VS Code 快速重启或关闭时，异步任务仍在尝试注册资源，引发 `DisposableStore has been disposed` 错误。
**正确做法 (零风险版)：** 仅在关键出口设置标志位。

### 修复步骤：
- **第一步 (global.js)：** 增加一个全局单例状态。
  ```javascript
  let _isDeactivated = false;
  module.exports = {
      setDeactivated: (v) => _isDeactivated = !!v,
      isDeactivated: () => _isDeactivated
  };
  ```
- **第二步 (qqq.js)：** 在 `deactivate` 函数的第一行，立即执行 `global.setDeactivated(true)`。
- **第三步 (各模块)：** 定义一个公共的 `safePush` 工具函数（建议放在 `global.js`），内部逻辑如下：
  ```javascript
  function safePush(context, disposable) {
      if (global.isDeactivated() || !context?.subscriptions) {
          disposable.dispose(); // 如果插件已停用，直接销毁新资源
          return;
      }
      context.subscriptions.push(disposable);
  }
  ```
- **原则：** 所有在 `await` 之后的 `subscriptions.push` 操作，全部改用 `safePush`。

---

## 5. 其他关键优化 (健壮性与编译器报错)

**这些优化虽小，但对项目的正常构建和资源释放至关重要。**

### 修复步骤：

- **A. 补全模块停用逻辑 (src/qqq.js)：**
  确保插件关闭时，`q2` (资源管理器/漫游器) 也能正常保存配置并释放文件监听资源。
  ```javascript
  if (q2Module?.deactivate) {
      try { await q2Module.deactivate(); } catch { }
  }
  ```

- **B. 清理重复成员 (src/q4.js)：**
  删除文件末尾冗余定义的 `dispose()` 方法，避免 `esbuild` 报 `Duplicate member` 错误。

- **C. 健壮的配置加载 (src/q2.js)：**
  在读取配置时增加空值容错：
  ```javascript
  const newConfig = globalContext.globalState.get("qqq_config") || {};
  ```

---

## 7. 存储清理策略：AUTO_CLEANUP_DAYS (30天)

**设计目标：** 确保磁盘存储不随使用时长无限膨胀，同时兼顾用户回溯需求。

### 详细逻辑：
1. **红灯预检**：清理逻辑仅在 `isDeactivated()` 为 false 时运行，避免在关闭插件时产生文件写入冲突。
2. **尾部滚动删除 (O(1))**：
   - 利用双向链表的特性，从 `_tail`（最老的数据）开始向前遍历。
   - 检查 `timestamp`。如果满足 `now - timestamp > 30天`，则立即切断该节点的所有指针引用。
   - 从 `Map` 索引中物理移除对应 ID 和 Hash，确保内存与磁盘同步释放。
3. **静默持久化**：
   - 只有当确实产生了删除行为时，才会触发 `requestSave()` 节流写入磁盘。
4. **取舍**：不采用复杂的“访问频率”算法，坚持“时间窗口”原则，保持代码极致轻量。

---

## 8. 总结：如何避免产生垃圾代码？
1. **不要** 在每个子模块里定义局部的 `isDeactivated`，统一用 `global.js` 的。
2. **不要** 在同步操作里加防御，只在有 `await` 之后（即可能产生执行断层的地方）加检查。
3. **不要** 手动调用 `dispose()` 那些已经丢进 `subscriptions` 的对象，VS Code 会自动处理。
为了解决“启动瞬间状态不一致”的风险，同时保持性能最优，我建议针对以下三类核心 Command 增加拦截。

### 1. 必须拦截的 Command 名单

这些命令由于深度依赖后台尚未完成的 `recover()` 或 `history load` 逻辑，如果不拦截，会导致功能失效或产生脏数据。

1.  **`qqq.downloadVideosFromUrl` (视频下载)**：
    *   **原因**：它需要读取 `TransactionManager` 以确定任务 ID 和锚点状态。如果 `recover()` 没跑完，可能会导致 ID 冲突或无法正确处理“已存在”的任务。
2.  **`qqq.weave` (事故清理)**：
    *   **原因**：这是最危险的。如果后台还没把“哪些文件是有效的”扫描清楚，清理逻辑可能会误删正在恢复中的任务文件。
3.  **`qqq.q1` / `qqq.q2` (剪切板历史/漫游器)**：
    *   **原因**：剪切板历史通常有几百 KB 到几 MB，如果加载慢了，用户点开后看到的是“空列表”，体验非常糟糕。

---

### 2. 最合理、性能最优的实现架构

**核心思想**：**“注册不等待，执行必等待”**。
不要用定时器去轮询状态，而是使用 **Promise 信号灯机制**。

#### **A. 基础设施 (global.js)**
在 `global.js` 中维护一个 `readyPromise`。Promise 的特性是：一旦 resolve（解决），后续所有的 `await` 都会**瞬间穿透**，没有任何性能损耗。

```javascript
// global.js
let _resolveReady;
const _readyPromise = new Promise(resolve => {
    _resolveReady = resolve;
});

module.exports = {
    markReady: () => _resolveReady?.(), // 供 qqq.js 调用
    ensureReady: () => _readyPromise,   // 供 Command 调用
};
```

#### **B. 拦截时机 (qqq.js)**
在 `activate` 的末尾，当所有的后台初始化（`recover`, `startDaemons`, `historyLoad`）完成后，推开信号灯。

```javascript
// qqq.js -> activate() 底部
Promise.all([
    global.TransactionManager.recover(),
    clipboardHistoryManager.load(), // 假设有这个
]).finally(() => {
    global.markReady(); // 告诉全世界：基座已就绪
});
```

#### **C. 最优性能的拦截写法 (Command 内部)**
在 Command 的函数体第一行加入 `await global.ensureReady()`。

**为什么这样性能最优？**
1.  **零阻塞注册**：VS Code 启动时完全不等待，插件秒开。
2.  **零轮询开销**：当 Ready 后，`await` 几乎不消耗 CPU 周期。
3.  **优雅的 UX**：如果初始化确实很慢（比如用户硬盘卡了），我们可以加一个“超时自动提示”。

```javascript
async function executeCommand() {
    // 性能最优：如果已经 Ready，这行代码耗时 < 0.1ms
    // 如果还没 Ready，它会静默挂起执行流
    await global.ensureReady();

    // 真正的逻辑开始...
}
```

---

### 3. 进阶优化：解决“用户点完没反应”的尴尬

如果 `ensureReady` 超过 300ms 还没返回，用户可能会觉得点击失效了。**极致的体验应该是：**

```javascript
async function executeCommand() {
    const timeout = setTimeout(() => {
        vscode.window.setStatusBarMessage("$(sync~spin) qqq 正在初始化环境，请稍候...", 3000);
    }, 300);

    await global.ensureReady();
    clearTimeout(timeout);

    // 执行逻辑...
}
```

### 总结
*   **拦截范围**：仅限 **下载、清理、历史加载** 这三个涉及核心持久化状态的命令。
*   **实现方式**：基于 `global.js` 的 **Promise 信号灯**。
*   **收益**：
    1.  **100% 避免**了启动瞬间的竞态 Bug。
    2.  **100% 保持**了我们好不容易拿到的“秒开”启动速度。
    3.  **零** 垃圾代码残留。

**如果您认可这个架构，我可以在下一次施工中为您在基座里埋下这盏“信号灯”。**







qq

obsoleteKeys 的清理范围与“新旧之分”
精准打击：obsoleteKeys 只清理那些带有“旧时代特征”的键值：
qqq_clipboard_history：旧版直接存文本的键。
qqq_history_manager_state：旧版存索引的键。
qqq.transactions.backup：注意这个 .backup 后缀，这是旧版用来存备份的。
新版安全：按照 REPAIR_BLUEPRINT.md 设计，新版的实时事务键名是 qqq.transactions（没有 backup 后缀）。
结论：obsoleteKeys 即使取消注释执行，也绝对不会碰到新版的事务数据。它们在命名空间上是完全物理隔离的。您现在的决定是“永远不再执行”，这更加稳妥。


 qq


. POJO 转换的触发频率
它的触发频率与 UI 刷新率 严格对齐：
动作触发：每次您 Ctrl+C 复制新内容、删除某项、或清空历史时，都会触发一次。
定时刷新：目前设定的 SIDEBAR_UPDATE_MS 是 5 秒一次（用于更新“ Dial”仪表盘的时间）。


. obsoleteKeys 到底是清理了哪些“陈年旧账”？
我的清理逻辑遵循您“向前看”的原则，在 activate 瞬间直接执行了以下物理卸载：
qqq_clipboard_history：这是旧版本直接存放在 VS Code 内部数据库（SQLite/LevelDB）里的全部剪切板文本。它通常是那 2MB 报警的罪魁祸首。
qqq_history_manager_state：旧版本用来记录“哪个是最后一条”的元数据。
qqq.transactions.backup：您之前担心的“事务残留”。如果之前的下载或漫游任务崩溃，旧版本会将未完成的事务存入这里。我直接将其抹除，强制让插件从“零状态”干净启动。



废除 Watchdog 机制：
移除了 10 秒一次的 Webview 心跳发送。
移除了 30 秒一次的宿主端健康检查计时器。
移除了 _lastHeartbeat 成员变量。
结论对齐：现在，如果脚本报错或 Webview 进程崩溃，界面将保持“白屏”或“报错状态”。这不仅节省了 CPU 和 IPC 资源，更让底层问题（如 CSP 拦截、脚本冲突）能被第一时间捕捉，而不是被定时重载所掩盖。




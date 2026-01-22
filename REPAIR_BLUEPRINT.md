# 插件核心 Bug 修复图纸 (Verified & Clean)

本文档整理了针对 `gh555.qqq` 插件已验证的正确修复方案。即便在代码回滚后，也可以按照以下步骤重新实施，避免产生冗余的垃圾代码。

---

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

## 6. 总结：如何避免产生垃圾代码？
1. **不要** 在每个子模块里定义局部的 `isDeactivated`，统一用 `global.js` 的。
2. **不要** 在同步操作里加防御，只在有 `await` 之后（即可能产生执行断层的地方）加检查。
3. **不要** 手动调用 `dispose()` 那些已经丢进 `subscriptions` 的对象，VS Code 会自动处理。

# DisposableStore 报错根治图纸 (核心定性版)

## 1. 终极定性：病因不在“注册”，而在“残留”

**现象：** 日志报 `Trying to add a disposable to a DisposableStore that has already been disposed of`。
**本质原因：** 插件已经执行了 `deactivate()`，但插件启动的某些**后台任务（僵尸任务）**没有被杀死。这些任务在插件死后触发了回调，并尝试向已销毁的 `context.subscriptions` 塞入新资源。

**结论：** 
- **错误的修复方向**：在 `activate` 里加 `await` 检查，或给每个 `push` 加 `safePush` 保护。这只是在洪水来时堵窗户。
- **正确的修复方向**：在 `deactivate` 里确保所有后台进程、定时器、事件监听器被**物理掐死**。

---

## 2. 为什么当前版本“暂时”不报错？

**原因审计：**
当前版本的 `activate` 是**纯同步执行**的（没有中间的 `await`）。VS Code 在执行 `activate` 的同步代码块时，不会交出控制权，因此 `deactivate` 无法插队。
**潜在风险：** 虽然现在不报错，但那些“僵尸任务”依然留在内存中，只是由于时机不对没触发报错而已。如果不清理源头，它们依然会导致内存泄漏和逻辑混乱。

---

## 3. 根治方案实施清单 (三步走)

### 第一步：定时器（Timer）的物理清理
**排查对象：** 所有的 `setInterval` 和 `setTimeout`。
**做法：** 
1. 必须将 Timer 句柄存入全局变量。
2. 在 `deactivate` 中显式 `clearInterval` / `clearTimeout`。
3. **关键点**：不要依赖 VS Code 自动清理定时器，它们不属于 `subscriptions` 管理范围。

### 第二步：桥接进程（Bridge Processes）的暴力终结
**排查对象：** PythonBridge, RustBridge, ShellBridge, yt-dlp 进程。
**做法：** 
1. 确保每一个 `spawn` 的进程都有对应的 `kill()` 逻辑。
2. 在 `deactivate` 函数中，必须 `await` 这些进程退出的 Promise。
3. 如果进程不响应，强制 `process.kill(pid, 'SIGKILL')`。

### 第三步：解开“循环依赖”死结
**排查对象：** `global.js` 与 `q1.js` / `q2.js` 的互相引用。
**原理：** 循环依赖会导致 `deactivate` 时某些对象变为 `undefined`，导致 `try-catch` 里的清理逻辑跳过，从而留下僵尸资源。
**做法：** 
1. 将公共状态移入独立的 `constants.js` 或 `state.js`。
2. 确保 `global.js` 处于依赖链的最顶端，不反向引用子模块。

---

## 4. 完美代码范例

**不要这样做 (防御式)：**
```javascript
// ❌ 依然在推卸责任
if (!global.isDeactivated()) context.subscriptions.push(item);
```

**务必这样做 (进攻式)：**
```javascript
// ✅ 在源头掐断，让回调永远没机会执行
function deactivate() {
    // 1. 停掉所有心跳
    if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }
    // 2. 强杀后台进程
    if (this.pythonProcess) {
        this.pythonProcess.kill();
    }
}
```

---

## 5. 总结

如果 `deactivate` 做到了真正的**“寸草不生”**，那么 `DisposableStore` 的报错将从物理上失去触发的可能性。我们不需要去修 `activate`，我们要修的是**“临终关怀” (Deactivation)**。

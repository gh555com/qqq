# DisposableStore 终极最优解：零断层同步注册法

## 1. 核心诊断总结
- **病根**：esbuild 打包后，为了分平台加载二进制，我们在 `activate` 中引入了 `await`。
- **后果**：这个 `await` 产生了一个微小的执行间隙，让 VS Code 有机会在初始化完成前就销毁插件，导致后续的 `push` 撞上“已销毁”的仓库。

## 2. 终极修复策略：三权分立

### 策略一：【注册权】提升
**所有** `context.subscriptions.push(...)` 必须写在 `activate` 函数的最顶层，且在第一个 `await` 出现之前。
- **理由**：只要它是同步运行的，JavaScript 的单线程特性保证了 VS Code 绝对无法在中途插队执行销毁操作。

### 策略二：【路径权】同步化
所有关于 `win32/darwin/linux` 的路径判断，必须改用纯同步逻辑。
- **做法**：使用 `os.platform()` 和 `path.join`，不要在启动时用 `fs.exists` 去检测文件（那是异步的）。先假设文件存在并注册，如果真的不存在，在后续运行报错即可。

### 策略三：【校验权】后台化
将那些必须 `await` 的逻辑（如检测二进制是否可执行）移到 `activate` 的最后。
```javascript
async function activate(context) {
    // 1. 同步注册区 (绝对安全)
    context.subscriptions.push(vscode.commands.registerCommand(...));
    context.subscriptions.push(new SidebarProvider());

    // 2. 异步校验区 (允许失败，不阻塞注册)
    initBinaryEnvironment(context).catch(e => {
        global.logMessage("环境初始化延迟失败: " + e.message, "ERROR");
    });
}
```

## 3. 终极代码规约 (Scorched Earth & Clean Architecture)

### A. 临终关怀 (Deactivation) 的焦土政策
在 `deactivate` 中，必须执行物理层面的彻底终结：
1. **停止心跳**：显式清除所有 `setInterval`。
2. **切断桥接**：给所有 `ChildProcess`（Python, Rust, Shell, 以及 yt-dlp 等）发送 `SIGKILL`，并 `await` 它们的退出。
3. **设置标志位**：设置全局 `_isDeactivated = true`，让那些残存的异步回调（如网络请求返回）在执行前看到“红灯”而自动退出。
4. **全模块覆盖**：确保 `qqq.js` 显式调用了所有子模块（q1, q2）的 `deactivate` 方法。

### B. 架构解耦 (Dependency Cleanup)
**严禁循环依赖**：如果 `global.js` 与 `q1.js` 互相引用，会导致 `deactivate` 时某些对象变为 `undefined`，从而跳过清理逻辑。
- **做法**：将公共状态移入独立的 `constants.js`，确保 `global.js` 处于依赖链顶端。

## 4. 结论：为什么这是最优解？
- **零开销**：不需要 `safePush` 这种包装函数，保持了 VS Code 原生 API 的纯粹。
- **零报错**：利用 JS 的同步特性，从物理上消灭了“插队”的可能性。
- **高工程度**：完美支持 esbuild 和分平台发布，因为我们把路径探测做成了同步配置。

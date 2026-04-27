# 音频子系统内部细节

## 架构

```
VS Code Extension (JS)
    │  Named Pipe IPC
    ▼
Python Broker (长驻进程, dist/kp.py)
    ├── _AUDIO_ENGINE  (NonBlockingAudioEngine)  ← 音乐
    └── _AUDIO_HUB     (AudioHub)                ← SFX 音效
```

两套引擎完全独立。设备丢失时音乐引擎通过 `on_device_lost` 回调联动重置 SFX。

**Broker 进程独立于扩展生命周期** — 扩展卸载/重装不会杀死旧 broker，必须手动 `taskkill` 才能让新代码生效。

---

## 日志

| 日志 | 路径 |
|------|------|
| broker.log | `%LOCALAPPDATA%/vix_audio_broker/broker.log` |
| err.log | JS 侧，与音频无关 |

关键标记：`【!!】` 设备丢失/失败、`【OK】` 恢复成功、`【??】` 设备创建但未拉数据

设备相关日志必须用 `_log_critical`（无论 silent 与否都写入 broker.log）。

---

## 播放路径

`_play_audio(file_path, count)` 分发：

| count | 有前奏 (2.mp3→a2.mp3) | 无前奏 | 代码路径 |
|-------|----------------------|--------|----------|
| 0/-1 | `play_with_intro(loop=True)` | `play_sound_file(loop=True)` | intro+loop / loop |
| 1 | `az_with_intro(1)` | `az(1)` | intro+nloop / nloop |
| >1 | `az_with_intro(count)` | `az(count)` | intro+nloop / nloop |

短文件（≤300s）走 PCM 预解码路径；长文件走 streaming 逐段解码。共 6 个恢复路径。

---

## 设备恢复机制

检测：`token.device_silent_seconds() > 3.0`（stream generator 每次 yield 数据时自动 `touch()`）

恢复流程：
1. `_log_critical` 记录检测
2. `_on_device_lost()` 回调重置 SFX
3. `_kill_device_async(device)` 异步销毁旧设备
4. 渐进退避重试：0.5s → 1s → 2s → ... → 30s 上限
5. 验证：`sleep(2.0)` 后检查 `device_silent_seconds() < 1.5`

---

## 致命陷阱

### 1. device.stop() 永久阻塞

屏保挂起设备后 `ma_device_stop()` 永久等待回调完成。

**方案：** `_kill_device_async()` — daemon 线程中执行 stop/close，主线程不等待。

设备可能异常 → `_kill_device_async`；设备正常 → 同步 stop/close。

### 2. 恢复循环内禁止调用 miniaudio 文件 I/O

`_kill_device_async` 的 daemon 线程卡在 miniaudio 内部锁上。如果恢复循环同时调用 `stream_file()` / `decode_file()` → 争同一把锁 → **死锁**。

**规则：恢复循环内只能复用已解码的内存 PCM。** 交叉淡化用纯 Python 的 `_prepare_pcm_loop_crossfade()`。

```python
# ✗ 死锁 — 缓存未命中时调 stream_file()
pcm, xf = self._get_pcm_cached_or_decode(path, ..., crossfade_ms=xms)

# ✓ 安全 — 纯内存操作
pcm, xf = self._prepare_pcm_loop_crossfade(main_pcm, xms)
```

### 3. 恢复验证假阳性

恢复后 **禁止** 在验证前调 `token.touch()`，否则 `device_silent_seconds()` 永远通过。

### 4. 异常吞掉

用 `except Exception:` 不是 `except:`。前 2 次 retry 必须记录错误日志。

---

## 修改检查清单

- [ ] 恢复循环内是否复用内存 PCM（不调 stream_file / decode_file）
- [ ] 设备清理方式是否正确（异常→async，正常→同步）
- [ ] 验证前是否避免了 token.touch()
- [ ] 异常日志是否记录（前 2 次 retry）
- [ ] 设备丢失日志是否用 _log_critical
- [ ] 6 个恢复路径是否全覆盖
- [ ] 修改后同步 dist/ 并重启 broker

# Changelog

## 0.2.0 — 兼容 DSH 0.2.2-rc.3（兼容性重写）

### 修复

- **启动即崩**：0.1.x 在 `apply()` 里调用 `persistence.inspect.bind(...)`，而 DSH
  `0.2.2-rc.3` 的 `SessionPersistence` 服务已不再提供 `inspect` / `readFrom`
  （现在只有 `create` / `open` / `flush` / `stat` / `list`），于是插件加载时直接抛
  `TypeError`。本版把读缓存整体迁移到 `open(id, 'read')` + `SessionHandle.read()`。
- **预热取不到会话 id**：`list()` 现在返回 `SessionPersistenceSnapshot`
  （`{ header, revision, eventState... }`），`id` / `createdAt` 在 `header` 里，
  旧代码按顶层 `header.id` 取到的是 `undefined`。
- **无效配置项**：`session-persistence-jsonl` 的 Config 现在只有
  `root` / `compression` / `listConcurrency`，旧版写入的
  `preparedSessionCacheSize` 与 `writeBatchMaxDelayMs` 会被静默忽略，故从 patch 中移除。

### 变更

- 读缓存改为**按 revision 校验**：`open` 命中先比 revision，句柄的每次 `read()`
  再比一次——后端保证 revision 相同即日志未变，因此正在运行的会话追加事件后仍然可见，
  不会返回陈旧快照。
- 淘汰策略从「单一只看槽数」改为**会话数 + 源文件字节双预算**，并新增单会话上限，
  避免把 10 MB+ 的会话解码成几百 MB 的 JS 对象驻留内存。
- 取消了「每条 `session/event` 就清空整个缓存」的失效方式——那会让活跃会话的命中率归零；
  正确性交给 revision 校验兜底。
- 写合并（kv unit 层）改为**能力探测**：rc.3 的 `KvUnit` 不再暴露
  `publish` / `state` / `assertOpen`，没有「先在内存改、再统一落盘」的挂点，
  因此自动跳过；写频率改由 `session-projection-cache` 的
  `writeEveryEvents` / `writeIntervalMs` 控制。旧版 DSH 上仍然生效。
- `inject` 从 `["sessionPersistence", "storage"]` 收紧为 `["sessionPersistence"]`，
  `storage` 改为可选（纯 web profile 下不再因为缺 storage 而不启用）。
- 新增 `test/smoke.mjs`（`npm test`），覆盖命中、失效、切片、close 语义、预热与预算淘汰。

### 升级注意

0.2.0 需要 **DSH ≥ 0.2.2-rc.3**。老版本请继续用 0.1.x。

## 0.1.0 — 初始版本

- 包装 `inspect` / `readFrom` / `list` 实现读缓存 + 会话预热 + kv 写合并。
- 适配 DSH 0.1.0-rc.6 ~ 0.2.2-rc.2。

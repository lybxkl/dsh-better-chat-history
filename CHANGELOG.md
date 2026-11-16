# Changelog

## 0.3.0 — 在插件页里直接调参

### 新增

- **设置面板**：`plugins.row.config` 槽位（键 `dsh-better-chat-history#io-optimizer`）。
  在 **插件 → 更好的聊天记录加载 → io-optimizer 行 → 配置** 里改六个参数，
  保存即写入 profile 的 `cordis.patch.yml` 并重启本插件。
- **配置 schema**：Host 端 `export const Config`（schemastery）。DSH 由此知道哪些字段
  可编辑、默认值是多少；schema 拿不到时（例如脱离 DSH 单独 import）自动降级为无面板。
- **MB 单位**：对外用 `readCacheSessionMb` / `readCacheSourceMb`，内部仍按字节计算，
  旧的 `readCacheSessionBytes` / `readCacheSourceBytes` 继续可用（两者都给时 MB 优先）。
- 浏览器半个插件、`./client` 导出、`locale/{zh,en}.json`（插件页标题与描述）。

### 修复

- **配置改动后可能整体失效**：原先用一个挂在服务上的布尔量挡重复安装。改配置会重启插件，
  若新实例先于旧实例的 dispose 执行，新实例会跳过安装、随后旧实例把 `open` 还原成原生方法，
  读缓存就此静默关闭。现在改为「总是安装 + 卸载时按身份校验只撤自己这一层」，
  原始方法锚在服务的 `Symbol.for('dsh-better-chat-history.originals')` 上，跨实例共享。

## 0.2.1 — 复查修掉的四类逻辑问题

### 修复

- **超大会话被白读一遍**：`open()` 在 `materialize()` 之后才发现某个会话超出单会话
  上限，于是先整份解码、再退回上游句柄，等于在大会话上做两次冷读（比不打补丁更慢）。
  现在先看 `stat().sizeBytes`，超限直接交还上游，一次都不多读。
- **`readCacheSessions = 0` 时反而变慢**：关缓存后仍会先 `materialize()` 再退回上游。
  现在该配置会让插件彻底不介入 `open`。
- **取消被吞掉**：`safeStat()` 原本把所有 `stat` 异常都当作「会话不存在」，导致被
  `AbortSignal` 取消的 `read()` 静默返回陈旧数据。现在 abort 一律向上抛。
- **`exclusive` 事件污染缓存**：DSH 的事件所有权是 `SessionSeedEventState`，只有
  `shared-frozen` 才能跨读者共享；`exclusive` 时调用方可能就地改写事件对象，
  一旦进缓存就会把改写泄漏给下一个读者。现在只缓存 `shared-frozen`（jsonl 后端始终是它）。
- **乱序完成覆盖新快照**：两次不同 revision 的读取可能后发先至，先发起的那次若后完成
  会把更新的条目顶掉。现在条目记录的是**发起时刻**，旧发起的完成时不写回。
- **并发重复解码**：`inflight` 去重键从 `id` 改为 `(id, revision)`，同一份日志并发只解一次，
  但不同 revision 绝不互相复用结果（原先会把旧 revision 的结果交给新 revision 的读者）。

### 变更

- `list()` 命中与未命中都返回数组副本，调用方改不动缓存。
- 配置合并忽略显式 `undefined`，不会再因为补丁里写了空值而把默认值抹成 `undefined`。
- 关闭句柄后 `read()` 抛出的错误名对齐上游 `SessionHandleClosedError`。
- 删掉写合并分支里三个未使用的绑定（其中 `void origPut` 之类在旧 DSH 上会直接
  `ReferenceError`）。
- `test/smoke.mjs` 扩到 13 组断言：新增超大跳过、`exclusive` 不缓存、abort 传播、
  并发去重、关闭缓存后不介入。

### 已知边界

- 缓存只在 `read` 访问上生效；`write` 句柄、`create`、`flush` 全部原样透传。
- 会话被外部删除时，`stat()` 返回 `undefined`，此时沿用最后一次视图（不抛错）。

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

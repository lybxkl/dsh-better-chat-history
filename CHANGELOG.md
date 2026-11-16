# Changelog

## 0.6.1 — 徽标只说真话，归档即清缓存

- **「已缓存」只在真的缓存了时才显示**：0.6.0 把「会话挂在宿主内存里（live）」也算成已缓存，文案不准。
  现在徽标只认读缓存里的条目；live 仅在接口里作为参考字段返回。
- **切会话真的会缓存了**：预热不再跳过 live 会话——切过去之后照样在后台存一份（串行、跳过超限与已新鲜的），
  所以切走再切回来走的是缓存，徽标也名副其实。
- **归档清缓存**：监听 `workspace/session-archived`（`{ sessionId }`，只在首次归档时派发），
  命中则立刻从缓存里删掉（日志记 `archive-evict id=…`），徽标随之消失。
## 0.6.0 — 切会话也进缓存

**观察到的实情**：在界面里切会话，`sessionPersistence.open` 一次都不会被调用（`openHit/openMiss` 长期为 0），
`sessionQuery.observeSession` 每次都在 1ms 内返回。原因是宿主里会话还没释放时会命中 live 快路径
（`sessions.get(id)` 直接给内存对象），根本不解码日志。所以「切会话」原本没有可省的解码。

因此这一版做两件事，让切会话也进缓存、也让标识对得上：

- **切换即预热**：包装 `sessionQuery.observeSession` / `readSession`，切到某个会话后把它补进读缓存。
  串行排队、一次一个；已在宿主内存里的会话跳过（再存一份纯属浪费内存）；超单会话上限的跳过。
  这样「切过去 → 离开 → 再切回来」走的就是缓存，而不是重新解码。
- **徽标认识 live**：`GET /io-optimizer/cache-state` 增加 `live` 字段（会话是否正挂在宿主内存里）。
  徽标在 `cached` 或 `live` 时都显示：live 意味着切回来同样不用解码，只是它不需要额外副本。
## 0.5.2 — 徽标只留一句话

体积从正文挪进 title：小会话只有几十 KB，正文写「1MB」会误导。正文只剩 `已缓存`，
title 里写清「缓存体积 + 是否与磁盘一致」；单位按 B / KB / MB 自适应。
## 0.5.1 — 徽标不闪了

0.5.0 只在「缓存与磁盘版本一致」时显示徽标，于是当前会话一边对话一边写日志，`revision` 每写一次就变，
徽标会跟着一闪一闪。现在只要缓存里有这个会话就显示：一致时绿点，落后时灰点（title 说明「下一次打开会重新解码」）。
文案仍是 `已缓存`，不给孩子加长句。
## 0.5.0 — 界面上标出「已缓存」

输入框下方多一个极简徽标：当前会话的日志真的在读缓存里、且与磁盘版本一致时，显示绿点 + `已缓存 · 12MB`；
没缓存或缓存已过期就完全不渲染，不占位。

- Host 半新增只读路由 `GET /io-optimizer/cache-state?sessionId=…`，返回 `{ ok, cached, fresh, bytes, ageMs }`。
  新鲜度用与读路径同一把尺子判定（`revision` 相同），所以「显示已缓存」就意味着下一次打开真的不会重新解码。
  路由**不提供会话清单**：调用方必须自带 id，避免把会话列表暴露给同源但未鉴权的请求。
- 浏览器半注册 `conversation.composer.dock` 槽位（id `io-optimizer-cache`，order 95），每 5 秒轮询一次，
  组件卸载/切会话时清掉定时器。`webServer` 晚就绪时每秒重试、最多 20 秒（与同生态插件一致）。
## 0.4.3 — 老配置的秒显示

0.4.2 把配置项改成了秒，但设置页的显示还直接读新键：老配置里只剩 `listCacheTtlMs: 60000` 这类键时，
新键缺席，输入框会显示兜底值（5 秒），而运行时实际按 60 秒在跑。现在表单显示也走同一套换算
（新键 → 旧毫秒键 / 1000 → 兜底），Host 端 `normalizeConfig` 与浏览器端 `numeric()` 口径一致；
清空输入框时保留空字符串，不会立刻跳回兜底值。
## 0.4.2 — 时间类配置改用秒

设置页里所有时间类配置项从毫秒改成秒，填 600 就是 10 分钟，不用再数零：

- `readCacheTtlMs` → `readCacheTtlSecs`（默认 600 秒 = 10 分钟）
- `listCacheTtlMs` → `listCacheSecs`（默认 5 秒）
- `warmDelayMs` → `warmDelaySecs`（默认 15 秒）

**升级兼容**：老配置里的毫秒键仍然认。`normalizeConfig` 在新键缺席时按 1 秒 = 1000 毫秒换算，
换算完再把旧键从归一结果里去掉，设置页只显示新键；新旧同时存在时以新键为准。
内部调度用的 `warmIntervalMs`（400 毫秒）与写合并的 `coalesceMs` 不是用户配置，保持毫秒、不进 schema。
## 0.4.1 — 全量复查后的修补

复查了 host 半个插件与浏览器半个插件，修掉以下问题（均为实现细节，接口不变）：

- **统计被自己污染**：预热器原来调用 `persistence.open()`，于是“插件自己预热”被算成调用方读了一次
  （日志里那两次 `openMiss` 就是这么来的）。改为直接走 `materialize`，`openHit/openMiss` 只反映真实调用。
- **新建会话可能短暂不出现**：`list()` 有 TTL 缓存，新建会话后列表仍返回旧快照。现在包 `create()`
  让列表缓存立刻失效（服务没有 `create` 时自动跳过）。
- **字节预算可能失真**：`sizeBytes` 缺失时会记成 0 字节，预算永远不生效、内存无界。现在拿不到体积
  就不缓存（宁可少缓存，不留隐患）。
- **诊断包装可能套娃**：`sessionQuery.readSession/observeSession` 的计时包装在 HMR 反复 apply 时
  可能叠多层。改为用 `Symbol.for()` 锚点保存原始方法，并只还原自己装的这一层。
- **诊断日志无限增长**：每 200 行检查一次，超过 2MB 轮转成 `.1`；另外支持 `IO_OPT_DIAG=off` 关闭。
- 心跳统计补上 `expired / evicted / warmLoaded`；修正 `DIAG_VERSION` 滞后与缩进。

## 0.4.0 — 缓存加上空闲过期与淘汰策略

- **新增“日志缓存空闲过期时间”**（`readCacheTtlMs`，默认 10 分钟，0 = 永不过期，设置页可改）：
  条目记录最后一次被读到的时刻，超过这么久没再用就直接丢弃，不再白占内存。
- **既有的 LRU 预算保留并补上统计**：会话数（`readCacheSessions`）与源文件总字节
  （`readCacheSourceMb`）双预算，超出时按“最久没使用”淘汰；替换同 id 条目不计入淘汰。
- **每 60 秒后台清理**：清过期条目；配置调小后也据此收缩到新预算（此前要等下一次写入才生效）。
- **统计口径补齐**：`stats.expired`（因空闲过期被丢）、`stats.evicted`（因预算被淘汰），
  一并写进诊断日志的 `stats` 行，能直接看出缓存的进出。

## 0.3.9 — 先看清切换会话走的是哪条路

- 实测结论：用户在界面里反复切换会话时，`sessionPersistence.open(…, 'read')` **一次都没有被调用**
  （计数器里 openMiss 一直是 2，且那两次来自本插件自己 10 秒后的预热）。也就是说切换并不是
  「冷读会话文件」这条路径，插件的缓存对切换根本不起作用——把单会话上限从 12MB 改到 25MB 也不会有区别。
- 这一版在 `ctx.get('sessionQuery')` 的 `readSession` / `observeSession` 上挂计时，往
  `%TEMP%\io-opt-diag.log` 记 `query.readSession id=… ms=…`，用来确认切换究竟走哪一条、每段耗时多少。
  只记录不改行为，卸载时会还原原方法。
- 顺手把日志里的版本标签从 0.3.6 修成当前版本。

## 0.3.8 — 看清缓存到底有没有被用上

- 设置页能保存之后，下一步要回答「改了配置，真的在用缓存吗」。往
  `%TEMP%\io-opt-diag.log` 里补三类记录（只写文件，不影响功能）：
  - `config {...}`：每次 apply 时生效的完整配置，确认保存的值真的到了插件里；
  - `hit id=…` / `miss id=… src=… ms=…` / `skip too-large id=… src=… limit=…`：每次 open
    的判定与耗时，能直接看出是命中、是重解码、还是因为超过单会话上限被跳过（每个会话只记一次跳过）；
  - `stats {...}`：每 15 秒检查一次，**只在计数变化时**写一行，事后可数出命中率。

## 0.3.7 — schema 解析不再依赖安装位置

- **根因确认**：诊断文件显示，从 profile 直接加载时 `schema=ok:self`、`Config` 成立、entry 是
  `io-optimizer`、`settings.describe()` 的 34 个配置节里**有** `io-optimizer`；而以 github 方式
  装进 pnpm store 时，模块从 `.pnpm/<hash>/...` 的真实路径加载，`createRequire(import.meta.url)`
  找不到 profile 里的 `@deepseek-ai/schemastery`，`Config` 就成了 undefined，
  DSH 那边显示 `status: absent`，设置页自然没有内容。安装方式换了，表现就跟着变——这就是
  「重启后又没了」的全部原因。
- **修法**：schema 按 `import.meta.url` → `cwd` → Electron `app.asar`（带 `dsh/` 前缀两种）→
  **逐个 profile 的 `node_modules`** 依次尝试，并记住是哪条基准成功。最后一条与安装方式无关，
  github / 本地 link / 商店 三种装法都能拿到 schemastery。
- 去掉 0.3.6 里那个 10 秒 `describe()` 探针（已确认设置服务能看到本插件），只留启动一行诊断。

## 0.3.6 — 诊断探针（临时）

- 运行期实测：`Config` 没被 DSH 认到（Config inspect 报 `absent`），但同样代码脱离 DSH
  用 `createRequire(import.meta.url)` 却能正常拿到 schemastery。怀疑宿主（尤其 HMR 或
  非 file:// 的模块 URL）下这条解析路径不成立。现在改成按 `import.meta.url` → `cwd` →
  app.asar 三个基准依次尝试，并把每次的结果记下来。
- `apply()` 里加临时探针，把下面这些事实写到 `%TEMP%\io-opt-diag.log`：
  模块 URL、schema 从哪条基准加载成功、`Config` 是否成立、entry id 与 fiber 状态、
  `runtime` 的导出名，以及 10 秒后 `settings.describe()` 的完整 ns 列表和本插件是否在其中。
- 探针只写临时文件，失败也不影响插件功能；确认问题后会在下一版删掉。

## 0.3.5 — 字段标 volatile，设置页才有东西可填

- **根因**：DSH 的 settings 服务只把插件 Config 里声明了 `.volatile()` 的字段投影成表单
  （`volatileForm()` 对没有 volatile 字段的 schema 直接返回 undefined，那一行会被整条跳过），
  写入时每个路径还必须落在 volatile 节点下（否则 `Config field "x" is not volatile`）。
  0.3.0–0.3.4 的六个字段都没有标 volatile，所以无论客户端怎么认领命名空间，设置页都拿不到配置——
  这就是「设置里点了却是空的」的真正原因。
- **六个字段全部 `.volatile()`**：设置侧栏分节与插件页配置页现在都有内容可填。
- **热更新**：volatile 改动的语义是宿主不重挂插件、原位更新配置引用并发 `loader/volatile-update`
  （见 vendor/loader README）。插件监听该事件重新读一次配置，改完立即生效，不再等重启；
  `apply()` 收到的配置若带 cosmokit 的 volatile 引用，`unwrapVolatile` 会逐字段拆包，
  避免把 `{ get() }` 当数字用。
- 客户端保存提示从「插件正在重启」改为「已保存，立即生效」；冒烟测试补上引用拆包与热更新两组断言。

## 0.3.4 — 按字段形状认领配置节

- **修 0.3.3 的设置页落到「没有找到配置项」**：bundle patch 插入的行，其 Settings 命名空间
  和行 id 不一定同名（可能是 `include:<行>`、`<包名>#<行>` 或别的拼法），只按 id 猜会认不出。
  现在先按候选 id / 后缀匹配，再**按字段形状兜底**：某一节的 `value` 或 `schema` 里出现
  `readCacheSessions` / `warmDelayMs` 等本插件独有字段，就认作本插件那一节。
- 认不出时不再只说一句「没有找到」，会把当前可用的配置节名字列出来（最多 5 个），
  省得再去开 DevTools 猜该匹配哪个。

## 0.3.3 — 设置侧栏里的独立分节

- **不用再钻插件页**：注册 `settings.section`（id `better-chat-history`，排在「格式匠」之后的 27 位），
  在 **设置 → 加载缓存** 里直接改六个参数；配套注册 `settings.section.icon`（同一 id，纯函数图标）。
- **两条入口共用一套表单**：插件页那份 `props.form` 与设置页的 `ctx.configForms.get(ns)` 是同一个
  `ConfigForm` 控制器，写入契约一致（`mutate(ops, revision)`），所以两处永远显示同一份值。
- **命名空间现场解析**：bundle patch 的行 id 是 `io-optimizer`，但 Loader 可能登记成
  `include:io-optimizer` 或 `<包名>#io-optimizer`。设置页按「精确候选 → 后缀匹配」认领，
  认不出来时显示说明文字而不是空白页。
- 服务缺失（ui-settings 未加载）与命名空间未 Serve 分别给出不同提示，都不抛错。
- `test/client.mjs` 扩到三类断言组：三个槽位注册、`inject` 注入的 t、设置页三条渲染分支
  （无服务 / 找不到配置 / 正常渲染六字段并带 revision 写入）。

## 0.3.2 — 去掉 top-level await

- 插件模块不再使用 `await import()`：schemastery 改为 `createRequire(import.meta.url)` 同步加载。
  这样插件模块不依赖加载器用什么方式导入（静态 import / 动态 import / 将来的 CJS 兜底都成立），
  同时让脱离 DSH 的单元测试不需要任何特殊处理。
## 0.3.1 — 设置面板的两处收尾

- **旧配置不再被顶掉**：schema 原先给 MB 字段带了默认值，于是任何在 patch 里写了
  `readCacheSessionBytes` 的旧配置都会被默认的 8MB 覆盖。现在 schema 不带默认值，
  默认值只由 `normalizeConfig` 在「用户没写这个键」时补上，字节键继续生效。
- **表单兜底显示**：schema 去掉默认值后，表单自己按 `fallback` 显示初始值（6 / 8 / 64 /
  5000 / 8 / 15000），没有改动时保存不会提交任何 op。
- 新增 `test/client.mjs`（无头跑浏览器半个插件：模块 id、槽位键、降级渲染、字段渲染），
  `npm test` 现在同时跑 Host 与 Client 两套断言。

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

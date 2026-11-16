# ⚡ dsh-better-chat-history

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.2.0-2ea44f)
![DSH](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.3-purple)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**更好的聊天记录加载** —— [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）会话 I/O 优化插件：消除多 Agent 切换会话时的 JSONL 全量冷读（zstd 逐帧解压 + 逐行 JSON 解析），让"点开会话"不再等。

**零依赖**，纯 JS ESM，不修改 DSH 本体——通过包装既有服务实例方法生效，静默运行。

> **0.2.0 是兼容性重写**：适配 DSH `0.2.2-rc.3+` 的句柄式持久化协议。0.1.x 在 rc.3 上会在启动时直接抛错（`persistence.inspect` 已不存在）。详见 [CHANGELOG](./CHANGELOG.md)。

## 🩺 它到底在治什么

DSH 的会话日志是 append-only 的 zstd 分帧文件。每次**冷读**（切换会话、首次打开）都要：

1. 读整个文件 → 逐帧 `zstdDecompressSync`（一个 14 MB 的会话 ≈ 11,000 帧）；
2. 每帧 `JSON.parse` → 构造完整事件数组；
3. 后端自带一个**条目数极少**的冷日志 memo，多开几个会话就把它挤爆，于是下一次切换又从第 1 步开始。

本插件在 `sessionPersistence.open(id, 'read')` 这一层加一层**按 revision 校验的 LRU 读缓存**：命中时直接把内存里的事件数组切片返回，磁盘与解码全部跳过。

### 为什么拦 `open()` 就够了

DSH Web 端打开会话时走的是 `dsh-session-query/src/cold-read.ts` 的 `readColdSessionLog()`：

```ts
const handle = await persistence.open(sessionId, 'read', options)
const read = await handle.read(0, undefined, options)   // 整个日志，一次性
await handle.close()
return { eventState: read.eventState, header: handle.header, ... }
```

也就是说：**每开一次会话 = 一次 open + 一次全量 read**。把 `open` 的只读分支拦下来，就等于把这层全量解码拦下来了；不需要动任何内部私有方法。

## ✨ 特性

- **读缓存（核心）** —— 包装 `open()` 的只读路径：
  - 每次 `open` 先用 `stat(id)` 取 `revision`（后端承诺：revision 相同 ⇒ 日志未变），命中就直接给出缓存句柄，零磁盘 IO；
  - 每次 `read()` 再校验一次 `revision`——正在运行的会话追加事件后立刻可见，**不会拿到陈旧快照**；
  - 同 id 并发请求去重，预热撞上点击时只解码一次。
- **双预算淘汰** —— LRU 同时按「会话数」和「源文件总字节」限制，并跳过超大会话。解码后的 JS 对象约占源文件的 3~5 倍，不设上限会吃掉几个 GB。
- **预热器** —— 启动后台把最近活跃的会话读进缓存，让"第一次点击"也命中。
- **列表缓存** —— `list()` 5 秒 TTL，避免每次刷新 GUI 都扫一遍全部会话头。
- **完全可逆** —— 用 `ctx.effect` disposer 恢复原始方法，带防重复包装标志，HMR / 插件重载安全。

## 📦 安装

```sh
# 从 GitHub 安装（推荐，跟进本仓库的修复）
dsh plugin --profile <profile> add github:lybxkl/dsh-better-chat-history

# 或本地 checkout
git clone https://github.com/lybxkl/dsh-better-chat-history.git
dsh plugin --profile <profile> add ./dsh-better-chat-history
```

包内 `cordis.patch.yml` 会自动成为 bundle 层（含配置覆盖与插件挂载），**重启后生效**。

### 手动挂载（零依赖，无需 pnpm）

1. 把本包放进目标 profile 的 `node_modules\dsh-better-chat-history\`（`lib/index.js` + `cordis.patch.yml` + `package.json` + `dsh.plugin.json`）；
2. 在 profile 的 `package.json` dependencies 加 `"dsh-better-chat-history": "file:<本包路径>"`；
3. 在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')

- id: session-projection-cache
  config:
    writeEveryEvents: 500
    writeIntervalMs: 15000

- insert:
    - id: io-optimizer
      name: 'dsh-better-chat-history'
```

4. 重启 `dsh web`（或 `dsh --profile <profile>`）。

> 需要 dsh ≥ `0.2.2-rc.3`。在更老的版本上服务契约不同，请用 0.1.x。

## ⚙️ 配置项

在 bundle patch 的 `io-optimizer` 行加 `config` 覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `readCacheSessions` | `6` | 最多缓存几个会话（0 关闭读缓存） |
| `readCacheSourceBytes` | `64 MiB` | 缓存会话的源文件总预算 |
| `readCacheSessionBytes` | `8 MiB` | 单个会话的源文件上限，超过就不缓存（避免大对象驻留） |
| `listCacheTtlMs` | `5000` | 会话列表缓存 TTL |
| `warmSessions` | `8` | 启动后预热的最近会话数（0 关闭） |
| `warmDelayMs` | `15000` | 预热开始延迟（避开启动高峰） |
| `warmIntervalMs` | `400` | 每两个会话之间的预热间隔 |
| `coalesceUnits` / `coalesceMs` | — | 旧版写合并用；rc.3 上无挂点，自动跳过 |

## 🛡️ 语义安全

- **只包装只读路径**：`access === 'read'` 才介入；写句柄、`create`、`flush` 原样透传。
- **缓存不改变读到什么**：每次 `read()` 都用 `revision` 重新校验；revision 一变就重读并刷新。
- **句柄语义对齐**：`close` 幂等、`append`/`flush` 在只读句柄上拒绝、`eventState` 原样返回、越界 `offset` 返回空数组。
- **不共享句柄**：句柄是单所有者状态，插件自己开的句柄读完即关，绝不给调用方复用。
- **契约不匹配时安静退出**：缺 `open`/`stat` 只打一条 warn，不抛错、不影响会话功能。

## ✅ 验证

```sh
node test/smoke.mjs     # 内置冒烟测试：命中/失效/切片/close/预热/预算
```

运行期行为：

- 有会话被预热时会打一条 info：`[更好的聊天记录加载] 预热 N 个会话（缓存 X 个 / Y MB）`；
- 正常情况下其余静默（只输出 warn / error）；
- 反复切换同一批会话应接近零等待。

## 🤖 AIGC 声明

本项目部分代码与文档由 AI 辅助生成，并经过人工审查与测试。项目按 MIT 许可证开源，仅供学习与参考；使用者请自行评估代码的安全性与合规性。

## 🔗 相关插件

- [dsh-lag-guard](https://github.com/456erddgr/dsh-lag-guard) —— 限制历史窗口与超大工具 schema
- [dsh-chat-archive](https://github.com/echo-xianyu/dsh-chat-archive) —— 聊天记录管理面板

## 📄 许可证

[MIT](./LICENSE) © 2026 dsh-better-chat-history contributors

# ⚡ dsh-better-chat-history

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.1.0-2ea44f)
![DSH](https://img.shields.io/badge/dsh-%3E%3D0.1.0--rc.6-purple)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**更好的聊天记录加载** —— [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）会话 I/O 优化插件：消除多 Agent 切换会话时的 JSONL 全量冷读，合并投影缓存写放大，延长 SSD 寿命。

**零依赖**，纯 JS ESM，不修改 DSH 本体——通过包装既有服务实例方法 + patch 配置覆盖生效，静默运行。

## ✨ 特性

- **读路径三级缓存**
  - `inspect`：LRU（默认 64 槽，TTL 60s）+ 并发去重（同 id 同时请求只读一次盘）；
  - `readFrom`：缓存命中时直接内存截取，零磁盘 IO；
  - `list`：5s TTL 缓存，避免每次打开 GUI / 刷新都全盘扫描所有会话 header；
- **会话预热器** —— web 启动后后台把最近活跃的会话（默认 24 个）预先 inspect 进缓存，让“初次点击”也命中缓存而不是全量冷读——解决首次打开卡顿的关键；
- **精确失效** —— 监听 `session/event` / `session/created` / `session/disposed`，会话日志一旦变化立即弃对应缓存：最多返回陈旧视图，绝不产生错误数据；
- **写合并** —— 对 fail-soft 的投影缓存做合并落盘（多次 put/delete 在合并窗口内只落盘一次），fsync 频率降低约 10 倍；`workspace.json` 等权威数据**不**合并，保持原语义。

## 📦 安装

### 方式 A（推荐）：Release tarball 安装

```sh
dsh plugin --profile <profile> add ./dsh-better-chat-history-0.1.0.tgz
```

包内 `cordis.patch.yml` 自动成为 bundle 层（含配置覆盖与插件挂载），重启后生效。

### 方式 B：手动挂载（零依赖，无需 pnpm）

1. 把本包放入目标 profile 的 `node_modules\dsh-better-chat-history\`（即 `lib\index.js` + `cordis.patch.yml` + `package.json`，零依赖无需 install）；
2. 在 profile 的 `package.json` dependencies 加 `"dsh-better-chat-history": "file:<本包路径>"`；
3. 在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
# 更好的聊天记录加载
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    preparedSessionCacheSize: 64
    writeBatchMaxDelayMs: 2000

- id: session-projection-cache
  config:
    writeEveryEvents: 500
    writeIntervalMs: 15000

- insert:
    - id: io-optimizer
      name: 'dsh-better-chat-history'
```

4. 重启 `dsh web`（或 `dsh --profile <profile>`）。插件**静默运行**：正常时不输出任何日志（仅 error 级），生效与否看行为——切换 / 初次打开会话明显变快。

> 需要 dsh ≥ 0.1.0-rc.6。Release 资产见页面右侧 **Releases**。

## ✅ 验证

```sh
dsh --profile web --dump-config
# 应看到 session-persistence-jsonl 行带 preparedSessionCacheSize: 64 / writeBatchMaxDelayMs: 2000，以及 io-optimizer 行
```

行为验证：重启后首次点开最近跑过的会话应接近秒开（预热命中）；反复切换会话应无等待（读缓存命中）。

## ⚙️ 配置项

profile patch 中给 `io-optimizer` 行加 config 覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `inspectCacheSize` | 64 | 冷读 LRU 槽数 |
| `inspectCacheTtlMs` | 60000 | 冷读缓存 TTL |
| `listCacheTtlMs` | 5000 | 会话列表缓存 TTL |
| `coalesceUnits` | `["session_projcache"]` | 参与写合并的 storage 单元名 |
| `coalesceMs` | 1500 | 写合并窗口 |
| `warmSessions` | 24 | 启动后预热的最近会话数（0 关闭） |
| `warmDelayMs` | 10000 | 预热开始延迟（避开启动高峰） |
| `warmIntervalMs` | 600 | 每两个会话预热之间的间隔（普通批次） |
| `warmFastCount` | 5 | 优先快速预热的前 N 个会话 |
| `warmFastIntervalMs` | 150 | 优先批次的预热间隔 |

## 🛡️ 语义安全

- 只读路径缓存 + 事件失效：最多返回陈旧视图，绝不产生错误数据；
- 写合并仅作用于 fail-soft 单元，权威数据原样直写；
- 崩溃丢失窗口：最近 ~2s 的日志事件、合并窗口内的投影缓存更新——均符合原设计语义；
- 插件可在 HMR / 重载时恢复原始方法（`ctx.effect` disposer + 防重复包装标志）。

## 🤖 AIGC 声明

本项目部分代码与文档由 AI 辅助生成，并经过人工审查与测试。项目按 MIT 许可证开源，仅供学习与参考；使用者请自行评估代码的安全性与合规性。

## 🔗 相关插件

- [dsh-go-rotator](https://github.com/echo-xianyu/dsh-go-rotator) —— OpenCode Go 订阅 key 轮换器
- [dsh-chat-archive](https://github.com/echo-xianyu/dsh-chat-archive) —— 聊天记录管理面板

## 📄 许可证

[MIT](./LICENSE) © 2026 dsh-better-chat-history contributors

// 更好的聊天记录加载 —— dsh-better-chat-history
//
// 兼容 DSH 0.2.2-rc.3+ 的会话持久化契约：
//   ctx.sessionPersistence = { create, open(id, access), flush, stat(id), list() }
//   SessionHandle            = { id, header, inheritedEventCount, access,
//                                read(offset?, length?), append, flush, close }
//
// 解决的问题：
//   1) 多 Agent 来回切换会话时，后端每次 open 都要全量冷读并解码 JSONL
//      （zstd 逐帧解压 + 逐行 JSON.parse），读放大 → 卡顿 + SSD 磨损。
//   2) 会话列表 list() 被高频调用时的重复扫描。
//
// 做法（全部通过包装既有服务实例方法实现，不修改 DSH 本体）：
//   - 读路径：包装 sessionPersistence.open()。access === 'read' 时先用
//     stat() 取 revision（后端保证：revision 相同 ⇒ 日志未变），命中则直接
//     用内存里的事件数组造一个句柄，完全跳过磁盘与解码。
//   - 校验：句柄的每次 read() 都会重新 stat 比对 revision —— 后端文档承诺
//     "append/flush 解决后，此后开始的读至少能看到该前缀"，所以不能用陈旧
//     快照糊弄正在运行的会话；revision 变了就重读一次并更新缓存。
//   - 淘汰：LRU，按会话数 + 源文件字节数双预算，并跳过超大会话（解码后的
//     JS 对象占用约为原始 JSON 的 3~5 倍，全缓存会吃掉几个 GB）。
//   - 列表：list() 加 5s TTL 缓存。
//   - 预热：启动后台把最近活跃的会话逐个读进缓存，让"第一次点击"就命中。
//
// 语义安全边界：
//   - 只包装 access === 'read'；写句柄、create、flush 全部原样透传。
//   - 句柄的语义保持与真实句柄一致：close 幂等、append/flush 在只读句柄上
//     拒绝、eventState 原样返回、越界 offset 返回空数组。
//   - 缓存只影响"读得多快"，不影响"读到什么"：每次 read 都用 revision 校验。
//
// 与旧版（0.1.x）的差异：DSH 0.2.2-rc.3 起
//   - 服务上不再有 inspect / readFrom（本插件曾因此启动即崩）；
//   - jsonl 后端不再有 preparedSessionCacheSize / writeBatchMaxDelayMs；
//   - storage 的 kv unit 不再暴露 publish/state/assertOpen，写合并没有挂点，
//     因此改为"检测到就启用、检测不到就跳过"，并把写频率交给
//     session-projection-cache 的 writeEveryEvents / writeIntervalMs。

import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

export const name = "io-optimizer";

// storage 只在写合并里用，且可以缺席（例如纯 web profile），所以不作硬依赖。
export const inject = ["sessionPersistence"];

const DEFAULTS = {
  // 读缓存：最多缓存几个会话 / 源文件总预算 / 单个会话上限。
  // 单会话上限刻意保守：冷读路径会把整份事件数组返回给调用方，
  // 缓存里再留一份同样的数组，解码后的对象体积约为源文件的 3~5 倍。
  readCacheSessions: 6,
  readCacheSourceBytes: 64 * 1024 * 1024,
  readCacheSessionBytes: 8 * 1024 * 1024,
  // 日志缓存的空闲过期时间（毫秒）：超过这么久没被读过就丢弃；0 = 永不过期。
  readCacheTtlMs: 10 * 60 * 1000,
  // list() 缓存 TTL
  listCacheTtlMs: 5000,
  // 预热：启动后把最近活跃的会话读进缓存（0 关闭）
  warmSessions: 8,
  warmDelayMs: 15000,
  warmIntervalMs: 400,
  // 写合并（仅在旧版 DSH 的 kv unit 上可用）
  coalesceUnits: ["session_projcache"],
  coalesceMs: 1500,
};

// ── 诊断探针（0.3.6，只写临时文件，不参与功能） ──────────────
const DIAG_VERSION = "0.3.9";
function diag(line) {
  try {
    appendFileSync(join(tmpdir(), "io-opt-diag.log"), `${new Date().toISOString()} [${DIAG_VERSION}] ${line}\n`);
  } catch {
    // 写不了就算了，绝不影响插件功能。
  }
}

// ── 配置 schema（设置面板用） ────────────────────────────────
// schemastery 随 DSH 一起安装（profile 的 node_modules 里就有），但本包坚持
// 零硬依赖：拿不到就退化成"没有设置面板"，插件功能不受影响。
//
// 0.3.6：运行期实测 Config 没被 DSH 认到（Config inspect 显示 absent），而脱离
// DSH 用同样的路径 import 却一切正常，说明 createRequire(import.meta.url) 在
// 宿主的加载方式下不成立。这里改成按多个基准路径依次尝试，并把每次的失败原因
// 留下来。
let Schema;
let schemaLoadNote = "";
{
  const bases = [];
  const push = (label, base) => {
    if (typeof base === "string" && base !== "") bases.push({ label, base });
  };
  push("self", import.meta.url);
  try {
    push("cwd", join(process.cwd(), "noop.mjs"));
  } catch {
    // 没有 process 就跳过。
  }
  try {
    // Electron 主进程：DSH 自带的 schemastery 在 app.asar 里（带 dsh/ 前缀）。
    const resources = process.resourcesPath;
    if (typeof resources === "string") {
      push("asar", join(resources, "app.asar", "dsh", "node_modules", "@deepseek-ai", "schemastery", "package.json"));
      push("asar-flat", join(resources, "app.asar", "node_modules", "@deepseek-ai", "schemastery", "package.json"));
    }
  } catch {
    // 非 Electron 环境没有 resourcesPath。
  }
  try {
    // 兜底：任何 profile 的 node_modules 里都有 schemastery。
    // github 方式装进 .pnpm 的包，从这里 import 时自己那份解析不到，这条能救回来。
    const home = process.env.DSH_HOME || join(homedir(), ".dsh");
    const profilesDir = join(home, "profiles");
    for (const name of readdirSync(profilesDir)) {
      push(`profile:${name}`, join(profilesDir, name, "node_modules", "@deepseek-ai", "schemastery", "package.json"));
    }
  } catch {
    // 目录不可读就跳过。
  }
  for (const { label, base } of bases) {
    try {
      const loaded = createRequire(base)("@deepseek-ai/schemastery");
      const candidate = loaded?.default ?? loaded;
      if (candidate !== undefined && candidate !== null && typeof candidate.object === "function") {
        Schema = candidate;
        schemaLoadNote = `ok:${label}`;
        break;
      }
      schemaLoadNote += `${label}=not-a-schema;`;
    } catch (error) {
      schemaLoadNote += `${label}=${error?.code ?? error?.name ?? "error"};`;
    }
  }
}

const MB = 1024 * 1024;

/**
 * 拆掉宿主塞进来的 volatile 引用。
 *
 * 标记为 `.volatile()` 的字段在运行期可能是 cosmokit 的 createVolatile 引用：
 * 一个只带 get() 的冻结对象，宿主热更新时原位替换它里面的值。普通值原样返回。
 *
 * @param value - 配置值（可能是引用）。
 * @returns 普通值。
 */
export function unwrapVolatile(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof value.get !== "function") return value;
  const keys = Reflect.ownKeys(value);
  if (!keys.includes("get")) return value;
  // 引用只有 get 这一个字符串键，其余是内部的 symbol 写入通道。
  if (keys.some((key) => typeof key === "string" && key !== "get")) return value;
  try {
    const inner = value.get();
    return inner === value ? value : inner;
  } catch {
    return value;
  }
}

/**
 * 把整个配置对象拍平成普通值。
 *
 * @param raw - apply() 收到的配置，可能是引用或含引用。
 * @returns 新的普通对象。
 */
export function unwrapConfig(raw) {
  const value = unwrapVolatile(raw);
  if (value === null || typeof value !== "object") return {};
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = unwrapVolatile(child);
  return out;
}

/** values 里的 MB 字段换算成内部使用的字节数。 */
export function normalizeConfig(raw = {}) {
  const given = unwrapConfig(raw);
  const cfg = { ...DEFAULTS };
  for (const [key, value] of Object.entries(given)) {
    if (value !== undefined) cfg[key] = value;
  }
  // 只有在用户真的写了 MB 字段时才换算：schema 刻意不带默认值，
  // 这样老配置里的 readCacheSessionBytes 不会被一个默认的 MB 值顶掉。
  const has = (key) => given[key] !== undefined && Number.isFinite(Number(given[key]));
  if (has("readCacheSessionMb")) {
    cfg.readCacheSessionBytes = Math.max(0, Math.round(Number(given.readCacheSessionMb) * MB));
  }
  if (has("readCacheSourceMb")) {
    cfg.readCacheSourceBytes = Math.max(1, Math.round(Number(given.readCacheSourceMb) * MB));
  }
  return cfg;
}

export const Config = Schema === undefined ? undefined : Schema.object({
  // 每个字段都要 .volatile()：DSH 的 settings 服务只把 volatile 字段投影成表单，
  // 普通配置字段不会出现在任何设置页里（volatileForm() 直接返回 undefined）。
  // volatile 同时意味着宿主做原位热更新——改完不必重启插件。
  readCacheSessions: Schema.number()
    .min(0)
    .max(64)
    .step(1)
    .description("最多缓存几个会话的日志（0 = 关闭读缓存）。")
    .volatile(),
  readCacheSessionMb: Schema.number()
    .min(0)
    .max(512)
    .step(1)
    .description("单个会话的源文件上限（MB）：超过就不缓存，避免解码后的大对象常驻内存。")
    .volatile(),
  readCacheSourceMb: Schema.number()
    .min(1)
    .max(4096)
    .step(1)
    .description("所有缓存会话的源文件字节总预算（MB）。")
    .volatile(),
  readCacheTtlMs: Schema.number()
    .min(0)
    .max(3600000)
    .step(60000)
    .description("日志缓存的空闲过期时间（毫秒）：这么久没再被读到就丢弃，0 = 永不过期。")
    .volatile(),
  listCacheTtlMs: Schema.number()
    .min(0)
    .max(600000)
    .step(500)
    .description("会话列表 list() 的缓存时长（毫秒，0 = 不缓存）。")
    .volatile(),
  warmSessions: Schema.number()
    .min(0)
    .max(64)
    .step(1)
    .description("启动后在后台预热的会话数（0 = 关闭）。")
    .volatile(),
  warmDelayMs: Schema.number()
    .min(0)
    .max(300000)
    .step(1000)
    .description("预热开始前的延迟（毫秒），避开启动高峰。")
    .volatile(),
});

/** 取一个可用的 logger：cordis 的 logger 服务可能是函数式命名器。 */
function loggerOf(ctx) {
  try {
    const logger = typeof ctx.logger === "function" ? ctx.logger("io-optimizer") : ctx.logger;
    if (logger && typeof logger.warn === "function" && typeof logger.error === "function") return logger;
  } catch {
    /* 落到 console */
  }
  return console;
}

export function apply(ctx, rawConfig = {}) {
  let cfg = normalizeConfig(rawConfig);
  const log = loggerOf(ctx);
  diag(`config ${JSON.stringify(cfg)}`);
  // 六个字段都是 volatile：宿主改配置时不重挂插件，而是原位更新引用再发这个事件。
  // 重新读一次配置即可生效；老宿主没有这个事件时改动在重启后生效，不影响功能。
  try {
    if (typeof ctx.on === "function") {
      ctx.on("loader/volatile-update", () => {
        try {
          cfg = normalizeConfig(rawConfig);
        } catch (error) {
          log.warn("[更好的聊天记录加载] 读取热更新后的配置失败，继续用旧值", error);
        }
      });
    }
  } catch {
    // 宿主不支持该事件：保持启动时的配置。
  }

  // ── 诊断探针（0.3.6 临时，只写 %TEMP%\io-opt-diag.log）─────────
  // 记录模块加载方式、Config 是否成立、本 entry 的身份，并在 10 秒后再问一次
  // settings 服务：它到底有没有把本插件投影成一个配置节。
  try {
    const fiber = ctx.fiber;
    let entryId = "?";
    let fiberState = "?";
    let runtimeKeys = "";
    try {
      entryId = fiber?.entry?.options?.id ?? "?";
      fiberState = String(fiber?.state ?? "?");
      runtimeKeys = Object.keys(fiber?.runtime ?? {}).join("|");
    } catch {
      runtimeKeys = "(unreadable)";
    }
    diag(
      `apply v${DIAG_VERSION} url=${import.meta.url} schema=${Schema === undefined ? "undefined" : schemaLoadNote}`
      + ` config=${Config === undefined ? "undefined" : "ok"} entry=${entryId} state=${fiberState}`
      + ` runtime=${runtimeKeys || "(empty)"}`,
    );
  } catch (error) {
    diag(`apply diag failed: ${error?.message ?? String(error)}`);
  }

  const persistence = ctx.get("sessionPersistence");
  if (
    persistence === undefined ||
    persistence === null ||
    typeof persistence.open !== "function" ||
    typeof persistence.stat !== "function"
  ) {
    log.warn(
      "[更好的聊天记录加载] 当前 DSH 的 sessionPersistence 服务缺少 open/stat（需要 0.2.2-rc.3+），插件不启用",
    );
    lastStats = null;
    return;
  }

  // ── 读缓存状态 ────────────────────────────────────────────
  // id -> { id, revision, header, inheritedEventCount, eventState, events,
  //         sourceBytes, at }；Map 插入序即 LRU 序。
  const cache = new Map();
  let cacheBytes = 0;
  const inflight = new Map(); // 并发去重：同一 id 同时只解码一次
  let listCache = null; // { at, value }
  const skipLogged = new Set(); // 每个会话只记一次"因过大而跳过"

  const stats = {
    openHit: 0,
    openMiss: 0,
    openTooLarge: 0,
    expired: 0,
    evicted: 0,
    refreshReDecode: 0,
    listHit: 0,
    listMiss: 0,
    warmLoaded: 0,
    coalescedOps: 0,
    coalescedPublishes: 0,
  };

  const touch = (id) => {
    const entry = cache.get(id);
    if (entry !== undefined) {
      entry.usedAt = Date.now();
      cache.delete(id);
      cache.set(id, entry);
    }
  };

  /** 静默移除（替换同 id 条目时用），不计入淘汰统计。 */
  const drop = (id) => {
    const entry = cache.get(id);
    if (entry !== undefined) {
      cacheBytes -= entry.sourceBytes;
      cache.delete(id);
    }
  };

  /** 淘汰：LRU 预算或空闲过期时用，计入 stats.evicted。 */
  const evict = (id) => {
    if (cache.has(id)) {
      stats.evicted++;
      drop(id);
    }
  };

  let warnedOwnership = false;
  const storeEntry = (entry) => {
    if (cfg.readCacheSessions <= 0) return false;
    // 事件值只有在 shared-frozen 时才可以跨调用方共享。'exclusive' 意味着
    // 事件值归调用方独占，它可能就地改写这些对象——那种情况下缓存会把
    // 上一轮的改写泄漏给下一个读者，所以一律不进缓存。
    if (entry.eventState !== "shared-frozen") {
      if (!warnedOwnership) {
        warnedOwnership = true;
        log.info?.(
          `[更好的聊天记录加载] 事件所有权是 '${String(entry.eventState)}'（非 shared-frozen），为安全起见不缓存事件，只保留直读`,
        );
      }
      return false;
    }
    if (!(entry.sourceBytes >= 0)) return false;
    if (entry.sourceBytes > cfg.readCacheSessionBytes) return false;
    // 单条就超过总预算时直接不存，避免"存进去又立刻被自己挤掉"。
    if (entry.sourceBytes > cfg.readCacheSourceBytes) return false;
    // 两个不同 revision 的读取可能乱序完成：先发起的那次即使后完成，也不许
    // 把已经写入的更新快照顶掉（at 记的是发起时刻，不是完成时刻）。
    const existing = cache.get(entry.id);
    if (
      existing !== undefined &&
      existing.revision !== entry.revision &&
      existing.at >= entry.at
    ) {
      return false;
    }
    drop(entry.id);
    entry.usedAt = Date.now();
    cache.set(entry.id, entry);
    cacheBytes += entry.sourceBytes;
    for (const id of [...cache.keys()]) {
      if (cache.size <= cfg.readCacheSessions && cacheBytes <= cfg.readCacheSourceBytes) break;
      if (id === entry.id) break;
      evict(id);
    }
    return true;
  };

  // 原始方法锚在服务对象的 symbol 上，跨实例共享：在设置面板里改配置会重启插件
  // （apply 重跑），没有锚点就会一层层套娃，且旧实例的 dispose 会把新包装顶掉。
  const ANCHOR = Symbol.for("dsh-better-chat-history.originals");
  const originals = persistence[ANCHOR] ?? (persistence[ANCHOR] = {
    open: persistence.open.bind(persistence),
    stat: persistence.stat.bind(persistence),
    list: persistence.list.bind(persistence),
  });
  const origOpen = originals.open;
  const origStat = originals.stat;
  const origList = originals.list;

  // 取消必须传播：被 abort 的读不能静默返回陈旧数据。
  const safeStat = async (id, options) => {
    try {
      return await origStat(id, options);
    } catch (error) {
      if (options?.signal?.aborted === true) throw error;
      return undefined;
    }
  };

  /** 把一次真实读取的结果装成缓存条目。 */
  const readIntoEntry = async (handle, id, snapshot, options, startedAt) => {
    const result = await handle.read(0, undefined, options);
    return {
      id,
      revision: snapshot.revision,
      header: handle.header ?? snapshot.header,
      inheritedEventCount: handle.inheritedEventCount ?? 0,
      eventState: result.eventState,
      events: result.events,
      sourceBytes: typeof snapshot.sizeBytes === "number" ? snapshot.sizeBytes : 0,
      at: startedAt,
    };
  };

  /**
   * 用真实句柄读一次日志，收成缓存条目后立刻关掉该句柄。
   * 并发去重按 (id, revision) 做：同一份日志同时只解码一次（预热撞上点击时
   * 省一次全量读），但不同 revision 的读取绝不互相复用结果。
   * 注意：这里绝不把句柄交出去 —— 句柄是单所有者状态，共享会破坏语义。
   */
  const materialize = async (id, snapshot, options) => {
    const key = `${id}\u0000${snapshot.revision}`;
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;
    const task = (async () => {
      const handle = await origOpen(id, "read", options);
      try {
        const entry = await readIntoEntry(handle, id, snapshot, options, Date.now());
        return { entry, cached: storeEntry(entry) };
      } finally {
        await handle.close().catch(() => {});
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  };

  /**
   * read() 之前校验 revision：变了就重读并刷新条目。
   * 后端保证 revision 相同 ⇒ 日志未变，因此这里不会漏掉已提交的前缀。
   */
  const refreshEntry = async (entry, options) => {
    const snapshot = await safeStat(entry.id, options);
    if (snapshot === undefined) return entry; // 会话消失：维持最后一次视图
    if (snapshot.revision === entry.revision) return entry;
    try {
      const next = await materialize(entry.id, snapshot, options);
      stats.refreshReDecode++;
      return next.entry;
    } catch (error) {
      if (options?.signal?.aborted === true) throw error;
      return entry;
    }
  };

  /** 用内存里的条目伪造一个只读句柄，语义与真实句柄保持一致。 */
  const makeCachedHandle = (initial) => {
    let entry = initial;
    let closed = false;
    const assertLive = () => {
      if (!closed) return;
      // 名字对齐上游的 SessionHandleClosedError，便于按 name 判别的调用方识别
      const error = new Error(`session handle '${initial.id}' is closed`);
      error.name = "SessionHandleClosedError";
      throw error;
    };
    return {
      id: initial.id,
      get header() {
        return entry.header;
      },
      get inheritedEventCount() {
        return entry.inheritedEventCount;
      },
      access: "read",
      async read(offset = 0, length, options) {
        assertLive();
        options?.signal?.throwIfAborted?.();
        entry = await refreshEntry(entry, options);
        const events = entry.events;
        const from = offset > 0 ? offset : 0;
        const to = length === undefined ? events.length : Math.min(events.length, from + length);
        if (from >= events.length) return { eventState: entry.eventState, events: [] };
        return { eventState: entry.eventState, events: events.slice(from, to) };
      },
      append() {
        return Promise.reject(new Error(`session handle '${initial.id}' is read-only`));
      },
      flush() {
        return Promise.reject(new Error(`session handle '${initial.id}' is read-only`));
      },
      async close() {
        closed = true;
      },
      [Symbol.asyncDispose]() {
        closed = true;
        return Promise.resolve();
      },    };
  };

  // 总是安装包装（不再用全局布尔量挡重复安装）：配置改动会重启插件，
  // 新旧实例的安装/卸载顺序不固定，靠下面的身份校验保证卸载只撤掉自己那一层。
  {
    const wrappedOpen = async (id, access, options) => {
      if (access !== "read") return origOpen(id, access, options);
      // 缓存关掉时彻底不介入：否则会出现"先白读一遍再退回上游"的双倍解码。
      if (cfg.readCacheSessions <= 0) return origOpen(id, access, options);
      options?.signal?.throwIfAborted?.();

      const snapshot = await safeStat(id, options);
      if (snapshot === undefined) return origOpen(id, access, options);

      const cached = cache.get(id);
      if (cached !== undefined && cached.revision === snapshot.revision) {
        // 空闲过期：太久没被读过就当没有，避免内存里长期躺着不再用的会话。
        const idleFor = Date.now() - (cached.usedAt ?? cached.at ?? 0);
        if (cfg.readCacheTtlMs > 0 && idleFor > cfg.readCacheTtlMs) {
          stats.expired++;
          evict(id);
          diag(`expired id=${id} idle=${idleFor}ms`);
        } else {
          stats.openHit++;
          touch(id);
          diag(`hit id=${id}`);
          return makeCachedHandle(cached);
        }
      }

      // 已知超过单会话上限：直接交给上游，不为缓存白读一遍。
      if (typeof snapshot.sizeBytes === "number" && snapshot.sizeBytes > cfg.readCacheSessionBytes) {
        stats.openTooLarge++;
        if (!skipLogged.has(id)) {
          skipLogged.add(id);
          diag(`skip too-large id=${id} src=${snapshot.sizeBytes} limit=${cfg.readCacheSessionBytes}`);
        }
        return origOpen(id, access, options);
      }

      stats.openMiss++;
      const missAt = Date.now();
      let materialized;
      try {
        materialized = await materialize(id, snapshot, options);
      } catch (error) {
        diag(`miss failed id=${id} ${error?.message ?? ""}`);
        return origOpen(id, access, options);
      }
      diag(`miss id=${id} src=${snapshot.sizeBytes ?? "?"} ms=${Date.now() - missAt}`);
      // 无论是否入缓存，都把这次已经读到的数据交给调用方——绝不再读第二遍。
      return makeCachedHandle(materialized.entry);
    };

    // 统计心跳：只有在计数变化时才写一行，便于事后判断缓存到底有没有被用上。
  {
    const seen = { openHit: 0, openMiss: 0, openTooLarge: 0, listHit: 0, listMiss: 0, refreshReDecode: 0 };
    const timer = setInterval(() => {
      const changed = Object.keys(seen).some((key) => seen[key] !== stats[key]) || seen.cached !== cache.size;
      if (!changed) return;
      for (const key of Object.keys(seen)) seen[key] = stats[key];
      seen.cached = cache.size;
      diag(`stats ${JSON.stringify({ ...stats, cachedSessions: cache.size, cachedBytes: cacheBytes })}`);
    }, 15000);
    if (timer !== null && typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  }

  const wrappedList = async (options) => {
      if (listCache !== null && Date.now() - listCache.at < cfg.listCacheTtlMs) {
        stats.listHit++;
        return [...listCache.value];
      }
      stats.listMiss++;
      const result = await origList(options);
      // 存一份副本、返回一份副本：调用方改到的不可能是缓存里的数组。
      listCache = { at: Date.now(), value: [...result] };
      return [...result];
    };

    persistence.open = wrappedOpen;
    persistence.list = wrappedList;

    // 不做事件驱动的整体失效：那会在活跃会话里每来一条事件就清空整个缓存。
    // 正确性由 read() 里的 revision 校验兜住（后端保证 revision 相同 ⇒ 日志未变）。
    // 定期清理：① 空闲过期 ② 配置改小之后按新预算收缩（否则要等下一次写入才生效）。
    const sweepTimer = setInterval(() => {
      const ttl = cfg.readCacheTtlMs;
      const now = Date.now();
      for (const [id, entry] of [...cache.entries()]) {
        if (ttl > 0 && now - (entry.usedAt ?? entry.at ?? 0) > ttl) evict(id);
      }
      for (const id of [...cache.keys()]) {
        if (cache.size <= cfg.readCacheSessions && cacheBytes <= cfg.readCacheSourceBytes) break;
        evict(id);
      }
    }, 60 * 1000);
    if (sweepTimer !== null && typeof sweepTimer === "object" && typeof sweepTimer.unref === "function") sweepTimer.unref();

    const invalidateAll = () => {
      cache.clear();
      cacheBytes = 0;
      inflight.clear();
      listCache = null;
    };

    ctx.effect(
      () => () => {
        // 只撤销自己这一层：若更新的实例已经装上，撤它就是破坏。
        if (persistence.open === wrappedOpen) persistence.open = origOpen;
        if (persistence.list === wrappedList) persistence.list = origList;
        invalidateAll();
        clearInterval(sweepTimer);
      },
      "io-optimizer.read-restore",
    );
  }

  // ── 诊断：切换会话到底走哪条读路径（0.3.9 临时）──────────────
  // 计数器显示切会话时 open() 一次都没被调用，所以先看 sessionQuery 的读方法
  // 有没有被调用、各自耗时多少。只记录，不改行为。
  try {
    const query = ctx.get("sessionQuery");
    if (query === undefined || query === null) {
      diag("sessionQuery 不可用，无法观测切换路径");
    } else {
      const originals = [];
      for (const name of ["readSession", "observeSession"]) {
        const fn = query[name];
        if (typeof fn !== "function") continue;
        const wrapped = async (...args) => {
          const first = args[0];
          const id = typeof first === "string" ? first : (first?.sessionId ?? "?");
          const at = Date.now();
          try {
            const result = await fn.apply(query, args);
            diag(`query.${name} id=${id} ms=${Date.now() - at}`);
            return result;
          } catch (error) {
            diag(`query.${name} id=${id} ms=${Date.now() - at} fail=${error?.message ?? ""}`);
            throw error;
          }
        };
        originals.push([name, fn]);
        query[name] = wrapped;
      }
      if (originals.length > 0 && typeof ctx.effect === "function") {
        ctx.effect(
          () => () => {
            for (const [name, fn] of originals) query[name] = fn;
          },
          "io-optimizer.query-diag",
        );
      }
    }
  } catch (error) {
    diag(`query 诊断安装失败: ${error?.message ?? String(error)}`);
  }

  // ── 预热器：让"第一次点击"就命中缓存 ───────────────────────
  if (cfg.warmSessions > 0) {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const snapshots = await origList();
          const ids = snapshots
            .map((snapshot) => ({
              id: snapshot?.header?.id,
              createdAt: Number(snapshot?.header?.createdAt ?? 0),
              sizeBytes: Number(snapshot?.sizeBytes ?? 0),
            }))
            .filter((entry) => typeof entry.id === "string")
            .filter((entry) => entry.sizeBytes <= cfg.readCacheSessionBytes)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, cfg.warmSessions)
            .map((entry) => entry.id);
          let warmed = 0;
          for (const id of ids) {
            try {
              const handle = await persistence.open(id, "read");
              await handle.close();
              warmed++;
            } catch {
              /* 单个会话预热失败（日志损坏等）不影响整体 */
            }
            await new Promise((resolve) => setTimeout(resolve, cfg.warmIntervalMs));
          }
          stats.warmLoaded = warmed;
          if (warmed > 0) {
            log.info?.(
              `[更好的聊天记录加载] 预热 ${warmed} 个会话（缓存 ${cache.size} 个 / ${Math.round(cacheBytes / 1048576)}MB）`,
            );
          }
        } catch {
          /* 预热失败静默：读缓存不影响功能 */
        }
      })();
    }, cfg.warmDelayMs);
    ctx.effect(() => () => clearTimeout(timer), "io-optimizer.warmup");
  }

  // ── 写合并（仅在旧版 DSH 的 kv unit 上可用） ────────────────
  // DSH 0.2.2-rc.3 的 KvUnit 只有 loadAll/putRecord/deleteRecord/
  // deleteRecords/setGlobal/close，没有 publish/state/assertOpen，
  // 也就没有"先在内存改、再统一落盘"的挂点。检测不到就跳过，
  // 写频率交给 session-projection-cache 的 writeEveryEvents/writeIntervalMs。
  const storage = ctx.get("storage");
  if (storage !== undefined && storage !== null && storage.backend !== undefined) {
    let backend;
    try {
      backend = typeof storage.backend.get === "function" ? storage.backend.get("json") : undefined;
    } catch {
      backend = undefined;
    }
    const kv = backend?.kv;
    if (
      kv !== undefined &&
      kv !== null &&
      typeof kv.open === "function" &&
      kv.__ioCoalesced !== true
    ) {
      const origOpen = kv.open.bind(kv);
      let supported = null; // 首次 open 时探测
      kv.__ioCoalesced = true;

      kv.open = async (descriptor) => {
        const unit = await origOpen(descriptor);
        if (!cfg.coalesceUnits.includes(descriptor.name) || unit.__ioCoalesced) return unit;
        const usable =
          typeof unit.publish === "function" &&
          typeof unit.assertOpen === "function" &&
          unit.state !== undefined &&
          typeof unit.putRecord === "function";
        if (supported === null) {
          supported = usable;
          if (!usable) {
            log.info?.(
              "[更好的聊天记录加载] 当前 DSH 的 kv unit 没有 publish 挂点，写合并已跳过（改用投影缓存的写入节流）",
            );
          }
        }
        if (!usable) return unit;
        unit.__ioCoalesced = true;

        let timer = null;
        let dirty = false;

        const publish = async () => {
          dirty = false;
          try {
            await unit.publish();
            stats.coalescedPublishes++;
          } catch (error) {
            log.error?.(
              `[更好的聊天记录加载] 合并写失败 ${unit.path}: ${String(error)}（缓存保持陈旧，下次写入自愈）`,
            );
          }
        };
        const schedule = () => {
          stats.coalescedOps++;
          if (dirty) return;
          dirty = true;
          timer = setTimeout(() => {
            timer = null;
            void publish();
          }, cfg.coalesceMs);
        };

        const origClose = unit.close.bind(unit);

        unit.putRecord = async (table, key, value) => {
          unit.assertOpen();
          unit.state.tables.get(table).set(key, value);
          schedule();
        };
        unit.deleteRecord = async (table, key) => {
          unit.assertOpen();
          unit.state.tables.get(table).delete(key);
          schedule();
        };
        unit.setGlobal = async (value) => {
          unit.assertOpen();
          unit.state.global = value;
          schedule();
        };
        unit.close = async () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          if (dirty) {
            dirty = false;
            await publish();
          }
          await origClose();
        };
        return unit;
      };

      ctx.effect(
        () => () => {
          kv.open = origOpen;
          kv.__ioCoalesced = false;
        },
        "io-optimizer.write-restore",
      );
    }
  }

  // 诊断：插件实例的命中率，供调试/体检读取
  lastStats = () => ({ ...stats, cachedSessions: cache.size, cachedBytes: cacheBytes });
}

/** 最近一次 apply 的诊断快照；未启用时返回 null。 */
let lastStats = null;
export function stats() {
  return lastStats === null ? null : lastStats();
}

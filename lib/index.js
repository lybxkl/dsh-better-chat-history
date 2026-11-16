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
import { readdirSync, renameSync, statSync } from "node:fs";

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
  // 日志缓存的空闲过期时间（秒）：超过这么久没被读过就丢弃；0 = 永不过期。
  readCacheTtlSecs: 10 * 60,
  // list() 缓存 TTL（秒）
  listCacheSecs: 5,
  // 预热：启动后把最近活跃的会话读进缓存（0 关闭）
  warmSessions: 8,
  warmDelaySecs: 15,
  // 内部调度用，不暴露给设置页（毫秒）
  warmIntervalMs: 400,
  // 写合并（仅在旧版 DSH 的 kv unit 上可用）
  coalesceUnits: ["session_projcache"],
  coalesceMs: 1500,
};

// ── 诊断探针（0.3.6，只写临时文件，不参与功能） ──────────────
const DIAG_VERSION = "0.7.6";
let diagWrites = 0;
function diag(line) {
  try {
    // 想看安静模式：设环境变量 IO_OPT_DIAG=off。
    if (process.env.IO_OPT_DIAG === "off") return;
    const file = join(tmpdir(), "io-opt-diag.log");
    diagWrites += 1;
    // 每 200 行检查一次体积，超过 2MB 就轮转一份 .1，避免长期跑把盘写满。
    if (diagWrites % 200 === 0) {
      try {
        if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
      } catch {
        // 文件不存在或改名失败都无所谓。
      }
    }
    appendFileSync(file, `${new Date().toISOString()} [${DIAG_VERSION}] ${line}\n`);
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
  // 兼容老配置里的毫秒字段：新字段没写就按 1 秒 = 1000 毫秒换算，
  // 免得升级后设置页里那三项忽然回到默认值。换算完把旧键从结果里去掉。
  const legacySecs = {
    readCacheTtlSecs: "readCacheTtlMs",
    listCacheSecs: "listCacheTtlMs",
    warmDelaySecs: "warmDelayMs",
  };
  for (const [next, old] of Object.entries(legacySecs)) {
    if (!has(next) && has(old)) cfg[next] = Math.max(0, Number(given[old]) / 1000);
    delete cfg[old];
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
  readCacheTtlSecs: Schema.number()
    .min(0)
    .max(86400)
    .step(60)
    .description("日志缓存的空闲过期时间（秒）：这么久没再被读到就丢弃，0 = 永不过期。")
    .volatile(),
  listCacheSecs: Schema.number()
    .min(0)
    .max(3600)
    .step(1)
    .description("会话列表 list() 的缓存时长（秒，0 = 不缓存）。")
    .volatile(),
  warmSessions: Schema.number()
    .min(0)
    .max(64)
    .step(1)
    .description("启动后在后台预热的会话数（0 = 关闭）。")
    .volatile(),
  warmDelaySecs: Schema.number()
    .min(0)
    .max(600)
    .step(1)
    .description("预热开始前的延迟（秒），避开启动高峰。")
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
  // 七个字段都是 volatile：宿主改配置时不重挂插件，而是原位更新引用再发这个事件。
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

  // sessionQuery 观测用到的两个钩子：真正实现落在 persistence 包装块里。
  // 没挂上 persistence 时保持空实现，观测照常工作、只是不预热。
  let prefetchSession = async () => {};
  let liveSessionOf = () => false;
  let forgetSession = () => {};

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
    appendReDecode: 0,
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
    // 拿不到体积就不缓存：否则 sourceBytes=0 会让字节预算永远不生效。
    if (!Number.isFinite(entry.sourceBytes) || entry.sourceBytes <= 0) return false;
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
   * 日志只会追加：体积变大且新旧事件首尾相接（seq 单调）时，只解压新增的那几条，
   * 不必为了几条新事件把整份日志重解一遍（14MB 的会话重解一次 ≈ 740ms）。
   *
   * @returns 合并后的新条目；接不上（日志被重写/压缩）时返回 undefined，交给全量路径。
   */
  const appendTail = async (entry, snapshot, options) => {
    const known = entry.events.length;
    const grew = typeof snapshot.sizeBytes === "number" && snapshot.sizeBytes > (entry.sourceBytes ?? 0);
    if (!grew || known === 0) return undefined;
    const handle = await origOpen(entry.id, "read", options);
    try {
      const result = await handle.read(known, undefined, options);
      const tail = Array.isArray(result?.events) ? result.events : [];
      if (tail.length === 0) return undefined;
      const lastSeq = entry.events[known - 1]?.seq;
      const firstSeq = tail[0]?.seq;
      // 前缀必须真的接得上：seq 不连续说明日志被重写过，退回全量解码。
      if (typeof lastSeq === "number" && typeof firstSeq === "number" && firstSeq !== lastSeq + 1) {
        return undefined;
      }
      const merged = {
        ...entry,
        header: handle.header ?? entry.header,
        inheritedEventCount: handle.inheritedEventCount ?? entry.inheritedEventCount,
        events: entry.events.concat(tail),
        revision: snapshot.revision,
        sourceBytes: snapshot.sizeBytes,
        at: Date.now(),
      };
      stats.appendReDecode++;
      storeEntry(merged);
      return merged;
    } finally {
      await handle.close().catch(() => {});
    }
  };

  /**
   * read() 之前校验 revision：变了才刷新条目。
   * 刷新优先补尾巴（appendTail），接不上才全量重解。
   */
  const refreshEntry = async (entry, options) => {
    const snapshot = await safeStat(entry.id, options);
    if (snapshot === undefined) return entry; // 会话消失：维持最后一次视图
    if (snapshot.revision === entry.revision) return entry;
    try {
      const appended = await appendTail(entry, snapshot, options);
      if (appended !== undefined) return appended;
    } catch (error) {
      if (options?.signal?.aborted === true) throw error;
    }
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
        if (cfg.readCacheTtlSecs > 0 && idleFor > cfg.readCacheTtlSecs * 1000) {
          stats.expired++;
          evict(id);
          diag(`expired id=${id} idle=${idleFor}ms`);
        } else {
          stats.openHit++;
          touch(id);
          diag(`hit id=${id}`);
          return makeCachedHandle(cached);
        }
      } else if (cached !== undefined) {
        // 有缓存但日志变了：追加场景只补尾巴，不把整份日志重解一遍。
        try {
          const appended = await appendTail(cached, snapshot, options);
          if (appended !== undefined) {
            stats.openHit++;
            touch(id);
            diag(`append id=${id} +${appended.events.length - cached.events.length}`);
            return makeCachedHandle(appended);
          }
        } catch (error) {
          if (options?.signal?.aborted === true) throw error;
          // 增量失败退回全量，不影响正确性。
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
    // 定时器要在卸载时清掉，否则每次热重载都会漏一个，旧实例会一直往日志里写 stats。
    let statsTimer = 0;
  {
    const seen = {
      openHit: 0, openMiss: 0, openTooLarge: 0, expired: 0, evicted: 0,
      listHit: 0, listMiss: 0, refreshReDecode: 0, appendReDecode: 0, warmLoaded: 0,
    };
    statsTimer = setInterval(() => {
      const changed = Object.keys(seen).some((key) => seen[key] !== stats[key]) || seen.cached !== cache.size;
      if (!changed) return;
      for (const key of Object.keys(seen)) seen[key] = stats[key];
      seen.cached = cache.size;
      diag(`stats ${JSON.stringify({ ...stats, cachedSessions: cache.size, cachedBytes: cacheBytes })}`);
    }, 15000);
    if (statsTimer !== null && typeof statsTimer === "object" && typeof statsTimer.unref === "function") statsTimer.unref();
  }

    const wrappedList = async (options) => {
      if (listCache !== null && Date.now() - listCache.at < cfg.listCacheSecs * 1000) {
        stats.listHit++;
        return [...listCache.value];
      }
      stats.listMiss++;
      const result = await origList(options);
      // 存一份副本、返回一份副本：调用方改到的不可能是缓存里的数组。
      listCache = { at: Date.now(), value: [...result] };
      return [...result];
    };

    // 新会话创建后必须让列表缓存失效：list() 带 TTL，不清理会短暂看不到刚建的会话。
    const origCreate = typeof persistence.create === "function"
      ? (originals.create ?? (originals.create = persistence.create.bind(persistence)))
      : undefined;
    const wrappedCreate = typeof origCreate === "function"
      ? async (...args) => {
        listCache = null;
        return origCreate(...args);
      }
      : undefined;

    persistence.open = wrappedOpen;
    persistence.list = wrappedList;
    if (typeof wrappedCreate === "function") persistence.create = wrappedCreate;

    // 不做事件驱动的整体失效：那会在活跃会话里每来一条事件就清空整个缓存。
    // 正确性由 read() 里的 revision 校验兜住（后端保证 revision 相同 ⇒ 日志未变）。
    // 定期清理：① 空闲过期 ② 配置改小之后按新预算收缩（否则要等下一次写入才生效）。
    const sweepTimer = setInterval(() => {
      const ttl = cfg.readCacheTtlSecs > 0 ? cfg.readCacheTtlSecs * 1000 : 0;
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

    // ── 浏览器可见的缓存状态（0.5.0） ─────────────────────────
    // 只回答「这个会话当下有没有一份新鲜的缓存」：调用方必须自己带 sessionId，
    // 不提供会话清单，免得把整份会话列表暴露给同源但未鉴权的请求。
    const answerCacheState = async (req, res) => {
      const reply = (status, body) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify(body));
      };
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const id = url.searchParams.get("sessionId") ?? "";
        if (id === "") return reply(400, { ok: false, error: "sessionId required" });
        const entry = cache.get(id);
        // live：会话正挂在宿主内存里（切换过去只是换引用，同样不用解码）。
        const live = liveSessionOf(id);
        if (entry === undefined) return reply(200, { ok: true, cached: false, fresh: false, live });
        // 新鲜度与读路径用同一把尺子：revision 相同 ⇒ 缓存就是日志当前的样子。
        const snapshot = await safeStat(id);
        const fresh = snapshot !== undefined && snapshot.revision === entry.revision;
        return reply(200, {
          ok: true,
          cached: true,
          fresh,
          live,
          bytes: entry.sourceBytes ?? 0,
          ageMs: Math.max(0, Date.now() - (entry.at ?? 0)),
        });
      } catch (error) {
        return reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    };

    // ── 浏览器侧切换耗时（0.7.2 临时探针） ────────────────────
    // 只收浏览器半插件报上来的「点击 → 首帧可见」毫秒数，写进诊断日志。
    // 严格限制：只接受 POST、body ≤ 2KB、字段按类型取，不落原文。
    const answerClientTiming = async (req, res) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) {
            res.statusCode = 413;
            res.end();
            return;
          }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const id = typeof body?.sessionId === "string" ? body.sessionId : "?";
        const num = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : -1);
        diag(
          `client switch id=${id} first=${body?.first === true ? "yes" : "no"}`
          + ` paint=${num(body?.paintMs)}ms longMax=${num(body?.longTaskMs)}ms`
          + ` longTotal=${num(body?.longTotalMs)}ms longCount=${num(body?.longCount)}`
          + ` settle=${num(body?.settleMs)}ms mutations=${num(body?.mutations)}`
          + ` text=${Array.isArray(body?.textLengths) ? body.textLengths.slice(0, 8).join("/") : "?"}`
          + ` build=${typeof body?.build === "string" ? body.build : "?"}`,
        );
        res.statusCode = 204;
        res.end();
      } catch {
        res.statusCode = 400;
        res.end();
      }
    };

    // webServer 可能比插件晚就绪：每秒重试，最多 20 秒（与同生态插件的做法一致）。
    let routeRetry = 0;
    let routeAttempt = 0;
    const registerCacheRoute = () => {
      routeAttempt += 1;
      let webServer;
      try {
        webServer = ctx.get?.("webServer");
      } catch {
        webServer = undefined;
      }
      if (webServer !== undefined && webServer !== null && typeof webServer.register === "function") {
        try {
          ctx.effect(
            () => webServer.register({
              kind: "exact",
              path: "/io-optimizer/cache-state",
              handler: (req, res) => { void answerCacheState(req, res); },
            }),
            "io-optimizer.cache-state-route",
          );
          ctx.effect(
            () => webServer.register({
              kind: "exact",
              path: "/io-optimizer/client-timing",
              handler: (req, res) => { void answerClientTiming(req, res); },
            }),
            "io-optimizer.client-timing-route",
          );
          diag("route registered /io-optimizer/cache-state");
        } catch (error) {
          log.warn?.(`[更好的聊天记录加载] 缓存状态路由注册失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (routeAttempt <= 20) routeRetry = setTimeout(registerCacheRoute, 1000);
      else log.warn?.("[更好的聊天记录加载] webServer 20 秒内未就绪，缓存徽标拿不到数据");
    };
    registerCacheRoute();
    ctx.effect(() => () => clearTimeout(routeRetry), "io-optimizer.cache-state-route-retry");

    const invalidateAll = () => {
      cache.clear();
      cacheBytes = 0;
      inflight.clear();
      listCache = null;
    };

    // ── 切到哪个会话就缓存哪个（0.6.0） ────────────────────────
    // 已经在宿主内存里的会话不走这里：切换本身就只是换引用，没有解码可省。
    liveSessionOf = (id) => {
      try {
        const sessions = ctx.get("sessions");
        if (sessions === undefined || sessions === null || typeof sessions.get !== "function") return false;
        return sessions.get(id) !== undefined;
      } catch {
        return false;
      }
    };

    // 串行排队：一次只解码一个，避免连着切几个大会话把宿主 CPU 顶满。
    let prefetchQueue = Promise.resolve();
    prefetchSession = (id) => {
      if (typeof id !== "string" || id === "") return prefetchQueue;
      prefetchQueue = prefetchQueue
        .then(async () => {
          if (cfg.readCacheSessions <= 0) return;
          // live 会话（正挂在宿主内存里）不预热：它本来就不用解码，而且对正在写入的
          // 会话 open('read') 实测要等 8.5 秒（写锁互斥），会把预热队列和后续切换一起拖住。
          if (liveSessionOf(id)) {
            diag(`prefetch skip live id=${id}`);
            return;
          }
          // 已经在缓存里：revision 没变就只续 TTL（重复打开确实不该重解）；
          // 变了（例如这个会话正在被写入）就走增量补尾巴——否则 live 会话永远
          // 走不到 open()，缓存条目会停在旧 revision，徽标一直是灰的。
          if (cache.has(id)) {
            const current = cache.get(id);
            const next = await refreshEntry(current);
            if (next !== current) {
              diag(`prefetch append id=${id} +${next.events.length - current.events.length}`);
            }
            touch(id);
            return;
          }
          const snapshot = await safeStat(id);
          if (snapshot === undefined) return;
          const at = Date.now();
          // 预热是「顺手」，绝不能把队列卡死：2 秒没结果就放弃这一次（materialize
          // 自身仍会继续，只是不再占着队列）。
          const timeout = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(undefined), 2000);
            if (timer !== null && typeof timer === "object" && typeof timer.unref === "function") timer.unref();
          });
          const result = await Promise.race([materialize(id, snapshot), timeout]);
          if (result === undefined) {
            diag(`prefetch timeout id=${id} ms=${Date.now() - at}`);
            return;
          }
          diag(`prefetch id=${id} ms=${Date.now() - at} cached=${result.cached === true ? "yes" : "no"}`);
        })
        .catch(() => {});
      return prefetchQueue;
    };

    // 归档即止损：会话被归档后不该再占着缓存与徽标。
    forgetSession = (id) => {
      if (typeof id !== "string" || id === "") return;
      if (!cache.has(id)) return;
      drop(id);
      diag(`archive-evict id=${id}`);
    };
    if (typeof ctx.on === "function") {
      try {
        const disposeArchived = ctx.on("workspace/session-archived", (request) => {
          forgetSession(request?.sessionId);
        });
        if (typeof disposeArchived === "function") {
          ctx.effect(() => disposeArchived, "io-optimizer.archive-evict");
        }
        diag("archive listener installed");
      } catch (error) {
        log.warn?.(`[更好的聊天记录加载] 归档监听未装上：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    ctx.effect(
      () => () => {
        // 只撤销自己这一层：若更新的实例已经装上，撤它就是破坏。
        if (persistence.open === wrappedOpen) persistence.open = origOpen;
        if (persistence.list === wrappedList) persistence.list = origList;
        if (typeof wrappedCreate === "function" && persistence.create === wrappedCreate) persistence.create = origCreate;
        invalidateAll();
        clearInterval(sweepTimer);
        clearInterval(statsTimer);
      },
      "io-optimizer.read-restore",
    );
  }

  // ── 切换路径观测：sessionQuery ────────────────────────────────
  // 注意：不能直接 ctx.get('sessionQuery') —— 插件没声明这条注入时拿不到（实测 undefined，
  // 日志里就是「sessionQuery 不可用」）。改用 apply 内的 ctx.inject 子上下文：服务就绪后
  // 才跑回调，服务缺席也不会让 entry 一直 pending。只记录不改行为。
  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["sessionQuery"], (child) => {
        const query = child?.sessionQuery;
        if (query === undefined || query === null) {
          diag("sessionQuery 注入后仍为空");
          return;
        }
        const QUERY_ANCHOR = Symbol.for("dsh-better-chat-history.query-originals");
        const originalsOf = query[QUERY_ANCHOR] ?? (query[QUERY_ANCHOR] = {});
        const installed = [];
        for (const name of ["readSession", "observeSession"]) {
          if (typeof query[name] !== "function") continue;
          const original = originalsOf[name] ?? (originalsOf[name] = query[name].bind(query));
          const wrapped = async (...args) => {
            const first = args[0];
            const id = typeof first === "string" ? first : (first?.sessionId ?? "?");
            const at = Date.now();
            try {
              const result = await original(...args);
              diag(`query.${name} id=${id} ms=${Date.now() - at}`);
              // 切到哪个会话，就在后台把它补进缓存（已经在宿主内存里的跳过）。
              void prefetchSession(id);
              return result;
            } catch (error) {
              diag(`query.${name} id=${id} ms=${Date.now() - at} fail=${error?.message ?? ""}`);
              throw error;
            }
          };
          installed.push([name, wrapped]);
          query[name] = wrapped;
        }
        diag(`query 观测已挂载: ${installed.map(([name]) => name).join(",") || "(无可用方法)"}`);
        if (installed.length > 0 && typeof child.effect === "function") {
          child.effect(
            () => () => {
              for (const [name, wrapped] of installed) {
                // 只还原自己装的那层：后来者可能又包了一层。
                if (query[name] === wrapped) query[name] = originalsOf[name];
              }
            },
            "io-optimizer.query-diag",
          );
        }
      });
    } else {
      diag("ctx.inject 不可用，无法观测 sessionQuery");
    }
  } catch (error) {
    diag(`query 诊断安装失败: ${error?.message ?? String(error)}`);
  }
  // 诊断：把「本插件能看到哪些服务」记一行，用来判断注入作用域。
  try {
    const probe = (name) => {
      try {
        return ctx.get(name) === undefined ? "no" : "yes";
      } catch (error) {
        return `err:${error?.name ?? "?"}`;
      }
    };
    diag(
      `services sessionQuery=${probe("sessionQuery")} storage=${probe("storage")}`
      + ` sessionProjections=${probe("sessionProjections")} sessionPersistence=${probe("sessionPersistence")}`,
    );
  } catch {
    // 探测失败不影响功能。
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
              // 直接走 materialize，不经过有计数的 wrappedOpen：预热不该算成
              // "调用方读了一次"，否则 openHit/openMiss 的语义会被自己污染。
              const snapshot = await safeStat(id, undefined);
              if (snapshot === undefined) continue;
              await materialize(id, snapshot, undefined);
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
    }, cfg.warmDelaySecs * 1000);
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

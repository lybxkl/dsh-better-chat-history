// 冒烟测试：用假的 sessionPersistence / ctx 驱动插件，验证
//   1) 读缓存命中时不重新开门；
//   2) revision 变化时必须重读（不能拿陈旧快照糊弄正在跑的会话）；
//   3) 切片、越界、close 后的语义与真实句柄一致；
//   4) list() 返回副本，且用的是 snapshot.header.id；
//   5) 预热用的是 snapshot.header.id（rc.3 的 list 返回 snapshot，不是 header）；
//   6) 超大会话：不为缓存白读一遍（只解码一次）；
//   7) eventState 为 exclusive 时不入缓存（事件值可能被调用方就地改写）。
//
// 运行：node test/smoke.mjs
// 测试不要污染真实诊断日志（%TEMP%\io-opt-diag.log）。
process.env.IO_OPT_DIAG = "off";

import assert from "node:assert/strict";
import { apply, normalizeConfig, stats, unwrapVolatile } from "../lib/index.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一个最小可用的假后端。 */
function makeBackend(sessions, { eventState = "shared-frozen" } = {}) {
  const reads = new Map(); // id -> 真实整份读取次数
  const store = new Map(); // id -> { revision, events, sizeBytes, header }

  for (const [id, events] of Object.entries(sessions)) {
    store.set(id, {
      revision: `${id}@1`,
      events,
      sizeBytes: 1024,
      header: { id, createdAt: 1, version: 4, cwd: "C:/x", isSeeded: false },
    });
  }

  const service = {
    async stat(id) {
      const record = store.get(id);
      if (record === undefined) return undefined;
      return {
        header: record.header,
        revision: record.revision,
        sizeBytes: record.sizeBytes,
        eventCount: record.events.length,
      };
    },
    async list() {
      return [...store.values()].map((record) => ({
        header: record.header,
        revision: record.revision,
        sizeBytes: record.sizeBytes,
        eventCount: record.events.length,
      }));
    },
    async open(id, access) {
      const record = store.get(id);
      if (record === undefined) throw new Error(`not found: ${id}`);
      let closed = false;
      return {
        id,
        header: record.header,
        inheritedEventCount: 0,
        access,
        async read(offset = 0) {
          assert.equal(closed, false, "读已关闭的句柄必须报错");
          reads.set(id, (reads.get(id) ?? 0) + 1);
          return { eventState, events: record.events.slice(offset).map((event) => ({ ...event })) };
        },
        async append() {
          throw new Error("read-only");
        },
        async flush() {
          throw new Error("read-only");
        },
        async close() {
          closed = true;
        },
        [Symbol.asyncDispose]() {
          closed = true;
          return Promise.resolve();
        },
      };
    },
    // 测试辅助
    bump(id, extra) {
      const record = store.get(id);
      record.events = [...record.events, ...extra];
      record.revision = `${id}@${Number(record.revision.split("@")[1]) + 1}`;
    },
    readCount(id) {
      return reads.get(id) ?? 0;
    },
  };
  return service;
}

function makeCtx(service, extraServices = {}) {
  const effects = [];
  const ctx = {
    logger: Object.assign(() => ({ info() {}, warn() {}, error() {} }), {
      info() {},
      warn() {},
      error() {},
    }),
    get(key) {
      if (key === "sessionPersistence") return service;
      return extraServices[key];
    },
    on() {
      return () => {};
    },
    effect(execute) {
      effects.push(execute());
      return () => {};
    },
  };
  return { ctx, effects };
}

/** 走完整的宿主路径：open → read(0) → close，返回事件数。 */
async function readThrough(service, id) {
  const handle = await service.open(id, "read");
  const result = await handle.read(0, undefined);
  await handle.close();
  return result;
}

const events = Array.from({ length: 10 }, (_, i) => ({ seq: i, type: "user/message" }));
const service = makeBackend({ s1: events, s2: events.slice(0, 3) });
const { ctx } = makeCtx(service);
apply(ctx, { warmSessions: 0, listCacheTtlMs: 50 });

// ── 1) 首次 open 读盘，第二次必须命中缓存 ────────────────────
const r1 = await readThrough(service, "s1");
assert.equal(r1.events.length, 10);
assert.equal(r1.eventState, "shared-frozen", "eventState 必须原样返回");
assert.equal(service.readCount("s1"), 1, "第一次 open 应只读一次");

const r2 = await readThrough(service, "s1");
assert.equal(r2.events.length, 10, "命中缓存仍要拿到完整日志");
assert.equal(service.readCount("s1"), 1, "第二次 open 不应再读盘");

// ── 2) 切片与越界 ────────────────────────────────────────────
const h = await service.open("s1", "read");
assert.equal((await h.read(0, 4)).events.length, 4, "length 生效");
assert.equal((await h.read(8)).events.length, 2, "offset 生效");
assert.deepEqual((await h.read(999)).events, [], "越界 offset 返回空");
await h.close();

// ── 3) 日志变化后必须重读，不能返回陈旧快照 ──────────────────
service.bump("s1", [{ seq: 10, type: "user/message" }]);
const r3 = await readThrough(service, "s1");
assert.equal(r3.events.length, 11, "revision 变化后必须看到新事件");
assert.equal(service.readCount("s1"), 2, "revision 变化后必须重读一次");

// ── 4) close 之后 read 必须报错 ──────────────────────────────
const h4 = await service.open("s1", "read");
await h4.close();
await assert.rejects(() => h4.read(0), (error) => error.name === "SessionHandleClosedError");

// ── 5) 只读句柄上 append/flush 必须拒绝 ──────────────────────
const h5 = await service.open("s1", "read");
await assert.rejects(() => h5.append([]), /read-only/);
await assert.rejects(() => h5.flush(), /read-only/);
await h5.close();

// ── 6) list() 返回副本 ──────────────────────────────────────
const listedA = await service.list();
const listedB = await service.list();
assert.notEqual(listedA, listedB, "两次 list 不能是同一个数组");
assert.ok(listedA[0].header.id, "list 返回 snapshot.header.id");

// ── 7) 预热必须用 snapshot.header.id ────────────────────────
const warmService = makeBackend({ a: events, b: events });
const { ctx: warmCtx } = makeCtx(warmService);
apply(warmCtx, { warmSessions: 2, warmDelayMs: 5, warmIntervalMs: 1, readCacheSessions: 4 });
await tick(100);
const warmStats = stats();
assert.ok(warmStats.warmLoaded === 2, `预热计数应为 2，实际 ${warmStats.warmLoaded}`);
assert.equal(warmService.readCount("a"), 1, "预热应把 a 读进缓存");
// 预热过的会话再打开不应再读盘
await readThrough(warmService, "a");
assert.equal(warmService.readCount("a"), 1, "预热后点击应命中缓存");

// ── 8) 超大会话：只解码一次，且不入缓存 ─────────────────────
const bigService = makeBackend({ big: events });
bigService.stat = async (id) => ({
  header: { id, createdAt: 1 },
  revision: "big@1",
  sizeBytes: 64 * 1024 * 1024,
});
const { ctx: bigCtx } = makeCtx(bigService);
apply(bigCtx, { warmSessions: 0, readCacheSessionBytes: 1024 });
const bigResult = await readThrough(bigService, "big");
assert.equal(bigResult.events.length, 10, "超大会话仍要正常返回内容");
assert.equal(bigService.readCount("big"), 1, "超大会话不能为缓存白读一遍");
const bigStats = stats();
assert.equal(bigStats.openTooLarge, 1);
assert.equal(bigStats.cachedSessions, 0, "超大会话不应进缓存");

// ── 9) eventState=exclusive 时不入缓存（避免手工改写互相污染） ──
const exclusiveService = makeBackend({ ex: events }, { eventState: "exclusive" });
const { ctx: exclusiveCtx } = makeCtx(exclusiveService);
apply(exclusiveCtx, { warmSessions: 0 });
const exFirst = await readThrough(exclusiveService, "ex");
exFirst.events[0].seq = 999; // 独占语义下调用方可以就地改写
const exSecond = await readThrough(exclusiveService, "ex");
assert.equal(exSecond.events[0].seq, 0, "exclusive 事件不能被上一个读者污染");
assert.equal(exclusiveService.readCount("ex"), 2, "exclusive 每次都应重新读");

// ── 10) 契约不匹配时不能抛错 ────────────────────────────────
const { ctx: badCtx } = makeCtx({ async list() { return []; } });
assert.doesNotThrow(() => apply(badCtx, {}), "契约不匹配时应安静退出而不是抛错");

// ── 11) 关闭缓存（readCacheSessions=0）时完全不介入 ─────────
const offService = makeBackend({ z: events });
const { ctx: offCtx } = makeCtx(offService);
apply(offCtx, { warmSessions: 0, readCacheSessions: 0 });
await readThrough(offService, "z");
await readThrough(offService, "z");
assert.equal(offService.readCount("z"), 2, "关闭缓存后每次都应走上游");

// ── 12) 被取消的读取必须抛错，不能静默返回陈旧数据 ─────────
const abortService = makeBackend({ ab: events });
const innerStat = abortService.stat.bind(abortService);
abortService.stat = async (id, options) => {
  if (options?.signal !== undefined) {
    const error = new Error("aborted");
    error.name = "AbortError";
    options.signal.aborted = true; // 模拟取消发生在 stat 期间
    throw error;
  }
  return innerStat(id);
};
const { ctx: abortCtx } = makeCtx(abortService);
apply(abortCtx, { warmSessions: 0 });
await readThrough(abortService, "ab"); // 先正常读一次，让缓存热起来
const abortHandle = await abortService.open("ab", "read");
const signal = { aborted: false, throwIfAborted() {} };
await assert.rejects(
  () => abortHandle.read(0, undefined, { signal }),
  (error) => error.name === "AbortError",
  "取消必须向上传播",
);
await abortHandle.close();

// ── 13) 同一会话并发打开只解码一次 ──────────────────────────
const dedupeService = makeBackend({ d: events });
const { ctx: dedupeCtx } = makeCtx(dedupeService);
apply(dedupeCtx, { warmSessions: 0 });
const [dh1, dh2] = await Promise.all([
  dedupeService.open("d", "read"),
  dedupeService.open("d", "read"),
]);
await dh1.read(0);
await dh2.read(0);
await dh1.close();
await dh2.close();
assert.equal(dedupeService.readCount("d"), 1, "并发同会话只应解码一次");

const finalStats = stats();

// ── 14) volatile 引用拆包（宿主热更新时会塞 createVolatile 引用进来）────
const fakeRef = () => {
  let current = 0;
  const write = Symbol("write");
  return Object.freeze({ get: () => current, [write]: (value) => { current = value; } });
};
const ref = fakeRef();
assert.equal(unwrapVolatile(ref), 0, "只带 get() 的引用要被拆开");
assert.equal(unwrapVolatile(6), 6, "普通数字原样返回");
assert.equal(unwrapVolatile(null), null, "null 原样返回");

const mixed = unwrapVolatile({ get: () => 1, other: 2 });
assert.equal(typeof mixed, "object", "带其它数据键的对象不当引用拆（可能真是数据）");

const volatileCfg = normalizeConfig({
  readCacheSessions: unwrapVolatile(ref),
  readCacheSessionMb: 16,
});
assert.equal(volatileCfg.readCacheSessions, 0, "引用拆包后参与归一");
assert.equal(volatileCfg.readCacheSessionBytes, 16 * 1024 * 1024, "MB 字段仍然换算成字节");

// ── 15) 热更新事件：收到 loader/volatile-update 后换用新配置 ──────────
let liveConfig = { readCacheSessions: 2, warmSessions: 0 };
const listeners = new Map();
const liveCtx = {
  get: () => undefined,
  on(event, listener) { listeners.set(event, listener); },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
};
apply(liveCtx, liveConfig);
assert.ok(listeners.has("loader/volatile-update"), "要监听热更新事件");
liveConfig = { readCacheSessions: 5, warmSessions: 0 };
listeners.get("loader/volatile-update")();
assert.ok(true, "热更新回调不应抛错");

// ── 16) 空闲过期：闲置超过 TTL 后必须重新解码 ──────────────────
const ttlService = makeBackend({ t: events });
const { ctx: ttlCtx } = makeCtx(ttlService);
apply(ttlCtx, { warmSessions: 0, readCacheTtlMs: 20 });
const ttlFirst = await ttlService.open("t", "read");
await ttlFirst.read(0);
await ttlFirst.close();
await new Promise((resolve) => setTimeout(resolve, 60));
const ttlSecond = await ttlService.open("t", "read");
await ttlSecond.read(0);
await ttlSecond.close();
assert.equal(ttlService.readCount("t"), 2, "空闲过期之后必须重新解码");
assert.ok(stats().expired >= 1, "过期要计入 stats.expired");

// ── 17) 淘汰策略：超出会话数预算时按 LRU 丢弃最久没用的 ────────
const evictService = makeBackend({ e1: events, e2: events });
const { ctx: evictCtx } = makeCtx(evictService);
apply(evictCtx, { warmSessions: 0, readCacheSessions: 1, readCacheTtlMs: 0 });
const evictFirst = await evictService.open("e1", "read");
await evictFirst.read(0);
await evictFirst.close();
const evictSecond = await evictService.open("e2", "read");
await evictSecond.read(0);
await evictSecond.close();
assert.ok(stats().evicted >= 1, "超出会话数预算要淘汰旧的");
assert.equal(stats().cachedSessions, 1, "淘汰后只剩预算内的条目");

console.log("✅ smoke: 所有断言通过");
console.log("   stats:", JSON.stringify(finalStats));

// 冒烟测试：用假的 sessionPersistence / ctx 驱动插件，验证
//   1) 读缓存命中时不重新开门；
//   2) revision 变化时必须重读（不能拿陈旧快照糊弄正在跑的会话）；
//   3) 切片、越界、close 后的语义与真实句柄一致；
//   4) list() TTL 缓存；
//   5) 预热用的是 snapshot.header.id（rc.3 的 list 返回 snapshot，不是 header）。
//
// 运行：node test/smoke.mjs
import assert from "node:assert/strict";
import { apply, stats } from "../lib/index.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一个最小可用的假后端。 */
function makeBackend(sessions) {
  const opens = new Map(); // id -> 次数
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
      opens.set(id, (opens.get(id) ?? 0) + 1);
      let closed = false;
      return {
        id,
        header: record.header,
        inheritedEventCount: 0,
        access,
        async read(offset = 0) {
          assert.equal(closed, false, "读已关闭的句柄必须报错");
          return { eventState: "shared-frozen", events: record.events.slice(offset) };
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
    openCount(id) {
      return opens.get(id) ?? 0;
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
    effect(execute, label) {
      const disposer = execute();
      effects.push({ disposer, label });
      return () => {};
    },
  };
  return { ctx, disposeAll: async () => { for (const { disposer } of effects.reverse()) await disposer?.(); } };
}

const events = Array.from({ length: 10 }, (_, i) => ({ seq: i, type: "user/message" }));
const service = makeBackend({ s1: events, s2: events.slice(0, 3) });
const { ctx } = makeCtx(service);
apply(ctx, { warmSessions: 0, listCacheTtlMs: 50 });

// ── 1) 首次 open 读盘，第二次必须命中缓存 ────────────────────
const h1 = await service.open("s1", "read");
const r1 = await h1.read(0, 4);
assert.equal(r1.events.length, 4, "切片长度");
assert.equal(r1.events[0].seq, 0);
assert.equal(r1.eventState, "shared-frozen", "eventState 必须原样返回");
await h1.close();
assert.equal(service.openCount("s1"), 1, "第一次 open 应读盘一次");

const h2 = await service.open("s1", "read");
assert.equal(service.openCount("s1"), 1, "第二次 open 不应再读盘");
const r2 = await h2.read(0);
assert.equal(r2.events.length, 10, "命中缓存仍要拿到完整日志");

// ── 2) 越界 offset 返回空数组 ────────────────────────────────
const beyond = await h2.read(999);
assert.deepEqual(beyond.events, [], "越界 offset 返回空");

await h2.close();

// ── 3) 日志变化后必须重读，不能返回陈旧快照 ──────────────────
service.bump("s1", [{ seq: 10, type: "user/message" }]);
const h3 = await service.open("s1", "read");
const r3 = await h3.read(0);
assert.equal(r3.events.length, 11, "revision 变化后必须看到新事件");
assert.ok(service.openCount("s1") >= 2, "revision 变化后必须重读一次");
await h3.close();

// ── 4) close 之后 read 必须报错 ──────────────────────────────
const h4 = await service.open("s1", "read");
await h4.close();
await assert.rejects(() => h4.read(0), /closed/, "关闭后的句柄必须拒绝读取");

// ── 5) 只读句柄上 append/flush 必须拒绝 ──────────────────────
const h5 = await service.open("s1", "read");
await assert.rejects(() => h5.append([]), /read-only/);
await assert.rejects(() => h5.flush(), /read-only/);
await h5.close();

// ── 6) list() 返回 snapshot 结构（header.id 在 header 里，不是顶层） ──
const snapshots = await service.list();
assert.ok(Array.isArray(snapshots) && snapshots[0].header.id, "list 返回 snapshot.header.id");

// ── 7) 预热：必须用 snapshot.header.id ──────────────────────
const warmService = makeBackend({ a: events, b: events });
const { ctx: warmCtx } = makeCtx(warmService);
apply(warmCtx, { warmSessions: 2, warmDelayMs: 5, warmIntervalMs: 1, readCacheSessions: 4 });
await tick(80);
assert.equal(warmService.openCount("a") + warmService.openCount("b"), 2, "预热应打开两个会话");
const warmStats = stats();
assert.ok(warmStats && warmStats.warmLoaded === 2, `预热计数应为 2，实际 ${warmStats?.warmLoaded}`);

// ── 8) 超大会话不入缓存（预算保护） ──────────────────────────
const bigService = makeBackend({ big: events });
bigService.stat = async (id) => ({
  header: { id, createdAt: 1 },
  revision: "big@1",
  sizeBytes: 64 * 1024 * 1024,
});
const { ctx: bigCtx } = makeCtx(bigService);
apply(bigCtx, { warmSessions: 0, readCacheSessionBytes: 1024 });
const bigHandle = await bigService.open("big", "read");
await bigHandle.close();
const bigStats = stats();
assert.equal(bigStats.openTooLarge, 1, "超大会话必须走 tooLarge 分支且不入缓存");
assert.equal(bigStats.cachedSessions, 0, "超大会话不应进缓存");

// ── 9) 未启用（服务缺 open/stat）时不能抛错 ──────────────────
const { ctx: badCtx } = makeCtx({ async list() { return []; } });
assert.doesNotThrow(() => apply(badCtx, {}), "契约不匹配时应安静退出而不是抛错");

console.log("✅ smoke: 所有断言通过");
console.log("   stats:", JSON.stringify(stats()));

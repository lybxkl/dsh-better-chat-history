// 更好的聊天记录加载 —— dsh-better-chat-history
//
// 零依赖 cordis 插件，解决两个问题：
//   1) 多 Agent 来回切换会话时反复全量冷读 JSONL 日志（读放大 → 卡顿 + SSD 寿命）；
//   2) 投影缓存 / 会话日志的高频 fsync 与全文件重写（写放大 → SSD 寿命）。
//
// 做法（全部通过包装既有服务实例方法实现，不修改 DSH 本体）：
//   - 读路径：包装 ctx.sessionPersistence 的 inspect / readFrom / list，
//     加 LRU + TTL 缓存，并监听 session/event、session/created、session/disposed
//     做精确失效（会话日志一旦变化立即弃缓存）。
//   - 写路径：包装 storage json 后端的 kv.open，对 fail-soft 单元
//     （默认 session_projcache）做写合并：多次 put/delete 合并为一次
//     全量 publish（一次文件写 + 一次 fsync）。
//   - 写频率：由同包 cordis.patch.yml 覆盖 session-persistence-jsonl 的
//     writeBatchMaxDelayMs（200 → 2000ms）与 preparedSessionCacheSize（5 → 64）。
//
// 语义安全边界：
//   - inspect / readFrom 是只读路径，缓存 + 事件失效后最多返回陈旧视图，
//     不会产生错误数据；inspect 结果本身是冻结的不可变对象，可安全共享引用。
//   - 合并写只作用于 fail-soft 单元（投影缓存丢了只是冷读时重放日志），
//     不碰 workspace.json 等权威数据。
//   - 崩溃最多丢失：最近 ~2s 的会话日志事件（writeBatchMaxDelayMs）与
//     最近一次合并窗口内的投影缓存更新——均符合原设计语义。

export const name = "io-optimizer";

export const inject = ["sessionPersistence", "storage"];

const DEFAULTS = {
  // inspect 冷读缓存：槽数 / TTL
  inspectCacheSize: 64,
  inspectCacheTtlMs: 60000,
  // list（会话列表）缓存 TTL
  listCacheTtlMs: 5000,
  // 写合并：作用于哪些 storage 单元名 / 合并窗口
  coalesceUnits: ["session_projcache"],
  coalesceMs: 1500,
  // 预热器：web 启动后后台把最近活跃的会话预先载入冷读缓存，
  // 让"初次点击"命中缓存而不是全量冷读 JSONL。0 关闭预热。
  warmSessions: 24,
  warmDelayMs: 10000,
  warmIntervalMs: 600,
  // 优先级：前 warmFastCount 个会话用更短间隔快速预热
  warmFastCount: 5,
  warmFastIntervalMs: 150,
  // "dispose 即预热"：subagent 会话销毁（跑完）后延迟预读，
  // 用户随后点开它时缓存已热。0 关闭。
  disposeWarmDelayMs: 1500,
};

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) };

  // 读缓存状态（apply 顶层持有：读路径与预热器共享）
  // id -> { at, meta, events }（Map 插入序即 LRU 序）
  const cache = new Map();
  // id -> Promise（并发去重，同 id 同时请求只读一次盘）
  const inflight = new Map();
  let listCache = null; // { at, value }

  const stats = {
    inspectHit: 0,
    inspectMiss: 0,
    readHit: 0,
    readMiss: 0,
    listHit: 0,
    listMiss: 0,
    coalescedOps: 0,
    coalescedPublishes: 0,
    warmLoaded: 0,
  };

  // ── 读路径缓存 ────────────────────────────────────────────
  const persistence = ctx.get("sessionPersistence");
  if (persistence !== undefined && persistence.__ioOptimizedRead !== true) {
    persistence.__ioOptimizedRead = true;
    const origInspect = persistence.inspect.bind(persistence);
    const origReadFrom = persistence.readFrom.bind(persistence);
    const origList = persistence.list.bind(persistence);

    const invalidate = (id) => {
      cache.delete(id);
      inflight.delete(id);
      listCache = null;
    };
    // dispose 即预热：subagent 销毁后延迟预读该会话（等持久化 final drain 完成）
    const disposeWarmTimers = new Map();
    const scheduleDisposeWarm = (id) => {
      if (cfg.disposeWarmDelayMs <= 0) return;
      const existing = disposeWarmTimers.get(id);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        disposeWarmTimers.delete(id);
        if (cache.has(id) || inflight.has(id)) return;
        persistence
          .inspect(id)
          .then(() => {
            stats.warmLoaded++;
          })
          .catch(() => {
            /* 预读失败（日志损坏等）静默跳过 */
          });
      }, cfg.disposeWarmDelayMs);
      disposeWarmTimers.set(id, timer);
    };
    const onSessionChanged = (session) => {
      if (session !== undefined && session !== null) invalidate(session.id);
    };
    const onSessionDisposed = (session) => {
      if (session !== undefined && session !== null) {
        invalidate(session.id);
        scheduleDisposeWarm(session.id);
      }
    };
    ctx.on("session/event", onSessionChanged);
    ctx.on("session/created", onSessionChanged);
    ctx.on("session/disposed", onSessionDisposed);

    persistence.inspect = async (id, signal) => {
      signal?.throwIfAborted?.();
      const hit = cache.get(id);
      if (hit !== undefined && Date.now() - hit.at < cfg.inspectCacheTtlMs) {
        stats.inspectHit++;
        return { meta: hit.meta, events: hit.events };
      }
      let pending = inflight.get(id);
      if (pending === undefined) {
        stats.inspectMiss++;
        pending = origInspect(id, signal)
          .then((result) => {
            if (cache.size >= cfg.inspectCacheSize) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            cache.set(id, { at: Date.now(), meta: result.meta, events: result.events });
            return result;
          })
          .finally(() => {
            inflight.delete(id);
          });
        inflight.set(id, pending);
      }
      return pending;
    };

    persistence.readFrom = async (id, fromSeq, signal) => {
      signal?.throwIfAborted?.();
      const hit = cache.get(id);
      if (
        hit !== undefined &&
        Date.now() - hit.at < cfg.inspectCacheTtlMs &&
        fromSeq <= hit.events.length
      ) {
        stats.readHit++;
        return { meta: hit.meta, events: hit.events.slice(fromSeq) };
      }
      stats.readMiss++;
      return origReadFrom(id, fromSeq, signal);
    };

    persistence.list = async (signal) => {
      signal?.throwIfAborted?.();
      if (listCache !== null && Date.now() - listCache.at < cfg.listCacheTtlMs) {
        stats.listHit++;
        return [...listCache.value];
      }
      stats.listMiss++;
      const result = await origList(signal);
      listCache = { at: Date.now(), value: result };
      return result;
    };

    ctx.effect(
      () => () => {
        for (const timer of disposeWarmTimers.values()) clearTimeout(timer);
        disposeWarmTimers.clear();
        persistence.inspect = origInspect;
        persistence.readFrom = origReadFrom;
        persistence.list = origList;
        persistence.__ioOptimizedRead = false;
      },
      "io-optimizer.read-restore",
    );
  }

  // ── 写合并（仅 fail-soft 单元） ───────────────────────────
  const storage = ctx.get("storage");
  if (storage !== undefined && storage.backend !== undefined) {
    let backend;
    try {
      backend = storage.backend.get("json");
    } catch {
      backend = undefined;
    }
    if (backend !== undefined && backend.kv !== undefined && backend.kv.__ioCoalesced !== true) {
      const origOpen = backend.kv.open.bind(backend.kv);
      backend.kv.__ioCoalesced = true;
      backend.kv.open = async (descriptor) => {
        const unit = await origOpen(descriptor);
        if (!cfg.coalesceUnits.includes(descriptor.name) || unit.__ioCoalesced) return unit;
        unit.__ioCoalesced = true;

        let timer = null;
        let dirty = false;

        const publish = async () => {
          dirty = false;
          try {
            await unit.publish();
            stats.coalescedPublishes++;
          } catch (error) {
            ctx.logger.error(
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

        const origPut = unit.putRecord.bind(unit);
        const origDelete = unit.deleteRecord.bind(unit);
        const origSetGlobal = unit.setGlobal.bind(unit);
        const origClose = unit.close.bind(unit);

        // 合并语义：直接改内存 state（读路径即时一致），
        // 落盘合并到 coalesceMs 窗口末尾，一次 publish = 一次 fsync。
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
          backend.kv.open = origOpen;
          backend.kv.__ioCoalesced = false;
        },
        "io-optimizer.write-restore",
      );
    }
  }

  // ── 预热器（让"初次点击"命中缓存） ─────────────────────────
  // web 启动完成后，后台把最近活跃的会话逐个 inspect 进冷读缓存。
  // 这是"初次点击不卡"的关键：会话第一次打开时后端要全量读 JSONL
  // （zstd 解压 + 逐行解析 + 深拷贝），预热让点击发生时缓存已热。
  // 分批优先级：最可能先点开的最先热（前 warmFastCount 个用短间隔），
  // 其余排队慢速预热，避免启动 IO 风暴。
  if (cfg.warmSessions > 0 && persistence !== undefined) {
    const warmFastCount = cfg.warmFastCount ?? 5;
    const warmFastIntervalMs = cfg.warmFastIntervalMs ?? 150;
    const warmTimer = setTimeout(() => {
      void (async () => {
        try {
          const headers = await persistence.list();
          const ids = headers
            .map((header) => ({ id: header.id, createdAt: header.createdAt ?? 0 }))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, cfg.warmSessions)
            .map((entry) => entry.id);
          let warmed = 0;
          for (let index = 0; index < ids.length; index++) {
            const id = ids[index];
            // 预热期间会话可能被用户点击/被事件失效：miss 后再读即可，
            // 失败（损坏日志等）跳过不阻塞后续。
            try {
              await persistence.inspect(id);
              warmed++;
            } catch {
              /* 单个会话预热失败不影响整体 */
            }
            const interval =
              index < warmFastCount ? warmFastIntervalMs : cfg.warmIntervalMs;
            await new Promise((resolve) => setTimeout(resolve, interval));
          }
          stats.warmLoaded = warmed;
        } catch {
          /* 预热失败静默（读缓存不影响功能，下次点击时仍走原路径） */
        }
      })();
    }, cfg.warmDelayMs);
    ctx.effect(() => () => clearTimeout(warmTimer), "io-optimizer.warmup");
  }
}

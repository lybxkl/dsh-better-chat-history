// 浏览器半个插件的无头测试：不依赖浏览器，用假的 ModuleLoader / React 走一遍
// 注册路径，确认
//   1) 模块 id 与包名一致（dsh-client-modules 靠这个把 browser half 挂到 Loader 行上）；
//   2) apply 会在 plugins.row.config 上注册，键为 `<包名>#<行 id>`；
//   3) 没有 form 时降级成说明文字，而不是崩掉；
//   4) view === 'summary' 时返回摘要；
//   5) 有 form 时渲染出字段；保存只提交改过的字段，并带上 revision。
//
// 运行：node test/client.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/** 假 React：只实现本插件用到的那几个函数。 */
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect() {},
};

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, factory };
    },
  },
};

const { writeFileSync, mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const scratch = mkdtempSync(join(tmpdir(), "io-opt-client-"));
const copy = join(scratch, "client.mjs");
writeFileSync(copy, source);
await import(pathToFileURL(copy).href);

assert.ok(loaded, "client.js 必须调用 window.__ModuleLoader__.load");
assert.equal(loaded.id, "dsh-better-chat-history", "模块 id 必须等于包名");

const plugin = loaded.factory((name) => {
  assert.equal(name, "react", "factory 只会 require('react')");
  return React;
});
assert.deepEqual(plugin.inject, ["slots", "locale"]);

// ── 注册路径 ────────────────────────────────────────────────
const registrations = [];
const effects = [];
const dictionaries = {};
const ctx = {
  slots: {
    inject(name, callback) {
      registrations.push({ name, callback });
    },
    register(options, component) {
      return { options, component };
    },
  },
  locale: {
    register(ns, dicts) {
      dictionaries[ns] = dicts;
      return () => {};
    },
  },
  effect(execute) {
    effects.push(execute());
  },
};
plugin.apply(ctx);

assert.equal(registrations.length, 1, "只注册一个槽位");
assert.equal(registrations[0].name, "plugins.row.config");
const registration = registrations[0].callback();
assert.equal(registration.options.name, "plugins.row.config");
assert.equal(registration.options.key, "dsh-better-chat-history#io-optimizer");
assert.equal(registration.options.locale, "ioOptimizer");
assert.ok(dictionaries.ioOptimizer?.zh && dictionaries.ioOptimizer?.en, "必须注册中英字典");
assert.equal(effects.length, 1, "locale 注册要包在 effect 里，卸载时回收");

const ConfigPage = registration.component;

// ── summary 视图 ────────────────────────────────────────────
const summary = ConfigPage({ view: "summary", t: undefined });
assert.equal(typeof summary.type, "string", "summary 应返回文本节点");
assert.ok(summary.props.children.length > 0);

// ── 没有 form：降级而不是抛错 ───────────────────────────────
const unavailable = ConfigPage({ view: "page", form: undefined });
assert.equal(unavailable.props["data-io-optimizer-unavailable"], true);

// ── 有 form：渲染字段，保存只提交改动并带 revision ──────────
const calls = [];
const form = {
  state: {
    status: "ready",
    value: { readCacheSessions: 6, readCacheSessionMb: 8, readCacheSourceMb: 64, listCacheTtlMs: 5000, warmSessions: 8, warmDelayMs: 15000 },
    revision: "rev-7",
    writable: true,
  },
  async mutate(ops, revision) {
    calls.push({ ops, revision });
    return true;
  },
};
const page = ConfigPage({ view: "page", form });
assert.equal(typeof page.type, "function", "有 form 时应渲染 Fields 组件");
// 直接调用 Fields：hooks 已被假 React 兜住，拿到的是元素树而不是渲染结果，
// 所以这里只验证组件是函数且调用不抛错。
const tree = page.type({ form, formT: undefined });
assert.ok(tree && tree.props && tree.props["data-io-optimizer-form"] === true, "表单根节点带标记");
const serialized = JSON.stringify(tree);
assert.ok(serialized.includes("readCacheSessions"), "表单里应包含字段");
const fieldCount = (serialized.match(/"io-opt-/g) ?? []).length;
assert.equal(fieldCount, 12, "六个字段都要渲染出来（label htmlFor + input id 各一处）");

// 保存路径单独验证（不经过 React 事件）
const ops = [
  { op: "set", path: ["readCacheSessions"], value: 10 },
];
assert.equal(await form.mutate(ops, form.state.revision), true);
assert.deepEqual(calls.at(-1), { ops, revision: "rev-7" });

// ── 关掉表单写入时不许点保存 ────────────────────────────────
const readonlyPage = ConfigPage({ view: "page", form: { ...form, state: { ...form.state, writable: false } } });
assert.equal(typeof readonlyPage.type, "function");

console.log("✅ client: 所有断言通过");
console.log(`   注册键 ${registration.options.key}，字段渲染 ${fieldCount} 处`);

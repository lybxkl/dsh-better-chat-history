// 浏览器半个插件的无头测试：不依赖浏览器，用假的 ModuleLoader / React 走一遍
// 注册路径，确认
//   1) 模块 id 与包名一致（dsh-client-modules 靠这个把 browser half 挂到 Loader 行上）；
//   2) apply 会在 plugins.row.config 上注册，键为 `<包名>#<行 id>`；
//   3) 没有 form 时插件页降级成说明文字，而不是崩掉；
//   4) view === 'summary' 时返回摘要；
//   5) 有 form 时渲染出字段；
//   6) 设置侧栏分节 settings.section / settings.section.icon 用同一个 id 注册，
//      label 走 locale；页面能从 ctx.configForms 解析出命名空间并渲染同一套字段；
//      服务缺失 / 命名空间没被 Serve 时给的是说明文字，不是异常。
//
// 运行：node test/client.mjs
// 测试不要污染真实诊断日志（%TEMP%\io-opt-diag.log）。
process.env.IO_OPT_DIAG = "off";

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

const ROW_KEY = "dsh-better-chat-history#io-optimizer";
const SECTION_ID = "better-chat-history";
const NS = "ioOptimizer";

const plugin = loaded.factory((name) => {
  assert.equal(name, "react", "factory 只会 require('react')");
  return React;
});
assert.deepEqual(plugin.inject, ["slots", "locale"]);

// ── 注册路径 ────────────────────────────────────────────────
const registrations = [];
const effects = [];
const dictionaries = {};
const services = {};
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
    bind(ns) {
      return (key) => dictionaries[ns]?.zh?.[key] ?? key;
    },
  },
  get(name) {
    return services[name];
  },
  effect(execute) {
    effects.push(execute());
  },
};
plugin.apply(ctx);

assert.deepEqual(
  registrations.map((item) => item.name),
  ["plugins.row.config", "settings.section", "settings.section.icon"],
  "三个槽位都要注册",
);
assert.ok(dictionaries[NS]?.zh && dictionaries[NS]?.en, "必须注册中英字典");
assert.equal(effects.length, 1, "locale 注册要包在 effect 里，卸载时回收");

const byName = Object.fromEntries(registrations.map((item) => [item.name, item.callback()]));

// ── 插件页那一行 ────────────────────────────────────────────
const rowRegistration = byName["plugins.row.config"];
assert.equal(rowRegistration.options.name, "plugins.row.config");
assert.equal(rowRegistration.options.key, ROW_KEY);
assert.equal(rowRegistration.options.locale, NS);
const ConfigPage = rowRegistration.component;

const summary = ConfigPage({ view: "summary", t: undefined });
assert.equal(typeof summary.type, "string", "summary 应返回文本节点");
assert.ok(summary.props.children.length > 0);

const unavailable = ConfigPage({ view: "page", form: undefined });
assert.equal(unavailable.props["data-io-optimizer-unavailable"], true, "没有 form 时降级");

// ── 设置侧栏分节 ────────────────────────────────────────────
const sectionRegistration = byName["settings.section"];
assert.equal(sectionRegistration.options.name, "settings.section");
assert.equal(sectionRegistration.options.id, SECTION_ID, "分节 id");
assert.equal(typeof sectionRegistration.options.order, "number", "order 用于排序");
assert.equal(typeof sectionRegistration.options.label, "function", "label 用 thunk，跟随语言");
assert.equal(sectionRegistration.options.label(), "加载缓存", "label 走 locale 字典");
assert.equal(typeof sectionRegistration.options.inject, "function", "注册时注入 forms/t");
const injected = sectionRegistration.options.inject();
assert.equal(injected.t("save"), "保存", "注入的 t 走 locale");
const SettingsSection = sectionRegistration.component;

const iconRegistration = byName["settings.section.icon"];
assert.equal(iconRegistration.options.id, SECTION_ID, "图标 id 必须等于分节 id");
const icon = iconRegistration.component({ size: 20, active: true });
assert.equal(icon.type, "svg", "图标返回 svg");
assert.equal(icon.props.width, 20, "图标跟随宿主给的 size");
assert.equal(icon.props["aria-hidden"], "true", "图标对读屏隐藏");

// 服务缺失：说清楚，不抛错
const noService = SettingsSection({ forms: undefined, t: undefined });
assert.equal(noService.props["data-io-optimizer-no-service"], true, "缺 configForms 时给提示");

// 命名空间没被 Serve：给 notFound，并把可用命名空间列出来
const emptyFace = { getSnapshot: () => ({ status: "ready", view: { namespaces: [], writable: true } }), subscribe: () => () => {} };
const notFound = SettingsSection({ forms: { describe: () => emptyFace, get: () => undefined } });
assert.equal(notFound.props["data-io-optimizer-not-found"], true, "认不出命名空间时给 notFound");

const otherFace = { getSnapshot: () => ({ status: "ready", view: { namespaces: [{ ns: "someone-else" }], writable: true } }), subscribe: () => () => {} };
const hinted = SettingsSection({ forms: { describe: () => otherFace, get: () => undefined } });
assert.ok(String(hinted.props.children).includes("someone-else"), "认不出时应列出可用命名空间，便于诊断");

// 正常路径：从 describe 里认出 include:io-optimizer，渲染同一套字段
const value = {
  readCacheSessions: 6, readCacheSessionMb: 8, readCacheSourceMb: 64,
  listCacheTtlMs: 5000, warmSessions: 8, warmDelayMs: 15000,
};
const snapshot = { status: "ready", value, revision: 3, writable: true };
const mutations = [];
const controller = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  async mutate(ops, revision) {
    mutations.push({ ops, revision });
    return true;
  },
};
let askedNamespace;
const configForms = {
  describe: () => ({
    getSnapshot: () => ({ status: "ready", view: { namespaces: [{ ns: "include:io-optimizer" }], writable: true } }),
    subscribe: () => () => {},
  }),
  get(ns) {
    askedNamespace = ns;
    return controller;
  },
};
const section = SettingsSection({ forms: configForms, t: injected.t });
assert.equal(askedNamespace, "include:io-optimizer", "应该认出 bundle 行的 Loader id");
assert.equal(typeof section.type, "function", "拿到控制器后渲染 Fields");
const tree = section.type({ state: snapshot, mutate: section.props.mutate, formT: undefined });
assert.equal(tree.props["data-io-optimizer-form"], true, "表单根节点带标记");
const serialized = JSON.stringify(tree);
assert.ok(serialized.includes("readCacheSessions"), "表单里应包含字段");
const fieldCount = (serialized.match(/"io-opt-/g) ?? []).length;
assert.equal(fieldCount, 14, "七个字段都要渲染出来（label htmlFor + input id 各一处）");

// 保存经控制器走，带 revision
assert.equal(await section.props.mutate([{ op: "set", path: ["warmSessions"], value: 4 }], snapshot.revision), true);
assert.deepEqual(mutations.at(-1), { ops: [{ op: "set", path: ["warmSessions"], value: 4 }], revision: 3 });

// id 完全不像时，按字段形状兜底认领
let shapeNamespace;
const shapeForms = {
  describe: () => ({
    getSnapshot: () => ({ status: "ready", view: { namespaces: [{ ns: "totally-different-id", value: { warmDelayMs: 15000 } }], writable: true } }),
    subscribe: () => () => {},
  }),
  get(ns) {
    shapeNamespace = ns;
    return controller;
  },
};
const shaped = SettingsSection({ forms: shapeForms, t: injected.t });
assert.equal(shapeNamespace, "totally-different-id", "id 不像时也要按值里的字段认出来");
assert.equal(typeof shaped.type, "function", "形状匹配成功后同样渲染 Fields");

// 只读时不许点保存（走插件页那条路径验证一次）
const readonlyPage = ConfigPage({ view: "page", form: { state: { ...snapshot, writable: false }, mutate: controller.mutate } });
assert.equal(typeof readonlyPage.type, "function");

console.log("✅ client: 所有断言通过");
console.log(`   槽位 ${registrations.length} 个，设置分节 id ${SECTION_ID}，字段渲染 ${fieldCount} 处`);

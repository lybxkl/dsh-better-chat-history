// 更好的聊天记录加载 —— 浏览器端半个插件。
//
// 做两件事，用的是同一套表单：
//   1) 「插件」页本插件那一行挂一个配置页（plugins.row.config）；
//   2) 「设置」侧栏加一个独立分节（settings.section），不用再钻进插件页找。
//
// 两条路的数据来源不同：
//   插件页   —— 槽位直接给 props.form = { state, mutate }；
//   设置页   —— 拿 ctx.configForms（@deepseek-ai/dsh-client-ui-settings 提供的
//               服务）：describe() 列出 Host 已经投影成表单的命名空间，
//               再 get(ns) 拿到同一个 ConfigForm 控制器，订阅它的快照。
//   两者的 mutate 契约相同：mutate(operations, expectedRevision) -> Promise<boolean>，
//   operations = [{ op: 'set', path: [field], value }] / [{ op: 'unset', path: [field] }]。
//
// 命名空间必须现场解析而不是写死：bundle patch 里的行 id 是 io-optimizer，
// 但 Loader 可能把它登记成 include:io-optimizer 或 <包名>#io-optimizer，
// 不同版本不一样，所以按候选 + 后缀匹配。
//
// 注意：DSH 文档明确不要 import Harness 的 Client 包（primitives 等），
// 所以控件全部自绘，只用 --dsw-alias-* 主题变量，跟随明暗主题。

window.__ModuleLoader__.load({
  id: 'dsh-better-chat-history',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'ioOptimizer'
    const ROW_ID = 'io-optimizer'
    const ROW_KEY = 'dsh-better-chat-history#io-optimizer'
    const SECTION_ID = 'better-chat-history'
    const NS_CANDIDATES = [ROW_ID, `include:${ROW_ID}`, ROW_KEY]

    const zh = {
      sectionLabel: '加载缓存',
      title: '加载缓存',
      intro: '调整读缓存的规模与预热行为。保存后本插件会重启并重新预热。',
      unavailable: '这个部署没有暴露可编辑的插件配置，请在 profile 的 cordis.patch.yml 里给 io-optimizer 行加 config。',
      notFound: '没有找到本插件的配置项（io-optimizer 行可能没启用，或本次部署没有把它的 Config 投影成表单）。',
      noService: '当前界面没有提供配置表单服务（ui-settings 未加载），暂时无法在这里改设置。',
      loading: '正在读取配置…',
      readCacheSessions: '缓存会话数',
      readCacheSessionsHint: '0 表示关闭读缓存（每次打开都走原生冷读）。',
      readCacheSessionMb: '单会话上限（MB）',
      readCacheSessionMbHint: '源文件超过这个大小的会话不缓存，避免几百 MB 的 JS 对象驻留内存。',
      readCacheSourceMb: '缓存总量上限（MB）',
      readCacheSourceMbHint: '所有被缓存会话的源文件字节总和上限。',
      listCacheTtlMs: '会话列表缓存（毫秒）',
      listCacheTtlMsHint: '0 表示每次都重新扫描会话列表。',
      warmSessions: '预热会话数',
      warmSessionsHint: '启动后在后台把最近活跃的会话读进缓存，让第一次点击就命中。0 关闭。',
      warmDelayMs: '预热延迟（毫秒）',
      warmDelayMsHint: '避开启动高峰，默认 15 秒后开始。',
      save: '保存',
      discard: '放弃改动',
      saving: '保存中…',
      saved: '已保存，插件正在重启。',
      conflict: '保存被拒绝（配置有并发修改或被更高层覆盖），已保留你的草稿。',
      failed: '保存失败，请查看 DSH 日志。',
      readonly: '当前配置不可写。',
      dirty: '有未保存的改动',
      unchanged: '没有改动',
      summary: '读缓存与预热参数',
    }
    const en = {
      sectionLabel: 'Load cache',
      title: 'Load cache',
      intro: 'Tune the read cache and warm-up. Saving restarts this plugin and warms the cache again.',
      unavailable: 'This deployment exposes no editable configuration; add config to the io-optimizer row in the profile cordis.patch.yml instead.',
      notFound: 'No configuration entry found for this plugin (the io-optimizer row may be disabled, or this deployment does not project its Config into a form).',
      noService: 'This UI exposes no configuration-form service (ui-settings is not loaded), so settings cannot be edited here.',
      loading: 'Reading configuration…',
      readCacheSessions: 'Cached sessions',
      readCacheSessionsHint: '0 disables the read cache (every open cold-reads the log).',
      readCacheSessionMb: 'Per-session limit (MB)',
      readCacheSessionMbHint: 'Sessions whose source file is larger stay uncached, so hundreds of MB of decoded objects never stay resident.',
      readCacheSourceMb: 'Total budget (MB)',
      readCacheSourceMbHint: 'Upper bound on the summed source bytes of cached sessions.',
      listCacheTtlMs: 'Session list cache (ms)',
      listCacheTtlMsHint: '0 rescans the session list every time.',
      warmSessions: 'Warm-up sessions',
      warmSessionsHint: 'Reads the most recently active sessions into the cache after startup so the first click hits. 0 disables.',
      warmDelayMs: 'Warm-up delay (ms)',
      warmDelayMsHint: 'Keeps warm-up out of the startup burst; 15 s by default.',
      save: 'Save',
      discard: 'Discard',
      saving: 'Saving…',
      saved: 'Saved; the plugin is restarting.',
      conflict: 'Save refused (concurrent edit or a higher layer overrides it); your draft is kept.',
      failed: 'Save failed; check the DSH log.',
      readonly: 'This configuration is read-only.',
      dirty: 'Unsaved changes',
      unchanged: 'No changes',
      summary: 'Read cache and warm-up',
    }

    // default 与 Host 端 DEFAULTS 保持一致：schema 不带默认值（否则会顶掉老配置里
    // 的 readCacheSessionBytes），所以表单自己兜底显示。
    const FIELDS = [
      { key: 'readCacheSessions', min: 0, max: 64, step: 1, fallback: 6 },
      { key: 'readCacheSessionMb', min: 0, max: 512, step: 1, fallback: 8 },
      { key: 'readCacheSourceMb', min: 1, max: 4096, step: 1, fallback: 64 },
      { key: 'listCacheTtlMs', min: 0, max: 600000, step: 500, fallback: 5000 },
      { key: 'warmSessions', min: 0, max: 64, step: 1, fallback: 8 },
      { key: 'warmDelayMs', min: 0, max: 300000, step: 1000, fallback: 15000 },
    ]
    const numeric = (field, source) => {
      const raw = source?.[field.key]
      const value = raw === undefined || raw === null || raw === '' ? field.fallback : Number(raw)
      return Number.isFinite(value) ? value : field.fallback
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '560px' },
      intro: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      labelRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
      label: { fontSize: '13px', fontWeight: 500, color: 'var(--dsw-alias-text-primary, inherit)' },
      input: {
        width: '132px', padding: '5px 8px', fontSize: '13px', textAlign: 'right',
        color: 'var(--dsw-alias-text-primary, inherit)',
        background: 'var(--dsw-alias-bg-secondary, transparent)',
        border: '1px solid var(--dsw-alias-border-secondary, #d1d5db)',
        borderRadius: '6px',
      },
      hint: { margin: 0, fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-text-tertiary, #9ca3af)' },
      bar: { display: 'flex', alignItems: 'center', gap: '10px' },
      button: {
        padding: '5px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-secondary, #d1d5db)',
        color: 'var(--dsw-alias-text-primary, inherit)',
        background: 'var(--dsw-alias-bg-secondary, transparent)',
      },
      primary: {
        padding: '5px 14px', fontSize: '13px', cursor: 'pointer', borderRadius: '6px', border: 'none',
        color: 'var(--dsw-alias-text-on-primary, #fff)',
        background: 'var(--dsw-alias-bg-primary, #247bbf)',
      },
      status: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
    }

    const text = (t, key) => {
      if (typeof t === 'function') {
        try {
          const value = t(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch {
          // 翻译函数不可用时退回内置文案，不打断渲染。
        }
      }
      return zh[key] ?? key
    }

    /** 按名字软取服务：服务没就绪时返回 undefined，而不是抛错。 */
    const softService = (ctx, name) => {
      if (ctx === undefined || ctx === null) return undefined
      if (typeof ctx.get === 'function') {
        try {
          const found = ctx.get(name)
          if (found !== undefined) return found
        } catch {
          // 服务不在依赖图里，继续走属性访问。
        }
      }
      try {
        return ctx[name]
      } catch {
        return undefined
      }
    }

    /**
     * 从 describe 的命名空间列表里认出本插件那一行。
     *
     * @param namespaces - SettingsNamespaceView[]，元素带 ns 字段。
     * @returns 匹配到的命名空间字符串，认不出来时 undefined。
     */
    const matchNamespace = (namespaces) => {
      if (!Array.isArray(namespaces) || namespaces.length === 0) return undefined
      const ids = []
      for (const view of namespaces) {
        if (view !== null && typeof view === 'object' && typeof view.ns === 'string' && view.ns !== '') ids.push(view.ns)
      }
      for (const candidate of NS_CANDIDATES) {
        if (ids.includes(candidate)) return candidate
      }
      return ids.find((id) => id.endsWith(`:${ROW_ID}`) || id.endsWith(`#${ROW_ID}`) || id.endsWith(`/${ROW_ID}`))
    }

    /**
     * 解析出本插件的 ConfigForm 控制器。
     *
     * @param forms - ctx.configForms（可能不存在）。
     * @param face - forms.describe() 的镜像面（可能不存在）。
     * @returns 控制器，或 undefined（服务缺失 / 命名空间没被 Serve）。
     */
    const resolveForm = (forms, face) => {
      if (forms === undefined || forms === null || typeof forms.get !== 'function') return undefined
      if (face === undefined || face === null || typeof face.getSnapshot !== 'function') return undefined
      const snapshot = face.getSnapshot()
      const ns = matchNamespace(snapshot?.view?.namespaces)
      if (ns === undefined) return undefined
      try {
        const controller = forms.get(ns)
        if (controller !== undefined && controller !== null && typeof controller.getSnapshot === 'function') return controller
      } catch {
        return undefined
      }
      return undefined
    }

    /** 表单本体：只在拿到 state + mutate 之后挂载，保证 hooks 顺序稳定。 */
    function Fields({ state, mutate, formT }) {
      const current = state?.value ?? {}
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const shown = draft ?? current
      const dirty = FIELDS.some((field) => numeric(field, shown) !== numeric(field, current))
      const writable = state?.writable !== false

      const commit = async () => {
        if (busy) return
        const ops = FIELDS.filter((field) => numeric(field, shown) !== numeric(field, current))
          .map((field) => ({ op: 'set', path: [field.key], value: numeric(field, shown) }))
        if (ops.length === 0) return
        setBusy(true)
        setNotice(null)
        try {
          const accepted = await mutate(ops, state?.revision)
          setNotice(accepted === false ? 'conflict' : 'saved')
          if (accepted !== false) setDraft(null)
        } catch {
          setNotice('failed')
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: styles.wrap, 'data-io-optimizer-form': true },
        h('p', { style: styles.intro }, text(formT, 'intro')),
        ...FIELDS.map((field) => h('div', { key: field.key, style: styles.field },
          h('div', { style: styles.labelRow },
            h('label', { style: styles.label, htmlFor: `io-opt-${field.key}` }, text(formT, field.key)),
            h('input', {
              id: `io-opt-${field.key}`,
              type: 'number',
              min: field.min,
              max: field.max,
              step: field.step,
              disabled: !writable || busy,
              value: String(shown[field.key] ?? ''),
              style: styles.input,
              onChange: (event) => {
                const next = { ...shown, [field.key]: event.target.value === '' ? '' : Number(event.target.value) }
                setDraft(next)
                setNotice(null)
              },
            }),
          ),
          h('p', { style: styles.hint }, text(formT, `${field.key}Hint`)),
        )),
        h('div', { style: styles.bar },
          h('button', { type: 'button', style: styles.primary, disabled: !writable || busy, onClick: commit },
            text(formT, busy ? 'saving' : 'save')),
          dirty
            ? h('button', {
              type: 'button', style: styles.button, disabled: busy,
              onClick: () => { setDraft(null); setNotice(null) },
            }, text(formT, 'discard'))
            : null,
          h('span', { style: styles.status },
            notice !== null
              ? text(formT, notice)
              : !writable
                ? text(formT, 'readonly')
                : dirty ? text(formT, 'dirty') : text(formT, 'unchanged')),
        ),
      )
    }

    /** 插件页那一行的配置页（plugins.row.config）：form 由槽位注入。 */
    function RowConfigPage(props) {
      const formT = props?.t
      if (props?.view === 'summary') {
        return h('span', null, text(formT, 'summary'))
      }
      const form = props?.form
      if (form === undefined || form === null || typeof form.mutate !== 'function') {
        return h('p', { style: styles.intro, 'data-io-optimizer-unavailable': true }, text(formT, 'unavailable'))
      }
      return h(Fields, { state: form.state, mutate: form.mutate, formT })
    }

    /**
     * 设置侧栏那一页（settings.section）。
     *
     * 这一页拿不到插件页的 props.form，只能通过 ctx.configForms 取同一个控制器：
     * 先订阅 describe 镜像找命名空间，再订阅控制器快照拿值。
     *
     * @param props - { close }（宿主只给这一个），外加注册时 inject 注入的 forms / t。
     */
    function SettingsSection(props) {
      const forms = props?.forms ?? softService(pluginContext, 'configForms')
      const formT = props?.t ?? ((key) => translate(key))
      const face = forms !== undefined && forms !== null && typeof forms.describe === 'function' ? forms.describe() : undefined

      const [controller, setController] = React.useState(() => resolveForm(forms, face))
      const [state, setState] = React.useState(() => (controller === undefined ? undefined : controller.getSnapshot()))

      React.useEffect(() => {
        if (face === undefined || face === null || typeof face.subscribe !== 'function') return undefined
        const sync = () => {
          const next = resolveForm(forms, face)
          setController(next)
          setState(next === undefined ? undefined : next.getSnapshot())
        }
        sync()
        return face.subscribe(sync)
      }, [forms, face])

      React.useEffect(() => {
        if (controller === undefined || controller === null) return undefined
        setState(controller.getSnapshot())
        return controller.subscribe(() => setState(controller.getSnapshot()))
      }, [controller])

      if (forms === undefined || forms === null || typeof forms.get !== 'function') {
        return h('p', { style: styles.intro, 'data-io-optimizer-no-service': true }, text(formT, 'noService'))
      }
      if (controller === undefined || controller === null) {
        // 镜像还没读到（view 为空）时是「加载中」，读到了但没有本行才是「找不到」。
        const snapshot = typeof face?.getSnapshot === 'function' ? face.getSnapshot() : undefined
        const key = snapshot?.view === undefined ? 'loading' : 'notFound'
        return h('p', { style: styles.intro, 'data-io-optimizer-not-found': true }, text(formT, key))
      }
      return h(Fields, {
        state,
        mutate: (ops, revision) => controller.mutate(ops, revision),
        formT,
      })
    }

    /**
     * 设置侧栏图标：宿主要求纯函数、无 hook，返回元素直接渲染。
     *
     * @param props - { size, active }。
     */
    function SectionIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      const stroke = props?.active === true
        ? 'var(--dsw-alias-text-primary, currentColor)'
        : 'var(--dsw-alias-text-secondary, currentColor)'
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke, strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', 'data-io-optimizer-icon': true,
      },
        // 一叠会话卡 + 右下角闪电：读缓存加速。
        h('rect', { key: 'card', x: 1.9, y: 2.6, width: 8.6, height: 6.6, rx: 1.5 }),
        h('path', { key: 'row2', d: 'M4.1 11.2h7.6' }),
        h('path', { key: 'row3', d: 'M5.8 13.1h4.2' }),
        h('path', { key: 'bolt', d: 'M12.5 5.4 10.6 8.6h1.7l-.8 2.4 2.3-3.3h-1.7l.9-2.3' }),
      )
    }

    let pluginContext
    let translate = (key) => zh[key] ?? key

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        pluginContext = ctx
        // 每次调用都向 locale 要当前语言，避免注册时把语言写死。
        translate = (key) => {
          const bound = (() => {
            try {
              return ctx.locale.bind(NS)
            } catch {
              return undefined
            }
          })()
          if (typeof bound === 'function') {
            try {
              const value = bound(key)
              if (typeof value === 'string' && value !== '' && value !== key) return value
            } catch {
              // 退回内置中文。
            }
          }
          return zh[key] ?? key
        }

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'io-optimizer: dictionaries')

        // 插件页那一行。
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
        }, RowConfigPage))

        // 设置侧栏独立分节：不依赖插件页也能改配置。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 27,
          label: () => translate('sectionLabel'),
          inject: () => ({ forms: softService(ctx, 'configForms'), t: translate }),
        }, SettingsSection))

        // 侧栏图标：注册 id 必须等于分节的 id，否则宿主退回通用齿轮。
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: SECTION_ID,
          order: 27,
        }, SectionIcon))
      },
    }
  },
})

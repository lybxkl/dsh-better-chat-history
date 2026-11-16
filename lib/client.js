// 更好的聊天记录加载 —— 浏览器端半个插件。
//
// 只做一件事：在「插件」页给本插件那一行挂一个配置页（plugins.row.config）。
// DSH 的插件页约定：注册这个槽位后，那一行会多出「配置」按钮，点开就是这里渲染的表单；
// 保存走页面注入的 form.mutate()，由 Host 的配置编辑器写回 profile 的 cordis.patch.yml。
//
// 约定（取自 @deepseek-ai/dsh-client-ui-plugin-manager 的插件页实现）：
//   槽位 props: { view: 'page' | 'summary', form: { state, mutate } | undefined, t }
//   form.state: { status, value, base, user, revision, writable }
//   form.mutate(operations, expectedRevision) -> Promise<boolean>
//     operations = [{ op: 'set', path: [field], value }] / [{ op: 'unset', path: [field] }]
// 当 Host 没有把本行暴露成可编辑配置时 form 为 undefined，此时只展示说明，不报错。
//
// 注意：DSH 文档明确不要 import Harness 的 Client 包（primitives 等），
// 所以控件全部自绘，只用 --dsw-alias-* 主题变量，跟随明暗主题。

window.__ModuleLoader__.load({
  id: 'dsh-better-chat-history',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'ioOptimizer'
    const ROW_KEY = 'dsh-better-chat-history#io-optimizer'

    const zh = {
      title: '加载缓存',
      intro: '调整读缓存的规模与预热行为。保存后本插件会重启并重新预热。',
      unavailable: '这个部署没有暴露可编辑的插件配置，请在 profile 的 cordis.patch.yml 里给 io-optimizer 行加 config。',
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
      title: 'Load cache',
      intro: 'Tune the read cache and warm-up. Saving restarts this plugin and warms the cache again.',
      unavailable: 'This deployment exposes no editable configuration; add config to the io-optimizer row in the profile cordis.patch.yml instead.',
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
        const value = t(key)
        if (typeof value === 'string' && value !== '' && value !== key) return value
      }
      return zh[key] ?? key
    }

    /** 表单本体：只在 form 存在时挂载，保证 hooks 调用顺序稳定。 */
    function Fields({ form, formT }) {
      const state = form.state ?? {}
      const current = state.value ?? {}
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const shown = draft ?? current
      const dirty = FIELDS.some((field) => numeric(field, shown) !== numeric(field, current))
      const writable = state.writable !== false

      const commit = async () => {
        if (busy) return
        const ops = FIELDS.filter((field) => numeric(field, shown) !== numeric(field, current))
          .map((field) => ({ op: 'set', path: [field.key], value: numeric(field, shown) }))
        if (ops.length === 0) return
        setBusy(true)
        setNotice(null)
        try {
          const accepted = await form.mutate(ops, state.revision)
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

    function ConfigPage(props) {
      const formT = props.t
      if (props.view === 'summary') {
        return h('span', null, text(formT, 'summary'))
      }
      const form = props.form
      if (form === undefined || form === null || typeof form.mutate !== 'function') {
        return h('p', { style: styles.intro, 'data-io-optimizer-unavailable': true }, text(formT, 'unavailable'))
      }
      return h(Fields, { form, formT })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'io-optimizer: dictionaries')
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
        }, ConfigPage))
      },
    }
  },
})

// dsh-smart-route — Client 半区
//
// 1. 对话栏按钮（conversation.input.right，模型选择旁）：
//    - 显示当前路由状态（启用/停用）
//    - 点击展开小面板：一键启用/停用、当前默认链、各渠道冷却状态
// 2. 设置卡（settings.plugin.item）：链配置编辑（渠道顺序、冷却参数）。
window.__ModuleLoader__.load({
  id: 'dsh-smart-route',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    const RPC_CHANNEL = '/dsh-smart-route'
    const inject = ['slots', 'connection', 'settingsScope']

    // ── 样式（与 DSH 主题一致）──────────────────────────────────────
    const CSS =
      '.srt-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:999px;padding:4px 11px;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}' +
      '.srt-btn:hover{border-color:var(--dsw-alias-brand-primary)}' +
      '.srt-btn.srt-off{color:var(--dsw-alias-label-secondary);opacity:.7}' +
      '.srt-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:0 0 auto}' +
      '.srt-dot.srt-off{background:var(--dsw-alias-label-tertiary)}' +
      '.srt-backdrop{position:fixed;inset:0;z-index:9990;background:transparent}' +
      '.srt-pop{position:absolute;bottom:calc(100% + 10px);right:0;z-index:9991;width:320px;max-width:calc(100vw - 24px);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;box-shadow:0 10px 34px rgba(0,0,0,.28)}' +
      '.srt-pop-title{font-size:13px;font-weight:600}' +
      '.srt-pop-sub{opacity:.72;font-size:11px}' +
      '.srt-switch{display:flex;align-items:center;gap:8px;justify-content:space-between;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px}' +
      '.srt-toggle{appearance:none;width:34px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);position:relative;cursor:pointer;transition:background .15s;flex:none}' +
      '.srt-toggle:checked{background:var(--dsw-alias-brand-primary)}' +
      '.srt-toggle:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}' +
      '.srt-toggle:checked:after{left:16px}' +
      '.srt-row{display:flex;flex-direction:column;gap:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px}' +
      '.srt-row-head{display:flex;align-items:center;gap:8px}' +
      '.srt-label{font-weight:500}' +
      '.srt-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;margin-left:auto}' +
      '.srt-badge.srt-hot{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-3)}' +
      '.srt-cool{font-size:11px;opacity:.8;font-variant-numeric:tabular-nums}' +
      '.srt-actions{display:flex;gap:8px}' +
      '.srt-actions button{flex:1;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px}' +
      '.srt-actions button.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}' +
      '.srt-status{min-height:16px;font-size:11px;opacity:.85;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}' +
      '.srt-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}' +
      '.srt-card:hover{border-color:var(--dsw-alias-label-dimmed)}' +
      '.srt-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}' +
      '.srt-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}' +
      '.srt-card-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
      '.srt-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.srt-card-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}' +
      '.srt-card-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;font-size:12px;line-height:1}' +
      '.srt-card-chevron-open{transform:rotate(180deg)}' +
      '.srt-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}' +
      '.srt-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}' +
      '.srt-field + .srt-field{border-top:1px solid var(--dsw-alias-border-l2)}' +
      '.srt-field-head{display:flex;align-items:center;gap:8px}' +
      '.srt-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);min-height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}' +
      '.srt-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.srt-iconBtn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);min-width:28px;height:28px;font-size:13px;line-height:1;padding:0}' +
      '.srt-iconBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}' +
      '.srt-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}' +
      '.srt-btn2{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0}' +
      '.srt-btn2:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}' +
      '.srt-btn2-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:#0000}' +
      '.srt-btn2:disabled{opacity:.4;cursor:default}' +
      '.srt-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}'

    let stylesInstalled = false
    function installStyles() {
      if (stylesInstalled || typeof document === 'undefined') return
      stylesInstalled = true
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-smart-route'
      tag.dataset.pluginCss = 'dsh-smart-route'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove(); stylesInstalled = false }
    }

    const h = React.createElement

    // ── 对话栏按钮 ───────────────────────────────────────────────────
    function ComposerButton(props) {
      const rpc = props.rpc
      const [open, setOpen] = useState(false)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(() => {
        rpc.call(RPC_CHANNEL, 'status', {}).then((res) => {
          if (res && res.ok) setStatus(res.value)
        }).catch(() => {})
      }, [rpc])

      useEffect(() => {
        load()
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [load])

      const toggle = () => {
        setBusy(true)
        rpc.call(RPC_CHANNEL, 'setEnabled', { enabled: !(status && status.enabled) })
          .then((res) => { if (res && res.ok) load(); setBusy(false) })
          .catch(() => setBusy(false))
      }

      const enabled = !!(status && status.enabled)
      const chain = status && status.defaultChain ? status.defaultChain : 'default'
      const cooldown = status && status.cooldown ? status.cooldown : {}
      const coolingNames = Object.keys(cooldown)

      return h('div', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', {
          type: 'button', className: 'srt-btn' + (enabled ? '' : ' srt-off'),
          title: enabled ? '智能路由已启用 — 点击查看/停用' : '智能路由已停用 — 点击查看/启用',
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'srt-dot' + (enabled ? '' : ' srt-off') }),
          h('span', null, enabled ? '智能路由' : '路由停用'),
        ),
        open ? h('div', { className: 'srt-backdrop', onClick: () => setOpen(false) }) : null,
        open ? h('div', { className: 'srt-pop' },
          h('div', { className: 'srt-pop-title' }, '智能路由'),
          h('div', { className: 'srt-pop-sub' }, '渠道报错自动切换下一家（含 4xx）。停用后模型请求直连默认渠道。'),
          h('div', { className: 'srt-switch' },
            h('span', null, enabled ? '已启用' : '已停用'),
            h('input', { type: 'checkbox', className: 'srt-toggle', checked: enabled, disabled: busy, onChange: toggle }),
          ),
          h('div', { className: 'srt-row' },
            h('div', { className: 'srt-row-head' },
              h('span', { className: 'srt-label' }, '默认链'),
              h('span', { className: 'srt-badge' + (enabled ? ' srt-hot' : '') }, chain),
            ),
            h('div', { className: 'srt-row-head' },
              h('span', { className: 'srt-label' }, '可用渠道'),
              h('span', { className: 'srt-badge' }, (status && status.providers ? status.providers.length : 0) + ' 个'),
            ),
          ),
          coolingNames.length > 0
            ? h('div', { className: 'srt-row' },
                h('div', { className: 'srt-row-head' },
                  h('span', { className: 'srt-label' }, '冷却中渠道'),
                ),
                coolingNames.map((p) =>
                  h('div', { className: 'srt-cool', key: p }, p + ' — ' + cooldown[p] + ' 秒后恢复')),
              )
            : null,
          h('div', { className: 'srt-status' }, busy ? '处理中…' : ''),
        ) : null,
      )
    }

    // ── 设置卡：链配置 ───────────────────────────────────────────────
    function SettingsCard(props) {
      const rpc = props.rpc
      const [open, setOpen] = useState(false)
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState(null) // 编辑中的链
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState(false)

      const load = useCallback(() => {
        rpc.call(RPC_CHANNEL, 'status', {}).then((res) => {
          if (res && res.ok) setStatus(res.value)
        }).catch(() => {})
      }, [rpc])

      useEffect(() => { load() }, [load])

      const chains = status && status.chains ? status.chains : {}
      const defaultChain = status && status.defaultChain ? status.defaultChain : 'default'
      const editing = draft !== null ? draft : { name: defaultChain, entries: (chains[defaultChain] || []).map((e) => ({ ...e })) }

      const updateEntry = (index, patch) => {
        setFailed(false)
        setDraft((prev) => {
          const base = prev !== null ? prev : { name: defaultChain, entries: (chains[defaultChain] || []).map((e) => ({ ...e })) }
          const entries = base.entries.map((e, i) => (i === index ? { ...e, ...patch } : e))
          return { ...base, entries }
        })
      }
      const addEntry = () => {
        setFailed(false)
        setDraft((prev) => {
          const base = prev !== null ? prev : { name: defaultChain, entries: (chains[defaultChain] || []).map((e) => ({ ...e })) }
          return { ...base, entries: [...base.entries, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }] }
        })
      }
      const removeEntry = (index) => {
        setFailed(false)
        setDraft((prev) => {
          const base = prev !== null ? prev : { name: defaultChain, entries: (chains[defaultChain] || []).map((e) => ({ ...e })) }
          return { ...base, entries: base.entries.filter((_e, i) => i !== index) }
        })
      }
      const moveEntry = (index, dir) => {
        setFailed(false)
        setDraft((prev) => {
          const base = prev !== null ? prev : { name: defaultChain, entries: (chains[defaultChain] || []).map((e) => ({ ...e })) }
          const list = [...base.entries]
          const target = index + dir
          if (target < 0 || target >= list.length) return prev
          const [moved] = list.splice(index, 1)
          list.splice(target, 0, moved)
          return { ...base, entries: list }
        })
      }
      const resetDraft = () => { setDraft(null); setFailed(false) }
      const saveChain = () => {
        if (!editing.entries || editing.entries.length === 0 || editing.entries.some((e) => !e.provider || !e.model)) {
          setFailed(true)
          return
        }
        setSaving(true)
        setFailed(false)
        rpc.call(RPC_CHANNEL, 'setChain', { name: editing.name, entries: editing.entries })
          .then((res) => {
            if (res && res.ok) { resetDraft(); load() }
            else setFailed(true)
            setSaving(false)
          })
          .catch(() => { setFailed(true); setSaving(false) })
      }

      const h2 = h
      return h2('li', { className: 'srt-card' + (open ? ' srt-card-open' : '') },
        h2('button', {
          type: 'button', className: 'srt-card-header', 'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h2('span', { className: 'srt-card-headText' },
            h2('span', { className: 'srt-card-name' }, '智能路由（dsh-smart-route）'),
            h2('span', { className: 'srt-card-desc' },
              '供应商自动路由：渠道报错自动切换下一家（含 4xx）· 对话栏一键启用/停用 · 不污染模型列表'),
          ),
          h2('span', { className: 'srt-card-chevron' + (open ? ' srt-card-chevron-open' : '') }, '▾'),
        ),
        open ? h2('div', { className: 'srt-card-body' },
          h2('div', { className: 'srt-field' },
            h2('div', { className: 'srt-field-head' },
              h2('span', { style: { fontWeight: 600, fontSize: 13 } }, '默认链「' + editing.name + '」的渠道顺序'),
            ),
            (editing.entries || []).map((entry, index) =>
              h2('div', { key: index, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', flexWrap: 'wrap' } },
                h2('span', { style: { flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', width: 16 } }, (index + 1) + '.'),
                h2('input', {
                  className: 'srt-input', style: { flex: '1 1 180px' }, placeholder: 'provider', value: entry.provider,
                  onChange: (e) => updateEntry(index, { provider: e.target.value }),
                }),
                h2('input', {
                  className: 'srt-input', style: { flex: '1 1 180px' }, placeholder: 'model', value: entry.model,
                  onChange: (e) => updateEntry(index, { model: e.target.value }),
                }),
                h2('button', { type: 'button', className: 'srt-iconBtn', title: '上移', disabled: index === 0, onClick: () => moveEntry(index, -1) }, '↑'),
                h2('button', { type: 'button', className: 'srt-iconBtn', title: '下移', disabled: index === (editing.entries || []).length - 1, onClick: () => moveEntry(index, 1) }, '↓'),
                h2('button', { type: 'button', className: 'srt-iconBtn', title: '移除', onClick: () => removeEntry(index) }, '✕'),
              ),
            ),
            h2('button', { type: 'button', className: 'srt-btn2', onClick: addEntry }, '+ 添加渠道'),
            h2('p', { className: 'srt-hint' },
              '渠道 provider 必须是 DSH 已注册的（如 deepseek-official、yunzhou、mze）。从上到下尝试，任一渠道报错（含 4xx）自动切下一家。'),
          ),
          h2('div', { className: 'srt-footer' },
            failed ? h2('p', { style: { flex: 1, margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-error)' } }, '保存失败：链需至少一个渠道，且 provider/model 不能为空。') : null,
            h2('button', { type: 'button', className: 'srt-btn2', disabled: draft === null || saving, onClick: resetDraft }, '放弃修改'),
            h2('button', { type: 'button', className: 'srt-btn2 srt-btn2-save', disabled: draft === null || saving, onClick: saveChain }, saving ? '保存中…' : '保存'),
          ),
        ) : null,
      )
    }

    // ── apply ────────────────────────────────────────────────────────
    function apply(ctx) {
      installStyles()
      const rpc = ctx.connection.rpc

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'dsh-smart-route',
        order: 15,
        label: '智能路由',
        inject: () => ({ rpc }),
      }, (props) => h(ComposerButton, Object.assign({}, props, { rpc }))))

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        id: 'dsh-smart-route',
        order: 45,
        label: '智能路由',
        inject: () => ({ rpc }),
      }, (props) => h(SettingsCard, Object.assign({}, props, { rpc }))))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

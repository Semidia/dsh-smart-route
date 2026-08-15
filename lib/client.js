// dsh-smart-route — Client 半区
//
// 1. 对话栏按钮（conversation.input.right，模型选择旁）：
//    - 显示当前路由状态（启用/停用），点击展开面板
//    - 面板：一键启用/停用、当前默认链、链内渠道、冷却状态
// 2. 设置卡（settings.plugin.item）：
//    - 多链管理：新建链 / 删除链 / 切换默认链
//    - 渠道编辑：provider / model / baseUrl / apiKeyEnv
//    - 允许空链（保存时提示但可存）
//
// 读写全部走 settingsScope（settings namespace 的 Host transport），
// 不依赖 loopback RPC（client 端没有 connection 服务）。
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
    var useSyncExternalStore = React.useSyncExternalStore

    const inject = ['slots', 'settingsScope']

    // ── 样式（幽灵式：透明底 + 细边框 + 主题文字色，激活用表面色填充）──
    const CSS =
      '.srt-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:999px;padding:4px 11px;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}' +
      '.srt-btn:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.srt-btn.srt-off{color:var(--dsw-alias-label-secondary);opacity:.7}' +
      '.srt-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:0 0 auto}' +
      '.srt-dot.srt-off{background:var(--dsw-alias-label-tertiary)}' +
      '.srt-backdrop{position:fixed;inset:0;z-index:9990;background:transparent}' +
      '.srt-pop{position:absolute;bottom:calc(100% + 10px);right:0;z-index:9991;width:340px;max-width:calc(100vw - 24px);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;box-shadow:0 10px 34px rgba(0,0,0,.28)}' +
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
      '.srt-input{border:1px solid var(--dsw-alias-border-l2);background:transparent;min-height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}' +
      '.srt-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.srt-input::placeholder{color:var(--dsw-alias-label-tertiary)}' +
      '.srt-iconBtn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);min-width:28px;height:28px;font-size:13px;line-height:1;padding:0}' +
      '.srt-iconBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.srt-iconBtn:disabled{opacity:.35;cursor:default}' +
      '.srt-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}' +
      '.srt-btn2{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:transparent}' +
      '.srt-btn2:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.srt-btn2-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}' +
      '.srt-btn2:disabled{opacity:.4;cursor:default}' +
      '.srt-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}' +
      '.srt-err{flex:1;margin:0;font-size:12px;color:var(--dsw-alias-label-error)}'

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

    // ── settingsScope 读取辅助 ──────────────────────────────────────
    // 返回 { status, value, enabled, defaultChain, chains }
    function readSnapshot(scope) {
      const snap = scope.getSnapshot()
      const status = snap && snap.status
      const value = snap && snap.status === 'ready' && snap.value && typeof snap.value === 'object' ? snap.value : null
      return {
        status,
        ready: status === 'ready',
        enabled: !!(value && value.enabled !== false),
        defaultChain: (value && value.defaultChain) || 'default',
        chains: (value && value.chains) || {},
      }
    }

    // ── 对话栏按钮 ───────────────────────────────────────────────────
    function ComposerButton(props) {
      const scope = props.scope
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)

      // settingsScope 的 getSnapshot/subscribe 是原型方法，必须绑定 this；
      // 用 useMemo 缓存稳定引用，避免 useSyncExternalStore 反复重订阅。
      const bound = React.useMemo(() => ({
        subscribe: scope.subscribe.bind(scope),
        getSnapshot: scope.getSnapshot.bind(scope),
      }), [scope])
      const subscribe = useCallback((cb) => bound.subscribe(cb), [bound])
      const getSnap = useCallback(() => bound.getSnapshot(), [bound])
      let snap
      try { snap = useSyncExternalStore(subscribe, getSnap) } catch (e) { snap = bound.getSnapshot() }
      const view = readSnapshotFrom(snap)
      const enabled = view.enabled
      const chain = view.defaultChain
      const entries = view.chains[chain] || []

      const toggle = () => {
        setBusy(true)
        Promise.resolve(scope.set('enabled', !enabled))
          .catch(() => {})
          .finally(() => setBusy(false))
      }

      return h('div', { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', {
          type: 'button', className: 'srt-btn' + (enabled ? '' : ' srt-off'),
          title: enabled ? '智能路由已启用 — 点击查看/停用' : '智能路由已停用 — 点击查看/启用',
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'srt-dot' + (enabled ? '' : ' srt-off') }),
          h('span', null, view.ready ? (enabled ? '智能路由' : '路由停用') : '路由…'),
        ),
        open ? h('div', { className: 'srt-backdrop', onClick: () => setOpen(false) }) : null,
        open ? h('div', { className: 'srt-pop' },
          h('div', { className: 'srt-pop-title' }, '智能路由'),
          h('div', { className: 'srt-pop-sub' }, '渠道报错自动切换下一家（含 4xx）。停用后模型请求直连默认渠道。'),
          !view.ready
            ? h('div', { className: 'srt-status' }, view.unavailable ? '路由设置不可用：smart-route 命名空间未暴露给配置客户端' : '设置加载中…')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
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
                    h('span', { className: 'srt-label' }, '链内渠道'),
                    h('span', { className: 'srt-badge' }, entries.length + ' 个'),
                  ),
                ),
                entries.length > 0
                  ? h('div', { className: 'srt-row' },
                      h('div', { className: 'srt-row-head' }, h('span', { className: 'srt-label' }, '渠道顺序')),
                      entries.map((e, i) =>
                        h('div', { className: 'srt-cool', key: i },
                          (i + 1) + '. ' + (e.provider || '') + (e.baseUrl ? ' @ ' + e.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '') + ' — ' + (e.model || ''))),
                    )
                  : h('div', { className: 'srt-row' }, h('div', { className: 'srt-row-head' }, h('span', { className: 'srt-label' }, '当前链无渠道'))),
              ),
          h('div', { className: 'srt-status' }, busy ? '处理中…' : ''),
        ) : null,
      )
    }

    // 辅助：从 useSyncExternalStore 返回的 snapshot 读取视图
    function readSnapshotFrom(snap) {
      const status = snap && snap.status
      const value = snap && snap.status === 'ready' && snap.value && typeof snap.value === 'object' ? snap.value : null
      return {
        status,
        ready: status === 'ready',
        unavailable: status === 'unavailable',
        enabled: !!(value && value.enabled !== false),
        defaultChain: (value && value.defaultChain) || 'default',
        chains: (value && value.chains) || {},
      }
    }

    // ── 设置卡 ───────────────────────────────────────────────────────
    function SettingsCard(props) {
      const scope = props.scope
      const [open, setOpen] = useState(false)
      const [editChain, setEditChain] = useState('')
      const [draft, setDraft] = useState(null)
      const [newChainName, setNewChainName] = useState('')
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState('')

      const bound = React.useMemo(() => ({
        subscribe: scope.subscribe.bind(scope),
        getSnapshot: scope.getSnapshot.bind(scope),
      }), [scope])
      const subscribe = useCallback((cb) => bound.subscribe(cb), [bound])
      const getSnap = useCallback(() => bound.getSnapshot(), [bound])
      let snap
      try { snap = useSyncExternalStore(subscribe, getSnap) } catch (e) { snap = bound.getSnapshot() }
      const view = readSnapshotFrom(snap)
      const ready = view.ready

      const chains = view.chains || {}
      const chainNames = Object.keys(chains)
      const defaultChain = view.defaultChain || (chainNames[0] || 'default')
      const activeChain = editChain !== '' ? editChain : defaultChain

      const editingName = draft !== null ? draft.name : activeChain
      const editingEntries = draft !== null ? draft.entries : ((chains[editingName] || [])).map((e) => ({ ...e }))
      const dirty = draft !== null

      const startDraft = () => {
        if (draft !== null) return
        setFailed('')
        setDraft({ name: activeChain, entries: (chains[activeChain] || []).map((e) => ({ ...e })) })
      }
      const updateEntry = (index, patch) => {
        startDraft()
        setFailed('')
        setDraft((prev) => {
          const entries = prev.entries.map((e, i) => (i === index ? { ...e, ...patch } : e))
          return { ...prev, entries }
        })
      }
      const addEntry = () => {
        startDraft()
        setFailed('')
        setDraft((prev) => ({ ...prev, entries: [...prev.entries, { provider: '', model: '' }] }))
      }
      const removeEntry = (index) => {
        startDraft()
        setFailed('')
        setDraft((prev) => ({ ...prev, entries: prev.entries.filter((_e, i) => i !== index) }))
      }
      const moveEntry = (index, dir) => {
        startDraft()
        setFailed('')
        setDraft((prev) => {
          const list = [...prev.entries]
          const target = index + dir
          if (target < 0 || target >= list.length) return prev
          const [moved] = list.splice(index, 1)
          list.splice(target, 0, moved)
          return { ...prev, entries: list }
        })
      }
      const resetDraft = () => { setDraft(null); setFailed('') }

      const saveChain = () => {
        if (draft === null) return
        const entries = draft.entries
        const bad = entries.find((e) => !(e.provider || '').trim() || !(e.model || '').trim())
        if (bad) { setFailed('渠道的 provider 与 model 不能为空（可删除该渠道或留空整条链）'); return }
        setSaving(true)
        setFailed('')
        const nextChains = { ...(chains || {}) }
        nextChains[draft.name] = entries.map((e) => {
          const out = { provider: String(e.provider || '').trim(), model: String(e.model || '').trim() }
          if (e.baseUrl && String(e.baseUrl).trim()) out.baseUrl = String(e.baseUrl).trim()
          if (e.apiKeyEnv && String(e.apiKeyEnv).trim()) out.apiKeyEnv = String(e.apiKeyEnv).trim()
          return out
        })
        Promise.all([
          scope.set('chains', nextChains),
          scope.set('defaultChain', draft.name),
        ]).then(() => {
          setSaving(false)
          resetDraft()
        }).catch((e) => { setSaving(false); setFailed('保存失败：' + String(e && e.message || e)) })
      }

      const addChain = () => {
        const name = newChainName.trim()
        if (!name) return
        if (name in chains) { setFailed('链 "' + name + '" 已存在'); return }
        const nextChains = { ...(chains || {}) }
        nextChains[name] = [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }]
        Promise.resolve(scope.set('chains', nextChains)).then(() => {
          setNewChainName('')
          setEditChain(name)
          setDraft(null)
        }).catch((e) => setFailed('新建失败：' + String(e && e.message || e)))
      }
      const removeChain = (name) => {
        const nextChains = { ...(chains || {}) }
        if (!(name in nextChains)) return
        if (Object.keys(nextChains).length <= 1) { setFailed('至少保留一条链'); return }
        delete nextChains[name]
        const nextDefault = (defaultChain === name ? Object.keys(nextChains)[0] : defaultChain)
        Promise.all([
          scope.set('chains', nextChains),
          scope.set('defaultChain', nextDefault),
        ]).then(() => {
          setEditChain('')
          setDraft(null)
        }).catch((e) => setFailed('删除失败：' + String(e && e.message || e)))
      }
      const setDefault = (name) => {
        Promise.resolve(scope.set('defaultChain', name))
          .catch((e) => setFailed('切换失败：' + String(e && e.message || e)))
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
              '供应商自动路由：渠道报错自动切换下一家（含 4xx）· 对话栏一键启用/停用 · 多链管理 · 渠道级 URL'),
          ),
          h2('span', { className: 'srt-card-chevron' + (open ? ' srt-card-chevron-open' : '') }, '▾'),
        ),
        open ? h2('div', { className: 'srt-card-body' },
          !ready
            ? h2('div', { className: 'srt-field' }, h2('p', { className: 'srt-hint' }, ready === false && view.unavailable ? '路由设置不可用：smart-route 命名空间未暴露给配置客户端' : '设置加载中…'))
            : h2('div', null,
                h2('div', { className: 'srt-field' },
                  h2('div', { className: 'srt-field-head' }, h2('span', { style: { fontWeight: 600, fontSize: 13 } }, '链管理')),
                  h2('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h2('select', {
                      className: 'srt-input', style: { flex: '1 1 160px' }, value: activeChain,
                      onChange: (e) => { setEditChain(e.target.value); setDraft(null); setFailed('') },
                    },
                      chainNames.map((name) =>
                        h2('option', { value: name, key: name }, name + (name === defaultChain ? '（默认）' : ''))),
                    ),
                    h2('button', {
                      type: 'button', className: 'srt-btn2', disabled: chainNames.length <= 1,
                      onClick: () => removeChain(activeChain),
                    }, '删除此链'),
                    h2('button', {
                      type: 'button', className: 'srt-btn2', disabled: activeChain === defaultChain,
                      onClick: () => setDefault(activeChain),
                    }, '设为默认'),
                  ),
                  h2('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
                    h2('input', {
                      className: 'srt-input', placeholder: '新链名称（如 paid）', value: newChainName,
                      onChange: (e) => setNewChainName(e.target.value),
                    }),
                    h2('button', { type: 'button', className: 'srt-btn2', disabled: !newChainName.trim(), onClick: addChain }, '+ 新建链'),
                  ),
                  h2('p', { className: 'srt-hint' }, '链是渠道的有序回退序列。默认链用于新会话；可建多条链并在面板/设置里切换。'),
                ),
                h2('div', { className: 'srt-field' },
                  h2('div', { className: 'srt-field-head' }, h2('span', { style: { fontWeight: 600, fontSize: 13 } }, '链「' + editingName + '」的渠道顺序')),
                  (editingEntries || []).map((entry, index) =>
                    h2('div', { key: index, style: { display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 8 } },
                      h2('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        h2('span', { style: { flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', width: 16 } }, (index + 1) + '.'),
                        h2('input', {
                          className: 'srt-input', style: { flex: '1 1 140px' }, placeholder: 'provider', value: entry.provider,
                          onChange: (e) => updateEntry(index, { provider: e.target.value }),
                        }),
                        h2('input', {
                          className: 'srt-input', style: { flex: '1 1 140px' }, placeholder: 'model', value: entry.model,
                          onChange: (e) => updateEntry(index, { model: e.target.value }),
                        }),
                        h2('button', { type: 'button', className: 'srt-iconBtn', title: '上移', disabled: index === 0, onClick: () => moveEntry(index, -1) }, '↑'),
                        h2('button', { type: 'button', className: 'srt-iconBtn', title: '下移', disabled: index === (editingEntries || []).length - 1, onClick: () => moveEntry(index, 1) }, '↓'),
                        h2('button', { type: 'button', className: 'srt-iconBtn', title: '移除', onClick: () => removeEntry(index) }, '✕'),
                      ),
                      h2('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        h2('input', {
                          className: 'srt-input', style: { flex: '1 1 220px' }, placeholder: 'baseUrl（可选，如 https://api.example.com/v1；留空复用注册 provider）', value: entry.baseUrl || '',
                          onChange: (e) => updateEntry(index, { baseUrl: e.target.value }),
                        }),
                        h2('input', {
                          className: 'srt-input', style: { flex: '1 1 180px' }, placeholder: 'apiKeyEnv（可选，环境变量名）', value: entry.apiKeyEnv || '',
                          onChange: (e) => updateEntry(index, { apiKeyEnv: e.target.value }),
                        }),
                      ),
                    ),
                  ),
                  h2('button', { type: 'button', className: 'srt-btn2', onClick: addEntry }, '+ 添加渠道'),
                  h2('p', { className: 'srt-hint' },
                    'provider 为 DSH 已注册路由（如 deepseek-official、yunzhou、mze）时留空 baseUrl 即可复用；填了 baseUrl 则走内置 OpenAI 兼容调用（可选 apiKeyEnv 提供密钥）。从上到下尝试，任一渠道报错（含 4xx）自动切下一家。允许空链（保存后该链无渠道可用）。'),
                ),
                h2('div', { className: 'srt-footer' },
                  failed ? h2('p', { className: 'srt-err' }, failed) : null,
                  h2('button', { type: 'button', className: 'srt-btn2', disabled: !dirty || saving, onClick: resetDraft }, '放弃修改'),
                  h2('button', { type: 'button', className: 'srt-btn2 srt-btn2-save', disabled: !dirty || saving, onClick: saveChain }, saving ? '保存中…' : '保存'),
                ),
              ),
        ) : null,
      )
    }

    // ── apply ────────────────────────────────────────────────────────
    function apply(ctx) {
      installStyles()
      // decode 直接接受 Host 返回的 section，跳过 client 端 schema 重建校验
      // （Host schema 含 dict/array 嵌套，client rehydrateSchema 可能无法还原）。
      const scope = ctx.settingsScope.bind({
        namespace: 'smart-route',
        decode: (section) => (typeof section === 'object' && section !== null ? section : undefined),
      })

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'dsh-smart-route',
        order: 15,
        label: '智能路由',
        inject: () => ({ scope }),
      }, (props) => h(ComposerButton, Object.assign({}, props, { scope }))))

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        id: 'dsh-smart-route',
        order: 45,
        label: '智能路由',
        inject: () => ({ scope }),
      }, (props) => h(SettingsCard, Object.assign({}, props, { scope }))))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

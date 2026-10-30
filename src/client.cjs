// Client half of dsh-ps-preflight: the 预检 Tab in the conversation view.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness (esbuild marks it external). The one
// relative require below (the stylesheet) is replaced by a CSS string literal
// in scripts/build.mjs, so do not add any other relative require here.

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-ps-preflight'
const POLL_MS = 1000

// One module-level poller shared by every mounted view. The host half owns the
// state; this side only renders what /state reports. A failed request keeps the
// previous snapshot and surfaces an error bar instead of blanking the panel.
let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      // One bad subscriber must not stop the poll.
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-ps-preflight] listener failed', error)
    }
  })
}

function load() {
  fetch(API + '/state', { headers: { accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    })
    .then(function (data) {
      snap = { data: data, error: '', at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function post(path, body) {
  return fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (res) {
    return res.text().then(function (text) {
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch (error) {
          data = null
        }
      }
      if (!res.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + res.status)
      return data || {}
    })
  })
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

// ---------------------------------------------------------------------------
// Defensive rendering helpers: every field may be missing while the host half
// is still starting up.
// ---------------------------------------------------------------------------

const TIER_LABEL = { none: '无风险', low: '低风险', medium: '中风险', high: '高风险' }
const TIERS = ['none', 'low', 'medium', 'high']

const CATEGORY_LABEL = {
  delete: '删除',
  overwrite: '覆盖',
  download: '网络下载',
  credential: '凭据',
  execute: '动态执行',
  system: '系统改动',
  privilege: '权限改动',
}

const DECISION = {
  pass: { label: '放行', tone: 'muted' },
  watch: { label: '留意', tone: 'medium' },
  audit: { label: '仅记录', tone: 'muted' },
  allow: { label: '已确认', tone: 'good' },
  deny: { label: '已拒绝', tone: 'bad' },
  ask: { label: '转审批', tone: 'medium' },
  confirm: { label: '待确认', tone: 'medium' },
  // A command waiting in the queue is already in the audit log as `pending`;
  // it must not fall through to the raw value.
  pending: { label: '等待确认', tone: 'medium' },
  degraded: { label: '检查失败', tone: 'muted' },
}

function arr(value) {
  return Array.isArray(value) ? value : []
}

function str(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

function num(value) {
  const n = Number(value)
  return isFinite(n) ? n : 0
}

function tierOf(value) {
  return TIERS.indexOf(value) >= 0 ? value : ''
}

function categoryOf(value) {
  return CATEGORY_LABEL[value] || ''
}

function summaryOf(report) {
  const summary = str(report && report.summary)
  if (summary) return summary
  return arr(report && report.categories)
    .map(function (c) { return categoryOf(c) || str(c) })
    .filter(Boolean)
    .join(' · ')
}

function verdictFor(tier, mode) {
  if (tier === 'high') return mode === 'audit' ? '仅记录模式：会记下来，但不拦' : '执行前会要求人工确认'
  if (tier === 'medium') return '会记录但不拦'
  if (tier === 'low' || tier === 'none') return '无风险特征'
  return '未能分级'
}

function toMs(value) {
  if (typeof value === 'number' && isFinite(value)) return value
  const n = Number(value)
  if (isFinite(n) && n > 0) return n
  const parsed = Date.parse(str(value))
  return isFinite(parsed) ? parsed : 0
}

function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

function clock(value) {
  const ms = toMs(value)
  if (!ms) return '--:--:--'
  const d = new Date(ms)
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

function sizeText(bytes) {
  return (num(bytes) / 1024).toFixed(1) + ' KB'
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function TierBadge(props) {
  const tier = tierOf(props.tier)
  return h('span', { className: 'ps-badge ' + (tier ? 'ps-tone-' + tier : 'ps-tone-muted') },
    tier ? TIER_LABEL[tier] : '未知',
  )
}

function DecisionBadge(props) {
  const decision = str(props.decision)
  const info = DECISION[decision] || { label: decision || '—', tone: 'muted' }
  return h('span', { className: 'ps-badge ps-tone-' + info.tone }, info.label)
}

function Stat(props) {
  return h('div', { className: 'ps-stat' + (props.tone ? ' ' + props.tone : '') },
    h('b', null, String(num(props.value))),
    h('span', null, props.label),
  )
}

function Findings(props) {
  const list = arr(props.findings)
  if (list.length === 0) return null
  const limit = props.limit === undefined ? 6 : props.limit
  const shown = list.slice(0, limit)
  return h('div', { className: 'ps-findings' },
    shown.map(function (finding, i) {
      const f = finding || {}
      const label = str(f.label) || categoryOf(f.category) || str(f.id) || '命中'
      const evidence = str(f.evidence)
      return h('div', { className: 'ps-finding', key: i },
        h('span', { className: 'ps-finding-label' }, label),
        evidence ? h('code', { className: 'ps-mono ps-evidence' }, evidence) : null,
      )
    }),
    list.length > shown.length
      ? h('div', { className: 'ps-more' }, '另有 ' + (list.length - shown.length) + ' 条命中')
      : null,
  )
}

function PendingCard(props) {
  const p = props.p || {}
  const tier = tierOf(p.tier)
  const summary = str(p.summary) || arr(p.categories).map(categoryOf).filter(Boolean).join(' · ')
  const deadline = toMs(p.deadline)
  let countdown = ''
  if (deadline) {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    countdown = remaining > 0 ? '剩 ' + remaining + ' 秒' : '已超时'
  }
  const busy = props.busy
  return h('div', { className: 'ps-pend' + (tier === 'high' ? ' ps-pend--high' : '') },
    h('div', { className: 'ps-pend-head' },
      h(TierBadge, { tier: p.tier }),
      summary ? h('span', { className: 'ps-pend-sum' }, summary) : null,
      countdown ? h('span', { className: 'ps-count' }, countdown) : null,
    ),
    h('div', { className: 'ps-pend-cmd ps-mono' }, str(p.command) || '(空命令)'),
    h(Findings, { findings: p.findings, limit: 4 }),
    h('div', { className: 'ps-pend-foot' },
      h('button', {
        className: 'ps-btn ps-btn--quiet',
        type: 'button',
        disabled: busy,
        onClick: function () { props.onDecide(str(p.id), false) },
      }, '拒绝'),
      h('button', {
        className: 'ps-btn ps-btn--primary',
        type: 'button',
        disabled: busy,
        onClick: function () { props.onDecide(str(p.id), true) },
      }, busy ? '处理中…' : '确认执行'),
    ),
  )
}

function RecentRow(props) {
  const d = props.d || {}
  const decision = str(d.decision)
  const categories = arr(d.categories).map(function (c) { return categoryOf(c) || str(c) }).filter(Boolean)
  return h('div', { className: 'ps-row' + (decision === 'deny' ? ' ps-row--deny' : '') },
    h('div', { className: 'ps-row-top' },
      h('span', { className: 'ps-time' }, clock(d.at)),
      h(TierBadge, { tier: d.tier }),
      categories.length > 0
        ? h('span', { className: 'ps-cats' }, categories.map(function (label, i) {
          return h('span', { className: 'ps-cat', key: i }, label)
        }))
        : null,
      h(DecisionBadge, { decision: d.decision }),
    ),
    h('div', { className: 'ps-cmd ps-mono', title: str(d.command) }, str(d.command) || '(空命令)'),
    d.reason ? h('div', { className: 'ps-reason' }, str(d.reason)) : null,
  )
}

// ---------------------------------------------------------------------------
// "试一试" — local, one-shot analysis. It only grades; it never executes.
// ---------------------------------------------------------------------------

function TryCard() {
  const [command, setCommand] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const [report, setReport] = React.useState(null)
  const [mode, setMode] = React.useState('')
  const [decision, setDecision] = React.useState('')
  const [error, setError] = React.useState('')

  function run() {
    const text = command.trim()
    if (running) return
    if (!text) {
      setError('先写一条 PowerShell 命令')
      return
    }
    setRunning(true)
    setError('')
    setReport(null)
    setMode('')
    setDecision('')
    post('/analyze', { command: text })
      .then(function (data) {
        const next = data && data.report ? data.report : null
        setReport(next)
        setMode(str(data && data.mode))
        setDecision(str(data && data.decision))
        if (!next) setError('host 没有返回分级结果')
      })
      .catch(function (err) {
        setError(String((err && err.message) || err))
      })
      .then(function () {
        setRunning(false)
      })
  }

  const tier = tierOf(report && report.tier)
  const summary = summaryOf(report)
  const verdict = verdictFor(tier, mode)
  const score = report ? num(report.score) : 0

  return h('div', { className: 'ps-card' },
    h('div', { className: 'ps-card-head' },
      h('h4', { className: 'ps-card-title' }, '试一试'),
      h('span', { className: 'ps-hint' }, '粘贴一条命令，看它会被判成什么'),
    ),
    h('textarea', {
      className: 'ps-input ps-mono',
      'aria-label': '待预检的 PowerShell 命令',
      placeholder: 'Remove-Item -Recurse -Force D:\\Projects\\old-build',
      value: command,
      spellCheck: false,
      rows: 3,
      onChange: function (event) { setCommand(event.target.value) },
      onKeyDown: function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          run()
        }
      },
    }),
    h('div', { className: 'ps-try-foot' },
      h('span', { className: 'ps-try-note' }, '只判分级，不执行'),
      h('button', {
        className: 'ps-btn ps-btn--primary',
        type: 'button',
        disabled: running,
        onClick: run,
      }, running ? '检测中…' : '预检'),
    ),
    error ? h('div', { className: 'ps-err ps-try-err', role: 'alert' }, '预检失败：' + error) : null,
    report ? h('div', { className: 'ps-result' },
      h('div', { className: 'ps-result-head' },
        h(TierBadge, { tier: report.tier }),
        summary ? h('span', { className: 'ps-summary' }, summary) : null,
        h('span', { className: 'ps-score' }, '评分 ' + String(score)),
        decision ? h(DecisionBadge, { decision: decision }) : null,
      ),
      str(report.escalated) ? h('div', { className: 'ps-escalated' }, '升级判定：' + str(report.escalated)) : null,
      h(Findings, { findings: report.findings, limit: 8 }),
      h('div', { className: 'ps-verdict' }, '结论：' + verdict),
      report.truncated ? h('div', { className: 'ps-hint' }, '命令过长，只分析了前一部分') : null,
    ) : null,
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function PreflightView() {
  const [state, setState] = React.useState(snap)
  React.useEffect(function () { return subscribe(setState) }, [])

  const [busyId, setBusyId] = React.useState('')
  const [actionError, setActionError] = React.useState('')

  const data = state.data
  const stats = (data && data.stats) || {}
  const pending = arr(data && data.pending)
  const recent = arr(data && data.recent)
  const connected = Boolean(data)
  const rawMode = str(data && data.mode)
  const mode = rawMode === 'audit' ? 'audit' : 'enforce'
  const modeLabel = !connected ? '未连接' : rawMode === 'audit' ? '仅记录' : rawMode === 'enforce' ? '拦截模式' : '未知模式'
  const modeTone = !connected || !rawMode ? 'muted' : mode === 'audit' ? 'muted' : 'low'

  function decide(id, allow) {
    if (busyId) return
    setBusyId(id)
    setActionError('')
    post('/confirm', { id: id, allow: allow })
      .then(function (result) {
        if (result && result.ok === false) throw new Error(str(result.error) || '确认失败')
        load()
      })
      .catch(function (error) {
        setActionError(String((error && error.message) || error))
      })
      .then(function () {
        setBusyId('')
      })
  }

  function clearAll() {
    setActionError('')
    post('/clear', {})
      .then(function (result) {
        if (result && result.ok === false) throw new Error(str(result.error) || '清空失败')
        load()
      })
      .catch(function (error) {
        setActionError(String((error && error.message) || error))
      })
  }

  const auditPath = str(data && data.auditPath)
  const auditBytes = num(data && data.auditBytes)

  return h('div', { className: 'ps-root' },
    h('div', { className: 'ps-head' },
      h('div', { className: 'ps-head-main' },
        h('div', { className: 'ps-title' }, '命令预检'),
        h('div', { className: 'ps-sub' }, '每条 PowerShell 命令在执行前分级；高风险要你点一次确认'),
      ),
      h('div', { className: 'ps-head-actions' },
        h('span', { className: 'ps-badge ps-mode ps-tone-' + modeTone + (mode === 'audit' && connected ? ' ps-mode--audit' : '') }, modeLabel),
        h('button', { className: 'ps-btn ps-btn--quiet', type: 'button', onClick: clearAll }, '清空'),
      ),
    ),
    state.error
      ? h('div', { className: 'ps-err', role: 'alert' }, '与 host 通信失败：' + state.error)
      : null,
    actionError
      ? h('div', { className: 'ps-err', role: 'alert' }, '操作失败：' + actionError)
      : null,
    h('div', { className: 'ps-stats' },
      h(Stat, { label: '检查', value: stats.examined }),
      h(Stat, { label: '高风险', value: stats.high, tone: 'ps-stat--bad' }),
      h(Stat, { label: '已确认', value: stats.confirmed, tone: 'ps-stat--good' }),
      h(Stat, { label: '已拒绝', value: stats.denied, tone: 'ps-stat--bad' }),
      h(Stat, { label: '网络下载', value: stats.downloads }),
      h(Stat, { label: '凭据', value: stats.credentials }),
    ),
    pending.length > 0
      ? h('div', { className: 'ps-section' },
        h('div', { className: 'ps-section-head' },
          h('span', { className: 'ps-section-title' }, '待确认'),
          h('span', { className: 'ps-hint' }, pending.length + ' 条命令在等你的决定'),
        ),
        h('div', { className: 'ps-pend-list' }, pending.map(function (item, i) {
          const p = item || {}
          return h(PendingCard, {
            key: str(p.id) || String(i),
            p: p,
            busy: busyId === str(p.id),
            onDecide: decide,
          })
        })),
      )
      : null,
    h(TryCard),
    h('div', { className: 'ps-card' },
      h('div', { className: 'ps-card-head' },
        h('h4', { className: 'ps-card-title' }, '最近记录'),
        recent.length > 0 ? h('span', { className: 'ps-hint' }, '共 ' + recent.length + ' 条') : null,
      ),
      recent.length === 0
        ? h('div', { className: 'ps-empty' }, connected ? '暂无记录。执行 PowerShell 命令后，判定会出现在这里。' : 'host 还没连上，暂时没有记录。')
        : h('div', { className: 'ps-recent' }, recent.map(function (d, i) {
          return h(RecentRow, { key: str(d && d.at) + '-' + i, d: d })
        })),
    ),
    h('div', { className: 'ps-foot' },
      h('span', null, '审计日志'),
      h('span', { className: 'ps-path ps-mono' }, auditPath || '(host 未提供)'),
      h('span', { className: 'ps-foot-sep' }, '·'),
      h('span', null, sizeText(auditBytes)),
    ),
  )
}

function apply(ctx) {
  // The shared poll lives at module scope and therefore outlives one apply();
  // unmounting the view is not guaranteed on unload, so it needs an explicit
  // disposer that clears the timer, the subscribers and the snapshot together.
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-ps-preflight'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // Guarded, and normalised to always hand Cordis a disposer: a changed slot
  // contract must degrade this one panel and say so, not abort the client boot
  // for every other plugin in the graph.
  ctx.effect(function () {
    return ctx.slots.inject('conversation.view', function () {
      let disposeView
      try {
        disposeView = ctx.slots.register(
          { name: 'conversation.view', id: 'ps-preflight', order: 30, label: '预检' },
          PreflightView,
        )
      } catch (error) {
        disposeView = undefined
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-ps-preflight] could not register the 预检 view; grading still runs on the host', error)
        }
      }
      return typeof disposeView === 'function' ? disposeView : function () {}
    })
  })
}

module.exports = {
  name: 'dsh-ps-preflight',
  inject: ['slots'],
  apply: apply,
}

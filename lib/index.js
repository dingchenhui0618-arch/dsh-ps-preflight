// Host half of dsh-ps-preflight.
//
// Wires into the one hook point DeepSeek Harness offers plugins before a tool
// runs:
//
//   tools/pre-execute  ->  { kind: 'allow' } | { kind: 'deny', reason } | { kind: 'ask' }
//
// Every PowerShell command that reaches the hook is graded by src/analyze.js
// and written to a local JSONL audit log. The top tier ("high") has to be
// confirmed by a human before it runs, through one of two channels:
//
//   panel -> the 预检 tab in the conversation view shows the command and two
//            buttons; the hook waits for the click (or a timeout).
//   ask   -> the harness' own approval dialog.
//
// "auto" (the default) uses the panel while somebody is actually watching it
// and falls back to the approval dialog otherwise. The approval dialog is
// subject to the session's approval policy: under `never` it fails closed, so a
// high-risk command is denied rather than silently allowed. That is the
// intended reading of "high risk must be confirmed".
//
// Everything else fails open: a grader bug, an unwritable audit file, a panel
// that never registered — none of them may stop ordinary work.

import { appendFileSync, renameSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { analyze, redact } from './analyze.js'

export const name = 'dsh-ps-preflight'
export const inject = ['webServer']

const AUDIT_FILENAME = 'ps-preflight-audit.jsonl'
const MAX_RECENT = 80
const STATE_ROWS = 60
const MAX_BODY = 1048576
const DEFAULT_MAX_AUDIT_BYTES = 2 * 1024 * 1024
const DEFAULT_TOOLS = ['pwsh', 'powershell']

function pluginVersion() {
  try {
    const localRequire = createRequire(import.meta.url)
    const pkg = localRequire('../package.json')
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch (error) {
    return '0.0.0'
  }
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > MAX_BODY) req.destroy()
    })
    req.on('end', function () {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', function () {
      resolve({})
    })
  })
}

function methodFromUrl(url) {
  const path = String(url || '').split('?')[0]
  const rest = path.replace(/^\/dsh-ps-preflight\/?/, '')
  return rest || 'state'
}

function safeString(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Pull the PowerShell source out of a tool call. The pwsh tool passes
 * `{ command }`; a couple of wrappers pass the arguments as a JSON string, so
 * both shapes are accepted. Anything else is "not a shell call" and passes
 * through untouched.
 */
export function commandOf(exec) {
  const args = exec === undefined || exec === null ? undefined : exec.arguments
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (trimmed.length === 0) return undefined
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed.command === 'string') return parsed.command
      } catch (error) {
        return args
      }
    }
    return args
  }
  if (args && typeof args === 'object') {
    for (const key of ['command', 'script', 'cmd', 'line']) {
      if (typeof args[key] === 'string') return args[key]
    }
    if (args.input && typeof args.input === 'object' && typeof args.input.command === 'string') return args.input.command
  }
  return undefined
}

function excerpt(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const home = typeof settings.dshHome === 'string' ? settings.dshHome : dshHome()
  const auditPath = typeof settings.auditPath === 'string' ? settings.auditPath : join(home, AUDIT_FILENAME)
  const mode = settings.mode === 'audit' ? 'audit' : 'enforce'
  const confirmMode = settings.confirmMode === 'panel' || settings.confirmMode === 'ask' ? settings.confirmMode : 'auto'
  const confirmTimeoutMs = Number.isFinite(settings.confirmTimeoutMs) && settings.confirmTimeoutMs > 0
    ? settings.confirmTimeoutMs
    : 120000
  const panelWindowMs = Number.isFinite(settings.panelWindowMs) && settings.panelWindowMs >= 0
    ? settings.panelWindowMs
    : 8000
  const maxAuditBytes = Number.isFinite(settings.maxAuditBytes) && settings.maxAuditBytes > 0
    ? settings.maxAuditBytes
    : DEFAULT_MAX_AUDIT_BYTES
  const tools = new Set(
    (Array.isArray(settings.tools) ? settings.tools : DEFAULT_TOOLS)
      .filter((entry) => typeof entry === 'string' && entry.length > 0)
      .map((entry) => entry.toLowerCase()),
  )
  const version = pluginVersion()

  const stats = {
    examined: 0, high: 0, medium: 0, low: 0, none: 0,
    confirmed: 0, denied: 0, pending: 0, downloads: 0, credentials: 0,
  }
  const recent = []
  const pending = new Map()
  let lastStatePoll = 0
  let closed = false

  /** Someone is looking at the 预检 tab if it polled within the window. */
  function panelActive() {
    return Date.now() - lastStatePoll < panelWindowMs
  }

  function newId() {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  function appendAudit(entry) {
    const line = JSON.stringify(entry) + '\n'
    try {
      const info = statSync(auditPath)
      if (info.size > maxAuditBytes) renameSync(auditPath, auditPath + '.1')
    } catch (error) {
      // Missing file is the normal first-write case.
    }
    try {
      appendFileSync(auditPath, line)
    } catch (error) {
      // An unwritable audit log must never affect a tool call.
    }
  }

  function record(entry) {
    if (typeof entry.id !== 'string') entry.id = newId()
    recent.push(entry)
    if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT)
    appendAudit({
      at: new Date(entry.at).toISOString(),
      id: entry.id,
      tool: entry.tool,
      tier: entry.tier,
      score: entry.score,
      categories: entry.categories,
      decision: entry.decision,
      reason: entry.reason,
      mode: mode,
      findings: (entry.findings || []).map((finding) => finding.id),
      command: entry.command,
      ms: entry.ms,
    })
    return entry
  }

  /**
   * A high-risk command that waited for a human gets a second audit line: the
   * first one says what was analyzed and why it needed confirmation, this one
   * says what the human did. `resolutionOf` ties the pair together.
   */
  function recordResolution(entry) {
    appendAudit({
      at: new Date(entry.at).toISOString(),
      id: newId(),
      resolutionOf: entry.id,
      tool: entry.tool,
      tier: entry.tier,
      score: entry.score,
      categories: entry.categories,
      decision: entry.decision,
      reason: entry.reason,
      mode: mode,
      findings: (entry.findings || []).map((finding) => finding.id),
      command: entry.command,
      ms: entry.ms,
    })
  }

  function publicPending() {
    const out = []
    for (const item of pending.values()) out.push(item.entry)
    return out
  }

  /**
   * Park the tool call until a human answers in the panel. Resolves with
   * 'allow' | 'deny' | 'timeout' | 'aborted' and always settles exactly once,
   * including when the plugin is unloaded mid-wait.
   */
  function askPanel(exec, report, command) {
    return new Promise(function (resolve) {
      const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
      const at = Date.now()
      const entry = {
        id: id,
        at: at,
        deadline: at + confirmTimeoutMs,
        tool: safeString(exec.name) || 'pwsh',
        command: excerpt(command, 4000),
        tier: report.tier,
        score: report.score,
        categories: report.categories,
        summary: report.summary,
        findings: report.findings.slice(0, 8),
      }

      let settled = false
      let timer

      function onAbort() {
        settle('aborted')
      }

      function settle(outcome) {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (exec.signal !== undefined && typeof exec.signal.removeEventListener === 'function') {
          try {
            exec.signal.removeEventListener('abort', onAbort)
          } catch (error) {
            // A detached signal is not worth failing a tool call over.
          }
        }
        pending.delete(id)
        resolve(outcome)
      }

      timer = setTimeout(function () {
        settle('timeout')
      }, confirmTimeoutMs)

      if (exec.signal !== undefined && typeof exec.signal.addEventListener === 'function') {
        try {
          exec.signal.addEventListener('abort', onAbort, { once: true })
        } catch (error) {
          // Same here: degrade to timeout.
        }
      }

      pending.set(id, { entry: entry, settle: settle })
    })
  }

  function decide(report) {
    if (mode === 'audit') return 'audit'
    if (report.tier === 'high') return 'confirm'
    if (report.tier === 'medium') return 'watch'
    return 'pass'
  }

  ctx.on('tools/pre-execute', async function (exec, next) {
    const started = Date.now()
    const toolName = safeString(exec && exec.name).toLowerCase()
    if (!tools.has(toolName)) return next()

    let report
    let command
    try {
      command = commandOf(exec)
      if (command === undefined) return next()
      stats.examined = stats.examined + 1
      report = analyze(command)
      if (report.tier === 'high') stats.high = stats.high + 1
      else if (report.tier === 'medium') stats.medium = stats.medium + 1
      else if (report.tier === 'low') stats.low = stats.low + 1
      else stats.none = stats.none + 1
      if (report.categories.indexOf('download') >= 0) stats.downloads = stats.downloads + 1
      if (report.categories.indexOf('credential') >= 0) stats.credentials = stats.credentials + 1
    } catch (error) {
      // The grader itself failed: allow, and say so in the log rather than
      // silently pretending the command was checked.
      try {
        record({
          at: started, tool: toolName, tier: 'none', score: 0, categories: [],
          decision: 'degraded', reason: '分析器异常：' + String((error && error.message) || error),
          command: excerpt(redact(typeof command === 'string' ? command : ''), 300), findings: [], ms: 0,
        })
      } catch (inner) {
        // never let logging break the call
      }
      return next()
    }

    const baseEntry = function (decision, extra) {
      const entry = {
        at: started,
        tool: toolName,
        tier: report.tier,
        score: report.score,
        categories: report.categories,
        summary: report.summary,
        decision: decision,
        command: excerpt(redact(command), 300),
        findings: report.findings.map(function (finding) {
          return {
            category: finding.category, tier: finding.tier, weight: finding.weight,
            id: finding.id, label: finding.label, evidence: redact(finding.evidence),
          }
        }),
        ms: Date.now() - started,
      }
      if (extra !== undefined) {
        if (extra.reason !== undefined) entry.reason = extra.reason
        if (extra.escalated !== undefined) entry.escalated = extra.escalated
      }
      return entry
    }

    const decision = decide(report)
    if (decision !== 'confirm') {
      record(baseEntry(decision))
      return next()
    }

    // High risk from here on.
    if (exec.signal !== undefined && exec.signal.aborted === true) return next()
    if (closed === true) return next()

    const text = '[' + name + '] 高风险命令（' + report.summary + '）：' + (report.findings[0] ? report.findings[0].label : '未标注')
    const usePanel = confirmMode === 'panel' || (confirmMode === 'auto' && panelActive())

    // The analysis line is written before anybody waits, so the command and its
    // verdict are on disk even if the wait never finishes.
    const entry = record(baseEntry(usePanel ? 'pending' : 'ask', { reason: text, escalated: report.escalated }))
    if (!usePanel) {
      return { kind: 'ask', reason: text, displayReason: text }
    }

    stats.pending = stats.pending + 1
    let outcome = 'aborted'
    try {
      outcome = await askPanel(exec, report, command)
    } finally {
      stats.pending = Math.max(0, stats.pending - 1)
    }

    entry.ms = Date.now() - started
    if (outcome === 'allow') {
      stats.confirmed = stats.confirmed + 1
      entry.decision = 'allow'
      recordResolution(entry)
      return next()
    }

    stats.denied = stats.denied + 1
    entry.decision = 'deny'
    entry.reason = outcome === 'timeout'
      ? text + '；等待确认超时，已拒绝'
      : outcome === 'aborted'
        ? text + '；等待确认期间被中断'
        : text + '；用户拒绝执行'
    recordResolution(entry)
    return { kind: 'deny', reason: entry.reason }
  })

  // Pending confirmations are promises inside a tool call: unloading the plugin
  // must settle them, or the call hangs forever.
  ctx.effect(function () {
    return function () {
      closed = true
      const items = Array.from(pending.values())
      for (const item of items) item.settle('aborted')
      pending.clear()
    }
  })

  // The panel is the disposable half. If the route cannot be registered — a
  // changed webServer contract, a host with no web server — the gate itself
  // keeps working, so the failure is contained here.
  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-ps-preflight',
        handler: async function (req, res) {
          try {
            const method = methodFromUrl(req.url)
            if (req.method === 'GET' || method === 'state') {
              lastStatePoll = Date.now()
              let auditBytes = 0
              try {
                auditBytes = statSync(auditPath).size
              } catch (error) {
                auditBytes = 0
              }
              sendJson(res, 200, {
                mode: mode,
                confirmMode: confirmMode,
                version: version,
                auditPath: auditPath,
                auditBytes: auditBytes,
                stats: Object.assign({}, stats),
                pending: publicPending(),
                recent: recent.slice(-STATE_ROWS).reverse(),
              })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const body = await readBody(req)
            if (method === 'analyze') {
              const command = typeof body.command === 'string' ? body.command : ''
              const report = analyze(command)
              sendJson(res, 200, { report: report, decision: decide(report), mode: mode })
              return
            }
            if (method === 'confirm') {
              const id = typeof body.id === 'string' ? body.id : ''
              const item = pending.get(id)
              if (item === undefined) {
                sendJson(res, 404, { ok: false, error: '这条确认已失效' })
                return
              }
              item.settle(body.allow === true ? 'allow' : 'deny')
              sendJson(res, 200, { ok: true })
              return
            }
            if (method === 'clear') {
              recent.length = 0
              sendJson(res, 200, { ok: true })
              return
            }
            sendJson(res, 404, { error: 'unknown method' })
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) })
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })
}

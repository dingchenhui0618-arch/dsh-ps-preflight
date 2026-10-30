// Host-half tests. These drive the real apply() against a stub ctx, so the
// gate's outcomes — allow, watch, ask, panel-confirm, panel-deny, timeout,
// audit-only, degrade — are pinned without a running harness.

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, commandOf } from '../src/host.js'

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'preflight-test-'))
}

function readAudit(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  } catch (error) {
    return []
  }
}

function setup(options) {
  const settings = options || {}
  const listeners = new Map()
  const routes = []
  const disposers = []

  const webServer = {
    register(route) {
      if (settings.registerThrows === true) throw new Error('webServer.register is unavailable')
      routes.push(route)
      if (settings.registerReturnsUndefined === true) return undefined
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  const ctx = {
    webServer: webServer,
    get() {
      return undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
      const dispose = function () {
        if (listeners.get(event) === listener) listeners.delete(event)
      }
      disposers.push(dispose)
      return dispose
    },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
  }

  const home = settings.home || makeHome()
  const config = { dshHome: home }
  for (const key of ['mode', 'confirmMode', 'confirmTimeoutMs', 'panelWindowMs', 'auditPath', 'tools', 'maxAuditBytes']) {
    if (settings[key] !== undefined) config[key] = settings[key]
  }
  apply(ctx, config)

  const auditPath = config.auditPath || join(home, 'ps-preflight-audit.jsonl')

  async function request(method, url, body) {
    const route = routes[0]
    assert.ok(route, 'the route was registered')
    let parsed
    const listenersByEvent = {}
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) {
        parsed = text === undefined || text.length === 0 ? undefined : JSON.parse(text)
      },
    }
    const req = {
      method: method,
      url: url,
      on(event, fn) {
        listenersByEvent[event] = listenersByEvent[event] || []
        listenersByEvent[event].push(fn)
      },
      destroy() {},
    }
    setImmediate(function () {
      if (body !== undefined) for (const fn of listenersByEvent.data || []) fn(JSON.stringify(body))
      for (const fn of listenersByEvent.end || []) fn()
    })
    await route.handler(req, res)
    return { status: res.statusCode, body: parsed }
  }

  return {
    home: home,
    auditPath: auditPath,
    routes: routes,
    listeners: listeners,
    audit() {
      return readAudit(auditPath)
    },
    state() {
      return request('GET', '/dsh-ps-preflight/state')
    },
    post(method, body) {
      return request('POST', '/dsh-ps-preflight/' + method, body || {})
    },
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
    async call(name, args, signal) {
      const listener = listeners.get('tools/pre-execute')
      assert.ok(listener, 'tools/pre-execute listener was registered')
      let nextCalls = 0
      const next = async function () {
        nextCalls = nextCalls + 1
        return { kind: 'allow' }
      }
      const result = await listener({ name: name, arguments: args, callId: 'c1', agent: { id: 'agent-1' }, signal: signal }, next)
      return { result: result, nextCalls: nextCalls }
    },
  }
}

const shell = (command) => ({ command: command })

test('tools that do not run PowerShell are invisible to the gate', async () => {
  const h = setup({})
  for (const name of ['read', 'glob', 'grep', 'write', 'bash']) {
    const out = await h.call(name, shell('Remove-Item -Recurse D:\\x'))
    assert.equal(out.result.kind, 'allow', name)
    assert.equal(out.nextCalls, 1, name)
  }
  assert.deepEqual(h.audit(), [], 'nothing was audited for non-shell tools')
})

test('an ordinary command is allowed and written to the audit log', async () => {
  const h = setup({})
  const out = await h.call('pwsh', shell('git status'))
  assert.equal(out.result.kind, 'allow')
  assert.equal(out.nextCalls, 1)
  const rows = h.audit()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tier, 'none')
  assert.equal(rows[0].decision, 'pass')
  assert.equal(rows[0].tool, 'pwsh')
  assert.equal(rows[0].command, 'git status')
  assert.ok(rows[0].id, 'every audit row has an id')
})

test('a medium-risk command is audited as watch and still runs', async () => {
  const h = setup({})
  const out = await h.call('pwsh', shell('Set-Content D:\\tmp\\a.txt "hello"'))
  assert.equal(out.result.kind, 'allow')
  assert.equal(out.nextCalls, 1)
  const rows = h.audit()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tier, 'medium')
  assert.equal(rows[0].decision, 'watch')
})

test('a high-risk command asks the approval dialog when nobody is watching the panel', async () => {
  const h = setup({})
  const out = await h.call('pwsh', shell('Remove-Item -Recurse -Force D:\\Projects\\old'))
  assert.equal(out.result.kind, 'ask')
  assert.match(out.result.reason, /高风险命令/)
  assert.equal(typeof out.result.displayReason, 'string')
  assert.equal(out.nextCalls, 0, 'the command did not run')
  const rows = h.audit()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tier, 'high')
  assert.equal(rows[0].decision, 'ask')
})

test('a panel confirmation allows the command and records both audit lines', async () => {
  const h = setup({ confirmMode: 'panel' })
  const pending = h.call('pwsh', shell('Remove-Item -Recurse -Force D:\\Projects\\old'))
  await Promise.resolve()

  const state = await h.state()
  assert.equal(state.body.pending.length, 1)
  assert.equal(state.body.stats.pending, 1)
  assert.equal(state.body.pending[0].tier, 'high')
  assert.match(state.body.pending[0].command, /Remove-Item/)

  const answer = await h.post('confirm', { id: state.body.pending[0].id, allow: true })
  assert.equal(answer.body.ok, true)

  const out = await pending
  assert.equal(out.result.kind, 'allow')
  assert.equal(out.nextCalls, 1)

  const after = await h.state()
  assert.equal(after.body.pending.length, 0)
  assert.equal(after.body.stats.confirmed, 1)
  assert.equal(after.body.stats.pending, 0)

  const rows = h.audit()
  assert.equal(rows.length, 2, 'analysis line + resolution line')
  assert.equal(rows[0].decision, 'pending')
  assert.equal(rows[1].decision, 'allow')
  assert.equal(rows[1].resolutionOf, rows[0].id)
})

test('a panel rejection blocks the command with a reason', async () => {
  const h = setup({ confirmMode: 'panel' })
  const pending = h.call('pwsh', shell('Remove-Item -Recurse -Force D:\\Projects\\old'))
  await Promise.resolve()
  const state = await h.state()
  await h.post('confirm', { id: state.body.pending[0].id, allow: false })

  const out = await pending
  assert.equal(out.result.kind, 'deny')
  assert.match(out.result.reason, /用户拒绝/)
  assert.equal(out.nextCalls, 0)

  const after = await h.state()
  assert.equal(after.body.stats.denied, 1)
  const rows = h.audit()
  assert.equal(rows.length, 2)
  assert.equal(rows[1].decision, 'deny')
})

test('an unanswered confirmation times out into a denial', async () => {
  const h = setup({ confirmMode: 'panel', confirmTimeoutMs: 25 })
  const out = await h.call('pwsh', shell('Remove-Item -Recurse -Force D:\\Projects\\old'))
  assert.equal(out.result.kind, 'deny')
  assert.match(out.result.reason, /超时/)
  assert.equal(out.nextCalls, 0)
  const rows = h.audit()
  assert.equal(rows[1].decision, 'deny')
})

test('auto mode uses the panel once the panel has polled', async () => {
  const h = setup({})
  const answer = await h.call('pwsh', shell('git status'))
  assert.equal(answer.nextCalls, 1)
  await h.state()

  const pending = h.call('pwsh', shell('Remove-Item -Recurse -Force D:\\Projects\\old'))
  await Promise.resolve()
  const state = await h.state()
  assert.equal(state.body.pending.length, 1, 'it waited for the panel instead of asking')
  await h.post('confirm', { id: state.body.pending[0].id, allow: true })
  const out = await pending
  assert.equal(out.result.kind, 'allow')
})

test('audit mode never blocks anything', async () => {
  const h = setup({ mode: 'audit' })
  const out = await h.call('pwsh', shell('Remove-Item -Recurse -Force C:\\'))
  assert.equal(out.result.kind, 'allow')
  assert.equal(out.nextCalls, 1)
  const rows = h.audit()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].decision, 'audit')
  const state = await h.state()
  assert.equal(state.body.mode, 'audit')
})

test('the state route summarises counters, categories and recent rows', async () => {
  const h = setup({})
  await h.call('pwsh', shell('git status'))
  await h.call('pwsh', shell('iwr https://example.com/a.ps1 -OutFile a.ps1'))
  await h.call('pwsh', shell('Get-Content C:\\Users\\me\\.ssh\\id_rsa'))
  await h.call('pwsh', shell('Remove-Item -Recurse D:\\x'))

  const state = await h.state()
  assert.equal(state.status, 200)
  assert.equal(state.body.stats.examined, 4)
  assert.equal(state.body.stats.high, 1)
  assert.equal(state.body.stats.medium, 2)
  assert.equal(state.body.stats.downloads, 1)
  assert.equal(state.body.stats.credentials, 1)
  assert.equal(state.body.recent.length, 4)
  assert.equal(state.body.recent[0].tier, 'high', 'newest first')
  assert.ok(state.body.auditPath.endsWith('ps-preflight-audit.jsonl'))
  assert.equal(typeof state.body.version, 'string')
})

test('the analyze route grades a pasted command without running it', async () => {
  const h = setup({})
  const answer = await h.post('analyze', { command: 'Remove-Item -Recurse -Force D:\\Projects\\old' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.report.tier, 'high')
  assert.equal(answer.body.decision, 'confirm')
  assert.ok(answer.body.report.findings.length > 0)
  assert.deepEqual(h.audit(), [], 'a dry run writes no audit line')

  const benign = await h.post('analyze', { command: 'Get-ChildItem C:\\' })
  assert.equal(benign.body.report.tier, 'none')
  assert.equal(benign.body.decision, 'pass')
})

test('an unknown confirmation id is rejected instead of hanging', async () => {
  const h = setup({})
  const answer = await h.post('confirm', { id: 'nope', allow: true })
  assert.equal(answer.status, 404)
  assert.equal(answer.body.ok, false)
})

test('inline secrets never reach the audit file', async () => {
  const h = setup({})
  await h.call('pwsh', shell('Invoke-WebRequest https://x -Headers @{Authorization="Bearer ghp_abcdefghijklmnopqrstuvwxyz0123"}'))
  const rows = h.audit()
  assert.equal(rows.length, 1)
  const raw = JSON.stringify(rows[0])
  assert.ok(!raw.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), raw)
  assert.ok(raw.includes('[redacted]') || raw.includes('[github-token]'), raw)
})

test('an unwritable audit path does not affect the call', async () => {
  const home = makeHome()
  const blocker = join(home, 'not-a-file')
  mkdirSync(blocker)
  const h = setup({ home: home, auditPath: blocker })
  const out = await h.call('pwsh', shell('Remove-Item -Recurse D:\\x'))
  assert.equal(out.result.kind, 'ask', 'the gate still reviewed')
  assert.equal(h.audit().length, 0)
})

test('unloading settles a pending confirmation instead of hanging it', async () => {
  const h = setup({ confirmMode: 'panel' })
  const pending = h.call('pwsh', shell('Remove-Item -Recurse -Force D:\\Projects\\old'))
  await Promise.resolve()
  h.dispose()
  const out = await pending
  assert.equal(out.result.kind, 'deny')
  assert.match(out.result.reason, /中断/)
  assert.equal(h.routes.length, 0)
  assert.equal(h.listeners.size, 0)
})

test('unloading removes both the route and the tool listener', () => {
  const h = setup({})
  assert.equal(h.routes.length, 1)
  assert.ok(h.listeners.get('tools/pre-execute'))
  h.dispose()
  assert.equal(h.routes.length, 0)
  assert.equal(h.listeners.size, 0)
})

test('a webServer that refuses to register does not take the gate down', async () => {
  const h = setup({ registerThrows: true })
  assert.equal(h.routes.length, 0)
  const out = await h.call('pwsh', shell('Remove-Item -Recurse D:\\x'))
  assert.equal(out.result.kind, 'ask', 'the gate still reviews')
})

test('a register() that returns no disposer is tolerated on unload', () => {
  const h = setup({ registerReturnsUndefined: true })
  assert.equal(h.routes.length, 1)
  h.dispose()
  assert.equal(h.listeners.size, 0)
})

test('commandOf accepts every argument shape the harness produces', () => {
  assert.equal(commandOf({ name: 'pwsh', arguments: { command: 'Get-Date' } }), 'Get-Date')
  assert.equal(commandOf({ name: 'pwsh', arguments: '{"command":"Get-Date"}' }), 'Get-Date')
  assert.equal(commandOf({ name: 'pwsh', arguments: 'Get-Date' }), 'Get-Date')
  assert.equal(commandOf({ name: 'pwsh', arguments: { script: 'Get-Date' } }), 'Get-Date')
  assert.equal(commandOf({ name: 'pwsh', arguments: { input: { command: 'Get-Date' } } }), 'Get-Date')
  assert.equal(commandOf({ name: 'pwsh', arguments: {} }), undefined)
  assert.equal(commandOf({ name: 'pwsh', arguments: { command: '' } }), '')
  assert.equal(commandOf({ name: 'pwsh' }), undefined)
  assert.equal(commandOf(undefined), undefined)
})

test('a shell call without a command string is passed through untouched', async () => {
  const h = setup({})
  const out = await h.call('pwsh', {})
  assert.equal(out.result.kind, 'allow')
  assert.equal(out.nextCalls, 1)
  assert.deepEqual(h.audit(), [])
})

test('the audit file rotates instead of growing without bound', async () => {
  const home = makeHome()
  const auditPath = join(home, 'ps-preflight-audit.jsonl')
  writeFileSync(auditPath, 'x'.repeat(2048), 'utf8')
  const h = setup({ home: home, auditPath: auditPath, maxAuditBytes: 1024 })
  await h.call('pwsh', shell('git status'))
  const rotated = readFileSync(auditPath + '.1', 'utf8')
  assert.equal(rotated.length, 2048)
  assert.equal(h.audit().length, 1)
})

test('a grader failure degrades to allow and says so in the log', async () => {
  const h = setup({})
  // A getter that throws inside analysis-equivalent access proves the catch
  // path: the stub replaces JSON serialisation of the arguments with a value
  // whose `command` getter explodes.
  const args = {}
  Object.defineProperty(args, 'command', {
    get() {
      throw new Error('boom')
    },
    enumerable: true,
  })
  const out = await h.call('pwsh', args)
  assert.equal(out.result.kind, 'allow')
  assert.equal(out.nextCalls, 1)
  const rows = h.audit()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].decision, 'degraded')
  assert.match(rows[0].reason, /boom/)
})

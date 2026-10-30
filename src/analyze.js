// Pure analysis of one PowerShell command string: no I/O, no harness access,
// fully unit-testable.
//
// The goal is a *pre-execution* grade, not a sandbox. It answers one question —
// "if the agent runs this, what can it break, and how badly?" — from the command
// text alone, synchronously and in well under a millisecond, so it can sit in
// front of every shell call without being felt.
//
// This is a heuristic tokenizer, not a PowerShell parser. It understands the
// shapes agents actually emit (cmdlets, aliases, parameters, pipelines,
// redirection, subexpressions, nested -Command, -EncodedCommand) and grades the
// ones it recognizes. A command that assembles itself at runtime out of string
// fragments is opaque to any static pass, including this one; the audit log is
// what covers that gap. Do not read a "low" tier as proof of safety.

export const MAX_INPUT = 20000

/** Risk categories, in the order the UI renders them. */
export const CATEGORY_ORDER = ['delete', 'overwrite', 'download', 'credential', 'execute', 'system', 'privilege']

export const CATEGORY_LABELS = {
  delete: '删除',
  overwrite: '覆盖',
  download: '网络下载',
  credential: '凭据',
  execute: '动态执行',
  system: '系统改动',
  privilege: '权限改动',
}

export const TIER_ORDER = ['none', 'low', 'medium', 'high']

export const TIER_LABELS = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
}

const TIER_RANK = { none: 0, low: 1, medium: 2, high: 3 }
const TIER_WEIGHT = { low: 1, medium: 4, high: 10 }

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

const SEPARATORS = new Set([';', '\n', '|', '&&', '||', '{', '}', '&'])

function captureBalanced(src, start) {
  const open = src[start]
  const close = open === '(' ? ')' : open === '{' ? '}' : undefined
  if (close === undefined) return undefined
  let depth = 0
  let quote = ''
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote !== '') {
      if (c === '`' && quote === '"') {
        i++
        continue
      }
      if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return { text: src.slice(start + 1, i), end: i }
    }
  }
  return undefined
}

/**
 * Pull `$( ... )` and `( ... )` bodies out of the text and analyze them as their
 * own commands. `$()` inside a double-quoted string interpolates, so it is
 * extracted there too; single-quoted strings never interpolate.
 */
function extractSubexpressions(src) {
  const inner = []
  let out = ''
  const n = src.length
  let i = 0
  let quote = ''
  while (i < n) {
    const c = src[i]
    if (quote === "'") {
      out += c
      if (c === "'" && src[i + 1] === "'") {
        out += src[i + 1]
        i += 2
        continue
      }
      if (c === "'") quote = ''
      i++
      continue
    }
    if (quote === '"') {
      if (c === '`' && i + 1 < n) {
        out += c + src[i + 1]
        i += 2
        continue
      }
      if (c === '$' && src[i + 1] === '(') {
        const captured = captureBalanced(src, i + 1)
        if (captured !== undefined) {
          inner.push(captured.text)
          out += '$SUB' + inner.length
          i = captured.end + 1
          continue
        }
      }
      out += c
      if (c === '"' && src[i + 1] !== '"') quote = ''
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      out += c
      i++
      continue
    }
    // A bare `(` that follows an identifier is a method/argument list, not a
    // subexpression: `$x.Delete(true)` must keep its `(true)` so the method
    // call stays visible. Only `$(` always extracts.
    const methodCall = c === '(' && i > 0 && /[A-Za-z0-9_$\])]/.test(src[i - 1])

    if (!methodCall && ((c === '$' && src[i + 1] === '(') || c === '(')) {
      const open = c === '$' ? i + 1 : i
      const captured = captureBalanced(src, open)
      if (captured !== undefined) {
        inner.push(captured.text)
        out += ' $SUB' + inner.length + ' '
        i = captured.end + 1
        continue
      }
    }
    out += c
    i++
  }
  return { text: out, inner: inner }
}

function isCommentStart(src, i) {
  if (i === 0) return true
  return /[\s;|&({[]/.test(src[i - 1])
}

/**
 * Turn one command string into word/separator tokens.
 * Word tokens keep their unquoted `text`, the source slice as `raw`, and
 * `quoted` / `interpolated` so literal-only checks can tell a fixed string from
 * a value assembled at runtime.
 */
export function lex(src) {
  const out = []
  const n = src.length
  let i = 0

  function pushWord(text, quoted, start, end, interpolated) {
    out.push({ type: 'word', text: text, quoted: quoted, interpolated: interpolated === true, raw: src.slice(start, end) })
  }

  while (i < n) {
    const c = src[i]

    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\u00a0') {
      i++
      continue
    }
    if (c === '\n') {
      out.push({ type: 'sep', value: '\n' })
      i++
      continue
    }
    if (c === '<' && src[i + 1] === '#') {
      const end = src.indexOf('#>', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (c === '#' && isCommentStart(src, i)) {
      const end = src.indexOf('\n', i)
      i = end < 0 ? n : end
      continue
    }
    if (c === '`' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\r' ? 3 : 2
      continue
    }

    if (c === '@' && (src[i + 1] === "'" || src[i + 1] === '"')) {
      const term = src[i + 1] + '@'
      const end = src.indexOf(term, i + 2)
      if (end < 0) {
        pushWord(src.slice(i + 2), true, i, n)
        i = n
      } else {
        pushWord(src.slice(i + 2, end), true, i, end + 2)
        i = end + 2
      }
      continue
    }

    if (c === "'") {
      let j = i + 1
      let text = ''
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") {
          text += "'"
          j += 2
          continue
        }
        if (src[j] === "'") break
        text += src[j]
        j++
      }
      pushWord(text, true, i, Math.min(j + 1, n), false)
      i = Math.min(j + 1, n)
      continue
    }

    if (c === '"') {
      let j = i + 1
      let text = ''
      let hasVar = false
      while (j < n) {
        const d = src[j]
        if (d === '`' && j + 1 < n) {
          text += src[j + 1]
          j += 2
          continue
        }
        if (d === '$') hasVar = true
        if (d === '"') break
        text += d
        j++
      }
      pushWord(text, true, i, Math.min(j + 1, n), hasVar)
      i = Math.min(j + 1, n)
      continue
    }

    if (c === '2' && src[i + 1] === '>') {
      const op = src[i + 2] === '>' ? '2>>' : '2>'
      out.push({ type: 'sep', value: op })
      i += op.length
      continue
    }
    if (c === '*' && src[i + 1] === '>') {
      out.push({ type: 'sep', value: '*>' })
      i += 2
      continue
    }
    if (c === '>') {
      const op = src[i + 1] === '>' ? '>>' : '>'
      out.push({ type: 'sep', value: op })
      i += op.length
      continue
    }
    if (c === '&' && src[i + 1] === '&') {
      out.push({ type: 'sep', value: '&&' })
      i += 2
      continue
    }
    if (c === '|' && src[i + 1] === '|') {
      out.push({ type: 'sep', value: '||' })
      i += 2
      continue
    }
    if (SEPARATORS.has(c)) {
      out.push({ type: 'sep', value: c })
      i++
      continue
    }

    const start = i
    let text = ''
    while (i < n) {
      const d = src[i]
      if (d === '`' && i + 1 < n) {
        text += src[i + 1]
        i += 2
        continue
      }
      if (/\s/.test(d) || SEPARATORS.has(d) || d === '>') break
      text += d
      i++
    }
    if (text.length > 0) pushWord(text, false, start, i, false)
    else i++
  }

  return out
}

// ---------------------------------------------------------------------------
// Statement assembly
// ---------------------------------------------------------------------------

const REDIRECTIONS = new Set(['>', '>>', '2>', '2>>', '*>'])

export function toStatements(tokens) {
  const statements = []
  let words = []
  let redirs = []
  let pipeline = 0
  let redirOp = null
  // Everything upstream in the current pipeline chain. `{` does not break the
  // chain, so `Get-ChildItem -Recurse | ForEach-Object { Remove-Item }` keeps
  // its source visible to the statement inside the block.
  let chain = []

  function flush() {
    if (words.length === 0 && redirs.length === 0) return
    const text = words.map((w) => w.raw).join(' ') + redirs.map((r) => ' ' + r.op + ' ' + r.target).join('')
    statements.push({
      words: words,
      redirs: redirs,
      pipeline: pipeline,
      pipeFrom: chain.join(' '),
      text: text,
    })
    words = []
    redirs = []
    chain.push(text)
  }

  for (const token of tokens) {
    if (token.type === 'word') {
      if (redirOp !== null) {
        redirs.push({ op: redirOp, target: token.text })
        redirOp = null
        continue
      }
      words.push(token)
      continue
    }
    if (REDIRECTIONS.has(token.value)) {
      redirOp = token.value
      continue
    }
    if (token.value === '|') {
      pipeline++
      flush()
      continue
    }
    flush()
    if (token.value !== '{') {
      chain = []
      pipeline = 0
    }
  }
  flush()
  return statements
}

// ---------------------------------------------------------------------------
// Command name normalization
// ---------------------------------------------------------------------------

const ALIASES = {
  rm: 'remove-item',
  ri: 'remove-item',
  erase: 'remove-item',
  cp: 'copy-item',
  copy: 'copy-item',
  cpi: 'copy-item',
  mv: 'move-item',
  move: 'move-item',
  mi: 'move-item',
  ren: 'rename-item',
  rni: 'rename-item',
  ni: 'new-item',
  md: 'new-item',
  mkdir: 'new-item',
  gc: 'get-content',
  cat: 'get-content',
  gi: 'get-item',
  gci: 'get-childitem',
  ls: 'get-childitem',
  iex: 'invoke-expression',
  iwr: 'invoke-webrequest',
  irm: 'invoke-restmethod',
  curl: 'invoke-webrequest',
  wget: 'invoke-webrequest',
  ac: 'add-content',
  clc: 'clear-content',
  saps: 'start-process',
  start: 'start-process',
}

/** Native executables whose `/x` tokens are switches, not paths. */
const NATIVE = new Set([
  'attrib', 'bcdedit', 'bitsadmin', 'cacls', 'certutil', 'cipher', 'cleanmgr',
  'cmd', 'cmdkey', 'command', 'del', 'diskpart', 'dism', 'format', 'fsutil',
  'icacls', 'manage-bde', 'mountvol', 'net', 'nltest', 'psql', 'mysql', 'sqlcmd',
  'reg', 'regedit', 'rmdir', 'rd', 'robocopy', 'route', 'runas', 'sc',
  'schtasks', 'setx', 'sfc', 'shutdown', 'takeown', 'taskkill', 'tskill',
  'vssadmin', 'wbadmin', 'wevtutil', 'wmic', 'xcopy', 'curl', 'wget',
])

function canonical(word) {
  let name = word.text.trim()
  name = name.replace(/^[.&]\s*/, '')
  if (name.startsWith('"') || name.startsWith("'")) name = name.slice(1, -1)
  const slash = name.lastIndexOf('\\')
  if (slash >= 0 && slash < name.length - 1) name = name.slice(slash + 1)
  name = name.toLowerCase()
  if (name.endsWith('.exe')) name = name.slice(0, -4)
  return ALIASES[name] !== undefined ? ALIASES[name] : name
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  'path', 'literalpath', 'destination', 'outfile', 'filepath', 'uri', 'url',
  'filter', 'include', 'exclude', 'name', 'value', 'command', 'argumentlist',
  'encodedcommand', 'credential', 'inputobject', 'itempath', 'stream', 'encoding',
  'timeoutsec', 'headers', 'body', 'method', 'type', 'property', 'scope', 'verb',
  'template', 'target', 'source', 'output', 'out', 'executionpolicy',
  'erroraction', 'warningaction', 'informationaction', 'progressaction',
  'errorvariable', 'warningvariable', 'informationvariable', 'outvariable',
])

/** Flags whose value is a filesystem target. */
const PATH_FLAGS = new Set([
  'path', 'literalpath', 'destination', 'outfile', 'filepath', 'target', 'source',
  'output', 'out', 'itempath',
])

function splitFlag(text) {
  const colon = text.indexOf(':')
  if (colon > 0) return [text.slice(0, colon).toLowerCase(), text.slice(colon + 1)]
  const eq = text.indexOf('=')
  if (eq > 0) return [text.slice(0, eq).toLowerCase(), text.slice(eq + 1)]
  return [text.toLowerCase(), undefined]
}

function parseParams(statement, native) {
  const flags = []
  const values = new Map()
  const positional = []
  const words = statement.words
  for (let i = 1; i < words.length; i++) {
    const word = words[i]
    const text = word.text
    if (native && text.startsWith('/') && text.length > 1) {
      const parts = splitFlag(text.slice(1))
      flags.push({ name: parts[0], value: parts[1] })
      if (parts[1] !== undefined) values.set(parts[0], parts[1])
      continue
    }
    const isFlag = !native && text.startsWith('-') && text.length > 1 && !/^-\d/.test(text)
    if (isFlag) {
      const parts = splitFlag(text.slice(1))
      const name = parts[0]
      if (name.length === 0) {
        positional.push(text)
        continue
      }
      let value = parts[1]
      if (value === undefined && VALUE_FLAGS.has(name) && i + 1 < words.length && !(words[i + 1].text.startsWith('-') && !/^-\d/.test(words[i + 1].text))) {
        value = words[i + 1].text
        i++
      }
      flags.push({ name: name, value: value })
      if (value !== undefined) values.set(name, value)
      continue
    }
    positional.push(text)
  }
  return { flags: flags, values: values, positional: positional }
}

function isOff(value) {
  if (value === undefined) return false
  const v = String(value).trim().toLowerCase()
  return v === 'false' || v === '0' || v === '$false'
}

/** Match a parameter by canonical name or unambiguous abbreviation. */
export function hasFlag(params, ...names) {
  for (const flag of params.flags) {
    if (isOff(flag.value)) continue
    for (const name of names) {
      if (flag.name === name) return flag
      if (flag.name.length >= 2 && name.startsWith(flag.name)) return flag
    }
  }
  return undefined
}

function flagValue(params, ...names) {
  for (const name of names) {
    if (params.values.has(name)) return params.values.get(name)
  }
  return undefined
}

function allTargets(params) {
  const out = params.positional.slice()
  for (const entry of params.values) {
    if (PATH_FLAGS.has(entry[0])) out.push(entry[1])
  }
  return out.filter((t) => t.length > 0)
}

/** Unix-style short clusters `rm -rf` / `-fr` / `-r -f`. */
function shortClusters(params) {
  return params.flags
    .map((f) => f.name)
    .filter((n) => n.length <= 3 && /^[a-z]+$/.test(n))
}

// ---------------------------------------------------------------------------
// Paths and secrets
// ---------------------------------------------------------------------------

// A path ends at a separator, a space, a quote or the end of the command;
// `Get-Content C:\proj\.env` must match even though nothing follows it.
const SEP = '(?:[\\\\/]|$|\\s)'
const CREDENTIAL_PATH = new RegExp([
  '[.\\\\/]\\.ssh' + SEP, 'id_(rsa|dsa|ecdsa|ed25519)', '[.\\\\/]\\.aws[\\\\/]credentials',
  '[.\\\\/]\\.git-credentials', '[.\\\\/]\\.npmrc', '[.\\\\/]\\.netrc', '[.\\\\/]\\.pgpass',
  '[.\\\\/]\\.dsh[\\\\/](?:\\.?credentials|auth|tokens?|secrets?)', '\\.credentials\\.ya?ml', '[.\\\\/]\\.env(\\.[a-z0-9]+)?' + SEP,
  'AGENTS\\.md', 'credentials?\\.json', 'service[_-]account[^\\\\/]*\\.json', 'wallet\\.dat',
  '[.\\\\/]Login Data', '[.\\\\/]Cookies', '(^|[\\\\/\\s])SAM(?:[\\\\/]|$|\\s)', '(^|[\\\\/\\s])SECURITY(?:[\\\\/]|$|\\s)',
  '\\.(pem|pfx|p12)(\\s|$|["\'])',
].join('|'), 'i')

const INLINE_SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{12,}|(password|passwd|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*\S{4,})/i

const ENV_SECRET = /\$env:[a-z0-9_]*(token|secret|key|password|passwd|credential)/i

export function isRootishPath(target) {
  const t = String(target).replace(/^["']|["']$/g, '').trim()
  if (t.length === 0) return false
  if (/^[a-zA-Z]:[\\/]?$/.test(t)) return true
  if (/^[\\/]$/.test(t)) return true
  if (/^(~|\$home|\$env:userprofile|\$env:homedrive|\$env:systemroot)$/i.test(t)) return true
  if (/^[a-zA-Z]:[\\/](windows|users|program files|programdata|projects|repos|code)$/i.test(t)) return true
  return false
}

function looksLikeWildcard(target) {
  return /[*?]/.test(String(target))
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const DRY_RUN_CATEGORIES = new Set(['delete', 'overwrite', 'system', 'privilege'])

function add(ctx, finding) {
  // `-WhatIf` is PowerShell's own dry run: the cmdlet prints what it would do
  // and changes nothing. Findings from such a statement keep their evidence but
  // drop to the bottom tier, because nothing is going to happen.
  let next = finding
  if (ctx.dryRun > 0 && DRY_RUN_CATEGORIES.has(finding.category)) {
    next = {
      category: finding.category,
      tier: 'low',
      id: finding.id + '.whatif',
      label: finding.label + '（-WhatIf 空跑）',
      evidence: finding.evidence,
    }
  }
  const key = next.id + '|' + next.evidence
  if (ctx.seen.has(key)) return
  ctx.seen.add(key)
  ctx.findings.push({
    category: next.category,
    tier: next.tier,
    weight: TIER_WEIGHT[next.tier] || 0,
    id: next.id,
    label: next.label,
    evidence: next.evidence,
  })
}

function ev(statement) {
  const text = (statement && statement.text ? statement.text : '').trim()
  return text.length > 160 ? text.slice(0, 157) + '…' : text
}

function isNullTarget(target) {
  const t = String(target).trim().toLowerCase()
  return t === '$null' || t === 'nul' || t === '/dev/null' || t === 'null'
}

function firstPositionalToken(statement) {
  const words = statement.words
  for (let i = 1; i < words.length; i++) {
    const text = words[i].text
    if (text.startsWith('-') && text.length > 1 && !/^-\d/.test(text)) {
      const name = splitFlag(text.slice(1))[0]
      if (VALUE_FLAGS.has(name) && splitFlag(text.slice(1))[1] === undefined) i++
      continue
    }
    return words[i]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Per-statement rules
// ---------------------------------------------------------------------------

function analyzeStatement(statement, ctx, depth) {
  if (statement.words.length === 0) {
    classifyStatement(statement, ctx, depth)
    return
  }
  const native = NATIVE.has(canonical(statement.words[0]))
  const whatIf = hasFlag(parseParams(statement, native), 'whatif') !== undefined
  if (whatIf) ctx.dryRun = (ctx.dryRun || 0) + 1
  try {
    classifyStatement(statement, ctx, depth)
  } finally {
    if (whatIf) ctx.dryRun = Math.max(0, (ctx.dryRun || 0) - 1)
  }
}

function classifyStatement(statement, ctx, depth) {
  const words = statement.words
  for (const redir of statement.redirs) {
    if (isNullTarget(redir.target)) continue
    add(ctx, { category: 'overwrite', tier: 'medium', id: 'overwrite.redirect', label: '重定向覆盖文件', evidence: redir.op + ' ' + redir.target })
  }
  if (words.length === 0) return

  const verb = canonical(words[0])
  const native = NATIVE.has(verb)
  const params = parseParams(statement, native)
  const targets = allTargets(params)
  const text = statement.text

  if (verb === 'cmd' && (hasFlag(params, 'c', 'r', 'k') !== undefined || /\/[ck]\b/i.test(text))) {
    // `cmd /c` switches belong to cmd, not to the inner command, so the payload
    // has to come from the raw text rather than from parsed parameters:
    // `cmd /c del /s /q D:\x` would otherwise hand `del D:\x` to the analyzer
    // and lose the recursive switch.
    let payload = text.replace(/^\s*\S+\s*/, '')
    payload = payload.replace(/^\/[ck]\b\s*/i, '').trim()
    if (payload.startsWith('"') && payload.endsWith('"') && payload.length > 1) payload = payload.slice(1, -1)
    if (payload.length > 0 && depth < 3) {
      ctx.notes.push('已跟进 cmd /c 内容')
      merge(ctx, analyze(payload, { maxDepth: 2 }))
    }
    return
  }

  if (verb === 'start-process') {
    if (/runas/i.test(String(flagValue(params, 'verb') || ''))) {
      add(ctx, { category: 'privilege', tier: 'high', id: 'privilege.runas', label: '提权启动进程', evidence: ev(statement) })
    } else {
      add(ctx, { category: 'execute', tier: 'low', id: 'execute.process', label: '启动新进程', evidence: ev(statement) })
    }
    return
  }

  if (verb === 'remove-item') {
    const shorts = shortClusters(params)
    const recurse = hasFlag(params, 'recurse') !== undefined || shorts.some((n) => n.indexOf('r') >= 0)
    const wildcard = targets.some(looksLikeWildcard)
    const rootish = targets.some(isRootishPath)
    // `Get-ChildItem -Recurse | Remove-Item -Force` deletes whatever came down
    // the pipe; the destructive flag lives upstream, so the upstream text has
    // to be part of the decision. `$_` / `$PSItem` / `$input` are the pipe, not
    // a target of their own.
    const pipelineVars = targets.length > 0 && targets.every((target) => /^\$(?:_|psitem|input)\b/i.test(target))
    const noRealTarget = targets.length === 0 || pipelineVars
    const pipedRecursive = noRealTarget
      && typeof statement.pipeFrom === 'string'
      && /-(recurse|r)\b/i.test(statement.pipeFrom)
    if (recurse) {
      add(ctx, {
        category: 'delete',
        tier: 'high',
        id: rootish ? 'delete.recurse-root' : 'delete.recurse',
        label: rootish ? '递归删除高价值根路径' : '递归删除',
        evidence: ev(statement),
      })
    } else if (pipedRecursive) {
      add(ctx, { category: 'delete', tier: 'high', id: 'delete.pipeline-recurse', label: '删除管道上游列出的全部条目', evidence: ev(statement) })
    } else if (wildcard) {
      add(ctx, { category: 'delete', tier: 'medium', id: 'delete.wildcard', label: '通配符删除', evidence: ev(statement) })
    } else if (targets.length > 0) {
      add(ctx, { category: 'delete', tier: 'medium', id: 'delete.item', label: '删除文件或目录', evidence: ev(statement) })
    } else {
      add(ctx, { category: 'delete', tier: 'medium', id: 'delete.unknown-target', label: '删除（目标在变量里）', evidence: ev(statement) })
    }
    if (hasFlag(params, 'whatif') !== undefined) ctx.notes.push('带 -WhatIf，实际不会删除')
    return
  }

  if (verb === 'clear-content') {
    add(ctx, { category: 'overwrite', tier: 'medium', id: 'overwrite.clear', label: '清空文件内容', evidence: ev(statement) })
    return
  }

  if (verb === 'set-content' || verb === 'add-content' || verb === 'out-file' || verb === 'export-csv' || verb === 'export-clixml' || verb === 'tee-object' || verb === 'set-item' || verb === 'set-itemproperty') {
    const append = verb === 'add-content' || hasFlag(params, 'append') !== undefined
    add(ctx, {
      category: 'overwrite',
      tier: append ? 'low' : 'medium',
      id: append ? 'overwrite.append' : 'overwrite.contents',
      label: append ? '追加写入文件' : '覆盖写入文件',
      evidence: ev(statement),
    })
    return
  }

  if (verb === 'copy-item' || verb === 'move-item' || verb === 'rename-item') {
    const force = hasFlag(params, 'force') !== undefined
    add(ctx, {
      category: 'overwrite',
      tier: force ? 'medium' : 'low',
      id: force ? 'overwrite.force-copy' : 'overwrite.copy',
      label: force ? '强制覆盖目标' : '复制/移动文件',
      evidence: ev(statement),
    })
    return
  }

  if (verb === 'new-item') {
    if (hasFlag(params, 'force') !== undefined) {
      add(ctx, { category: 'overwrite', tier: 'low', id: 'overwrite.new-force', label: '新建并允许覆盖', evidence: ev(statement) })
    }
    return
  }

  if (verb === 'expand-archive') {
    add(ctx, {
      category: 'overwrite',
      tier: hasFlag(params, 'force') !== undefined ? 'medium' : 'low',
      id: 'overwrite.expand',
      label: '解压覆盖目标目录',
      evidence: ev(statement),
    })
    return
  }

  if (verb === 'invoke-expression') {
    const token = firstPositionalToken(statement)
    const literal = token !== undefined && token.quoted === true && token.interpolated !== true
    add(ctx, {
      category: 'execute',
      tier: literal ? 'medium' : 'high',
      id: literal ? 'execute.iex-literal' : 'execute.iex-dynamic',
      label: literal ? 'Invoke-Expression（固定字符串）' : 'Invoke-Expression（动态拼接）',
      evidence: ev(statement),
    })
    // A string handed to Invoke-Expression is code, so its contents are a
    // command in their own right. Ordinary quoted arguments are data and are
    // deliberately not parsed this way, to keep `Write-Output 'rm -rf /demo'`
    // out of the destructive bucket.
    if (literal && depth < 3 && token.text.trim().length > 0) {
      const inner = analyze(token.text, { maxDepth: 2 })
      if (inner.findings.length > 0) {
        merge(ctx, inner)
        ctx.notes.push('已分析 Invoke-Expression 的字符串内容')
      }
    }
    return
  }

  if (verb === 'invoke-webrequest' || verb === 'invoke-restmethod' || verb === 'start-bitstransfer') {
    add(ctx, { category: 'download', tier: 'medium', id: 'download.fetch', label: '从网络拉取内容', evidence: ev(statement) })
    return
  }

  if (verb === 'invoke-command') {
    add(ctx, { category: 'execute', tier: 'medium', id: 'execute.invoke-command', label: '执行脚本块', evidence: ev(statement) })
    return
  }

  if (verb === 'get-content' || verb === 'get-item' || verb === 'get-childitem' || verb === 'test-path') {
    return
  }

  if (verb === 'set-executionpolicy') {
    const value = String(params.positional[0] || flagValue(params, 'executionpolicy') || '').toLowerCase()
    const scope = String(flagValue(params, 'scope') || '').toLowerCase()
    if (value === 'bypass' || value === 'unrestricted') {
      add(ctx, {
        category: 'execute',
        tier: /machine/i.test(scope) ? 'high' : 'medium',
        id: 'execute.policy-bypass',
        label: '放开脚本执行策略',
        evidence: ev(statement),
      })
    }
    return
  }

  if (verb === 'stop-computer' || verb === 'restart-computer' || verb === 'shutdown') {
    add(ctx, { category: 'system', tier: 'high', id: 'system.power', label: '关机/重启', evidence: ev(statement) })
    return
  }

  if (verb === 'clear-recyclebin') {
    add(ctx, { category: 'system', tier: 'medium', id: 'system.recycle', label: '清空回收站', evidence: ev(statement) })
    return
  }

  if (verb === 'clear-disk' || verb === 'initialize-disk' || verb === 'remove-partition' || verb === 'format-volume' || verb === 'diskpart' || verb === 'format' || verb === 'mkfs' || verb === 'dd') {
    add(ctx, { category: 'delete', tier: 'high', id: 'delete.disk', label: '磁盘格式化/擦除', evidence: ev(statement) })
    return
  }

  if (verb === 'bcdedit' || verb === 'vssadmin' || verb === 'wbadmin' || verb === 'cipher' || verb === 'manage-bde' || verb === 'wevtutil') {
    const destructive = /delete|config|set|disable|off|remove|wipe|clear-log/i.test(text)
      // `wevtutil cl Security` clears an event log; `cl` is the short form.
      || (verb === 'wevtutil' && /\bcl\b/i.test(text))
    if (destructive) {
      add(ctx, { category: 'system', tier: 'high', id: 'system.boot', label: '引导/备份/加密卷/日志改动', evidence: ev(statement) })
    } else {
      add(ctx, { category: 'system', tier: 'medium', id: 'system.inspect', label: '系统底层命令', evidence: ev(statement) })
    }
    return
  }

  if (verb === 'reg' || verb === 'regedit') {
    if (/\b(delete|add|import)\b/i.test(text)) {
      const hive = /(hklm|hkcu|hkey_)/i.test(text)
      add(ctx, { category: 'system', tier: hive ? 'high' : 'medium', id: 'system.registry', label: '改写注册表', evidence: ev(statement) })
    } else {
      add(ctx, { category: 'system', tier: 'low', id: 'system.registry-read', label: '读取注册表', evidence: ev(statement) })
    }
    return
  }

  if (verb === 'icacls' || verb === 'cacls' || verb === 'takeown' || verb === 'attrib') {
    if (/grant|everyone|reset|deny|[\\/]f\b/i.test(text)) {
      add(ctx, { category: 'privilege', tier: 'high', id: 'privilege.acl', label: '改写文件权限/取得所有权', evidence: ev(statement) })
    } else {
      add(ctx, { category: 'privilege', tier: 'low', id: 'privilege.acl-read', label: '查看文件权限', evidence: ev(statement) })
    }
    return
  }

  if (verb === 'net' || verb === 'sc' || verb === 'schtasks' || verb === 'setx' || verb === 'cmdkey') {
    // `net user bob P@ss /add` puts the password between the account name and
    // the switch, so the test must not assume the switch comes second.
    const accountChange = /localgroup\s+administrators|administrators\s+[\\/]add/i.test(text)
      || (/\buser\s+\S+/i.test(text) && /[\\/](add|delete)\b/i.test(text))
    if (accountChange) {
      add(ctx, { category: 'system', tier: 'high', id: 'system.account', label: '创建/删除账号或加入管理员组', evidence: ev(statement) })
      return
    }
    if (verb === 'cmdkey' && /[\\/]add/i.test(text)) {
      add(ctx, { category: 'credential', tier: 'medium', id: 'credential.cmdkey', label: '写入保存的凭据', evidence: ev(statement) })
      return
    }
    if (verb === 'sc' && /\b(delete|config)\b/i.test(text)) {
      add(ctx, { category: 'system', tier: 'high', id: 'system.service', label: '改动系统服务', evidence: ev(statement) })
      return
    }
    if (verb === 'schtasks' && /[\\/](create|change)/i.test(text)) {
      add(ctx, { category: 'system', tier: 'medium', id: 'system.schedule', label: '创建计划任务', evidence: ev(statement) })
      return
    }
    if (verb === 'setx') {
      add(ctx, { category: 'system', tier: 'low', id: 'system.env', label: '设置用户环境变量', evidence: ev(statement) })
      return
    }
    return
  }

  if (verb === 'netsh') {
    if (/(advfirewall|firewall)/i.test(text) && /\b(off|disable|set)\b/i.test(text)) {
      add(ctx, { category: 'system', tier: 'high', id: 'system.firewall', label: '改动防火墙', evidence: ev(statement) })
    }
    return
  }

  if (verb === 'bitsadmin' || verb === 'certutil') {
    if (verb === 'bitsadmin' && /[\\/](transfer|addfile)/i.test(text)) {
      add(ctx, { category: 'download', tier: 'medium', id: 'download.bitsadmin', label: '后台传输下载', evidence: ev(statement) })
      return
    }
    if (verb === 'certutil' && /-urlcache|-split/i.test(text)) {
      add(ctx, { category: 'download', tier: 'medium', id: 'download.certutil', label: '用 certutil 下载', evidence: ev(statement) })
      return
    }
    if (verb === 'certutil' && /-decode/i.test(text)) {
      add(ctx, { category: 'execute', tier: 'medium', id: 'execute.certutil-decode', label: '解码载荷', evidence: ev(statement) })
    }
    return
  }

  if (verb === 'robocopy' || verb === 'xcopy' || verb === 'copy') {
    if (verb === 'robocopy' && (/[\\/]mir\b/i.test(text) || params.flags.some((f) => f.name === 'mir' || f.name === 'mirror'))) {
      add(ctx, { category: 'delete', tier: 'high', id: 'delete.mirror', label: '镜像同步会删除目标多余文件', evidence: ev(statement) })
      return
    }
    add(ctx, { category: 'overwrite', tier: 'low', id: 'overwrite.native-copy', label: '复制文件', evidence: ev(statement) })
    return
  }

  if (verb === 'rmdir' || verb === 'rd' || verb === 'del' || verb === 'erase') {
    if (/[\\/]s\b/i.test(text)) {
      add(ctx, { category: 'delete', tier: 'high', id: 'delete.native-recurse', label: '递归删除目录树', evidence: ev(statement) })
    } else if (/[\\/][qf]\b/i.test(text)) {
      add(ctx, { category: 'delete', tier: 'medium', id: 'delete.native-quiet', label: '静默删除', evidence: ev(statement) })
    } else {
      add(ctx, { category: 'delete', tier: 'low', id: 'delete.native', label: '删除文件', evidence: ev(statement) })
    }
    return
  }

  if (verb === 'git') {
    const lower = text.toLowerCase()
    if (/push\b/.test(lower) && /--force|\s-f\b/.test(lower)) {
      add(ctx, { category: 'overwrite', tier: 'high', id: 'overwrite.git-push-force', label: '强制推送覆盖远端历史', evidence: ev(statement) })
      return
    }
    if (/reset\b/.test(lower) && /--hard/.test(lower)) {
      add(ctx, { category: 'overwrite', tier: 'medium', id: 'overwrite.git-reset-hard', label: '丢弃未提交改动', evidence: ev(statement) })
      return
    }
    if (/clean\b/.test(lower) && /\s-[a-z]*f/.test(lower)) {
      const aggressive = /\s-[a-z]*[dx]/.test(lower)
      add(ctx, {
        category: 'delete',
        tier: aggressive ? 'high' : 'medium',
        id: 'delete.git-clean',
        label: aggressive ? '清理未跟踪文件与目录' : '清理未跟踪文件',
        evidence: ev(statement),
      })
      return
    }
    if (/checkout\b/.test(lower) && /\s--\s+\.|\s\.\s*$/.test(lower)) {
      add(ctx, { category: 'overwrite', tier: 'medium', id: 'overwrite.git-checkout', label: '丢弃工作区改动', evidence: ev(statement) })
      return
    }
    if (/restore\b/.test(lower)) {
      add(ctx, { category: 'overwrite', tier: 'medium', id: 'overwrite.git-restore', label: '还原/丢弃文件改动', evidence: ev(statement) })
      return
    }
    return
  }

  if (verb === 'sqlcmd' || verb === 'psql' || verb === 'mysql' || verb === 'sqlite3' || verb === 'mongo') {
    const lower = text.toLowerCase()
    if (/drop\s+(table|database|schema)|truncate\s+table|delete\s+from/.test(lower)) {
      add(ctx, { category: 'delete', tier: 'high', id: 'delete.sql', label: '删表/删库/清空表', evidence: ev(statement) })
    } else if (/update\s+|insert\s+into|alter\s+table/.test(lower)) {
      add(ctx, { category: 'overwrite', tier: 'medium', id: 'overwrite.sql', label: '改写数据库内容', evidence: ev(statement) })
    }
    return
  }
}

/**
 * Text-level rules. These run for every statement, including the ones a verb
 * handler already recognized, because a destructive verb nested in an argument
 * — an inline script, a here-string, a -Command payload — must not be invisible
 * just because the outer verb was boring.
 */
function textRules(statement, ctx) {
  const text = statement.text
  // Quoted segments are data, not code: a here-string holding an example
  // `Remove-Item -Recurse` must not be graded as a destructive command. The
  // rules that look for *dangerous text* therefore run on this quote-blind
  // copy, while the credential and secret rules keep the original string.
  const bare = statement.words.map((word) => (word.quoted === true ? '""' : word.raw)).join(' ')
  const lower = bare.toLowerCase()
  const here = ev(statement)

  if (/\[scriptblock\]::create|\[system\.reflection\.assembly\]::load|\[convert\]::frombase64string/.test(lower)) {
    add(ctx, { category: 'execute', tier: 'high', id: 'execute.dynamic', label: '运行时构造并执行代码', evidence: here })
  }
  if (/\badd-type\b/.test(lower)) {
    add(ctx, { category: 'execute', tier: 'medium', id: 'execute.add-type', label: '编译加载新代码', evidence: here })
  }
  if (/(downloadstring|downloadfile|downloaddata)\s*\(/.test(lower)) {
    add(ctx, { category: 'download', tier: 'medium', id: 'download.webclient', label: '下载到内存/落盘', evidence: here })
  }
  if (/\.delete\s*\(\s*true\s*\)/.test(lower)) {
    add(ctx, { category: 'delete', tier: 'high', id: 'delete.method-recursive', label: '递归删除（.NET 方法）', evidence: here })
  } else if (/\.delete\s*\(|\.removeat\s*\(/.test(lower)) {
    add(ctx, { category: 'delete', tier: 'medium', id: 'delete.method', label: '调用删除方法', evidence: here })
  }
  if (/\[system\.io\.directory\]::delete\s*\(|\[system\.io\.file\]::delete\s*\(/.test(lower)) {
    const recursive = /\$true/.test(lower)
    add(ctx, {
      category: 'delete',
      tier: recursive ? 'high' : 'medium',
      id: recursive ? 'delete.dotnet-recursive' : 'delete.dotnet',
      label: recursive ? '递归删除目录（.NET 静态方法）' : '删除文件/目录（.NET 静态方法）',
      evidence: here,
    })
  }
  if (/\/dev\/sd[a-z]|\bmkfs\b/.test(lower)) {
    add(ctx, { category: 'delete', tier: 'high', id: 'delete.raw-disk', label: '写裸设备', evidence: here })
  }
  if (INLINE_SECRET.test(text)) {
    add(ctx, { category: 'credential', tier: 'medium', id: 'credential.inline-secret', label: '命令里带了明文密钥', evidence: redact(here) })
  }
  if (ENV_SECRET.test(text)) {
    add(ctx, { category: 'credential', tier: 'low', id: 'credential.env', label: '读取环境变量里的密钥', evidence: here })
  }
  if (/convertto-securestring\b/.test(lower) && /-asplaintext/.test(lower)) {
    add(ctx, { category: 'credential', tier: 'medium', id: 'credential.securestring', label: '把明文转换成安全字符串', evidence: here })
  }
  if (/\bget-credential\b/.test(lower)) {
    add(ctx, { category: 'credential', tier: 'low', id: 'credential.prompt', label: '弹出凭据提示', evidence: here })
  }
  if (/reg\s+save[^\n]*(sam|security|system)/i.test(text)) {
    add(ctx, { category: 'credential', tier: 'high', id: 'credential.hive', label: '导出凭据数据库', evidence: here })
  }
  // `.env.example` / `.env.sample` are templates by convention and carry no
  // secrets, so they are blanked out before the credential-path test.
  const credentialText = text
    .replace(/["']/g, ' ')
    .replace(/([.\\/])\.env\.(example|sample|template|dist)\b/gi, ' ')
  if (CREDENTIAL_PATH.test(credentialText)) {
    const writes = /\b(remove-item|clear-content|set-content|add-content|out-file|copy-item|move-item|rename-item|new-item|del|rmdir|format)\b/i.test(text)
    add(ctx, {
      category: 'credential',
      tier: writes ? 'high' : 'medium',
      id: writes ? 'credential.write-path' : 'credential.read-path',
      label: writes ? '写入凭据/配置路径' : '触碰凭据路径',
      evidence: here,
    })
  }
}

// ---------------------------------------------------------------------------
// Nested commands
// ---------------------------------------------------------------------------

function nestedCommandTexts(statement) {
  const out = []
  for (let i = 1; i < statement.words.length; i++) {
    const prev = statement.words[i - 1]
    const name = prev.text.replace(/^-+/, '').toLowerCase()
    if (name.length === 0 || name.length > 'encodedcommand'.length) continue
    const value = statement.words[i].text
    // PowerShell prefix-matches parameter names, so `-ec`, `-e` and `-Encoded`
    // all reach -EncodedCommand, and `-c`, `-Co` reach -Command.
    if (name === 'encodedcommand' || name === 'enc' || name === 'ec' || name === 'encoded') {
      // A malformed blob is still an encoded command: the point is that the
      // real command is not visible here.
      out.push({ kind: 'encodedcommand', text: value })
      continue
    }
    if ('encodedcommand'.startsWith(name)) {
      if (decodeBase64Command(value) !== undefined) {
        out.push({ kind: 'encodedcommand', text: value })
        continue
      }
    }
    if ('command'.startsWith(name)) {
      out.push({ kind: 'command', text: value })
    }
  }
  return out
}

export function decodeBase64Command(text) {
  try {
    const clean = String(text).replace(/\s+/g, '')
    if (clean.length < 12 || !/^[A-Za-z0-9+/=]+$/.test(clean)) return undefined
    const pad = clean.length % 4 === 0 ? clean : clean + '='.repeat(4 - (clean.length % 4))
    const buffer = Buffer.from(pad, 'base64')
    if (buffer.length === 0) return undefined
    const decoded = buffer.toString('utf16le')
    if (!/[\u0020-\u007e]{4,}/.test(decoded)) return undefined
    return decoded
  } catch (error) {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function merge(ctx, report) {
  for (const finding of report.findings) add(ctx, finding)
  for (const note of report.notes) {
    if (ctx.notes.indexOf(note) < 0) ctx.notes.push(note)
  }
}

export function analyze(command, options) {
  const settings = options || {}
  const maxDepth = Number.isFinite(settings.maxDepth) ? settings.maxDepth : 3
  const ctx = { findings: [], notes: [], seen: new Set(), statements: 0, dryRun: 0 }
  let text = typeof command === 'string' ? command : ''
  let truncated = false
  if (text.length > MAX_INPUT) {
    text = text.slice(0, MAX_INPUT)
    truncated = true
    ctx.notes.push('命令超过 ' + MAX_INPUT + ' 字符，只分析了前段')
  }

  const scanned = extractSubexpressions(text)
  const statements = toStatements(lex(scanned.text))
  ctx.statements = statements.length
  for (const statement of statements) {
    analyzeStatement(statement, ctx, 0)
    textRules(statement, ctx)
    for (const nested of nestedCommandTexts(statement)) {
      if (nested.text.length === 0) continue
      if (nested.kind === 'encodedcommand' || nested.kind === 'enc') {
        add(ctx, {
          category: 'execute',
          tier: 'high',
          id: 'execute.encoded-command',
          label: 'Base64 编码命令',
          evidence: '-EncodedCommand ' + nested.text.slice(0, 48) + (nested.text.length > 48 ? '…' : ''),
        })
        const decoded = decodeBase64Command(nested.text)
        if (decoded !== undefined && maxDepth > 0) {
          ctx.notes.push('已解码 -EncodedCommand 继续分析')
          merge(ctx, analyze(decoded, { maxDepth: maxDepth - 1 }))
        }
        continue
      }
      if (maxDepth > 0) {
        ctx.notes.push('已跟进嵌套的 -Command 内容')
        merge(ctx, analyze(nested.text, { maxDepth: maxDepth - 1 }))
      }
    }
  }

  if (maxDepth > 0) {
    let used = 0
    for (const inner of scanned.inner) {
      if (inner.trim().length === 0) continue
      const sub = analyze(inner, { maxDepth: maxDepth - 1 })
      if (sub.findings.length > 0) {
        merge(ctx, sub)
        used++
      }
    }
    if (used > 0) ctx.notes.push('已分析子表达式')
  }

  return finalize(ctx, truncated)
}

function finalize(ctx, truncated) {
  const findings = ctx.findings.slice().sort(function (a, b) {
    const byTier = TIER_RANK[b.tier] - TIER_RANK[a.tier]
    if (byTier !== 0) return byTier
    return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  })

  let tier = 'none'
  for (const finding of findings) {
    if (TIER_RANK[finding.tier] > TIER_RANK[tier]) tier = finding.tier
  }

  const categories = []
  for (const finding of findings) {
    if (categories.indexOf(finding.category) < 0) categories.push(finding.category)
  }

  // Two combinations are worse than the sum of their parts and are promoted
  // explicitly: "download then run", and "read a secret then send it out".
  let escalated = ''
  const has = (name) => categories.indexOf(name) >= 0
  if (has('download') && has('execute')) {
    tier = 'high'
    escalated = '下载并执行'
  } else if (has('download') && has('credential')) {
    tier = 'high'
    escalated = '读取凭据并外发'
  }

  let score = 0
  for (const finding of findings) score += finding.weight

  const summary = categories.length === 0 ? '无风险特征' : categories.map((c) => CATEGORY_LABELS[c] || c).join(' · ')

  return {
    tier: tier,
    score: Math.min(100, score),
    categories: categories,
    findings: findings,
    statements: ctx.statements,
    notes: ctx.notes,
    truncated: truncated,
    confirm: tier === 'high',
    escalated: escalated,
    summary: summary,
  }
}

/** Only the top tier needs a human. */
export function shouldConfirm(report) {
  return Boolean(report) && report.tier === 'high'
}

/** Mask credential-shaped text before it reaches a log or a panel row. */
export function redact(text) {
  let out = String(text === undefined || text === null ? '' : text)
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private-key]')
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[github-token]')
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[github-token]')
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[api-key]')
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[aws-key]')
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[slack-token]')
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, '[jwt]')
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[token]')
  out = out.replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s;|&]+)/gi, '$1[redacted]')
  return out
}

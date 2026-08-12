// ───────────────────────────────────────────────────────────────────────────────
// HARNESS ONLY — NOT A SHIPPED IMPLEMENTATION.
//
// This is a deliberately naive implementation of SPEC.md sections 2-7, written to give the
// conformance runner something to run before any language package exists. It exists to prove
// the fixtures and the runner work, and to serve as executable documentation of PROBE.md.
//
// It is NOT packages/ts/. It wraps no configuration library — the whole point of the language
// packages is that they wrap cosmiconfig, Dynaconf, Viper, Spring Boot config and figment
// rather than hand-rolling this. Its parsers are hand-rolled subsets that handle exactly what
// the fixtures contain and will fall over on real-world files. Do not import it, do not copy
// it into a package, and do not treat its behavior as normative anywhere SPEC.md is silent.
// ───────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A seam for reference/broken/run, which reruns this same file with one defect switched on so
// the suite can be shown going red. Nothing else reads the ambient environment.
const DEFECT = process.env.REFERENCE_PROBE_DEFECT ?? ''

class LoadError extends Error {
  constructor(kind, path, message) {
    super(message)
    this.kind = kind
    this.path = path
  }
}
class ProbeError extends Error {}

const warn = (msg) => process.stderr.write(`warning: ${msg}\n`)

// ── parsers (subsets — see the header) ──────────────────────────────────────

const stripComment = (line) => {
  let out = ''
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote && line[i - 1] !== '\\') quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#') break
    out += c
  }
  return out.trim()
}

function parseTomlScalar(raw, file, lineNo) {
  const text = raw.trim()
  if (text === '') throw new LoadError('malformed', file, `${file}:${lineNo}: missing value`)
  if (text[0] === '"' || text[0] === "'") {
    const quote = text[0]
    if (text.length < 2 || text.at(-1) !== quote) {
      throw new LoadError('malformed', file, `${file}:${lineNo}: unterminated string`)
    }
    const body = text.slice(1, -1)
    return quote === '"' ? body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"') : body
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new LoadError('malformed', file, `${file}:${lineNo}: unterminated array`)
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return splitTopLevel(inner).map((part) => parseTomlScalar(part, file, lineNo))
  }
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^[+-]?(\d+\.\d+|\d+[eE][+-]?\d+)$/.test(text)) return Number.parseFloat(text)
  throw new LoadError('malformed', file, `${file}:${lineNo}: cannot parse value ${JSON.stringify(text)}`)
}

/** Split a comma-separated list, ignoring commas inside quotes or brackets. */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

function parseToml(text, file) {
  const root = {}
  let table = root
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = stripComment(rawLine)
    if (line === '') return
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new LoadError('malformed', file, `${file}:${i + 1}: unterminated table header`)
      const name = line.slice(1, -1).trim()
      if (name === '') throw new LoadError('malformed', file, `${file}:${i + 1}: empty table header`)
      table = root
      for (const part of name.split('.')) {
        table[part] ??= {}
        table = table[part]
      }
      return
    }
    const eq = line.indexOf('=')
    if (eq < 1) throw new LoadError('malformed', file, `${file}:${i + 1}: expected key = value`)
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '')
    table[key] = parseTomlScalar(line.slice(eq + 1), file, i + 1)
  })
  return root
}

function parseYamlScalar(text) {
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^[+-]?\d+\.\d+$/.test(text)) return Number.parseFloat(text)
  return text
}

function parseYaml(text, file) {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ raw: l, no: i + 1 }))
    .filter(({ raw }) => raw.trim() !== '' && !raw.trim().startsWith('#'))

  let pos = 0
  const parseBlock = (indent) => {
    let result = null
    while (pos < lines.length) {
      const { raw, no } = lines[pos]
      const currentIndent = raw.length - raw.trimStart().length
      if (currentIndent < indent) break
      if (currentIndent > indent) throw new LoadError('malformed', file, `${file}:${no}: unexpected indentation`)
      const body = raw.trim()
      if (body.startsWith('- ') || body === '-') {
        result ??= []
        if (!Array.isArray(result)) throw new LoadError('malformed', file, `${file}:${no}: list item inside a map`)
        pos++
        result.push(parseYamlScalar(body.slice(1).trim()))
        continue
      }
      const colon = body.indexOf(':')
      if (colon < 0) throw new LoadError('malformed', file, `${file}:${no}: expected key: value`)
      result ??= {}
      if (Array.isArray(result)) throw new LoadError('malformed', file, `${file}:${no}: map key inside a list`)
      const key = body.slice(0, colon).trim()
      const rest = body.slice(colon + 1).trim()
      pos++
      if (rest === '') {
        const next = lines[pos]
        const nextIndent = next ? next.raw.length - next.raw.trimStart().length : -1
        result[key] = nextIndent > indent ? parseBlock(nextIndent) : null
      } else {
        result[key] = parseYamlScalar(rest)
      }
    }
    return result ?? {}
  }

  const value = parseBlock(0)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LoadError('malformed', file, `${file}: top level must be a map`)
  }
  return value
}

function parseJsonLike(text, file, allowComments) {
  const source = allowComments ? stripJsonComments(text) : text
  if (source.trim() === '') return {}
  try {
    const value = JSON.parse(source)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('top level must be an object')
    }
    return value
  } catch (err) {
    throw new LoadError('malformed', file, `${file}: ${err.message}`)
  }
}

function stripJsonComments(text) {
  let out = ''
  let inString = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (inString) {
      if (c === '\\') {
        out += c + (next ?? '')
        i += 2
        continue
      }
      if (c === '"') inString = false
      out += c
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function parseIni(text, file) {
  const root = {}
  let table = root
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new LoadError('malformed', file, `${file}:${i + 1}: unterminated section header`)
      const name = line.slice(1, -1).trim()
      table = root
      for (const part of name.split('.')) {
        table[part] ??= {}
        table = table[part]
      }
      return
    }
    const eq = line.indexOf('=')
    if (eq < 1) throw new LoadError('malformed', file, `${file}:${i + 1}: expected key=value`)
    // INI is an untyped format; SPEC section 2.5 pins the same coercion the env layer uses.
    table[line.slice(0, eq).trim()] = coerce(line.slice(eq + 1).trim(), false)
  })
  return root
}

/** SPEC section 4.5 step 5: parse as JSON, keep the raw string when that fails. */
function coerce(raw, wasQuoted) {
  if (wasQuoted) return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function parseDotenv(text, file, prefix) {
  const result = {}
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) return
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = body.indexOf('=')
    if (eq < 1) throw new LoadError('malformed', file, `${file}:${i + 1}: expected KEY=VALUE`)
    let name = body.slice(0, eq).trim()
    let value = body.slice(eq + 1).trim()
    let quoted = false
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
      quoted = true
    }
    // SPEC section 4.6: the prefix is stripped when present and simply absent otherwise.
    if (prefix && name.toUpperCase().startsWith(prefix + '_')) name = name.slice(prefix.length + 1)
    assignPath(result, envKeyPath(name), coerce(value, quoted))
  })
  return result
}

const envKeyPath = (name) => name.toLowerCase().split('__').filter((s) => s !== '')

function assignPath(target, path, value) {
  let node = target
  for (const part of path.slice(0, -1)) {
    if (node[part] === null || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {}
    node = node[part]
  }
  node[path.at(-1)] = value
}

// ── merge (SPEC section 4) ──────────────────────────────────────────────────

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function merge(lower, higher, options, path = '') {
  const out = { ...lower }
  for (const [key, value] of Object.entries(higher)) {
    const at = path ? `${path}.${key}` : key
    if (value === null) {
      delete out[key] // section 4.4: explicit null unsets; absent is not null.
      continue
    }
    const existing = out[key]
    if (isMap(existing) && isMap(value)) {
      out[key] = merge(existing, value, options, at)
      continue
    }
    if (Array.isArray(existing) && Array.isArray(value)) {
      const concat = options.arrayMerge === 'concat' || DEFECT === 'array-concat'
      out[key] = concat ? [...existing, ...value] : value // section 4.3
      continue
    }
    if (isMap(existing) !== isMap(value) && existing !== undefined) {
      warn(`${at}: replacing ${isMap(existing) ? 'a map' : 'a scalar'} with ${isMap(value) ? 'a map' : 'a scalar'}`)
    }
    out[key] = value
  }
  return out
}

// ── discovery (SPEC section 2) ──────────────────────────────────────────────

const RECOGNIZED = [
  ['config.toml', 'toml'],
  ['config.yaml', 'yaml'],
  ['config.yml', 'yaml'],
  ['config.json', 'json'],
  ['config.jsonc', 'jsonc'],
  ['config.ini', 'ini'],
  ['.env', 'dotenv'],
]

const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function walkUp(packageName, startDir, homeDir, stopDir) {
  const roots = []
  let dir = startDir
  for (;;) {
    // Section 2.2: a directory is always checked before it is tested for stopping.
    const packageRoot = join(dir, '.config', packageName)
    if (isDir(packageRoot)) roots.push(packageRoot)

    const parent = dirname(dir)
    const atRoot = parent === dir
    const atHome = dir === homeDir
    const atStop = stopDir !== undefined && dir === stopDir
    const atGit = existsSync(join(dir, '.git'))
    if (atRoot || atHome || atStop || atGit) break
    dir = parent
  }
  return roots.reverse() // farthest ancestor first (section 2.7)
}

function userRootFor(packageName, homeDir, env) {
  const xdg = env.XDG_CONFIG_HOME
  if (xdg !== undefined) {
    if (xdg !== '' && isAbsolute(xdg)) return join(xdg, packageName)
    warn(`ignoring XDG_CONFIG_HOME=${JSON.stringify(xdg)}: not an absolute path (SPEC 2.4)`)
  }
  return join(homeDir, '.config', packageName)
}

/** The recognized files in one config directory, in SPEC section 2.5 order. */
function filesIn(root, profile) {
  let entries
  try {
    entries = new Set(readdirSync(root))
  } catch {
    warn(`skipping unreadable directory ${root}`)
    return []
  }
  if (entries.has('config.yaml') && entries.has('config.yml')) {
    throw new LoadError('duplicate-format', root, `${root}: config.yaml and config.yml cannot coexist`)
  }
  const out = []
  for (const [name, format] of RECOGNIZED) {
    if (entries.has(name)) out.push({ path: join(root, name), format })
    if (profile) {
      const { name: stem, ext } = parsePath(name)
      const withProfile = ext === '' ? `${stem}.${profile}` : `${stem}.${profile}${ext}`
      if (entries.has(withProfile)) out.push({ path: join(root, withProfile), format })
    }
  }
  return out
}

function readAndParse(file, format, envPrefix) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new LoadError('unreadable', file, `${file}: ${err.code ?? err.message}`)
  }
  switch (format) {
    case 'toml':
      return parseToml(text, file)
    case 'yaml':
      return parseYaml(text, file)
    case 'json':
      return parseJsonLike(text, file, false)
    case 'jsonc':
      return parseJsonLike(text, file, true)
    case 'ini':
      return parseIni(text, file)
    case 'dotenv':
      return parseDotenv(text, file, envPrefix)
    default:
      throw new ProbeError(`unhandled format ${format}`)
  }
}

// ── load (SPEC sections 3 and 7) ────────────────────────────────────────────

const KNOWN_OPTIONS = new Set([
  'cwd', 'home', 'stopDir', 'strategy', 'arrayMerge',
  'envPrefix', 'profile', 'strict', 'defaults', 'overrides',
])

export function load({ packageName, cwd, home, env, options, fixtureRoot }) {
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTIONS.has(key)) throw new ProbeError(`unknown option "${key}" (SPEC section 6)`)
  }
  const strategy = options.strategy ?? 'layered'
  if (!['layered', 'first-match'].includes(strategy)) throw new ProbeError(`bad strategy "${strategy}"`)
  const arrayMerge = options.arrayMerge ?? 'replace'
  if (!['replace', 'concat'].includes(arrayMerge)) throw new ProbeError(`bad arrayMerge "${arrayMerge}"`)
  if (/[\\/]/.test(packageName) || packageName === '.' || packageName === '..') {
    throw new ProbeError(`package name ${JSON.stringify(packageName)} is not a single path segment`)
  }

  const envPrefix = (options.envPrefix ?? packageName.toUpperCase().replace(/[^A-Z0-9]/g, '_')).toUpperCase()
  const startDir = realpathSync(options.cwd ?? cwd)
  const homeDir = options.home ?? home
  const stopDir = options.stopDir === undefined ? undefined : realpathSync(options.stopDir)

  const userRoot = userRootFor(packageName, homeDir, env)
  const roots = [
    ...(isDir(userRoot) ? [{ dir: userRoot, precedence: 1 }] : []),
    ...walkUp(packageName, startDir, homeDir, stopDir).map((dir) => ({ dir, precedence: 2 })),
  ]

  // Resolve every root's file list before merging anything, so first-match can pick the
  // highest root that actually holds a file and duplicate-format still fires from any root.
  const blocks = roots.map((root) => ({ ...root, files: filesIn(root.dir, options.profile) }))
  const contributing =
    strategy === 'first-match'
      ? blocks.filter((b) => b.files.length > 0).slice(-1) // section 3.2
      : blocks

  const rel = (p) => (relative(fixtureRoot, p) || '.').split('\\').join('/')
  const sources = []
  let config = { ...(options.defaults ?? {}) }
  let found = false

  if (Object.keys(options.defaults ?? {}).length > 0) {
    sources.push({ path: '<defaults>', format: 'defaults', precedence: 0, keys: sortedKeys(options.defaults) })
  }

  for (const block of contributing) {
    for (const file of block.files) {
      const data = readAndParse(file.path, file.format, envPrefix)
      found = true
      sources.push({
        path: rel(file.path),
        format: file.format,
        // A .env is its own layer, applied inside its root's block (section 3.1).
        precedence: file.format === 'dotenv' ? 3 : block.precedence,
        keys: sortedKeys(data),
      })
      config = merge(config, data, { arrayMerge })
    }
  }

  const envLayer = {}
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(envPrefix + '_')) continue
    const path = envKeyPath(name.slice(envPrefix.length + 1))
    if (path.length === 0) {
      warn(`ignoring ${name}: empty key path`)
      continue
    }
    assignPath(envLayer, path, coerce(value, false))
  }
  if (Object.keys(envLayer).length > 0) {
    sources.push({ path: '<env>', format: 'env', precedence: 4, keys: sortedKeys(envLayer) })
    config = merge(config, envLayer, { arrayMerge })
  }

  if (Object.keys(options.overrides ?? {}).length > 0) {
    sources.push({ path: '<overrides>', format: 'overrides', precedence: 5, keys: sortedKeys(options.overrides) })
    config = merge(config, options.overrides, { arrayMerge })
  }

  return { config, found, sources }
}

const sortedKeys = (obj) => Object.keys(obj).sort()

// ── the PROBE.md process contract ───────────────────────────────────────────

function parseArgv(argv) {
  const out = { env: {}, options: {} }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--package-name':
      case '--cwd':
      case '--home':
      case '--fixture-root': {
        if (value === undefined) throw new ProbeError(`${flag} requires a value`)
        out[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value
        i++
        break
      }
      case '--env': {
        if (value === undefined) throw new ProbeError('--env requires KEY=VALUE')
        const eq = value.indexOf('=')
        if (eq < 1) throw new ProbeError(`--env expects KEY=VALUE, got ${JSON.stringify(value)}`)
        out.env[value.slice(0, eq)] = value.slice(eq + 1)
        i++
        break
      }
      case '--options': {
        if (value === undefined) throw new ProbeError('--options requires a JSON object')
        try {
          out.options = JSON.parse(value)
        } catch (err) {
          throw new ProbeError(`--options is not valid JSON: ${err.message}`)
        }
        i++
        break
      }
      default:
        throw new ProbeError(`unknown flag ${JSON.stringify(flag)}`)
    }
  }
  for (const required of ['packageName', 'cwd', 'home', 'fixtureRoot']) {
    if (out[required] === undefined) throw new ProbeError(`missing required flag for ${required}`)
  }
  return out
}

export function main(argv) {
  let args
  try {
    args = parseArgv(argv)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 2
  }
  try {
    const result = load({ ...args, fixtureRoot: resolve(args.fixtureRoot) })
    process.stdout.write(JSON.stringify(result))
    return 0
  } catch (err) {
    if (err instanceof LoadError) {
      const path = err.path ? (relative(resolve(args.fixtureRoot), err.path) || '.').split('\\').join('/') : undefined
      process.stdout.write(JSON.stringify({ error: { kind: err.kind, path, message: err.message } }))
      return 1
    }
    process.stderr.write(`${err.stack ?? err.message}\n`)
    return 2
  }
}

// Run only when executed, so `reference/run` and `reference/broken/run` both work while the
// module stays importable.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}

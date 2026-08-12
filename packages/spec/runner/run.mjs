#!/usr/bin/env node
// The conformance runner.
//
// Drives every fixture under ../fixtures/ against one probe (../PROBE.md) and reports the
// difference between what the spec requires and what the implementation did. Node built-ins
// only, deliberately: adding a dependency here would mean every language epic inherits a
// package install before it can find out whether it conforms.

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalize } from './canonicalize.mjs'
import { diffCanonical, formatDiff } from './diff.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC_DIR = resolve(HERE, '..')
const FIXTURES_DIR = join(SPEC_DIR, 'fixtures')
const PACKAGES_DIR = resolve(SPEC_DIR, '..')
const LANGUAGES = ['ts', 'py', 'golang', 'java', 'rust']

const EXIT = { ok: 0, failure: 1, usage: 2 }

// ── a very small JSON Schema subset ──────────────────────────────────────────
// Enough for manifest.schema.json and nothing more. A malformed manifest must fail as a
// schema error with a field name in it, not as a bewildering output diff twenty lines later.

function validateSchema(schema, value, path = '') {
  const errors = []
  const at = path || '<root>'

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`)
    return errors
  }

  const t = schema.type
  if (t) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const ok =
      t === 'integer' ? Number.isInteger(value) : t === actual || (t === 'number' && actual === 'number')
    if (!ok) {
      errors.push(`${at}: expected ${t}, got ${actual}`)
      return errors
    }
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: ${JSON.stringify(value)} does not match /${schema.pattern}/`)
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than minLength ${schema.minLength}`)
    }
  }

  if (Array.isArray(value)) {
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${at}: contains duplicate items`)
    }
    if (schema.items) {
      value.forEach((v, i) => errors.push(...validateSchema(schema.items, v, `${at}[${i}]`)))
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${at}: missing required property "${key}"`)
    }
    const props = schema.properties ?? {}
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) {
        errors.push(...validateSchema(props[key], v, path ? `${path}.${key}` : key))
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unknown property "${key}"`)
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(
          ...validateSchema(schema.additionalProperties, v, path ? `${path}.${key}` : key),
        )
      }
    }
  }

  return errors
}

// ── fixtures ─────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function listFixtures() {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(FIXTURES_DIR, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort()
}

function loadFixture(name) {
  const dir = join(FIXTURES_DIR, name)
  const schema = readJson(join(FIXTURES_DIR, 'manifest.schema.json'))
  const manifest = readJson(join(dir, 'manifest.json'))
  const errors = validateSchema(schema, manifest)
  if (manifest.name !== name) {
    errors.push(`name: "${manifest.name}" does not match the directory name "${name}"`)
  }
  if (!existsSync(join(dir, 'expected.json'))) errors.push('expected.json is missing')
  if (errors.length) return { name, dir, schemaErrors: errors }

  const expected = readJson(join(dir, 'expected.json'))
  if (Boolean(manifest.expectError) !== Boolean(expected.error)) {
    return {
      name,
      dir,
      schemaErrors: ['manifest.expectError and expected.json disagree about whether this case fails'],
    }
  }
  return { name, dir, manifest, expected, tree: join(dir, 'tree') }
}

/** Every file named `dot-git` under a fixture tree — see fixtures/README.md. */
function findDotGitMarkers(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) findDotGitMarkers(p, out)
    else if (entry.name === 'dot-git') out.push(p)
  }
  return out
}

/**
 * Materialize the `.git` markers and permission bits a fixture describes, run `body`, and undo
 * all of it — in a finally, so an interrupted run cannot leave an unreadable file or a stray
 * `.git` in the working tree.
 */
function withPreparedTree(fixture, body) {
  const created = []
  const restored = []
  try {
    for (const marker of findDotGitMarkers(fixture.tree)) {
      const dotGit = join(dirname(marker), '.git')
      if (!existsSync(dotGit)) {
        writeFileSync(dotGit, '')
        created.push(dotGit)
      }
    }
    for (const [rel, mode] of Object.entries(fixture.manifest.chmod ?? {})) {
      const target = join(fixture.tree, rel)
      restored.push([target, statSync(target).mode & 0o7777])
      chmodSync(target, parseInt(mode, 8))
    }
    return body()
  } finally {
    for (const [target, mode] of restored) {
      try {
        chmodSync(target, mode)
      } catch {
        /* the probe cannot have removed it, but never mask the real failure */
      }
    }
    for (const dotGit of created) {
      try {
        rmSync(dotGit, { force: true })
      } catch {
        /* same */
      }
    }
  }
}

/**
 * A mode of `000` does not always deny: an inherited ACL (macOS `/Users/Shared` is the one
 * that bit us) can grant read back, and root ignores the bits entirely. Call this once the
 * mode is applied — if the file is still readable, the case cannot be expressed on this
 * filesystem and must skip. Reporting a FAIL there would blame the implementation for the
 * environment.
 */
function unenforceableMode(fixture) {
  for (const [rel, mode] of Object.entries(fixture.manifest.chmod ?? {})) {
    if (parseInt(mode, 8) & 0o400) continue
    const target = join(fixture.tree, rel)
    try {
      readFileSync(target)
    } catch {
      continue
    }
    return `mode ${mode} does not deny read here — an ACL or a privileged user overrides it (${rel})`
  }
  return null
}

// ── probes ───────────────────────────────────────────────────────────────────

function isExecutable(file) {
  try {
    return statSync(file).isFile() && (statSync(file).mode & 0o111) !== 0
  } catch {
    return false
  }
}

function languageProbe(lang) {
  const dir = join(PACKAGES_DIR, lang, 'conformance')
  return { lang, dir, exe: join(dir, 'run'), cwd: join(PACKAGES_DIR, lang) }
}

function registeredProbes() {
  return LANGUAGES.map(languageProbe).filter((p) => isExecutable(p.exe))
}

function runProbe(probe, fixture) {
  const { manifest, tree } = fixture
  const env = Object.fromEntries(
    Object.entries(manifest.env ?? {}).map(([k, v]) => [k, v.replaceAll('${TREE}', tree)]),
  )
  const args = [
    '--package-name', manifest.packageName,
    '--cwd', join(tree, manifest.cwd),
    '--home', join(tree, manifest.home),
    '--fixture-root', tree,
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    '--options', JSON.stringify(manifest.options ?? {}),
  ]
  const result = spawnSync(probe.exe, args, {
    cwd: probe.cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // The probe's own environment is not the fixture's environment: PROBE.md section 3 puts
    // every value the library may see behind --env. PATH still has to work, so the ambient
    // environment is passed through minus anything that could leak into the prefixed layer.
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith(manifest.packageName.toUpperCase() + '_') && k !== 'XDG_CONFIG_HOME',
      ),
    ),
  })
  return { args, ...result }
}

// ── one case ─────────────────────────────────────────────────────────────────

const STATUS = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', error: 'ERROR' }

function evaluate(fixture, run) {
  const { manifest, expected } = fixture
  const code = run.status
  const stdout = run.stdout ?? ''

  if (run.error) return { status: STATUS.error, detail: `probe could not be spawned: ${run.error.message}` }
  if (code === null) return { status: STATUS.error, detail: `probe was killed by signal ${run.signal}` }
  if (code >= 2) {
    return { status: STATUS.error, detail: `probe exited ${code} — the harness is broken, the case is unproven` }
  }

  let actual
  try {
    actual = JSON.parse(stdout)
  } catch {
    const preview = stdout.length > 400 ? stdout.slice(0, 400) + '…' : stdout
    return {
      status: STATUS.fail,
      detail: `protocol failure: stdout is not one JSON document (PROBE.md section 4)\n    stdout was: ${JSON.stringify(preview)}`,
    }
  }

  if (manifest.expectError) {
    if (code !== 1) {
      return {
        status: STATUS.fail,
        detail: `expected error kind "${manifest.expectError.kind}" and exit 1, got exit ${code}`,
      }
    }
    const got = actual.error
    if (!got || typeof got !== 'object') {
      return { status: STATUS.fail, detail: 'exit 1 but stdout carried no "error" object' }
    }
    if (got.kind !== expected.error.kind) {
      return {
        status: STATUS.fail,
        detail: `error kind: expected "${expected.error.kind}", got ${JSON.stringify(got.kind)}`,
      }
    }
    if (expected.error.path !== undefined) {
      const gotPath = canonicalize({ path: got.path }).path
      if (gotPath !== expected.error.path) {
        return {
          status: STATUS.fail,
          detail: `error path: expected "${expected.error.path}", got ${JSON.stringify(gotPath ?? null)}`,
        }
      }
    }
    return { status: STATUS.pass }
  }

  if (code !== 0) {
    return {
      status: STATUS.fail,
      detail: `expected a result, got exit 1 with ${JSON.stringify(actual.error ?? actual)}`,
    }
  }

  const entries = diffCanonical(canonicalize(expected), canonicalize(actual))
  if (entries.length === 0) return { status: STATUS.pass }
  return { status: STATUS.fail, detail: `${entries.length} difference(s)\n${formatDiff(entries)}`, entries }
}

function runCase(probe, name) {
  const fixture = loadFixture(name)
  if (fixture.schemaErrors) {
    return { name, status: STATUS.error, detail: `manifest schema:\n    ${fixture.schemaErrors.join('\n    ')}` }
  }
  if ((fixture.manifest.skipOn ?? []).includes(process.platform)) {
    return { name, status: STATUS.skip, detail: `not expressible on ${process.platform}` }
  }
  if (Object.keys(fixture.manifest.chmod ?? {}).length > 0 && process.getuid?.() === 0) {
    return { name, status: STATUS.skip, detail: 'running as root: permission bits do not deny root' }
  }

  const run = withPreparedTree(fixture, () => {
    const unenforceable = unenforceableMode(fixture)
    return unenforceable ? { skip: unenforceable } : runProbe(probe, fixture)
  })
  if (run.skip) return { name, status: STATUS.skip, detail: run.skip }

  const outcome = evaluate(fixture, run)
  return { name, stderr: run.stderr, ...outcome }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `Usage: node packages/spec/runner/run.mjs [options]

Runs the conformance fixture suite against one probe (see packages/spec/PROBE.md).

Options:
  --probe <lang>        Run packages/<lang>/conformance/run. One of: ${LANGUAGES.join(', ')}.
  --probe-path <dir>    Run <dir>/run instead of a registered language. Used by the runner's
                        own tests to point at the reference probe without pretending it is a
                        language package.
  --fixture <name>      Run one case instead of all of them.
  --list                List every fixture and every registered probe, then exit.
  --help                This text.

With no options, prints which language packages have a probe and exits 0.

Exit codes: 0 everything passed · 1 at least one failure · 2 unknown probe, unknown fixture,
or bad usage.`

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const takesValue = ['--probe', '--probe-path', '--fixture']
    if (takesValue.includes(arg)) {
      if (i + 1 >= argv.length) return { error: `${arg} requires a value` }
      opts[arg.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i]
    } else if (arg === '--list') opts.list = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else return { error: `unknown argument: ${arg}` }
  }
  return opts
}

function main(argv) {
  const opts = parseArgs(argv)
  if (opts.error) {
    console.error(opts.error)
    console.error(HELP)
    return EXIT.usage
  }
  if (opts.help) {
    console.log(HELP)
    return EXIT.ok
  }

  const fixtures = listFixtures()

  if (opts.list) {
    console.log(`fixtures (${fixtures.length}):`)
    for (const f of fixtures) console.log(`  ${f}`)
    const probes = registeredProbes()
    console.log(`registered probes (${probes.length}):`)
    for (const p of probes) console.log(`  ${p.lang} -> ${relative(PACKAGES_DIR, p.exe)}`)
    if (probes.length === 0) console.log('  (none)')
    return EXIT.ok
  }

  if (!opts.probe && !opts.probePath) {
    console.log('language packages:')
    for (const lang of LANGUAGES) {
      const probe = languageProbe(lang)
      const state = isExecutable(probe.exe)
        ? 'probe registered'
        : existsSync(join(PACKAGES_DIR, lang))
          ? 'directory present, no executable conformance/run'
          : 'absent'
      console.log(`  ${lang.padEnd(7)} ${state}`)
    }
    console.log(`\n${fixtures.length} fixtures. Pass --probe <lang> to run them.`)
    return EXIT.ok
  }

  let probe
  if (opts.probePath) {
    const dir = resolve(process.cwd(), opts.probePath)
    probe = { lang: basename(dir), dir, exe: join(dir, 'run'), cwd: dir }
    if (!isExecutable(probe.exe)) {
      console.error(`no executable probe at ${probe.exe}`)
      return EXIT.usage
    }
  } else {
    if (!LANGUAGES.includes(opts.probe)) {
      console.error(`unknown probe "${opts.probe}" — expected one of: ${LANGUAGES.join(', ')}`)
      return EXIT.usage
    }
    probe = languageProbe(opts.probe)
    if (!isExecutable(probe.exe)) {
      console.error(
        `${opts.probe} is not registered: ${relative(PACKAGES_DIR, probe.exe)} is missing or not executable`,
      )
      return EXIT.usage
    }
  }

  let selected = fixtures
  if (opts.fixture) {
    if (!fixtures.includes(opts.fixture)) {
      console.error(`unknown fixture "${opts.fixture}"`)
      return EXIT.usage
    }
    selected = [opts.fixture]
  }

  console.log(`probe: ${probe.lang} (${probe.exe})`)
  const counts = { PASS: 0, FAIL: 0, SKIP: 0, ERROR: 0 }
  const bad = []
  for (const name of selected) {
    const result = runCase(probe, name)
    counts[result.status]++
    console.log(`${result.status.padEnd(5)} ${name}${result.detail ? ` — ${result.detail}` : ''}`)
    if (result.status !== STATUS.pass && result.status !== STATUS.skip) {
      bad.push(result.name)
      if (result.stderr?.trim()) {
        console.log(result.stderr.trimEnd().replace(/^/gm, '    stderr | '))
      }
    }
  }

  console.log(
    `\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.ERROR} errored, ${counts.SKIP} skipped` +
      (bad.length ? `\nnot passing: ${bad.join(', ')}` : ''),
  )
  return bad.length ? EXIT.failure : EXIT.ok
}

// This module is a CLI, not a library: the tests in run.test.mjs spawn it, exactly as CI does,
// so what they exercise is the real process contract rather than an in-process shortcut.
process.exit(main(process.argv.slice(2)))

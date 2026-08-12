// Tests for the conformance runner itself.
//
// The suite's whole value is that it goes red when an implementation is wrong. A harness that
// has only ever been observed green is not known to detect anything, so these tests drive it
// against a correct probe, a probe with one seeded defect, and two probes that violate the
// process contract in different ways.
//
//   node --test packages/spec/runner/run.test.mjs

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const RUNNER = join(HERE, 'run.mjs')
const REFERENCE = join(HERE, 'reference')
const BROKEN = join(REFERENCE, 'broken')
const FIXTURES = resolve(HERE, '../fixtures')

const scratch = mkdtempSync(join(tmpdir(), 'conformance-runner-test-'))
const temporaryFixtures = []
after(() => {
  rmSync(scratch, { recursive: true, force: true })
  for (const dir of temporaryFixtures) rmSync(dir, { recursive: true, force: true })
})

function runRunner(...args) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], { cwd: REPO, encoding: 'utf8' })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

/** Every fixture line the runner printed, as {status, name, detail}. */
function results(out) {
  return out
    .split('\n')
    .map((line) => /^(PASS|FAIL|SKIP|ERROR)\s+(\S+)(?:\s+—\s+(.*))?$/.exec(line))
    .filter(Boolean)
    .map(([, status, name, detail]) => ({ status, name, detail: detail ?? '' }))
}

const namesWith = (out, status) => results(out).filter((r) => r.status === status).map((r) => r.name)

/** A throwaway probe directory holding one `run` script. */
function makeProbe(name, script) {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  const exe = join(dir, 'run')
  writeFileSync(exe, script)
  chmodSync(exe, 0o755)
  return dir
}

describe('the reference probe', () => {
  test('passes every fixture', () => {
    const { code, out } = runRunner('--probe-path', REFERENCE)
    assert.equal(code, 0, `runner exited ${code}:\n${out}`)
    assert.deepEqual(namesWith(out, 'FAIL'), [])
    assert.deepEqual(namesWith(out, 'ERROR'), [])
    assert.ok(namesWith(out, 'PASS').length >= 12, 'expected at least twelve passing fixtures')
  })
})

describe('the probe with a seeded defect', () => {
  const { code, out } = runRunner('--probe-path', BROKEN)

  test('fails the run', () => {
    assert.equal(code, 1)
  })

  test('fails exactly the fixture the defect breaks, and no other', () => {
    assert.deepEqual(namesWith(out, 'FAIL'), ['both-array-replace'])
    assert.deepEqual(namesWith(out, 'ERROR'), [])
    // The defect is arrays-concatenated-instead-of-replaced, so the case that opted into
    // concatenation must still pass. A suite that went red everywhere would prove nothing
    // about localization.
    assert.ok(namesWith(out, 'PASS').includes('both-array-concat'))
  })

  test('names the offending key path and both values in the diff', () => {
    assert.match(out, /config\.plugins/)
    assert.match(out, /expected "c", got "a"/)
  })
})

describe('the process contract', () => {
  test('a log line before the JSON is a protocol failure, not a diff', () => {
    const noisy = makeProbe(
      'noisy',
      `#!/bin/sh\necho "loading configuration..."\nexec node ${join(REFERENCE, 'probe.mjs')} "$@"\n`,
    )
    const { code, out } = runRunner('--probe-path', noisy, '--fixture', 'local-only')
    assert.equal(code, 1)
    const [result] = results(out)
    assert.equal(result.status, 'FAIL')
    assert.match(result.detail, /protocol failure/)
    assert.doesNotMatch(result.detail, /difference\(s\)/)
  })

  test('exit 2 is a harness error, distinct from a load error', () => {
    const broken = makeProbe('exit-two', '#!/bin/sh\necho "could not build" >&2\nexit 2\n')
    const { code, out } = runRunner('--probe-path', broken, '--fixture', 'local-only')
    assert.equal(code, 1)
    const [result] = results(out)
    assert.equal(result.status, 'ERROR')
    assert.match(result.detail, /harness is broken/)
    assert.match(out, /stderr \| could not build/)

    // A load error, by contrast, is a fixture-level verdict and never an ERROR.
    const loadError = runRunner('--probe-path', REFERENCE, '--fixture', 'malformed-toml')
    assert.equal(loadError.code, 0)
    assert.equal(results(loadError.out)[0].status, 'PASS')
  })
})

describe('skipOn', () => {
  test('skips rather than passes, and the summary counts it', () => {
    const name = `zz-selftest-skip-${process.pid}`
    const dir = join(FIXTURES, name)
    temporaryFixtures.push(dir)
    mkdirSync(join(dir, 'tree', 'project'), { recursive: true })
    mkdirSync(join(dir, 'tree', 'home'), { recursive: true })
    writeFileSync(join(dir, 'tree', 'project', 'dot-git'), '')
    writeFileSync(join(dir, 'tree', 'home', '.gitkeep'), '')
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          name,
          description: 'Synthesized by run.test.mjs to prove skipOn skips instead of passing.',
          specClause: '5',
          packageName: 'mytool',
          cwd: 'project',
          home: 'home',
          skipOn: [process.platform],
        },
        null,
        2,
      ),
    )
    // Deliberately unsatisfiable: were the case run instead of skipped, it would fail.
    writeFileSync(
      join(dir, 'expected.json'),
      JSON.stringify({ config: { never: 'reached' }, found: true, sources: [] }, null, 2),
    )

    const { code, out } = runRunner('--probe-path', REFERENCE, '--fixture', name)
    assert.equal(code, 0)
    assert.deepEqual(namesWith(out, 'SKIP'), [name])
    assert.deepEqual(namesWith(out, 'PASS'), [])
    assert.match(out, /0 passed, 0 failed, 0 errored, 1 skipped/)
  })
})

describe('usage', () => {
  test('--list reports every fixture', () => {
    const { code, out } = runRunner('--list')
    assert.equal(code, 0)
    assert.match(out, /both-array-replace/)
    assert.match(out, /registered probes/)
  })

  test('an unknown probe exits 2', () => {
    assert.equal(runRunner('--probe', 'nope').code, 2)
  })

  test('an unknown fixture exits 2', () => {
    assert.equal(runRunner('--probe-path', REFERENCE, '--fixture', 'no-such-case').code, 2)
  })

  test('--probe-path is documented in --help', () => {
    const { code, out } = runRunner('--help')
    assert.equal(code, 0)
    assert.match(out, /--probe-path/)
  })
})

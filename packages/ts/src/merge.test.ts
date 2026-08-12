import { describe, expect, it } from 'vitest'

import { applyStrategy, isPlainObject, mergeLayers } from './merge.js'
import type { Layer } from './merge.js'
import { warningCollector } from './test-utils.js'
import type { Format } from './types.js'

/** A file layer at `root`, so `first-match` has something to filter on. */
function layer(value: unknown, root?: string, precedence = 2, format: Format = 'toml'): Layer {
  return {
    value,
    ...(root === undefined ? {} : { root }),
    source: { path: root === undefined ? '<env>' : `${root}/config.toml`, format, precedence, keys: [] },
  }
}

// The cases below mirror the conformance fixtures one to one, so a unit failure and a
// conformance failure point at the same line of SPEC.
describe('mergeLayers — the fixture cases', () => {
  it('both-scalar-conflict: the higher layer wins', () => {
    expect(
      mergeLayers([layer({ log: { level: 'info' } }, '/user', 1), layer({ log: { level: 'debug' } }, '/project')]),
    ).toEqual({ log: { level: 'debug' } })
  })

  it('both-nested-map-merge: maps merge key by key instead of replacing', () => {
    expect(
      mergeLayers([
        layer({ database: { host: 'db.example.com', port: 5432 } }, '/user', 1),
        layer({ database: { port: 6543 } }, '/project'),
      ]),
    ).toEqual({ database: { host: 'db.example.com', port: 6543 } })
  })

  it('both-array-replace: arrays replace wholesale', () => {
    expect(
      mergeLayers([layer({ plugins: ['a', 'b'] }, '/user', 1), layer({ plugins: ['c'] }, '/project')]),
    ).toEqual({ plugins: ['c'] })
  })

  it('both-array-concat: concat appends and does not deduplicate', () => {
    expect(
      mergeLayers(
        [layer({ plugins: ['a', 'b'] }, '/user', 1), layer({ plugins: ['b', 'c'] }, '/project')],
        { arrayMerge: 'concat' },
      ),
    ).toEqual({ plugins: ['a', 'b', 'b', 'c'] })
  })

  it('explicit-null-unsets: null deletes, undefined is absent', () => {
    expect(mergeLayers([layer({ a: 1 }, '/user', 1), layer({ a: null }, '/project')])).toEqual({})
    // The two must never be conflated: absent means "the higher layer said nothing".
    expect(mergeLayers([layer({ a: 1 }, '/user', 1), layer({ a: undefined }, '/project')])).toEqual({ a: 1 })
  })
})

describe('mergeLayers — type conflicts', () => {
  it('replaces a map with a scalar and warns', () => {
    const { warnings, onWarning } = warningCollector()
    expect(
      mergeLayers([layer({ log: { level: 'info' } }, '/user', 1), layer({ log: 'debug' }, '/project')], {
        onWarning,
      }),
    ).toEqual({ log: 'debug' })
    expect(warnings[0]).toMatch(/log: replacing a map with a scalar/)
  })

  it('replaces a scalar with a map and warns', () => {
    const { warnings, onWarning } = warningCollector()
    expect(
      mergeLayers([layer({ log: 'info' }, '/user', 1), layer({ log: { level: 'debug' } }, '/project')], {
        onWarning,
      }),
    ).toEqual({ log: { level: 'debug' } })
    expect(warnings[0]).toMatch(/log: replacing a scalar with a map/)
  })
})

describe('mergeLayers — untrusted input', () => {
  it('never lets a config file reach Object.prototype', () => {
    const { warnings, onWarning } = warningCollector()
    const polluted = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "ok": 2}') as Record<
      string,
      unknown
    >
    const result = mergeLayers([layer(polluted, '/project')], { onWarning })

    expect(result).toEqual({ ok: 2 })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(warnings).toHaveLength(2)
  })
})

describe('applyStrategy', () => {
  const defaults = layer({ d: 1 })
  const user = layer({ log: { level: 'info' } }, '/user', 1)
  const project = layer({ log: { level: 'debug' } }, '/project')
  const env = layer({ log: { level: 'trace' } }, undefined, 4)

  it('layered keeps every layer', () => {
    expect(applyStrategy([defaults, user, project, env], 'layered')).toHaveLength(4)
  })

  it('first-match drops lower roots from the merge and from sources', () => {
    const kept = applyStrategy([defaults, user, project, env], 'first-match')
    // The user layer is gone entirely — not merged, and not reported. `first-match` means the
    // lower root was never consulted, not that it lost.
    expect(kept).toEqual([defaults, project, env])
    expect(mergeLayers(kept)).toEqual({ d: 1, log: { level: 'trace' } })
  })

  it('first-match keeps every file layer of the winning root', () => {
    const dotenv = { ...layer({ log: { level: 'from-dotenv' } }, '/project', 3, 'dotenv') }
    expect(applyStrategy([user, project, dotenv], 'first-match')).toEqual([project, dotenv])
  })
})

describe('isPlainObject', () => {
  it('accepts plain and null-prototype objects and rejects everything else', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null) as object)).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })
})

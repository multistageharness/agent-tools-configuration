import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { coerceValue, envKeyPath, envLayer } from './env.js'
import type { Layer } from './merge.js'
import { buildSources } from './sources.js'
import { warningCollector } from './test-utils.js'

describe('coercion — SPEC §4.5 step 5', () => {
  it.each([
    { raw: '5432', expected: 5432 as unknown, type: 'number' },
    { raw: 'true', expected: true as unknown, type: 'boolean' },
    { raw: '[1,2]', expected: [1, 2] as unknown, type: 'array' },
    { raw: '5432abc', expected: '5432abc' as unknown, type: 'string' },
  ])('$raw becomes the $type', ({ raw, expected }) => {
    expect(coerceValue(raw)).toEqual(expected)
  })

  it('keeps a value the caller says was quoted as a string', () => {
    expect(coerceValue('5432', true)).toBe('5432')
  })
})

describe('envKeyPath', () => {
  it('splits on __ and leaves a single underscore literal', () => {
    expect(envKeyPath('LOG__LEVEL')).toEqual(['log', 'level'])
    expect(envKeyPath('SOME_KEY')).toEqual(['some_key'])
    expect(envKeyPath('A__B__C')).toEqual(['a', 'b', 'c'])
  })
})

describe('envLayer', () => {
  it('maps MYTOOL_LOG__LEVEL to a nested key', () => {
    expect(envLayer({ MYTOOL_LOG__LEVEL: 'trace' }, 'MYTOOL')).toEqual({ log: { level: 'trace' } })
  })

  it('keeps a single underscore inside the key name', () => {
    expect(envLayer({ MYTOOL_SOME_KEY: '1' }, 'MYTOOL')).toEqual({ some_key: 1 })
  })

  it('ignores variables without the prefix', () => {
    expect(envLayer({ OTHER_LOG__LEVEL: 'trace', PATH: '/usr/bin' }, 'MYTOOL')).toEqual({})
  })

  it('warns about a variable that maps to an empty key path', () => {
    const { warnings, onWarning } = warningCollector()
    expect(envLayer({ MYTOOL_: 'x' }, 'MYTOOL', onWarning)).toEqual({})
    expect(warnings[0]).toMatch(/empty key path/)
  })
})

describe('buildSources', () => {
  const layerAt = (path: string, value: unknown, precedence: number): Layer => ({
    value,
    source: { path, format: 'toml', precedence, keys: [] },
  })

  it('reports the top-level keys each source contributed, sorted', () => {
    const sources = buildSources([layerAt('/abs/a/config.toml', { b: 1, a: 2 }, 2)])
    expect(sources[0]?.keys).toEqual(['a', 'b'])
  })

  it('includes a source whose file parsed empty, with no keys', () => {
    expect(buildSources([layerAt('/abs/a/config.toml', {}, 2)])[0]?.keys).toEqual([])
  })

  it('rewrites paths relative to relativeTo, forward-slashed', () => {
    const root = ['', 'abs', 'fixture'].join(sep)
    const file = ['', 'abs', 'fixture', 'project', '.config', 'mytool', 'config.toml'].join(sep)
    expect(buildSources([layerAt(file, {}, 2)], { relativeTo: root })[0]?.path).toBe(
      'project/.config/mytool/config.toml',
    )
  })

  it('leaves the non-file layer labels alone', () => {
    const sources = buildSources([{ value: { a: 1 }, source: { path: '<env>', format: 'env', precedence: 4, keys: [] } }], {
      relativeTo: '/abs/fixture',
    })
    expect(sources[0]?.path).toBe('<env>')
  })

  it('preserves application order rather than sorting by precedence', () => {
    // A user-level .env is precedence 3 but belongs inside the user root's block, so it must
    // still be emitted before the project files that outrank it (SPEC §3.1).
    const order = buildSources([
      layerAt('/u/config.toml', {}, 1),
      layerAt('/u/.env', {}, 3),
      layerAt('/p/config.toml', {}, 2),
    ]).map((source) => source.precedence)
    expect(order).toEqual([1, 3, 2])
  })
})

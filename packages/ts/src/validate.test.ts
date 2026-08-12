import { join } from 'node:path'
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest'

import { ConfigError } from './errors.js'
import { load } from './index.js'
import { cleanupTrees, makeTree, warningCollector } from './test-utils.js'
import type { StandardSchemaV1 } from './types.js'
import { validateConfig } from './validate.js'

afterAll(cleanupTrees)

/**
 * A hand-written Standard Schema. No validator appears in dependencies *or* devDependencies —
 * the whole point of the interface is that this package never needs one.
 */
function schemaOf<Output>(
  validate: (value: unknown) => StandardSchemaV1.Result<Output>,
  shape?: Record<string, unknown>,
): StandardSchemaV1<unknown, Output> {
  return {
    '~standard': { version: 1, vendor: 'handwritten', validate },
    ...(shape === undefined ? {} : { shape }),
  } as StandardSchemaV1<unknown, Output>
}

const portSchema = schemaOf<{ port: number }>(
  (value) => {
    const port = (value as { port?: unknown }).port
    if (typeof port !== 'number') {
      return { issues: [{ message: 'port must be a number', path: ['port'] }] }
    }
    return { value: { port } }
  },
  { port: null },
)

describe('validateConfig', () => {
  it('raises kind validation with the failing key path', async () => {
    try {
      await validateConfig({ port: 'nope' }, portSchema)
      expect.unreachable('expected a validation error')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).kind).toBe('validation')
      expect((error as ConfigError).keyPath).toBe('port')
    }
  })

  it('carries every issue, not only the one it names', async () => {
    const multi = schemaOf(() => ({
      issues: [
        { message: 'a is wrong', path: ['a'] },
        { message: 'b is wrong', path: ['b', 'c'] },
      ],
    }))
    const error = (await validateConfig({}, multi).catch((e: unknown) => e)) as ConfigError
    expect(error.keyPath).toBe('a')
    expect(error.issues).toHaveLength(2)
  })

  it('understands the {key} form of an issue path segment', async () => {
    const nested = schemaOf(() => ({ issues: [{ message: 'nope', path: [{ key: 'db' }, { key: 'port' }] }] }))
    const error = (await validateConfig({}, nested).catch((e: unknown) => e)) as ConfigError
    expect(error.keyPath).toBe('db.port')
  })

  it('returns the validator’s output, so a coercing schema changes the result', async () => {
    const coercing = schemaOf<{ port: number }>((value) => ({
      value: { port: Number((value as { port: unknown }).port) },
    }))
    expect(await validateConfig({ port: '5432' }, coercing)).toEqual({ port: 5432 })
  })
})

describe('strict', () => {
  it('warns about an unknown key by default', async () => {
    const { warnings, onWarning } = warningCollector()
    await validateConfig({ port: 1, extra: true }, portSchema, { onWarning })
    expect(warnings[0]).toMatch(/unknown keys: extra/)
  })

  it('raises kind unknown-key under strict', async () => {
    await expect(validateConfig({ port: 1, extra: true }, portSchema, { strict: true })).rejects.toMatchObject({
      kind: 'unknown-key',
      keyPath: 'extra',
    })
  })

  it('says nothing when the validator does not expose its keys', async () => {
    const opaque = schemaOf((value) => ({ value }))
    const { warnings, onWarning } = warningCollector()
    await validateConfig({ anything: true }, opaque, { strict: true, onWarning })
    expect(warnings).toEqual([])
  })
})

describe('load with a schema', () => {
  it('narrows the result type to the schema’s output', async () => {
    const tree = makeTree({ 'project/.git': '', 'project/.config/mytool/config.toml': 'port = 5432\n' })
    const result = await load('mytool', {
      cwd: join(tree, 'project'),
      home: join(tree, 'home'),
      env: {},
      schema: portSchema,
    })
    expect(result.config).toEqual({ port: 5432 })
    expectTypeOf(result.config).toEqualTypeOf<{ port: number }>()
    expectTypeOf(result.config.port).toBeNumber()
  })

  it('turns a schema failure into a ConfigError from load itself', async () => {
    const tree = makeTree({ 'project/.git': '', 'project/.config/mytool/config.toml': 'port = "nope"\n' })
    await expect(
      load('mytool', { cwd: join(tree, 'project'), home: join(tree, 'home'), env: {}, schema: portSchema }),
    ).rejects.toMatchObject({ kind: 'validation', keyPath: 'port' })
  })
})

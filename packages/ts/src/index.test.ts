import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { ConfigError, isConfigError } from './errors.js'
import type { ConfigErrorKind } from './errors.js'
import { load, loadSync } from './index.js'
import { cleanupTrees, makeTree } from './test-utils.js'
import type { Loaded } from './types.js'

afterAll(cleanupTrees)

const base = (tree: string) => ({ cwd: join(tree, 'project'), home: join(tree, 'home'), env: {} })

describe('load — end to end', () => {
  it('local only', async () => {
    const tree = makeTree({
      'project/.git': '',
      'project/.config/mytool/config.toml': '[log]\nlevel = "debug"\n',
      'home/.gitkeep': '',
    })
    const result = await load('mytool', base(tree))
    expect(result.config).toEqual({ log: { level: 'debug' } })
    expect(result.found).toBe(true)
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ format: 'toml', precedence: 2, keys: ['log'] })
  })

  it('user only', async () => {
    const tree = makeTree({
      'project/.git': '',
      'home/.config/mytool/config.toml': '[log]\nlevel = "info"\n',
    })
    const result = await load('mytool', base(tree))
    expect(result.config).toEqual({ log: { level: 'info' } })
    expect(result.sources[0]?.precedence).toBe(1)
  })

  it('neither present is not an error', async () => {
    const tree = makeTree({ 'project/.git': '', 'home/.gitkeep': '' })
    const result = await load('mytool', base(tree))
    expect(result).toEqual({ config: {}, found: false, sources: [] })
  })

  it('neither present still returns the defaults, and defaults do not set found', async () => {
    const tree = makeTree({ 'project/.git': '', 'home/.gitkeep': '' })
    const result = await load('mytool', { ...base(tree), defaults: { log: { level: 'warn' } } })
    expect(result.config).toEqual({ log: { level: 'warn' } })
    expect(result.found).toBe(false)
    expect(result.sources.map((s) => s.format)).toEqual(['defaults'])
  })

  it('three layers conflict and the highest wins, with the losers still reported', async () => {
    const tree = makeTree({
      'project/.git': '',
      'project/.config/mytool/config.toml': '[log]\nlevel = "debug"\n',
      'home/.config/mytool/config.toml': '[log]\nlevel = "info"\n',
    })
    const result = await load('mytool', {
      ...base(tree),
      env: { MYTOOL_LOG__LEVEL: 'trace', MYTOOL_PORT: '5432' },
    })
    expect(result.config).toEqual({ log: { level: 'trace' }, port: 5432 })
    expect(result.sources.map((s) => s.precedence)).toEqual([1, 2, 4])
  })

  it('applies programmatic overrides above everything else', async () => {
    const tree = makeTree({
      'project/.git': '',
      'project/.config/mytool/config.toml': '[log]\nlevel = "debug"\n',
      'home/.gitkeep': '',
    })
    const result = await load('mytool', {
      ...base(tree),
      env: { MYTOOL_LOG__LEVEL: 'trace' },
      overrides: { log: { level: 'silent' } },
    })
    expect(result.config).toEqual({ log: { level: 'silent' } })
    expect(result.sources.at(-1)).toMatchObject({ format: 'overrides', precedence: 5 })
  })

  it('rejects a package name that is not a single path segment', async () => {
    await expect(load('../evil')).rejects.toBeInstanceOf(TypeError)
  })
})

describe('load and loadSync agree', () => {
  const cases: { name: string; files: Record<string, string>; env?: Record<string, string> }[] = [
    { name: 'local only', files: { 'project/.git': '', 'project/.config/mytool/config.toml': 'a = 1\n', 'home/.gitkeep': '' } },
    { name: 'user only', files: { 'project/.git': '', 'home/.config/mytool/config.yaml': 'a: 2\n' } },
    { name: 'neither', files: { 'project/.git': '', 'home/.gitkeep': '' } },
    {
      name: 'every layer',
      files: {
        'project/.git': '',
        'project/.config/mytool/config.toml': '[log]\nlevel = "debug"\n',
        'project/.config/mytool/.env': 'LOG__LEVEL=dotenv\n',
        'home/.config/mytool/config.toml': '[log]\nlevel = "info"\n',
      },
      env: { MYTOOL_PORT: '5432' },
    },
  ]

  it.each(cases)('$name', async ({ files, env }) => {
    const tree = makeTree(files)
    const options = { ...base(tree), env: env ?? {} }
    const asynchronous: Loaded<unknown> = await load('mytool', options)
    const synchronous: Loaded<unknown> = loadSync('mytool', options)
    expect(synchronous).toEqual(asynchronous)
  })
})

describe('every ConfigError kind', () => {
  const kinds = new Set<ConfigErrorKind>()

  it('malformed', async () => {
    const tree = makeTree({ 'project/.git': '', 'project/.config/mytool/config.toml': '[log\n', 'home/.gitkeep': '' })
    const error = (await load('mytool', base(tree)).catch((e: unknown) => e)) as ConfigError
    expect(error.kind).toBe('malformed')
    expect(error.path).toContain('config.toml')
    kinds.add(error.kind)
  })

  it('duplicate-format', async () => {
    const tree = makeTree({
      'project/.git': '',
      'project/.config/mytool/config.yaml': 'a: 1\n',
      'project/.config/mytool/config.yml': 'a: 2\n',
      'home/.gitkeep': '',
    })
    const error = (await load('mytool', base(tree)).catch((e: unknown) => e)) as ConfigError
    expect(error.kind).toBe('duplicate-format')
    kinds.add(error.kind)
  })

  it('unreadable', async () => {
    // A directory where a file belongs: EISDIR. chmod 000 is not portable — an inherited ACL
    // or a privileged user makes it a no-op — so the fixture suite skips that case and this
    // test takes the deterministic route to the same code path.
    const tree = makeTree({ 'project/.git': '', 'project/.config/mytool/config.toml/': '', 'home/.gitkeep': '' })
    const error = (await load('mytool', base(tree)).catch((e: unknown) => e)) as ConfigError
    expect(error.kind).toBe('unreadable')
    kinds.add(error.kind)
  })

  it('validation and unknown-key', async () => {
    const tree = makeTree({ 'project/.git': '', 'project/.config/mytool/config.toml': 'port = "x"\nextra = 1\n', 'home/.gitkeep': '' })
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'handwritten',
        validate: (value: unknown) =>
          typeof (value as { port: unknown }).port === 'number'
            ? { value: value as { port: number } }
            : { issues: [{ message: 'port must be a number', path: ['port'] }] },
      },
      shape: { port: null },
    }
    const validation = (await load('mytool', { ...base(tree), schema }).catch((e: unknown) => e)) as ConfigError
    expect(validation.kind).toBe('validation')
    kinds.add(validation.kind)

    const strict = (await load('mytool', { ...base(tree), schema, strict: true }).catch(
      (e: unknown) => e,
    )) as ConfigError
    expect(strict.kind).toBe('unknown-key')
    kinds.add(strict.kind)
  })

  it('not-found is a kind that is never thrown', async () => {
    const tree = makeTree({ 'project/.git': '', 'home/.gitkeep': '' })
    await expect(load('mytool', base(tree))).resolves.toMatchObject({ found: false })
    // It exists so a caller can name the condition (SPEC §5), not so it can be raised.
    const constructed = new ConfigError('not-found', 'nothing anywhere')
    expect(isConfigError(constructed)).toBe(true)
    kinds.add(constructed.kind)

    expect([...kinds].sort()).toEqual([
      'duplicate-format',
      'malformed',
      'not-found',
      'unknown-key',
      'unreadable',
      'validation',
    ])
  })
})

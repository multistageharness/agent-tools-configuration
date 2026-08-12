import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { listConfigFiles } from './discover.js'
import { ConfigError } from './errors.js'
import { createExplorer, createExplorerSync, loadConfigFile, loadConfigFileSync, parseIni, parseDotenv } from './loaders.js'
import { cleanupTrees, makeTree } from './test-utils.js'

afterAll(cleanupTrees)

const explorer = () => createExplorer('mytool', { envPrefix: 'MYTOOL' })

describe('loaders', () => {
  it('round-trips every recognized format from one directory', async () => {
    const tree = makeTree({
      'c/config.toml': 'from_toml = true\n[nested]\nvalue = 1\n',
      'c/config.yaml': 'from_yaml: true\n',
      'c/config.json': '{"from_json": true}\n',
      'c/config.jsonc': '// a comment\n{"from_jsonc": true /* inline */}\n',
      'c/config.ini': '[section]\nport = 5432\nname = local\n',
      'c/.env': 'FROM__DOTENV=true\nPORT="5432"\n',
    })
    const dir = join(tree, 'c')
    const loaded: Record<string, unknown> = {}
    for (const ref of listConfigFiles(dir)) {
      Object.assign(loaded, await loadConfigFile(explorer(), ref))
    }
    expect(loaded).toEqual({
      from_toml: true,
      nested: { value: 1 },
      from_yaml: true,
      from_json: true,
      from_jsonc: true,
      section: { port: 5432, name: 'local' },
      from: { dotenv: true },
      // SPEC §4.6: a value written inside quotes stays a string.
      port: '5432',
    })
  })

  it('reports a malformed TOML with kind, path and a line number', async () => {
    const tree = makeTree({ 'c/config.toml': '[log\nlevel = \n' })
    const ref = { path: join(tree, 'c/config.toml'), format: 'toml' as const }
    try {
      await loadConfigFile(explorer(), ref)
      expect.unreachable('expected a malformed error')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      const configError = error as ConfigError
      expect(configError.kind).toBe('malformed')
      expect(configError.path).toBe(ref.path)
      expect(configError.line).toBe(1)
    }
  })

  it('reports malformed YAML through cosmiconfig’s own loader', async () => {
    const tree = makeTree({ 'c/config.yaml': 'a: [1,\nb: 2\n' })
    const ref = { path: join(tree, 'c/config.yaml'), format: 'yaml' as const }
    await expect(loadConfigFile(explorer(), ref)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('classifies a read failure as unreadable rather than malformed', async () => {
    // A directory where a file is expected: EISDIR, which is a read failure, not a parse one.
    const tree = makeTree({ 'c/config.toml/': '' })
    const ref = { path: join(tree, 'c/config.toml'), format: 'toml' as const }
    await expect(loadConfigFile(explorer(), ref)).rejects.toMatchObject({ kind: 'unreadable' })
  })

  it('treats a file that parsed empty as read, not as missing', async () => {
    const tree = makeTree({ 'c/config.toml': '\n# nothing but a comment\n' })
    const value = await loadConfigFile(explorer(), { path: join(tree, 'c/config.toml'), format: 'toml' })
    expect(value).toEqual({})
  })

  it('rejects a top level that is not a table', async () => {
    const tree = makeTree({ 'c/config.json': '[1, 2, 3]\n' })
    await expect(
      loadConfigFile(explorer(), { path: join(tree, 'c/config.json'), format: 'json' }),
    ).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('loads synchronously to the same value', () => {
    const tree = makeTree({ 'c/config.toml': 'a = 1\n' })
    const ref = { path: join(tree, 'c/config.toml'), format: 'toml' as const }
    expect(loadConfigFileSync(createExplorerSync('mytool', { envPrefix: 'MYTOOL' }), ref)).toEqual({ a: 1 })
  })
})

describe('parseIni', () => {
  it('handles sections, both comment characters, and SPEC §2.5 typing', () => {
    expect(
      parseIni('; leading comment\n[db]\nhost = localhost\nport = 5432\n# trailing\ndebug = true\n'),
    ).toEqual({ db: { host: 'localhost', port: 5432, debug: true } })
  })

  it('raises on a line that is not key = value', () => {
    expect(() => parseIni('[db]\nnonsense\n')).toThrow(/line 2/)
  })
})

describe('parseDotenv', () => {
  it('strips the prefix when present and leaves bare keys alone', () => {
    expect(parseDotenv('MYTOOL_LOG__LEVEL=trace\nPORT=5432\n', 'MYTOOL')).toEqual({
      log: { level: 'trace' },
      port: 5432,
    })
  })

  it('keeps a quoted value a string and coerces an unquoted one', () => {
    expect(parseDotenv('A="5432"\nB=5432\n', 'MYTOOL')).toEqual({ a: '5432', b: 5432 })
  })

  it('ignores comments and honors export', () => {
    expect(parseDotenv('# comment\nexport A=1\n', 'MYTOOL')).toEqual({ a: 1 })
  })
})

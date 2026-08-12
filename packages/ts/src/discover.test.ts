import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { listConfigFiles, resolveProjectRoots, resolveUserRoot } from './discover.js'
import { ConfigError } from './errors.js'
import { cleanupTrees, makeTree, warningCollector } from './test-utils.js'

afterAll(cleanupTrees)

describe('resolveProjectRoots', () => {
  it('finds a config directory two levels up', () => {
    const tree = makeTree({
      '.git': '',
      '.config/mytool/config.toml': 'a = 1\n',
      'a/b/.gitkeep': '',
    })
    expect(resolveProjectRoots(join(tree, 'a/b'), 'mytool')).toEqual([
      join(realpathSync(tree), '.config/mytool'),
    ])
  })

  it('returns roots farthest ancestor first', () => {
    const tree = makeTree({
      '.git': '',
      '.config/mytool/config.toml': 'a = 1\n',
      'pkg/.config/mytool/config.toml': 'a = 2\n',
      'pkg/src/.gitkeep': '',
    })
    const real = realpathSync(tree)
    // Order is the contract: the nearest root is last, and last is what wins.
    expect(resolveProjectRoots(join(tree, 'pkg/src'), 'mytool')).toEqual([
      join(real, '.config/mytool'),
      join(real, 'pkg/.config/mytool'),
    ])
  })

  it('stops at a .git directory between cwd and the config', () => {
    const tree = makeTree({
      '.config/mytool/config.toml': 'a = 1\n',
      'repo/.git/HEAD': 'ref: refs/heads/main\n',
      'repo/pkg/.gitkeep': '',
    })
    expect(resolveProjectRoots(join(tree, 'repo/pkg'), 'mytool')).toEqual([])
  })

  it('stops at a .git *file*, the form git uses for a worktree or submodule', () => {
    const tree = makeTree({
      '.config/mytool/config.toml': 'a = 1\n',
      'repo/.git': 'gitdir: /elsewhere/.git/worktrees/w\n',
      'repo/pkg/.gitkeep': '',
    })
    expect(resolveProjectRoots(join(tree, 'repo/pkg'), 'mytool')).toEqual([])
  })

  it('checks the stopDir itself before ending the walk', () => {
    const tree = makeTree({
      '.git': '',
      'pkg/.config/mytool/config.toml': 'a = 1\n',
      'pkg/src/.gitkeep': '',
    })
    const real = realpathSync(tree)
    // stopDir is inclusive: the directory holding the config is searched, then the walk ends.
    expect(
      resolveProjectRoots(join(tree, 'pkg/src'), 'mytool', { stopDir: join(tree, 'pkg') }),
    ).toEqual([join(real, 'pkg/.config/mytool')])
  })

  it('stops at the injected home directory, inclusive', () => {
    const tree = makeTree({
      '.git': '',
      'home/.config/mytool/config.toml': 'a = 1\n',
      'home/work/.gitkeep': '',
    })
    const real = realpathSync(tree)
    expect(
      resolveProjectRoots(join(tree, 'home/work'), 'mytool', { home: join(tree, 'home') }),
    ).toEqual([join(real, 'home/.config/mytool')])
  })

  it('raises rather than spinning when the walk goes pathologically deep', () => {
    const tree = makeTree({})
    const deep = join(tree, Array.from({ length: 70 }, (_, i) => `d${i}`).join('/'))
    mkdirSync(deep, { recursive: true })
    expect(() => resolveProjectRoots(deep, 'mytool')).toThrow(/exceeded 64 directories/)
  })
})

describe('resolveUserRoot', () => {
  it('prefers an absolute XDG_CONFIG_HOME over the home directory', () => {
    const tree = makeTree({
      'xdg/mytool/config.toml': 'a = 1\n',
      'home/.config/mytool/config.toml': 'a = 2\n',
    })
    expect(
      resolveUserRoot('mytool', {
        home: join(tree, 'home'),
        env: { XDG_CONFIG_HOME: join(tree, 'xdg') },
      }),
    ).toBe(join(tree, 'xdg/mytool'))
  })

  it('ignores a relative XDG_CONFIG_HOME, warns, and falls back to home', () => {
    const tree = makeTree({ 'home/.config/mytool/config.toml': 'a = 1\n' })
    const { warnings, onWarning } = warningCollector()
    const root = resolveUserRoot('mytool', {
      home: join(tree, 'home'),
      env: { XDG_CONFIG_HOME: '../cfg' },
      onWarning,
    })
    expect(root).toBe(join(tree, 'home/.config/mytool'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/XDG_CONFIG_HOME.*absolute/)
  })

  it('ignores an empty XDG_CONFIG_HOME and warns', () => {
    const tree = makeTree({ 'home/.config/mytool/config.toml': 'a = 1\n' })
    const { warnings, onWarning } = warningCollector()
    expect(
      resolveUserRoot('mytool', { home: join(tree, 'home'), env: { XDG_CONFIG_HOME: '' }, onWarning }),
    ).toBe(join(tree, 'home/.config/mytool'))
    expect(warnings).toHaveLength(1)
  })

  it('uses home/.config when XDG_CONFIG_HOME is unset', () => {
    const tree = makeTree({ 'home/.config/mytool/config.toml': 'a = 1\n' })
    const { warnings, onWarning } = warningCollector()
    expect(resolveUserRoot('mytool', { home: join(tree, 'home'), env: {}, onWarning })).toBe(
      join(tree, 'home/.config/mytool'),
    )
    expect(warnings).toEqual([])
  })

  it('returns null when the resolved directory does not exist', () => {
    const tree = makeTree({ 'home/.gitkeep': '' })
    expect(resolveUserRoot('mytool', { home: join(tree, 'home'), env: {} })).toBeNull()
  })
})

describe('listConfigFiles', () => {
  it('returns recognized files in the SPEC §2.5 order', () => {
    const tree = makeTree({
      'c/.env': 'A=1\n',
      'c/config.ini': '[s]\nk = 1\n',
      'c/config.json': '{}\n',
      'c/config.jsonc': '{}\n',
      'c/config.toml': 'a = 1\n',
      'c/config.yaml': 'a: 1\n',
      'c/unrecognized.txt': 'ignored\n',
    })
    expect(listConfigFiles(join(tree, 'c')).map((f) => [f.path.split('/').pop(), f.format])).toEqual([
      ['config.toml', 'toml'],
      ['config.yaml', 'yaml'],
      ['config.json', 'json'],
      ['config.jsonc', 'jsonc'],
      ['config.ini', 'ini'],
      ['.env', 'dotenv'],
    ])
  })

  it('raises duplicate-format for config.yaml beside config.yml', () => {
    const tree = makeTree({ 'c/config.yaml': 'a: 1\n', 'c/config.yml': 'a: 2\n' })
    try {
      listConfigFiles(join(tree, 'c'))
      expect.unreachable('expected a duplicate-format error')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).kind).toBe('duplicate-format')
      expect((error as ConfigError).path).toBe(join(tree, 'c'))
    }
  })

  it('loads a profile file immediately after its base file', () => {
    const tree = makeTree({ 'c/config.toml': 'a = 1\n', 'c/config.prod.toml': 'a = 2\n' })
    expect(listConfigFiles(join(tree, 'c'), 'prod').map((f) => f.path.split('/').pop())).toEqual([
      'config.toml',
      'config.prod.toml',
    ])
  })
})

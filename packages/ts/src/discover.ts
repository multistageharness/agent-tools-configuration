/**
 * Search-path resolution — SPEC §2.
 *
 * Why this does not use `cosmiconfig.search()`: cosmiconfig's search walks upward and stops at
 * the **first** hit, returning one config. SPEC §2.2 collects **every** ancestor root and
 * layers them nearest-wins, which `search()` cannot express — and `strategy: "first-match"`
 * recovers the stop-at-first reading afterward from the full list. cosmiconfig is still doing
 * the job it is best at, one directory down: parsing and loading an individual file through its
 * loader registry (see loaders.ts). Anyone who sees the dependency and assumes `search()` is
 * driving discovery is reading it backwards.
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { ConfigError } from './errors.js'
import type { Format, WarningSink } from './types.js'

/** SPEC §2.5: the closed, ordered list of recognized file names. */
export const RECOGNIZED_FILES: ReadonlyArray<readonly [name: string, format: Format]> = [
  ['config.toml', 'toml'],
  ['config.yaml', 'yaml'],
  ['config.yml', 'yaml'],
  ['config.json', 'json'],
  ['config.jsonc', 'jsonc'],
  ['config.ini', 'ini'],
  ['.env', 'dotenv'],
]

/**
 * A pathological mount or a symlink loop the realpath did not collapse should fail loudly
 * rather than spin. No real tree is 64 directories deep below its repository root.
 */
const MAX_DEPTH = 64

export interface WalkOptions {
  /** The resolved home directory; the walk stops there, inclusive (SPEC §2.3). */
  home?: string
  /** Opt-in extra stop condition, inclusive. */
  stopDir?: string
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every existing `.config/<packageName>/` from `cwd` upward, **farthest ancestor first** so the
 * list is already in SPEC §2.7 order and the nearest root is last, and therefore wins.
 */
export function resolveProjectRoots(
  cwd: string,
  packageName: string,
  options: WalkOptions = {},
): string[] {
  let dir = realpathSync(resolve(cwd)) // SPEC §2.1: realpath-resolved exactly once.
  const home = options.home === undefined ? undefined : resolve(options.home)
  const stopDir = options.stopDir === undefined ? undefined : resolve(options.stopDir)

  const roots: string[] = []
  for (let depth = 0; ; depth++) {
    if (depth > MAX_DEPTH) {
      throw new ConfigError(
        'unreadable',
        `upward walk exceeded ${MAX_DEPTH} directories starting at ${cwd}; refusing to continue`,
        { path: cwd },
      )
    }

    // SPEC §2.2: a directory is checked before it is tested for stopping, so a config beside a
    // .git is found and the walk then ends.
    const candidate = join(dir, '.config', packageName)
    if (isDirectory(candidate)) roots.push(candidate)

    const parent = dirname(dir)
    const atFilesystemRoot = parent === dir
    const atHome = home !== undefined && dir === home
    const atStopDir = stopDir !== undefined && dir === stopDir
    // Both forms count: a directory in a normal clone, a file in a worktree or submodule.
    const atRepositoryBoundary = existsSync(join(dir, '.git'))
    if (atFilesystemRoot || atHome || atStopDir || atRepositoryBoundary) break

    dir = parent
  }
  return roots.reverse()
}

export interface UserRootOptions {
  /** Overrides the platform home directory. */
  home?: string
  /** Required — never read `process.env` in here; the probe and the tests both depend on that. */
  env: Record<string, string | undefined>
  onWarning?: WarningSink
}

/**
 * The single user-level root of SPEC §2.4, or `null` when it does not exist — so a caller can
 * tell "no user config at all" from "user config directory is empty".
 *
 * Windows takes this identical path. `%APPDATA%` and `%LOCALAPPDATA%` are deliberately not
 * consulted (SPEC §2.4): one documented location on every platform beats a native one that
 * nobody can predict from the docs, because the same directory has to be readable by five
 * language implementations.
 */
export function resolveUserRoot(packageName: string, options: UserRootOptions): string | null {
  const xdg = options.env['XDG_CONFIG_HOME']
  let root: string
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) {
    root = join(xdg, packageName)
  } else {
    if (xdg !== undefined) {
      options.onWarning?.(
        `ignoring XDG_CONFIG_HOME=${JSON.stringify(xdg)}: it must be a non-empty absolute path (SPEC §2.4)`,
      )
    }
    root = join(options.home ?? homedir(), '.config', packageName)
  }
  return isDirectory(root) ? root : null
}

export interface ConfigFileRef {
  path: string
  format: Format
}

/**
 * The recognized files present in one config directory, in SPEC §2.5 order — which is also
 * their load order, later entries winning.
 */
export function listConfigFiles(root: string, profile?: string): ConfigFileRef[] {
  // SPEC §2.5: a mistake, not an intention. Picking a winner silently would hide it.
  if (existsSync(join(root, 'config.yaml')) && existsSync(join(root, 'config.yml'))) {
    throw new ConfigError(
      'duplicate-format',
      `${root}: config.yaml and config.yml cannot both be present`,
      { path: root },
    )
  }

  const files: ConfigFileRef[] = []
  for (const [name, format] of RECOGNIZED_FILES) {
    const path = join(root, name)
    if (existsSync(path)) files.push({ path, format })
    if (profile !== undefined && profile !== '') {
      // SPEC §2.6: `config.<profile>.<ext>` immediately after its base file.
      const dot = name.lastIndexOf('.')
      const profiled = dot <= 0 ? `${name}.${profile}` : `${name.slice(0, dot)}.${profile}${name.slice(dot)}`
      const profiledPath = join(root, profiled)
      if (existsSync(profiledPath)) files.push({ path: profiledPath, format })
    }
  }
  return files
}

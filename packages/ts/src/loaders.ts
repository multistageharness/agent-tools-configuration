/**
 * File loading — the job cosmiconfig is actually here to do.
 *
 * cosmiconfig owns reading a single file and dispatching it to a loader by extension, and it
 * ships YAML and JSON. It ships no TOML, INI, or `.env`, so three loaders are registered here.
 * Discovery is not cosmiconfig's — see the header of discover.ts for why.
 */

import { cosmiconfig, cosmiconfigSync, defaultLoadersSync } from 'cosmiconfig'
import type { Loader, LoaderSync, PublicExplorer, PublicExplorerSync } from 'cosmiconfig'
import { parse as parseToml } from 'smol-toml'
import { parse as parseDotenvContent } from 'dotenv'

import { assignPath, coerceValue, envKeyPath } from './env.js'
import { ConfigError } from './errors.js'
import type { ConfigFileRef } from './discover.js'

export interface LoaderOptions {
  /** The prefix stripped from `.env` keys when present (SPEC §4.6). */
  envPrefix: string
}

/** Pull whatever line/column a parser was willing to tell us out of its error. */
function positionOf(error: unknown): { line?: number; column?: number } {
  if (error === null || typeof error !== 'object') return {}
  const source = error as Record<string, unknown>
  const mark = source['mark'] as Record<string, unknown> | undefined // js-yaml
  const line = source['line'] ?? mark?.['line']
  const column = source['column'] ?? mark?.['column']
  return {
    ...(typeof line === 'number' ? { line } : {}),
    ...(typeof column === 'number' ? { column } : {}),
  }
}

/**
 * Every loader goes through here, so a parse failure is a `ConfigError` with `kind:
 * "malformed"` and the path no matter which parser produced it. Without this the caller would
 * be pattern-matching five different libraries' exception types.
 */
function guard(parse: (filepath: string, content: string) => unknown): LoaderSync {
  return (filepath, content) => {
    try {
      return parse(filepath, content)
    } catch (error) {
      if (error instanceof ConfigError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new ConfigError('malformed', `${filepath}: ${message}`, {
        path: filepath,
        ...positionOf(error),
        cause: error,
      })
    }
  }
}

/** A small INI reader: `[section]` headers, `key = value`, `#` and `;` comments. */
export function parseIni(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let table = root
  content.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new Error(`line ${index + 1}: unterminated section header`)
      table = root
      for (const segment of line.slice(1, -1).trim().split('.')) {
        const existing = table[segment]
        if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
          table[segment] = {}
        }
        table = table[segment] as Record<string, unknown>
      }
      return
    }
    const eq = line.indexOf('=')
    if (eq < 1) throw new Error(`line ${index + 1}: expected key = value`)
    const value = line.slice(eq + 1).trim()
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]
    // INI is untyped; SPEC §2.5 pins the same coercion the env layer uses.
    table[line.slice(0, eq).trim()] = coerceValue(quoted ? value.slice(1, -1) : value, quoted)
  })
  return root
}

function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let i = 0
  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      if (char === '\\') {
        out += char + (next ?? '')
        i += 2
        continue
      }
      if (char === '"') inString = false
      out += char
      i++
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      i++
      continue
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += char
    i++
  }
  return out
}

/**
 * `.env` files map their keys the same way environment variables do (SPEC §4.6), with the
 * prefix optional — a `.env` inside `.config/<packageName>/` is already unambiguous about which
 * package it belongs to.
 */
export function parseDotenv(content: string, envPrefix: string): Record<string, unknown> {
  const flat = parseDotenvContent(content)
  // dotenv strips surrounding quotes and does not say it did, but SPEC §4.6 keeps a quoted
  // value a string: PORT="5432" is text, PORT=5432 is the number. So the raw lines are scanned
  // for which keys were written quoted.
  const quotedKeys = new Set<string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '')
    const match = /^([\w.-]+)\s*=\s*(.*)$/.exec(line)
    const value = match?.[2]?.trim()
    if (match?.[1] === undefined || value === undefined) continue
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      quotedKeys.add(match[1])
    }
  }

  const result: Record<string, unknown> = {}
  const marker = `${envPrefix}_`
  for (const [name, value] of Object.entries(flat)) {
    const bare = name.toUpperCase().startsWith(marker) ? name.slice(marker.length) : name
    const path = envKeyPath(bare)
    if (path.length === 0) continue
    assignPath(result, path, coerceValue(value, quotedKeys.has(name)))
  }
  return result
}

function buildLoaders(options: LoaderOptions): Record<string, LoaderSync> {
  return {
    '.toml': guard((_filepath, content) => parseToml(content)),
    // cosmiconfig's own, so YAML and JSON error messages stay the ones its users recognize.
    '.yaml': defaultLoadersSync['.yaml'] as LoaderSync,
    '.yml': defaultLoadersSync['.yml'] as LoaderSync,
    '.json': defaultLoadersSync['.json'] as LoaderSync,
    '.jsonc': guard((_filepath, content) => JSON.parse(stripJsonComments(content)) as unknown),
    '.ini': guard((_filepath, content) => parseIni(content)),
    // `.env` has no extension as far as `path.extname` is concerned.
    noExt: guard((_filepath, content) => parseDotenv(content, options.envPrefix)),
  }
}

/**
 * `searchPlaces: []` is not an oversight — it is the statement that `explorer.search()` is
 * never called. Only `explorer.load(path)` is, against paths this package resolved itself.
 */
export function createExplorer(packageName: string, options: LoaderOptions): PublicExplorer {
  return cosmiconfig(packageName, {
    searchPlaces: [],
    loaders: buildLoaders(options) as Record<string, Loader>,
    cache: false,
  })
}

export function createExplorerSync(packageName: string, options: LoaderOptions): PublicExplorerSync {
  return cosmiconfigSync(packageName, {
    searchPlaces: [],
    loaders: buildLoaders(options),
    cache: false,
  })
}

/** Normalize whatever cosmiconfig hands back into a plain object. */
function shape(result: { config?: unknown; isEmpty?: boolean } | null, ref: ConfigFileRef): Record<string, unknown> {
  // A file that parsed to nothing still counts as read: SPEC §7 wants it in `sources` with an
  // empty `keys`, because "I read it and it was empty" answers a different question from
  // "I never saw it".
  if (result === null || result.isEmpty === true || result.config === null || result.config === undefined) {
    return {}
  }
  if (typeof result.config !== 'object' || Array.isArray(result.config)) {
    throw new ConfigError('malformed', `${ref.path}: top level must be a table, not a ${typeof result.config}`, {
      path: ref.path,
    })
  }
  return result.config as Record<string, unknown>
}

/** Turn a read failure into the right `kind`; a parse failure is already a `ConfigError`. */
function rethrow(error: unknown, ref: ConfigFileRef): never {
  if (error instanceof ConfigError) throw error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ELOOP') {
    throw new ConfigError('unreadable', `${ref.path}: ${code}`, { path: ref.path, cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  throw new ConfigError('malformed', `${ref.path}: ${message}`, {
    path: ref.path,
    ...positionOf(error),
    cause: error,
  })
}

export async function loadConfigFile(
  explorer: PublicExplorer,
  ref: ConfigFileRef,
): Promise<Record<string, unknown>> {
  try {
    return shape(await explorer.load(ref.path), ref)
  } catch (error) {
    rethrow(error, ref)
  }
}

export function loadConfigFileSync(
  explorer: PublicExplorerSync,
  ref: ConfigFileRef,
): Record<string, unknown> {
  try {
    return shape(explorer.load(ref.path), ref)
  } catch (error) {
    rethrow(error, ref)
  }
}

/**
 * The `sources` output — SPEC §7.
 *
 * This is the only thing standing between a user who expected `debug` and an afternoon of
 * guessing which of six layers set `trace`, so every source that was read is listed, winners
 * and losers alike.
 */

import { isAbsolute, relative, sep } from 'node:path'

import { isPlainObject } from './merge.js'
import type { Layer } from './merge.js'
import type { Source } from './types.js'

export interface BuildSourcesOptions {
  /** Rewrite paths relative to this directory, forward-slashed. The probe passes the fixture root. */
  relativeTo?: string
}

/** Forward slashes on every platform — SPEC §7 and CANONICAL.md rule 3. */
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * Entry order is **application order** — the order the layers were merged, lowest effective
 * priority first (SPEC §3.1). That is ascending precedence with one documented exception: a
 * root's `.env` (precedence 3) belongs inside that root's block, so a user-level `.env` still
 * loses to a project-local `config.toml`. Sorting this list by precedence would reorder it into
 * something that does not describe what happened.
 */
export function buildSources(layers: Layer[], options: BuildSourcesOptions = {}): Source[] {
  return layers.map((layer) => {
    const keys = isPlainObject(layer.value) ? Object.keys(layer.value).sort() : []
    return {
      ...layer.source,
      path: rewritePath(layer.source.path, options.relativeTo),
      keys,
    }
  })
}

function rewritePath(path: string, relativeTo?: string): string {
  // `<defaults>`, `<env>` and `<overrides>` are labels, not paths, and are passed through.
  if (!isAbsolute(path)) return path
  if (relativeTo === undefined) return path
  const rewritten = relative(relativeTo, path)
  // A path outside the fixture root stays absolute rather than turning into a ../../ climb that
  // no expected.json could ever match.
  if (rewritten === '' || rewritten.startsWith('..')) return toPosix(path)
  return toPosix(rewritten)
}

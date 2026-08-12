/**
 * Merge semantics — SPEC §4.
 *
 * cosmiconfig does no merging at all, so nothing here is fighting a library's opinion. That
 * makes this the implementation the other four languages get adjudicated against when a
 * fixture disagreement needs settling.
 */

import type { ArrayMerge, Source, Strategy, WarningSink } from './types.js'

export interface Layer {
  value: unknown
  source: Source
  /**
   * The config directory this layer came from, for `first-match`. Absent on the layers that
   * belong to no root: defaults, env, overrides.
   */
  root?: string
}

export interface MergeOptions {
  arrayMerge?: ArrayMerge
  onWarning?: WarningSink
}

/**
 * True only for a plain data object. Arrays, `null`, dates, class instances and everything else
 * with a non-default prototype are values to be replaced, not maps to be merged into.
 * `Object.create(null)` counts, because a parser is allowed to produce one.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** A config file is untrusted input, and these three keys are how untrusted input escapes. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function mergeInto(
  lower: Record<string, unknown>,
  higher: Record<string, unknown>,
  options: MergeOptions,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...lower }
  for (const key of Object.keys(higher)) {
    const at = path === '' ? key : `${path}.${key}`
    if (FORBIDDEN_KEYS.has(key)) {
      options.onWarning?.(`dropping ${at}: prototype-polluting keys are never merged`)
      continue
    }
    const value = higher[key]

    // SPEC §4.4. Absent is not null: `undefined` means the higher layer never mentioned the
    // key, `null` means it asked for the key to go away.
    if (value === undefined) continue
    if (value === null) {
      delete out[key]
      continue
    }

    const existing = out[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeInto(existing, value, options, at)
      continue
    }
    if (Array.isArray(existing) && Array.isArray(value)) {
      // SPEC §4.3: replace by default; concat appends and never deduplicates.
      out[key] = options.arrayMerge === 'concat' ? [...existing, ...value] : value
      continue
    }
    if (existing !== undefined && isPlainObject(existing) !== isPlainObject(value)) {
      options.onWarning?.(
        `${at}: replacing ${isPlainObject(existing) ? 'a map' : 'a scalar'} with ${isPlainObject(value) ? 'a map' : 'a scalar'} (SPEC §4.2)`,
      )
    }
    out[key] = value
  }
  return out
}

/** Fold the layers lowest precedence first. */
export function mergeLayers(layers: Layer[], options: MergeOptions = {}): Record<string, unknown> {
  let result: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!isPlainObject(layer.value)) continue
    result = mergeInto(result, layer.value, options, '')
  }
  return result
}

/**
 * SPEC §3.2. Under `first-match`, only the highest-precedence root that contributed a file
 * survives — the lower roots are dropped from the merge **and** from `sources`, because the
 * option means "the others were never consulted", not "the others lost".
 *
 * The rootless layers — defaults, env, overrides — always survive: the option scopes the file
 * layers only.
 */
export function applyStrategy(layers: Layer[], strategy: Strategy): Layer[] {
  if (strategy !== 'first-match') return layers
  const winningRoot = layers.filter((layer) => layer.root !== undefined).at(-1)?.root
  return layers.filter((layer) => layer.root === undefined || layer.root === winningRoot)
}
